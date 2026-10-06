import { useEffect, useState } from 'react';

// What a region's templates are matched on (native/template_match.hpp, Look), and how a template looks
// to the matcher that way, for its thumbnail: its colours, its brightness, or its edges.
export type MatchLook = 'color' | 'gray' | 'edges';

export const MATCH_LOOKS: { id: MatchLook; label: string; hint: string }[] = [
  { id: 'color', label: 'Colour', hint: 'Matches colours as they are. Best when the object always looks the same.' },
  { id: 'gray', label: 'Grayscale', hint: 'Matches brightness only, so the same pose in another colour or tint still matches. Also the fastest.' },
  { id: 'edges', label: 'Edges', hint: 'Matches outlines, whatever their colours or how light or dark they are, but lookalikes score higher too: raise the threshold, and give it a search reach, since searching the whole window is slow this way.' },
];

// The edges of an image as the runtime works them out: grayscale, a light blur, and how sharply
// brightness changes (the mean of |dx| and |dy| of a 3×3 Sobel)
function edgesOf(src: ImageData): ImageData {
  const { width: w, height: h, data } = src;
  const gray = new Float32Array(w * h), blur = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const at = (a: Float32Array, x: number, y: number) => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const k = [1, 2, 1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += k[i + 1] * k[j + 1] * at(gray, x + i, y + j);
    blur[y * w + x] = s / 16;
  }
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = at(blur, x + 1, y - 1) + 2 * at(blur, x + 1, y) + at(blur, x + 1, y + 1) - at(blur, x - 1, y - 1) - 2 * at(blur, x - 1, y) - at(blur, x - 1, y + 1);
    const dy = at(blur, x - 1, y + 1) + 2 * at(blur, x, y + 1) + at(blur, x + 1, y + 1) - at(blur, x - 1, y - 1) - 2 * at(blur, x, y - 1) - at(blur, x + 1, y - 1);
    const v = Math.min(255, (Math.abs(dx) + Math.abs(dy)) / 2), o = (y * w + x) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v; out.data[o + 3] = 255;
  }
  return out;
}

const edgesCache = new Map<string, string>();

// A template's thumbnail as the matcher sees it
export default function LookThumb({ src, look, className, alt, title }: { src: string; look: MatchLook; className?: string; alt?: string; title?: string }) {
  const [edges, setEdges] = useState<string | null>(() => look === 'edges' ? edgesCache.get(src) ?? null : null);
  useEffect(() => {
    if (look !== 'edges') return;
    const cached = edgesCache.get(src);
    if (cached) { setEdges(cached); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      g.putImageData(edgesOf(g.getImageData(0, 0, c.width, c.height)), 0, 0);
      const url = c.toDataURL('image/png');
      edgesCache.set(src, url);
      if (alive) setEdges(url);
    };
    img.src = src;
    return () => { alive = false; };
  }, [src, look]);
  return <img src={look === 'edges' ? edges ?? src : src} className={className} alt={alt} title={title}
    style={look === 'gray' ? { filter: 'grayscale(1)' } : undefined} />;
}
