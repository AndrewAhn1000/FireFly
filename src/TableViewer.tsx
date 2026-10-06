import { useCallback, useEffect, useState } from 'react';
import type { TableRows } from './collectionModel';

const PAGE = 100;
const shown = (v: unknown) => v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

// A Table node's rows, one per screenshot it kept, a page at a time; the filter and sort cover the whole table
export default function TableViewer({ scope, table, onClose }: { scope: string; table: string; onClose(): void }) {
  const [data, setData] = useState<TableRows | null>(null), [error, setError] = useState('');
  const [typed, setTyped] = useState(''), [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ column: string; up: boolean }>({ column: 'savedAt', up: false });
  const [page, setPage] = useState(0);
  // The filter applies once typing pauses, from the first page
  useEffect(() => {
    const timer = setTimeout(() => { setFilter(typed); setPage(0); }, 250);
    return () => clearTimeout(timer);
  }, [typed]);
  const load = useCallback(() => {
    window.bridge.collection.table('rows', { scope, table, offset: page * PAGE, limit: PAGE, filter, sort })
      .then(rows => {
        // A page emptied by deleting its last rows shows the one before it
        if (rows.rows.length === 0 && page > 0 && rows.total > 0) setPage(Math.ceil(rows.total / PAGE) - 1);
        else { setData(rows); setError(''); }
      }, e => setError(String(e)));
  }, [scope, table, page, filter, sort]);
  useEffect(load, [load]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const remove = async (key?: string) => {
    if (!key && !window.confirm(`Delete all ${data?.all ?? 0} rows of “${table}”? Their values count as new again. The screenshots stay.`)) return;
    try { await window.bridge.collection.table('delete', { scope, table, key }); if (!key) setPage(0); load(); } catch (e) { setError(String(e)); }
  };
  const header = (column: string, label: string) => <th key={column} onClick={() => { setSort(s => ({ column, up: s.column === column ? !s.up : true })); setPage(0); }}>
    {label}{sort.column === column ? (sort.up ? ' ▲' : ' ▼') : ''}
  </th>;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  const first = data && data.total ? page * PAGE + 1 : 0, last = data ? page * PAGE + data.rows.length : 0;
  return <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal-card table-viewer" role="dialog" aria-label={`Table ${table}`}>
      <div className="modal-header table-viewer-hd">
        <span className="modal-title">Table “{table}”</span>
        <span>{data ? `${data.all} row${data.all === 1 ? '' : 's'}` : 'Loading…'}</span>
        <input aria-label="Filter rows" placeholder="Filter, e.g. 100000000 [2,-1]" value={typed} onChange={e => setTyped(e.target.value)} />
        <button className="modal-btn" onClick={load}>Refresh</button>
        <button className="modal-btn" onClick={onClose}>Close</button>
      </div>
      {error && <div className="collection-error">{error}</div>}
      <div className="table-viewer-body">
        {data && data.all === 0 ? <div className="pg-hint">Nothing kept yet. A row is added each time a screenshot this table let through is saved.</div>
          : data && data.total === 0 ? <div className="pg-hint">No rows hold all of “{filter}”.</div>
          : <table>
            <thead><tr>{(data?.columns ?? []).map(c => header(c, c))}{header('savedAt', 'Saved')}<th /><th /></tr></thead>
            <tbody>{data?.rows.map(r => <tr key={r.key}>
              {data.columns.map(c => <td key={c}>{shown(r.columns[c])}</td>)}
              <td>{new Date(r.savedAt).toLocaleString()}</td>
              <td>{r.image && <button className="modal-btn" onClick={() => void window.bridge.policy.reveal(r.image!)}>Show image</button>}</td>
              <td><button className="modal-btn" title="Delete this row: its values no longer count as kept" aria-label="Delete row" onClick={() => void remove(r.key)}>✕</button></td>
            </tr>)}</tbody>
          </table>}
      </div>
      <div className="modal-actions table-viewer-ft">
        <button className="modal-btn" aria-label="First page" disabled={page === 0} onClick={() => setPage(0)}>«</button>
        <button className="modal-btn" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
        <span className="table-viewer-page">{data && data.total ? `Rows ${first}–${last} of ${data.total}${filter ? ` matching (${data.all} in all)` : ''} · page ${page + 1} of ${pages}` : ''}</span>
        <button className="modal-btn" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
        <button className="modal-btn" aria-label="Last page" disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>»</button>
        <span className="table-viewer-spacer" />
        <button className="modal-btn modal-btn-danger" disabled={!data?.all} onClick={() => void remove()}>Delete all rows</button>
      </div>
    </div>
  </div>;
}
