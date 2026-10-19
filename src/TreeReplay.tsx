import { useEffect, useMemo, useState } from 'react';
import { buttonLabel } from './Keyboard';
import { cleanError } from './policyPlay';
import { BT, type BtNode } from './behaviorModel';

// Stepping through a run of a behaviour tree, frame by frame (the worker's behavior.traces and behavior.trace, from
// <root>/traces/behavior): which nodes it reached and how each answered (lit on the tree as it was), what it held and
// pressed, what it was doing, and the values of what its formulas read, so you can see why it did what it did.

type Status = 'running' | 'success' | 'failure';
interface Frame {
  t: number; now: number; keys: string[]; nodes: Record<string, Status>; trees?: Record<string, Record<string, Status>>;
  maps?: Record<string, { text: string; at: string | null; dest: string | null; link: string | null; last?: string }>;
  text: string | null; values?: Record<string, unknown>; sequence?: [number, number, boolean][]; done?: string;
}
export interface ReplayFrame extends Frame { treeId: string | null; }
interface Run { file: string; when: string; frames: number; name?: string | null; }
interface Trace { head: { treeId?: string | null; buttons?: string[]; reads?: string[]; name?: string | null }; frames: Frame[]; }

const show = (v: unknown): string => v == null ? '—' : Array.isArray(v) ? (v.length === 2 && v.every(x => typeof x === 'number')
  ? `(${v.map(x => Math.round(x as number * 10) / 10).join(', ')})` : `${v.length} item${v.length === 1 ? '' : 's'}`)
  : typeof v === 'number' ? String(Math.round(v * 100) / 100) : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v);
const same = (a?: Frame, b?: Frame) => !!a && !!b && JSON.stringify([a.nodes, a.trees, a.keys]) === JSON.stringify([b.nodes, b.trees, b.keys]);

export default function TreeReplay({ treeId, labels, nodes, onFrame }: { treeId: string; labels: Record<string, string>; nodes: BtNode[]; onFrame(f: ReplayFrame | null): void }) {
  const [runs, setRuns] = useState<Run[] | null>(null), [file, setFile] = useState(''), [trace, setTrace] = useState<Trace | null>(null);
  const [at, setAt] = useState(0), [playing, setPlaying] = useState(false), [error, setError] = useState('');
  const list = async () => {
    try {
      const r = (await window.bridge.policy.invoke('behavior.traces', { treeId })) as { runs: Run[] };
      setRuns(r.runs); setFile(f => f && r.runs.some(x => x.file === f) ? f : r.runs[0]?.file ?? '');
    } catch (e) { setError(cleanError(e)); setRuns([]); }
  };
  useEffect(() => { void list(); }, [treeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!file) { setTrace(null); return; }
    let alive = true;
    void (async () => {
      try { const r = (await window.bridge.policy.invoke('behavior.trace', { file })) as Trace; if (alive) { setTrace(r); setAt(0); setError(''); } }
      catch (e) { if (alive) setError(cleanError(e)); }
    })();
    return () => { alive = false; };
  }, [file]);
  const frames = trace?.frames ?? [], frame = frames[Math.min(at, frames.length - 1)];
  useEffect(() => { onFrame(frame ? { ...frame, treeId: trace?.head.treeId ?? null } : null); }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onFrame(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // played back as it went, from the frame on screen
  useEffect(() => {
    if (!playing || !frames.length) return;
    if (at >= frames.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => setAt(k => k + 1), Math.min(500, Math.max(5, frames[at + 1].now - frames[at].now)));
    return () => clearTimeout(timer);
  }, [playing, at, frames]);
  const step = (k: number) => { setPlaying(false); setAt(Math.max(0, Math.min(frames.length - 1, k))); };
  const change = (dir: 1 | -1) => { let k = at + dir; while (k > 0 && k < frames.length - 1 && same(frames[k], frames[at])) k += dir; step(k); };
  const named = useMemo(() => new Map(nodes.map(n => [n.id, n.data.label || BT[n.data.kind]?.title || n.data.kind])), [nodes]);
  const start = frames[0]?.now ?? 0;
  const reached = frame ? Object.entries(frame.nodes).filter(([id]) => named.has(id)) : [];
  const inner = frame ? Object.entries(frame.trees ?? {}).filter(([id]) => id !== treeId) : [];
  return <div className="bt-replay" aria-label="Replay">
    <div className="bt-replay-bar">
      <select aria-label="Run to replay" value={file} onChange={e => setFile(e.target.value)}>
        {!runs?.length && <option value="">{runs ? 'No runs kept yet: Run it' : 'Reading…'}</option>}
        {runs?.map(r => <option key={r.file} value={r.file}>{r.when} · {r.frames} frames</option>)}
      </select>
      <button className="modal-btn" title="Read the runs again" onClick={() => void list()}>↻</button>
      <button className="modal-btn" aria-label="First frame" disabled={!frames.length} onClick={() => step(0)}>⏮</button>
      <button className="modal-btn" aria-label="Last change" title="Back to where what it did last changed" disabled={!frames.length} onClick={() => change(-1)}>«</button>
      <button className="modal-btn" aria-label="Previous frame" disabled={!frames.length} onClick={() => step(at - 1)}>‹</button>
      <button className="modal-btn" aria-label={playing ? 'Pause' : 'Play'} disabled={!frames.length} onClick={() => setPlaying(p => !p)}>{playing ? '❚❚' : '▶'}</button>
      <button className="modal-btn" aria-label="Next frame" disabled={!frames.length} onClick={() => step(at + 1)}>›</button>
      <button className="modal-btn" aria-label="Next change" title="On to where what it does next changes" disabled={!frames.length} onClick={() => change(1)}>»</button>
      <input type="range" aria-label="Frame" min={0} max={Math.max(0, frames.length - 1)} value={Math.min(at, Math.max(0, frames.length - 1))} disabled={!frames.length}
        onChange={e => step(Number(e.target.value))} />
      <span className="bt-replay-at">{frame ? `frame ${at + 1}/${frames.length} · ${((frame.now - start) / 1000).toFixed(2)} s` : ''}</span>
    </div>
    {error && <div className="pg-warn">{error}</div>}
    {frame && <div className="bt-replay-body">
      <div>
        <div className="pg-section-hd">Doing</div>
        <div className="bt-replay-text">{frame.text ?? 'nothing'}{frame.done ? ` · the tree ${frame.done === 'success' ? 'succeeded' : 'failed'}` : ''}</div>
        <div className="pg-section-hd">Holding</div>
        <div>{frame.keys.length ? frame.keys.map(buttonLabel).join(' + ') : 'nothing'}</div>
        {frame.sequence && <><div className="pg-section-hd">Sent to play</div>
          <div className="pg-hint">{frame.sequence.length ? frame.sequence.map(([ms, k, down]) => `${Math.round(ms)} ms ${down ? '↓' : '↑'}${buttonLabel(trace?.head.buttons?.[k] ?? String(k))}`).join(', ') : 'stop what was playing'}</div></>}
        {Object.entries(frame.maps ?? {}).map(([id, m]) => <div key={id}><div className="pg-section-hd">Map</div><div>{m.text}</div>{m.last && <div className="pg-hint">{m.last}</div>}</div>)}
      </div>
      <div>
        <div className="pg-section-hd">Nodes reached</div>
        <div className="bt-replay-nodes">{reached.map(([id, s]) => <span key={id} className={`bt-badge bt-badge-${s}`} title={s}>{named.get(id)}: {s}</span>)}
          {!reached.length && <span className="pg-hint">none of this tree’s</span>}</div>
        {inner.map(([id, s]) => <div key={id} className="pg-hint">In a tree it ran: {Object.values(s).filter(x => x === 'running').length} running, {Object.values(s).filter(x => x === 'failure').length} failed</div>)}
      </div>
      <div>
        <div className="pg-section-hd">What it read</div>
        <table className="bt-replay-values"><tbody>
          {Object.entries(frame.values ?? {}).map(([name, v]) => <tr key={name}><td>{labels[name] ?? name}</td><td>{show(v)}</td></tr>)}
        </tbody></table>
        {!Object.keys(frame.values ?? {}).length && <div className="pg-hint">{trace?.head.reads ? 'Its formulas read nothing' : 'Runs from before replays don’t keep what was read'}</div>}
      </div>
    </div>}
  </div>;
}
