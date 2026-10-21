import type { Edge, Node } from '@xyflow/react';
import { compileMap, type CompiledMap, type MapDoc } from './mapModel';

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
// How shapes lie around a point (worker/spatial.py): a position wired into `in:@point` (and, optionally, a
// true/false into `in:@facing`, true facing left), and shapes wired into inputs named like a formula's
// (`in:<alias>`; each takes any number of wires, measured together as one set), each giving the same columns,
// named <name>.<alias>.…: the nearest, the nearest each way, how many within each radius, and whether the
// point is inside one. Shapes wired into `in:@bounds` only frame the node's picture
// One of a Spatial node's fields (worker/spatial.py): which shape it's about (`pick`; `by`, the shapes' own field
// lowest and highest rank by), only those within a radius and where one of their fields compares to a number, what
// it gives (`value`; `prop`, the shape's own field it gives), what that reads with nothing picked (`fill`), and the
// inputs it's for (all, without `inputs`). Each gives a column per input it's for, <node>.<input>.<name>
// `under` is the shape directly below the point (a platform stood on, or landed on); a field can leave that one out
// (`notUnder`), so the nearest ahead is the next ledge. Its ends: how far the picked shape reaches left and right of
// the point (positive while it does), or ahead and behind with facing
export type SpatialPick = 'nearest' | 'left' | 'right' | 'above' | 'below' | 'ahead' | 'behind' | 'lowest' | 'highest' | 'under' | 'all';
export type SpatialValue = 'dx' | 'dy' | 'forward' | 'dist' | 'found' | 'prop' | 'left_end' | 'right_end' | 'ahead_end' | 'behind_end' | 'count' | 'inside';
export interface SpatialField {
  name: string; pick: SpatialPick; value: SpatialValue; by?: string; prop?: string; within?: number;
  where?: { field: string; op: '<' | '<=' | '>' | '>=' | '==' | '!='; value: number }; fill?: number; inputs?: string[];
  notUnder?: boolean;
  // Only shapes touching a box round the point: so far ahead (the way it faces; right without facing), behind, up, down
  area?: { ahead: number; behind: number; above: number; below: number };
}
// How an input's shapes of x, y, w, h alone are read (worker/spatial.py, read_as): a point at (x, y), as any shape of x
// and y alone is; the box from its top-left corner (a script's {x, y, w, h}); the box round its centre (a template
// match's); or the point at its bottom centre
export type SpatialRead = 'point' | 'corner' | 'centre' | 'bottom';
// `fields` are its own, once any preset is edited; without them it has the presets, made from `radii`. `reads`, by
// input: how each reads x, y, w, h (a point, unless it says)
export interface SpatialData {
  kind: 'spatial'; name: string; inputs: string[]; radii: number[]; maxDistance: number; fields?: SpatialField[];
  reads?: Record<string, SpatialRead>; [key: string]: unknown;
}
// Where the player is to get to (worker/observations.py, Featurizer.goal): the way from a position wired into
// `in:@position` (and, optionally, which way it faces, `in:@facing`) to a target, as columns <name>.forward (or
// .dx), .dy and .dist. In training the target is where the player got to `lookAhead` seconds later (hindsight:
// `targets` of them, evenly over the range, each a row, those under `minMove` px away left out), so the policy
// learns how to get to a place from every move recorded; in play it's where `heads` says: what's wired into
// `in:@target`, the way over a map (a Map graph, src/mapModel.ts), or along a recording's route
export interface GoalData {
  kind: 'goal'; name: string; lookAhead: [number, number]; targets: number; minMove: number;
  heads?: GoalHeads;   // absent: what's wired into its Target
  route?: { recording: string; aheadS: number } | null;  // from before Planners: migrateGraph makes it `heads`
  hint?: boolean; // the plan's next move as values too: per button, whether it's next and how far until it is
  [key: string]: unknown;
}
// Where play heads. `map`: over a Map graph's places and links (and what it learns on a grid), toward a place of it,
// a position wired into `in:@destination`, or where a recording ended, aiming aheadS seconds along the quickest way
// (worker/planner.py); `avoid`, inputs of a Spatial node wired into `in:@avoid` whose shapes the way keeps away from;
// `learn`, a link that doesn't happen costs more for the rest of the run. `route`: the point aheadS seconds on along
// where the player went in a recording, from where the player is on it. Either way play's targets are like training's:
// where to get to next, not somewhere far off
export type MapDestination = { kind: 'place'; place: string } | { kind: 'input' } | { kind: 'end'; recording: string };
export type GoalHeads = { kind: 'target' }
  | { kind: 'map'; map: string; destination: MapDestination; aheadS: number; avoid?: string[]; learn?: boolean }
  | { kind: 'route'; recording: string; aheadS: number };
// A map as a Goal reads it: its saved document and name in the graph library, null when it's gone
export type MapLookup = (id: string) => { doc: MapDoc; name: string } | null;
// The Planner node from before maps (graphs are migrated: migrateGraph)
interface LegacyPlanner {
  kind: 'planner'; name: string; mode: 'route' | 'plan'; route: { recording: string; aheadS: number };
  plan?: { cell: number; aheadS: number; destination: { kind: 'point'; x?: number; y?: number; level?: string | null } | { kind: 'input' } | { kind: 'end'; recording: string };
    avoid?: string[]; learn?: boolean };
}

export interface PolicyData {
  kind: 'policy'; name: string;
  buttons: string[] | null; // the labels: the buttons it learns and presses; null is every one recorded
  off: string[];            // values wired in but left out, by column name
  stepMs: number | null; history: number; delayMs: number; epochs: number;
  correctionShare?: number; // how much of training its corrections make up (DEFAULT_CORRECTION_SHARE unless chosen)
  [key: string]: unknown;
}
export type GraphData = StateData | FormulaData | RecordingsData | PolicyData | GridData | SpatialData | GoalData;
export type GraphNode = Node<GraphData>;
export interface GraphDoc { version: 1; nodes: GraphNode[]; edges: Edge[]; }

// What the worker says about each formula (worker/formulas.py), by name
export interface FormulaCheck {
  name: string; source: string; type: string | null; columns: string[]; error: string | null;
  preview?: { value: number[] | null; missing: number; rows: number; reason: string | null };
}
export interface FormulaSpec { name: string; source: string; inputs: Record<string, string>; }
export interface GridSpec { name: string; shapes: string; cols: number; rows: number; mode: string; width: number; height: number; center?: string; cell?: number; }
export interface SpatialSpec {
  name: string; point: string; facing?: string; bounds?: string; sets: { alias: string; shapes: string[]; read?: SpatialRead }[];
  radii: number[]; maxDistance: number; fields?: SpatialField[];
}
export interface PlanSpec {
  map: CompiledMap & { id: string; name: string }; aheadS: number;
  avoid?: { alias: string; shapes: string[]; read?: SpatialRead }[]; learn?: false;
  destination: { kind: 'place'; place: string } | { kind: 'input'; name: string } | { kind: 'end'; recording: string };
}
export interface GoalSpec {
  name: string; position: string; facing?: string; target?: string; route?: { recording: string; aheadS: number }; plan?: PlanSpec;
  lookAhead: [number, number]; targets: number; minMove: number;
  hint?: true; // the plan's next move as columns, for the buttons the policy presses (the worker names them)
}
export interface PolicyRequest {
  recordingIds: string[]; formulas: FormulaSpec[]; grids: GridSpec[]; spatial: SpatialSpec[]; goal?: GoalSpec; columns: string[]; buttons: string[] | null;
  stepMs?: number; history: number; actionDelayMs: number; policy: { id: string; name: string };
}
// A value wired into a Policy: the node it comes from and the dataset columns it gives
export interface PolicyValue { nodeId: string; name: string; type: string | null; columns: string[]; }
export interface Compiled { request: PolicyRequest | null; values: PolicyValue[]; problems: string[]; }

export const GRID_CELL = 40; // px, a centred grid's cell unless it says otherwise
export const SPATIAL_RADII = [100, 250, 500], SPATIAL_REACH = 1000; // px, a Spatial node's unless it says otherwise
export const SPATIAL_POINT = 'in:@point', SPATIAL_FACING = 'in:@facing', SPATIAL_BOUNDS = 'in:@bounds'; // an alias has no @, so these are never one
export const GOAL_POSITION = 'in:@position', GOAL_FACING = 'in:@facing', GOAL_TARGET = 'in:@target';
export const GOAL_DESTINATION = 'in:@destination', GOAL_AVOID = 'in:@avoid';  // heading over a map
export const GOAL_DEFAULTS = { lookAhead: [1, 4] as [number, number], targets: 3, minMove: 20 };
export const ROUTE_AHEAD_S = 2.5; // the middle of the default look-ahead: how far along a map or route play aims
// Whether a Spatial node's input takes several wires: its shapes inputs do, its point, facing and bounds don't
export const takesMany = (node: GraphNode | undefined, handle: string | null | undefined) =>
  node?.data.kind === 'spatial' && !!handle && handle.startsWith('in:') && !handle.startsWith('in:@') && handle !== 'in:+';
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
  if (node.data.kind === 'formula' || node.data.kind === 'grid' || node.data.kind === 'spatial' || node.data.kind === 'goal')
    return node.data.name.trim() || null;
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

// A Spatial node as the worker takes it, once a point and shapes are wired into it
export function spatialSpec(doc: GraphDoc, node: GraphNode): SpatialSpec | null {
  if (node.data.kind !== 'spatial') return null;
  const nodes = byId(doc), from = (handle: string) => nameOf(nodes.get(into(doc, node.id, handle)[0]?.source ?? ''));
  const point = from(SPATIAL_POINT), facing = from(SPATIAL_FACING), bounds = from(SPATIAL_BOUNDS);
  const reads = node.data.reads ?? {};
  const sets = node.data.inputs.map(alias => ({ alias,
    shapes: [...new Set(into(doc, node.id, `in:${alias}`).map(e => nameOf(nodes.get(e.source))).filter((n): n is string => !!n))],
    ...(reads[alias] && reads[alias] !== 'point' ? { read: reads[alias] } : {}) }))
    .filter(s => s.shapes.length);
  return point && sets.length ? { name: node.data.name.trim(), point, ...(facing ? { facing } : {}), ...(bounds ? { bounds } : {}), sets,
    radii: [...new Set(node.data.radii)].sort((a, b) => a - b), maxDistance: node.data.maxDistance,
    ...(node.data.fields ? { fields: node.data.fields } : {}) } : null;
}

// The presets, as worker/spatial.py makes them (default_fields): the nearest's dx (positive ahead with facing), dy,
// distance and found; the nearest each way; how many within each radius; and whether the point is inside one
export function defaultSpatialFields(radii: number[], facing: boolean): SpatialField[] {
  return [
    { name: 'nearest.dx', pick: 'nearest', value: facing ? 'forward' : 'dx' },
    { name: 'nearest.dy', pick: 'nearest', value: 'dy' },
    { name: 'nearest.dist', pick: 'nearest', value: 'dist' },
    { name: 'nearest.found', pick: 'nearest', value: 'found' },
    ...(facing ? ['ahead', 'behind', 'above', 'below'] as const : ['left', 'right', 'above', 'below'] as const)
      .map(d => ({ name: d, pick: d, value: 'dist' } as SpatialField)),
    ...[...new Set(radii)].sort((a, b) => a - b).map(r => ({ name: `within.${r}`, pick: 'all', within: r, value: 'count' } as SpatialField)),
    { name: 'inside', pick: 'all', value: 'inside' },
  ];
}

// A Spatial node's fields: its own, else the presets
export const spatialFields = (data: SpatialData, facing: boolean) => data.fields ?? defaultSpatialFields(data.radii, facing);
export const fieldApplies = (field: SpatialField, alias: string) => !field.inputs || field.inputs.includes(alias);

export function spatialSpecs(doc: GraphDoc): SpatialSpec[] {
  return doc.nodes.map(n => spatialSpec(doc, n)).filter((s): s is SpatialSpec => !!s && !!s.name);
}

// Its columns, as worker/spatial.py names them (field_columns): per input, one for each field it's for
export function spatialColumns(name: string, aliases: string[], fields: SpatialField[]): string[] {
  return aliases.flatMap(alias => fields.filter(f => fieldApplies(f, alias)).map(f => `${name.trim()}.${alias}.${f.name}`));
}

// Where a Goal heads in play (its Target unless it says)
export const headsOf = (d: GoalData): GoalHeads => d.heads ?? { kind: 'target' };

// A Goal's plan over its map as the worker takes it, or null while something it needs isn't there (see goalProblem)
export function goalPlan(doc: GraphDoc, node: GraphNode, maps?: MapLookup): PlanSpec | null {
  const h = node.data.kind === 'goal' ? headsOf(node.data) : null;
  if (h?.kind !== 'map') return null;
  const found = h.map ? maps?.(h.map) : null;
  if (!found) return null;
  const d = h.destination, wired = nameOf(byId(doc).get(into(doc, node.id, GOAL_DESTINATION)[0]?.source ?? ''));
  const destination = d.kind === 'place' ? (found.doc.places.some(p => p.id === d.place) ? d : null)
    : d.kind === 'input' ? (wired ? { kind: 'input' as const, name: wired } : null) : d.recording ? d : null;
  if (!destination) return null;
  const avoid = goalAvoid(doc, node, h.avoid ?? []);
  return { map: { ...compileMap(found.doc), id: h.map, name: found.name }, aheadS: h.aheadS, destination,
    ...(avoid?.length ? { avoid } : {}), ...(h.learn === false ? { learn: false as const } : {}) };
}

// Those inputs of the Spatial node wired into a Goal's Keep away from that are named
export function goalAvoid(doc: GraphDoc, node: GraphNode, aliases: string[]): PlanSpec['avoid'] | null {
  const spatial = byId(doc).get(into(doc, node.id, GOAL_AVOID)[0]?.source ?? '');
  const spec = spatial ? spatialSpec(doc, spatial) : null;
  if (!spec) return null;
  const on = new Set(aliases);
  return spec.sets.filter(s => on.has(s.alias)).map(s => ({ alias: s.alias, shapes: s.shapes, ...(s.read ? { read: s.read } : {}) }));
}

// What stops a Goal heading where it says in play, if anything
export function goalProblem(doc: GraphDoc, node: GraphNode, maps?: MapLookup): string | null {
  if (node.data.kind !== 'goal') return null;
  const h = headsOf(node.data), name = node.data.name.trim() || 'Its goal';
  if (h.kind === 'route') return h.recording ? null : `${name}: choose the recording whose route play follows`;
  if (h.kind !== 'map') return null;
  const found = h.map ? maps?.(h.map) : null;
  if (!h.map) return `${name}: choose the map play goes over`;
  if (!found) return `${name}: the map it goes over was deleted: choose another`;
  if (!found.doc.position.trim()) return `${name}: ${found.name} doesn’t say where the player is yet: open it and set its Position`;
  if (!found.doc.places.length && !found.doc.grid) return `${name}: ${found.name} has no places: add some, or have it learn a grid from your recordings`;
  const d = h.destination;
  if (d.kind === 'place' && !found.doc.places.some(p => p.id === d.place)) return `${name}: choose the place of ${found.name} play heads for`;
  if (d.kind === 'input' && !into(doc, node.id, GOAL_DESTINATION).length) return `${name}: wire a position into its Destination`;
  if (d.kind === 'end' && !d.recording) return `${name}: choose the recording whose end play heads for`;
  return null;
}

// A Goal node as the worker takes it, once a position is wired into it: its target a position, a map's way or a
// recording's route
export function goalSpec(doc: GraphDoc, node: GraphNode, maps?: MapLookup): GoalSpec | null {
  if (node.data.kind !== 'goal') return null;
  const nodes = byId(doc), from = (handle: string) => nameOf(nodes.get(into(doc, node.id, handle)[0]?.source ?? ''));
  const position = from(GOAL_POSITION), facing = from(GOAL_FACING), d = node.data, h = headsOf(d);
  const target = h.kind === 'target' ? from(GOAL_TARGET) : null;
  const route = h.kind === 'route' && h.recording ? { recording: h.recording, aheadS: h.aheadS } : null;
  const plan = goalPlan(doc, node, maps);
  return position ? { name: d.name.trim(), position, ...(facing ? { facing } : {}),
    ...(route ? { route } : plan ? { plan } : target ? { target } : {}), ...(d.hint && plan ? { hint: true as const } : {}),
    lookAhead: d.lookAhead, targets: d.targets, minMove: d.minMove } : null;
}

export function goalSpecs(doc: GraphDoc, maps?: MapLookup): GoalSpec[] {
  return doc.nodes.map(n => goalSpec(doc, n, maps)).filter((s): s is GoalSpec => !!s && !!s.name);
}

// Its columns, as worker/observations.py names them (goal_names): forward with facing, else dx; dy; how far
export const goalColumns = (name: string, facing: boolean) =>
  [`${name.trim()}.${facing ? 'forward' : 'dx'}`, `${name.trim()}.dy`, `${name.trim()}.dist`];

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
    if (node?.data.kind === 'spatial')  // its point and facing, such as formulas
      for (const e of [...into(doc, id, SPATIAL_POINT), ...into(doc, id, SPATIAL_FACING)]) stack.push(e.source);
    if (node?.data.kind === 'goal')  // its position, facing, target and destination, such as formulas
      for (const e of [...into(doc, id, GOAL_POSITION), ...into(doc, id, GOAL_FACING), ...into(doc, id, GOAL_TARGET), ...into(doc, id, GOAL_DESTINATION)])
        stack.push(e.source);
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
// it can train only on what all of them hold. `label` names an observation as the user knows it: the State reading
// it (“hp %” for bar level), for the problems
export function compilePolicy(doc: GraphDoc, policyId: string, fields: Map<string, string>,
    checks: Map<string, FormulaCheck>, holds: Map<string, Set<string>> = new Map(), label: (name: string) => string = n => n,
    maps?: MapLookup): Compiled {
  const L = (name: string | undefined) => name ? label(name) : '';
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
  const seen = new Set<string>(), grids: GridSpec[] = [], spatial: SpatialSpec[] = [];
  let goal: GoalSpec | undefined;
  for (const e of into(doc, policyId, 'values')) {
    const node = nodes.get(e.source), name = nameOf(node);
    if (!node || !name || seen.has(name)) continue;
    seen.add(name);
    if (node.data.kind === 'grid') {
      const spec = gridSpec(doc, node);
      if (!spec) problems.push(`Wire a shapes observation, such as platforms, into ${name}`);
      else if (fields.get(spec.shapes) !== 'shapes') problems.push(`${name}: ${L(spec.shapes)} isn\u2019t shapes`);
      else if (recorded && !recorded.has(spec.shapes)) problems.push(notRecorded(L(spec.shapes)));
      else if (spec.center && (fields.get(spec.center) ?? checks.get(spec.center)?.type) !== 'vector')
        problems.push(`${name} is centred on ${L(spec.center)}, which isn’t a position (a vector)`);
      else if (spec.center && recorded && fields.has(spec.center) && !checks.has(spec.center) && !recorded.has(spec.center))
        problems.push(notRecorded(L(spec.center)));
      else grids.push(spec);
      values.push({ nodeId: node.id, name, type: 'grid', columns: spec ? gridColumns(spec) : [] });
      continue;
    }
    if (node.data.kind === 'spatial') {
      const spec = spatialSpec(doc, node), typeOf = (n: string) => fields.get(n) ?? checks.get(n)?.type;
      const unwired = node.data.inputs.filter(a => !spec?.sets.some(s => s.alias === a));
      if (!spec) problems.push(`Wire a position into ${name}'s Point and shapes into it`);
      else if (unwired.length) problems.push(`Wire input${unwired.length > 1 ? 's' : ''} ${unwired.join(', ')} of ${name}`);
      else if (typeOf(spec.point) !== 'vector') problems.push(`${name}: its point, ${L(spec.point)}, isn’t a position (a vector)`);
      else if (spec.facing && typeOf(spec.facing) !== 'boolean') problems.push(`${name}: its facing, ${L(spec.facing)}, isn’t true or false`);
      else if (spec.sets.some(s => s.shapes.some(n => fields.get(n) !== 'shapes'))) problems.push(`${name}: wire shapes into its inputs`);
      else if (spec.bounds && !['shapes', 'object'].includes(fields.get(spec.bounds) ?? ''))
        problems.push(`${name}: its bounds, ${L(spec.bounds)}, aren’t a box (shapes, or a table such as {left, top, right, bottom})`);
      else {
        for (const n of [spec.point, spec.facing, ...spec.sets.flatMap(s => s.shapes)])
          if (n && recorded && fields.has(n) && !checks.has(n) && !recorded.has(n)) problems.push(notRecorded(L(n)));
        spatial.push(spec);
      }
      values.push({ nodeId: node.id, name, type: 'spatial',
        columns: spec ? spatialColumns(name, spec.sets.map(s => s.alias), spatialFields(node.data, !!spec.facing)) : [] });
      continue;
    }
    if (node.data.kind === 'goal') {
      const spec = goalSpec(doc, node, maps), typeOf = (n: string) => fields.get(n) ?? checks.get(n)?.type;
      if (goal) problems.push(`A policy has one goal: ${goal.name} and ${name} are both wired into it`);
      else if (!spec) problems.push(`Wire a position, such as the player’s, into ${name}'s Position`);
      else if (goalProblem(doc, node, maps)) problems.push(goalProblem(doc, node, maps)!);
      else if (spec.plan?.destination.kind === 'input' && typeOf(spec.plan.destination.name) !== 'vector')
        problems.push(`${name}: its destination, ${L(spec.plan.destination.name)}, isn’t a position (a vector)`);
      else if (spec.route && holds.size && !holds.has(spec.route.recording)) problems.push(`${name}: the recording whose route play follows was deleted: choose another`);
      else if (typeOf(spec.position) !== 'vector') problems.push(`${name}: its position, ${L(spec.position)}, isn’t a position (a vector)`);
      else if (spec.facing && typeOf(spec.facing) !== 'boolean') problems.push(`${name}: its facing, ${L(spec.facing)}, isn’t true or false`);
      else if (spec.target && typeOf(spec.target) !== 'vector') problems.push(`${name}: its target, ${L(spec.target)}, isn’t a position (a vector)`);
      else {
        for (const n of [spec.position, spec.facing, spec.target])
          if (n && recorded && fields.has(n) && !checks.has(n) && !recorded.has(n)) problems.push(notRecorded(L(n)));
        goal = spec;
      }
      values.push({ nodeId: node.id, name, type: 'goal', columns: goalColumns(name, !!spec?.facing) });
      continue;
    }
    if (node.data.kind === 'state') {
      const type = fields.get(name);
      const columns = columnsOf(name, type);
      if (!type) problems.push(`${L(name)}: its type isn’t known until FireFly observes it (start a capture session) or a recording holds it`);
      else if (!columns) problems.push(`${L(name)} is ${type}: use it through a formula`);
      else if (recorded && !recorded.has(name)) problems.push(notRecorded(L(name)));
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
      if (!made.has(input) && !recorded.has(input)) problems.push(notRecorded(L(input)));
  }
  const off = new Set(data.off);
  const columns = values.flatMap(v => v.columns).filter(c => !off.has(c));
  if (values.length && !columns.length && !problems.length) problems.push('Every value is left out: tick at least one');
  // A Goal or Spatial node measured from where the player faces (forward, ahead, behind) needs that facing among the
  // values: told only that the target is ahead, a policy can't know whether ahead is the left key or the right, and
  // pressed what it pressed most (a version without it walked left whatever its plan said)
  for (const [what, facing] of [[goal?.name, goal?.facing], ...spatial.map(sp => [sp.name, sp.facing])] as [string | undefined, string | undefined][])
    if (what && facing && !columns.includes(facing))
      problems.push(`${what} is measured from ${L(facing)} (ahead is the way it faces), which isn’t one of the values: wire ${L(facing)} into Values and tick it, or it can’t tell whether ahead is left or right`);
  if (data.buttons && !data.buttons.length) problems.push('Choose at least one button for it to learn');
  if (!data.name.trim()) problems.push('Name the policy');
  const request: PolicyRequest = {
    recordingIds, formulas, grids, spatial, ...(goal ? { goal } : {}), columns, buttons: data.buttons,
    ...(data.stepMs ? { stepMs: data.stepMs } : {}), history: data.history, actionDelayMs: data.delayMs,
    policy: { id: policyId, name: data.name.trim() },
  };
  return { request: problems.length ? null : request, values, problems: [...new Set(problems)] };
}

// Where play heads for a Policy node's versions, from the graph as it is now: the target, route or plan of the Goal
// wired into it (play sends it with the version it plays, which uses it in place of what it trained with), or null.
// A Goal that can't head where it says gives the reason ({error}): played without it, a version went where it
// trained to (the route of another level), as if the destination had been ignored
export function playGoal(doc: GraphDoc, policyId: string, maps?: MapLookup): Pick<GoalSpec, 'target' | 'route' | 'plan'> | { error: string } | null {
  const nodes = byId(doc);
  for (const e of into(doc, policyId, 'values')) {
    const node = nodes.get(e.source);
    if (node?.data.kind !== 'goal') continue;
    const problem = goalProblem(doc, node, maps);
    if (problem) return { error: problem };
    const spec = goalSpec(doc, node, maps);
    if (!spec) return null;
    const { target, route, plan } = spec;
    return target || route || plan ? { ...(target ? { target } : {}), ...(route ? { route } : {}), ...(plan ? { plan } : {}) } : null;
  }
  return null;
}

// What migrateGraph hands a Planner from before maps that planned on a grid, for the graph library to make a Map graph
// of (the places a Goal's plan goes over): the formulas for where the player is and on which level, the grid it
// learned (its place size and recordings), and the point it headed for, if one was clicked
export interface PlannerMap { name: string; position: string; level: string; cell: number; recordings: string[] | null; point: { x: number; y: number; level: string | null } | null; }
// What a node's value is as a map's formula (over observations, not the policy graph): a State's name, or a formula's
// own source with its inputs' names in place of their aliases
function formulaText(doc: GraphDoc, id: string | undefined): string {
  const node = id ? byId(doc).get(id) : undefined;
  if (!node) return '';
  if (node.data.kind === 'state') return quoted(node.data.name);
  if (node.data.kind !== 'formula') return '';
  let text = node.data.source;
  for (const alias of node.data.inputs) {
    const wired = formulaText(doc, into(doc, node.id, `in:${alias}`)[0]?.source);
    if (wired) text = text.replace(new RegExp(`(?<![\\w.\`])${alias}(?![\\w\`])`, 'g'), `(${wired})`);  // an alias is a plain name
  }
  return text;
}
const quoted = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '') + '`';

// A graph from before maps. A Goal that followed a recording's route (`route`, from before Planners) heads along it.
// A Planner wired into a Goal's Target becomes how the Goal heads: following a recording, or, planning on a grid, over
// a Map graph `makeMap` makes of it ({map id, place id of a clicked point}), its destination and the Spatial node it
// kept away from rewired into the Goal; without `makeMap` (a pasted graph) the Goal is left to choose a map. The
// Planner goes. Graphs without these come back as they are
export function migrateGraph(doc: GraphDoc, newId: () => string = () => crypto.randomUUID(),
    makeMap?: (planner: PlannerMap) => { map: string; place: string | null }): GraphDoc {
  const planners = doc.nodes.filter(n => (n.data as { kind: string }).kind === 'planner');
  const routed = doc.nodes.filter(n => n.data.kind === 'goal' && (n.data as GoalData).route);
  if (!planners.length && !routed.length) return doc;
  let edges = [...doc.edges];
  const nodes = doc.nodes.filter(n => !planners.includes(n)).map(node => {
    if (node.data.kind !== 'goal') return node;
    const { route, ...rest } = node.data as GoalData;
    let data: GoalData = route ? { ...rest, heads: { kind: 'route' as const, recording: route.recording ?? '', aheadS: route.aheadS ?? ROUTE_AHEAD_S } } : node.data;
    const planner = planners.find(p => into(doc, node.id, GOAL_TARGET).some(e => e.source === p.id));
    if (!planner) return { ...node, data };
    const p = planner.data as unknown as LegacyPlanner;
    edges = edges.filter(e => !(e.target === node.id && e.targetHandle === GOAL_TARGET));
    if (p.mode === 'route') return { ...node, data: { ...data, heads: { kind: 'route' as const, recording: p.route.recording, aheadS: p.route.aheadS } } };
    const plan = p.plan ?? { cell: 40, aheadS: ROUTE_AHEAD_S, destination: { kind: 'point' } };
    // its Data (else the policy's Recordings node), its level, and its destination and map, rewired into the Goal
    const policy = doc.edges.find(e => e.source === node.id && e.targetHandle === 'values')?.target;
    const data_ = byId(doc).get(into(doc, planner.id, 'in:@data')[0]?.source ?? '') ?? byId(doc).get(into(doc, policy ?? '', 'data')[0]?.source ?? '');
    const d = plan.destination;
    const made = makeMap?.({ name: `${p.name || node.data.name || 'Planner'} map`,
      position: formulaText(doc, into(doc, node.id, GOAL_POSITION)[0]?.source), level: formulaText(doc, into(doc, planner.id, 'in:@level')[0]?.source),
      cell: plan.cell, recordings: data_?.data.kind === 'recordings' && data_.data.ids.length ? data_.data.ids : null,
      point: d.kind === 'point' && d.x != null && d.y != null ? { x: d.x, y: d.y, level: d.level ?? null } : null });
    const destination: MapDestination = d.kind === 'end' ? { kind: 'end', recording: d.recording } : d.kind === 'input' ? { kind: 'input' } : { kind: 'place', place: made?.place ?? '' };
    for (const [from, to] of [['in:@destination', GOAL_DESTINATION], ['in:@map', GOAL_AVOID]])
      for (const e of into(doc, planner.id, from)) edges.push({ ...e, id: newId(), target: node.id, targetHandle: to });
    data = { ...data, heads: { kind: 'map', map: made?.map ?? '', destination, aheadS: plan.aheadS,
      ...(plan.avoid?.length ? { avoid: plan.avoid } : {}), ...(plan.learn === false ? { learn: false } : {}) } };
    return { ...node, data };
  });
  edges = edges.filter(e => !planners.some(p => e.source === p.id || e.target === p.id));
  return { ...doc, nodes, edges };
}

// Reading a saved graph: anything malformed falls back to an empty one
export function readGraph(text: string | null, makeMap?: (planner: PlannerMap) => { map: string; place: string | null }): GraphDoc {
  try {
    const doc = JSON.parse(text ?? 'null') as GraphDoc | null;
    if (doc?.version === 1 && Array.isArray(doc.nodes) && Array.isArray(doc.edges)) return migrateGraph(doc, undefined, makeMap);
  } catch { /* fall through */ }
  return emptyGraph();
}
