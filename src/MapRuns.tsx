import { useEffect, useRef, useState } from 'react';
import { cleanError } from './policyPlay';
import { AttemptView, attemptFailed, endedText, summaryText, type Attempt, type KeyEvent, type Report } from './ReplayReport';

// A map's runs, under its canvas: every Drive (or clip replayed) kept as a trace, each link it tried and how that went,
// and for a recorded movement its replay against its recording (the worker's behavior.replay). The attempt chosen is
// drawn on the map, the recorded path beside the path it took, and each key event where it was in both (onShow).
// Nothing in it knows a game: it shows where the replay and the recording parted, and leaves what that means to you.

interface Run { file: string; when: string; frames: number; }
export interface ShownAttempt { attempt: Attempt; event: number | null; }

// its jumps in a few words: how many landed where they should, of those measured
const jumpsText = (a: Attempt) => {
  const measured = (a.jumps ?? []).filter(j => j.landed);
  const off = measured.filter(j => j.modelOff).length;
  return measured.length ? ` · jumps ${measured.filter(j => j.worked).length}/${measured.length} landed${a.takeoffMode === 'adaptive' ? ' (adaptive)' : ''}${off ? `, ${off} off the model ⚠` : ''}` : '';
};

export default function MapRuns({ graphId, map, playing, openRun, onShow }: {
  graphId: string; map: unknown; playing: boolean;
  // a run to open (its trace file), from "What happened": the newest when it's ''
  openRun: { file: string; at: number } | null;
  onShow(shown: ShownAttempt | null): void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null), [file, setFile] = useState('');
  const [report, setReport] = useState<Report | null>(null), [threshold, setThreshold] = useState(8);
  const [chosen, setChosen] = useState<number | string | null>(null), [event, setEvent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const list = async (pick?: string) => {
    try {
      const r = (await window.bridge.policy.invoke('behavior.traces', { treeId: graphId })) as { runs: Run[] };
      setRuns(r.runs);
      setFile(f => pick !== undefined ? (pick && r.runs.some(x => x.file === pick) ? pick : r.runs[0]?.file ?? '')
        : f && r.runs.some(x => x.file === f) ? f : r.runs[0]?.file ?? '');
    } catch (e) { setError(cleanError(e)); setRuns([]); }
  };
  // read when opened, and again when a run ends, so the one just made is there; and when asked to open one
  useEffect(() => { void list(); }, [graphId]); // eslint-disable-line react-hooks/exhaustive-deps
  const wasPlaying = useRef(playing);
  useEffect(() => { if (wasPlaying.current && !playing) void list(); wasPlaying.current = playing; }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (openRun) void list(openRun.file); }, [openRun?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!file) { setReport(null); return; }
    let alive = true;
    setBusy(true); setError('');
    window.bridge.policy.invoke('behavior.replay', { file, maps: { [graphId]: map }, thresholdPx: threshold })
      .then(r => {
        if (!alive) return;
        const got = r as Report;
        setReport(got);
        // the attempt it failed on, else the last
        const failed = [...got.attempts].reverse().find(attemptFailed) ?? got.attempts[got.attempts.length - 1];
        setChosen(failed?.attempt ?? null); setEvent(null);
      })
      .catch(e => { if (alive) { setError(cleanError(e)); setReport(null); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [file, threshold]); // eslint-disable-line react-hooks/exhaustive-deps
  const attempt = report?.attempts.find(a => a.attempt === chosen) ?? null;
  useEffect(() => { onShow(attempt?.recordedPath ? { attempt, event } : null); }, [attempt, event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onShow(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const where = (a: Attempt) => a.kind === 'line-up' && a.lineUp ? `lining up with (${Math.round(a.lineUp.target[0])}, ${Math.round(a.lineUp.target[1])})`
    : a.recordedPath?.length
    ? `(${Math.round(a.recordedPath[0][1])}, ${Math.round(a.recordedPath[0][2])}) → (${Math.round(a.recordedEnd?.[0] ?? a.recordedPath[a.recordedPath.length - 1][1])}, ${Math.round(a.recordedEnd?.[1] ?? a.recordedPath[a.recordedPath.length - 1][2])})`
    : `${a.from ?? '?'} → ${a.to ?? '?'}`;
  return <div className="map-runs" aria-label="Map runs">
    <div className="bt-replay-bar">
      <select aria-label="Map run" value={file} onChange={e => setFile(e.target.value)}>
        {!runs?.length && <option value="">{runs ? 'No runs yet: Drive' : 'Reading…'}</option>}
        {runs?.map(r => <option key={r.file} value={r.file}>{r.when} · {r.frames} frames</option>)}
      </select>
      <button className="modal-btn" title="Read the runs again" onClick={() => void list()}>↻</button>
      <label className="pg-hint">Diverged past <input type="number" aria-label="Divergence threshold" min={1} max={200} value={threshold}
        onChange={e => setThreshold(Math.max(1, Number(e.target.value) || 8))} style={{ width: 48 }} /> px</label>
      {busy && <span className="pg-hint">Comparing with the recordings…</span>}
    </div>
    {error && <div className="pg-warn">{error}</div>}
    {report && <div className="map-runs-body">
      <div className="map-runs-list" aria-label="Link attempts">
        {report.notes.map(n => <div key={n} className="pg-hint">{n}</div>)}
        {report.summary && report.attempts.length > 0 && <div className="pg-hint">{summaryText(report.summary)}</div>}
        {!report.attempts.length && <div className="pg-hint">It tried no link in this run.</div>}
        {report.attempts.map(a => <button key={a.attempt} className={`map-run-attempt ${a.attempt === chosen ? 'on' : ''} ${attemptFailed(a) ? 'failed' : ''}`}
          onClick={() => { setChosen(a.attempt); setEvent(null); }}>
          <span>{typeof a.attempt === 'number' ? `#${a.attempt} ` : ''}{where(a)}</span>
          <small>{endedText(a)}{a.lineUp && a.kind !== 'line-up' ? ` · lined up in ${a.lineUp.taps.length} tap${a.lineUp.taps.length === 1 ? '' : 's'}` : ''}{a.recorded && a.startOffsetPx != null ? ` · started ${a.startOffsetPx.toFixed(1)} px off` : ''}{a.recorded && a.lastOnsetMs != null ? ` · parted at ${(a.lastOnsetMs / 1000).toFixed(2)} s` : ''}{jumpsText(a)}</small>
        </button>)}
      </div>
      <div className="map-runs-detail">
        {attempt ? <AttemptView a={attempt} selected={event} onEvent={(k: KeyEvent) => setEvent(e => e === k.index ? null : k.index)} />
          : <div className="pg-hint">Choose an attempt.</div>}
        {attempt?.recordedPath && <div className="pg-hint">On the map: the recorded path dashed white, the path it took orange, each key event joined where it was in both (red where they’re over {threshold} px apart), and a red ring where they parted for good.</div>}
      </div>
    </div>}
  </div>;
}
