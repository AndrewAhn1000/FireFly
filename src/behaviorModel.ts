import type { Edge, Node } from '@xyflow/react';
import { compileMap, readMap, type CompiledMap } from './mapModel';

// A behaviour tree, built in the Graphs view (src/BehaviorTree.tsx) and run on every frame by the worker
// (worker/behavior.py, which says what each kind of node does). A node's children are the nodes wired below it, in
// order from left to right; a node has one parent. Pure, so it can be reasoned about apart from the editor.

export type BtKind = 'root' | 'sequence' | 'fallback' | 'repeat' | 'retry' | 'invert' | 'succeed' | 'limit' | 'while'
  | 'condition' | 'press' | 'hold' | 'wait' | 'walk' | 'clip' | 'set' | 'run' | 'go';
export type BtInputType = 'number' | 'boolean' | 'vector';
export interface BtInput { name: string; type: BtInputType; }
export interface BtData {
  kind: BtKind; label?: string;
  loop?: boolean;                  // root: start again when it ends
  inputs?: BtInput[];              // root: what a tree running this one gives it (Run tree, or a map's link)
  times?: number;                  // repeat (0: for ever), retry
  ms?: number;                     // limit, press, hold, wait, walk: how long (at most)
  formula?: string;                // condition, while, set
  until?: string;                  // hold, wait
  keys?: string[];                 // press, hold
  position?: string; target?: string; axis?: 'x' | 'y'; less?: string[]; more?: string[]; within?: number; // walk
  recording?: string; from?: number; to?: number; // clip: a stretch of a recording (capture ms)
  measure?: string; grounded?: string;            // clip: what its clips are measured by when finding them
  name?: string;                   // set: the variable
  tree?: string; args?: Record<string, string>; // run: the tree (a graph id), and a formula per input
  map?: string; place?: string;    // go: the map (a graph id), and the place (else `target`, a position formula)
  [key: string]: unknown;
}
export type BtNode = Node<BtData>;
export interface BtDoc { version: 1; kind: 'behavior'; nodes: BtNode[]; edges: Edge[]; }
export type BtGroup = 'Control' | 'Decorators' | 'Conditions' | 'Actions' | 'Trees and maps';

// Each kind: its name, glyph, where it's listed, how many children it takes (0, 1, or any number), what it does
// (shown on it and in the palette), and what a new one starts with
export const BT: Record<BtKind, { title: string; glyph: string; group: BtGroup | null; children: 0 | 1 | 'many'; help: string; defaults: Partial<BtData> }> = {
  root: { title: 'Root', glyph: '◉', group: null, children: 1, help: 'Where the tree starts, each frame', defaults: { loop: true } },
  sequence: { title: 'Sequence', glyph: '→', group: 'Control', children: 'many',
    help: 'Its children in order, left to right: fails as soon as one fails, succeeds once all have', defaults: {} },
  fallback: { title: 'Fallback', glyph: '?', group: 'Control', children: 'many',
    help: 'Its children in order until one succeeds: fails once all have failed', defaults: {} },
  repeat: { title: 'Repeat', glyph: '↻', group: 'Decorators', children: 1, help: 'Its child again each time it succeeds (0 times: for ever); fails if it fails', defaults: { times: 0 } },
  retry: { title: 'Retry', glyph: '⟲', group: 'Decorators', children: 1, help: 'Its child again each time it fails, up to so many tries', defaults: { times: 3 } },
  invert: { title: 'Invert', glyph: '¬', group: 'Decorators', children: 1, help: 'Success as failure, and failure as success', defaults: {} },
  succeed: { title: 'Always succeed', glyph: '✓', group: 'Decorators', children: 1, help: 'Its child, then success however it ended', defaults: {} },
  limit: { title: 'Time limit', glyph: '⏱', group: 'Decorators', children: 1, help: 'Fails if its child is still running after this long', defaults: { ms: 3000 } },
  while: { title: 'While', glyph: '⟳', group: 'Decorators', children: 1, help: 'Its child for as long as the formula is true: stops it and fails once it isn’t', defaults: { formula: '' } },
  condition: { title: 'Condition', glyph: '◇', group: 'Conditions', children: 0, help: 'Succeeds while the formula is true, fails while it isn’t (or something it reads isn’t there)', defaults: { formula: '' } },
  press: { title: 'Press', glyph: '⌨', group: 'Actions', children: 0, help: 'Keys pressed together for so long, to the millisecond', defaults: { keys: [], ms: 150 } },
  hold: { title: 'Hold', glyph: '▬', group: 'Actions', children: 0, help: 'Keys held until the formula is true (failing after the time), or for the time without one', defaults: { keys: [], until: '', ms: 2000 } },
  wait: { title: 'Wait', glyph: '…', group: 'Actions', children: 0, help: 'Nothing pressed until the formula is true (failing after the time), or for the time without one', defaults: { until: '', ms: 1000 } },
  walk: { title: 'Walk to', glyph: '⇥', group: 'Actions', children: 0, help: 'Holds the keys that way until the position is within so many px of the target', defaults: { position: '', target: '', axis: 'x', less: [], more: [], within: 8, ms: 5000 } },
  clip: { title: 'Play a clip', glyph: '▶', group: 'Actions', children: 0, help: 'The keys of a stretch of a recording, as you pressed them, to the millisecond', defaults: {} },
  set: { title: 'Remember', glyph: '≔', group: 'Actions', children: 0, help: 'A variable set to the formula’s value now, which formulas read by its name from then on', defaults: { name: '', formula: '' } },
  run: { title: 'Run tree', glyph: '⑂', group: 'Trees and maps', children: 0, help: 'Another behaviour tree, given its inputs: succeeds or fails as it does', defaults: { tree: '', args: {} } },
  go: { title: 'Go to', glyph: '⌖', group: 'Trees and maps', children: 0, help: 'To a place of a map, over its links: the quickest way, learned from how each went', defaults: { map: '', place: '', target: '' } },
};

export const emptyTree = (): BtDoc => ({ version: 1, kind: 'behavior', edges: [],
  nodes: [{ id: crypto.randomUUID(), type: 'bt', position: { x: 0, y: 0 }, data: { kind: 'root', loop: true } }] });

export function readTree(text: string | null): BtDoc {
  try {
    const d = JSON.parse(text ?? 'null');
    if (d?.version === 1 && Array.isArray(d.nodes) && Array.isArray(d.edges) && d.nodes.some((n: BtNode) => n.data?.kind === 'root'))
      return { version: 1, kind: 'behavior', nodes: d.nodes, edges: d.edges };
  } catch { /* a new one */ }
  return emptyTree();
}

// A node's children, left to right
export function childrenOf(doc: { nodes: BtNode[]; edges: Edge[] }, id: string): string[] {
  const x = new Map(doc.nodes.map(n => [n.id, n.position.x]));
  return doc.edges.filter(e => e.source === id && x.has(e.target)).map(e => e.target).sort((a, b) => x.get(a)! - x.get(b)!);
}

// Whether `source` can take `target` as a child: one that takes children, not the root, never making a loop
export function canConnect(doc: { nodes: BtNode[]; edges: Edge[] }, source: string, target: string): boolean {
  const s = doc.nodes.find(n => n.id === source), t = doc.nodes.find(n => n.id === target);
  if (!s || !t || source === target || BT[s.data.kind].children === 0 || t.data.kind === 'root') return false;
  // target mustn't be above source
  for (let at: string | undefined = source; at; at = doc.edges.find(e => e.target === at)?.source) if (at === target) return false;
  return true;
}

// The edges once source → target is wired: the target's old parent let go of it, and a node taking one child lets go
// of the one before
export function connect(doc: { nodes: BtNode[]; edges: Edge[] }, source: string, target: string): Edge[] {
  const s = doc.nodes.find(n => n.id === source)!;
  const kept = doc.edges.filter(e => e.target !== target && !(BT[s.data.kind].children === 1 && e.source === source));
  return [...kept, { id: crypto.randomUUID(), source, sourceHandle: 'children', target, targetHandle: 'parent', type: 'smoothstep' }];
}

export interface CompiledTree { root: string; nodes: Record<string, { kind: BtKind; params: Record<string, unknown>; children: string[] }>; }
// The tree as the worker runs it (only what's under the Root), and the nodes that aren't under it
export function compileTree(doc: { nodes: BtNode[]; edges: Edge[] }): { tree: CompiledTree | null; unreached: string[] } {
  const root = doc.nodes.find(n => n.data.kind === 'root');
  if (!root) return { tree: null, unreached: doc.nodes.map(n => n.id) };
  const nodes: CompiledTree['nodes'] = {}, stack = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (nodes[id]) continue;
    const n = doc.nodes.find(m => m.id === id)!;
    const { kind, ...params } = n.data;
    const children = childrenOf(doc, id);
    nodes[id] = { kind, params, children };
    stack.push(...children);
  }
  return { tree: { root: root.id, nodes }, unreached: doc.nodes.filter(n => !nodes[n.id]).map(n => n.id) };
}

// A formula's name for an observation: as it is when it's one word, else in backticks
export const quoted = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '') + '`';

// A tree's inputs, as its Root says (what Run tree nodes and maps' links give it)
export const inputsOf = (doc: BtDoc): BtInput[] => doc.nodes.find(n => n.data.kind === 'root')?.data.inputs ?? [];

// Everything a tree needs to run: itself, the trees its Run tree nodes run, and the maps its Go to nodes go over with
// the trees their links run, read by graph id (`read`: its saved document, null when gone; a gone one the worker
// says so of on the node). Loops are the worker's to find.
export function compileBundle(doc: { nodes: BtNode[]; edges: Edge[] }, read: (id: string) => string | null) {
  const first = compileTree(doc);
  const trees: Record<string, CompiledTree> = {}, maps: Record<string, CompiledMap> = {};
  const queue: ['tree' | 'map', string][] = [];
  const visit = (t: CompiledTree | null) => {
    for (const n of Object.values(t?.nodes ?? {})) {
      if (n.kind === 'run' && typeof n.params.tree === 'string' && n.params.tree) queue.push(['tree', n.params.tree]);
      if (n.kind === 'go' && typeof n.params.map === 'string' && n.params.map) queue.push(['map', n.params.map]);
    }
  };
  visit(first.tree);
  while (queue.length) {
    const [kind, id] = queue.shift()!;
    if (kind === 'tree' ? trees[id] : maps[id]) continue;
    const text = read(id);
    if (text == null) continue;
    if (kind === 'tree') {
      const compiled = compileTree(readTree(text)).tree;
      if (!compiled) continue;
      trees[id] = compiled;
      visit(compiled);
    } else {
      const map = compileMap(readMap(text));
      maps[id] = map;
      for (const l of map.links) if ('tree' in l && l.tree) queue.push(['tree', l.tree]);
      if (map.approach?.tree) queue.push(['tree', map.approach.tree]);
    }
  }
  return { ...first, trees, maps };
}
