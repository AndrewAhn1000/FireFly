import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Listing = Awaited<ReturnType<typeof window.bridge.collection.datasetList>>;
type Item = Awaited<ReturnType<typeof window.bridge.collection.datasetItem>>;
const COLORS = ['#ff4d4d', '#3ddc84', '#4d9dff', '#ffb84d', '#c77dff', '#4dd8e6', '#ff7ab6', '#d4e157'];
const colorOf = (cls: number) => COLORS[cls % COLORS.length];

// A Dataset Output folder's saved images, one at a time and in the order they were saved, with their label boxes on top
export default function DatasetViewer({ directory, onClose }: { directory: string; onClose(): void }) {
  const [listing, setListing] = useState<Listing | null>(null), [error, setError] = useState('');
  const [split, setSplit] = useState('all'), [index, setIndex] = useState(0);
  const [item, setItem] = useState<Item | null>(null), [showBoxes, setShowBoxes] = useState(true);
  const [notice, setNotice] = useState(''), [deleting, setDeleting] = useState(false);
  const load = useCallback(() => {
    window.bridge.collection.datasetList(directory).then(l => { setListing(l); setError(''); }, e => setError(String(e)));
  }, [directory]);
  useEffect(load, [load]);
  const items = useMemo(() => (listing?.items ?? []).filter(i => split === 'all' || i.split === split), [listing, split]);
  const splits = useMemo(() => [...new Set((listing?.items ?? []).map(i => i.split).filter(Boolean))], [listing]);
  const at = Math.min(index, Math.max(0, items.length - 1)), current = items[at];
  // Only the newest request shows, however fast the images are stepped through
  const asked = useRef(0);
  useEffect(() => {
    if (!current) { setItem(null); return; }
    const ask = ++asked.current;
    window.bridge.collection.datasetItem(directory, current.path)
      .then(found => { if (ask === asked.current) { setItem(found); setError(''); } }, e => { if (ask === asked.current) setError(String(e)); });
  }, [directory, current]);
  const go = useCallback((to: number) => { setIndex(Math.max(0, Math.min(items.length - 1, to))); setNotice(''); }, [items.length]);
  // The image on screen and its labels to the Recycle Bin, and its table rows deleted; the next image takes its place
  const remove = useCallback(async () => {
    if (!current || deleting) return;
    if (!window.confirm(`Move ${current.path} and its labels to the Recycle Bin? Its table rows are deleted too, so the moment it shows counts as new again.`)) return;
    setDeleting(true);
    try {
      const done = await window.bridge.collection.datasetDelete(directory, current.path);
      setListing(l => l && { ...l, items: l.items.filter(i => i.path !== current.path) });
      setNotice(`Moved ${done.files} file${done.files === 1 ? '' : 's'} to the Recycle Bin · ${done.rows} table row${done.rows === 1 ? '' : 's'} deleted`);
      setError(done.rowsError ? `The image is gone, but its table rows weren't deleted: ${done.rowsError}` : '');
    } catch (e) { setError(String(e)); } finally { setDeleting(false); }
  }, [current, deleting, directory]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && (el as HTMLInputElement).type !== 'checkbox') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(at + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(at - 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
      else if (e.key === 'Delete') { e.preventDefault(); void remove(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, go, at, items.length, remove]);
  const classes = listing?.classes ?? [];
  const counts = new Map<number, number>();
  for (const b of item?.boxes ?? []) counts.set(b.cls, (counts.get(b.cls) ?? 0) + 1);
  return <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-card dataset-viewer" role="dialog" aria-label="Dataset preview">
      <div className="modal-header dataset-viewer-hd">
        <span className="modal-title">Dataset preview</span>
        <button className="modal-btn" aria-label="Previous image" disabled={at <= 0} onClick={() => go(at - 1)}>◀ Prev</button>
        <span className="dataset-viewer-count">{items.length ? `${at + 1} / ${items.length}` : '0 / 0'}</span>
        <button className="modal-btn" aria-label="Next image" disabled={at >= items.length - 1} onClick={() => go(at + 1)}>Next ▶</button>
        <input aria-label="Image" type="range" min={0} max={Math.max(0, items.length - 1)} value={at} disabled={items.length < 2} onChange={e => go(Number(e.target.value))} />
        {splits.length > 0 && <select aria-label="Split" value={split} onChange={e => { setSplit(e.target.value); setIndex(0); }}>
          <option value="all">All</option>{splits.map(s => <option key={s} value={s}>{s}</option>)}
        </select>}
        <label className="collection-check"><input type="checkbox" checked={showBoxes} onChange={e => setShowBoxes(e.target.checked)} />Labels</label>
        <button className="modal-btn" onClick={load}>Refresh</button>
        <button className="modal-btn" onClick={onClose}>Close</button>
      </div>
      {error && <div className="collection-error">{error}</div>}
      <div className="dataset-viewer-body">
        {listing && items.length === 0 ? <div className="pg-hint">No saved images in {directory} yet.</div>
          : item && <div className="dataset-viewer-frame">
            <img src={item.image} alt={current?.path ?? ''} />
            {showBoxes && item.boxes?.map((b, i) => <div key={i} className="dataset-box" style={{
              left: `${(b.x - b.w / 2) * 100}%`, top: `${(b.y - b.h / 2) * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, borderColor: colorOf(b.cls),
            }}><span style={{ background: colorOf(b.cls) }}>{classes[b.cls] ?? b.cls}</span></div>)}
          </div>}
      </div>
      <div className="dataset-viewer-ft">
        <code title={item?.file}>{current?.path}</code>
        {current?.split && <b>{current.split}</b>}
        {item?.meta?.trigger && <span>{item.meta.trigger}</span>}
        {item?.meta?.savedAt && <span>{new Date(item.meta.savedAt).toLocaleString()}</span>}
        <span className="dataset-viewer-legend">
          {item?.boxes === null ? 'No label file' : item && (item.boxes.length === 0 ? 'No boxes (background)'
            : [...counts].sort((a, b) => a[0] - b[0]).map(([cls, n]) => <span key={cls}><i style={{ background: colorOf(cls) }} />{classes[cls] ?? `class ${cls}`} × {n}</span>))}
        </span>
        {notice && <span className="dataset-viewer-notice">{notice}</span>}
        {item && <button className="modal-btn" onClick={() => void window.bridge.policy.reveal(item.file)}>Show file</button>}
        {current && <button className="modal-btn modal-btn-danger" disabled={deleting} title="Move it and its labels to the Recycle Bin, and delete its table rows (Delete)" onClick={() => void remove()}>Delete image</button>}
      </div>
    </div>
  </div>;
}
