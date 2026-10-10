// A window's setup is saved under its title (App.tsx Persistence; the Graphs' library in GraphLibrary.tsx), so
// another window of the same game, titled differently, starts with none. These find the windows that have
// one, and copy one's setup to another, in place of what that one had.

export type SetupPart = 'states' | 'graphs' | 'recording';
export const SETUP_PARTS: { id: SetupPart; label: string; hint: string }[] = [
  { id: 'states', label: 'States and Regions', hint: 'Every State and its folders, and every Region with its templates and Lua script. They go together: a State can read a Region.' },
  { id: 'graphs', label: 'Graphs', hint: 'The policy and data collection graphs, as they were laid out.' },
  { id: 'recording', label: 'Recording setup', hint: 'The buttons recorded, how often, and which observations go into recordings.' },
];

interface Store { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

const enc = encodeURIComponent;
// The keys each part is saved under, for a window's title
const keysOf = (title: string): Record<'states' | 'recording', string[]> => ({
  states: [`firefly-states-${enc(title)}`, `firefly-state-folders-${enc(title)}`, `firefly-regions-${enc(title)}`],
  recording: [`firefly-record-setup-${enc(title)}`, `firefly-recorded-${enc(title)}`],
});
export const graphScope = (title: string) => `firefly-policy-graph-${enc(title)}`;

// The Graphs' keys: the library, each graph in it and its view, and the single graph from before there was a
// library. Found from the library rather than by prefix: one title's keys can begin with another's.
function graphKeys(store: Store, title: string): string[] {
  const scope = graphScope(title), keys = [scope, `${scope}-view`, `${scope}-library`];
  try {
    const library = JSON.parse(store.getItem(`${scope}-library`) ?? 'null') as { entries?: { id: string }[] } | null;
    for (const e of library?.entries ?? []) keys.push(`${scope}-document-${e.id}`, `${scope}-document-${e.id}-view`);
  } catch { /* no library */ }
  return keys;
}

const count = (store: Store, key: string) => {
  try { const v = JSON.parse(store.getItem(key) ?? '[]'); return Array.isArray(v) ? v.length : 0; } catch { return 0; }
};

export interface SavedSetup { title: string; states: number; regions: number; graphs: number }

// What a window has saved: its States, Regions and graphs (folders hold nothing on their own)
export function setupOf(store: Store, title: string): SavedSetup {
  let graphs = 0;
  try {
    const library = JSON.parse(store.getItem(`${graphScope(title)}-library`) ?? 'null') as { entries?: { kind: string }[] } | null;
    graphs = (library?.entries ?? []).filter(e => e.kind !== 'folder').length;
  } catch { /* none */ }
  return { title, states: count(store, `firefly-states-${enc(title)}`), regions: count(store, `firefly-regions-${enc(title)}`), graphs };
}

// Every window with States or Regions saved, but `except`, most first. Graphs alone don't count: every window
// opened gets an empty one.
export function savedSetups(store: Store, except?: string | null): SavedSetup[] {
  const titles = new Set<string>();
  for (let i = 0; i < store.length; i++) {
    const m = /^firefly-(?:states|regions)-(.*)$/.exec(store.key(i) ?? '');
    if (!m) continue;
    try { titles.add(decodeURIComponent(m[1])); } catch { /* not a title */ }
  }
  titles.delete(except ?? '');
  return [...titles].map(t => setupOf(store, t)).filter(s => s.states + s.regions > 0)
    .sort((a, b) => b.states + b.regions - (a.states + a.regions) || a.title.localeCompare(b.title));
}

// Copies `from`'s setup to `to`, in place of what `to` had for those parts. Graphs keep their ids, so a
// window's graphs and the policies trained from them stay one another's.
export function copySetup(store: Store, from: string, to: string, parts: SetupPart[]) {
  if (from === to) return;
  for (const part of parts) {
    if (part === 'graphs') {
      for (const key of graphKeys(store, to)) store.removeItem(key);
      const toScope = graphScope(to), fromScope = graphScope(from);
      for (const key of graphKeys(store, from)) {
        const value = store.getItem(key);
        if (value !== null) store.setItem(toScope + key.slice(fromScope.length), value);
      }
      continue;
    }
    const source = keysOf(from)[part], target = keysOf(to)[part];
    source.forEach((key, i) => {
      const value = store.getItem(key);
      if (value === null) store.removeItem(target[i]); else store.setItem(target[i], value);
    });
  }
}
