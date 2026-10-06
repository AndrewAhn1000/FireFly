import type { Edge, Node } from '@xyflow/react';

// The Policy Graph as data, and what it means for training: which recordings, formulas and values make a
// Policy node's dataset. A node's output handle is `out` (a state or formula: its value) or `data` (a
// Recordings node); a formula's inputs are handles `in:<alias>`, a Policy's are `values` and `data`.
// Pure, so it can be reasoned about apart from the editor (src/PolicyGraph.tsx).

export interface StateData { kind: 'state'; name: string; [key: string]: unknown }
export interface FormulaData { kind: 'formula'; name: string; source: string; inputs: string[]; [key: string]: unknown }
export interface RecordingsData { kind: 'recordings'; ids: string[]; [key: string]: unknown }
// A shapes observation (wired into `in:shapes`) as a grid of cells over the whole screen, row by row: each
// cell how much the shapes cover it, or whether any is there (worker/shapes.py, grid_values). width and
// height are the screen it's laid over when a recording doesn't say (recordings keep each frame's size).
// A grid lies over the whole screen, or, with a position wired into in:center, moves with it: cols x rows
// cells of `cell` px around it
export interface GridData { kind: 'grid'; name: string; cols: number; rows: number; mode: 'coverage' | 'present'; width: number; height: number; cell?: number; [key: string]: unknown }
export interface PolicyData {
  kind: 'policy'; name: string;
  buttons: string[] | null; // the labels: the buttons it learns and presses; null is every one recorded
  off: string[];            // values wired in but left out, by column name
  stepMs: number | null; history: number; delayMs: number; epochs: number;
  [key: string]: unknown;
}
export type GraphData = StateData | FormulaData | RecordingsData | PolicyData | GridData;
export type GraphNode = Node<GraphData>;
export interface GraphDoc { version: 1; nodes: GraphNode[]; edges: Edge[]; }

// What the worker says about each formula (worker/formulas.py), by name
export interface FormulaCheck {
  name: string; source: string; type: string | null; columns: string[]; error: string | null;
  preview?: { value: number[] | null; missing: number; rows: number; reason: string | null };
}
export interface FormulaSpec { name: string; source: string; inputs: Record<string, string>; }
export interface GridSpec { name: string; shapes: string; cols: number; rows: number; mode: string; width: number; height: number; center?: string; cell?: number; }
export interface PolicyRequest {
  recordingIds: string[]; formulas: FormulaSpec[]; grids: GridSpec[]; columns: string[]; buttons: string[] | null;
  stepMs?: number; history: number; actionDelayMs: number; policy: { id: string; name: string };
}
// A value wired into a Policy: the node it comes from and the dataset columns it gives
export interface PolicyValue { nodeId: string; name: string; type: string | null; columns: string[]; }
export interface Compiled { request: PolicyRequest | null; values: PolicyValue[]; problems: string[]; }

export const GRID_CELL = 40; // px, a centred grid's cell unless it says otherwise
export const VALUE_TYPES = ['number', 'boolean', 'vector'];     // what a dataset can hold as numbers
export const FORMULA_INPUT_TYPES = [...VALUE_TYPES, 'shapes'];  // what formulas can read

export const emptyGraph = (): GraphDoc => ({
  version: 1, edges: [],
  nodes: [
    { id: 'recordings', type: 'recordings', position: { x: 40, y: 260 }, data: { kind: 'recordings', ids: [] } },
    { id: 'policy', type: 'policy', position: { x: 620, y: 80 },
      data: { kind: 'policy', name: 'Policy 1', buttons: null, off: [], stepMs: null, history: 2, delayMs: 0, epochs: 60 } },
  ],
});

// The columns an observation gives in a dataset, or null if it isn't a value (shapes, text, images)
export function columnsOf(name: string, type: string | undefined): string[] | null {
  if (type === 'vector') return [`${name}.x`, `${name}.y`];
  if (type === 'number' || type === 'boolean') return [name];
  return null;
}

// The name a node's value goes by: an observation's, or a formula's
export function nameOf(node: GraphNode | undefined): string | null {
  if (!node) return null;
  if (node.data.kind === 'state') return node.data.name;
  if (node.data.kind === 'formula' || node.data.kind === 'grid') return node.data.name.trim() || null;
  return null;
}

const byId = (doc: GraphDoc) => new Map(doc.nodes.map(n => [n.id, n]));
const into = (doc: GraphDoc, target: string, handle: string) =>
  doc.edges.filter(e => e.target === target && (e.targetHandle ?? '') === handle);

// Every formula, as the worker takes it: its inputs are what's wired into them
export function formulaSpec(doc: GraphDoc, node: GraphNode): FormulaSpec | null {
  if (node.data.kind !== 'formula') return null;
  const nodes = byId(doc), inputs: Record<string, string> = {};
  for (const alias of node.data.inputs) {
    const from = nameOf(nodes.get(into(doc, node.id, `in:${alias}`)[0]?.source ?? ''));
    if (from) inputs[alias] = from;
  }
  return { name: node.data.name.trim(), source: node.data.source, inputs };
}

// A grid as the worker takes it, once a shapes observation is wired into it
export function gridSpec(doc: GraphDoc, node: GraphNode): GridSpec | null {
  if (node.data.kind !== 'grid') return null;
  const nodes = byId(doc), shapes = nameOf(nodes.get(into(doc, node.id, 'in:shapes')[0]?.source ?? ''));
  const center = nameOf(nodes.get(into(doc, node.id, 'in:center')[0]?.source ?? ''));
  const d = node.data;
  return shapes ? { name: d.name.trim(), shapes, cols: d.cols, rows: d.rows, mode: d.mode, width: d.width, height: d.height,
    ...(center ? { center, cell: d.cell ?? GRID_CELL } : {}) } : null;
}

export function gridSpecs(doc: GraphDoc): GridSpec[] {
  return doc.nodes.map(n => gridSpec(doc, n)).filter((g): g is GridSpec => !!g && !!g.name);
}

export const gridColumns = (g: { name: string; cols: number; rows: number }) =>
  Array.from({ length: g.rows * g.cols }, (_, i) => `${g.name.trim()}.r${Math.floor(i / g.cols)}c${i % g.cols}`);

export function formulaSpecs(doc: GraphDoc): FormulaSpec[] {
  return doc.nodes.map(n => formulaSpec(doc, n)).filter((f): f is FormulaSpec => !!f && !!f.name);
}

// The nodes a node's value is made from, following formula inputs back
export function upstream(doc: GraphDoc, ids: string[]): Set<string> {
  const nodes = byId(doc), seen = new Set<string>(), stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node?.data.kind === 'formula')
      for (const alias of node.data.inputs) for (const e of into(doc, id, `in:${alias}`)) stack.push(e.source);
    if (node?.data.kind === 'grid')  // what it's centred on, such as a formula
      for (const e of into(doc, id, 'in:center')) stack.push(e.source);
  }
  return seen;
}

const notRecorded = (name: string) =>
  `${name} isn’t in the chosen recordings: tick it in the Recordings tab and record, or choose recordings that hold it`;

// Whether wiring `source` into `target` would make a formula depend on itself
export function makesCycle(doc: GraphDoc, source: string, target: string): boolean {
  return source === target || upstream(doc, [source]).has(target);
}

// A Policy node's dataset, as a request for the worker's preview, train and export, and what stops it.
// `fields` is every observation's type, from what's observed now and what's recorded; `holds` is what each
// recording holds, by id. A policy is built from States, and its recordings are checked against it, since
// it can train only on what all of them hold.
export function compilePolicy(doc: GraphDoc, policyId: string, fields: Map<string, string>,
    checks: Map<string, FormulaCheck>, holds: Map<string, Set<string>> = new Map()): Compiled {
  const nodes = byId(doc), policy = nodes.get(policyId);
  const problems: string[] = [], values: PolicyValue[] = [];
  if (!policy || policy.data.kind !== 'policy') return { request: null, values, problems: ['Not a policy'] };
  const data = policy.data;
  const source = nodes.get(into(doc, policyId, 'data')[0]?.source ?? '');
  const recordingIds = source?.data.kind === 'recordings' ? source.data.ids : [];
  const held = recordingIds.map(id => holds.get(id)).filter((s): s is Set<string> => !!s);
  const recorded = held.length ? new Set([...held[0]].filter(name => held.every(s => s.has(name)))) : null;
  if (!source) problems.push('Wire a Recordings node into Data');
  else if (!recordingIds.length) problems.push('Choose recordings in the Recordings node');
  const seen = new Set<string>(), grids: GridSpec[] = [];
  for (const e of into(doc, policyId, 'values')) {
    const node = nodes.get(e.source), name = nameOf(node);
    if (!node || !name || seen.has(name)) continue;
    seen.add(name);
    if (node.data.kind === 'grid') {
      const spec = gridSpec(doc, node);
      if (!spec) problems.push(`Wire a shapes observation, such as platforms, into ${name}`);
      else if (fields.get(spec.shapes) !== 'shapes') problems.push(`${name}: ${spec.shapes} isn\u2019t shapes`);
      else if (recorded && !recorded.has(spec.shapes)) problems.push(notRecorded(spec.shapes));
      else if (spec.center && (fields.get(spec.center) ?? checks.get(spec.center)?.type) !== 'vector')
        problems.push(`${name} is centred on ${spec.center}, which isn’t a position (a vector)`);
      else if (spec.center && recorded && fields.has(spec.center) && !checks.has(spec.center) && !recorded.has(spec.center))
        problems.push(notRecorded(spec.center));
      else grids.push(spec);
      values.push({ nodeId: node.id, name, type: 'grid', columns: spec ? gridColumns(spec) : [] });
      continue;
    }
    if (node.data.kind === 'state') {
      const type = fields.get(name);
      const columns = columnsOf(name, type);
      if (!type) problems.push(`${name}: its type isn’t known until FireFly observes it (start a capture session) or a recording holds it`);
      else if (!columns) problems.push(`${name} is ${type}: use it through a formula`);
      else if (recorded && !recorded.has(name)) problems.push(notRecorded(name));
      values.push({ nodeId: node.id, name, type: type ?? null, columns: columns ?? [] });
    } else {
      const check = checks.get(name);
      if (!check) problems.push(`Checking ${name}…`);
      else if (check.error) problems.push(`Fix the formula ${name}: ${check.error}`);
      values.push({ nodeId: node.id, name, type: check?.type ?? null, columns: check?.error ? [] : check?.columns ?? [] });
    }
  }
  if (!values.length) problems.push('Wire states or formulas into Values');
  const formulaIds = upstream(doc, values.map(v => v.nodeId));
  const formulas: FormulaSpec[] = [];
  for (const id of formulaIds) {
    const node = nodes.get(id);
    if (node?.data.kind !== 'formula') continue;
    const spec = formulaSpec(doc, node)!;
    const unwired = node.data.inputs.filter(a => !(a in spec.inputs));
    if (!spec.name) problems.push('Name every formula');
    if (unwired.length) problems.push(`Wire input${unwired.length > 1 ? 's' : ''} ${unwired.join(', ')} of ${spec.name || 'a formula'}`);
    const check = checks.get(spec.name);
    if (check?.error && !values.some(v => v.name === spec.name)) problems.push(`Fix the formula ${spec.name}: ${check.error}`);
    formulas.push(spec);
  }
  if (recorded) {
    const made = new Set(formulas.map(f => f.name));
    for (const input of new Set(formulas.flatMap(f => Object.values(f.inputs))))
      if (!made.has(input) && !recorded.has(input)) problems.push(notRecorded(input));
  }
  const off = new Set(data.off);
  const columns = values.flatMap(v => v.columns).filter(c => !off.has(c));
  if (values.length && !columns.length && !problems.length) problems.push('Every value is left out: tick at least one');
  if (data.buttons && !data.buttons.length) problems.push('Choose at least one button for it to learn');
  if (!data.name.trim()) problems.push('Name the policy');
  const request: PolicyRequest = {
    recordingIds, formulas, grids, columns, buttons: data.buttons,
    ...(data.stepMs ? { stepMs: data.stepMs } : {}), history: data.history, actionDelayMs: data.delayMs,
    policy: { id: policyId, name: data.name.trim() },
  };
  return { request: problems.length ? null : request, values, problems: [...new Set(problems)] };
}

// Reading a saved graph: anything malformed falls back to an empty one
export function readGraph(text: string | null): GraphDoc {
  try {
    const doc = JSON.parse(text ?? 'null') as GraphDoc | null;
    if (doc?.version === 1 && Array.isArray(doc.nodes) && Array.isArray(doc.edges)) return doc;
  } catch { /* fall through */ }
  return emptyGraph();
}
