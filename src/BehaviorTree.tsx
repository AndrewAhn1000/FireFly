import { createContext, useCallback, useContext, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type NodeChange, type NodeProps, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { BUTTONS, buttonLabel } from './Keyboard';
import { PreservedInput } from './PreservedInputs';
import { cleanError, playingText, stopHow, type PlayStatus } from './policyPlay';
import { BT, canConnect, compileBundle, connect, inputsOf, quoted, readTree, type BtData, type BtGroup, type BtInput, type BtInputType, type BtKind, type BtNode } from './behaviorModel';
import { readMap } from './mapModel';
import TreeReplay, { type ReplayFrame } from './TreeReplay';

// A behaviour tree: what the player does, built from nodes (worker/behavior.py runs it on every frame). Control nodes
// order their children, decorators change how their one child runs, conditions ask your States, and actions press
// keys. Run plays it in the captured window behind the same input guard as a policy, each node lit as it runs.

interface Recording { id: string; name: string; status: string; durationMs: number; metadata: { started: number; correction?: boolean; observationSchema?: { fields?: { name: string; type: string }[] } }; }
// A recording's stretches between stands (the worker's clips.list), to choose a clip from
interface Clip { from: number; to: number; ms: number; start: [number, number]; end: [number, number]; dx: number; dy: number; keys: [number, string, boolean][]; onStart?: unknown; onEnd?: unknown; }
interface ClipList { clips: Clip[]; start: number | null; stands: number; note: string | null; }

// A graph of the library a tree can run or go over
export interface GraphRef { id: string; name: string; kind: string; }
export interface BehaviorTreeProps {
  storageKey: string; graphId: string; name: string; windowId: string | null; capturing: boolean; recording: boolean; online: boolean;
  observed: Record<string, string>; stateLabels: Record<string, string>;
  scope: string; graphs: GraphRef[];  // the library's graphs, read by `${scope}-document-${id}`
}
export const graphDocument = (scope: string, id: string) => { try { return localStorage.getItem(`${scope}-document-${id}`); } catch { return null; } };
interface Ctx {
  update(id: string, patch: Partial<BtData>): void; remove(id: string): void; fields: Map<string, string>; labels: Record<string, string>;
  errors: Record<string, string>; live: Record<string, string>; locked: boolean; recordings: Recording[]; recorded: string[]; childCount(id: string): number;
  findClips(recording: string, measure: string, grounded?: string): Promise<ClipList | { error: string }>;
  graphId: string; graphs: GraphRef[]; read(id: string): string | null; variables: Map<string, string>;
}
const Context = createContext<Ctx>(null!);

// A formula, with the observations to put in it
function FormulaField({ label, value, placeholder, onChange, title }: { label: string; value: string; placeholder?: string; onChange(v: string): void; title?: string }) {
  const g = useContext(Context);
  return <label className="nodrag bt-field" title={title}>{label}
    <span className="bt-formula">
      <PreservedInput className="pg-source" aria-label={label} spellCheck={false} value={value} placeholder={placeholder} disabled={g.locked} onChange={e => onChange(e.target.value)} />
      <select aria-label={`Put a State in ${label}`} value="" disabled={g.locked} title="Put a State in the formula"
        onChange={e => { if (e.target.value) onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${quoted(e.target.value)}`); }}>
        <option value="">+ State</option>
        {[...g.fields].filter(([, t]) => ['number', 'boolean', 'vector', 'shapes'].includes(t)).map(([n, t]) => <option key={n} value={n}>{g.labels[n] ?? n} ({t})</option>)}
        {[...g.variables].map(([n, t]) => <option key={'v ' + n} value={n}>{n} ({t})</option>)}
      </select>
    </span></label>;
}

// Keys: those chosen as chips (a click lets go of one), and any key to add
function KeysField({ label, keys, onChange }: { label: string; keys: string[]; onChange(keys: string[]): void }) {
  const g = useContext(Context);
  const offered = [...g.recorded.filter(id => !keys.includes(id)), ...BUTTONS.map(b => b.id).filter(id => !keys.includes(id) && !g.recorded.includes(id))];
  return <div className="nodrag bt-field">{label}
    <div className="bt-keys">
      {keys.map(k => <button key={k} className="bt-chip" disabled={g.locked} title="Leave it out" onClick={() => onChange(keys.filter(x => x !== k))}>{buttonLabel(k)} ✕</button>)}
      <select aria-label={`Add a key to ${label}`} value="" disabled={g.locked} onChange={e => { if (e.target.value) onChange([...keys, e.target.value]); }}>
        <option value="">+ key</option>
        {offered.map(id => <option key={id} value={id}>{buttonLabel(id)}{g.recorded.includes(id) ? ' (recorded)' : ''}</option>)}
      </select>
    </div></div>;
}

function Number_({ label, value, min = 0, max = 600000, onChange, unit }: { label: string; value: number | undefined; min?: number; max?: number; unit?: string; onChange(v: number): void }) {
  const g = useContext(Context);
  return <label className="nodrag bt-field bt-number">{label}
    <span><input type="number" aria-label={label} min={min} max={max} value={value ?? ''} disabled={g.locked}
      onChange={e => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || 0))))} />{unit}</span></label>;
}

function ClipField({ id, d }: { id: string; d: BtData }) {
  const g = useContext(Context), update = (patch: Partial<BtData>) => g.update(id, patch);
  const recs = g.recordings.filter(r => r.status === 'complete' && !r.metadata.correction).sort((a, b) => b.metadata.started - a.metadata.started);
  const [picked, setPicked] = useState(''), rec = picked || d.recording || recs[0]?.id || '';
  const [found, setFound] = useState<ClipList | { error: string } | null>(null), [finding, setFinding] = useState(false);
  const vectors = [...g.fields].filter(([, t]) => t === 'vector').map(([n]) => n), booleans = [...g.fields].filter(([, t]) => t === 'boolean').map(([n]) => n);
  const measure = d.measure || vectors[0] || '';
  const find = async () => {
    setFinding(true);
    try { setFound(await g.findClips(rec, measure, d.grounded || undefined)); } finally { setFinding(false); }
  };
  const chosen = g.recordings.find(r => r.id === d.recording);
  return <div className="bt-clip">
    {d.recording ? <div className="bt-chosen">{chosen?.name ?? '(deleted recording)'} · {(((d.to ?? 0) - (d.from ?? 0)) / 1000).toFixed(2)} s</div>
      : <div className="pg-hint">Choose a stretch of a recording, from one stand to the next.</div>}
    <label className="nodrag bt-field">Recording<select aria-label="Clip recording" value={rec} disabled={g.locked} onChange={e => { setPicked(e.target.value); setFound(null); }}>
      {!recs.length && <option value="">No recordings</option>}
      {recs.map(r => <option key={r.id} value={r.id}>{r.name} · {Math.round(r.durationMs / 1000)} s</option>)}</select></label>
    <label className="nodrag bt-field" title="The player's position: where each stretch went is measured by it">Measured by<select aria-label="Clip position" value={measure} disabled={g.locked} onChange={e => update({ measure: e.target.value })}>
      {vectors.map(n => <option key={n} value={n}>{g.labels[n] ?? n}</option>)}</select></label>
    <label className="nodrag bt-field" title="Optional: a stand is only while this is true">On the ground<select aria-label="Clip on the ground" value={d.grounded ?? ''} disabled={g.locked} onChange={e => update({ grounded: e.target.value })}>
      <option value="">(not used)</option>{booleans.map(n => <option key={n} value={n}>{g.labels[n] ?? n}</option>)}</select></label>
    <button className="nodrag modal-btn" disabled={!rec || !measure || finding || g.locked} onClick={() => void find()}>{finding ? 'Finding…' : 'Find clips'}</button>
    {found && 'error' in found && <div className="pg-warn">{found.error}</div>}
    {found && 'clips' in found && <div className="pg-list nowheel bt-clips" aria-label="Clips">
      {found.note && <div className="pg-hint">{found.note}</div>}
      {found.clips.map((c, k) => {
        const on = d.recording === rec && d.from === c.from && d.to === c.to;
        return <button key={k} className={`nodrag bt-clip-row ${on ? 'bt-clip-on' : ''}`} title={`From (${c.start.join(', ')}) to (${c.end.join(', ')})`}
          onClick={() => update({ recording: rec, from: c.from, to: c.to })}>
          <b>{c.dx >= 0 ? '+' : ''}{Math.round(c.dx)}, {c.dy >= 0 ? '+' : ''}{Math.round(c.dy)} px</b> in {(c.ms / 1000).toFixed(2)} s
          <small>at {found.start != null ? ((c.from - found.start) / 1000).toFixed(1) : '?'} s · {[...new Set(c.keys.filter(e => e[2]).map(e => buttonLabel(e[1])))].join(', ') || 'nothing pressed'}</small>
        </button>;
      })}
    </div>}
  </div>;
}

const INPUT_TYPES: BtInputType[] = ['number', 'boolean', 'vector'];
// A tree's inputs, on its Root: what a Run tree node (or a map's link) gives it, read by name in its formulas
function InputsField({ inputs, onChange }: { inputs: BtInput[]; onChange(inputs: BtInput[]): void }) {
  const g = useContext(Context);
  const set = (k: number, patch: Partial<BtInput>) => onChange(inputs.map((x, j) => j === k ? { ...x, ...patch } : x));
  const fresh = () => { for (let k = 1; ; k++) if (!inputs.some(x => x.name === `input${k}`)) return `input${k}`; };
  return <div className="nodrag bt-field" aria-label="Tree inputs">Inputs
    {inputs.map((x, k) => <span key={k} className="bt-input">
      <PreservedInput aria-label={`Input ${k + 1} name`} value={x.name} disabled={g.locked} spellCheck={false} onChange={e => set(k, { name: e.target.value })} />
      <select aria-label={`Input ${k + 1} type`} value={x.type} disabled={g.locked} onChange={e => set(k, { type: e.target.value as BtInputType })}>
        {INPUT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select>
      <button className="pg-x" disabled={g.locked} title="Remove the input" aria-label={`Remove input ${x.name}`} onClick={() => onChange(inputs.filter((_, j) => j !== k))}>✕</button>
    </span>)}
    <button className="bt-add" disabled={g.locked} onClick={() => onChange([...inputs, { name: fresh(), type: 'vector' }])}>+ input</button>
    <span className="pg-hint">{inputs.length ? 'Given by another tree’s Run tree node, or by a map’s link (from and to, the places’ positions).' : 'None: it runs by itself. Give it inputs to run it from other trees.'}</span>
  </div>;
}

// Run tree: another behaviour tree, and a formula for each of its inputs
function RunField({ id, d }: { id: string; d: BtData }) {
  const g = useContext(Context), update = (patch: Partial<BtData>) => g.update(id, patch);
  const trees = g.graphs.filter(x => x.kind === 'behavior' && x.id !== g.graphId);
  const text = d.tree ? g.read(d.tree) : null, inputs = text != null ? inputsOf(readTree(text)) : [];
  return <>
    <label className="nodrag bt-field">Tree<select aria-label="Tree to run" value={d.tree ?? ''} disabled={g.locked} onChange={e => update({ tree: e.target.value })}>
      <option value="">Choose a tree…</option>{trees.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      {d.tree && !trees.some(t => t.id === d.tree) && <option value={d.tree}>(deleted tree)</option>}</select></label>
    {inputs.map(x => <FormulaField key={x.name} label={`${x.name} (${x.type})`} value={(d.args ?? {})[x.name] ?? ''}
      placeholder={x.type === 'vector' ? 'such as vec(480, 145)' : x.type === 'boolean' ? 'true or false' : 'a number'}
      onChange={v => update({ args: { ...(d.args ?? {}), [x.name]: v } })} />)}
    {d.tree && text != null && !inputs.length && <div className="pg-hint">It takes no inputs.</div>}
  </>;
}

// Go to: a map, and a place of it or a position (the place nearest it on the player's level)
function GoField({ id, d }: { id: string; d: BtData }) {
  const g = useContext(Context), update = (patch: Partial<BtData>) => g.update(id, patch);
  const maps = g.graphs.filter(x => x.kind === 'map');
  const text = d.map ? g.read(d.map) : null, map = text != null ? readMap(text) : null;
  const levels = [...new Set((map?.places ?? []).map(p => p.level))];
  return <>
    <label className="nodrag bt-field">Map<select aria-label="Map to go over" value={d.map ?? ''} disabled={g.locked} onChange={e => update({ map: e.target.value, place: '' })}>
      <option value="">Choose a map…</option>{maps.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      {d.map && !maps.some(m => m.id === d.map) && <option value={d.map}>(deleted map)</option>}</select></label>
    {map && <label className="nodrag bt-field">To<select aria-label="Place to go to" value={d.place ?? ''} disabled={g.locked} onChange={e => update({ place: e.target.value })}>
      <option value="">a position (the nearest place)</option>
      {levels.map(level => <optgroup key={String(level)} label={level == null ? 'Places' : `Level ${level}`}>
        {map.places.filter(p => p.level === level).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
      {d.place && !map.places.some(p => p.id === d.place) && <option value={d.place}>(deleted place)</option>}</select></label>}
    {map && !d.place && <FormulaField label="Position" value={d.target ?? ''} placeholder="such as vec(480, 145), or a State" onChange={v => update({ target: v })} />}
    {map && !map.places.length && <div className="pg-hint">The map has no places yet: open it to add them.</div>}
  </>;
}

function BtCard({ id, data: d, selected }: NodeProps<BtNode>) {
  const g = useContext(Context), spec = BT[d.kind], update = (patch: Partial<BtData>) => g.update(id, patch);
  const live = g.live[id], error = g.errors[id];
  const kids = g.childCount(id);
  return <div className={`pg-node bt-node bt-${d.kind} ${live ? `bt-${live}` : ''} ${selected ? 'pg-selected' : ''}`} aria-label={`${spec.title} node`}>
    {d.kind !== 'root' && <Handle type="target" position={Position.Top} id="parent" className="pg-handle bt-handle" />}
    <div className="pg-title"><span className="pg-glyph">{spec.glyph}</span><span className="bt-kind">{spec.title}</span>
      {d.kind !== 'root' && <PreservedInput className="nodrag pg-name bt-label" aria-label={`${spec.title} label`} value={d.label ?? ''} placeholder="label" disabled={g.locked}
        onChange={e => update({ label: e.target.value })} />}
      {live && <span className={`bt-badge bt-badge-${live}`}>{live}</span>}
      {d.kind !== 'root' && <button className="nodrag pg-x pg-node-delete" disabled={g.locked} title={`Delete ${spec.title}`} aria-label={`Delete ${spec.title} node`} onClick={() => g.remove(id)}>✕</button>}
    </div>
    <div className="pg-hint">{spec.help}</div>
    {d.kind === 'root' && <label className="nodrag pg-check"><input type="checkbox" aria-label="Start again" checked={d.loop !== false} disabled={g.locked} onChange={e => update({ loop: e.target.checked })} />
      Start again when it ends (else it stops)</label>}
    {d.kind === 'root' && <InputsField inputs={d.inputs ?? []} onChange={inputs => update({ inputs })} />}
    {d.kind === 'run' && <RunField id={id} d={d} />}
    {d.kind === 'go' && <GoField id={id} d={d} />}
    {(d.kind === 'repeat' || d.kind === 'retry') && <Number_ label={d.kind === 'repeat' ? 'Times (0: for ever)' : 'Tries'} value={d.times} min={d.kind === 'retry' ? 1 : 0} max={100000} onChange={v => update({ times: v })} />}
    {d.kind === 'limit' && <Number_ label="At most" value={d.ms} min={1} unit=" ms" onChange={v => update({ ms: v })} />}
    {(d.kind === 'condition' || d.kind === 'while') && <FormulaField label="True when" value={d.formula ?? ''} placeholder="such as `On Ground` and hp > 30" onChange={v => update({ formula: v })} />}
    {(d.kind === 'press' || d.kind === 'hold') && <KeysField label="Keys" keys={d.keys ?? []} onChange={keys => update({ keys })} />}
    {d.kind === 'press' && <Number_ label="For" value={d.ms} min={1} unit=" ms" onChange={v => update({ ms: v })} />}
    {(d.kind === 'hold' || d.kind === 'wait') && <>
      <FormulaField label="Until" value={d.until ?? ''} placeholder="blank: for the time below" onChange={v => update({ until: v })} />
      <Number_ label={(d.until ?? '').trim() ? 'Failing after' : 'For'} value={d.ms} min={1} unit=" ms" onChange={v => update({ ms: v })} /></>}
    {d.kind === 'walk' && <>
      <FormulaField label="Position" value={d.position ?? ''} placeholder="the player’s, such as `Player Position`" onChange={v => update({ position: v })} />
      <FormulaField label="Target" value={d.target ?? ''} placeholder="such as vec(480, 145), or a State" onChange={v => update({ target: v })} />
      <label className="nodrag bt-field">Along<select aria-label="Walk along" value={d.axis ?? 'x'} disabled={g.locked} onChange={e => update({ axis: e.target.value as 'x' | 'y' })}>
        <option value="x">x (across)</option><option value="y">y (up and down)</option></select></label>
      <KeysField label={(d.axis ?? 'x') === 'x' ? 'Keys to go left (−)' : 'Keys to go up (−)'} keys={d.less ?? []} onChange={less => update({ less })} />
      <KeysField label={(d.axis ?? 'x') === 'x' ? 'Keys to go right (+)' : 'Keys to go down (+)'} keys={d.more ?? []} onChange={more => update({ more })} />
      <Number_ label="There within" value={d.within} unit=" px" max={10000} onChange={v => update({ within: v })} />
      <Number_ label="Failing after" value={d.ms} min={1} unit=" ms" onChange={v => update({ ms: v })} /></>}
    {d.kind === 'clip' && <ClipField id={id} d={d} />}
    {d.kind === 'set' && <>
      <label className="nodrag bt-field">Name<PreservedInput aria-label="Variable name" value={d.name ?? ''} placeholder="such as start_x" disabled={g.locked} onChange={e => update({ name: e.target.value })} /></label>
      <FormulaField label="To" value={d.formula ?? ''} placeholder="such as `Player Position`.x" onChange={v => update({ formula: v })} /></>}
    {spec.children === 'many' && <div className="pg-hint bt-order">{kids ? `${kids} child${kids === 1 ? '' : 'ren'}, run left to right` : 'Wire its children below it'}</div>}
    {spec.children === 1 && !kids && <div className="pg-hint bt-order">Wire one node below it</div>}
    {error && <div className="pg-warn">{error}</div>}
    {spec.children !== 0 && <Handle type="source" position={Position.Bottom} id="children" className="pg-handle bt-handle" />}
  </div>;
}
const nodeTypes = { bt: BtCard };

export default function BehaviorTree(props: BehaviorTreeProps) { return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>; }

function Editor(props: BehaviorTreeProps) {
  const initial = useMemo(() => readTree(localStorage.getItem(props.storageKey)), [props.storageKey]);
  const [nodes, setNodes, onNodesChange] = useNodesState<BtNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [error, setError] = useState(''), [status, setStatus] = useState<PlayStatus | null>(null), [starting, setStarting] = useState(false);
  const flow = useReactFlow();
  const doc = useMemo(() => ({ version: 1 as const, kind: 'behavior' as const, nodes, edges }), [nodes, edges]);
  useEffect(() => { try { localStorage.setItem(props.storageKey, JSON.stringify(doc)); } catch { setError('Could not save the tree: local storage is full'); } }, [props.storageKey, doc]);
  // Playing: this tree's nodes lit as they run; anything else playing, the tree can't run
  useEffect(() => window.bridge.on('play:status', s => setStatus(s as PlayStatus)), []);
  const mine = !!status?.behavior && status.treeId === props.graphId;
  const running = !!status?.playing && mine, locked = running || starting;
  // run by another tree (or a map's link), its nodes lit as they run there
  const within = !running && !!status?.playing && !!status.behavior ? status.tree?.trees?.[props.graphId] ?? null : null;
  const [replayed, setReplayed] = useState<ReplayFrame | null>(null), [replaying, setReplaying] = useState(false);
  const live: Record<string, string> = replaying && replayed ? (replayed.treeId === props.graphId ? replayed.nodes : replayed.trees?.[props.graphId] ?? {})
    : running ? status?.tree?.nodes ?? {} : within ?? {};
  // The recordings, for clips and the keys they hold
  const [recordings, setRecordings] = useState<Recording[]>([]);
  useEffect(() => {
    if (!props.online) return;
    let alive = true;
    void (async () => {
      try { const r = (await window.bridge.invoke('dataset.list')) as { recordings: (Recording & { metadata: { actionSchema?: { buttons?: { id: string }[] } } })[] };
        if (alive) setRecordings(r.recordings.filter(x => x.status === 'complete')); } catch { /* none */ }
    })();
    return () => { alive = false; };
  }, [props.online]);
  const recorded = useMemo(() => [...new Set(recordings.flatMap(r => ((r.metadata as { actionSchema?: { buttons?: { id: string }[] } }).actionSchema?.buttons ?? []).map(b => b.id)))], [recordings]);
  // What formulas read: what FireFly observes now, and what the recordings hold
  const fields = useMemo(() => {
    const out = new Map(Object.entries(props.observed));
    for (const r of recordings) for (const f of r.metadata.observationSchema?.fields ?? []) if (!out.has(f.name)) out.set(f.name, f.type);
    return out;
  }, [props.observed, recordings]);
  const fieldList = useMemo(() => [...fields].map(([name, type]) => ({ name, type })), [fields]);
  // What's wrong with it, by node, a moment after it changes (the worker checks every formula), with the trees it runs
  // and the maps it goes over as they're saved now
  const read = useCallback((id: string) => graphDocument(props.scope, id), [props.scope]);
  const [others, setOthers] = useState(0);  // the other graphs read again every few seconds, for changes made to them
  useEffect(() => { const t = setInterval(() => setOthers(n => n + 1), 3000); return () => clearInterval(t); }, []);
  const bundled = useMemo(() => compileBundle(doc, read), [doc, read, others]); // eslint-disable-line react-hooks/exhaustive-deps
  const compiled = useMemo(() => ({ tree: bundled.tree, unreached: bundled.unreached }), [bundled]);
  const inputs = useMemo(() => inputsOf(doc), [doc]);
  const variables = useMemo(() => new Map<string, string>([...inputs.map(x => [x.name, 'input'] as [string, string]),
    ...nodes.filter(n => n.data.kind === 'set' && n.data.name).map(n => [n.data.name!, 'variable'] as [string, string])]), [inputs, nodes]);
  const [errors, setErrors] = useState<Record<string, string>>({}), [problem, setProblem] = useState('');
  const checkKey = JSON.stringify([bundled.tree, bundled.trees, bundled.maps, fieldList]);
  useEffect(() => {
    if (!compiled.tree) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await window.bridge.policy.invoke('behavior.check', { tree: bundled.tree, trees: bundled.trees, maps: bundled.maps, treeId: props.graphId, fields: fieldList }) as { errors: Record<string, string>; problem?: string };
        if (alive) { setErrors(r.errors ?? {}); setProblem(Object.keys(r.errors ?? {}).length ? '' : r.problem ?? ''); }
      } catch (e) { if (alive) setProblem(cleanError(e)); }
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [checkKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((id: string, patch: Partial<BtData>) => {
    if (locked) return;
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
  }, [locked, setNodes]);
  const remove = useCallback((id: string) => {
    if (locked) return;
    setNodes(ns => ns.filter(n => n.id !== id || n.data.kind === 'root'));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
  }, [locked, setNodes, setEdges]);
  // The Root can't be deleted; nothing changes while it runs but where nodes are
  const onNodes = useCallback((changes: NodeChange<BtNode>[]) => onNodesChange(changes.filter(c =>
    !(c.type === 'remove' && (locked || nodes.find(n => n.id === c.id)?.data.kind === 'root')))), [onNodesChange, locked, nodes]);
  const valid = useCallback((c: Connection | Edge) => !locked && !!c.source && !!c.target && canConnect(doc, c.source, c.target), [locked, doc]);
  const onConnect = useCallback((c: Connection) => { if (valid(c)) setEdges(connect(doc, c.source!, c.target!)); }, [valid, doc, setEdges]);
  const add = (kind: BtKind, position?: { x: number; y: number }) => {
    const root = nodes.find(n => n.data.kind === 'root');
    const at = position ?? { x: (root?.position.x ?? 0) + 60 * (nodes.length % 6), y: (root?.position.y ?? 0) + 160 + 30 * Math.floor(nodes.length / 6) };
    setNodes(ns => [...ns, { id: crypto.randomUUID(), type: 'bt', position: at, data: { kind, ...structuredClone(BT[kind].defaults) } as BtData }]);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (locked) return;
    try { const item = JSON.parse(e.dataTransfer.getData('application/firefly-bt')); if (item.kind in BT) add(item.kind, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })); } catch { /* another drag */ }
  };
  const findClips = useCallback(async (recording: string, measure: string, grounded?: string) => {
    try { return await window.bridge.policy.invoke('clips.list', { recording, position: quoted(measure), ...(grounded ? { grounded: quoted(grounded) } : {}), fields: fieldList, formulas: [] }) as ClipList; }
    catch (e) { return { error: cleanError(e) }; }
  }, [fieldList]);
  const run = async () => {
    const now = compileBundle(doc, read);  // the trees and maps as they're saved now
    if (!props.windowId || !now.tree) return;
    setError(''); setStarting(true); setReplaying(false);
    try {
      const res = await window.bridge.policy.play({ windowId: props.windowId, graphId: props.graphId, name: props.name, treeId: props.graphId,
        behavior: { tree: now.tree, trees: now.trees, maps: now.maps, treeId: props.graphId, name: props.name, fields: fieldList, buttons: BUTTONS.map(b => ({ id: b.id, vk: b.vk })) } });
      if (!res.ok) setError(`Can’t run: ${res.error ?? 'it didn’t start'}`);
    } finally { setStarting(false); }
  };
  const childCount = useCallback((id: string) => edges.filter(e => e.source === id).length, [edges]);
  // The wires down to what's running, moving
  const shownEdges = useMemo(() => edges.map(e => ({ ...e, type: 'smoothstep', animated: live[e.source] === 'running' && live[e.target] === 'running',
    className: live[e.target] ? `bt-edge-${live[e.target]}` : undefined })), [edges, live]);
  let viewport: Viewport | undefined;
  try { viewport = JSON.parse(localStorage.getItem(props.storageKey + '-view') ?? 'null') ?? undefined; } catch { /* the initial view */ }
  const wrong = Object.keys(errors).length; // nodes not under the Root just don't run
  const groups: BtGroup[] = ['Control', 'Decorators', 'Conditions', 'Actions', 'Trees and maps'];
  const takesInputs = inputs.length > 0;
  return <Context.Provider value={{ update, remove, fields, labels: props.stateLabels, errors, live, locked, recordings, recorded, childCount, findClips,
    graphId: props.graphId, graphs: props.graphs, read, variables }}>
    <div className="collection-editor bt-editor">
      <div className="collection-toolbar">
        {running ? <button className="modal-btn" onClick={e => void window.bridge.policy.stop(stopHow(e))}>Stop</button>
          : <button className="modal-btn primary" aria-label="Run the tree" disabled={!props.capturing || !props.windowId || props.recording || starting || !!status?.playing || wrong > 0 || takesInputs}
            title={takesInputs ? 'It takes inputs: run it from another tree’s Run tree node' : !props.capturing ? 'Start a capture session first' : wrong ? 'Put right what the nodes say first' : 'Run it in the game: your keys or mouse take over'} onClick={() => void run()}>Run</button>}
        <button className={`modal-btn ${replaying ? 'primary' : ''}`} aria-label="Replay runs" aria-pressed={replaying} title="Step through a run of it, frame by frame: what each node did, what it pressed and what it read"
          onClick={() => setReplaying(r => !r)}>Replay</button>
        <span className="bt-status">{running ? playingText(status!) : within ? `Running inside ${status?.name ?? 'another tree'}: ${status?.tree?.text ?? ''}` : mine && status?.reason ? `Stopped: ${status.reason}` : status?.playing && !mine ? 'Something else is playing' : wrong
          ? `${Object.keys(errors).length} node${Object.keys(errors).length === 1 ? '' : 's'} to put right${compiled.unreached.length ? ` · ${compiled.unreached.length} not under the Root (they don’t run)` : ''}`
          : problem || (compiled.unreached.length ? `Ready · ${compiled.unreached.length} node${compiled.unreached.length === 1 ? '' : 's'} not under the Root (they don’t run)` : 'Ready')}</span>
      </div>
      {error && <div className="collection-error">{error}</div>}
      <div className="collection-body">
        <aside className="pg-palette" aria-label="Behaviour tree nodes">
          {groups.map(group => <div key={group}>
            <div className="pg-palette-hd">{group}</div>
            {(Object.keys(BT) as BtKind[]).filter(k => BT[k].group === group).map(kind => <button key={kind} className="pg-palette-item" title={BT[kind].help} disabled={locked}
              draggable={!locked} onDragStart={e => e.dataTransfer.setData('application/firefly-bt', JSON.stringify({ kind }))} onClick={() => add(kind)}>
              <span className="pg-glyph">{BT[kind].glyph}</span>{BT[kind].title}</button>)}
          </div>)}
          <div className="pg-hint">Each frame the tree runs from its Root. Wire a node's children below it: they run left to right. A child still running carries on next frame, so wrap it in a While to keep checking something.</div>
          <div className="pg-hint">Formulas read your States by name (`backticks` for names with spaces), variables you Remember, the Root’s inputs, and x[-1] for a frame back.</div>
          <div className="pg-hint">Run tree runs another tree, so one you build once (a jump, getting onto a ladder) is used everywhere. Go to goes over a map: make one with + Map.</div>
        </aside>
        <div className="pg-canvas" onDragOver={e => e.preventDefault()} onDrop={drop}>
          <ReactFlow nodes={nodes} edges={shownEdges} nodeTypes={nodeTypes} onNodesChange={onNodes} onEdgesChange={locked ? undefined : onEdgesChange}
            nodesConnectable={!locked} deleteKeyCode={locked ? null : ['Delete', 'Backspace']} onConnect={onConnect} isValidConnection={valid}
            defaultViewport={viewport} fitView={!viewport} minZoom={0.25} maxZoom={1.5} colorMode="dark"
            onMoveEnd={(_, v) => localStorage.setItem(props.storageKey + '-view', JSON.stringify(v))}>
            <Background gap={20} /><Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      {replaying && <TreeReplay treeId={props.graphId} labels={props.stateLabels} nodes={nodes} onFrame={setReplayed} />}
    </div>
  </Context.Provider>;
}

