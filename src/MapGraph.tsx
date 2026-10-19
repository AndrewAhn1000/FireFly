import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { buttonLabel } from './Keyboard';
import { PreservedInput } from './PreservedInputs';
import { cleanError, type PlayStatus } from './policyPlay';
import { inputsOf, quoted, readTree } from './behaviorModel';
import { graphDocument, type GraphRef } from './BehaviorTree';
import { MAP_DEFAULTS, mapProblems, placeName, readMap, type LinkStats, type MapDoc, type MapFrame, type MapLink, type MapPlace, type Suggested } from './mapModel';

// A map: places the player can be at and links between them, each how to get from one to the other (a clip of a
// recording, played as you pressed it, or a behaviour tree given `from` and `to`). A tree's Go to node goes over it
// (worker/behavior.py): the quickest links from where the player is, each costing what it took when it worked, over
// how often it has. Where the player is and on which level are your formulas; nothing in it is about one game.

export interface MapGraphProps {
  storageKey: string; graphId: string; name: string; scope: string; graphs: GraphRef[];
  capturing: boolean; online: boolean; observed: Record<string, string>; stateLabels: Record<string, string>;
}
interface Recording { id: string; name: string; status: string; durationMs: number; metadata: { started: number; correction?: boolean; observationSchema?: { fields?: { name: string; type: string }[] } }; }
interface Clip { from: number; to: number; ms: number; start: [number, number]; end: [number, number]; dx: number; dy: number; keys: [number, string, boolean][]; }
type Mode = 'select' | 'place' | 'link';
type Selection = { kind: 'place' | 'link'; id: string } | null;
interface View { x: number; y: number; scale: number; }
const SHAPE_COLORS = ['#5aa9e6', '#7bd389', '#e6a15a', '#c58ae6', '#e65a7b', '#5ae6d1'];

function Formula({ label, value, fields, labels, placeholder, onChange, title }: { label: string; value: string; fields: Map<string, string>; labels: Record<string, string>;
  placeholder?: string; title?: string; onChange(v: string): void }) {
  return <label className="map-field" title={title}>{label}
    <span className="bt-formula">
      <PreservedInput className="pg-source" aria-label={label} spellCheck={false} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
      <select aria-label={`Put a State in ${label}`} value="" title="Put a State in the formula"
        onChange={e => { if (e.target.value) onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${quoted(e.target.value)}`); }}>
        <option value="">+ State</option>
        {[...fields].filter(([, t]) => ['number', 'boolean', 'vector'].includes(t)).map(([n, t]) => <option key={n} value={n}>{labels[n] ?? n} ({t})</option>)}
      </select>
    </span></label>;
}

function NumberField({ label, value, min, max, unit, onChange, title }: { label: string; value: number; min: number; max: number; unit?: string; title?: string; onChange(v: number): void }) {
  return <label className="map-field map-number" title={title}>{label}
    <span><input type="number" aria-label={label} min={min} max={max} value={value} onChange={e => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))} />{unit}</span></label>;
}

// A tree and the formulas for its inputs, but those a map gives (from and to)
function TreeChoice({ label, tree, args, given, trees, read, fields, labels, onChange }: { label: string; tree: string; args: Record<string, string>; given: string[];
  trees: GraphRef[]; read(id: string): string | null; fields: Map<string, string>; labels: Record<string, string>; onChange(tree: string, args: Record<string, string>): void }) {
  const text = tree ? read(tree) : null, inputs = text != null ? inputsOf(readTree(text)) : [];
  return <>
    <label className="map-field">{label}<select aria-label={label} value={tree} onChange={e => onChange(e.target.value, args)}>
      <option value="">Choose a tree…</option>{trees.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      {tree && !trees.some(t => t.id === tree) && <option value={tree}>(deleted tree)</option>}</select></label>
    {tree && text != null && <div className="pg-hint">{inputs.filter(x => given.includes(x.name)).length
      ? `Given ${inputs.filter(x => given.includes(x.name)).map(x => x.name).join(' and ')}: the places’ positions.`
      : `Give its Root a vector input named ${given.join(' or ')} to be told ${given.length > 1 ? 'the places’ positions' : 'where to go'}.`}</div>}
    {inputs.filter(x => !given.includes(x.name)).map(x => <Formula key={x.name} label={`${x.name} (${x.type})`} value={args[x.name] ?? ''} fields={fields} labels={labels}
      onChange={v => onChange(tree, { ...args, [x.name]: v })} />)}
  </>;
}

export default function MapGraph(props: MapGraphProps) {
  const [doc, setDoc] = useState<MapDoc>(() => readMap(localStorage.getItem(props.storageKey)));
  const [error, setError] = useState('');
  useEffect(() => { try { localStorage.setItem(props.storageKey, JSON.stringify(doc)); } catch { setError('Could not save the map: local storage is full'); } }, [props.storageKey, doc]);
  const change = useCallback((patch: Partial<MapDoc> | ((d: MapDoc) => Partial<MapDoc>)) => setDoc(d => ({ ...d, ...(typeof patch === 'function' ? patch(d) : patch) })), []);
  const read = useCallback((id: string) => graphDocument(props.scope, id), [props.scope]);
  const trees = props.graphs.filter(g => g.kind === 'behavior');
  // recordings, and what formulas read: what FireFly observes now, and what the recordings hold
  const [recordings, setRecordings] = useState<Recording[]>([]);
  useEffect(() => {
    if (!props.online) return;
    let alive = true;
    void (async () => {
      try { const r = (await window.bridge.invoke('dataset.list')) as { recordings: Recording[] };
        if (alive) setRecordings(r.recordings.filter(x => x.status === 'complete' && !x.metadata.correction).sort((a, b) => b.metadata.started - a.metadata.started)); } catch { /* none */ }
    })();
    return () => { alive = false; };
  }, [props.online]);
  const fields = useMemo(() => {
    const out = new Map(Object.entries(props.observed));
    for (const r of recordings) for (const f of r.metadata.observationSchema?.fields ?? []) if (!out.has(f.name)) out.set(f.name, f.type);
    return out;
  }, [props.observed, recordings]);
  const fieldList = useMemo(() => [...fields].map(([name, type]) => ({ name, type })), [fields]);
  const shapeStates = [...fields].filter(([, t]) => t === 'shapes').map(([n]) => n);

  // what the map is drawn over: what FireFly observes now (about five times a second), else a recording's last sample
  const [frame, setFrame] = useState<MapFrame | null>(null), [frameError, setFrameError] = useState('');
  const frameSpec = useMemo(() => ({ position: doc.position, level: doc.level, draw: doc.draw, fields: fieldList }), [doc.position, doc.level, doc.draw, fieldList]);
  const spec = useRef(frameSpec); spec.current = frameSpec;
  useEffect(() => {
    if (!props.capturing || !doc.position.trim()) return;
    let latest: unknown[] | null = null, busy = false, alive = true;
    const off = window.bridge.on('runtime:event', (msg: unknown) => {
      const { event, result } = msg as { event: string; result: { observations?: unknown[]; tracked?: unknown[] } };
      if (event === 'observations' && result) latest = [...(result.observations ?? []), ...(result.tracked ?? [])];
    });
    const timer = setInterval(() => {
      if (!latest || busy) return;
      const observations = latest; latest = null; busy = true;
      window.bridge.policy.invoke('map.frame', { ...spec.current, observations })
        .then(r => { if (alive) { setFrame(r as MapFrame); setFrameError(''); } })
        .catch(e => { if (alive) setFrameError(cleanError(e)); })
        .finally(() => { busy = false; });
    }, 200);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [props.capturing, doc.position]);
  const drawnOver = doc.recording && recordings.some(r => r.id === doc.recording) ? doc.recording : recordings[0]?.id ?? '';
  useEffect(() => {
    if (props.capturing || !drawnOver || !props.online) return;
    let alive = true;
    const timer = setTimeout(() => {
      window.bridge.policy.invoke('map.frame', { ...frameSpec, recording: drawnOver })
        .then(r => { if (alive) { setFrame(r as MapFrame); setFrameError(''); } })
        .catch(e => { if (alive) setFrameError(cleanError(e)); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [props.capturing, drawnOver, frameSpec, props.online]);

  // a tree going over it: where it is, the way, the link running
  const [status, setStatus] = useState<PlayStatus | null>(null);
  useEffect(() => window.bridge.on('play:status', s => setStatus(s as PlayStatus)), []);
  const live = status?.playing ? status.tree?.maps?.[props.graphId] ?? null : null;
  // what its links did, kept from run to run
  const [stats, setStats] = useState<LinkStats>({});
  const readStats = useCallback(async () => {
    try { setStats(((await window.bridge.policy.invoke('map.stats', { map: props.graphId })) as { stats: LinkStats }).stats ?? {}); } catch { /* none yet */ }
  }, [props.graphId]);
  useEffect(() => { if (props.online) void readStats(); }, [props.online, readStats]);
  useEffect(() => { if (!live) return; const t = setInterval(() => void readStats(), 2000); return () => clearInterval(t); }, [!!live, readStats]); // eslint-disable-line react-hooks/exhaustive-deps

  // the level shown: the player's while it's known, else as chosen
  const levels = useMemo(() => [...new Set([...doc.places.map(p => p.level), ...(frame?.level !== undefined && doc.level.trim() ? [frame.level] : [])])], [doc.places, frame?.level, doc.level]);
  const [levelChoice, setLevelChoice] = useState<string | null | 'all'>('all');
  const level: string | null | 'all' = !doc.level.trim() ? null : levelChoice;
  const shown = (p: MapPlace) => level === 'all' || p.level === level;

  // the canvas
  const [mode, setMode] = useState<Mode>('select'), [selection, setSelection] = useState<Selection>(null), [linkFrom, setLinkFrom] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: Math.max(200, el.clientWidth), height: Math.max(200, el.clientHeight) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const [view, setView] = useState<View>(() => { try { return JSON.parse(localStorage.getItem(props.storageKey + '-view') ?? 'null') ?? { x: 0, y: 0, scale: 1 }; } catch { return { x: 0, y: 0, scale: 1 }; } });
  useEffect(() => { try { localStorage.setItem(props.storageKey + '-view', JSON.stringify(view)); } catch { /* the view only */ } }, [props.storageKey, view]);
  const toScreen = useCallback((x: number, y: number): [number, number] => [(x - view.x) * view.scale, (y - view.y) * view.scale], [view]);
  const toWorld = useCallback((sx: number, sy: number): [number, number] => [sx / view.scale + view.x, sy / view.scale + view.y], [view]);
  const fit = useCallback(() => {
    const pts: [number, number][] = [...doc.places.filter(shown).map(p => [p.x, p.y] as [number, number]),
      ...Object.values(frame?.shapes ?? {}).flat().flat(), ...(frame?.position ? [frame.position] : [])];
    if (!pts.length) { setView({ x: 0, y: 0, scale: 1 }); return; }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = Math.min(4, Math.max(0.05, Math.min(size.width / Math.max(40, x1 - x0 + 80), size.height / Math.max(40, y1 - y0 + 80))));
    setView({ x: (x0 + x1) / 2 - size.width / 2 / scale, y: (y0 + y1) / 2 - size.height / 2 / scale, scale });
  }, [doc.places, frame, size, level]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && (doc.places.length || frame) && !localStorage.getItem(props.storageKey + '-view')) { fitted.current = true; fit(); } }, [doc.places.length, frame, fit, props.storageKey]);

  const placeAt = (sx: number, sy: number) => {
    let best: MapPlace | null = null, d = 10;
    for (const p of doc.places) {
      if (!shown(p)) continue;
      const [px, py] = toScreen(p.x, p.y), e = Math.hypot(px - sx, py - sy);
      if (e <= d) { best = p; d = e; }
    }
    return best;
  };
  const linkAt = (sx: number, sy: number) => {
    let best: MapLink | null = null, d = 6;
    for (const l of doc.links) {
      const a = doc.places.find(p => p.id === l.from), b = doc.places.find(p => p.id === l.to);
      if (!a || !b || !shown(a) || !shown(b)) continue;
      const [ax, ay] = offsetLine(toScreen(a.x, a.y), toScreen(b.x, b.y), twoWay(l))[0], [bx, by] = offsetLine(toScreen(a.x, a.y), toScreen(b.x, b.y), twoWay(l))[1];
      const e = segmentDistance(sx, sy, ax, ay, bx, by);
      if (e <= d) { best = l; d = e; }
    }
    return best;
  };
  const twoWay = (l: MapLink) => doc.links.some(m => m.from === l.to && m.to === l.from);
  const drag = useRef<{ kind: 'pan' | 'place'; id?: string; sx: number; sy: number; view: View; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as [number, number]; };
  const newPlace = (x: number, y: number, at?: string | null) => {
    const p: MapPlace = { id: crypto.randomUUID(), name: placeName(doc), level: at !== undefined ? at : level === 'all' ? frame?.level ?? null : level, x: Math.round(x), y: Math.round(y) };
    change(d => ({ places: [...d.places, p] }));
    setSelection({ kind: 'place', id: p.id });
    return p;
  };
  const newLink = (from: string, to: string, link?: Partial<MapLink>) => {
    if (from === to) return;
    const l: MapLink = { id: crypto.randomUUID(), from, to, kind: 'tree', tree: '', args: {}, ...link };
    change(d => ({ links: [...d.links, l] }));
    setSelection({ kind: 'link', id: l.id });
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const [sx, sy] = local(e);
    canvas.current?.focus();
    const p = placeAt(sx, sy);
    if (mode === 'place' && !p) { const [x, y] = toWorld(sx, sy); newPlace(x, y); return; }
    if (mode === 'link') {
      if (!p) { setLinkFrom(null); return; }
      if (!linkFrom) { setLinkFrom(p.id); return; }
      newLink(linkFrom, p.id); setLinkFrom(null); return;
    }
    if (p) { setSelection({ kind: 'place', id: p.id }); drag.current = { kind: 'place', id: p.id, sx, sy, view, moved: false }; }
    else {
      const l = linkAt(sx, sy);
      setSelection(l ? { kind: 'link', id: l.id } : null);
      drag.current = { kind: 'pan', sx, sy, view, moved: false };
    }
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = drag.current; if (!g) return;
    const [sx, sy] = local(e);
    if (Math.hypot(sx - g.sx, sy - g.sy) > 3) g.moved = true;
    if (!g.moved) return;
    if (g.kind === 'pan') setView({ ...g.view, x: g.view.x - (sx - g.sx) / g.view.scale, y: g.view.y - (sy - g.sy) / g.view.scale });
    else { const [x, y] = toWorld(sx, sy); change(d => ({ places: d.places.map(p => p.id === g.id ? { ...p, x: Math.round(x), y: Math.round(y) } : p) })); }
  };
  const up = () => { drag.current = null; };
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      setView(v => {
        const scale = Math.min(8, Math.max(0.03, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const wx = sx / v.scale + v.x, wy = sy / v.scale + v.y;
        return { scale, x: wx - sx / scale, y: wy - sy / scale };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const removeSelected = () => {
    if (!selection) return;
    if (selection.kind === 'place') change(d => ({ places: d.places.filter(p => p.id !== selection.id), links: d.links.filter(l => l.from !== selection.id && l.to !== selection.id) }));
    else change(d => ({ links: d.links.filter(l => l.id !== selection.id) }));
    setSelection(null);
  };

  // drawing
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = size.width * dpr; el.height = size.height * dpr;
    const c = el.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#15171c'; c.fillRect(0, 0, size.width, size.height);
    // the shapes
    Object.entries(frame?.shapes ?? {}).forEach(([name, lines]) => {
      c.strokeStyle = SHAPE_COLORS[Math.max(0, doc.draw.indexOf(name)) % SHAPE_COLORS.length]; c.globalAlpha = 0.55; c.lineWidth = 1.5;
      for (const line of lines) {
        c.beginPath();
        line.forEach(([x, y], k) => { const [sx, sy] = toScreen(x, y); if (k) c.lineTo(sx, sy); else c.moveTo(sx, sy); });
        if (line.length === 1) { const [sx, sy] = toScreen(line[0][0], line[0][1]); c.rect(sx - 2, sy - 2, 4, 4); }
        c.stroke();
      }
    });
    c.globalAlpha = 1;
    const by = new Map(doc.places.map(p => [p.id, p]));
    const way = new Set(live?.way ?? []);
    // the links, as arrows (two ways apart side by side)
    for (const l of doc.links) {
      const a = by.get(l.from), b = by.get(l.to);
      if (!a || !b || !shown(a) || !shown(b)) continue;
      const [[ax, ay], [bx, by2]] = offsetLine(toScreen(a.x, a.y), toScreen(b.x, b.y), twoWay(l));
      const s = stats[l.id], gaveUp = (live?.fails?.[l.id] ?? 0) >= doc.giveUp;
      const on = selection?.kind === 'link' && selection.id === l.id;
      c.strokeStyle = gaveUp ? '#e65a5a' : live?.link === l.id ? '#4c8ef7' : way.has(l.id) ? '#9cc2ff' : on ? '#ffffff' : problemOf(l) ? '#d9a33b' : '#8a8f99';
      c.lineWidth = live?.link === l.id || on ? 3 : way.has(l.id) ? 2.5 : 1.5;
      c.setLineDash(gaveUp || problemOf(l) ? [5, 4] : []);
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by2); c.stroke(); c.setLineDash([]);
      const ang = Math.atan2(by2 - ay, bx - ax), hx = bx - Math.cos(ang) * 9, hy = by2 - Math.sin(ang) * 9;
      c.fillStyle = c.strokeStyle;
      c.beginPath(); c.moveTo(hx, hy); c.lineTo(hx - Math.cos(ang - 0.45) * 8, hy - Math.sin(ang - 0.45) * 8); c.lineTo(hx - Math.cos(ang + 0.45) * 8, hy - Math.sin(ang + 0.45) * 8); c.fill();
      if (s?.runs) {
        c.font = '10px sans-serif'; c.fillStyle = '#c9ced8';
        c.fillText(`${s.ms ? (s.ms / 1000).toFixed(1) + ' s · ' : ''}${s.runs - s.fails}/${s.runs}`, (ax + bx) / 2 + 4, (ay + by2) / 2 - 4);
      }
    }
    // the places
    for (const p of doc.places) {
      if (!shown(p)) continue;
      const [sx, sy] = toScreen(p.x, p.y), r = doc.reach * view.scale;
      const on = selection?.kind === 'place' && selection.id === p.id, at = live?.at === p.id, dest = live?.dest === p.id;
      c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1;
      c.beginPath(); c.arc(sx, sy, Math.max(2, r), 0, Math.PI * 2); c.stroke();
      c.fillStyle = dest ? '#7bd389' : at ? '#4c8ef7' : linkFrom === p.id ? '#e6a15a' : on ? '#ffffff' : '#d0d4dc';
      c.beginPath(); c.arc(sx, sy, on || at || dest ? 6 : 4.5, 0, Math.PI * 2); c.fill();
      c.font = '11px sans-serif'; c.fillStyle = '#e8eaee'; c.fillText(p.name + (level === 'all' && p.level != null ? ` (${p.level})` : ''), sx + 8, sy - 6);
    }
    // the player
    if (frame?.position && (level === 'all' || frame.level === level)) {
      const [sx, sy] = toScreen(frame.position[0], frame.position[1]);
      c.strokeStyle = '#ffd44c'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(sx - 7, sy); c.lineTo(sx + 7, sy); c.moveTo(sx, sy - 7); c.lineTo(sx, sy + 7); c.stroke();
      c.beginPath(); c.arc(sx, sy, 4, 0, Math.PI * 2); c.stroke();
    }
  });

  // the link chosen: its clip found in a recording, from near its place to near the other
  const selectedPlace = selection?.kind === 'place' ? doc.places.find(p => p.id === selection.id) ?? null : null;
  const selectedLink = selection?.kind === 'link' ? doc.links.find(l => l.id === selection.id) ?? null : null;
  const setLink = (id: string, patch: Partial<MapLink>) => change(d => ({ links: d.links.map(l => l.id === id ? { ...l, ...patch } : l) }));
  const setPlace = (id: string, patch: Partial<MapPlace>) => change(d => ({ places: d.places.map(p => p.id === id ? { ...p, ...patch } : p) }));
  const [clipRec, setClipRec] = useState(''), [clips, setClips] = useState<{ clips: Clip[]; start: number | null; note: string | null } | { error: string } | null>(null), [finding, setFinding] = useState(false);
  useEffect(() => { setClips(null); }, [selection?.id]);
  const findClips = async () => {
    setFinding(true);
    try {
      setClips(await window.bridge.policy.invoke('clips.list', { recording: clipRec || recordings[0]?.id, position: doc.position, ...(doc.grounded.trim() ? { grounded: doc.grounded } : {}),
        ...(doc.level.trim() ? { level: doc.level } : {}), fields: fieldList, formulas: [] }) as { clips: Clip[]; start: number | null; note: string | null });
    } catch (e) { setClips({ error: cleanError(e) }); } finally { setFinding(false); }
  };
  const nearness = (c: Clip, l: MapLink) => {
    const a = doc.places.find(p => p.id === l.from), b = doc.places.find(p => p.id === l.to);
    return a && b ? Math.hypot(c.start[0] - a.x, c.start[1] - a.y) + Math.hypot(c.end[0] - b.x, c.end[1] - b.y) : Infinity;
  };
  // suggestions from every recording: places where you stood, and the stretches between places
  const [suggested, setSuggested] = useState<Suggested | { error: string } | null>(null), [suggesting, setSuggesting] = useState(false);
  const suggest = async () => {
    setSuggesting(true);
    try {
      setSuggested(await window.bridge.policy.invoke('map.suggest', { recordings: recordings.map(r => r.id), position: doc.position, ...(doc.grounded.trim() ? { grounded: doc.grounded } : {}),
        ...(doc.level.trim() ? { level: doc.level } : {}), places: doc.places, reach: doc.reach, fields: fieldList, formulas: [] }) as Suggested);
    } catch (e) { setSuggested({ error: cleanError(e) }); } finally { setSuggesting(false); }
  };
  const has = (from: string, to: string) => doc.links.some(l => l.from === from && l.to === to);
  const problemOf = (l: MapLink) => l.kind === 'clip' ? !l.clip : !l.tree || read(l.tree) == null;
  const problems = mapProblems(doc, id => read(id) != null);
  const name = (id: string) => doc.places.find(p => p.id === id)?.name ?? '?';
  const recName = (id: string) => recordings.find(r => r.id === id)?.name ?? '(deleted recording)';

  return <div className="collection-editor map-editor" aria-label="Map editor">
    <div className="collection-toolbar">
      {(['select', 'place', 'link'] as Mode[]).map(m => <button key={m} className={`modal-btn ${mode === m ? 'primary' : ''}`} aria-pressed={mode === m}
        title={m === 'select' ? 'Choose a place or link; drag a place to move it, or the map to look around' : m === 'place' ? 'Click to put a place there' : 'Click a place, then the place it leads to'}
        onClick={() => { setMode(m); setLinkFrom(null); }}>{m === 'select' ? 'Select' : m === 'place' ? '+ Place' : '+ Link'}</button>)}
      <button className="modal-btn" disabled={!frame?.position} title="A place where the player is now" onClick={() => frame?.position && newPlace(frame.position[0], frame.position[1], doc.level.trim() ? frame.level : null)}>Place at player</button>
      {doc.level.trim() && <label className="map-level">Level<select aria-label="Level shown" value={level === 'all' ? '\u0000all' : level ?? '\u0000none'}
        onChange={e => setLevelChoice(e.target.value === '\u0000all' ? 'all' : e.target.value === '\u0000none' ? null : e.target.value)}>
        <option value={'\u0000all'}>All levels</option>
        {levels.map(l => <option key={String(l)} value={l ?? '\u0000none'}>{l ?? '(none)'}{frame?.level === l ? ' · the player’s' : ''}</option>)}</select></label>}
      <button className="modal-btn" onClick={fit}>Fit</button>
      <span className="bt-status">{live ? `● ${live.text}` : linkFrom ? `From ${name(linkFrom)}: click the place it leads to` : mode === 'place' ? 'Click where a place is' : problems[0] ?? `${doc.places.length} places · ${doc.links.length} links`}</span>
    </div>
    {error && <div className="collection-error">{error}</div>}
    <div className="collection-body">
      <aside className="map-settings" aria-label="Map settings">
        <div className="pg-section-hd">Where the player is</div>
        <Formula label="Position" value={doc.position} fields={fields} labels={props.stateLabels} placeholder="a position State, such as `Player Position`"
          title="Where the player is, a vector: places are where it is, and a link has worked once it's at its place" onChange={v => change({ position: v })} />
        <Formula label="Level (optional)" value={doc.level} fields={fields} labels={props.stateLabels} placeholder="such as `Map Id`"
          title="Which level, map or room the player is on, any value: places are kept per level" onChange={v => change({ level: v })} />
        <Formula label="On the ground (optional)" value={doc.grounded} fields={fields} labels={props.stateLabels} placeholder="true while standing on something"
          title="Only for suggestions: you stood still only while it's true" onChange={v => change({ grounded: v })} />
        {frameError && <div className="pg-warn">{frameError}</div>}
        {Object.entries(frame?.errors ?? {}).map(([k, v]) => <div key={k} className="pg-warn">{k}: {v}</div>)}
        <div className="pg-section-hd">Drawn under it</div>
        {shapeStates.length ? shapeStates.map(n => <label key={n} className="pg-check"><input type="checkbox" checked={doc.draw.includes(n)}
          onChange={e => change(d => ({ draw: e.target.checked ? [...d.draw, n] : d.draw.filter(x => x !== n) }))} />{props.stateLabels[n] ?? n}</label>)
          : <div className="pg-hint">Shapes States (platforms, walls…) can be drawn under it.</div>}
        {!props.capturing && <label className="map-field">Drawn over<select aria-label="Recording drawn over" value={drawnOver} onChange={e => change({ recording: e.target.value })}>
          {!recordings.length && <option value="">No recordings</option>}
          {recordings.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
        <div className="pg-section-hd">Going over it</div>
        <NumberField label="At a place within" value={doc.reach} min={1} max={5000} unit=" px" onChange={v => change({ reach: v })} title="How near a place the player has to be to be at it" />
        <NumberField label="A link fails after" value={doc.linkMs} min={100} max={600000} unit=" ms" onChange={v => change({ linkMs: v })} />
        <NumberField label="At its place within" value={doc.arriveMs} min={0} max={60000} unit=" ms" onChange={v => change({ arriveMs: v })} title="After a link's keys or tree ends, how long the player has to get to its place" />
        <NumberField label="Give up on a link after" value={doc.giveUp} min={1} max={100} unit=" fails" onChange={v => change({ giveUp: v })} title="In a run: a link failing this often isn't planned again until the next" />
        <div className="pg-hint">Each link costs what it took when it last worked (else its clip’s length), over how often it has worked, so a way that fails is taken less.</div>
        <TreeChoice label="Off every place, run" tree={doc.approach?.tree ?? ''} args={doc.approach?.args ?? {}} given={['to']} trees={trees} read={read} fields={fields} labels={props.stateLabels}
          onChange={(tree, args) => change({ approach: tree ? { tree, args } : null })} />
        <button className="modal-btn" onClick={() => change({ ...MAP_DEFAULTS })}>Defaults</button>
      </aside>
      <div className="map-canvas" ref={box}>
        <canvas ref={canvas} tabIndex={0} aria-label="Map" style={{ width: size.width, height: size.height, cursor: mode === 'select' ? 'grab' : 'crosshair' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onKeyDown={e => { if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); removeSelected(); } if (e.key === 'Escape') { setLinkFrom(null); setSelection(null); } }} />
        {!doc.places.length && <div className="map-empty">{doc.position.trim() ? 'Put places where the player goes: + Place, Place at player, or Suggest from recordings.' : 'Say where the player is first, a position State, in Position.'}</div>}
      </div>
      <aside className="map-inspector" aria-label="Map inspector">
        {selectedPlace && <>
          <div className="pg-section-hd">Place</div>
          <label className="map-field">Name<PreservedInput aria-label="Place name" value={selectedPlace.name} onChange={e => setPlace(selectedPlace.id, { name: e.target.value })} /></label>
          <div className="map-row">
            <NumberField label="x" value={selectedPlace.x} min={-1e6} max={1e6} onChange={v => setPlace(selectedPlace.id, { x: v })} />
            <NumberField label="y" value={selectedPlace.y} min={-1e6} max={1e6} onChange={v => setPlace(selectedPlace.id, { y: v })} />
          </div>
          {doc.level.trim() && <label className="map-field">Level<PreservedInput aria-label="Place level" value={selectedPlace.level ?? ''} placeholder="(none)"
            onChange={e => setPlace(selectedPlace.id, { level: e.target.value || null })} /></label>}
          <button className="modal-btn" disabled={!frame?.position} onClick={() => frame?.position && setPlace(selectedPlace.id, { x: Math.round(frame.position[0]), y: Math.round(frame.position[1]), ...(doc.level.trim() ? { level: frame.level } : {}) })}>Move to the player</button>
          <div className="pg-hint">{doc.links.filter(l => l.from === selectedPlace.id).length} links from it · {doc.links.filter(l => l.to === selectedPlace.id).length} to it</div>
          <button className="modal-btn" aria-label="Delete place" onClick={removeSelected}>Delete place</button>
        </>}
        {selectedLink && <>
          <div className="pg-section-hd">Link: {name(selectedLink.from)} → {name(selectedLink.to)}</div>
          <div className="map-row">
            <label className="pg-check"><input type="radio" name="link-kind" checked={selectedLink.kind === 'clip'} onChange={() => setLink(selectedLink.id, { kind: 'clip' })} />A clip</label>
            <label className="pg-check"><input type="radio" name="link-kind" checked={selectedLink.kind === 'tree'} onChange={() => setLink(selectedLink.id, { kind: 'tree' })} />A tree</label>
          </div>
          {selectedLink.kind === 'clip' && <>
            {selectedLink.clip ? <div className="bt-chosen">{recName(selectedLink.clip.recording)} · {((selectedLink.clip.to - selectedLink.clip.from) / 1000).toFixed(2)} s</div>
              : <div className="pg-hint">The keys of a stretch of a recording that went from here to there, played as you pressed them.</div>}
            <label className="map-field">Recording<select aria-label="Link clip recording" value={clipRec || recordings[0]?.id || ''} onChange={e => { setClipRec(e.target.value); setClips(null); }}>
              {recordings.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <button className="modal-btn" disabled={finding || !recordings.length || !doc.position.trim()} onClick={() => void findClips()}>{finding ? 'Finding…' : 'Find clips'}</button>
            {clips && 'error' in clips && <div className="pg-warn">{clips.error}</div>}
            {clips && 'clips' in clips && <div className="pg-list bt-clips" aria-label="Link clips">
              {clips.note && <div className="pg-hint">{clips.note}</div>}
              {[...clips.clips].sort((a, b) => nearness(a, selectedLink) - nearness(b, selectedLink)).slice(0, 40).map((c, k) => {
                const near = nearness(c, selectedLink), on = selectedLink.clip?.from === c.from && selectedLink.clip?.to === c.to;
                return <button key={k} className={`bt-clip-row ${on ? 'bt-clip-on' : ''}`} onClick={() => setLink(selectedLink.id, { clip: { recording: clipRec || recordings[0]!.id, from: c.from, to: c.to } })}>
                  <b>({Math.round(c.start[0])}, {Math.round(c.start[1])}) → ({Math.round(c.end[0])}, {Math.round(c.end[1])})</b> in {(c.ms / 1000).toFixed(2)} s
                  <small>{near <= 2 * doc.reach ? 'from here to there' : `${Math.round(near)} px off`} · {[...new Set(c.keys.filter(e => e[2]).map(e => buttonLabel(e[1])))].join(', ') || 'nothing pressed'}</small>
                </button>;
              })}
            </div>}
          </>}
          {selectedLink.kind === 'tree' && <TreeChoice label="Tree" tree={selectedLink.tree ?? ''} args={selectedLink.args ?? {}} given={['from', 'to']} trees={trees} read={read} fields={fields} labels={props.stateLabels}
            onChange={(tree, args) => setLink(selectedLink.id, { tree, args })} />}
          {(() => { const s = stats[selectedLink.id]; return <div className="pg-hint">{s?.runs ? `Run ${s.runs} time${s.runs === 1 ? '' : 's'}, worked ${s.runs - s.fails}${s.ms ? `, taking ${(s.ms / 1000).toFixed(2)} s` : ''}` : 'Not run yet'}{live?.fails?.[selectedLink.id] ? ` · failed ${live.fails[selectedLink.id]} this run` : ''}</div>; })()}
          {!has(selectedLink.to, selectedLink.from) && <button className="modal-btn" onClick={() => newLink(selectedLink.to, selectedLink.from, { kind: selectedLink.kind, tree: selectedLink.tree, args: selectedLink.args })}>Add the way back</button>}
          <button className="modal-btn" aria-label="Delete link" onClick={removeSelected}>Delete link</button>
        </>}
        {!selection && <>
          <div className="pg-section-hd">From your recordings</div>
          <button className="modal-btn" disabled={suggesting || !recordings.length || !doc.position.trim()} onClick={() => void suggest()}>{suggesting ? 'Reading recordings…' : 'Suggest places and links'}</button>
          <div className="pg-hint">Places where you stood still, and links for each stretch between two places, the quickest you made.</div>
          {suggested && 'error' in suggested && <div className="pg-warn">{suggested.error}</div>}
          {suggested && 'links' in suggested && <div className="pg-list map-suggested" aria-label="Suggestions">
            {suggested.links.filter(l => !has(l.from, l.to)).length > 0 && <button className="modal-btn" onClick={() => change(d => ({ links: [...d.links, ...suggested.links.filter(l => !has(l.from, l.to))
              .map(l => ({ id: crypto.randomUUID(), from: l.from, to: l.to, kind: 'clip' as const, clip: l.clip }))] }))}>Add every link</button>}
            {suggested.links.map((l, k) => <div key={'l' + k} className="map-suggestion">{name(l.from)} → {name(l.to)} <small>{(l.ms / 1000).toFixed(2)} s · made {l.count}×</small>
              {has(l.from, l.to) ? <small> (a link)</small> : <button className="bt-add" onClick={() => newLink(l.from, l.to, { kind: 'clip', clip: l.clip })}>Add</button>}</div>)}
            {suggested.places.slice(0, 30).map((p, k) => <div key={'p' + k} className="map-suggestion">Stood at ({Math.round(p.x)}, {Math.round(p.y)}){p.level != null ? ` on ${p.level}` : ''} <small>{p.n}×</small>
              <button className="bt-add" onClick={() => { newPlace(p.x, p.y, p.level); setSuggested(s => s && 'places' in s ? { ...s, places: s.places.filter(q => q !== p) } : s); }}>Add</button></div>)}
            {!suggested.links.length && !suggested.places.length && <div className="pg-hint">Nothing to suggest: add places where you stood, then suggest again for the links between them.</div>}
          </div>}
          <div className="pg-section-hd">Learned</div>
          <div className="pg-hint">{Object.keys(stats).length ? `${Object.keys(stats).length} links run ${Object.values(stats).reduce((n, s) => n + s.runs, 0)} times` : 'Nothing yet: it learns how each link goes as trees go over it.'}</div>
          <button className="modal-btn" disabled={!Object.keys(stats).length || !!live} onClick={() => void window.bridge.policy.invoke('map.stats', { map: props.graphId, forget: true }).then(() => setStats({}))}>Forget what it learned</button>
          {problems.length > 0 && <><div className="pg-section-hd">To put right</div>{problems.map((p, k) => <div key={k} className="pg-warn">{p}</div>)}</>}
        </>}
      </aside>
    </div>
  </div>;
}

// a link's line, moved aside when there's a way back, so both show
function offsetLine([ax, ay]: [number, number], [bx, by]: [number, number], aside: boolean): [[number, number], [number, number]] {
  const len = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / len, ny = (bx - ax) / len, o = aside ? 4 : 0;
  const ux = (bx - ax) / len, uy = (by - ay) / len, cut = Math.min(8, len / 3);
  return [[ax + nx * o + ux * cut, ay + ny * o + uy * cut], [bx + nx * o - ux * cut, by + ny * o - uy * cut]];
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
