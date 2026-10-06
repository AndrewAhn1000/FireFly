export interface TemplateMatch {
  x: number; y: number; w: number; h: number; confidence: number; templateId?: string;
}
export interface TemplateSnapshot { regionId: string; matches: TemplateMatch[]; }
export const TEMPLATE_DETECTED = '@template-detected';
// Where a followed region's box is, and how fast it moves: vectors in window px and px per second
export const REGION_POSITION = '@position';
export const REGION_VELOCITY = '@velocity';
// Where every match is: shapes, a point at each match's centre (multi-match: every instance)
export const REGION_MATCHES = '@matches';
export const MOTION_LABELS: Record<string, string> = { [REGION_POSITION]: 'Position', [REGION_VELOCITY]: 'Velocity', [REGION_MATCHES]: 'Every match' };
export interface RegionMotion { position: [number, number] | null; velocity: [number, number] | null; }
export interface TemplateSelection { templateId?: string; templateIds?: string[]; }
// Existing saved single-template states keep their selection. Undefined means
// any winning template; an explicit empty list means none, never any.
export function selectedTemplateIds(state: TemplateSelection): string[] | undefined {
  return state.templateIds ?? (state.templateId ? [state.templateId] : undefined);
}

// How long a template state's new answer has to hold before the state takes it, by default: none, since
// the two things that made states flicker are handled where they happen, without delaying real changes.
// A frame the object isn't recognised in holds the state (LOST_HOLD_MS), and a template that won the
// object keeps it unless another matches clearly better (the runtime's kStick in tracking.cpp).
export const TEMPLATE_SETTLE_MS = 0;
// How long a template state keeps its answer while its region's object isn't found at all: not being
// recognised for a moment says nothing about which template it is. Longer, and it's really gone.
export const LOST_HOLD_MS = 500;
// A template state's answer as it has settled: `value` is what it shows, and `next` is a different answer
// seen since `since` (capture ms) that it takes once that has held for its settle time; `lostSince` is
// when the object stopped being found. `key` is the selection and settle time it was worked out for, so
// changing either doesn't wait for new frames.
export interface Settled { key: string; value: boolean | undefined; next?: boolean; since?: number; lostSince?: number; }

// Takes a new raw answer at capture time `at`. While the object isn't found (`found` false) the answer
// is kept for up to LOST_HOLD_MS. A settle time, if set, makes any other new answer wait that long too.
// With no capture time, or no answer to keep, the raw answer is taken at once.
export function settle(prev: Settled | undefined, raw: boolean | undefined, at: number | null, key: string, ms: number, found = true): Settled {
  if (!found && prev && prev.key === key && prev.value !== undefined && at !== null) {
    const lostSince = prev.lostSince ?? at;
    if (at - lostSince < LOST_HOLD_MS) return { ...prev, lostSince };
  }
  if (!prev || prev.key !== key || prev.value === undefined || raw === undefined || at === null || ms <= 0 || raw === prev.value)
    return { key, value: raw };
  if (prev.next !== raw || prev.since === undefined) return { key, value: prev.value, next: raw, since: at };
  return at - prev.since >= ms ? { key, value: raw } : { ...prev, lostSince: undefined };
}

export function strongestMatch(matches: TemplateMatch[]): TemplateMatch | undefined {
  return matches.reduce<TemplateMatch | undefined>((best, m) =>
    Number.isFinite(m.confidence) && (!best || m.confidence > best.confidence) ? m : best, undefined);
}

// A specific template is present only if it won an instance, not just because
// its score also passed the threshold. No snapshot means unavailable, not false.
export function templateDetected(snapshot: TemplateSnapshot | null, regionId: string,
    selection: string | string[] | undefined, availableIds: string[]): boolean | undefined {
  if (!snapshot || !availableIds.length || snapshot.regionId !== regionId) return undefined;
  const ids = typeof selection === 'string' ? [selection] : selection;
  if (ids?.length && !ids.some(id => availableIds.includes(id))) return undefined;
  return snapshot.matches.some(m => !!m.templateId && availableIds.includes(m.templateId) &&
    (ids === undefined || ids.includes(m.templateId)));
}
