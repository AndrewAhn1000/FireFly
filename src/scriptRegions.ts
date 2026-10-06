export interface ScriptBox { x: number; y: number; w: number; h: number; }
export interface ScriptGeometry {
  windowW?: number; windowH?: number;
  // The client area within the captured window, in normalized image coordinates.
  clientArea?: ScriptBox;
}

export interface RegionBoxSnapshot { boxes: ScriptBox[]; timestamp: number; }
// A hidden Lua Region's script doesn't run, so it has no boxes, and is marked off for the scripts reading it
export function luaRegionSnapshot(regions: (ScriptBox & { id: string; label: string; source?: string; match?: boolean; visible?: boolean })[], dynamic: Record<string, RegionBoxSnapshot>) {
  return regions.map(r => {
    const moving = r.source === 'script' || r.match === true;
    const off = r.source === 'script' && r.visible === false;
    const snapshot = moving && !off ? dynamic[r.id] : undefined;
    return { id: r.id, label: r.label, dynamic: moving, valid: !off && (!moving || !!snapshot), ...(off ? { off: true } : {}),
      timestamp: snapshot?.timestamp ?? 0,
      boxes: moving ? snapshot?.boxes ?? [] : [{ x: r.x, y: r.y, w: r.w, h: r.h }] };
  });
}

export function scriptRegionBoxes(raw: unknown, geometry: ScriptGeometry, width = 0, height = 0): ScriptBox[] {
  const sw = width || geometry.windowW || 0, sh = height || geometry.windowH || 0;
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0)
    throw Error('Set the script coordinate size or start capture to use the current game window size.');
  const area = geometry.clientArea ?? { x: 0, y: 0, w: 1, h: 1 };
  const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  // An empty Lua table arrives as {}, whether it was intended as a list or object.
  if (raw == null || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0)) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(item => {
    if (!item || typeof item !== 'object') throw Error('Expected {x,y,w,h} or an array of boxes.');
    const b = item as Record<string, unknown>;
    let x = b.x, y = b.y, w = b.w, h = b.h;
    if ([b.x1, b.y1, b.x2, b.y2].every(numeric)) {
      x = Math.min(b.x1 as number, b.x2 as number); y = Math.min(b.y1 as number, b.y2 as number);
      w = b.w ?? Math.abs((b.x2 as number) - (b.x1 as number)); h = b.h ?? Math.abs((b.y2 as number) - (b.y1 as number));
    }
    if (!numeric(x) || !numeric(y) || !numeric(w) || !numeric(h) || w < 0 || h < 0)
      throw Error('Boxes need finite x, y, w and h values, with non-negative width and height.');
    return { x: area.x + x / sw * area.w, y: area.y + y / sh * area.h, w: w / sw * area.w, h: h / sh * area.h };
  });
}
