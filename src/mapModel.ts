// A map, built in the Graphs view (src/MapGraph.tsx) and gone over by a behaviour tree's Go to nodes
// (worker/behavior.py's MapRun): places where the player can be, and links between them, each how to get from one to
// the other (a clip of a recording, or a behaviour tree given `from` and `to`). Nothing in it is about one game: where
// the player is and on which level are your own formulas. Pure, so it can be reasoned about apart from the editor.

export interface MapPlace { id: string; name: string; level: string | null; x: number; y: number; }
export interface MapClip { recording: string; from: number; to: number; }
export interface MapLink {
  id: string; from: string; to: string; kind: 'clip' | 'tree';
  clip?: MapClip;                    // clip: a stretch of a recording, played as it was pressed
  tree?: string; args?: Record<string, string>; // tree: a behaviour tree, given from and to, and its other inputs' formulas
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
  places: MapPlace[]; links: MapLink[];
  recording?: string;                // the recording the map is drawn over, without a session
  view?: { x: number; y: number; scale: number };
}

export const MAP_DEFAULTS = { reach: 24, giveUp: 3, linkMs: 10000, arriveMs: 1500 };

export const emptyMap = (): MapDoc => ({ version: 1, kind: 'map', position: '', level: '', grounded: '', draw: [], ...MAP_DEFAULTS,
  approach: null, places: [], links: [] });

export function readMap(text: string | null): MapDoc {
  try {
    const d = JSON.parse(text ?? 'null');
    if (d?.version === 1 && d.kind === 'map' && Array.isArray(d.places) && Array.isArray(d.links)) return { ...emptyMap(), ...d };
  } catch { /* a new one */ }
  return emptyMap();
}

// The map as the worker goes over it
export function compileMap(doc: MapDoc) {
  return { position: doc.position, level: doc.level, reach: doc.reach, giveUp: doc.giveUp, linkMs: doc.linkMs, arriveMs: doc.arriveMs,
    approach: doc.approach?.tree ? doc.approach : null,
    places: doc.places.map(p => ({ id: p.id, name: p.name, level: p.level, x: p.x, y: p.y })),
    links: doc.links.map(l => ({ id: l.id, from: l.from, to: l.to, kind: l.kind, ...(l.kind === 'clip' ? { clip: l.clip ?? null } : { tree: l.tree ?? '', args: l.args ?? {} }) })) };
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
// A map as a tree going over it says it is, each frame
export interface MapLive { at: string | null; dest: string | null; way: string[] | null; link: string | null; fails: Record<string, number>; text: string; last?: string; }
