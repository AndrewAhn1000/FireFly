// A map, built in the Graphs view (src/MapGraph.tsx): places where the player can be, and links between them, each how
// to get from one to the other (a clip of a recording, a behaviour tree given `from` and `to`, or keys held until the
// player is there), and, if it says, places and moves learned on a grid from recordings. It's the one place that knows
// how to get around: a behaviour tree's Go to node goes over it (worker/behavior.py's MapRun), and a policy's Goal
// heads along it (worker/planner.py), each learning how its links go. Nothing in it is about one game: where the player
// is and on which level are your own formulas. Pure but for mapLookup, which reads the graph library.

export interface MapPlace { id: string; name: string; level: string | null; x: number; y: number; }
export interface MapClip { recording: string; from: number; to: number; }
export interface MapLink {
  id: string; from: string; to: string; kind: 'clip' | 'tree' | 'keys';
  clip?: MapClip;                    // clip: a stretch of a recording, played as it was pressed
  tree?: string; args?: Record<string, string>; // tree: a behaviour tree, given from and to, and its other inputs' formulas
  keys?: string[];                   // held until arrival; empty releases inputs and waits
}
export interface MapDoc {
  version: 1; kind: 'map';
  position: string;                  // a formula: where the player is (a vector), such as a position State
  level: string;                     // optional: which level the player is on (any value), places kept per level
  grounded: string;                  // optional: true while on the ground, only for finding stands in recordings
  draw: string[];                    // shapes States drawn under the map
  reach: number;                     // px: at a place within this of it
  giveUp: number;                    // a link failing this many times in a run isn't tried again in it
  linkMs: number;                    // a link not done in this long has failed
  arriveMs: number;                  // after a link's keys, how long to be at its place
  approach: { tree: string; args: Record<string, string> } | null; // off every place: a tree taking it to the nearest, given `to`
  // places and moves learned from recordings (worker/planner.py's learn): cells `cell` px a side where the player went,
  // and each move made from one to the next with the keys held, beside your own (`recordings` null: every one)
  grid: { cell: number; recordings: string[] | null; execution?: 'sequences' | 'keys'; replay?: ReplayDoc } | null;
  places: MapPlace[]; links: MapLink[];
  recording?: string;                // the recording the map is drawn over, without a session
  view?: { x: number; y: number; scale: number };
}

export const MAP_DEFAULTS = { reach: 24, giveUp: 3, linkMs: 10000, arriveMs: 1500 };

// How recorded movements are replayed (worker/behavior.py's replay_settings): how near their recorded start a replay
// starts, how near the recorded end counts as there, how long the player must stand still at either, and lining up
// with a start by tapping, with the keys that move the player each way along x (and y, if set). Nothing here is
// about a game: what one needs is read off its runs (the map's Runs)
export interface LineUpKeys { less: string[]; more: string[]; }
export interface ReplayDoc {
  startPx?: number; arrivePx?: number; stillMs?: number;
  // a true/false formula (such as On Ground): presses that came up to syncWindowMs after it turned true in a recording
  // wait for it to turn true again in play, instead of for the clock
  sync?: string; syncWindowMs?: number;
  // jumps (worker/platformer.py): timed as recorded (the baseline), or each simple jump pressed where it's safe to, by
  // a platformer model measured from the recordings over `ground`, a shapes State whose lines the player stands on
  takeoff?: 'timed' | 'adaptive'; ground?: string;
  lineUp?: { x?: LineUpKeys; y?: LineUpKeys; tapMs?: number; tries?: number; range?: number } | null;
}
export const REPLAY_DEFAULTS = { startPx: 6, arrivePx: 6, stillMs: 80, tapMs: 40, tries: 8, range: 48, syncWindowMs: 300 };

export const GRID_CELL = 40; // px, a learned place's side unless the map says otherwise
export const emptyMap = (): MapDoc => ({ version: 1, kind: 'map', position: '', level: '', grounded: '', draw: [], ...MAP_DEFAULTS,
  approach: null, grid: null, places: [], links: [] });

export function readMap(text: string | null): MapDoc {
  try {
    const d = JSON.parse(text ?? 'null');
    if (d?.version === 1 && d.kind === 'map' && Array.isArray(d.places) && Array.isArray(d.links)) return { ...emptyMap(), ...d };
  } catch { /* a new one */ }
  return emptyMap();
}

// The map as the worker goes over it
export function compileMap(doc: MapDoc) {
  return { position: doc.position, level: doc.level, grounded: doc.grounded, reach: doc.reach, giveUp: doc.giveUp, linkMs: doc.linkMs, arriveMs: doc.arriveMs,
    approach: doc.approach?.tree ? doc.approach : null, grid: doc.grid ?? null,
    places: doc.places.map(p => ({ id: p.id, name: p.name, level: p.level, x: p.x, y: p.y })),
    links: doc.links.map(l => ({ id: l.id, from: l.from, to: l.to, kind: l.kind, ...(l.kind === 'clip' ? { clip: l.clip ?? null }
      : l.kind === 'keys' ? { keys: l.keys ?? [] } : { tree: l.tree ?? '', args: l.args ?? {} }) })) };
}
export type CompiledMap = ReturnType<typeof compileMap>;

// A new place's name: the next of Place 1, Place 2… not taken
export function placeName(doc: MapDoc): string {
  const taken = new Set(doc.places.map(p => p.name));
  for (let k = doc.places.length + 1; ; k++) if (!taken.has(`Place ${k}`)) return `Place ${k}`;
}

// What's wrong with a map, as the Go to nodes going over it would be told: its position, and links with nothing to do
export function mapProblems(doc: MapDoc, treeExists: (id: string) => boolean): string[] {
  const out: string[] = [];
  if (!doc.position.trim()) out.push('Say where the player is: a position State or formula');
  const name = (id: string) => doc.places.find(p => p.id === id)?.name ?? 'a place';
  for (const l of doc.links) {
    if (l.kind === 'clip' && !l.clip) out.push(`The link from ${name(l.from)} to ${name(l.to)} has no clip`);
    if (l.kind === 'tree' && (!l.tree || !treeExists(l.tree))) out.push(`The link from ${name(l.from)} to ${name(l.to)} has no tree`);
  }
  if (doc.approach?.tree && !treeExists(doc.approach.tree)) out.push('Its approach tree is gone');
  return out;
}

// What the worker says about a place on the frame: the player's position and level by the map's formulas, and the
// shapes drawn under it
export interface MapFrame { position: [number, number] | null; level: string | null; shapes: Record<string, [number, number][][]>; errors: Record<string, string>; }
// Links and places suggested from recordings (the worker's map.suggest)
export interface Suggested {
  links: { from: string; to: string; count: number; ms: number; clip: MapClip }[];
  places: { level: string | null; x: number; y: number; n: number }[];
}
// What a map's links did (the worker's map.stats)
export type LinkStats = Record<string, { runs: number; fails: number; ms?: number }>;
// What a map learned on its grid (the worker's map.grid): places [level, x, y, n], moves [from, to, ms, n, keys]
export interface LearnedGrid { places: [string | null, number, number, number][]; moves: [number, number, number, number, string[]][]; count?: { places: number; moves: number }; recordings: number; execution?: 'sequences' | 'keys'; notes?: string[]; linkIds?: string[];
  // each recorded movement's path ([x, y], thinned), beside its move, for drawing
  paths?: [number, number][][];
  // where a failed movement could be resumed (worker/platformer.py's checkpoints): [level, x, y, kind, resumable, why]
  checkpoints?: [string | null, number, number, 'stable' | 'dynamic', boolean, string | null][];
  // recorded movements that wait for the map's Wait for State somewhere, and their waits in all
  synced?: number; waits?: number;
  // its recorded jumps measured by the platformer model (with a ground State): the model, how many jumps of each kind,
  // how many movements are unsafe, and which of the drawn ones
  takeoff?: TakeoffModel; unsafe?: boolean[]; }
export interface TakeoffModel {
  error?: string; unsafe?: number; counts?: Partial<Record<'adapt' | 'unsafe' | 'narrow' | 'position' | 'walkoff' | 'timed', number>>;
  // how recorded movements end after their last landing (platformer.finish): correctable there, or kept as recorded
  finishes?: Partial<Record<'correct' | 'kept', number>>;
  // its recovery checkpoints by kind ('stable', 'dynamic', and either with ' (not resumable)')
  checkpoints?: Record<string, number>;
  model?: { walk: number; jump: number; gravity: number; fall: number | null; jumpKey: string; leftKey: string | null; rightKey: string | null;
    delays: number[]; leaveMs: number; jumps: number; rms: { p50: number; p90: number } };
}
// The maps of a graph library, by graph id, as a Goal reads them (graphModel's MapLookup): their saved documents and names
export function mapLookup(scope: string) {
  let names: Map<string, string> | null = null;
  return (id: string): { doc: MapDoc; name: string } | null => {
    try {
      if (!names) {
        const library = JSON.parse(localStorage.getItem(`${scope}-library`) ?? 'null') as { entries?: { id: string; name: string; kind: string }[] } | null;
        names = new Map((library?.entries ?? []).filter(e => e.kind === 'map').map(e => [e.id, e.name]));
      }
      const text = names.has(id) ? localStorage.getItem(`${scope}-document-${id}`) : null;
      return text == null ? null : { doc: readMap(text), name: names.get(id)! };
    } catch { return null; }
  };
}
// A map as a tree going over it says it is, each frame
export interface MapLive { at: string | null; dest: string | null; way: string[] | null; link: string | null; fails: Record<string, number>; text: string; last?: string; }
