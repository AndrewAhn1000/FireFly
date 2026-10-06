import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';

interface Observation { name: string; type?: string; valid: boolean; value: unknown; reason?: string; heldMs?: number; }
interface RecordedRow {
  seq: number; timestamp?: number; kind?: string; valid?: boolean;
  observations?: Observation[];
  actions?: {valid?: boolean; buttons?: Record<string, boolean>; reason?: string};
  [key: string]: unknown;
}
interface Recording {
  id: string; name: string; status: string; samples: number; inputEvents: number;
  invalidSamples: number; durationMs: number;
  metadata: {started: number; hz?: number; observationSchema?: unknown; actionSchema?: unknown; correction?: boolean};
  rows?: RecordedRow[]; offset?: number; total?: number; stream?: string;
}
interface Props {
  active: boolean; online: boolean;
  recording: {active: boolean; id: string; samples: number; queued?: number; error?: string} | null;
  setup?: ReactNode; // setting up the next recording: buttons, rate and what it holds
}
const PAGE_SIZE = 50;
const concise = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '—';
  return text.length > 120 ? text.slice(0, 117) + '…' : text;
};

// How many samples a second a recording took, and what it aimed for
const rate = (r: Recording) => {
  const hz = r.samples / (r.durationMs / 1000);
  return `${hz >= 10 ? Math.round(hz) : hz.toFixed(1)}/s${r.metadata.hz ? ` of ${r.metadata.hz}` : ''}`;
};

export default function RecordingsPanel({active, online, recording, setup}: Props) {
  const [items, setItems] = useState<Recording[]>([]), [id, setId] = useState('');
  const [all, setAll] = useState<Recording[]>([]); // corrections too, which the list leaves out
  const [data, setData] = useState<Recording | null>(null), [stream, setStream] = useState<'samples' | 'inputs'>('samples');
  const [offset, setOffset] = useState(0), [follow, setFollow] = useState(true), [revision, setRevision] = useState(0);
  const [listError, setListError] = useState(''), [readError, setReadError] = useState(''), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<RecordedRow | null>(null), [updated, setUpdated] = useState('');
  const selection = useRef('');
  // Recordings ticked for deleting together; shift-click ticks every one between it and the last ticked
  const [marked, setMarked] = useState<Set<string>>(new Set()), lastMarked = useRef<string | null>(null);
  const [deleting, setDeleting] = useState<{done: number; of: number} | null>(null);
  const table = useRef<HTMLDivElement>(null);
  const choose = useCallback((next: string, live = false) => {
    selection.current = next; setId(next); setOffset(0); setFollow(live);
    setData(null); setSelected(null); setReadError(''); setUpdated('');
  }, []);

  // A newly started recording becomes the live selection, even if this dock is hidden.
  useEffect(() => { if (recording?.active && recording.id) choose(recording.id, true); }, [recording?.id, recording?.active, choose]);
  useEffect(() => {
    if (!active || !online) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const reply = await window.bridge.invoke('dataset.list') as {recordings: Recording[]};
        if (!alive) return;
        setItems(reply.recordings.filter(r => !r.metadata.correction)); setAll(reply.recordings); setListError('');
        setMarked(m => { const known = new Set(reply.recordings.map(r => r.id)); const next = new Set([...m].filter(x => known.has(x))); return next.size === m.size ? m : next; });
        const listed = reply.recordings.filter(r => !r.metadata.correction);
        if (!selection.current && listed.length) choose(listed[0].id);
      } catch (e) { if (alive) setListError(String(e)); }
      if (alive && recording?.active) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, online, recording?.id, recording?.active, revision, choose]);

  useEffect(() => {
    if (!active || !online || !id) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const refresh = async () => {
      try {
        const reply = await window.bridge.invoke('dataset.read', {recordingId: id, offset, limit: PAGE_SIZE, tail: follow, stream}) as {recording: Recording};
        if (!alive) return;
        setData(reply.recording); setReadError(''); setUpdated(new Date().toLocaleTimeString());
      } catch (e) { if (alive) setReadError(String(e)); }
      if (alive) {
        setLoading(false);
        // Keep the selected page fresh during a session; only Follow latest changes its offset.
        if (recording?.active) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, online, id, offset, follow, stream, revision, recording?.active, recording?.id]);

  useEffect(() => {
    if (follow && table.current) table.current.scrollTop = table.current.scrollHeight;
  }, [data, follow, active]);

  const rows = data?.rows ?? [], start = data?.offset ?? 0;
  const total = data?.total ?? (stream === 'samples' ? data?.samples : data?.inputEvents) ?? 0;
  const live = recording?.active && recording.id === id;
  const page = (next: number) => { setFollow(false); setOffset(next); setSelected(null); };
  // Deleting is for good: the recording's samples, input events and files
  const remove = async () => {
    if (!data || live) return;
    if (!window.confirm(`Delete “${data.name}”? Its ${data.samples.toLocaleString()} samples and ${data.inputEvents.toLocaleString()} input events are removed for good.`)) return;
    try {
      await window.bridge.invoke('dataset.delete', {recordingId: data.id});
      choose(''); setRevision(r => r + 1);
    } catch (e) { setReadError(String(e)); }
  };
  // Several at once: each is deleted in turn (never the one being recorded), and what failed is said
  const markable = items.filter(item => !(recording?.active && item.id === recording.id));
  const mark = (item: Recording, on: boolean, range: boolean) => setMarked(m => {
    const next = new Set(m);
    const from = range && lastMarked.current ? markable.findIndex(r => r.id === lastMarked.current) : -1, to = markable.findIndex(r => r.id === item.id);
    const ids = from >= 0 && to >= 0 ? markable.slice(Math.min(from, to), Math.max(from, to) + 1).map(r => r.id) : [item.id];
    for (const x of ids) { if (on) next.add(x); else next.delete(x); }
    lastMarked.current = item.id;
    return next;
  });
  const removeMarked = async () => {
    const chosen = markable.filter(item => marked.has(item.id));
    if (!chosen.length) return;
    const samples = chosen.reduce((n, r) => n + r.samples, 0), events = chosen.reduce((n, r) => n + r.inputEvents, 0);
    if (!window.confirm(`Delete ${chosen.length} recording${chosen.length > 1 ? 's' : ''}? Their ${samples.toLocaleString()} samples and ${events.toLocaleString()} input events are removed for good.\n\n`
      + chosen.slice(0, 12).map(r => `• ${r.name}`).join('\n') + (chosen.length > 12 ? `\n… and ${chosen.length - 12} more` : ''))) return;
    const failed: string[] = [], gone = new Set<string>();
    setDeleting({done: 0, of: chosen.length});
    for (const [i, r] of chosen.entries()) {
      try { await window.bridge.invoke('dataset.delete', {recordingId: r.id}); gone.add(r.id); }
      catch (e) { failed.push(`${r.name}: ${String(e).replace(/^Error: /, '')}`); }
      setDeleting({done: i + 1, of: chosen.length});
    }
    setDeleting(null);
    setMarked(new Set()); lastMarked.current = null;
    if (gone.has(id)) choose('');
    setRevision(r => r + 1);
    setListError(failed.length ? `Couldn\u2019t delete ${failed.length} of ${chosen.length}: ${failed.join('; ')}` : '');
  };
  const time = (row: RecordedRow) => typeof row.timestamp === 'number' && data
    ? ((row.timestamp - data.metadata.started) / 1000).toFixed(3) + ' s' : '—';

  return <div className="recordings-panel" hidden={!active}>
    <div className="recordings-toolbar">
      <strong>Recordings</strong><span className="recordings-muted">Saved observations and input events</span>
      <button className="modal-btn" disabled={!online} onClick={() => setRevision(r => r + 1)}>Refresh recordings</button>
      {recording?.active && <button className="modal-btn" onClick={() => choose(recording.id, true)}>View live recording</button>}
    </div>
    {!online && <div className="recordings-error" role="status">Connect the runtime to browse recordings.</div>}
    {(listError || readError || (live && recording?.error)) && <div className="recordings-error" role="alert">{listError || readError || recording?.error}</div>}
    <div className="recordings-body">
      {setup && <aside className="recordings-setup" aria-label="Recording setup">{setup}</aside>}
      <aside className="recordings-list" aria-label="Saved recordings">
        {items.length === 0 && <p>No saved recordings yet. Start recording while capturing to see samples here.</p>}
        {markable.length > 0 && <div className="recordings-bulk">
          <label title="Tick every recording (shift-click a box to tick a range)">
            <input type="checkbox" aria-label="Tick every recording" checked={marked.size > 0 && marked.size === markable.length}
              ref={el => { if (el) el.indeterminate = marked.size > 0 && marked.size < markable.length; }}
              onChange={e => { setMarked(e.target.checked ? new Set(markable.map(r => r.id)) : new Set()); lastMarked.current = null; }} />
            {deleting ? `Deleting ${deleting.done} of ${deleting.of}…` : marked.size ? `${marked.size} ticked` : 'Tick to delete several'}
          </label>
          {marked.size > 0 && <button className="modal-btn recordings-delete" disabled={!!deleting} onClick={() => void removeMarked()}>Delete {marked.size}</button>}
        </div>}
        {recording?.active && !all.some(item => item.id === recording.id) && <button onClick={() => choose(recording.id, true)}>● Current recording · initializing…</button>}
        {items.map(item => {
          const isLive = recording?.active === true && item.id === recording.id;
          return <div key={item.id} className={`recordings-item ${item.id === id ? 'selected' : ''} ${marked.has(item.id) ? 'marked' : ''}`}>
            <input type="checkbox" aria-label={`Tick ${item.name}`} checked={marked.has(item.id)} disabled={isLive || !!deleting}
              title={isLive ? 'Being recorded: stop it before deleting it' : 'Tick to delete it with others (shift-click: a range)'}
              onClick={e => mark(item, (e.target as HTMLInputElement).checked, e.shiftKey)} onChange={() => {}} />
            <button onClick={() => choose(item.id, isLive)}>
              <strong>{item.name}</strong><span>{item.status} · {(item.durationMs / 1000).toFixed(1)} s</span>
              <small>{item.samples.toLocaleString()} samples{item.durationMs > 1000 ? ` · ${rate(item)}` : ''} · {item.inputEvents.toLocaleString()} input events</small>
            </button>
          </div>;
        })}
        {items.length === 200 && <p>Showing the 200 most recent recordings.</p>}
      </aside>
      <section className="recordings-data">
        {!id ? <div className="recordings-empty">Select a recording to inspect its data.</div> : <>
          <div className="recordings-summary">
            <strong>{data?.name ?? 'Loading recording…'}</strong>
            <span className={live ? 'recordings-live' : ''}>{live ? '● Recording live' : data?.status}</span>
            {data && <span>{data.samples.toLocaleString()} samples · {data.inputEvents.toLocaleString()} inputs · {data.invalidSamples.toLocaleString()} invalid</span>}
            {live && <span>{recording?.queued ?? 0} queued</span>}
            <button className="modal-btn recordings-delete" disabled={!data || live} title={live ? 'Stop recording before deleting it' : 'Delete this recording'} onClick={() => void remove()}>Delete recording</button>
          </div>
          <div className="recordings-controls">
            <select aria-label="Recorded data stream" value={stream} onChange={e => {setStream(e.target.value as typeof stream); setOffset(0); setData(null); setSelected(null);}}>
              <option value="samples">Observation / action samples</option><option value="inputs">Raw input events</option>
            </select>
            <label><input type="checkbox" checked={follow} onChange={e => {setFollow(e.target.checked); setOffset(start); setSelected(null);}}/>Follow latest</label>
            <span>{loading ? 'Loading…' : updated ? `Updated ${updated}` : ''}</span>
          </div>
          <div className="recordings-table-wrap" ref={table}>
            <table className="recordings-table"><thead><tr><th>#</th><th>Session time</th>{stream === 'samples' ? <><th>Observations</th><th>Held actions</th><th>Validity</th></> : <><th>Event</th><th>Recorded data</th></>}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.seq} tabIndex={0} aria-selected={selected?.seq === row.seq} onClick={() => {setSelected(row); setFollow(false); setOffset(start);}} onKeyDown={e => {if(e.key === 'Enter'){setSelected(row);setFollow(false);setOffset(start);}}}>
                <td>{row.seq}</td><td title={String(row.timestamp ?? '')}>{time(row)}</td>
                {stream === 'samples' ? <><td>{row.observations?.length ? row.observations.map((observation, i) => <div key={observation.name + i} className={observation.valid ? '' : 'recordings-invalid'}><b>{observation.name}</b>: {observation.valid ? concise(observation.value) : `Invalid — ${observation.reason ?? 'no value'}`}{observation.heldMs ? <small className="recordings-muted"> (held {observation.heldMs} ms)</small> : null}</div>) : <span className="recordings-muted">No observations in this sample</span>}</td>
                  <td>{Object.entries(row.actions?.buttons ?? {}).filter(([, held]) => held).map(([name]) => name).join(', ') || '—'}</td>
                  <td className={row.valid ? 'recordings-valid' : 'recordings-invalid'}>{row.valid ? 'Valid' : row.actions?.reason || 'Invalid observation or action'}</td></>
                  : <><td>{row.kind ?? 'input'}</td><td>{concise(row)}</td></>}
              </tr>)}</tbody></table>
            {!rows.length && <div className="recordings-empty">{loading ? 'Reading saved data…' : live ? 'Waiting for committed data…' : 'No rows in this recording.'}</div>}
          </div>
          <div className="recordings-pagination">
            <button disabled={loading || start === 0} onClick={() => page(0)}>First</button>
            <button disabled={loading || start === 0} onClick={() => page(Math.max(0, start - PAGE_SIZE))}>Previous</button>
            <span>{total ? `${rows.length ? start + 1 : 0}–${start + rows.length} of ${total.toLocaleString()}` : '0 rows'}</span>
            <button disabled={loading || start + rows.length >= total} onClick={() => page(start + PAGE_SIZE)}>Next</button>
            <button disabled={loading || !total} onClick={() => {setFollow(true);setSelected(null);}}>Latest</button>
            <small>{live ? 'Committed data · refreshes every second' : 'Select a row to inspect all fields'}</small>
          </div>
          {selected && <div className="recordings-detail"><div><strong>{stream === 'samples' ? 'Sample' : 'Input event'} {selected.seq} · all recorded fields</strong><button onClick={() => setSelected(null)}>Close details</button></div><pre>{JSON.stringify(selected, null, 2)}</pre></div>}
          {data && <details className="recordings-schema"><summary>Recording metadata and schemas</summary><pre>{JSON.stringify(data.metadata, null, 2)}</pre></details>}
        </>}
      </section>
    </div>
  </div>;
}

