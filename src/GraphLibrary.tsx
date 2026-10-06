import { useEffect, useState } from 'react';
import PolicyGraph, { type PolicyGraphProps } from './PolicyGraph';
import CollectionGraph from './CollectionGraph';
import { emptyGraph } from './graphModel';
import { emptyCollection, type CaptureRegion, type CollectionStatus } from './collectionModel';

type Kind = 'folder' | 'policy' | 'collection';
interface Entry { id: string; parent: string | null; name: string; kind: Kind; collapsed?: boolean; }
interface Library { version: 1; entries: Entry[]; selected: string; }
interface Props extends PolicyGraphProps { regions: CaptureRegion[]; }
const documentKey = (scope: string, id: string) => `${scope}-document-${id}`;
function newPolicy() {
  const doc = emptyGraph(), ids = new Map(doc.nodes.map(n => [n.id, crypto.randomUUID()]));
  return { ...doc, nodes: doc.nodes.map(n => ({ ...n, id: ids.get(n.id)! })), edges: doc.edges.map(e => ({ ...e, source: ids.get(e.source)!, target: ids.get(e.target)! })) };
}
function readLibrary(scope: string): Library {
  const saved = localStorage.getItem(scope + '-library');
  if (saved) {
    const doc = JSON.parse(saved);
    if (doc.version !== 1 || !Array.isArray(doc.entries)) throw Error('Unsupported graph library');
    return doc;
  }
  const id = crypto.randomUUID();
  const legacy = localStorage.getItem(scope);
  localStorage.setItem(documentKey(scope, id), legacy ?? JSON.stringify(newPolicy()));
  const library: Library = { version: 1, entries: [{ id: 'policies', parent: null, kind: 'folder', name: 'Policies' }, { id: 'collection', parent: null, kind: 'folder', name: 'Data Collection' }, { id, parent: 'policies', name: 'Policy graph', kind: 'policy' }], selected: id };
  localStorage.setItem(scope + '-library', JSON.stringify(library));
  return library;
}

export default function GraphLibrary(props: Props) {
  const [statuses, setStatuses] = useState<CollectionStatus[]>([]);
  const [play, setPlay] = useState<{ playing: boolean; graphId?: string }>({ playing: false });
  useEffect(() => {
    void window.bridge.collection.status().then(setStatuses).catch(() => {});
    const a = window.bridge.on('collection:status', s => setStatuses(s as CollectionStatus[]));
    const b = window.bridge.on('play:status', s => setPlay(s as typeof play));
    return () => { a(); b(); };
  }, []);
  const running = statuses.filter(s => s.running);
  return <>
    {(running.length > 0 || play.playing) && <div className="graph-activity" aria-label="Active graphs">
      {play.playing && <span>● Policy playing <button onClick={() => void window.bridge.policy.stop()}>Stop policy</button></span>}
      {running.map(s => <span key={s.graphId}>● {s.name} · {s.test ? `${s.fired} test events` : `${s.saved} images`} <button onClick={() => void window.bridge.collection.stop(s.graphId)}>Stop</button></span>)}
    </div>}
    <LibraryEditor key={props.storageKey} {...props} statuses={statuses} playingId={play.playing ? play.graphId : undefined} />
  </>;
}

function LibraryEditor(props: Props & { statuses: CollectionStatus[]; playingId?: string }) {
  const [library, setLibrary] = useState<Library>(() => readLibrary(props.storageKey));
  const [opened, setOpened] = useState<string[]>([]);
  useEffect(() => {
    if (props.active && library.selected) setOpened(ids => ids.includes(library.selected) ? ids : [...ids, library.selected]);
  }, [props.active, library.selected]);
  const [query, setQuery] = useState(''), [error, setError] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ action: 'create' | 'rename' | 'move' | 'delete'; kind: Kind; id?: string; name: string; parent: string | null } | null>(null);
  const selected = library.entries.find(e => e.id === library.selected);
  const save = (next: Library) => {
    try { localStorage.setItem(props.storageKey + '-library', JSON.stringify(next)); setLibrary(next); setError(''); }
    catch { setError('Could not save the graph directory. Local storage may be full.'); }
  };
  const childrenOf = (id: string): string[] => [id, ...library.entries.filter(e => e.parent === id).flatMap(e => childrenOf(e.id))];
  const isRunning = (id: string) => props.playingId === id || props.statuses.some(s => s.graphId === id && s.running);
  const select = (entry: Entry) => {
    if (entry.kind === 'folder') save({ ...library, entries: library.entries.map(e => e.id === entry.id ? { ...e, collapsed: !e.collapsed } : e) });
    else { save({ ...library, selected: entry.id }); setOpened(ids => ids.includes(entry.id) ? ids : [...ids, entry.id]); }
  };
  const parent = selected?.kind === 'folder' ? selected.id : selected?.parent ?? null;
  const create = (kind: Kind, folder = parent) => { setMenu(null); setDialog({ action: 'create', kind, name: kind === 'folder' ? 'New folder' : kind === 'policy' ? 'New policy' : 'New collection', parent: folder }); };
  const manage = (action: 'rename' | 'move' | 'delete', entry: Entry) => { setMenu(null); setDialog({ action, kind: entry.kind, id: entry.id, name: entry.name, parent: entry.parent }); };
  const duplicate = (entry: Entry) => {
    setMenu(null);
    try {
      const id = crypto.randomUUID(), key = documentKey(props.storageKey, entry.id);
      const doc = JSON.parse(localStorage.getItem(key) ?? '{}');
      const ids = new Map<string, string>();
      for (const node of doc.nodes ?? []) ids.set(node.id, crypto.randomUUID());
      doc.nodes = doc.nodes.map((n: { id: string }) => ({ ...n, id: ids.get(n.id) }));
      doc.edges = doc.edges.map((e: { source: string; target: string }) => ({ ...e, id: crypto.randomUUID(), source: ids.get(e.source), target: ids.get(e.target) }));
      localStorage.setItem(documentKey(props.storageKey, id), JSON.stringify(doc));
      save({ ...library, selected: id, entries: [...library.entries, { ...entry, id, name: entry.name + ' copy' }] }); setOpened(o => [...o, id]);
    } catch (e) { setError(String(e)); }
  };
  const exportGraph = (entry: Entry) => {
    const doc = localStorage.getItem(documentKey(props.storageKey, entry.id));
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ kind: entry.kind, name: entry.name, graph: JSON.parse(doc) }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = entry.name.replace(/[<>:"/\\|?*]/g, '_') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMenu(null);
  };
  const submit = () => {
    if (!dialog || !dialog.name.trim()) return;
    const d = dialog;
    try {
      if (d.action === 'create') {
        const id = crypto.randomUUID();
        if (d.kind !== 'folder') localStorage.setItem(documentKey(props.storageKey, id), JSON.stringify(d.kind === 'policy' ? newPolicy() : emptyCollection()));
        save({ ...library, selected: d.kind === 'folder' ? library.selected : id, entries: [...library.entries.map(e => e.id === d.parent ? { ...e, collapsed: false } : e), { id, parent: d.parent, name: d.name.trim(), kind: d.kind }] });
        if (d.kind !== 'folder') setOpened(ids => [...ids, id]);
      } else if (d.action === 'delete') {
        const remove = childrenOf(d.id!);
        if (remove.some(isRunning)) { setError('Stop the running graphs in this folder before deleting it.'); return; }
        const entries = library.entries.filter(e => !remove.includes(e.id));
        save({ ...library, entries, selected: remove.includes(library.selected) ? entries.find(e => e.kind !== 'folder')?.id ?? '' : library.selected });
        setOpened(o => o.filter(id => !remove.includes(id)));
        // Documents remain recoverable in local storage; removing a graph never deletes datasets or models.
      } else {
        save({ ...library, entries: library.entries.map(e => e.id === d.id ? { ...e, name: d.name.trim(), parent: d.parent } : e) });
      }
      setDialog(null);
    } catch (e) { setError(String(e)); }
  };
  const move = (id: string, destination: string | null) => {
    if (!library.entries.some(e => e.id === id) || (destination && childrenOf(id).includes(destination))) return;
    save({ ...library, entries: library.entries.map(e => e.id === id ? { ...e, parent: destination } : e.id === destination ? { ...e, collapsed: false } : e) });
  };
  const tree = (folder: string | null, depth = 0) => library.entries.filter(e => e.parent === folder).map(entry => {
    const matches = entry.name.toLowerCase().includes(query.toLowerCase());
    const containsMatch = childrenOf(entry.id).some(id => library.entries.find(e => e.id === id)!.name.toLowerCase().includes(query.toLowerCase()));
    if (query && !containsMatch) return null;
    return <div key={entry.id}>
      <button className={`graph-tree-row ${library.selected === entry.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 13 }}
        aria-label={`${entry.kind}: ${entry.name}`} draggable onDragStart={e => { e.dataTransfer.setData('application/firefly-graph', entry.id); e.stopPropagation(); }}
        onDragOver={e => { if (entry.kind === 'folder' && e.dataTransfer.types.includes('application/firefly-graph')) e.preventDefault(); }}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); move(e.dataTransfer.getData('application/firefly-graph'), entry.kind === 'folder' ? entry.id : entry.parent); }}
        onClick={() => select(entry)} onContextMenu={e => { e.preventDefault(); setMenu({ id: entry.id, x: e.clientX, y: e.clientY }); }}>
        <span>{entry.kind === 'folder' ? entry.collapsed && !query ? '▸' : '▾' : entry.kind === 'policy' ? '◇' : '▣'}</span><span className={query && matches ? 'graph-match' : ''}>{entry.name}</span>{isRunning(entry.id) && <span className="graph-running" title="Running">●</span>}
      </button>
      {entry.kind === 'folder' && (!entry.collapsed || query) && tree(entry.id, depth + 1)}
    </div>;
  });
  const ancestors: string[] = [];
  let at = selected;
  while (at) { ancestors.unshift(at.name); at = library.entries.find(e => e.id === at?.parent); }
  const selectedKey = selected ? documentKey(props.storageKey, selected.id) : '';
  return <div className={`graph-library ${props.active ? '' : 'pg-off'}`}>
    <aside className="graph-directory" aria-label="Graph directory" onDragOver={e => { if (e.dataTransfer.types.includes('application/firefly-graph')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); move(e.dataTransfer.getData('application/firefly-graph'), null); }}>
      <div className="graph-directory-title">Graphs <button title="New folder" aria-label="New folder" onClick={() => create('folder', null)}>＋</button></div>
      <input aria-label="Find graphs" placeholder="Find graphs…" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="graph-game">{props.graphOf || 'No game selected'}</div>
      <div className="graph-tree">{tree(null)}</div>
      <div className="graph-new"><button onClick={() => create('policy')}>+ Policy</button><button onClick={() => create('collection')}>+ Collection</button></div>
      <small>Right-click to organize. Drag graphs into folders.</small>
    </aside>
    <section className="graph-workspace">
      <div className="graph-breadcrumb"><span>{props.graphOf} / {ancestors.join(' / ')}</span>{selected && <><b>{selected.kind === 'policy' ? 'Policy' : 'Data Collection'}</b><button title="Graph options" aria-label="Graph options" onClick={e => setMenu({ id: selected.id, x: e.clientX - 150, y: e.clientY + 10 })}>⋯</button></>}</div>
      {error && <div className="collection-error">{error}</div>}
      {/* Open policy editors stay mounted so training state survives navigation. */}
      {library.entries.filter(e => e.kind === 'policy' && (opened.includes(e.id) || props.active && library.selected === e.id)).map(entry => <div key={entry.id} className={`graph-page ${library.selected === entry.id ? '' : 'pg-off'}`}><PolicyGraph {...props} active storageKey={documentKey(props.storageKey, entry.id)} graphId={entry.id} /></div>)}
      {selected?.kind === 'collection' && (props.active || opened.includes(selected.id)) && <CollectionGraph key={selectedKey} storageKey={selectedKey} graphId={selected.id} name={selected.name} scope={props.storageKey} windowId={props.windowId} capturing={props.capturing} observed={props.observed} stateLabels={props.stateLabels} regions={props.regions} status={props.statuses.find(s => s.graphId === selected.id)} />}
      {!selected && <div className="graph-empty">Create a Policy or Data Collection graph to get started.</div>}
    </section>
    {menu && <div className="graph-menu-shade" onClick={() => setMenu(null)}><div className="graph-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 270) }} onClick={e => e.stopPropagation()}>{(() => {
      const entry = library.entries.find(e => e.id === menu.id); if (!entry) return null;
      return <>{entry.kind === 'folder' ? <><button onClick={() => create('folder', entry.id)}>New folder</button><button onClick={() => create('policy', entry.id)}>New policy</button><button onClick={() => create('collection', entry.id)}>New collection</button></> : <><button onClick={() => duplicate(entry)}>Duplicate</button><button onClick={() => exportGraph(entry)}>Export graph</button></>}<button onClick={() => manage('rename', entry)}>Rename</button><button onClick={() => manage('move', entry)}>Move to…</button><button onClick={() => manage('delete', entry)}>Delete</button></>;
    })()}</div></div>}
    {dialog && <div className="graph-dialog-shade"><form className="graph-dialog" onSubmit={e => { e.preventDefault(); submit(); }}>
      <b>{dialog.action === 'create' ? `New ${dialog.kind === 'collection' ? 'Data Collection graph' : dialog.kind}` : `${dialog.action[0].toUpperCase() + dialog.action.slice(1)} ${dialog.name}`}</b>
      {dialog.action === 'delete' ? <p>Remove this {dialog.kind === 'folder' ? 'folder and its graphs' : 'graph'} from the directory? Saved images, recordings and trained models are kept.</p> : <><label>Name<input autoFocus aria-label="Graph name" value={dialog.name} onChange={e => setDialog({ ...dialog, name: e.target.value })} /></label><label>Folder<select aria-label="Parent folder" value={dialog.parent ?? ''} onChange={e => setDialog({ ...dialog, parent: e.target.value || null })}><option value="">Game root</option>{library.entries.filter(e => e.kind === 'folder' && (!dialog.id || !childrenOf(dialog.id).includes(e.id))).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label></>}
      <div><button type="button" onClick={() => setDialog(null)}>Cancel</button><button type="submit">{dialog.action === 'delete' ? 'Delete' : 'Save'}</button></div>
    </form></div>}
  </div>;
}
