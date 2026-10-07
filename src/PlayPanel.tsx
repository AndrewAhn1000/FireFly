import { useCallback, useEffect, useMemo, useState } from 'react';
import { buttonLabel } from './Keyboard';
import {
  cleanError, correctionsOf, meanF1, newestFirst, percent, playingText, POLICY_VERSION, retrainRequest,
  type PlayStatus, type PolicyVersion, type RecordingInfo,
} from './policyPlay';

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
interface Group { key: string; name: string; versions: PolicyVersion[] }

const when = (v: PolicyVersion) => new Date(v.created * 1000).toLocaleString();

export default function PlayPanel({ active, online, capturing, windowId, recording }: Props) {
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [status, setStatus] = useState<PlayStatus>({ playing: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [training, setTraining] = useState<{ versionId: string; epochs: number; progress: Epoch | null } | null>(null);
  const [trained, setTrained] = useState<string | null>(null); // the version a training here just made
  const [error, setError] = useState('');

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

  const groups = useMemo(() => {
    const byKey = new Map<string, Group>();
    for (const v of versions) {
      const key = v.policy?.id ?? '', name = v.policy?.name || 'Earlier policies';
      if (!byKey.has(key)) byKey.set(key, { key, name, versions: [] });
      byKey.get(key)!.versions.push(v);
    }
    // Named policies by their newest version, the unnamed ones last
    return [...byKey.values()].sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.versions[0].created - a.versions[0].created);
  }, [versions]);
  const selected = versions.find(v => v.id === selectedId) ?? groups[0]?.versions[0] ?? null;
  const group = selected ? groups.find(g => g.versions.includes(selected)) ?? null : null;
  const number = (v: PolicyVersion, g: Group) => g.key ? `v${g.versions.length - g.versions.indexOf(v)}` : when(v);

  const play = async (v: PolicyVersion, corrections: boolean) => {
    if (!windowId) return;
    setError('');
    const res = await window.bridge.policy.play({ modelId: v.id, windowId, corrections });
    if (!res.ok) setError(res.error ?? 'Could not start playing');
  };
  const train = async (v: PolicyVersion, siblings: PolicyVersion[]) => {
    const request = retrainRequest(v, siblings, recordings);
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
    : recording ? 'Stop recording first' : status.playing ? 'Another version is playing' : '';

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
          <div className="play-group-hd">{g.name}<span>{g.versions.length} version{g.versions.length > 1 ? 's' : ''}</span></div>
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
          {buttons.length > 0 && <div className="play-meta">Presses {buttons.join(', ')}</div>}

          {!playable ? <div className="play-hint">Trained by an older FireFly, so it can't play: train its Policy node again in Graphs.</div> : <>
            <div className="play-actions">
              {isPlaying ? <button className="train-btn-stop" onClick={() => void window.bridge.policy.stop()}>■ Stop</button> : <>
                <button className="train-btn-primary" disabled={!!why} title={why} onClick={() => void play(v, false)}>▶ Play</button>
                <button className="train-btn-sm play-correct" disabled={!!why} title={why || 'Take over whenever it goes wrong: what you do is recorded as a correction'}
                  onClick={() => void play(v, true)}>▶ Play and record my corrections</button>
              </>}
            </div>
            {why && !isPlaying && <div className="play-hint">{why}.</div>}
            {isPlaying && <div className="play-live" role="status">{playingText(status)}</div>}
            {!status.playing && status.reason && (!status.modelId || status.modelId === v.id) && <div className="play-stopped">Stopped: {status.reason}</div>}
            <div className="play-hint">With corrections, press keys or click in the game whenever it goes wrong: you take over, what you do is recorded, and it carries on once you've let go for 1.5 s. Without, any key or click stops it.</div>
          </>}

          <div className="play-section-hd">Corrections</div>
          <div className="play-meta">
            {fixes.length ? `${fixes.length} correction${fixes.length > 1 ? 's' : ''} recorded while ${group.key ? `${group.name}'s versions` : 'it'} played${own ? ` (${own} while this one played)` : ''}` : 'None recorded yet: play it with corrections, and take over when it goes wrong.'}
          </div>
          <div className="play-actions">
            <button className="train-btn-sm" disabled={!fixes.length || !!training || recording || isPlaying}
              title={isPlaying ? 'Stop it first' : recording ? 'Stop recording first' : !fixes.length ? 'Record some corrections first' : ''}
              onClick={() => void train(v, group.versions)}>
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
