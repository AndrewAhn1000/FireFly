import { useCallback, useEffect, useMemo, useState } from 'react';
import { buttonLabel } from './Keyboard';
import {
  cleanError, correctionShareHint, correctionsOf, DEFAULT_CORRECTION_SHARE, MAX_CORRECTION_SHARE, meanF1, newestFirst, percent,
  playingText, policyNodes, POLICY_VERSION, retrainRequest, savedPlayGoal, stopHow, type PlayStatus, type TraceReport, type PolicyVersion, type RecordingInfo,
} from './policyPlay';
import { graphScope, SETTINGS } from './windowSetup';

// What a version saw while it played, beside its training: whether its situations were familiar, how it pressed each
// button against how the player did, and the values most unlike training
function TraceSummary({ report, error }: { report: TraceReport | null; error?: string }) {
  if (error) return <div className="play-stopped">{error}</div>;
  if (!report) return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`, u = report.unfamiliar;
  const odd = report.values.filter(v => v.outside > 0.01 || v.shift > 1).slice(0, 10);
  return <div className="play-trace" aria-label="Its play beside its training">
    <div>{report.acted.toLocaleString()} of {report.frames.toLocaleString()} frames acted on
      {report.frames > report.acted ? `; nothing to go on in the rest (${Object.entries(report.missing).map(([r, n]) => `${r}: ${n}`).join('; ')})` : ''}.</div>
    <div title="Each frame's distance to the training row most like it, in training's spread, beside the rows held back from training">
      {pct(u.beyondHeldBack90)} of its frames were less like its training than nearly all (90%) of the moments held back from training
      {u.beyondHeldBack90 > .3 ? ': it was mostly somewhere its recordings don’t cover' : u.beyondHeldBack90 > .1 ? ': often somewhere its recordings don’t cover' : ': its situations were like its training'}.</div>
    <div>It pressed nothing in {pct(report.pressedNothing)} of frames (you: {pct(report.playerNothing)}).</div>
    <table className="play-trace-table"><thead><tr><th>Button</th><th>You held it</th><th>It held it</th><th>Its average chance</th></tr></thead>
      <tbody>{report.buttons.filter(b => b.playerPressed > .002 || b.playPressed > .002).map(b => <tr key={b.id}>
        <td>{buttonLabel(b.id)}</td><td>{pct(b.playerPressed)}</td><td>{pct(b.playPressed)}</td><td>{pct(b.playChance)}</td></tr>)}</tbody></table>
    {odd.length > 0 ? <>
      <div>Values most unlike its training (outside: how often play went past anything training had; shift: how far the average moved, in training's spread):</div>
      <table className="play-trace-table"><thead><tr><th>Value</th><th>Training</th><th>Play</th><th>Outside</th><th>Shift</th></tr></thead>
        <tbody>{odd.map(v => <tr key={v.name}><td>{v.name}</td><td>{fmt(v.trainLow)}…{fmt(v.trainHigh)} (avg {fmt(v.trainMean)})</td>
          <td>{fmt(v.playLow)}…{fmt(v.playHigh)} (avg {fmt(v.playMean)})</td><td>{pct(v.outside)}</td><td>{v.shift.toFixed(1)}</td></tr>)}</tbody></table>
    </> : <div>Every value stayed within what training had.</div>}
  </div>;
}
const fmt = (v: number) => Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);

// The Play tab: every trained policy and its versions, to play one as it is, or with corrections recorded
// whenever the player takes over, and then train a new version with those corrections, without opening its
// graph. A version keeps what it was trained from and how, so "with corrections" is that again plus the
// corrections (see retrainRequest). Policies are built and first trained in the Policy Graph (Graphs).

interface Props {
  active: boolean;     // the tab is shown: versions and recordings are read while it is
  online: boolean;     // the runtime is ready
  capturing: boolean;  // a capture session is running
  windowId: string | null;
  recording: boolean;  // a recording is being made, which play can't share the runtime with
}
interface Epoch { epoch: number; validationLoss: number; buttonF1?: number; }
// A named policy's versions, newest first; versions trained before policies had names go together
interface Group { key: string; name: string; graphs: string[]; versions: PolicyVersion[] }

const when = (v: PolicyVersion) => new Date(v.created * 1000).toLocaleString();

export default function PlayPanel({ active, online, capturing, windowId, recording }: Props) {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [status, setStatus] = useState<PlayStatus>({ playing: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [training, setTraining] = useState<{ versionId: string; epochs: number; progress: Epoch | null } | null>(null);
  const [trained, setTrained] = useState<string | null>(null); // the version a training here just made
  const [error, setError] = useState('');
  // How much the corrections count in the next training, when chosen here; else as much as they did for the
  // version shown. Choosing another version starts from its own again.
  const [share, setShare] = useState<number | null>(null);
  useEffect(() => setShare(null), [selectedId]);

  const refresh = useCallback(async () => {
    try {
      setVersions(newestFirst(await window.bridge.policy.invoke('models') as PolicyVersion[]));
      if (online) setRecordings(((await window.bridge.invoke('dataset.list')) as { recordings: RecordingInfo[] }).recordings);
    } catch (e) { setError(cleanError(e)); }
  }, [online]);
  // Read while shown, and again every few seconds: corrections arrive as the policy plays
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  useEffect(() => {
    const offs = [
      window.bridge.on('play:status', (s: unknown) => setStatus(s as PlayStatus)),
      window.bridge.on('policy:event', (msg: unknown) => {
        const { event, result } = msg as { event: string; result: Epoch };
        if (event === 'training') setTraining(t => t ? { ...t, progress: result } : t);
      }),
    ];
    return () => offs.forEach(off => off());
  }, []);

  // Each policy by its Policy node's name now (renamed since a version was trained, the version says the old one),
  // and the graph it's in; a policy whose node is gone keeps its newest version's name
  const groups = useMemo(() => {
    const nodes = policyNodes(graphScope(SETTINGS));
    const byKey = new Map<string, Group>();
    for (const v of versions) {
      const key = v.policy?.id ?? '', placed = key ? nodes.filter(n => n.policyId === key) : [];
      const name = placed.find(n => n.name)?.name || v.policy?.name || 'Earlier policies';
      if (!byKey.has(key)) byKey.set(key, { key, name, graphs: [...new Set(placed.map(n => n.graph))], versions: [] });
      byKey.get(key)!.versions.push(v);
    }
    // Named policies by their newest version, the unnamed ones last
    return [...byKey.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.versions[0].created - a.versions[0].created);
  }, [versions, active]);
  const selected = versions.find(v => v.id === selectedId) ?? groups[0]?.versions[0] ?? null;
  const group = selected ? groups.find(g => g.versions.includes(selected)) ?? null : null;
  const number = (v: PolicyVersion, g: Group) => g.key ? `v${g.versions.length - g.versions.indexOf(v)}` : when(v);

  // Keeping what it sees while it plays, and that beside what it trained on
  const [keepSeen, setKeepSeen] = useState(false);
  const [report, setReport] = useState<{ versionId: string; report: TraceReport | null; error?: string; busy?: boolean } | null>(null);
  const play = async (v: PolicyVersion, corrections: boolean) => {
    if (!windowId) return;
    setError('');
    // Where it heads is its graph's now (the Goal's target, route or plan), not what the version trained with
    const goal = v.policy ? savedPlayGoal(graphScope(SETTINGS), v.policy.id) : null;
    if (goal && 'error' in goal) { setError(`Can’t play: ${goal.error}`); return; }
    const res = await window.bridge.policy.play({ modelId: v.id, windowId, corrections, trace: keepSeen, ...(goal ? { goal } : {}) });
    if (!res.ok) setError(res.error ?? 'Could not start playing');
  };
  const compare = async (v: PolicyVersion) => {
    setReport({ versionId: v.id, report: null, busy: true });
    try { setReport({ versionId: v.id, report: await window.bridge.policy.invoke('trace.report', { modelId: v.id }) as TraceReport }); }
    catch (e) { setReport({ versionId: v.id, report: null, error: cleanError(e) }); }
  };
  const train = async (v: PolicyVersion, siblings: PolicyVersion[], correctionShare: number) => {
    const request = retrainRequest(v, siblings, recordings, correctionShare);
    if (!request) { setError('The recordings this version was trained from have all been deleted'); return; }
    setError(''); setTrained(null);
    setTraining({ versionId: v.id, epochs: Number(request.epochs) || 60, progress: null });
    try {
      const made = await window.bridge.policy.invoke('train', request) as PolicyVersion;
      setTrained(made.id); setSelectedId(made.id);
      await refresh();
    } catch (e) { setError(cleanError(e)); }
    setTraining(null);
  };

  const playingNow = status.playing ? versions.find(v => v.id === status.modelId) ?? null : null;
  const why = !capturing ? 'Start a capture session first' : !windowId ? 'Choose the game window first'
    : recording ? 'Stop recording first' : status.playing ? (status.behavior ? `${status.name ?? 'A behaviour tree'} is running` : 'Another version is playing') : '';

  if (!versions.length) return (
    <div className="play-panel play-empty">
      <div className="play-empty-title">No trained policies yet</div>
      <div className="play-hint">Build a policy in <b>Graphs</b>: a Policy node with States and a Recordings node wired in, then <b>Train</b>. Its versions show up here to play.</div>
      {error && <div className="play-error">{error}</div>}
    </div>
  );

  return (
    <div className="play-panel">
      <div className="play-list" aria-label="Trained policies">
        {groups.map(g => <div key={g.key || 'earlier'} className="play-group">
          <div className="play-group-hd" title={g.graphs.length ? `In the graph${g.graphs.length > 1 ? 's' : ''} ${g.graphs.join(', ')}` : g.key ? 'Its Policy node is no longer in any graph' : undefined}>
            <span className="play-group-name">{g.name}{g.graphs.length > 0 && <small> · {g.graphs.join(', ')}</small>}</span>
            <span>{g.versions.length} version{g.versions.length > 1 ? 's' : ''}</span></div>
          {g.versions.map(v => {
            const f1 = meanF1(v), isPlaying = playingNow?.id === v.id;
            return <button key={v.id} className={`play-version${v.id === selected?.id ? ' play-version-sel' : ''}`} onClick={() => setSelectedId(v.id)}>
              <span className="play-version-name">{isPlaying && <span className="play-dot" />}{number(v, g)}</span>
              <small>{g.key ? `${when(v)} · ` : ''}{(v.trainingSamples + v.validationSamples).toLocaleString()} rows{f1 !== null ? ` · F1 ${percent(f1)}` : ''}</small>
            </button>;
          })}
        </div>)}
      </div>

      {selected && group && (() => {
        const v = selected, f1 = meanF1(v), playable = v.version === POLICY_VERSION;
        const isPlaying = playingNow?.id === v.id;
        const fixes = correctionsOf(group.versions, recordings), own = fixes.filter(r => r.metadata.policyId === v.id).length;
        const buttons = (v.outputs?.map(b => b.id) ?? v.config.buttons ?? []).map(buttonLabel);
        const trainingHere = training?.versionId === v.id;
        return <div className="play-detail">
          <div className="play-title">{group.name} <b>{number(v, group)}</b>{trained === v.id && <span className="play-new">new</span>}</div>
          <div className="play-meta">
            Trained {when(v)} · {(v.trainingSamples + v.validationSamples).toLocaleString()} rows
            {f1 !== null ? ` · F1 ${percent(f1)} on recordings it hadn't seen` : ''}
            {v.stepMs ? ` · acts every ${Math.round(v.stepMs)} ms` : ''}
          </div>
          {buttons.length > 0 && <div className="play-meta">Presses {buttons.join(', ')}
            {Object.keys(v.taps ?? {}).length > 0 && <> · taps {Object.entries(v.taps!).map(([b, t]) => `${buttonLabel(b)} (${t.downMs} ms down, ${t.upMs} up)`).join(', ')}, as you did</>}</div>}
          {v.corrections?.learned != null && <div className="play-meta">
            Trained with {v.corrections.recordings} correction{v.corrections.recordings === 1 ? '' : 's'}: does what you showed it {percent(v.corrections.learned)} of the time
          </div>}
          {v.corrections?.learned != null && v.corrections.learned < .8 && <div className="play-hint">
            It can’t do much of what your corrections showed it. Most likely its States can’t tell those moments apart from
            ones in the recordings where it should do otherwise: add a State that shows what’s different there (such as a
            portal’s position), and train it again.
          </div>}

          {!playable ? <div className="play-hint">Trained by an older FireFly, so it can't play: train its Policy node again in Graphs.</div> : <>
            <div className="play-actions">
              {isPlaying ? <button className="train-btn-stop" onClick={e => void window.bridge.policy.stop(stopHow(e))}>■ Stop</button> : <>
                <button className="train-btn-primary" disabled={!!why} title={why} onClick={() => void play(v, false)}>▶ Play</button>
                <button className="train-btn-sm play-correct" disabled={!!why} title={why || 'Take over whenever it goes wrong: what you do is recorded as a correction'}
                  onClick={() => void play(v, true)}>▶ Play and record my corrections</button>
              </>}
            </div>
            <label className="play-keep" title="Keeps each frame it acts on, with the values it saw and how sure it was of each button, to compare with what it trained on">
              <input type="checkbox" checked={keepSeen} disabled={isPlaying} onChange={e => setKeepSeen(e.target.checked)} />Keep what it sees, to compare with its training</label>
            {why && !isPlaying && <div className="play-hint">{why}.</div>}
            {isPlaying && <div className="play-live" role="status">{playingText(status)}</div>}
            {!status.playing && status.reason && (!status.modelId && !status.behavior || status.modelId === v.id) && <div className="play-stopped">Stopped: {status.reason}</div>}
            {!isPlaying && <button className="train-btn-sm" disabled={report?.busy}
              title="Its last play that kept what it saw, beside what it trained on" onClick={() => void compare(v)}>
              {report?.busy && report.versionId === v.id ? 'Comparing…' : 'Compare what it saw with its training'}</button>}
            {report && report.versionId === v.id && !report.busy && <TraceSummary report={report.report} error={report.error} />}
            <div className="play-hint">With corrections, press keys or click in the game whenever it goes wrong: you take over, what you do is recorded, and it carries on once you've let go for 1.5 s. Without, any key or click stops it.</div>
          </>}

          <div className="play-section-hd">Corrections</div>
          <div className="play-meta">
            {fixes.length ? `${fixes.length} correction${fixes.length > 1 ? 's' : ''} recorded while ${group.key ? `${group.name}'s versions` : 'it'} played${own ? ` (${own} while this one played)` : ''}` : 'None recorded yet: play it with corrections, and take over when it goes wrong.'}
          </div>
          {(() => {
            const chosen = share ?? v.config.correctionShare ?? DEFAULT_CORRECTION_SHARE;
            return <label className="play-share" title={correctionShareHint}>
              How much they count
              <input type="range" aria-label="How much the corrections count" min={0} max={MAX_CORRECTION_SHARE} step={.05} value={chosen}
                disabled={!!training} onChange={e => setShare(Number(e.target.value))} />
              <b>{chosen === 0 ? 'as plain rows' : `${percent(chosen)} of training`}</b>
            </label>;
          })()}
          <div className="play-actions">
            <button className="train-btn-sm" disabled={!fixes.length || !!training || recording || isPlaying}
              title={isPlaying ? 'Stop it first' : recording ? 'Stop recording first' : !fixes.length ? 'Record some corrections first' : ''}
              onClick={() => void train(v, group.versions, share ?? v.config.correctionShare ?? DEFAULT_CORRECTION_SHARE)}>
              {trainingHere ? `Training… ${training?.progress ? `${training.progress.epoch}/${training.epochs}` : ''}` : 'Train a new version with my corrections'}
            </button>
          </div>
          <div className="play-hint">Trains a new version{group.key ? ` of ${group.name}` : ''} the way this one was trained (its recordings, values, labels and time step), plus every correction above. It's trained from scratch, and this version is kept. To change what a policy learns from, edit its Policy node in Graphs.</div>
          {error && <div className="play-error">{error}</div>}
        </div>;
      })()}
    </div>
  );
}
