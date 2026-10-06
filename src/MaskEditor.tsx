import { useCallback, useEffect, useRef, useState } from 'react';

// Painting which of a template's pixels are the object: only those count when it's matched
// (native/template_match.cpp, Pattern::mask), so the background around a sprite, which changes as it
// moves, doesn't count for or against it. The mask is a grayscale PNG the template's size, white where a
// pixel counts; no mask (every pixel counts) is undefined.
//
// Tools: a brush, and a magic wand that takes the area of about the clicked colour (only what joins it,
// or everywhere), each leaving pixels out or keeping them; and a one-click background removal.

type Tool = 'brush' | 'wand';
type Mode = 'out' | 'keep';

interface Props { src: string; mask?: string; onChange(mask: string | undefined): void; }

const MAX_W = 360, MAX_H = 260;

export default function MaskEditor({ src, mask, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const image = useRef<ImageData | null>(null);
  const keep = useRef<Uint8Array | null>(null); // 1 where a pixel counts
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('wand');
  const [mode, setMode] = useState<Mode>('out');
  const [brush, setBrush] = useState(3);
  const [tolerance, setTolerance] = useState(24);
  const [contiguous, setContiguous] = useState(true);
  const [kept, setKept] = useState(1);
  const painting = useRef(false);
  const zoom = size ? Math.max(1, Math.floor(Math.min(MAX_W / size.w, MAX_H / size.h))) : 1;

  // The template, with what's left out dimmed and tinted, and what the wand would take shown in cyan
  const draw = useCallback((preview?: Uint8Array | null) => {
    const c = canvasRef.current, img = image.current, k = keep.current;
    if (!c || !img || !k) return;
    const g = c.getContext('2d')!;
    const out = new ImageData(img.width, img.height);
    let n = 0;
    for (let i = 0; i < k.length; i++) {
      const o = i * 4;
      if (k[i]) { out.data[o] = img.data[o]; out.data[o + 1] = img.data[o + 1]; out.data[o + 2] = img.data[o + 2]; n++; }
      else {
        const x = i % img.width, y = (i / img.width) | 0, check = ((x >> 2) + (y >> 2)) & 1 ? 70 : 45;
        out.data[o] = check + img.data[o] * 0.15 + 60; out.data[o + 1] = check + img.data[o + 1] * 0.15; out.data[o + 2] = check + img.data[o + 2] * 0.15 + 60;
      }
      if (preview?.[i]) { out.data[o] = out.data[o] * 0.4; out.data[o + 1] = out.data[o + 1] * 0.4 + 150; out.data[o + 2] = out.data[o + 2] * 0.4 + 150; }
      out.data[o + 3] = 255;
    }
    const small = document.createElement('canvas');
    small.width = img.width; small.height = img.height;
    small.getContext('2d')!.putImageData(out, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(small, 0, 0, c.width, c.height);
    setKept(n / k.length);
  }, []);

  // The template and its mask, as pixels
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, w, h);
      const k = new Uint8Array(w * h).fill(1);
      const done = () => { if (!alive) return; image.current = data; keep.current = k; setSize({ w, h }); };
      if (!mask) { done(); return; }
      const m = new Image();
      m.onload = () => {
        g.clearRect(0, 0, w, h); g.drawImage(m, 0, 0, w, h);
        const md = g.getImageData(0, 0, w, h).data;
        for (let i = 0; i < k.length; i++) k[i] = md[i * 4] > 127 ? 1 : 0;
        done();
      };
      m.onerror = done;
      m.src = mask;
    };
    img.src = src;
    return () => { alive = false; };
  }, [src]); // only a different template reloads it; its own saves shouldn't
  useEffect(() => { draw(); }, [size, zoom, draw]);

  const commit = useCallback(() => {
    const k = keep.current, img = image.current;
    if (!k || !img) return;
    if (k.every(v => v)) { onChange(undefined); return; }
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const out = new ImageData(img.width, img.height);
    for (let i = 0; i < k.length; i++) { const v = k[i] ? 255 : 0; out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255; }
    c.getContext('2d')!.putImageData(out, 0, 0);
    onChange(c.toDataURL('image/png'));
  }, [onChange]);

  const pixelAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), w = size?.w ?? 1, h = size?.h ?? 1;
    return { x: Math.min(w - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * w))),
             y: Math.min(h - 1, Math.max(0, Math.floor((e.clientY - r.top) / r.height * h))) };
  };
  const near = (img: ImageData, a: number, b: number) =>
    Math.abs(img.data[a * 4] - img.data[b * 4]) + Math.abs(img.data[a * 4 + 1] - img.data[b * 4 + 1]) + Math.abs(img.data[a * 4 + 2] - img.data[b * 4 + 2]) <= tolerance * 3;

  // The pixels of about the colour of these starting pixels: grown from each through pixels close to the
  // colour it started from (not to their neighbour, which creeps across a soft edge into the object), or,
  // not contiguous, every such pixel anywhere
  const similar = (starts: number[], joined: boolean): Uint8Array => {
    const img = image.current!, { width: w, height: h } = img, taken = new Uint8Array(w * h);
    if (!joined) {
      for (let i = 0; i < taken.length; i++) if (starts.some(s => near(img, i, s))) taken[i] = 1;
      return taken;
    }
    const stack: [number, number][] = [];
    for (const s of starts) if (!taken[s]) { taken[s] = 1; stack.push([s, s]); }
    while (stack.length) {
      const [i, from] = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || taken[j]) continue;
        if (near(img, j, from)) { taken[j] = 1; stack.push([j, from]); }
      }
    }
    return taken;
  };
  const apply = (taken: Uint8Array, value: 0 | 1) => {
    const k = keep.current!;
    for (let i = 0; i < k.length; i++) if (taken[i]) k[i] = value;
    draw(); commit();
  };
  const paint = (x: number, y: number) => {
    const k = keep.current, img = image.current;
    if (!k || !img) return;
    const r = brush - 1, v = mode === 'keep' ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < img.width && yy < img.height && dx * dx + dy * dy <= r * r + r) k[yy * img.width + xx] = v;
    }
    draw();
  };
  // The background: grown in from the template's edges, but only from edge pixels in the edge's common
  // colours, since the object often touches an edge, and growing from its own pixels eats into it
  const leaveOutBackground = () => {
    const img = image.current;
    if (!img) return;
    const { width: w, height: h } = img, edge: number[] = [];
    for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
    const bin = (i: number) => ((img.data[i * 4] >> 5) << 6) | ((img.data[i * 4 + 1] >> 5) << 3) | (img.data[i * 4 + 2] >> 5);
    const counts = new Map<number, number>();
    for (const i of edge) counts.set(bin(i), (counts.get(bin(i)) ?? 0) + 1);
    const common = new Set([...counts].filter(([, n]) => n >= edge.length * 0.08).map(([b]) => b));
    apply(similar(edge.filter(i => common.has(bin(i))), true), 0);
  };
  const setAll = (v: 0 | 1 | 'invert') => {
    const k = keep.current;
    if (!k) return;
    for (let i = 0; i < k.length; i++) k[i] = v === 'invert' ? (k[i] ? 0 : 1) : v;
    draw(); commit();
  };

  if (!size) return <div className="mask-editor mask-loading">Loading…</div>;
  return <div className="mask-editor">
    <canvas ref={canvasRef} width={size.w * zoom} height={size.h * zoom} className="mask-canvas" aria-label="Template mask"
      style={{ cursor: tool === 'wand' ? 'crosshair' : 'cell' }}
      onPointerDown={e => {
        const { x, y } = pixelAt(e);
        if (tool === 'wand') { apply(similar([y * size.w + x], contiguous), mode === 'keep' ? 1 : 0); return; }
        painting.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* strokes still paint without capture */ }
        paint(x, y);
      }}
      onPointerMove={e => {
        const { x, y } = pixelAt(e);
        if (painting.current) paint(x, y);
        else if (tool === 'wand') draw(similar([y * size.w + x], contiguous)); // what a click would take
      }}
      onPointerUp={() => { if (painting.current) { painting.current = false; commit(); } }}
      onPointerLeave={() => { if (!painting.current) draw(); }} />
    <div className="mask-tools">
      <div className="mask-tool-row">
        <span className="mask-row-lbl">Tool</span>
        {([['wand', 'Magic wand'], ['brush', 'Brush']] as const).map(([id, label]) =>
          <button key={id} className={`mask-tool ${tool === id ? 'mask-tool-on' : ''}`} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
        <span className="mask-row-lbl">does</span>
        {([['out', 'Leave out'], ['keep', 'Keep']] as const).map(([id, label]) =>
          <button key={id} className={`mask-tool ${mode === id ? 'mask-tool-on' : ''}`} aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}
      </div>
      {tool === 'wand'
        ? <label className="mask-check"><input type="checkbox" checked={contiguous} onChange={e => setContiguous(e.target.checked)} /> Only the area joined to where you click (off: that colour everywhere)</label>
        : <label className="mask-slider">Brush <input type="range" min={1} max={12} value={brush} onChange={e => setBrush(Number(e.target.value))} /><span>{brush * 2 - 1} px</span></label>}
      <label className="mask-slider">Colour tolerance <input type="range" min={2} max={80} value={tolerance} onChange={e => setTolerance(Number(e.target.value))} /><span>{tolerance}</span></label>
      <div className="mask-tool-row">
        <button className="mask-tool" onClick={leaveOutBackground} title="Leave out what joins the template's edges in their common colours, working inwards">Leave out the background</button>
        <button className="mask-tool" onClick={() => setAll('invert')}>Invert</button>
        <button className="mask-tool" onClick={() => setAll(1)}>Keep everything</button>
      </div>
      <div className="rtp-hint">{Math.round(kept * 100)}% of its pixels count; the dimmed, tinted ones don't. {tool === 'wand'
        ? 'Hover to see what a click takes (cyan); raise the tolerance to take more.' : 'Drag to paint.'} Leave out what isn't the object, such as the ground behind it.</div>
    </div>
  </div>;
}
