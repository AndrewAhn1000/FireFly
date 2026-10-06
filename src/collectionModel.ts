import type { Node, Edge } from '@xyflow/react';
import { NEW_INPUT } from './formulaInputs';

export type CollectionKind = 'state' | 'condition' | 'logic' | 'formula' | 'trigger' | 'capture' | 'format' | 'output' | 'table';
export interface CollectionData extends Record<string, unknown> {
  kind: CollectionKind; name: string;
  operator?: string; value?: string; upper?: string;
  source?: string; inputs?: string[];
  mode?: string; initial?: boolean; holdMs?: number; intervalMs?: number; cooldownMs?: number;
  area?: string; crop?: { x: number; y: number; w: number; h: number }; regionId?: string;
  format?: string; quality?: number; width?: number; height?: number;
  directory?: string; pattern?: string; metadata?: string; fields?: string[]; labels?: string;
  valSplit?: number;
  formatType?: string;
  classes?: Record<string, string>;
  match?: Record<string, TableMatch>; // a table: how each column is compared with the rows kept
}
// Same value: compare only with rows holding this value. Any new item: new while it holds an item those rows didn't.
// Any value: kept with the row, but any value matches (saved as 'store', its earlier name).
export type TableMatch = 'same' | 'any' | 'store';
export type CollectionNode = Node<CollectionData>;
export interface CollectionDoc { version: 1; nodes: CollectionNode[]; edges: Edge[]; maxAgeMs?: number; }
export interface CollectionStatus {
  graphId: string; scope: string; name: string; running: boolean; test: boolean;
  saved: number; fired: number; skipped: number; error: string;
  values: Record<string, unknown>; issues: Record<string, string>;
  recent: { path?: string; trigger: string; timestamp: number; test?: boolean }[];
}
// What a Table node has kept: a row of its values for every screenshot it let through
export interface TableRow { key: string; columns: Record<string, unknown>; savedAt: string; image?: string; }
// A page of them: total rows matching the filter, all rows in the table, and every column any row has
export interface TableRows { total: number; all: number; columns: string[]; rows: TableRow[]; }
export interface CaptureRegion { id: string; label: string; x: number; y: number; w: number; h: number; }
export const collectionDefaults = (kind: CollectionKind, name?: string): CollectionData => {
  const base = { kind, name: name ?? ({ state: 'State', condition: 'Condition', logic: 'All conditions', formula: 'Formula', trigger: 'Trigger', capture: 'Capture image', format: 'Format Dataset', output: 'Dataset Output', table: 'Seen' }[kind]) };
  if (kind === 'condition') return { ...base, operator: 'true', value: '0', upper: '100' };
  if (kind === 'logic') return { ...base, operator: 'all', inputs: [] };
  if (kind === 'formula') return { ...base, source: 'true', inputs: [] };
  if (kind === 'trigger') return { ...base, mode: 'rise', initial: false, holdMs: 0, intervalMs: 2000, cooldownMs: 1000 };
  if (kind === 'capture') return { ...base, area: 'window', format: 'png', quality: 95, width: 0, height: 0 };
  if (kind === 'format') return { ...base, formatType: 'yolo', valSplit: 20, inputs: [], classes: {} };
  if (kind === 'table') return { ...base, inputs: [], match: {} };
  if (kind === 'output') return { ...base, directory: '', pattern: '{session}/{trigger}/{sequence}', metadata: 'json', fields: [], labels: '{}', valSplit: 20 };
  return base;
};
export const emptyCollection = (): CollectionDoc => {
  const doc: CollectionDoc = { version: 1, maxAgeMs: 250, nodes: [
  { id: crypto.randomUUID(), type: 'collection', position: { x: 40, y: 80 }, data: collectionDefaults('trigger') },
  { id: crypto.randomUUID(), type: 'collection', position: { x: 330, y: 80 }, data: collectionDefaults('capture') },
  { id: crypto.randomUUID(), type: 'collection', position: { x: 620, y: 80 }, data: collectionDefaults('output') },
  ], edges: [] };
  doc.edges = [[0, 1], [1, 2]].map(([a, b]) => ({ id: crypto.randomUUID(), source: doc.nodes[a].id, target: doc.nodes[b].id, sourceHandle: 'out', targetHandle: 'in' }));
  return doc;
};
// A Logic node's inputs: the ones wired into it (graphs from before wired inputs had a and b), only the first for Not
export function logicInputs(d: CollectionData): string[] {
  const inputs = d.inputs ?? ['a', 'b'];
  return d.operator === 'not' ? inputs.slice(0, 1) : inputs;
}
// A name for a Logic node's next input, which nobody sees: a, b, c…
export function nextLogicInput(taken: string[]): string {
  for (let i = 0; ; i++) {
    const name = i < 26 ? String.fromCharCode(97 + i) : `in${i}`;
    if (!taken.includes(name)) return name;
  }
}
export function collectionInputs(d: CollectionData): string[] {
  return d.kind === 'state' ? [] :
    d.kind === 'formula' ? d.inputs ?? [] :
    d.kind === 'table' ? d.inputs ?? [] :
    d.kind === 'format' ? ['image', ...(d.inputs ?? [])] :
    d.kind === 'logic' ? logicInputs(d) :
    ['in'];
}
// A graph saved while Tables sat in the image path (Capture → Table → Output) or had a Keep if input:
// their image wires join what fed the Table straight to what it fed, and the Keep if wires go
export function migrateTables(doc: CollectionDoc): CollectionDoc {
  const tables = new Set(doc.nodes.filter(n => n.data.kind === 'table').map(n => n.id));
  const imageInto = (id: string, seen = new Set<string>()): string | undefined => {
    const source = doc.edges.find(e => e.target === id && e.targetHandle === 'image')?.source;
    return source && tables.has(source) && !seen.has(source) ? imageInto(source, seen.add(source)) : source;
  };
  const edges = doc.edges.flatMap(e => {
    if (tables.has(e.target) && (e.targetHandle === 'image' || e.targetHandle === 'keep')) return [];
    const target = doc.nodes.find(n => n.id === e.target)?.data.kind;
    if (!tables.has(e.source) || !(target === 'output' || (target === 'format' && e.targetHandle === 'image'))) return [e];
    const source = imageInto(e.source);
    return source ? [{ ...e, id: `${e.id}-moved`, source }] : [];
  });
  return edges.length === doc.edges.length && edges.every((e, i) => e === doc.edges[i]) ? doc : { ...doc, edges };
}
export function canConnectCollection(nodes: CollectionNode[], edges: Edge[], source: string, target: string, handle: string): boolean {
  const from = nodes.find(n => n.id === source), to = nodes.find(n => n.id === target);
  if (!from || !to || source === target) return false;
  const isNew = (to.data.kind === 'formula' || to.data.kind === 'format' || to.data.kind === 'table' ||
    (to.data.kind === 'logic' && !(to.data.operator === 'not' && logicInputs(to.data).length > 0))) && handle === NEW_INPUT;
  if (!isNew && !collectionInputs(to.data).includes(handle)) return false;
  const allowed =
    to.data.kind === 'capture' ? ['trigger'] :
    to.data.kind === 'format' ? (handle === 'image' ? ['capture'] : ['state', 'formula']) :
    to.data.kind === 'table' ? ['state', 'formula'] :
    to.data.kind === 'output' ? ['capture', 'format'] :
    ['state', 'condition', 'logic', 'formula', 'table'];
  if (!allowed.includes(from.data.kind)) return false;
  const seen = new Set<string>();
  const reaches = (id: string): boolean => { if (id === source) return true; if (seen.has(id)) return false; seen.add(id); return edges.filter(e => e.source === id).some(e => reaches(e.target)); };
  return !reaches(target);
}
