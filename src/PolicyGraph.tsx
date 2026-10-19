import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, addEdge, reconnectEdge, useEdgesState, useNodeId, useNodesState, useReactFlow,
  type Connection, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import AliasInput from './FormulaAliasInput';
import { buttonLabel } from './Keyboard';
import { cleanError, correctionShareHint, correctionsOf, DEFAULT_CORRECTION_SHARE, deleteVersions, MAX_CORRECTION_SHARE, meanF1, newestFirst, percent, playingText, policyNodes, POLICY_VERSION, stopHow, type PlayStatus, type PolicyVersion, type Schema } from './policyPlay';
import { NEW_INPUT, aliasFrom, renameIn } from './formulaInputs';
import { PreservedTextarea, PreservedInput } from './PreservedInputs';
import {
  FORMULA_INPUT_TYPES, GOAL_DEFAULTS, GOAL_FACING, GOAL_POSITION, GOAL_TARGET, GRID_CELL, PLANNER_DATA, PLANNER_DESTINATION, PLANNER_LEVEL, PLANNER_MAP,
  PLAN_CELL, PLAN_SNAP, PLAN_TOLERANCE, MOVEMENT_FIELDS, movementSpec, type Movement, ROUTE_AHEAD_S, SPATIAL_BOUNDS, planDefaults, planShapes, SPATIAL_FACING, SPATIAL_POINT, SPATIAL_RADII, SPATIAL_REACH, VALUE_TYPES, compilePolicy, formulaSpecs, gridSpecs,
  fieldApplies, goalColumns, goalSpecs, makesCycle, migrateGraph, nameOf, playGoal, readGraph, spatialColumns, spatialFields, spatialSpec, spatialSpecs, takesMany,
  type Compiled, type FormulaCheck, type FormulaData, type GoalData, type GraphDoc, type PlannerData, type GraphNode, type GridData, type PolicyData, type RecordingsData,
  type SpatialData, type SpatialField, type SpatialPick, type SpatialRead, type SpatialValue, type StateData,
} from './graphModel';

// The Policy Graph: a policy's dataset built as a graph. States (the observations recordings hold) are
// dragged in, formulas relate them to each other, a Recordings node says which recordings are the rows,
// and a Policy node collects the values that are its dataset's columns and the buttons that are its
// labels. Train makes a new version of that named policy, which can be played; the same dataset can be
// exported. The worker (worker/worker.py) checks formulas, previews and trains; this only edits the graph
// and shows what it says. The graph is kept per captured window, like its regions and States.

interface Recording {
  id: string; name: string; status: string; samples: number; invalidSamples: number; durationMs: number;
  metadata: { started: number; hz?: number; observationSchema?: Schema; actionSchema?: Schema; correction?: boolean; policyId?: string };
}
interface Preview {
  samples: number; stepMs: number; recordings: { id: string; rows: number }[]; skipped: string[];
  skippedReasons: Record<string, number>; values: string[]; inputs: number; buttons: { id: string; pressed: number }[];
}
// What the worker says about a grid: its cells in the latest sample, for the Grid node's picture
interface GridCheck { name: string; cols?: number; rows?: number; values: number[] | null; screen?: [number, number] | null; centred?: boolean; error: string | null; }
// What the worker says about a Spatial node: its columns and their values in the latest sample, for its table,
// and what it draws (worker/spatial.py, picture): the bounds; each input's shapes, with the fields of theirs the
// node's fields read; the point, facing and the radii its fields count within; and per input what each field is
// about: the shape it picked and where its value ends ([x, y, distance]), or the shapes it counts or the point is in
type SpatialAbout = { end: [number, number, number]; shape: number } | { shapes: number[] } | null;
interface SpatialPictureData {
  bounds: [number, number, number, number]; fitted: boolean; point: [number, number]; facingLeft: boolean | null; radii: number[];
  areas?: Record<string, [number, number, number, number]>; // each field's area, [left, top, right, bottom]
  sets: {
    alias: string; shapes: { points: [number, number][]; closed: boolean; props?: Record<string, number> }[];
    props?: string[]; fields?: Record<string, SpatialAbout>; distances?: (number | null)[];
  }[];
}
interface SpatialCheck { name: string; columns: string[]; values: number[] | null; picture?: SpatialPictureData | null; error: string | null; }
// What the worker says about a Goal: its columns, toward its Target in the latest sample, and how far the player
// went in its look-ahead from there (what training aims at)
interface GoalCheck { name: string; columns: string[]; values: number[] | null; moved: number | null; error: string | null; }
interface Epoch { epoch: number; validationLoss: number; buttonF1?: number; }

const fmt = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 1);
// A distance or count: at most one decimal, none when it's whole (152, not 152.0)
const px1 = (v: number) => String(Math.round(v * 10) / 10);
const skipText = (skips?: Record<string, number>) => {
  const entries = Object.entries(skips ?? {}).filter(([, n]) => n > 0);
  if (!entries.length) return '';
  const total = entries.reduce((n, [, c]) => n + c, 0);
  return `${total.toLocaleString()} step${total === 1 ? '' : 's'} skipped: ${entries.slice(0, 3).map(([r, n]) => `${r} (${n.toLocaleString()})`).join(', ')}${entries.length > 3 ? ', …' : ''}`;
};

interface Ctx {
  fields: Map<string, string>; recordedAnywhere: Set<string>; labels: Record<string, string>; recordings: Recording[]; checks: Map<string, FormulaCheck>; gridChecks: Map<string, GridCheck>;
  spatialChecks: Map<string, SpatialCheck>; goalChecks: Map<string, GoalCheck>;
  compiled: Record<string, Compiled>; previews: Record<string, Preview | { error: string } | 'loading'>;
  versions: PolicyVersion[]; deleteVersion(v: PolicyVersion, n: number, corrections: number): void;
  deleteAll(versions: PolicyVersion[], name: string, corrections: number): void; status: PlayStatus; training: { nodeId: string; progress: Epoch | null } | null;
  capturing: boolean; windowId: string | null; recordingNow: boolean; corrections: boolean;
  setCorrections(on: boolean): void;
  update(id: string, patch: Record<string, unknown>): void; removeNode(id: string): void; removeInput(id: string, alias: string): void;
  train(id: string, withCorrections?: boolean): void; exportDataset(id: string): void; play(modelId: string): void; stop(e?: { detail: number }): void;
  drive(plannerId: string): void; // the planner moves the player itself, to its destination (worker/executor.py)
  exported: { nodeId: string; text: string; path?: string } | null;
  wiredInto(nodeId: string, handle: string): string | null; // the name of what's wired into a node's input
  wiredAll(nodeId: string, handle: string): string[];       // every one, for an input that takes several
  nodeInto(nodeId: string, handle: string): GraphNode | undefined; // the node wired into a node's input
  planPictures: Record<string, PlanPicture | { error: string }>;     // each planning Planner's map, by node id
  measurePlan(nodeId: string, sample: LiveSample): Promise<PlanPicture | { error: string }>; // one on what FireFly observes now
  nodesOutOf(nodeId: string): GraphNode[];                  // the nodes a node's output is wired into
  measureSpatial(nodeId: string, sample: LiveSample): Promise<SpatialCheck | null>; // a Spatial node on one sample (its preview, live)
  latestLive(): LiveSample | null; // what FireFly observed last, while a session runs
  sharedWith: Record<string, string[]>; // a Policy node's id that another graph's Policy node has too: those graphs' names
  separate(nodeId: string): void;       // that Policy node made its own policy (a new id), the versions staying with the other
  refreshChecks(): void;           // ask the worker about every node again, now
  // A formula's or Spatial node's inputs: a new one wired from a node, renamed (in a formula's text too), and what can be wired
  addInput(formulaId: string, sourceId: string): void; renameInput(formulaId: string, alias: string, next: string): void;
  inputChoices(formulaId: string): { id: string; label: string }[];
  hot(nodeId: string, handle: string): boolean; // an end of the wire under the pointer
}
const GraphContext = createContext<Ctx | null>(null);
const useGraph = () => useContext(GraphContext)!;

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────────

function StateNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as StateData, type = g.fields.get(d.name);
  const usable = type && FORMULA_INPUT_TYPES.includes(type);
  return <div className={`pg-node pg-state ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-dot" />{g.labels[d.name] ?? d.name}<span className="pg-type">{type ?? '?'}</span><button className="nodrag pg-x pg-node-delete" title={`Delete ${g.labels[d.name] ?? d.name} node`} aria-label="Delete node" onClick={() => g.removeNode(id)}>✕</button></div>
    {g.labels[d.name] && g.labels[d.name] !== d.name && <div className="pg-hint">recorded as {d.name}</div>}
    {!type && <div className="pg-warn">Its type isn't known until FireFly observes it: start a capture session</div>}
    {type && !g.recordedAnywhere.has(d.name) && <div className="pg-hint">Not recorded yet: tick it in the Recordings tab and record</div>}
    {type === 'object' && <div className="pg-hint">A table: it can be a Spatial node's Bounds, such as {'{left, top, right, bottom}'}</div>}
    {type && !usable && type !== 'object' && <div className="pg-warn">{type} can't be used</div>}
    {type === 'shapes' && <div className="pg-hint">Shapes are used through a formula, a Grid or a Spatial node</div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

function FormulaNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as FormulaData, check = g.checks.get(d.name.trim());
  const choices = g.inputChoices(id);
  return <div className={`pg-node pg-formula ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">ƒ</span>
      <PreservedInput className="nodrag pg-name" aria-label="Formula name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete formula ${d.name || ''}`} aria-label="Delete formula node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    {d.inputs.map(alias => {
      const from = g.wiredInto(id, `in:${alias}`);
      return <div key={alias} className="pg-input-row">
        <PgHandle type="target" position={Position.Left} id={`in:${alias}`} />
        <AliasInput alias={alias} taken={d.inputs} onRename={next => g.renameInput(id, alias, next)} />
        <span className={`pg-from ${from ? '' : 'pg-unwired'}`} title={from ? `${alias} stands for ${g.labels[from] ?? from}` : 'Wire something into it'}>
          {from ? `← ${g.labels[from] ?? from}` : 'not wired'}</span>
        <button className="nodrag pg-x" title={`Remove input ${alias}`} onClick={() => g.removeInput(id, alias)}>✕</button>
      </div>;
    })}
    <div className="pg-input-row pg-new-input">
      <PgHandle type="target" position={Position.Left} id={NEW_INPUT} extra="pg-handle-new" />
      <span>Drop a wire here for a new input, or</span>
      <select className="nodrag" aria-label="Add an input from" value="" onChange={e => { if (e.target.value) g.addInput(id, e.target.value); }}>
        <option value="">+ input from…</option>
        {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </div>
    <PreservedTextarea className="nodrag nowheel pg-source" aria-label="Formula" rows={2} spellCheck={false} value={d.source}
      placeholder={d.inputs.length >= 2 ? `distance(${d.inputs[0]}, ${d.inputs[1]})` : 'a * 2'}
      onChange={e => g.update(id, { source: e.target.value })} />
    {!check ? <div className="pg-hint">{d.name.trim() ? 'Checking…' : 'Name it to use it'}</div>
      : check.error ? <div className="pg-error">{check.error}</div>
      : <div className="pg-hint">{check.type === 'vector' ? 'vector' : check.type === 'boolean' ? 'true/false' : 'number'} → {check.columns.join(', ')}
          {check.preview && check.preview.rows > 0 && <> · {check.preview.value ? `first ${check.preview.value.map(fmt).join(', ')}` : 'never there'}
            {check.preview.missing > 0 && <span className="pg-missing" title={check.preview.reason ?? ''}> · missing in {check.preview.missing} of {check.preview.rows}</span>}</>}
        </div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// A node's connection point, lit while the wire under the pointer ends there
function PgHandle({ type, position, id, extra = '' }: { type: 'source' | 'target'; position: Position; id: string; extra?: string }) {
  const g = useGraph(), nodeId = useNodeId() ?? '';
  return <Handle type={type} position={position} id={id} className={`pg-handle ${extra} ${g.hot(nodeId, id) ? 'pg-handle-hot' : ''}`} />;
}


// A heat map of a grid's cells, as the worker worked them out for the latest sample
function GridPicture({ check, cols, rows, centred }: { check?: GridCheck; cols: number; rows: number; centred: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = 216, height = Math.max(24, Math.round(width * rows / cols * (check?.screen ? check.screen[1] / check.screen[0] * cols / rows : 9 / 16)));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    const values = check?.values, cw = c.width / cols, ch = c.height / rows;
    if (values && values.length === cols * rows)
      values.forEach((v, i) => { if (v > 0) { g.fillStyle = `rgba(86, 195, 86, ${0.25 + 0.75 * Math.min(1, v)})`; g.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, Math.ceil(cw), Math.ceil(ch)); } });
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let x = 1; x < cols; x++) { g.beginPath(); g.moveTo(x * cw, 0); g.lineTo(x * cw, c.height); g.stroke(); }
    for (let y = 1; y < rows; y++) { g.beginPath(); g.moveTo(0, y * ch); g.lineTo(c.width, y * ch); g.stroke(); }
    if (centred) { // where it's centred, such as the player
      g.strokeStyle = '#f0a020'; g.lineWidth = 2;
      g.beginPath(); g.arc(c.width / 2, c.height / 2, 4, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1;
    }
  }, [check, cols, rows, height, centred]);
  return <canvas ref={ref} width={width} height={height} className="pg-grid-picture" aria-label="Grid preview" />;
}

function GridNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as GridData, check = g.gridChecks.get(d.name.trim());
  const centre = g.wiredInto(id, 'in:center'), cell = d.cell ?? GRID_CELL;
  const num = (key: 'cols' | 'rows' | 'width' | 'height' | 'cell', min: number, max: number) => (e: ChangeEvent<HTMLInputElement>) =>
    g.update(id, { [key]: Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))) });
  return <div className={`pg-node pg-grid ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">▦</span>
      <PreservedInput className="nodrag pg-name" aria-label="Grid name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete grid ${d.name || ''}`} aria-label="Delete grid node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="in:shapes" />Shapes, such as platforms</div>
    <div className="pg-port" title="Wire a position in, such as the player's, and the grid moves with it: a cell is the same place beside it anywhere on the screen, and on any map">
      <PgHandle type="target" position={Position.Left} id="in:center" />
      {centre ? <>Centred on <b>{g.labels[centre] ?? centre}</b></> : 'Centred on (optional): else the whole screen'}</div>
    <div className="pg-settings">
      <label className="nodrag">Columns<input type="number" min={1} max={64} value={d.cols} onChange={num('cols', 1, 64)} /></label>
      <label className="nodrag">Rows<input type="number" min={1} max={64} value={d.rows} onChange={num('rows', 1, 64)} /></label>
      <label className="nodrag">Each cell<select value={d.mode} onChange={e => g.update(id, { mode: e.target.value })}>
        <option value="coverage">How much is covered</option><option value="present">Whether anything is there</option></select></label>
      {centre
        ? <label className="nodrag" title="Each cell's size: the grid reaches half its width and height either side of the centre">Cell (px)
            <input type="number" min={4} max={400} value={cell} onChange={num('cell', 4, 400)} /></label>
        : <label className="nodrag" title="The screen size used for recordings from before FireFly kept each frame's size">Screen (older recordings)
            <span className="pg-pair"><input type="number" min={16} value={d.width} onChange={num('width', 16, 8000)} />×<input type="number" min={16} value={d.height} onChange={num('height', 16, 8000)} /></span></label>}
    </div>
    {centre && <div className="pg-hint">Reaches {d.cols * cell}×{d.rows * cell} px around it.</div>}
    <GridPicture check={check} cols={d.cols} rows={d.rows} centred={!!centre} />
    {check?.error ? <div className="pg-error">{check.error}</div>
      : <div className="pg-hint">{d.cols * d.rows} values{d.cols * d.rows > 300 ? ': many for a small policy to learn from; record plenty, or use fewer cells' : ''}.
          {check?.values ? ' The latest sample of the recordings, as the policy sees it.' : ' Wire shapes in and choose recordings to see it.'}</div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// Each shapes input's colour in a Spatial node's picture, by its place
const SET_COLORS = ['#5aa9e6', '#e6a35a', '#7bd389', '#e66a8a', '#b38be6', '#e6d45a', '#5ae6d4', '#e67a5a'];
// A step for the scale grid: 1, 2 or 5 times a power of ten, about an eighth of the width
const gridStep = (span: number) => {
  const rough = span / 8, power = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
  return [1, 2, 5, 10].map(m => m * power).find(s => s >= rough) ?? rough;
};

// Where a Spatial node's picture is looked at: the shapes' point at the canvas's centre, and canvas px per unit
interface SpatialView { cx: number; cy: number; scale: number; }
const fitView = (bounds: SpatialPictureData['bounds'], width: number, height: number): SpatialView => {
  const [x0, y0, x1, y1] = bounds, w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: Math.min(width / w, height / h) };
};
// A field's relation: which shape it picks, and how it narrows them. Fields with the same one end at the same place
// (the presets' four nearest.* are one line), so it's what a line is labelled with
const relationOf = (f: SpatialField) =>
  (f.pick === 'lowest' || f.pick === 'highest' ? `${f.pick} ${f.by ?? '?'}` : f.pick === 'all' ? (f.value === 'inside' ? 'inside' : 'count') : f.pick)
  + (f.notUnder ? ' not under' : '') + (f.within != null ? ` within ${f.within}` : '') + (f.area ? ' in area' : '') + (f.where ? ` where ${f.where.field} ${f.where.op} ${f.where.value}` : '');
interface SpatialShow { lines: boolean; counted: boolean; props: boolean; }

// A Spatial node's picture on a canvas: the bounds with a scale grid, each input's shapes in its colour (all but
// those hidden), the point, which way it faces and its radii; and, as `show` says, what its fields measure: a line
// to where each picks (dashed to the nearest, dotted to the lowest or highest of a field, solid each way), labelled
// with the relation and its distance; the shapes counted within the radii (brighter within the smallest, faint
// beyond them all); the box the point is inside, outlined; and the shapes' own fields the node reads, beside them.
// `focus`, one field of one input, is drawn alone and bold, the rest faint
function drawSpatial(c: HTMLCanvasElement, picture: SpatialPictureData, aliases: string[], view: SpatialView,
    opts: { hidden?: Set<string>; show?: SpatialShow; focus?: { alias: string; field: string } | null; fields?: SpatialField[]; ratio?: number } = {}) {
  const g = c.getContext('2d')!, ratio = opts.ratio ?? 1, width = c.width / ratio, height = c.height / ratio;
  const show = opts.show ?? { lines: false, counted: false, props: false }, focus = opts.focus ?? null, fields = opts.fields ?? [];
  const focusField = focus ? fields.find(f => f.name === focus.field) : undefined;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const at = (x: number, y: number): [number, number] => [width / 2 + (x - view.cx) * view.scale, height / 2 + (y - view.cy) * view.scale];
  const colorOf = (alias: string) => SET_COLORS[Math.max(0, aliases.indexOf(alias)) % SET_COLORS.length];
  g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, width, height);
  const [bx0, by0] = at(picture.bounds[0], picture.bounds[1]), [bx1, by1] = at(picture.bounds[2], picture.bounds[3]);
  g.fillStyle = '#111'; g.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  // The scale grid, in the shapes' own units, over what's in view
  const left = view.cx - width / 2 / view.scale, top = view.cy - height / 2 / view.scale;
  const step = gridStep(Math.max(width, height) / view.scale);
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
  for (let x = Math.ceil(left / step) * step; x <= left + width / view.scale; x += step) { const [cx] = at(x, 0); g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, height); g.stroke(); }
  for (let y = Math.ceil(top / step) * step; y <= top + height / view.scale; y += step) { const [, cy] = at(0, y); g.beginPath(); g.moveTo(0, cy); g.lineTo(width, cy); g.stroke(); }
  if (!picture.fitted) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.strokeRect(bx0, by0, bx1 - bx0, by1 - by0); }
  const radii = [...picture.radii].sort((a, b) => a - b);
  const path = (points: [number, number][]) => { g.beginPath(); points.forEach((q, i) => { const [px, py] = at(q[0], q[1]); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); };
  // A label beside its end, moved up or down a line at a time until it covers no other (several end at the point)
  const placed: [number, number, number, number][] = [];
  const label = (x: number, y: number, text: string, color: string, size = 11) => {
    g.font = `${size}px system-ui, sans-serif`;
    const w = g.measureText(text).width, h = size + 2, left = x + 6;
    const clear = (top: number) => placed.every(([l, t, r, b]) => left + w < l || left > r || top + h < t || top > b);
    let top = y - 6 - (size - 1);
    for (let k = 1; k < 12 && !clear(top); k++) top = y - 5 - size + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * h;
    placed.push([left, top, left + w, top + h]);
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = color;
    g.strokeText(text, left, top + size - 1); g.fillText(text, left, top + size - 1);
  };
  for (const set of picture.sets) {
    if (opts.hidden?.has(set.alias)) continue;
    const color = colorOf(set.alias), about = set.fields ?? {}, distances = set.distances ?? [], other = !!focus && focus.alias !== set.alias;
    const focused = focus && !other ? about[focus.field] : undefined;
    const picked = focused ? new Set('shapes' in focused ? focused.shapes : [focused.shape]) : null;
    const inside = new Set(fields.filter(f => f.value === 'inside' && fieldApplies(f, set.alias))
      .flatMap(f => { const a = about[f.name]; return a && 'shapes' in a ? a.shapes : []; }));
    set.shapes.forEach((shape, i) => {
      // how much it counts: picked by the field in focus, or within the smallest, any or none of the radii
      let alpha = 1, line = 1.5;
      if (focus && !other) { if (picked?.has(i)) line = 2.5; else alpha = 0.25; }
      else if (show.counted && radii.length) { const d = distances[i] ?? null; if (d === null || d > radii[radii.length - 1]) alpha = 0.35; else if (d <= radii[0]) line = 2.5; }
      if (other) alpha *= 0.3;
      g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = line;
      if (shape.points.length === 1) { const [px, py] = at(...shape.points[0]); g.fillStyle = color; g.fillRect(px - 1.5, py - 1.5, 3, 3); }
      else { path(shape.points); if (shape.closed) { g.fillStyle = color + '40'; g.fill(); } g.stroke(); }
      if (focus ? !other && focusField?.value === 'inside' && picked?.has(i) : inside.has(i)) { // the box the point is in
        g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 2.5; path(shape.points); g.stroke();
      }
      g.globalAlpha = 1;
      if (show.props && shape.props && !other && (!focus || picked?.has(i))) { // its own fields the node reads, such as hp
        const [lx, ly] = at(Math.min(...shape.points.map(q => q[0])), Math.min(...shape.points.map(q => q[1])));
        label(lx - 6, ly + 2, Object.entries(shape.props).map(([k, v]) => `${k} ${px1(v)}`).join(' '), color, 10);
      }
    });
  }
  const [px, py] = at(picture.point[0], picture.point[1]);
  // The areas fields look in: faint, or the field in focus's alone and bold
  for (const [field, area] of Object.entries(picture.areas ?? {})) {
    if (focus && focus.field !== field) continue;
    const [ax0, ay0] = at(area[0], area[1]), [ax1, ay1] = at(area[2], area[3]);
    g.strokeStyle = focus ? '#f0a020' : 'rgba(240,160,32,0.45)'; g.lineWidth = focus ? 2 : 1; g.setLineDash([4, 3]);
    g.strokeRect(ax0, ay0, ax1 - ax0, ay1 - ay0); g.setLineDash([]);
  }
  // The radii, or just the one the field in focus counts within
  const focusR = focusField?.within ?? null;
  g.setLineDash([3, 3]);
  for (const r of focus ? (focusR !== null ? [focusR] : []) : radii) {
    g.strokeStyle = focus ? '#f0a020' : 'rgba(240,160,32,0.5)'; g.lineWidth = focus ? 2 : 1;
    g.beginPath(); g.arc(px, py, r * view.scale, 0, Math.PI * 2); g.stroke();
  }
  g.setLineDash([]);
  // A line to where each field picks, one per relation, each end labelled once with every relation that ends there
  for (const set of picture.sets) {
    if (opts.hidden?.has(set.alias) || (focus && focus.alias !== set.alias)) continue;
    const color = colorOf(set.alias), about = set.fields ?? {};
    const ends = new Map<string, { x: number; y: number; names: string[] }>(), drawn = new Set<string>();
    for (const f of fields) {
      const a = about[f.name], relation = relationOf(f);
      if (!a || !('end' in a) || !fieldApplies(f, set.alias) || (focus ? focus.field !== f.name : !show.lines) || drawn.has(relation)) continue;
      drawn.add(relation);
      const [qx, qy] = at(a.end[0], a.end[1]);
      g.strokeStyle = color; g.lineWidth = focus ? 2.5 : 1.5;
      g.setLineDash(f.pick === 'nearest' ? [5, 4] : f.pick === 'lowest' || f.pick === 'highest' ? [2, 3] : []);
      g.beginPath(); g.moveTo(px, py); g.lineTo(qx, qy); g.stroke(); g.setLineDash([]);
      g.fillStyle = color; g.beginPath(); g.arc(qx, qy, 3, 0, Math.PI * 2); g.fill();
      const key = `${Math.round(qx)},${Math.round(qy)}`, entry = ends.get(key) ?? { x: qx, y: qy, names: [] };
      entry.names.push(`${focus ? f.name : relation} ${px1(a.end[2])}`);
      ends.set(key, entry);
    }
    for (const { x, y, names } of ends.values()) label(x, y, names.join(' · '), color);
  }
  g.fillStyle = '#f0a020'; g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
  if (picture.facingLeft !== null) { // which way it faces
    const dir = picture.facingLeft ? -1 : 1;
    g.strokeStyle = '#f0a020'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, py); g.lineTo(px + dir * 12, py); g.stroke();
    g.beginPath(); g.moveTo(px + dir * 12, py); g.lineTo(px + dir * 8, py - 3); g.moveTo(px + dir * 12, py); g.lineTo(px + dir * 8, py + 3); g.stroke();
  }
}

// The latest sample as the node measures it, small, fitted to its bounds; a click opens the preview
function SpatialPicture({ picture, aliases, onOpen }: { picture: SpatialPictureData; aliases: string[]; onOpen(): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [x0, y0, x1, y1] = picture.bounds, w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  const width = 246, height = Math.round(Math.min(260, Math.max(70, width * h / w)));
  useEffect(() => { if (ref.current) drawSpatial(ref.current, picture, aliases, fitView(picture.bounds, width, height)); }, [picture, aliases, width, height]);
  return <canvas ref={ref} width={width} height={height} className="nodrag pg-grid-picture pg-spatial-picture" aria-label="Spatial picture"
    title="Open the preview" onClick={onOpen} />;
}

// A sample of what FireFly observes, as the runtime's observations event gives it
interface LiveSample { observations: unknown[]; frame?: { w: number; h: number } | null; }
const NO_PICTURE: SpatialPictureData = { bounds: [0, 0, 1, 1], fitted: true, point: [0, 0], facingLeft: null, radii: [], sets: [] };

// A Spatial node, large: live while a capture session runs (what FireFly observes now, measured about five times a
// second), else the latest sample of the recordings. Every input with what's wired into it and how many shapes it
// has (click one to hide it), a line from the point to each input's nearest shape, the point, facing, radii and
// bounds. The wheel zooms where the pointer is, dragging moves it, and the pointer's place reads below
function SpatialPreview({ name, recorded, inputs, fields, capturing, measure, onClose }: {
  name: string; recorded?: SpatialCheck; inputs: { alias: string; from: string[] }[]; fields: SpatialField[]; capturing: boolean;
  measure(sample: LiveSample): Promise<SpatialCheck | null>; onClose(): void;
}) {
  const [live, setLive] = useState<SpatialCheck | null>(null);
  const measured = useRef(measure);
  measured.current = measure;
  useEffect(() => {
    if (!capturing) { setLive(null); return; }
    let latest: LiveSample | null = null, fresh = false, busy = false, alive = true;
    const off = window.bridge.on('runtime:event', (msg: unknown) => {
      const { event, result } = msg as { event: string; result: { observations?: unknown[]; tracked?: unknown[]; frame?: { w: number; h: number } } };
      if (event !== 'observations' || !result) return;
      latest = { observations: [...(result.observations ?? []), ...(result.tracked ?? [])], frame: result.frame ?? null };
      fresh = true;
    });
    // one at a time, the newest each time: the worker may be busy (training)
    const timer = setInterval(() => {
      if (!fresh || busy || !latest) return;
      fresh = false; busy = true;
      measured.current(latest)
        .then(r => { if (alive) setLive(r); })
        .catch(e => { if (alive) setLive({ name, columns: [], values: null, picture: null, error: cleanError(e) }); })
        .finally(() => { busy = false; });
    }, 200);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [capturing, name]);
  const source = live?.picture ? live : recorded?.picture ? recorded : null;
  const picture = source?.picture ?? NO_PICTURE, columns = source?.columns ?? [], values = source?.values ?? null;
  const ref = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null);
  const aliases = useMemo(() => inputs.map(i => i.alias), [inputs]);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<SpatialView | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const drag = useRef<{ x: number; y: number; view: SpatialView } | null>(null);
  const pressedOutside = useRef(false);
  const ratio = window.devicePixelRatio || 1;
  const [show, setShow] = useState<SpatialShow>({ lines: true, counted: true, props: true });
  const [focus, setFocus] = useState<{ alias: string; field: string } | null>(null);
  // Each input's values, as the node gives them: one per field it's for
  const rowsOf = (alias: string) => columns.map((column, i) => ({ column, i })).filter(({ column }) => column.startsWith(`${name}.${alias}.`))
    .map(({ column, i }) => ({ field: column.slice(name.length + alias.length + 2), value: values?.[i] ?? null }));
  // The canvas fills the space beside the legend, and starts fitted to the bounds
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: Math.max(200, Math.floor(el.clientWidth)), height: Math.max(200, Math.floor(el.clientHeight)) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const shown = view ?? fitView(picture.bounds, size.width, size.height);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (source) drawSpatial(c, picture, aliases, shown, { hidden, show, focus, fields, ratio });
    else { const g = c.getContext('2d')!; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, c.width, c.height); }
  });
  // Escape closes it; no other key reaches the graph meanwhile (Delete there would delete its selected node)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const toShapes = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [shown.cx + (e.clientX - r.left - size.width / 2) / shown.scale, shown.cy + (e.clientY - r.top - size.height / 2) / shown.scale];
  };
  const onWheel = (e: React.WheelEvent) => {
    const [x, y] = toShapes(e), factor = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(200, Math.max(1e-4, shown.scale * factor));
    // the place under the pointer stays under it
    setView({ cx: x - (x - shown.cx) * shown.scale / scale, cy: y - (y - shown.cy) * shown.scale / scale, scale });
  };
  const values_ = (alias: string) => {
    const at = (key: string) => { const i = columns.indexOf(`${name}.${alias}.${key}`); return i >= 0 && values ? values[i] : null; };
    const dist = at('nearest.dist'), found = at('nearest.found');
    return found ? `nearest ${px1(dist ?? 0)} px` : 'none within reach';
  };
  const count = (alias: string) => picture.sets.find(s => s.alias === alias)?.shapes.length ?? 0;
  // Closed by a click on the darkened page around it, not by a drag of the view let go of there
  return createPortal(<div className="modal-overlay" onMouseDown={e => { pressedOutside.current = e.target === e.currentTarget; }}
    onClick={e => { if (pressedOutside.current && e.target === e.currentTarget) onClose(); }}>
    <div className="modal-card pg-spatial-preview" role="dialog" aria-label={`Preview of ${name}`} onClick={e => e.stopPropagation()}>
      <div className="modal-header pg-spatial-preview-hd"><span className="modal-title">{name}: {source === live && live
          ? <><span className="pg-live-dot" />live, what FireFly observes now</> : source ? 'the latest sample of the recordings' : 'nothing to draw yet'}</span>
        <span className="pg-spatial-preview-tools">
          <button className="modal-btn" onClick={() => setView(null)}>Fit</button>
          <button className="modal-btn" onClick={() => setView({ ...shown, cx: picture.point[0], cy: picture.point[1] })}>Centre on point</button>
          <button className="modal-btn" onClick={onClose}>Close</button>
        </span></div>
      <div className="pg-spatial-preview-body">
        <div className="pg-spatial-preview-canvas" ref={box}>
          {!source && <div className="pg-spatial-empty">{capturing
            ? live?.error ? `Nothing to draw: ${live.error}` : 'Waiting for what FireFly observes…'
            : 'Start a capture session to see it live, or choose recordings to see their latest sample.'}</div>}
          {source && source !== live && live?.error && <div className="pg-spatial-empty pg-spatial-note">Live: {live.error}. Showing the latest recorded sample.</div>}
          <canvas ref={ref} width={size.width * ratio} height={size.height * ratio} style={{ width: size.width, height: size.height }}
            aria-label="Spatial preview" onWheel={onWheel}
            onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, view: shown }; }}
            onMouseMove={e => {
              setPointer(toShapes(e));
              const d = drag.current;
              if (d) setView({ ...d.view, cx: d.view.cx - (e.clientX - d.x) / d.view.scale, cy: d.view.cy - (e.clientY - d.y) / d.view.scale });
            }}
            onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; setPointer(null); }} />
        </div>
        <div className="pg-spatial-legend" aria-label="Inputs">
          <div className="pg-spatial-show" aria-label="Relations shown">
            <label><input type="checkbox" checked={show.lines} onChange={e => setShow({ ...show, lines: e.target.checked })} />Lines</label>
            <label><input type="checkbox" checked={show.counted} onChange={e => setShow({ ...show, counted: e.target.checked })} />Counted</label>
            <label><input type="checkbox" checked={show.props} onChange={e => setShow({ ...show, props: e.target.checked })} />Shape fields</label>
          </div>
          {inputs.map((input, i) => <div key={input.alias} className="pg-spatial-legend-input">
            <button className={`pg-spatial-legend-row ${hidden.has(input.alias) ? 'pg-dim' : ''}`} title={hidden.has(input.alias) ? 'Show it' : 'Hide it'}
              onClick={() => setHidden(h => { const next = new Set(h); if (next.has(input.alias)) next.delete(input.alias); else next.add(input.alias); return next; })}>
              <span className="pg-swatch" style={{ background: SET_COLORS[i % SET_COLORS.length] }} />
              <span><b>{input.alias}</b><small>{input.from.join(' + ') || 'not wired'}</small>
                <small>{count(input.alias).toLocaleString()} shape{count(input.alias) === 1 ? '' : 's'} · {values_(input.alias)}</small></span>
            </button>
            {!hidden.has(input.alias) && source && <div className="pg-spatial-relations" aria-label={`${input.alias} values`}>
              {rowsOf(input.alias).map(row => <div key={row.field}
                className={focus?.alias === input.alias && focus.field === row.field ? 'pg-on' : ''}
                onMouseEnter={() => setFocus({ alias: input.alias, field: row.field })} onMouseLeave={() => setFocus(null)}>
                <span>{row.field}</span><b>{row.value === null ? '' : px1(row.value)}</b></div>)}
            </div>}
          </div>)}
          <div className="pg-spatial-legend-key">
            <div><span className="pg-key-dot" />Point ({fmt(picture.point[0])}, {fmt(picture.point[1])}){picture.facingLeft !== null ? `, facing ${picture.facingLeft ? 'left' : 'right'}` : ''}</div>
            {picture.radii.length > 0 && <div><span className="pg-key-ring" />Counted within {picture.radii.join(', ')} px: brighter within the smallest, faint beyond them all</div>}
            <div><span className="pg-key-dash" />Dashed to the nearest, dotted to the lowest or highest of a field, solid each way</div>
            {Object.keys(picture.areas ?? {}).length > 0 && <div><span className="pg-key-area" />The areas fields look in: {Object.keys(picture.areas!).join(', ')}</div>}
            <div><span className="pg-key-box" />The box the point is inside</div>
            <div>{picture.fitted ? 'Framed round everything wired in' : `Bounds ${picture.bounds.map(v => fmt(v)).join(', ')}`}</div>
          </div>
          <div className="pg-hint">Point at a value to see where it comes from. Wheel to zoom, drag to move, click an input to hide or show it.</div>
          <div className="pg-spatial-pointer">{pointer ? `(${Math.round(pointer[0])}, ${Math.round(pointer[1])})` : '\u00a0'}</div>
        </div>
      </div>
    </div>
  </div>, document.body);
}

// The words a field is shown in: which shape, and what of it
const PICK_LABELS: Record<SpatialPick, string> = {
  nearest: 'The nearest', left: 'The nearest left', right: 'The nearest right', above: 'The nearest above', below: 'The nearest below',
  ahead: 'The nearest ahead', behind: 'The nearest behind', lowest: 'The lowest of a field', highest: 'The highest of a field',
  under: 'The one under the point (stood on, or landed on)', all: 'All of them',
};
const VALUE_LABELS: Record<SpatialValue, string> = {
  dx: 'dx (right is +)', dy: 'dy (down is +)', forward: 'dx forward (ahead is +)', dist: 'Distance', found: 'Found (1 or 0)',
  prop: 'One of its fields', count: 'How many', inside: 'Whether the point is inside one',
  left_end: 'How far its left end is (left is +)', right_end: 'How far its right end is (right is +)',
  ahead_end: 'How far its end ahead is', behind_end: 'How far its end behind is',
};
const ONE_VALUES: SpatialValue[] = ['dx', 'dy', 'forward', 'dist', 'found', 'prop', 'left_end', 'right_end', 'ahead_end', 'behind_end'];
const NEEDS_FACING: (SpatialPick | SpatialValue)[] = ['ahead', 'behind', 'forward', 'ahead_end', 'behind_end'];
function describeField(f: SpatialField): string {
  const which = f.pick === 'lowest' || f.pick === 'highest' ? `${f.pick} ${f.by ?? '?'}` : f.pick === 'all' ? 'all' : f.pick;
  const gives = f.value === 'prop' ? `its ${f.prop ?? f.by ?? '?'}` : f.value === 'count' ? 'how many' : f.value === 'forward' ? 'dx forward' : f.value === 'dist' ? 'distance'
    : f.value.endsWith('_end') ? `its ${f.value.slice(0, -4)} end` : f.value;
  const area = f.area ? ` in an area (${f.area.ahead} ahead, ${f.area.behind} behind, ${f.area.above} up, ${f.area.below} down)` : '';
  return `${which}${f.notUnder ? ' (not the one under)' : ''}${f.within != null ? ` within ${f.within}` : ''}${area}${f.where ? ` where ${f.where.field} ${f.where.op} ${f.where.value}` : ''} · ${gives}`;
}

// A Spatial node's fields: the presets until one is edited, then its own. Each is listed with what it measures and
// the inputs it's for, can be edited or removed, and new ones added; Reset puts the presets back
function SpatialFieldsEditor({ fields, custom, aliases, facing, props, onChange, onReset }: {
  fields: SpatialField[]; custom: boolean; aliases: string[]; facing: boolean; props: string[];
  onChange(fields: SpatialField[]): void; onReset(): void;
}) {
  const [editing, setEditing] = useState<{ index: number | null; draft: SpatialField } | null>(null);
  const listId = useMemo(() => `pg-sf-props-${Math.random().toString(36).slice(2, 8)}`, []);
  const draft = editing?.draft;
  const set = (patch: Partial<SpatialField>) => setEditing(e => e && { ...e, draft: { ...e.draft, ...patch } });
  const nameTaken = !!draft && fields.some((f, i) => f.name === draft.name.trim() && i !== editing!.index);
  const problem = !draft ? '' : !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(draft.name.trim()) ? 'Name it with letters, digits, _ and dots, such as lowest.hp'
    : nameTaken ? 'Another field has that name'
    : (draft.pick === 'lowest' || draft.pick === 'highest') && !draft.by ? 'Say which field it ranks by, such as hp'
    : draft.value === 'prop' && !(draft.prop || draft.by) ? 'Say which of its fields it gives, such as hp'
    : !facing && (NEEDS_FACING.includes(draft.pick) || NEEDS_FACING.includes(draft.value)) ? 'Ahead, behind and forward need Facing wired in'
    : draft.where && !draft.where.field ? 'Say which field “only where” compares'
    : draft.inputs && !draft.inputs.length ? 'It’s for at least one input'
    : draft.area && (draft.area.ahead + draft.area.behind <= 0 || draft.area.above + draft.area.below <= 0) ? 'The area needs some width and some height' : '';
  const save = () => {
    if (!draft || problem) return;
    const clean: SpatialField = { name: draft.name.trim(), pick: draft.pick, value: draft.value };
    if (draft.pick === 'lowest' || draft.pick === 'highest') clean.by = draft.by;
    if (draft.value === 'prop') { clean.prop = draft.prop || draft.by; if (draft.fill != null) clean.fill = draft.fill; }
    if (draft.within != null) clean.within = draft.within;
    if (draft.where) clean.where = draft.where;
    if (draft.area) clean.area = draft.area;
    if (draft.notUnder && draft.pick !== 'under') clean.notUnder = true;
    if (draft.inputs) clean.inputs = draft.inputs;
    onChange(editing!.index === null ? [...fields, clean] : fields.map((f, i) => i === editing!.index ? clean : f));
    setEditing(null);
  };
  const num = (v: string) => v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
  return <div className="nodrag nowheel pg-sf">
    <div className="pg-sf-hd"><b>Fields</b><small>{custom ? 'its own' : 'the presets'} · a value per input for each</small>
      {custom && <button className="pg-link" title="Put the presets back in place of these" onClick={() => { onReset(); setEditing(null); }}>Reset</button>}</div>
    {fields.map((f, i) => editing?.index === i ? null : <div key={f.name} className="pg-sf-row">
      <span><b>{f.name}</b><small>{describeField(f)}{f.inputs ? ` · for ${f.inputs.join(', ')}` : ''}</small></span>
      <button className="pg-x" title={`Edit ${f.name}`} aria-label={`Edit ${f.name}`} onClick={() => setEditing({ index: i, draft: { ...f } })}>✎</button>
      <button className="pg-x" title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} disabled={fields.length <= 1}
        onClick={() => onChange(fields.filter((_, j) => j !== i))}>✕</button>
    </div>)}
    {draft && <div className="pg-sf-form" aria-label="Field">
      <label>Name<input aria-label="Field name" value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="lowest.hp" /></label>
      <label>Which shape<select aria-label="Which shape" value={draft.pick} onChange={e => {
        const pick = e.target.value as SpatialPick;
        set({ pick, value: pick === 'all' ? (draft.value === 'inside' ? 'inside' : 'count') : ONE_VALUES.includes(draft.value) ? draft.value : 'dist' });
      }}>
        {(Object.keys(PICK_LABELS) as SpatialPick[]).map(p => <option key={p} value={p} disabled={!facing && (p === 'ahead' || p === 'behind')}>{PICK_LABELS[p]}</option>)}
      </select></label>
      {(draft.pick === 'lowest' || draft.pick === 'highest') && <label>Ranked by<input aria-label="Ranked by" list={listId} value={draft.by ?? ''} onChange={e => set({ by: e.target.value.trim() || undefined })} placeholder="hp" /></label>}
      <label>Gives<select aria-label="Gives" value={draft.value} onChange={e => set({ value: e.target.value as SpatialValue })}>
        {(draft.pick === 'all' ? ['count', 'inside'] as SpatialValue[] : ONE_VALUES).map(v => <option key={v} value={v} disabled={!facing && NEEDS_FACING.includes(v)}>{VALUE_LABELS[v]}</option>)}
      </select></label>
      {draft.value === 'prop' && <>
        <label>Its field<input aria-label="Its field" list={listId} value={draft.prop ?? ''} onChange={e => set({ prop: e.target.value.trim() || undefined })} placeholder={draft.by ?? 'hp'} /></label>
        <label title="What it reads when no shape is picked">With none<input aria-label="With none" type="number" value={draft.fill ?? ''} onChange={e => set({ fill: num(e.target.value) })} placeholder="0" /></label>
      </>}
      {draft.pick !== 'under' && <label className="pg-sf-check" title="Leave out the shape under the point, such as the platform you stand on, so the nearest ahead is the next ledge">
        <input type="checkbox" checked={!!draft.notUnder} onChange={e => set({ notUnder: e.target.checked || undefined })} />Not the one under the point</label>}
      <label title="Only shapes this near; blank for the node's reach">Within (px)<input aria-label="Within" type="number" min={1} value={draft.within ?? ''} onChange={e => set({ within: num(e.target.value) })} placeholder="reach" /></label>
      <label className="pg-sf-check" title="Only shapes touching a box round the point, such as your attack's reach: it turns with Facing (without it, ahead is right)">
        <input type="checkbox" checked={!!draft.area} onChange={e => set({ area: e.target.checked ? { ahead: 120, behind: 10, above: 80, below: 10 } : undefined })} />In an area</label>
      {draft.area && <div className="pg-sf-area">
        {(['ahead', 'behind', 'above', 'below'] as const).map(k => <label key={k}>{k === 'ahead' ? (facing ? 'Ahead' : 'Right') : k === 'behind' ? (facing ? 'Behind' : 'Left') : k === 'above' ? 'Up' : 'Down'}
          <input aria-label={`Area ${k}`} type="number" min={0} value={draft.area![k]} onChange={e => set({ area: { ...draft.area!, [k]: Math.max(0, num(e.target.value) ?? 0) } })} /></label>)}
      </div>}
      <label className="pg-sf-check"><input type="checkbox" checked={!!draft.where} onChange={e => set({ where: e.target.checked ? { field: draft.by ?? props[0] ?? '', op: '<', value: 100 } : undefined })} />Only where</label>
      {draft.where && <div className="pg-sf-where">
        <input aria-label="Where field" list={listId} value={draft.where.field} onChange={e => set({ where: { ...draft.where!, field: e.target.value.trim() } })} placeholder="hp" />
        <select aria-label="Where compares" value={draft.where.op} onChange={e => set({ where: { ...draft.where!, op: e.target.value as NonNullable<SpatialField['where']>['op'] } })}>
          {(['<', '<=', '>', '>=', '==', '!='] as const).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <input aria-label="Where value" type="number" value={draft.where.value} onChange={e => set({ where: { ...draft.where!, value: num(e.target.value) ?? 0 } })} />
      </div>}
      <div className="pg-sf-inputs"><span>For</span>
        <label><input type="checkbox" checked={!draft.inputs} onChange={e => set({ inputs: e.target.checked ? undefined : [...aliases] })} />every input</label>
        {draft.inputs && aliases.map(a => <label key={a}><input type="checkbox" checked={draft.inputs!.includes(a)}
          onChange={e => set({ inputs: e.target.checked ? [...draft.inputs!, a] : draft.inputs!.filter(x => x !== a) })} />{a}</label>)}
      </div>
      {problem && <div className="pg-error">{problem}</div>}
      <div className="pg-sf-actions"><button className="modal-btn" disabled={!!problem} onClick={save}>{editing!.index === null ? 'Add' : 'Save'}</button>
        <button className="modal-btn modal-btn-cancel" onClick={() => setEditing(null)}>Cancel</button></div>
    </div>}
    {!draft && <button className="modal-btn pg-sf-add" disabled={fields.length >= 32}
      onClick={() => setEditing({ index: null, draft: { name: '', pick: 'nearest', value: 'dist' } })}>+ Field</button>}
    <datalist id={listId}>{props.map(p => <option key={p} value={p} />)}</datalist>
  </div>;
}

// How shapes lie around a point, as columns for a policy (worker/spatial.py): wire a position into Point, shapes
// into its inputs (each named like a formula's, each taking any number of wires, measured as one set), and the
// node into a Policy's Values. Bounds, also shapes, frame its picture
function SpatialNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as SpatialData, check = g.spatialChecks.get(d.name.trim());
  const point = g.wiredInto(id, SPATIAL_POINT), facing = g.wiredInto(id, SPATIAL_FACING), choices = g.inputChoices(id);
  const bounds = g.wiredInto(id, SPATIAL_BOUNDS);
  const [previewing, setPreviewing] = useState(false);
  const wired = d.inputs.filter(alias => g.wiredInto(id, `in:${alias}`));
  const fields = spatialFields(d, !!facing);
  const columns = check?.columns.length ? check.columns : spatialColumns(d.name, wired, fields);
  // The number fields its shapes carry, such as hp, to rank by, read or compare
  const props = [...new Set((check?.picture?.sets ?? []).flatMap(s => s.props ?? []))].sort();
  // Refreshed by hand: what FireFly sees now while a session runs, kept until the node changes; else the latest
  // recorded sample, asked for again
  const [snapshot, setSnapshot] = useState<{ check: SpatialCheck; at: number; key: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const shapeKey = JSON.stringify([d.inputs, d.reads, fields, d.maxDistance, point, facing, bounds, d.inputs.map(a => g.wiredAll(id, `in:${a}`))]);
  const live = snapshot?.key === shapeKey && g.capturing ? snapshot : null;
  const shown = live?.check.picture ? live.check : check;
  const refresh = async () => {
    const sample = g.capturing ? g.latestLive() : null;
    if (!sample) { setSnapshot(null); g.refreshChecks(); return; }
    setRefreshing(true);
    try {
      const measured = await g.measureSpatial(id, sample);
      if (measured) setSnapshot({ check: measured, at: Date.now(), key: shapeKey });
    } catch (e) {
      setSnapshot({ check: { name: d.name.trim(), columns: [], values: null, picture: null, error: cleanError(e) }, at: Date.now(), key: shapeKey });
    } finally { setRefreshing(false); }
  };
  return <div className={`pg-node pg-spatial ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">⌖</span>
      <PreservedInput className="nodrag pg-name" aria-label="Spatial name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete ${d.name || 'spatial node'}`} aria-label="Delete spatial node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port" title="Where everything is measured from, such as the player's position"><PgHandle type="target" position={Position.Left} id={SPATIAL_POINT} />
      {point ? <>Point: <b>{g.labels[point] ?? point}</b></> : <span className="pg-unwired">Point: wire a position in</span>}</div>
    <div className="pg-port" title="True when facing left: left and right become ahead and behind"><PgHandle type="target" position={Position.Left} id={SPATIAL_FACING} />
      {facing ? <>Facing left: <b>{g.labels[facing] ?? facing}</b></> : 'Facing left (optional): else left and right'}</div>
    <div className="pg-port" title="A box round the area to draw, such as the map's: shapes, or a table such as {left, top, right, bottom} or {x, y, w, h}. It only frames the picture"><PgHandle type="target" position={Position.Left} id={SPATIAL_BOUNDS} />
      {bounds ? <>Bounds: <b>{g.labels[bounds] ?? bounds}</b></> : 'Bounds (optional): else round everything'}</div>
    {d.inputs.map((alias, i) => {
      const from = g.wiredAll(id, `in:${alias}`);
      return <div key={alias} className="pg-input-row">
        <PgHandle type="target" position={Position.Left} id={`in:${alias}`} />
        <span className="pg-swatch" style={{ background: SET_COLORS[i % SET_COLORS.length] }} />
        <AliasInput alias={alias} taken={d.inputs} onRename={next => g.renameInput(id, alias, next)} />
        <span className={`pg-from ${from.length ? '' : 'pg-unwired'}`} title={from.length > 1 ? 'Measured together, as one set' : 'Wire more shapes into it to measure them together'}>
          {from.length ? `← ${from.map(f => g.labels[f] ?? f).join(' + ')}` : 'not wired'}</span>
        <select className="nodrag pg-read" aria-label={`${alias} read as`} value={d.reads?.[alias] ?? 'point'}
          title="How its shapes of x, y, w, h alone (no points) are measured. A script's {x, y, w, h} is a box from its top-left corner; a template match's is a box round its centre"
          onChange={e => g.update(id, { reads: { ...d.reads, [alias]: e.target.value as SpatialRead } })}>
          <option value="point">x, y as a point</option><option value="corner">box from top-left</option>
          <option value="centre">box round centre</option><option value="bottom">bottom centre</option>
        </select>
        <button className="nodrag pg-x" title={`Remove ${alias}`} onClick={() => g.removeInput(id, alias)}>✕</button>
      </div>;
    })}
    <div className="pg-input-row pg-new-input">
      <PgHandle type="target" position={Position.Left} id={NEW_INPUT} extra="pg-handle-new" />
      <span>Drop shapes here, or</span>
      <select className="nodrag" aria-label="Add shapes from" value="" onChange={e => { if (e.target.value) g.addInput(id, e.target.value); }}>
        <option value="">+ shapes from…</option>
        {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </div>
    <SpatialFieldsEditor fields={fields} custom={!!d.fields} aliases={d.inputs} facing={!!facing} props={props}
      onChange={next => g.update(id, { fields: next })} onReset={() => g.update(id, { fields: undefined })} />
    <div className="pg-settings">
      <label className="nodrag" title="The furthest it measures: anything further away, or nothing that way, reads as this">Reach (px)
        <input type="number" min={10} max={100000} value={d.maxDistance}
          onChange={e => g.update(id, { maxDistance: Math.min(100000, Math.max(10, Math.round(Number(e.target.value) || SPATIAL_REACH))) })} /></label>
    </div>
    <div className="pg-spatial-refresh">
      <span className="pg-hint">{live ? `Live, as of ${new Date(live.at).toLocaleTimeString()}` : check?.picture ? 'The latest recorded sample' : ''}</span>
      <button className="nodrag modal-btn" disabled={refreshing || !point || !wired.length}
        title={g.capturing ? 'Measure what FireFly sees now' : 'Read the latest recorded sample again'} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {live?.check.error && <div className="pg-error">{live.check.error}</div>}
    {shown?.picture && <SpatialPicture picture={shown.picture} aliases={d.inputs} onOpen={() => setPreviewing(true)} />}
    <button className="nodrag modal-btn pg-spatial-open" disabled={!point || !wired.length}
      title={!point ? 'Wire a position into Point first' : !wired.length ? 'Wire shapes in first' : g.capturing ? 'See it live, large' : 'See the latest recorded sample, large'}
      onClick={() => setPreviewing(true)}>Preview</button>
    {previewing && <SpatialPreview name={d.name.trim()} recorded={check} fields={fields} capturing={g.capturing} measure={sample => g.measureSpatial(id, sample)}
      inputs={d.inputs.map(alias => ({ alias, from: g.wiredAll(id, `in:${alias}`).map(f => g.labels[f] ?? f) }))} onClose={() => setPreviewing(false)} />}
    {check?.error ? <div className="pg-error">{check.error}</div>
      : <div className="pg-hint">{columns.length} values{live?.check.values ? ', as FireFly sees them now:' : check?.values ? ', in the latest sample of the recordings:' : wired.length ? '. Choose recordings to see them.' : ': wire shapes in.'}</div>}
    {columns.length > 0 && <div className="nowheel pg-spatial-values">
      {columns.map((c, i) => <div key={c}><span>{c.slice(d.name.trim().length + 1)}</span><b>{shown?.values ? fmt(shown.values[i]) : ''}</b></div>)}
    </div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// Where the player is to get to, as columns for a policy (worker/observations.py, Featurizer.goal): the way from
// Position to a target. Training aims each moment at where the player got to a little later (hindsight), so a
// policy learns to get anywhere the recordings went; play aims at what's wired into Target
function GoalNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as GoalData, check = g.goalChecks.get(d.name.trim());
  const position = g.wiredInto(id, GOAL_POSITION), facing = g.wiredInto(id, GOAL_FACING), target = g.wiredInto(id, GOAL_TARGET);
  const columns = check?.columns.length ? check.columns : goalColumns(d.name, !!facing);
  const [low, high] = d.lookAhead;
  const planner = g.nodeInto(id, GOAL_TARGET)?.data.kind === 'planner' ? g.nodeInto(id, GOAL_TARGET)!.data as PlannerData : null;
  const seconds = (i: 0 | 1) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = Math.min(30, Math.max(0.1, Number(e.target.value) || 0.1)), next: [number, number] = [d.lookAhead[0], d.lookAhead[1]];
    next[i] = v;
    if (next[0] > next[1]) next[1 - i] = v;  // the shortest stays first
    g.update(id, { lookAhead: next });
  };
  return <div className={`pg-node pg-goal ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">⚑</span>
      <PreservedInput className="nodrag pg-name" aria-label="Goal name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete ${d.name || 'goal'}`} aria-label="Delete goal node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port" title="Who is to get there, such as the player's position"><PgHandle type="target" position={Position.Left} id={GOAL_POSITION} />
      {position ? <>Position: <b>{g.labels[position] ?? position}</b></> : <span className="pg-unwired">Position: wire the player’s in</span>}</div>
    <div className="pg-port" title="True when facing left: the way to the target is then forward or back, rather than right or left"><PgHandle type="target" position={Position.Left} id={GOAL_FACING} />
      {facing ? <>Facing left: <b>{g.labels[facing] ?? facing}</b></> : 'Facing left (optional): else right and left'}</div>
    <div className="pg-port" title="Where play goes: a Planner (along a recording's route), or a position, such as a formula vec(1200, 300) or a State the recordings hold. Training doesn't use it"><PgHandle type="target" position={Position.Left} id={GOAL_TARGET} />
      {planner ? <>Target: <b>{planner.name || 'planner'}</b>{planner.mode === 'route' ? <small className="pg-dim"> (follows a recording)</small> : null}</>
        : target ? <>Target: <b>{g.labels[target] ?? target}</b></> : <span className="pg-unwired">Target: where play goes, such as a Planner</span>}</div>
    <div className="pg-settings">
      <label className="nodrag" title="Training aims each moment at where the player was this long after it">Look ahead (s)
        <span className="pg-pair"><input aria-label="Look ahead from" type="number" min={0.1} max={30} step={0.5} value={low} onChange={seconds(0)} />–<input aria-label="Look ahead to" type="number" min={0.1} max={30} step={0.5} value={high} onChange={seconds(1)} /></span></label>
      <label className="nodrag" title="How many of those later places each moment aims at, evenly over the look-ahead: each is a row">Targets each moment
        <input type="number" min={1} max={8} value={d.targets} onChange={e => g.update(id, { targets: Math.min(8, Math.max(1, Math.round(Number(e.target.value) || 1))) })} /></label>
      <label className="nodrag" title="A target nearer than this teaches nothing about getting anywhere, and is left out: standing still, fighting">At least (px) away
        <input type="number" min={0} max={10000} value={d.minMove} onChange={e => g.update(id, { minMove: Math.min(10000, Math.max(0, Math.round(Number(e.target.value) || 0))) })} /></label>
    </div>
    <div className="pg-hint">Training aims each moment at where you got to {low === high ? `${low} s` : `${low}–${high} s`} later, so it learns to get anywhere you went; playing, it {planner ? `goes where ${planner.name || 'the planner'} says` : 'goes to the Target'}.
      {d.targets > 1 ? ` Each moment is ${d.targets} rows.` : ''}</div>
    {!target && <div className="pg-warn">Without a Target it trains, but has nowhere to go when it plays.</div>}
    <label className="nodrag pg-check" title="Per button the policy presses, whether the plan's next move uses it (next.<button>) and how far along the way until a move does (soon.<button>, up to 400 px): in training, toward where you got to; playing, toward the destination. So it needn't work out which keys get there from the way alone">
      <input type="checkbox" aria-label="Plan next move as values" checked={!!d.hint} disabled={planner?.mode !== 'plan'}
        onChange={e => g.update(id, { hint: e.target.checked })} />Tell it the plan’s next move</label>
    {d.hint && planner?.mode !== 'plan' && <div className="pg-warn">The plan’s next move needs a Planner planning from what you’ve done in its Target.</div>}
    {d.hint && planner?.mode === 'plan' && <div className="pg-hint">Adds next.&lt;button&gt; and soon.&lt;button&gt; for each button the policy presses.</div>}
    {check?.error ? <div className="pg-error">{check.error}</div> : check?.moved != null
      ? <div className="pg-hint">In the latest sample you went {fmt(check.moved)} px in {high} s{check.moved < d.minMove ? ', under the least, so that moment has no row' : ''}.</div> : null}
    <div className="nowheel pg-spatial-values">
      {columns.map((c, i) => <div key={c}><span>{c.slice(d.name.trim().length + 1)}</span><b>{check?.values ? fmt(check.values[i]) : ''}</b></div>)}
    </div>
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// A Planner's map, from the worker (worker/planner.py, Planner.picture): the places it learned, the moves between
// them, and with a destination the way there from the player, the target, the next move and how long it takes
interface PlanPicture {
  places: [number, number][]; moves: [number, number][]; count: { places: number; moves: number }; recordings: number;
  path?: [number, number][] | null; target?: [number, number] | null; position?: [number, number] | null;
  destination?: [number, number] | null; next?: { keys: string[]; ms: number; seen: number } | null; seconds?: number | null;
  level?: string | null; error?: string | null;
  // Along shapes: the moves learned (along shapes each way, hops), from how many levels, and of the hops made in each
  // recording, how many the moves of the others plan
  library?: { along: number; hops: number; levels: number; coverage: { hops: number; replayed: number } | null;
    scale?: { jump: number | null; hopMs: number | null } | null; snap?: number; tolerance?: number;
    solid?: boolean; through?: { flights: number; up: number };
    // the movement measured from the recordings (px/ms), and as planned with (null: jumps as recorded)
    physics?: { walk: number | null; jump: number | null; gravity: number | null; fall: number | null; slide?: number | null; precision?: number | null;
      jumpKey: string | null; fits: { jumps: number; of: number; falls: number; stops?: number } } | null;
    physicsUsed?: Record<string, number | string | null> | null };
  shapes?: [string, [number, number][]][]; // along shapes: the lines it planned over, the same sample's
  moving?: string[];                         // ticked inputs left out of places, since their shapes move
}
// The shapes under a Planner's map: those it planned over (the same sample as its places), else its Spatial node's
const planShapesOf = (p: PlanPicture, fallback: { points: [number, number][]; color: string }[], aliases: string[]) => p.shapes
  ? p.shapes.map(([alias, points]) => ({ points, color: SET_COLORS[Math.max(0, aliases.indexOf(alias)) % SET_COLORS.length] }))
  : fallback;
const libraryText = (p: PlanPicture) => p.library
  ? `Library: ${p.library.hops} hops and ${p.library.along} ways along shapes, from ${p.library.levels} level${p.library.levels === 1 ? '' : 's'}`
    + (p.library.coverage ? ` · plans ${Math.round(100 * p.library.coverage.replayed / Math.max(1, p.library.coverage.hops))}% of your hops from your other recordings` : '')
    + (p.library.scale?.jump ? ` · your jumps up rise ${Math.round(p.library.scale.jump)} px` : '')
  : '';
const planBounds = (p: PlanPicture): [number, number, number, number] => {
  const pts = [...p.places, ...(p.position ? [p.position] : []), ...(p.destination ? [p.destination] : [])];
  if (!pts.length) return [0, 0, 1, 1];
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), pad = 30;
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
};
// Draws a Planner's map: the level's shapes (from its Spatial node) faint, the moves fainter, the places, the way to
// the destination bold, the player, the target and the destination's flag
function drawPlan(c: HTMLCanvasElement, p: PlanPicture, view: SpatialView, shapes: { points: [number, number][]; color: string }[], ratio = 1) {
  const g = c.getContext('2d')!, width = c.width / ratio, height = c.height / ratio;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  const at = (x: number, y: number): [number, number] => [width / 2 + (x - view.cx) * view.scale, height / 2 + (y - view.cy) * view.scale];
  g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, width, height);
  g.lineWidth = 1.5;
  for (const s of shapes) {
    g.strokeStyle = s.color; g.globalAlpha = 0.35; g.beginPath();
    s.points.forEach(([x, y], i) => { const [u, v] = at(x, y); if (i) g.lineTo(u, v); else g.moveTo(u, v); });
    g.stroke();
  }
  g.globalAlpha = 1; g.strokeStyle = 'rgba(255,255,255,0.13)'; g.lineWidth = 1; g.beginPath();
  for (const [a, b] of p.moves) { const [x0, y0] = at(...p.places[a]), [x1, y1] = at(...p.places[b]); g.moveTo(x0, y0); g.lineTo(x1, y1); }
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.45)';
  for (const q of p.places) { const [x, y] = at(...q); g.fillRect(x - 1, y - 1, 2, 2); }
  if (p.path?.length) {
    g.strokeStyle = '#5aa9e6'; g.lineWidth = 2.5; g.beginPath();
    p.path.forEach((q, i) => { const [x, y] = at(...q); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
  }
  if (p.position) { const [x, y] = at(...p.position); g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); }
  if (p.target) { const [x, y] = at(...p.target); g.strokeStyle = '#f0a020'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); }
  if (p.destination) {
    const [x, y] = at(...p.destination); g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 16); g.lineTo(x + 11, y - 12); g.lineTo(x, y - 8); g.stroke();
  }
}
const nextMove = (p: PlanPicture) => p.next ? `next: ${p.next.keys.length ? p.next.keys.map(buttonLabel).join(' + ') : 'nothing held'} · ${(p.next.ms / 1000).toFixed(1)} s · seen ${p.next.seen}×` : '';

function PlanMap({ picture, shapes, aliases, onPick }: { picture: PlanPicture; shapes: { points: [number, number][]; color: string }[]; aliases: string[]; onPick(x: number, y: number, level: string | null): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bounds = planBounds(picture), w = Math.max(bounds[2] - bounds[0], 1), h = Math.max(bounds[3] - bounds[1], 1);
  const width = 236, height = Math.round(Math.min(220, Math.max(70, width * h / w)));
  const view = fitView(bounds, width, height);
  useEffect(() => { if (ref.current) drawPlan(ref.current, picture, view, planShapesOf(picture, shapes, aliases)); });
  return <canvas ref={ref} width={width} height={height} className="nodrag pg-grid-picture" aria-label="Planner map" style={{ cursor: 'crosshair' }}
    title="Click to put the destination there" onClick={e => {
      const r = e.currentTarget.getBoundingClientRect(), k = width / r.width;  // the canvas is scaled with the graph's zoom
      onPick(Math.round(view.cx + ((e.clientX - r.left) * k - width / 2) / view.scale), Math.round(view.cy + ((e.clientY - r.top) * k - height / 2) / view.scale), picture.level ?? null);
    }} />;
}

// A Planner's map, large: live while a capture session runs (what FireFly observes now, about three times a second),
// else from where its first recording ended. The wheel zooms where the pointer is, dragging moves it, and a click
// (without dragging) puts the destination there
function PlanPreview({ name, recorded, shapes, aliases, capturing, measure, onPick, onClose }: {
  name: string; recorded: PlanPicture | { error: string } | undefined; shapes: { points: [number, number][]; color: string }[]; aliases: string[];
  capturing: boolean; measure(sample: LiveSample): Promise<PlanPicture | { error: string }>; onPick(x: number, y: number, level: string | null): void; onClose(): void;
}) {
  const [live, setLive] = useState<PlanPicture | { error: string } | null>(null);
  const repick = useRef(false); // measure again now (a destination was just clicked), new frame or not
  const measured = useRef(measure);
  measured.current = measure;
  useEffect(() => {
    if (!capturing) { setLive(null); return; }
    let latest: LiveSample | null = null, fresh = false, busy = false, alive = true;
    const off = window.bridge.on('runtime:event', (msg: unknown) => {
      const { event, result } = msg as { event: string; result: { observations?: unknown[]; tracked?: unknown[] } };
      if (event !== 'observations' || !result) return;
      latest = { observations: [...(result.observations ?? []), ...(result.tracked ?? [])] };
      latestSample.current = latest;
      fresh = true;
    });
    const timer = setInterval(() => {
      if (latestSample.current && !latest) latest = latestSample.current;
      if ((!fresh && !repick.current) || busy || !latest) return;
      repick.current = false;
      fresh = false; busy = true;
      measured.current(latest).then(r => { if (alive) setLive(r); }).catch(e => { if (alive) setLive({ error: cleanError(e) }); }).finally(() => { busy = false; });
    }, 300);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [capturing]);
  const latestSample = useRef<LiveSample | null>(null);
  const [picked, setPicked] = useState<[number, number] | null>(null);
  const shownSource = live && 'places' in live ? live : recorded && 'places' in recorded ? recorded : null;
  // What was clicked shows at once, until the worker's next picture (which has it)
  useEffect(() => { setPicked(null); }, [recorded, live]);
  const source = shownSource && picked ? { ...shownSource, destination: picked, path: null, target: null, next: null, seconds: null } : shownSource;
  const ref = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [view, setView] = useState<SpatialView | null>(null);
  const drag = useRef<{ x: number; y: number; view: SpatialView; moved: boolean } | null>(null);
  const ratio = window.devicePixelRatio || 1;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setSize({ width: Math.max(200, Math.floor(el.clientWidth)), height: Math.max(200, Math.floor(el.clientHeight)) });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const shown = view ?? fitView(source ? planBounds(source) : [0, 0, 1, 1], size.width, size.height);
  useEffect(() => { if (ref.current && source) drawPlan(ref.current, source, shown, planShapesOf(source, shapes, aliases), ratio); });
  useEffect(() => {
    const key = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const toMap = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [shown.cx + (e.clientX - r.left - size.width / 2) / shown.scale, shown.cy + (e.clientY - r.top - size.height / 2) / shown.scale];
  };
  const problem = (live && 'error' in live && live.error) || (source?.error ?? null) || (!source && recorded && 'error' in recorded ? recorded.error : null);
  return createPortal(<div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-card pg-spatial-preview" role="dialog" aria-label={`Preview of ${name}`} onClick={e => e.stopPropagation()}>
      <div className="modal-header pg-spatial-preview-hd"><span className="modal-title">{name}: {source === live && live
          ? <><span className="pg-live-dot" />live, from where you are now</> : source ? 'from where its first recording ended' : 'nothing to draw yet'}</span>
        <span className="pg-spatial-preview-tools">
          <button className="modal-btn" onClick={() => setView(null)}>Fit</button>
          <button className="modal-btn" onClick={onClose}>Close</button>
        </span></div>
      <div className="pg-spatial-preview-body">
        <div className="pg-spatial-preview-canvas" ref={box}>
          {!source && <div className="pg-spatial-empty">{problem ?? 'Working out its places and moves…'}</div>}
          <canvas ref={ref} width={size.width * ratio} height={size.height * ratio} style={{ width: size.width, height: size.height, cursor: 'crosshair' }}
            aria-label="Planner preview"
            onWheel={e => {
              const [x, y] = toMap(e), scale = Math.min(200, Math.max(1e-4, shown.scale * Math.exp(-e.deltaY * 0.0015)));
              setView({ cx: x - (x - shown.cx) * shown.scale / scale, cy: y - (y - shown.cy) * shown.scale / scale, scale });
            }}
            onMouseDown={e => { drag.current = { x: e.clientX, y: e.clientY, view: shown, moved: false }; }}
            onMouseMove={e => {
              const d = drag.current;
              if (!d) return;
              if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) d.moved = true;
              if (d.moved) setView({ ...d.view, cx: d.view.cx - (e.clientX - d.x) / d.view.scale, cy: d.view.cy - (e.clientY - d.y) / d.view.scale });
            }}
            onMouseUp={e => {
              const d = drag.current; drag.current = null;
              if (d && !d.moved && source) { const [x, y] = toMap(e); setPicked([Math.round(x), Math.round(y)]); repick.current = true; onPick(Math.round(x), Math.round(y), source.level ?? null); }
            }}
            onMouseLeave={() => { drag.current = null; }} />
        </div>
        <div className="pg-spatial-legend" aria-label="Plan">
          {source && <>
            <div><b>{source.count.places.toLocaleString()}</b> places · <b>{source.count.moves.toLocaleString()}</b> moves {source.library ? 'here' : `from ${source.recordings} recording${source.recordings === 1 ? '' : 's'}`}{source.level != null ? ` · level ${source.level}` : ''}</div>
            {source.library && <div className="pg-hint">{libraryText(source)}</div>}
            {source.path ? <div>The way there: {(source.seconds ?? 0).toFixed(1)} s · {nextMove(source)}</div>
              : <div className="pg-hint">{source.destination ? '' : 'Click the map where play heads.'}</div>}
          </>}
          {problem && <div className="pg-warn">{problem}</div>}
          <div className="pg-hint">● you · <span style={{ color: '#f0a020' }}>○</span> where it aims · <span style={{ color: '#5aa9e6' }}>━</span> the way there · ⚑ destination · dots and faint lines: the places and moves of your recordings. Click to put the destination there; drag to move, wheel to zoom.</div>
        </div>
      </div>
    </div></div>, document.body);
}

// Where play heads, wired into a Goal's Target (graphModel.ts, PlannerData): along where you went in a recording, or
// planned over the places and moves of your recordings, aiming a little ahead each time, so play gets targets like
// the ones it trained on
function PlannerNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as PlannerData;
  const map = g.wiredInto(id, PLANNER_MAP);
  const plan = d.plan ?? planDefaults();
  const level = g.wiredInto(id, PLANNER_LEVEL), destination = g.wiredInto(id, PLANNER_DESTINATION);
  const learnFrom = g.nodeInto(id, PLANNER_DATA);
  const recordedPicture = g.planPictures[id];
  const [previewing, setPreviewing] = useState(false);
  // Refreshed by hand: from where you are now while a session runs, kept until the node changes; else worked out again
  const [snapshot, setSnapshot] = useState<{ picture: PlanPicture; at: number; key: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const planKey = JSON.stringify([d.plan, d.mode, g.wiredInto(id, PLANNER_LEVEL), g.wiredInto(id, PLANNER_DESTINATION), g.nodeInto(id, PLANNER_DATA)?.id]);
  const live = snapshot?.key === planKey && g.capturing ? snapshot : null;
  const picture = recordedPicture;
  const shown = live?.picture ?? recordedPicture;
  // what it learned, with the game's scale and what snap and tolerance left blank came to
  const library = recordedPicture && 'places' in recordedPicture ? recordedPicture.library : undefined;
  const refresh = async () => {
    const sample = g.capturing ? g.latestLive() : null;
    if (!sample) { setSnapshot(null); g.refreshChecks(); return; }
    setRefreshing(true);
    try {
      const measured = await g.measurePlan(id, sample);
      if ('places' in measured) setSnapshot({ picture: measured, at: Date.now(), key: planKey });
    } finally { setRefreshing(false); }
  };
  const setPlan = (patch: Partial<NonNullable<PlannerData['plan']>>) => g.update(id, { plan: { ...plan, ...patch } });
  // The level's shapes, under its map: the Spatial node's latest sample
  const mapNode = g.nodeInto(id, PLANNER_MAP);
  const mapInputs = mapNode?.data.kind === 'spatial' ? (mapNode.data as SpatialData).inputs : [];
  const sets = mapNode?.data.kind === 'spatial' ? g.spatialChecks.get((mapNode.data as SpatialData).name.trim())?.picture?.sets ?? [] : [];
  const shapes = sets.flatMap((s, i) => s.shapes.map(shape => ({ points: shape.points as [number, number][], color: SET_COLORS[i % SET_COLORS.length] })));
  // Recordings whose route play can follow: the player's own, newest first
  const routes = g.recordings.filter(r => r.status === 'complete' && !r.metadata.correction).sort((a, b) => b.metadata.started - a.metadata.started);
  // The Goals it's the Target of, whose look-ahead its aim should be within
  const goals = g.nodesOutOf(id).filter(n => n.data.kind === 'goal').map(n => n.data as GoalData);
  const aim = d.mode === 'plan' ? plan.aheadS : d.route.aheadS;
  const outside = goals.find(goal => aim < goal.lookAhead[0] || aim > goal.lookAhead[1]);
  return <div className={`pg-node pg-planner ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">⤳</span>
      <PreservedInput className="nodrag pg-name" aria-label="Planner name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete ${d.name || 'planner'}`} aria-label="Delete planner node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port" title="A Spatial node: the position and the level's shapes, for planning over them"><PgHandle type="target" position={Position.Left} id={PLANNER_MAP} />
      {map ? <>Map: <b>{map}</b></> : <span className="pg-dim">Map (optional): a Spatial node</span>}</div>
    <div className="pg-settings">
      <label className="nodrag" title="How it works out where play heads">Mode
        <select aria-label="Planner mode" value={d.mode} onChange={e => g.update(id, { mode: e.target.value, ...(e.target.value === 'plan' && !d.plan ? { plan: planDefaults() } : {}) })}>
          <option value="route">Follow a recording</option>
          <option value="plan">Plan from what I've done</option>
        </select></label>
      {d.mode === 'plan' && <>
        <label className="nodrag" title="A grid: places only where you've been. Along shapes: places along the shapes you can be on, moves reused wherever shapes are arranged alike, so it plans beyond where you've been, and on levels you haven't recorded">Places
          <select aria-label="Plan places" value={plan.places ?? 'grid'} onChange={e => setPlan({ places: e.target.value as 'grid' | 'shapes' })}>
            <option value="grid">A grid</option><option value="shapes">Along shapes</option>
          </select></label>
        <label className="nodrag" title={plan.places === 'shapes' ? 'A place every this many px along a shape' : 'The world in cells this size: each a place, at where you were in it; a move is you going from one to the next'}>{plan.places === 'shapes' ? 'Place every (px)' : 'Places (px)'}
          <input aria-label="Place size" type="number" min={8} max={400} value={plan.cell}
            onChange={e => setPlan({ cell: Math.min(400, Math.max(8, Math.round(Number(e.target.value) || PLAN_CELL))) })} /></label>
        {plan.places === 'shapes' && <>
          <label className="nodrag" title={`How near a shape you count as on it. Blank: worked out from your recordings (${PLAN_SNAP} px where jumps rise 45 px, as in MapleStory; more in a game drawn bigger)`}>On a shape within (px)
            <input aria-label="On a shape within" type="number" min={1} max={200} value={plan.snap ?? ''}
              placeholder={`auto${library?.snap ? ` (${Math.round(library.snap)})` : ''}`}
              onChange={e => setPlan({ snap: e.target.value === '' ? undefined : Math.min(200, Math.max(1, Math.round(Number(e.target.value) || PLAN_SNAP))) })} /></label>
          <label className="nodrag" title={`A move you made is reused wherever shapes are arranged alike: landing within this many px of a shape, lower or shorter (never higher or further across than you made it). Blank: worked out from your recordings (${PLAN_TOLERANCE} px at MapleStory's scale)`}>Reuse within (px)
            <input aria-label="Reuse within" type="number" min={1} max={500} value={plan.tolerance ?? ''}
              placeholder={`auto${library?.tolerance ? ` (${Math.round(library.tolerance)})` : ''}`}
              onChange={e => setPlan({ tolerance: e.target.value === '' ? undefined : Math.min(500, Math.max(1, Math.round(Number(e.target.value) || PLAN_TOLERANCE))) })} /></label>
          <label className="nodrag" title="Whether you can jump up through a platform from below. Solid: a move you made is only reused where its arc passes no platform (Mario, Celeste). Auto: solid unless one of your recorded jumps went up through one (it needs 20 jumps or more to say solid). Ropes and ladders never block">From below, platforms are
            <select aria-label="Platforms from below" value={plan.solid == null ? 'auto' : plan.solid ? 'solid' : 'through'}
              onChange={e => setPlan({ solid: e.target.value === 'auto' ? undefined : e.target.value === 'solid' })}>
              <option value="auto">{`Auto${library?.solid != null ? ` (${library.solid ? 'solid' : 'can jump through'})` : ''}`}</option>
              <option value="solid">Solid</option><option value="through">Can jump through</option>
            </select></label>
          {plan.solid == null && library?.through && <div className="pg-hint">{library.through.up
            ? `${library.through.up} of your ${library.through.flights} jumps went up through a platform, so you can jump through them.`
            : `None of your ${library.through.flights} jumps went up through a platform${library.through.flights >= 20 ? ', so they’re taken as solid' : ': too few to say they’re solid'}.`}</div>}
          <MovementSettings movement={plan.movement ?? {}} library={library} onChange={movement => setPlan({ movement })} />
        </>}
        <label className="nodrag" title="Where play heads">Heads for
          <select aria-label="Plan destination" value={plan.destination.kind} onChange={e => setPlan({ destination:
            e.target.value === 'end' ? { kind: 'end', recording: g.recordings.filter(r => r.status === 'complete' && !r.metadata.correction).sort((a, b) => b.metadata.started - a.metadata.started)[0]?.id ?? '' }
              : e.target.value === 'input' ? { kind: 'input' } : { kind: 'point' } })}>
            <option value="point">A point I click on its map</option>
            <option value="input">What's wired into Destination</option>
            <option value="end">Where a recording ended</option>
          </select></label>
        {plan.destination.kind === 'end' && <label className="nodrag">Recording
          <select aria-label="Destination recording" value={plan.destination.recording} onChange={e => setPlan({ destination: { kind: 'end', recording: e.target.value } })}>
            {!plan.destination.recording && <option value="">Choose a recording…</option>}
            {routes.map(r => <option key={r.id} value={r.id}>{r.name} · {Math.round(r.durationMs / 1000)} s</option>)}
          </select></label>}
        <label className="nodrag" title="How far along the way it aims from where you are. Within the Goal's look-ahead, so its targets are like training's">Aim ahead (s)
          <input aria-label="Plan aim ahead" type="number" min={0.1} max={30} step={0.5} value={plan.aheadS}
            onChange={e => setPlan({ aheadS: Math.min(30, Math.max(0.1, Number(e.target.value) || 0.1)) })} /></label>
      </>}
      {d.mode === 'route' && <>
        <label className="nodrag" title="The recording of you doing it, such as a run of the jump quest from start to finish">Route
          <select aria-label="Route recording" value={d.route.recording} onChange={e => g.update(id, { route: { ...d.route, recording: e.target.value } })}>
            {!d.route.recording && <option value="">Choose a recording…</option>}
            {d.route.recording && !routes.some(r => r.id === d.route.recording) && <option value={d.route.recording}>(deleted)</option>}
            {routes.map(r => <option key={r.id} value={r.id}>{r.name} · {Math.round(r.durationMs / 1000)} s</option>)}
          </select></label>
        <label className="nodrag" title="How far along the route it aims from where you are on it. Within the Goal's look-ahead, so its targets are like training's">Aim ahead (s)
          <input aria-label="Aim ahead" type="number" min={0.1} max={30} step={0.5} value={d.route.aheadS}
            onChange={e => g.update(id, { route: { ...d.route, aheadS: Math.min(30, Math.max(0.1, Number(e.target.value) || 0.1)) } })} /></label>
      </>}
    </div>
    {d.mode === 'plan' && <>
      <div className="pg-port" title="A State telling levels or maps apart, such as a map id: each keeps its own places"><PgHandle type="target" position={Position.Left} id={PLANNER_LEVEL} />
        {level ? <>Level: <b>{g.labels[level] ?? level}</b></> : <span className="pg-dim">Level (optional): one space</span>}</div>
      <div className="pg-port" title="A position play heads for, such as a portal's or a monster's: used when it heads for what's wired in"><PgHandle type="target" position={Position.Left} id={PLANNER_DESTINATION} />
        {destination ? <>Destination: <b>{g.labels[destination] ?? destination}</b></> : <span className="pg-dim">Destination{plan.destination.kind === 'input' ? '' : ' (optional)'}</span>}</div>
      <div className="pg-port" title="The recordings it learns places and moves from: else the policy's"><PgHandle type="target" position={Position.Left} id={PLANNER_DATA} extra="pg-handle-data" />
        {learnFrom?.data.kind === 'recordings' ? <>Learns from: <b>{(learnFrom.data as RecordingsData).ids.length} recordings</b></> : <span className="pg-dim">Learns from: the policy's recordings</span>}</div>
      <div className="pg-spatial-refresh">
        <span className="pg-hint">{snapshot ? `Live, as of ${new Date(snapshot.at).toLocaleTimeString()}` : picture && 'places' in picture ? 'From where its first recording ended' : ''}</span>
        <button className="nodrag modal-btn" disabled={refreshing} title={g.capturing ? 'Measure from where you are now' : 'Work its map out again'}
          onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {shown && 'places' in shown && <PlanMap picture={shown} shapes={shapes} aliases={mapInputs} onPick={(x, y, level) => { setSnapshot(null); setPlan({ destination: { kind: 'point', x, y, level } }); }} />}
      {plan.places === 'shapes' && <div className="pg-plan-on" aria-label="Shapes you can be on">
        <span className="pg-hint" title="Shapes that stay put, such as platforms and ropes: not ones that move, such as monsters">{mapInputs.length ? 'You can be on:' : 'Wire a Spatial node into Map for its shapes.'}</span>
        {mapInputs.map(alias => <label key={alias} className="nodrag"><input type="checkbox" checked={(plan.on ?? []).includes(alias)}
          onChange={e => setPlan({ on: e.target.checked ? [...(plan.on ?? []), alias] : (plan.on ?? []).filter(a => a !== alias) })} />{alias}</label>)}
      </div>}
      {mapInputs.length > 0 && <div className="pg-plan-on" aria-label="Shapes to keep away from">
        <span className="pg-hint" title="Moves ending near these shapes, as they are each moment (monsters), take 1.5 s longer, so a way round them is planned when there is one">Keep away from:</span>
        {mapInputs.map(alias => <label key={alias} className="nodrag"><input type="checkbox" checked={(plan.avoid ?? []).includes(alias)}
          onChange={e => setPlan({ avoid: e.target.checked ? [...(plan.avoid ?? []), alias] : (plan.avoid ?? []).filter(a => a !== alias) })} />{alias}</label>)}
      </div>}
      <label className="nodrag pg-check" title="Playing, a planned move that hasn't happened after twice its usual time (and half a second) costs four times as much from then on, so it plans another way if there is one. Forgotten when play stops">
        <input type="checkbox" aria-label="Learn from failure" checked={plan.learn !== false} onChange={e => setPlan({ learn: e.target.checked })} />Try another way when a move fails</label>
      {picture && 'places' in picture && !!picture.moving?.length && <div className="pg-warn">Left out of places, since their shapes move: {picture.moving.join(', ')}. Tick only shapes that stay put.</div>}
      {picture && 'places' in picture && picture.library && <div className="pg-hint">{libraryText(picture)}</div>}
      {picture && 'places' in picture && <div className="pg-hint">Click the map to put the destination there. {picture.count.places.toLocaleString()} places · {picture.count.moves.toLocaleString()} moves from {picture.recordings} recording{picture.recordings === 1 ? '' : 's'}
        {picture.path ? ` · there in ${(picture.seconds ?? 0).toFixed(1)} s` : ''}{picture.next ? ` · ${nextMove(picture)}` : ''}</div>}
      {picture && (('error' in picture && picture.error) || ('places' in picture && picture.error)) && <div className="pg-warn">{picture.error}</div>}
      <button className="nodrag modal-btn pg-spatial-open" disabled={!picture || !('places' in picture)} onClick={() => setPreviewing(true)}
        title="See its places, moves and the way there large, and click where play heads">Preview</button>
      {plan.places === 'shapes' && <div className="pg-drive">
        {g.status.playing && g.status.drive && g.status.driverId === id
          ? <><button className="nodrag modal-btn" onClick={g.stop}>Stop driving</button>
            <span className="pg-hint">{g.status.driving?.text ?? 'starting'} · {g.status.driving?.done ?? 0} done, {g.status.driving?.missed ?? 0} missed</span></>
          : <><button className="nodrag modal-btn" aria-label="Drive" disabled={!g.capturing || !g.windowId || g.recordingNow || g.status.playing || plan.destination.kind === 'point' && plan.destination.x == null}
              title="Move the player to the destination itself: walking with the keys you walked with, and doing each hop as you did, to the millisecond. Your keys or mouse take over"
              onClick={() => g.drive(id)}>Drive</button>
            <span className="pg-hint">The planner moves the player there itself, each hop as you did it.</span></>}
      </div>}
      {previewing && <PlanPreview name={d.name.trim() || 'planner'} recorded={picture} shapes={shapes} aliases={mapInputs} capturing={g.capturing}
        measure={sample => g.measurePlan(id, sample)} onClose={() => setPreviewing(false)}
        onPick={(x, y, level) => setPlan({ destination: { kind: 'point', x, y, level } })} />}
    </>}
    <div className="pg-hint">{d.mode === 'route'
      ? `Play aims ${d.route.aheadS} s ahead along where you went in the recording, from where you are on it; off it, it rejoins it on your own level.`
      : `Play aims ${plan.aheadS} s along the quickest moves you've made toward ${plan.destination.kind === 'point' ? (plan.destination.x != null ? `(${plan.destination.x}, ${plan.destination.y})` : 'where you click on its map') : plan.destination.kind === 'end' ? 'where the recording ended' : 'what’s wired into Destination'}. It knows only moves your recordings made.`}</div>
    {!goals.length && <div className="pg-warn">Wire it into a Goal's Target.</div>}
    {d.mode === 'route' && !d.route.recording && <div className="pg-warn">Choose the recording whose route play follows.</div>}
    {outside && <div className="pg-warn">Aim ahead within the Goal's look-ahead ({outside.lookAhead[0]}–{outside.lookAhead[1]} s), so its targets are like the ones it trained on.</div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// How the player moves, which jumps are planned from: measured from the recordings, each value overwritten by typing it
// (blank: the measured one), or jumps only as recorded
function MovementSettings({ movement, library, onChange }: { movement: Movement; library?: PlanPicture['library']; onChange(m: Movement): void }) {
  const measured = library?.physics, used = library?.physicsUsed;
  const fits = measured?.fits;
  const usable = !!used;
  return <div className="pg-movement" aria-label="Movement">
    <label className="nodrag" title="Physics: jumps are worked out from how the player moves, from every place, so it finds jumps you never made and none you couldn't. Recorded: only jumps alike to ones you made">Jumps from
      <select aria-label="Jumps from" value={movement.physics === false ? 'recorded' : 'physics'}
        onChange={e => onChange({ ...movement, physics: e.target.value === 'recorded' ? false : undefined })}>
        <option value="physics">Physics</option><option value="recorded">Jumps I recorded</option>
      </select></label>
    {movement.physics !== false && <>
      {MOVEMENT_FIELDS.map(f => {
        const m = measured?.[f.key];
        return <label key={f.key} className="nodrag" title={`${f.title}. Blank: measured from your recordings`}>{f.label} ({f.unit})
          <input aria-label={f.label} type="number" min={0} value={movement[f.key] ?? ''}
            placeholder={m != null ? `measured: ${Math.round(m * f.scale)}` : 'not measured'}
            onChange={e => onChange({ ...movement, [f.key]: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0) || undefined })} /></label>;
      })}
      {fits && <div className="pg-hint">{`Measured from ${fits.jumps} of your ${fits.of} jumps${measured?.jumpKey ? ` (jump key: ${buttonLabel(measured.jumpKey)})` : ''}`
        + (fits.falls ? `, and ${fits.falls} long fall${fits.falls === 1 ? '' : 's'}` : ', no long falls: falling has no top speed')
        + (fits.stops ? `; slides from ${fits.stops} stops` : '; no stops to measure sliding from')}.</div>}
      {library && !usable && <div className="pg-warn">Too few clean jumps to measure the movement: set walk speed, jump speed and gravity, or it plans jumps as recorded.</div>}
    </>}
  </div>;
}

function RecordingsNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as RecordingsData;
  const first = g.recordings.find(r => r.id === d.ids[0]);
  const compatible = (r: Recording) => !first || (r.metadata.observationSchema?.identity === first.metadata.observationSchema?.identity
    && r.metadata.actionSchema?.identity === first.metadata.actionSchema?.identity);
  const toggle = (rid: string, on: boolean) => g.update(id, { ids: on ? [...d.ids, rid] : d.ids.filter(x => x !== rid) });
  return <div className={`pg-node pg-recordings ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">▤</span>Recordings<span className="pg-type">{d.ids.length} chosen</span><button className="nodrag pg-x pg-node-delete" title="Delete recordings node" aria-label="Delete recordings node" onClick={() => g.removeNode(id)}>✕</button></div>
    <div className="nowheel pg-list">
      {!g.recordings.some(r => !r.metadata.correction) && <div className="pg-hint">No complete recordings yet</div>}
      {g.recordings.filter(r => !r.metadata.correction).map(r => {
        const on = d.ids.includes(r.id), ok = compatible(r), empty = r.samples > 0 && r.invalidSamples >= r.samples;
        return <label key={r.id} className={`nodrag pg-rec ${!ok ? 'pg-dim' : ''}`}
          title={!ok ? 'Recorded different observations or buttons than the first one chosen' : empty ? 'No valid samples' : ''}>
          <input type="checkbox" checked={on} disabled={!on && !ok} onChange={e => toggle(r.id, e.target.checked)} />
          <span>{r.metadata.correction ? '✋ ' : ''}{r.name}<small>{r.samples.toLocaleString()} samples · {(r.durationMs / 1000).toFixed(0)} s</small></span>
        </label>;
      })}
    </div>
    <PgHandle type="source" position={Position.Right} id="data" extra="pg-handle-data" />
  </div>;
}

function PolicyNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as PolicyData, compiled = g.compiled[id], preview = g.previews[id];
  const recorded = g.recordings.find(r => compiled?.request?.recordingIds.includes(r.id) || false)?.metadata.actionSchema?.buttons
    ?? g.recordings.find(r => r.metadata.actionSchema?.buttons)?.metadata.actionSchema?.buttons ?? [];
  const chosen = d.buttons ?? recorded.map(b => b.id);
  const off = new Set(d.off);
  const versions = g.versions.filter(v => v.policy?.id === id);
  const [allVersions, setAllVersions] = useState(false);
  // Corrections of its versions, deleted ones too: they're still this policy's
  const corrections = correctionsOf(versions, g.recordings);
  const training = g.training?.nodeId === id;
  const setColumn = (cols: string[], on: boolean) => {
    const next = new Set(d.off);
    for (const c of cols) { if (on) next.delete(c); else next.add(c); }
    g.update(id, { off: [...next] });
  };
  const num = (key: 'history' | 'delayMs' | 'epochs', min: number, max: number) => (e: ChangeEvent<HTMLInputElement>) =>
    g.update(id, { [key]: Math.min(max, Math.max(min, Number(e.target.value) || 0)) });
  return <div className={`pg-node pg-policy ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">◎</span>
      <PreservedInput className="nodrag pg-name" aria-label="Policy name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete policy ${d.name || ''}`} aria-label="Delete policy node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="values" />Values: states and formulas</div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="data" extra="pg-handle-data" />Data: a Recordings node</div>
    <div className="pg-section nowheel">
      <div className="pg-section-hd">Values <small>the dataset's columns</small></div>
      {!compiled?.values.length && <div className="pg-hint">Wire states or formulas in</div>}
      {compiled?.values.map(v => <div key={v.nodeId} className="pg-value">
        <label className="nodrag"><input type="checkbox" checked={v.columns.length > 0 && v.columns.some(c => !off.has(c))}
          onChange={e => setColumn(v.columns, e.target.checked)} /><b title={g.labels[v.name] && g.labels[v.name] !== v.name ? `Recorded as ${v.name}` : undefined}>{g.labels[v.name] ?? v.name}</b><small>{v.type === 'grid' ? `grid · ${v.columns.length} cells` : v.type === 'spatial' ? `spatial · ${v.columns.length} values` : v.type === 'goal' ? 'goal' : v.type ?? ''}</small></label>
        {v.columns.length > 1 && v.type !== 'grid' && v.columns.map(c => <label key={c} className="nodrag pg-column">
          <input type="checkbox" checked={!off.has(c)} onChange={e => setColumn([c], e.target.checked)} />{c.slice(v.name.length + 1)}
        </label>)}
      </div>)}
      <div className="pg-section-hd">Labels <small>the buttons it learns and presses, of those its recordings recorded (chosen in the Recordings tab)</small></div>
      <div className="pg-buttons">
        {recorded.map(b => <label key={b.id} className="nodrag"><input type="checkbox" checked={chosen.includes(b.id)}
          onChange={e => { const next = e.target.checked ? [...chosen, b.id] : chosen.filter(x => x !== b.id);
            g.update(id, { buttons: next.length === recorded.length ? null : next }); }} />{buttonLabel(b.id)}</label>)}
        {!recorded.length && <div className="pg-hint">Choose recordings to see their buttons</div>}
      </div>
      <div className="pg-settings">
        <label className="nodrag">Time step (ms)<input type="number" min={10} max={1000} value={d.stepMs ?? ''}
          placeholder={preview && typeof preview === 'object' && 'stepMs' in preview ? fmt(preview.stepMs) : 'auto'}
          onChange={e => g.update(id, { stepMs: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label className="nodrag">Earlier steps<input type="number" min={0} max={4} value={d.history} onChange={num('history', 0, 4)} /></label>
        <label className="nodrag">Buttons from (ms later)<input type="number" min={0} max={1000} step={50} value={d.delayMs} onChange={num('delayMs', 0, 1000)} /></label>
        <label className="nodrag">Epochs<input type="number" min={1} max={200} value={d.epochs} onChange={num('epochs', 1, 200)} /></label>
      </div>
      <div className="pg-section-hd">Dataset</div>
      {g.sharedWith[id] && <div className="pg-shared">
        <div className="pg-warn">This is the same policy as the Policy node in {g.sharedWith[id].map(n => `“${n}”`).join(', ')} (one graph was pasted from the other), so both train versions of one policy and the Play tab shows them together.</div>
        <button className="nodrag modal-btn" title="Give this node a policy of its own. The versions trained so far stay with the other graph" onClick={() => g.separate(id)}>Make it its own policy</button>
      </div>}
      {compiled?.problems.map(p => <div key={p} className="pg-warn">{p}</div>)}
      {!compiled?.problems.length && (preview === 'loading' || !preview ? <div className="pg-hint">Working out the dataset…</div>
        : 'error' in preview ? <div className="pg-error">{preview.error}</div>
        : <div className="pg-dataset">
            <div><b>{preview.samples.toLocaleString()}</b> rows × <b>{preview.values.length}</b> values
              {d.history ? ` (${preview.inputs} inputs with ${d.history} earlier step${d.history > 1 ? 's' : ''})` : ''} · {fmt(preview.stepMs)} ms apart</div>
            <div className="pg-hint">{preview.buttons.map(b => `${buttonLabel(b.id)} ${percent(b.pressed)}`).join(' · ')} pressed</div>
            {skipText(preview.skippedReasons) && <div className="pg-missing">{skipText(preview.skippedReasons)}</div>}
            {/* A button no row presses is one the policy learns never to press: say so before training */}
            {(() => { const never = preview.buttons.filter(b => b.pressed === 0).map(b => buttonLabel(b.id));
              return never.length > 0 && <div className="pg-warn">Never pressed in these rows: {never.join(', ')}. The policy will never press {never.length > 1 ? 'them' : 'it'}: record {never.length > 1 ? 'them' : 'it'} being used (the buttons are chosen in the Recordings tab), or untick {never.length > 1 ? 'them' : 'it'} under Labels.</div>; })()}
            {preview.samples > 0 && preview.samples < 500 && <div className="pg-warn">Only {preview.samples} rows ({(preview.samples * preview.stepMs / 1000).toFixed(0)} s of play): a policy learns little from so few. Record more, several minutes of the behaviour.</div>}
          </div>)}
      <div className="pg-actions">
        <button className="nodrag modal-btn pg-train" disabled={!compiled?.request || !!g.training || g.recordingNow} onClick={() => g.train(id)}>
          {training ? `Training… ${g.training?.progress ? `${g.training.progress.epoch}/${d.epochs}` : ''}` : versions.length ? 'Train a new version' : 'Train'}</button>
        <button className="nodrag modal-btn pg-export" disabled={!compiled?.request || !!g.training} onClick={() => g.exportDataset(id)}>Export dataset…</button>
      </div>
      {g.exported?.nodeId === id && <div className="pg-hint">{g.exported.text}{g.exported.path &&
        <> <a href="#" className="nodrag" onClick={e => { e.preventDefault(); void window.bridge.policy.reveal(g.exported!.path!); }}>Show in folder</a></>}</div>}
      {versions.length > 0 && <>
        <div className="pg-section-hd pg-versions-hd">Versions
          {(() => {
            const playingOne = g.status.playing && versions.some(v => v.id === g.status.modelId);
            return <button className="nodrag pg-link pg-delete-all" disabled={playingOne || training}
              title={playingOne ? 'Stop the version playing first' : training ? 'Wait for training to finish' : `Delete all ${versions.length} versions${corrections.length ? `, and their ${corrections.length} corrections` : ''}`}
              onClick={() => g.deleteAll(versions, d.name || 'this policy', corrections.length)}>Delete all</button>;
          })()}
        </div>
        {(allVersions ? versions : versions.slice(0, 5)).map((v, i) => {
          const playing = g.status.playing && g.status.modelId === v.id;
          const f1 = meanF1(v);
          const fixes = corrections.filter(r => r.metadata.policyId === v.id).length; // recorded while it played
          return <div key={v.id} className="pg-version">
            <span><b>v{versions.length - i}</b> {new Date(v.created * 1000).toLocaleString()}
              <small>{(v.trainingSamples + v.validationSamples).toLocaleString()} rows{f1 !== null ? ` · F1 ${percent(f1)}` : ''}{fixes ? ` · ${fixes} correction${fixes > 1 ? 's' : ''}` : ''}</small></span>
            <span className="pg-version-actions">
              {v.version !== POLICY_VERSION ? <small className="pg-hint">older FireFly</small>
                : playing ? <button className="nodrag modal-btn pg-stop" onClick={g.stop}>Stop</button>
                : <button className="nodrag modal-btn pg-play" disabled={!g.capturing || !g.windowId || g.recordingNow || g.status.playing}
                    title={!g.capturing ? 'Start a capture session first' : g.recordingNow ? 'Stop recording first' : ''} onClick={() => g.play(v.id)}>Play</button>}
              <button className="nodrag pg-delete" disabled={playing} title={playing ? 'Stop it first' : `Delete v${versions.length - i}`}
                aria-label={`Delete v${versions.length - i}`} onClick={() => g.deleteVersion(v, versions.length - i, fixes)}>✕</button>
            </span>
          </div>;
        })}
        {versions.length > 5 && <button className="nodrag pg-link" onClick={() => setAllVersions(!allVersions)}>
          {allVersions ? 'Show the newest 5' : `Show all ${versions.length} versions`}</button>}
        <label className="nodrag pg-option"><input type="checkbox" checked={g.corrections} onChange={e => g.setCorrections(e.target.checked)} /> Record my corrections while it plays</label>
        <div className="pg-hint">{corrections.length ? `${corrections.length} correction${corrections.length === 1 ? '' : 's'} recorded` : 'No corrections yet'}
          {corrections.length > 0 && <button className="nodrag modal-btn pg-inline" disabled={!compiled?.request || !!g.training || g.recordingNow}
            onClick={() => g.train(id, true)}>Train with corrections</button>}</div>
        {corrections.length > 0 && (() => {
          const share = d.correctionShare ?? DEFAULT_CORRECTION_SHARE;
          return <label className="nodrag pg-share" title={correctionShareHint}>They count
            <input type="range" aria-label="How much the corrections count" min={0} max={MAX_CORRECTION_SHARE} step={.05} value={share}
              disabled={!!g.training} onChange={e => g.update(id, { correctionShare: Number(e.target.value) })} />
            <b>{share === 0 ? 'as plain rows' : `${percent(share)} of training`}</b>
          </label>;
        })()}
      </>}
    </div>
  </div>;
}

const nodeTypes: NodeTypes = { state: StateNode, formula: FormulaNode, recordings: RecordingsNode, policy: PolicyNode, grid: GridNode, spatial: SpatialNode, goal: GoalNode, planner: PlannerNode };

// ── The editor ───────────────────────────────────────────────────────────────────────────────────────

// stateLabels: each observation's States, by name. A State that reads a region's value or a model output
// is recorded under that output's name (“hp %” as “bar level”), so it's shown by the State's name.
// observed: every State's observation and its type (and whatever else FireFly observes now), which the
// graph is built from; States are dragged in from the app's States list.
export interface PolicyGraphProps { active: boolean; online: boolean; capturing: boolean; windowId: string | null; recording: boolean; storageKey: string; stateLabels: Record<string, string>; graphId?: string;
  observed: Record<string, string>;
  frameSize?: { w: number; h: number } | null; } // the captured window's size, for a new grid's screen

export default function PolicyGraph(props: PolicyGraphProps) {
  return <div className={`pg ${props.active ? '' : 'pg-off'}`}>
    {props.active && <ReactFlowProvider><Editor key={props.storageKey} {...props} /></ReactFlowProvider>}
  </div>;
}

function Editor({ online, capturing, windowId, recording, storageKey, stateLabels, observed, frameSize, graphId }: PolicyGraphProps) {
  const initial = useMemo(() => readGraph(localStorage.getItem(storageKey)), [storageKey]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const flow = useReactFlow();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [checks, setChecks] = useState<Map<string, FormulaCheck>>(new Map());
  const [gridChecks, setGridChecks] = useState<Map<string, GridCheck>>(new Map());
  const [spatialChecks, setSpatialChecks] = useState<Map<string, SpatialCheck>>(new Map());
  const [goalChecks, setGoalChecks] = useState<Map<string, GoalCheck>>(new Map());
  const [previews, setPreviews] = useState<Ctx['previews']>({});
  const [status, setStatus] = useState<PlayStatus>({ playing: false });
  const [training, setTraining] = useState<Ctx['training']>(null);
  const [corrections, setCorrections] = useState(true);
  const [exported, setExported] = useState<Ctx['exported']>(null);
  const [error, setError] = useState('');
  const doc: GraphDoc = useMemo(() => ({ version: 1, nodes, edges }), [nodes, edges]);

  // Kept per captured window, a moment after the last change
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges })); }
    catch { setError('Could not save graph: local storage is full'); }
  }, [nodes, edges, storageKey]);

  // The recordings as they are now: deleted in the Recordings tab while this is open, one has to go from
  // the Recordings nodes too (below), so the list is read again every few seconds
  const [recordingsRead, setRecordingsRead] = useState(false);
  const refresh = useCallback(async () => {
    try {
      if (online) {
        setRecordings(((await window.bridge.invoke('dataset.list')) as { recordings: Recording[] }).recordings.filter(r => r.status === 'complete'));
        setRecordingsRead(true);
      }
      setVersions(newestFirst(await window.bridge.policy.invoke('models') as PolicyVersion[]));
    } catch (e) { setError(cleanError(e)); }
  }, [online]);
  // A version and the corrections recorded while it played go together
  const deleteVersion = useCallback(async (v: PolicyVersion, n: number, count: number) => {
    if (!window.confirm(`Delete v${n} (${new Date(v.created * 1000).toLocaleString()})? It can't be played again${count ? `, and its ${count} correction${count > 1 ? 's are' : ' is'} deleted with it` : ''}.`)) return;
    try { await deleteVersions([v]); await refresh(); }
    catch (e) { setError(cleanError(e)); }
  }, [refresh]);
  // Every version of a policy at once, with all of their corrections
  const deleteAll = useCallback(async (vs: PolicyVersion[], name: string, count: number) => {
    if (!window.confirm(`Delete all ${vs.length} version${vs.length > 1 ? 's' : ''} of ${name}? ${vs.length > 1 ? 'They' : 'It'} can't be played again${count ? `, and the ${count} correction${count > 1 ? 's' : ''} recorded while they played ${count > 1 ? 'are' : 'is'} deleted with them` : ''}. Its graph and recordings are kept.`)) return;
    try { await deleteVersions(vs); await refresh(); }
    catch (e) { setError(cleanError(e)); await refresh(); }
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Read again every few seconds: recordings come and go in the Recordings tab, and versions are trained and
  // deleted in the Play tab too (an editor stays mounted while hidden, so it wouldn't otherwise see them)
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        if (online) setRecordings(((await window.bridge.invoke('dataset.list')) as { recordings: Recording[] }).recordings.filter(r => r.status === 'complete'));
        const latest = newestFirst(await window.bridge.policy.invoke('models') as PolicyVersion[]);
        setVersions(prev => prev.length === latest.length && prev.every((v, i) => v.id === latest[i].id) ? prev : latest);
      } catch { /* the next try, or Refresh, reads it */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [online]);
  // A recording that's gone (deleted) is no longer chosen, once the list has been read from the runtime
  useEffect(() => {
    if (!recordingsRead) return;
    // (corrections too: they belong to their versions, and come with Train with corrections)
    const known = new Set(recordings.filter(r => !r.metadata.correction).map(r => r.id));
    setNodes(ns => {
      let changed = false;
      const next = ns.map(n => {
        if (n.data.kind !== 'recordings' || n.data.ids.every(id => known.has(id))) return n;
        changed = true;
        return { ...n, data: { ...n.data, ids: n.data.ids.filter(id => known.has(id)) } };
      });
      return changed ? next : ns;
    });
  }, [recordings, recordingsRead, setNodes]);
  useEffect(() => {
    const offs = [
      window.bridge.on('policy:event', (msg: unknown) => {
        const { event, result } = msg as { event: string; result: Epoch };
        if (event === 'training') setTraining(t => t ? { ...t, progress: result } : t);
      }),
      window.bridge.on('play:status', (s: unknown) => setStatus(s as PlayStatus)),
    ];
    return () => offs.forEach(off => off());
  }, []);

  // The observations a policy can use: those the chosen recordings hold (else the latest recording's)
  const schemaRecording = useMemo(() => {
    const chosen = nodes.flatMap(n => n.data.kind === 'recordings' ? n.data.ids : []);
    return recordings.find(r => r.id === chosen[0]) ?? recordings[0];
  }, [nodes, recordings]);
  // Every observation's type: what FireFly observes now (the States), else what a recording holds. A
  // policy is built from States, whether or not anything has recorded them yet; what each recording
  // holds is what a policy's recordings are checked against (compilePolicy)
  const fields = useMemo(() => new Map([...Object.entries(observed),
    ...(schemaRecording?.metadata.observationSchema?.fields ?? []).filter(f => !(f.name in observed)).map(f => [f.name, f.type] as [string, string])]),
    [observed, schemaRecording]);
  const holds = useMemo(() => new Map(recordings.map(r => [r.id, new Set((r.metadata.observationSchema?.fields ?? []).map(f => f.name))])), [recordings]);
  const recordedAnywhere = useMemo(() => new Set([...holds.values()].flatMap(s => [...s])), [holds]);

  // The worker checks every formula (a moment after the last change), with a preview over the recording
  const specs = useMemo(() => formulaSpecs(doc), [doc]);
  const grids = useMemo(() => gridSpecs(doc), [doc]);
  const spatial = useMemo(() => spatialSpecs(doc), [doc]);
  const goals = useMemo(() => goalSpecs(doc), [doc]);
  const fieldList = useMemo(() => [...fields].map(([name, type]) => ({ name, type })), [fields]);
  const [refreshed, setRefreshed] = useState(0);
  const specKey = JSON.stringify([specs, grids, spatial, goals, schemaRecording?.id, fieldList, refreshed]);
  const latestLive = useRef<LiveSample | null>(null);
  useEffect(() => {
    latestLive.current = null;
    if (!capturing) return;
    return window.bridge.on('runtime:event', (msg: unknown) => {
      const { event, result } = msg as { event: string; result: { observations?: unknown[]; tracked?: unknown[]; frame?: { w: number; h: number } } };
      if (event === 'observations' && result) latestLive.current = { observations: [...(result.observations ?? []), ...(result.tracked ?? [])], frame: result.frame ?? null };
    });
  }, [capturing]);
  useEffect(() => {
    if ((!schemaRecording && !fieldList.length) || (!specs.length && !grids.length && !spatial.length && !goals.length)) {
      setChecks(new Map()); setGridChecks(new Map()); setSpatialChecks(new Map()); setGoalChecks(new Map()); return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      window.bridge.policy.invoke('columns', { recordingIds: schemaRecording ? [schemaRecording.id] : [], fields: fieldList, formulas: specs, grids, spatial, goals })
        .then((r: unknown) => {
          if (!alive) return;
          const res = r as { formulas: FormulaCheck[]; grids?: GridCheck[]; spatial?: SpatialCheck[]; goals?: GoalCheck[] };
          setChecks(new Map(res.formulas.map(f => [f.name, f])));
          setGridChecks(new Map((res.grids ?? []).map(g => [g.name, g])));
          setSpatialChecks(new Map((res.spatial ?? []).map(g => [g.name, g])));
          setGoalChecks(new Map((res.goals ?? []).map(g => [g.name, g])));
        })
        .catch(e => { if (alive) setError(cleanError(e)); });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [specKey]);

  // A planning Planner's request to the worker's planner.preview: the Goal it's the Target of (its position), its
  // plan, and the recordings it learns from (its own, else the policy's that Goal feeds)
  const planRequest = useCallback((plannerId: string): { request: Record<string, unknown> } | { error: string } => {
    const planner = nodes.find(n => n.id === plannerId);
    if (planner?.data.kind !== 'planner') return { error: 'Not a planner' };
    const into = (id: string, handle: string) => edges.filter(e => e.target === id && e.targetHandle === handle).map(e => nodes.find(n => n.id === e.source));
    const goal = edges.filter(e => e.source === plannerId && e.targetHandle === GOAL_TARGET).map(e => nodes.find(n => n.id === e.target)).find(n => n?.data.kind === 'goal');
    if (!goal || goal.data.kind !== 'goal') return { error: "Wire it into a Goal's Target to see its map" };
    const position = nameOf(into(goal.id, GOAL_POSITION)[0]), facing = nameOf(into(goal.id, GOAL_FACING)[0]);
    if (!position) return { error: "Wire a position, such as the player's, into the Goal's Position" };
    const own = into(plannerId, PLANNER_DATA)[0];
    const policies = edges.filter(e => e.source === goal.id && e.targetHandle === 'values').map(e => e.target);
    const policyData = policies.flatMap(p => into(p, 'data')).find(n => n?.data.kind === 'recordings');
    const ids = own?.data.kind === 'recordings' ? own.data.ids : policyData?.data.kind === 'recordings' ? policyData.data.ids : [];
    if (!ids.length) return { error: own ? 'Choose the recordings it learns from' : "Choose the policy's recordings, or wire Recordings into Learns from" };
    const p = planner.data.plan ?? planDefaults(), dest = p.destination, level = nameOf(into(plannerId, PLANNER_LEVEL)[0]);
    const wired = nameOf(into(plannerId, PLANNER_DESTINATION)[0]);
    const destination = dest.kind === 'point' ? (dest.x != null ? { kind: 'point', x: dest.x, y: dest.y, ...(dest.level != null ? { level: dest.level } : {}) } : undefined)
      : dest.kind === 'input' ? (wired ? { kind: 'input', name: wired } : undefined) : dest.recording ? dest : undefined;
    const d = goal.data;
    const shapes = p.places === 'shapes' ? planShapes({ version: 1, nodes, edges }, planner as GraphNode & { data: PlannerData }) : null;
    if (p.places === 'shapes' && !shapes) return { error: 'Wire a Spatial node into its Map, for the shapes its places are along' };
    if (p.places === 'shapes' && !shapes!.length) return { error: 'Tick the shapes you can be on, such as platforms and ropes' };
    const avoid = planShapes({ version: 1, nodes, edges }, planner as GraphNode & { data: PlannerData }, p.avoid ?? []);
    return { request: { goal: { name: d.name.trim() || 'goal', position, ...(facing ? { facing } : {}), lookAhead: d.lookAhead, targets: d.targets, minMove: d.minMove,
      plan: { cell: p.cell, aheadS: p.aheadS, ...(level ? { level } : {}), recordings: ids, ...(destination ? { destination } : {}),
        ...(shapes ? { places: 'shapes', inputs: shapes, ...(p.snap != null ? { snap: p.snap } : {}), ...(p.tolerance != null ? { tolerance: p.tolerance } : {}),
          ...(p.solid != null ? { solid: p.solid } : {}), ...(movementSpec(p.movement) !== undefined ? { physics: movementSpec(p.movement) } : {}) } : {}),
        ...(avoid?.length ? { avoid } : {}), ...(p.learn === false ? { learn: false } : {}) } },
      recordingIds: ids, fields: fieldList, formulas: specs } };
  }, [nodes, edges, fieldList, specs]);
  const [planPictures, setPlanPictures] = useState<Record<string, PlanPicture | { error: string }>>({});
  const planKey = JSON.stringify(nodes.filter(n => n.data.kind === 'planner' && n.data.mode === 'plan').map(n => [n.id, planRequest(n.id)]));
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const out: Record<string, PlanPicture | { error: string }> = {};
      for (const n of nodes.filter(n => n.data.kind === 'planner' && n.data.mode === 'plan')) {
        const r = planRequest(n.id);
        if ('error' in r) { out[n.id] = r; continue; }
        try { out[n.id] = await window.bridge.policy.invoke('planner.preview', r.request) as PlanPicture; }
        catch (e) { out[n.id] = { error: cleanError(e) }; }
      }
      if (alive) setPlanPictures(out);
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [planKey, refreshed]);
  // Drive: the planner moves the player to its destination itself, doing each hop as you did (worker/executor.py)
  const drive = useCallback(async (plannerId: string) => {
    if (!windowId) return;
    setError('');
    const r = planRequest(plannerId), planner = nodes.find(n => n.id === plannerId);
    if ('error' in r) { setError(`Can’t drive: ${r.error}`); return; }
    const res = await window.bridge.policy.play({ windowId, graphId, drive: r.request, driverId: plannerId,
      name: planner ? nameOf(planner) ?? 'the planner' : 'the planner' });
    if (!res.ok) setError(`Can’t drive: ${res.error ?? 'it didn’t start'}`);
  }, [windowId, graphId, planRequest, nodes]);
  const measurePlan = useCallback(async (nodeId: string, sample: LiveSample) => {
    const r = planRequest(nodeId);
    if ('error' in r) return r;
    return await window.bridge.policy.invoke('planner.preview', { ...r.request, observations: sample.observations }) as PlanPicture;
  }, [planRequest]);

  const compiled = useMemo(() => Object.fromEntries(nodes.filter(n => n.data.kind === 'policy')
    .map(n => [n.id, compilePolicy(doc, n.id, fields, checks, holds, name => stateLabels[name] ?? name)])), [doc, fields, checks, holds, stateLabels]);

  // Each policy's dataset as the worker would make it, worked out again a moment after it changes
  const previewKey = JSON.stringify(Object.entries(compiled).map(([id, c]) => [id, c.request]));
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      for (const [id, c] of Object.entries(compiled)) {
        if (!c.request) continue;
        setPreviews(p => ({ ...p, [id]: 'loading' }));
        window.bridge.policy.invoke('preview', { ...c.request })
          .then((r: unknown) => { if (alive) setPreviews(p => ({ ...p, [id]: r as Preview })); })
          .catch(e => { if (alive) setPreviews(p => ({ ...p, [id]: { error: cleanError(e) } })); });
      }
    }, 800);
    return () => { alive = false; clearTimeout(timer); };
  }, [previewKey]);

  const update = useCallback((id: string, patch: Record<string, unknown>) =>
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } as GraphNode['data'] } : n)), [setNodes]);
  const removeInput = useCallback((id: string, alias: string) => {
    setNodes(ns => ns.map(n => n.id === id && (n.data.kind === 'formula' || n.data.kind === 'spatial')
      ? { ...n, data: { ...n.data, inputs: n.data.inputs.filter(a => a !== alias),
          // a Spatial node's fields for that input alone go with it
          ...(n.data.kind === 'spatial' && n.data.fields ? { fields: n.data.fields
            .map(f => f.inputs ? { ...f, inputs: f.inputs.filter(a => a !== alias) } : f).filter(f => !f.inputs || f.inputs.length) } : {}) } as GraphNode['data'] } : n));
    setEdges(es => es.filter(e => !(e.target === id && e.targetHandle === `in:${alias}`)));
  }, [setNodes, setEdges]);
  // Every other graph's Policy nodes, to tell when one of this graph's is the same policy (pasted from it)
  const otherPolicies = useCallback(() => {
    const suffix = graphId ? `-document-${graphId}` : null;
    if (!suffix || !storageKey.endsWith(suffix)) return [];
    return policyNodes(storageKey.slice(0, -suffix.length)).filter(p => p.graphId !== graphId);
  }, [storageKey, graphId]);
  const policyIds = nodes.filter(n => n.data.kind === 'policy').map(n => n.id).join();
  const sharedWith = useMemo(() => {
    const mine = new Set(policyIds.split(',')), shared: Record<string, string[]> = {};
    for (const p of otherPolicies()) if (mine.has(p.policyId)) (shared[p.policyId] ??= []).push(p.graph);
    return shared;
  }, [policyIds, otherPolicies]);
  const separate = useCallback((nodeId: string) => {
    const next = crypto.randomUUID();
    setNodes(ns => ns.map(n => n.id === nodeId ? { ...n, id: next } : n));
    setEdges(es => es.map(e => e.source === nodeId || e.target === nodeId
      ? { ...e, id: crypto.randomUUID(), source: e.source === nodeId ? next : e.source, target: e.target === nodeId ? next : e.target } : e));
  }, [setNodes, setEdges]);
  const removeNode = useCallback((id: string) => { setNodes(ns => ns.filter(n => n.id !== id)); setEdges(es => es.filter(e => e.source !== id && e.target !== id)); }, [setNodes, setEdges]);

  const train = useCallback(async (id: string, withCorrections = false) => {
    const c = compiled[id];
    if (!c?.request) return;
    const node = nodes.find(n => n.id === id)!, { epochs, correctionShare } = node.data as PolicyData;
    let recordingIds = c.request.recordingIds;
    if (withCorrections) {
      const own = new Set(versions.filter(v => v.policy?.id === id).map(v => v.id));
      recordingIds = [...new Set([...recordingIds, ...recordings.filter(r => r.metadata.correction && own.has(r.metadata.policyId ?? '')).map(r => r.id)])];
    }
    setTraining({ nodeId: id, progress: null }); setError('');
    try {
      await window.bridge.policy.invoke('train', { ...c.request, recordingIds, epochs, correctionShare: correctionShare ?? DEFAULT_CORRECTION_SHARE });
      await refresh();
    } catch (e) { setError(cleanError(e)); }
    setTraining(null);
  }, [compiled, nodes, versions, recordings, refresh]);

  const exportDataset = useCallback(async (id: string) => {
    const c = compiled[id];
    if (!c?.request) return;
    setExported(null);
    const res = await window.bridge.policy.exportDataset({ ...c.request });
    if (res.ok && res.path) setExported({ nodeId: id, path: res.path,
      text: `Exported ${(res.samples ?? 0).toLocaleString()} rows of ${res.features ?? 0} values${res.stepMs ? `, ${res.stepMs} ms apart` : ''}.` });
    else if (!res.canceled) setError(res.error ?? 'Could not export');
  }, [compiled]);

  const play = useCallback(async (modelId: string) => {
    if (!windowId) return;
    setError('');
    // Where it heads is this graph's now (its Goal's target, route or plan), not what the version trained with
    const version = versions.find(v => v.id === modelId), goal = version?.policy ? playGoal(doc, version.policy.id) : null;
    if (goal && 'error' in goal) { setError(`Can’t play: ${goal.error}`); return; }
    const res = await window.bridge.policy.play({ modelId, windowId, corrections, graphId, ...(goal ? { goal } : {}) });
    if (!res.ok) setError(res.error ?? 'Could not start playing');
  }, [windowId, corrections, graphId, versions, doc]);

  // Wiring: a value into a formula input or a Policy's Values, a Recordings node into a Policy's Data.
  // An input takes one wire, so a new one replaces it
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = nodes.find(n => n.id === c.source), target = nodes.find(n => n.id === c.target);
    if (!source || !target || source.id === target.id) return false;
    const handle = c.targetHandle ?? '';
    if (target.data.kind === 'planner') {
      if (handle === PLANNER_MAP) return source.data.kind === 'spatial';
      if (handle === PLANNER_DATA) return source.data.kind === 'recordings';
      const type = source.data.kind === 'state' ? fields.get(source.data.name) : source.data.kind === 'formula' ? checks.get(nameOf(source) ?? '')?.type : 'none';
      if (handle === PLANNER_LEVEL) return source.data.kind === 'state' && type !== 'shapes' && type !== 'image';
      if (handle === PLANNER_DESTINATION) return type !== 'none' && (!type || type === 'vector');
      return false;
    }
    if (source.data.kind === 'recordings') return target.data.kind === 'policy' && handle === 'data';
    if (source.data.kind === 'planner') return target.data.kind === 'goal' && handle === GOAL_TARGET;
    if (source.data.kind === 'grid' || source.data.kind === 'spatial' || source.data.kind === 'goal') return target.data.kind === 'policy' && handle === 'values';
    if (target.data.kind === 'goal') {
      // Its position and target: positions; its facing: true or false. From a state or a formula (whose type may not be known yet)
      const type = source.data.kind === 'state' ? fields.get(source.data.name) : source.data.kind === 'formula' ? checks.get(nameOf(source) ?? '')?.type : 'none';
      if (type === 'none') return false;
      if (handle === GOAL_FACING) return !type || type === 'boolean';
      return (handle === GOAL_POSITION || handle === GOAL_TARGET) && (!type || type === 'vector');
    }
    if (target.data.kind === 'spatial') {
      // Its point: a position; its facing: true or false; its other inputs: shapes. From a state, or for the point
      // and facing a formula (whose type may not be known yet)
      const type = source.data.kind === 'state' ? fields.get(source.data.name) : source.data.kind === 'formula' ? checks.get(nameOf(source) ?? '')?.type : 'none';
      if (handle === SPATIAL_POINT) return type !== 'none' && (!type || type === 'vector');
      if (handle === SPATIAL_FACING) return type !== 'none' && (!type || type === 'boolean');
      // Bounds: shapes, or a table a script returns, such as {left, top, right, bottom} (worker/spatial.py, box_of)
      if (handle === SPATIAL_BOUNDS) return source.data.kind === 'state' && (type === 'shapes' || type === 'object');
      return handle.startsWith('in:') && source.data.kind === 'state' && type === 'shapes';
    }
    if (target.data.kind === 'grid') {
      if (handle === 'in:shapes') return source.data.kind === 'state' && fields.get(source.data.name) === 'shapes';
      // Its centre: a position, from a state or a formula (a formula's type may not be known yet)
      const type = source.data.kind === 'state' ? fields.get(source.data.name) : source.data.kind === 'formula' ? checks.get(nameOf(source) ?? '')?.type : 'none';
      return handle === 'in:center' && (!type || type === 'vector');
    }
    if (source.data.kind !== 'state' && source.data.kind !== 'formula') return false;
    const type = source.data.kind === 'state' ? fields.get(source.data.name) : checks.get(nameOf(source) ?? '')?.type ?? 'number';
    if (target.data.kind === 'policy') return handle === 'values' && (!type || VALUE_TYPES.includes(type));
    if (target.data.kind === 'formula') return handle.startsWith('in:') && (!type || FORMULA_INPUT_TYPES.includes(type)) && !makesCycle(doc, source.id, target.id);
    return false;
  }, [nodes, fields, checks, doc]);

  // A formula's inputs: a new one for a node wired in (named after it), renamed, and what can be wired in
  const labelOf = useCallback((node: GraphNode) => { const name = nameOf(node) ?? ''; return stateLabels[name] ?? name; }, [stateLabels]);
  const addInput = useCallback((formulaId: string, sourceId: string) => {
    const formula = nodes.find(n => n.id === formulaId), source = nodes.find(n => n.id === sourceId);
    if ((formula?.data.kind !== 'formula' && formula?.data.kind !== 'spatial') || !source) return;
    const alias = aliasFrom(labelOf(source), formula.data.inputs);
    setNodes(ns => ns.map(n => n.id === formulaId && (n.data.kind === 'formula' || n.data.kind === 'spatial')
      ? { ...n, data: { ...n.data, inputs: [...n.data.inputs, alias] } as GraphNode['data'] } : n));
    setEdges(es => addEdge({ source: sourceId, sourceHandle: 'out', target: formulaId, targetHandle: `in:${alias}` }, es));
  }, [nodes, labelOf, setNodes, setEdges]);
  const renameInput = useCallback((formulaId: string, alias: string, next: string) => {
    setNodes(ns => ns.map(n => n.id === formulaId && n.data.kind === 'formula'
      ? { ...n, data: { ...n.data, inputs: n.data.inputs.map(a => a === alias ? next : a), source: renameIn(n.data.source, alias, next) } }
      : n.id === formulaId && n.data.kind === 'spatial' ? { ...n, data: { ...n.data, inputs: n.data.inputs.map(a => a === alias ? next : a),
          ...(n.data.reads?.[alias] ? { reads: Object.fromEntries(Object.entries(n.data.reads).map(([a, r]) => [a === alias ? next : a, r])) } : {}),
          ...(n.data.fields ? { fields: n.data.fields.map(f => f.inputs ? { ...f, inputs: f.inputs.map(a => a === alias ? next : a) } : f) } : {}) } } : n));
    setEdges(es => es.map(e => e.target === formulaId && e.targetHandle === `in:${alias}` ? { ...e, targetHandle: `in:${next}`, id: `${e.id}~${next}` } : e));
  }, [setNodes, setEdges]);
  const inputChoices = useCallback((formulaId: string) => nodes
    .filter(n => (n.data.kind === 'state' || n.data.kind === 'formula') && n.id !== formulaId && nameOf(n)
      && isValidConnection({ source: n.id, sourceHandle: 'out', target: formulaId, targetHandle: NEW_INPUT })
      // shapes a Spatial node already measures aren't offered again
      && !(nodes.find(t => t.id === formulaId)?.data.kind === 'spatial' && edges.some(e => e.source === n.id && e.target === formulaId)))
    .map(n => ({ id: n.id, label: `${n.data.kind === 'formula' ? 'ƒ ' : ''}${labelOf(n)}` })), [nodes, edges, isValidConnection, labelOf]);

  const onConnect = useCallback((c: Connection) => {
    if (c.targetHandle === NEW_INPUT) { addInput(c.target, c.source); return; }
    // A formula's or grid's input, a policy's data, take one wire; a Spatial node's shapes inputs take several
    const single = (c.targetHandle?.startsWith('in:') || c.targetHandle === 'data') && !takesMany(nodes.find(n => n.id === c.target), c.targetHandle);
    setEdges(es => addEdge({ ...c, animated: c.targetHandle === 'data' }, single ? es.filter(e => !(e.target === c.target && e.targetHandle === c.targetHandle)) : es));
  }, [setEdges, addInput, nodes]);
  // A wire's end dragged somewhere else moves it there; dropped where nothing takes it, the wire goes
  const reconnected = useRef(true);
  const onReconnectStart = useCallback(() => { reconnected.current = false; }, []);
  const onReconnect = useCallback((old: Edge, c: Connection) => {
    reconnected.current = true;
    if (c.targetHandle === NEW_INPUT) { setEdges(es => es.filter(e => e.id !== old.id)); addInput(c.target, c.source); return; }
    const single = (c.targetHandle?.startsWith('in:') || c.targetHandle === 'data') && !takesMany(nodes.find(n => n.id === c.target), c.targetHandle);
    setEdges(es => {
      const rest = single ? es.filter(e => e.id === old.id || !(e.target === c.target && e.targetHandle === c.targetHandle)) : es;
      return reconnectEdge(old, c, rest);
    });
  }, [setEdges, addInput, nodes]);
  const onReconnectEnd = useCallback((_: unknown, edge: Edge) => {
    if (!reconnected.current) setEdges(es => es.filter(e => e.id !== edge.id));
    reconnected.current = true;
  }, [setEdges]);
  // The wire under the pointer, shown in full: drawn thicker and bright, above the others, and its ends lit
  const [hotEdge, setHotEdge] = useState<Edge | null>(null);
  const shownEdges = useMemo(() => hotEdge ? edges.map(e => e.id === hotEdge.id ? { ...e, className: 'pg-edge-hot', zIndex: 1000 } : e) : edges, [edges, hotEdge]);
  const hot = useCallback((nodeId: string, handle: string) => !!hotEdge
    && ((hotEdge.target === nodeId && hotEdge.targetHandle === handle) || (hotEdge.source === nodeId && (hotEdge.sourceHandle ?? 'out') === handle)), [hotEdge]);

  // Dragging from the palette: a state, a formula, a Recordings node or a Policy
  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/firefly-node');
    if (!raw) return;
    const item = JSON.parse(raw) as { kind: string; name?: string };
    const position = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = crypto.randomUUID();
    const count = (kind: string) => nodes.filter(n => n.data.kind === kind).length + 1;
    const data: GraphNode['data'] = item.kind === 'state' ? { kind: 'state', name: item.name! }
      : item.kind === 'formula' ? { kind: 'formula', name: `formula ${count('formula')}`, source: '', inputs: ['a', 'b'] }
      : item.kind === 'recordings' ? { kind: 'recordings', ids: [] }
      : item.kind === 'grid' ? { kind: 'grid', name: `grid ${count('grid')}`, cols: 16, rows: 9, mode: 'coverage', width: frameSize?.w ?? 1280, height: frameSize?.h ?? 720 }
      : item.kind === 'goal' ? { kind: 'goal', name: count('goal') > 1 ? `goal ${count('goal')}` : 'goal', ...GOAL_DEFAULTS }
      : item.kind === 'planner' ? { kind: 'planner', name: count('planner') > 1 ? `planner ${count('planner')}` : 'planner', mode: 'route',
          route: { recording: recordings.filter(r => r.status === 'complete' && !r.metadata.correction).sort((a, b) => b.metadata.started - a.metadata.started)[0]?.id ?? '', aheadS: ROUTE_AHEAD_S } }
      : item.kind === 'spatial' ? { kind: 'spatial', name: count('spatial') > 1 ? `spatial ${count('spatial')}` : 'spatial', inputs: [], radii: SPATIAL_RADII, maxDistance: SPATIAL_REACH }
      : { kind: 'policy', name: `Policy ${count('policy')}`, buttons: null, off: [], stepMs: null, history: 2, delayMs: 0, epochs: 60 };
    setNodes(ns => [...ns, { id, type: data.kind, position, data }]);
  }, [flow, nodes, setNodes]);
  // A graph as text, to keep, share or start from: copied to the clipboard, or pasted in place of this one
  const [copied, setCopied] = useState(false);
  const copyGraph = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ version: 1, nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges }, null, 1));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch (e) { setError('Could not copy: ' + cleanError(e)); }
  };
  const pasteGraph = async () => {
    try {
      let pasted: GraphDoc | null = null;
      try { pasted = JSON.parse(await navigator.clipboard.readText()) as GraphDoc; } catch { /* not JSON */ }
      if (pasted?.version !== 1 || !Array.isArray(pasted.nodes) || !Array.isArray(pasted.edges) || !pasted.nodes.length) {
        setError('The clipboard doesn’t hold a Policy Graph'); return;
      }
      if (nodes.length > 2 && !window.confirm('Replace this graph with the one on the clipboard?')) return;
      pasted = migrateGraph(pasted);
      const taken = new Set(otherPolicies().map(p => p.policyId)), ids = new Map<string, string>();
      for (const n of pasted.nodes) if (n.data?.kind === 'policy' && taken.has(n.id)) ids.set(n.id, crypto.randomUUID());
      const fresh = (id: string) => ids.get(id) ?? id;
      setNodes(pasted.nodes.map(n => ({ ...n, id: fresh(n.id) })));
      setEdges(pasted.edges.map(e => ids.has(e.source) || ids.has(e.target) ? { ...e, id: crypto.randomUUID(), source: fresh(e.source), target: fresh(e.target) } : e));
      setError('');
      setTimeout(() => flow.fitView(), 50);
    } catch (e) { setError('Could not paste: ' + cleanError(e)); }
  };
  const drag = (item: { kind: string; name?: string }) => (e: DragEvent) => {
    e.dataTransfer.setData('application/firefly-node', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
  };

  const unassigned = versions.filter(v => !v.policy && v.version === POLICY_VERSION);
  const ctx: Ctx = { fields, recordedAnywhere, labels: stateLabels, recordings, checks, gridChecks, spatialChecks, goalChecks, compiled, previews, versions, deleteVersion, deleteAll, status, training, capturing, windowId, recordingNow: recording,
    corrections, setCorrections, update, removeNode, removeInput, train, exportDataset, play, drive, stop: (e?: { detail: number }) => void window.bridge.policy.stop(stopHow(e)), exported,
    wiredInto: (nodeId, handle) => nameOf(nodes.find(n => n.id === edges.find(e => e.target === nodeId && e.targetHandle === handle)?.source)) ?? null,
    planPictures, measurePlan,
    nodeInto: (nodeId, handle) => nodes.find(n => n.id === edges.find(e => e.target === nodeId && e.targetHandle === handle)?.source),
    nodesOutOf: nodeId => edges.filter(e => e.source === nodeId).map(e => nodes.find(n => n.id === e.target)).filter((n): n is GraphNode => !!n),
    wiredAll: (nodeId, handle) => edges.filter(e => e.target === nodeId && e.targetHandle === handle)
      .map(e => nameOf(nodes.find(n => n.id === e.source))).filter((n): n is string => !!n),
    measureSpatial: async (nodeId, sample) => {
      const node = nodes.find(n => n.id === nodeId), spec = node ? spatialSpec(doc, node) : null;
      if (!spec) return null;
      return await window.bridge.policy.invoke('spatial.sample', { fields: fieldList, formulas: specs, spatial: spec, ...sample }) as SpatialCheck;
    },
    latestLive: () => latestLive.current, refreshChecks: () => setRefreshed(n => n + 1), sharedWith, separate,
    addInput, renameInput, inputChoices, hot };

  return <GraphContext.Provider value={ctx}>
    <aside className="pg-palette" aria-label="Nodes to add">
      <div className="pg-palette-hd">Drag onto the graph</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'formula' })}><span className="pg-glyph">ƒ</span>Formula</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'grid' })} title="Shapes, such as platforms, as a grid over the whole screen"><span className="pg-glyph">▦</span>Grid</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'spatial' })} title="How shapes, such as platforms and monsters, lie around a point, such as the player: distances and counts as values"><span className="pg-glyph">⌖</span>Spatial</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'goal' })} title="Where the player is to get to: trained on where you went, played toward a target"><span className="pg-glyph">⚑</span>Goal</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'planner' })} title="Where play heads, for a Goal's Target: along a recording's route"><span className="pg-glyph">⤳</span>Planner</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'recordings' })}><span className="pg-glyph">▤</span>Recordings</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'policy' })}><span className="pg-glyph">◎</span>Policy</div>
      <div className="pg-hint pg-drag-states">Drag States in from the States list on the right.</div>
      {unassigned.length > 0 && <>
        <div className="pg-palette-hd">Earlier policies</div>
        {unassigned.slice(0, 8).map(v => <div key={v.id} className="pg-palette-policy">
          <span>{new Date(v.created * 1000).toLocaleString()}</span>
          {status.playing && status.modelId === v.id ? <button className="modal-btn" onClick={ctx.stop}>Stop</button>
            : <button className="modal-btn" disabled={!capturing || !windowId || recording || status.playing} onClick={() => void play(v.id)}>Play</button>}
        </div>)}
      </>}
      <div className="pg-palette-hd">Graph</div>
      <div className="pg-palette-row">
        <button className="modal-btn" title="Copy this graph to the clipboard, as text" onClick={() => void copyGraph()}>{copied ? 'Copied' : 'Copy graph'}</button>
        <button className="modal-btn" title="Replace this graph with one copied to the clipboard" onClick={() => void pasteGraph()}>Paste graph</button>
      </div>
      <div className="pg-palette-hd">Help</div>
      <div className="pg-hint">Wire states into a Formula's inputs (a, b…) and write what it works out, such as <code>distance(a, b)</code>. Wire states, formulas and grids into a Policy's Values: they're its dataset's columns. A Grid lays shapes, such as platforms, over the whole screen in cells. A Spatial node measures shapes from a point, such as the player: the nearest, the nearest each way, and how many are near. A Recordings node wired into Data is its rows. Delete or Backspace removes what’s selected, or click ✕ on any node.</div>
    </aside>
    <div className="pg-canvas" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
      {(error || status.reason) && <div className="pg-banner">{error || `Stopped: ${status.reason}`}<button className="pg-x" onClick={() => { setError(''); setStatus(s => ({ ...s, reason: null })); }}>✕</button></div>}
      {status.playing && <div className="pg-banner pg-banner-live">{playingText(status)}
        <button className="modal-btn" onClick={ctx.stop}>Stop</button></div>}
      <ReactFlow nodes={nodes} edges={shownEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        isValidConnection={isValidConnection} nodeTypes={nodeTypes} colorMode="dark" fitView={!localStorage.getItem(storageKey + '-view')} defaultViewport={JSON.parse(localStorage.getItem(storageKey + '-view') ?? 'null') ?? undefined} minZoom={0.3} maxZoom={1.5}
        onMoveEnd={(_, viewport) => localStorage.setItem(storageKey + '-view', JSON.stringify(viewport))}
        edgesReconnectable reconnectRadius={20} onReconnect={onReconnect} onReconnectStart={onReconnectStart} onReconnectEnd={onReconnectEnd}
        onEdgeMouseEnter={(_, e) => setHotEdge(e)} onEdgeMouseLeave={() => setHotEdge(null)}
        deleteKeyCode={['Delete', 'Backspace']}>
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </GraphContext.Provider>;
}
