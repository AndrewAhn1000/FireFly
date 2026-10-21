import { useState } from 'react';
import { buttonLabel } from './Keyboard';
import { cleanError } from './policyPlay';

// A run's recorded movements against their recordings (the worker's behavior.replay, worker/replay_report.py):
// measurement only. Per key event: when it was due and sent, the recorded and live positions at its due time (each
// observed or interpolated, and how far from a real reading), the raw error, and the lag that best lines the two
// paths up with the error left after it, side by side so neither hides the other.

interface Point { x: number; y: number; level: unknown; nearestMs: number; interpolated: boolean; }
export interface KeyEvent {
  index: number; at: number; part?: number; liveAt?: number | null; button: string; down: boolean; sentMs: number | null; lateMs: number | null; returnedMs: number | null;
  outcome: string | null; recorded: Point | null; live: Point | null; errorPx: number | null; lagMs: number | null; alignedErrorPx: number | null;
}
// lining up with a recorded start by tapping (worker/behavior.py's _line_up): from and to where, each tap and what it moved
export interface LineUp {
  target: [number, number]; from: [number, number]; to: [number, number]; offPx: number; worked: boolean; why?: string;
  taps: { axis: string; keys: string[]; ms: number; errorPx: number; movedPx?: number }[];
}
export interface Attempt {
  attempt: number | string; link: string | null; map: string; lineUp?: LineUp | null; problem?: string; clip?: { recording: string; from: number; to: number };
  // false: a link that isn't a recorded movement (a tree, keys, a hand-made clip), listed with how it went
  recorded?: boolean; kind?: string | null; from?: string | null; to?: string | null; position?: [number, number] | null; ms?: number | null;
  recordedEnd?: [number, number];
  // both paths, [elapsed ms, x, y]
  recordedPath?: [number, number, number][]; livePath?: [number, number, number][];
  // a movement played in parts, each after a wait for the map's Wait for State, and how each wait went
  parts?: number; syncs?: { index: number; worked: boolean; waitedMs?: number | null; lateMs?: number | null; why?: string | null }[];
  recordedStart?: [number, number]; recordedMs?: number; startOffsetPx?: number | null; actionId?: number; durationMs?: number; startedAt?: number;
  executor?: { state: string | null; cause: string | null; error: string | null; ranMs: number; maxLateMs: number; sent: number; emitted: number };
  // recovered: one that reached its platform but not its place, whether lining up put it right (null: not known)
  // arrival: how a recorded movement that worked got onto its end, as played ('direct') or by its terminal correction
  // ('corrected', worker/behavior.py's _finish), whose taps and facing are `finish`
  ended?: { worked: boolean | null; cause: string | null; why: string | null; recovered?: boolean | null; recoveredHow?: string | null;
    arrival?: 'direct' | 'corrected'; finish?: Finish } | null;
  outcome?: Outcome | null;
  readings?: { fresh: number; reused: number; inferred: boolean; medianGapMs: number | null; readLagMs: { median: number; max: number } | null };
  thresholdPx?: number; reliableMs?: number; firstOverMs?: number | null; lastOnsetMs?: number | null; maxErrorPx?: number | null;
  firstOverEvent?: number | null; continuedMs?: number | null; events?: KeyEvent[]; series?: [number, number | null, number | null][];
  jumps?: JumpRow[] | null; unsafe?: string | null; takeoffMode?: 'timed' | 'adaptive' | null;
}
// a recorded movement's terminal correction: the taps that put it on its end (and faced it as recorded), the trailing
// presses left out for it, and whether the recording's facing was kept
export interface Finish {
  worked: boolean; arrival?: 'direct' | 'corrected'; taps: { axis: string; keys: string[]; ms: number; movedPx?: number; facing?: boolean }[];
  corrections: number; offPx: number; dropped: [number, string][]; why?: string; ms?: number;
  // kept: on evidence a press that way was taken (it moved the player); null: one was sent, not known to be taken
  facing?: { recorded: string; kept: boolean | null; why?: string };
}
export type Outcome = 'direct' | 'corrected' | 'recovered' | 'failed';
// a run's attempts counted by outcome, apart, with how many there were and how many were retries
export interface Summary { attempts: number; direct: number; corrected: number; recovered: number; failed: number; unended: number; retries: number; }
export interface Report { attempts: Attempt[]; notes: string[]; summary?: Summary; }
export const summaryText = (s: Summary) => `${s.attempts} attempt${s.attempts === 1 ? '' : 's'}: ${s.direct} straight onto their end, ${s.corrected} corrected onto it, `
  + `${s.recovered} put right after, ${s.failed} failed${s.unended ? `, ${s.unended} not ended` : ''} · ${s.retries} retr${s.retries === 1 ? 'y' : 'ies'}`;
// a terminal correction, in a line
export const finishText = (f: Finish) => {
  const taps = f.taps.filter(t => !t.facing);
  return (f.worked ? (taps.length ? `corrected onto its end in ${taps.length} tap${taps.length === 1 ? '' : 's'} (${taps.map(t => `${t.keys.join('+')} ${Math.round(t.ms)} ms`).join(', ')})` : 'onto its end as played')
    : `its end couldn’t be corrected: ${f.why ?? ''}`)
    + (f.dropped.length ? `; left out ${f.dropped.map(([at, k]) => `${k} at ${Math.round(at)} ms`).join(', ')}` : '')
    + (f.facing ? (f.facing.kept ? `; facing ${f.facing.recorded} as recorded` : f.facing.kept === null ? `; a tap ${f.facing.recorded} sent to face it as recorded (${f.facing.why ?? ''})`
      : `; not faced ${f.facing.recorded} as recorded (${f.facing.why ?? ''})`) : '');
};
// one of a movement's recorded jumps as it went (worker/replay_report.py's _jumps): how it was to be pressed, where it
// took off when the guard sent it, where the model said that lands, and where it landed
export interface JumpRow {
  index: number; at: number; status: 'adapt' | 'unsafe' | 'narrow' | 'position' | 'walkoff' | 'timed'; why?: string | null; mode?: 'timed' | 'adaptive'; forced?: boolean;
  demoX?: number; interval?: [number, number] | null; window?: [number, number] | null; aim?: number | null;
  plan?: { worked: boolean; why?: string | null; leadMs?: number; estX?: number; observedX?: number; waitedMs?: number; readAgeMs?: number; repositions?: number; aimShift?: number; prepMs?: number | null };
  stopWatched?: { fromX: number; stoppedX: number; ms: number; stopPx: number };
  walkedBack?: { fromX: number; to: number }[];
  outcome?: { tookOff: boolean; ms?: number; aimShift?: number; nextShift?: number };
  sent?: boolean; sentMs?: number; takeoffX?: number; inInterval?: boolean;
  predicted?: { x: number; on: 'target' | 'start' } | null; landed?: { x?: number; y?: number; on: 'target' | 'start' | 'elsewhere' | 'fell' | 'no jump'; ms?: number } | null;
  worked?: boolean; landingErrorPx?: number; modelOff?: boolean;
}

const ms = (v: number | null | undefined, digits = 0) => v == null ? '—' : `${v.toFixed(digits)} ms`;
const px = (v: number | null | undefined) => v == null ? '—' : `${v.toFixed(1)} px`;
const s = (v: number | null | undefined) => v == null ? '—' : `${(v / 1000).toFixed(2)} s`;
const at = (p: Point | null) => p ? `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})${p.interpolated ? ` ~${p.nearestMs.toFixed(0)} ms` : ''}` : '—';

// The raw error along the replay: dots at readings whose recorded position is near a real recorded reading, faint
// where it's interpolated further than that; the threshold as a line, and where the divergence it ended in began
function ErrorChart({ a }: { a: Attempt }) {
  const series = (a.series ?? []).filter(p => p[1] != null) as [number, number, number | null][];
  if (!series.length) return <div className="pg-hint">No live readings to compare.</div>;
  const w = 560, h = 90, end = Math.max(a.durationMs ?? 0, series[series.length - 1][0], 1);
  const top = Math.max(a.thresholdPx ?? 8, ...series.map(p => p[1])) * 1.1;
  const x = (t: number) => (t / end) * w, y = (d: number) => h - (d / top) * h;
  const reliable = (p: [number, number, number | null]) => p[2] != null && p[2] <= (a.reliableMs ?? 25);
  return <svg className="rr-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
    aria-label={`Raw error over ${s(end)}, up to ${top.toFixed(0)} px`}>
    <line x1={0} x2={w} y1={y(a.thresholdPx ?? 8)} y2={y(a.thresholdPx ?? 8)} className="rr-threshold" />
    {a.lastOnsetMs != null && <rect x={x(a.lastOnsetMs)} y={0} width={Math.max(1, w - x(a.lastOnsetMs))} height={h} className="rr-diverged" />}
    <polyline points={series.map(p => `${x(p[0])},${y(p[1])}`).join(' ')} className="rr-line" />
    {series.map((p, i) => <circle key={i} cx={x(p[0])} cy={y(p[1])} r={1.6} className={reliable(p) ? 'rr-dot' : 'rr-dot rr-faint'} />)}
  </svg>;
}

// lining up, in a line: how far it started and ended, and each tap's length and move
export const lineUpText = (l: LineUp) => `${l.worked ? 'Lined up' : 'Couldn’t line up'} with (${Math.round(l.target[0])}, ${Math.round(l.target[1])}) from ${Math.round(Math.hypot(l.from[0] - l.target[0], l.from[1] - l.target[1]))} px off to ${l.offPx.toFixed(1)}`
  + (l.taps.length ? ` in ${l.taps.length} tap${l.taps.length === 1 ? '' : 's'}: ${l.taps.map(t => `${t.keys.map(buttonLabel).join('+')} ${Math.round(t.ms)} ms${t.movedPx != null ? ` → ${t.movedPx > 0 ? '+' : ''}${t.movedPx} px` : ''}`).join(', ')}` : '')
  + (l.why ? ` (${l.why})` : '');

// a movement in parts: how each wait for the map's Wait for State went
export const syncText = (a: Attempt) => {
  const s = a.syncs ?? [];
  const failed = s.find(x => !x.worked);
  return `Played in ${a.parts ?? 1} part${(a.parts ?? 1) === 1 ? '' : 's'}, waiting ${s.length} time${s.length === 1 ? '' : 's'}`
    + (s.filter(x => x.worked).length ? `: waited ${s.filter(x => x.worked).map(x => `${Math.round(x.waitedMs ?? 0)} ms`).join(', ')} after each part's last press` : '')
    + (failed ? `; a wait failed: ${failed.why}` : '');
};

const landedText = (l: JumpRow['landed']) => !l ? '—' : l.on === 'no jump' ? 'didn’t jump'
  : `${l.on === 'target' ? 'on its target' : l.on === 'start' ? 'back where it left' : l.on === 'fell' ? 'fell below both lines' : 'elsewhere'}${l.x != null ? ` at ${l.x.toFixed(0)}` : ''}`;
const stretch = (r?: [number, number] | null) => r ? `${r[0].toFixed(0)}..${r[1].toFixed(0)}` : 'none';

// what held a press back or saved it: as long after its landing as recorded, and a stop watched before walking back
const pressNotes = (j: JumpRow) => `${j.plan?.worked && j.plan.prepMs != null ? `, ${j.plan.prepMs.toFixed(0)} ms after landing as recorded` : ''}${j.stopWatched ? `, after it stopped at ${j.stopWatched.stoppedX.toFixed(0)} with nothing held (${j.stopWatched.ms.toFixed(0)} ms; ${j.stopWatched.stopPx.toFixed(0)} px reckoned)` : ''}`;

// a movement's jumps: how each was to be pressed, and where it took off and landed against the model
function Jumps({ a }: { a: Attempt }) {
  const rows = a.jumps ?? [];
  if (!rows.length) return null;
  const how = (j: JumpRow) => j.status === 'timed' ? `timed (${j.why})` : j.status === 'walkoff' ? 'a walk off its edge, its jump key pressed in the air (did nothing in the recording): as recorded' : j.status === 'position' && j.mode === 'adaptive'
    ? `pressed by position at ${j.aim?.toFixed(0)}${j.plan?.aimShift ? ` (${j.plan.aimShift} px further from the edge, learned)` : ''}, the rest as recorded${j.walkedBack?.length ? `, after walking back ${j.walkedBack.length}×` : ''}${pressNotes(j)}${j.plan && !j.plan.worked ? `: ${j.plan.why}` : ''}${j.outcome ? (j.outcome.tookOff ? '' : `; didn’t take off${j.outcome.nextShift ? `, next aimed ${j.outcome.nextShift} px further in` : ''}`) : ''}`
    : j.mode === 'adaptive' && (j.status === 'adapt' || j.forced)
    ? `${j.forced ? 'unsafe, pressed anyway' : 'pressed where safe'}${j.walkedBack?.length ? ` after walking back ${j.walkedBack.map(w => `from ${w.fromX.toFixed(0)} to ${w.to.toFixed(0)}`).join(', then ')}` : ''}${j.plan ? (j.plan.worked ? `: ${j.plan.leadMs?.toFixed(0)} ms after deciding, aiming at ${j.aim?.toFixed(0)}${pressNotes(j)}` : `: ${j.plan.why}`) : ''}`
    : `timed as recorded${j.status !== 'adapt' ? ` (${j.status}: ${j.why})` : ''}`;
  return <>
    <div className="pg-section-hd">Jumps · {a.takeoffMode === 'adaptive' ? 'pressed where it’s safe' : 'timed as recorded'}{a.unsafe ? ' · marked unsafe' : ''}</div>
    {a.unsafe && <div className="pg-hint">Unsafe: {a.unsafe}</div>}
    <table className="rr-jumps" aria-label="Jumps"><thead><tr>
      <th>#</th><th>Pressed</th><th>Recorded at</th><th>Safe stretch</th><th>Took off</th><th>Model: lands</th><th>Landed</th><th>Off by</th>
    </tr></thead><tbody>
      {rows.map(j => <tr key={j.index} className={j.worked === false ? 'rr-failed' : undefined}>
        <td>{j.index + 1}</td><td>{how(j)}</td><td>{j.demoX != null ? j.demoX.toFixed(0) : '—'}</td>
        <td>{j.status === 'timed' || j.status === 'walkoff' ? '—' : j.status === 'position' ? `by ${j.aim?.toFixed(0)} (not checked)` : `${stretch(j.interval)}${j.window && !j.interval ? ` (lands at all ${stretch(j.window)})` : ''}`}</td>
        <td>{j.takeoffX != null ? `${j.takeoffX.toFixed(0)}${j.inInterval === false ? ' (outside)' : ''}` : j.sent === false ? 'not sent' : '—'}</td>
        <td>{j.predicted ? `${j.predicted.on === 'target' ? 'on target' : 'short'} at ${j.predicted.x.toFixed(0)}` : '—'}</td>
        <td>{landedText(j.landed)}</td><td title={j.modelOff ? 'Further from where the model said than the landing margin its safe stretch allows: the model is off on this jump, however it landed' : undefined}>{px(j.landingErrorPx)}{j.modelOff ? ' ⚠' : ''}</td>
      </tr>)}
    </tbody></table>
    <div className="pg-hint">Took off: where the player was when the guard sent the press (its readings carried on at its speed). Model: where the platformer model says a press there lands. Off by: where it landed, less where the model said; ⚠ past the landing margin its safe stretch allows (the model is off on that jump, even when it landed).</div>
  </>;
}

// how an attempt ended, in a few words
export const endedText = (a: Attempt) => !a.ended ? 'didn’t end in this run' : a.ended.worked ? (a.ended.arrival === 'corrected' ? 'worked, corrected onto its end' : 'worked')
  : a.ended.recovered ? `reached its platform, put right (${a.ended.recoveredHow})`
  : a.ended.recovered === false ? `reached its platform, not put right (${a.ended.recoveredHow})`
  : `failed${a.ended.cause ? ` (${a.ended.cause})` : ''}`;
// an attempt that failed, as the list marks it: one put right by lining up isn't
export const attemptFailed = (a: Attempt) => !!a.ended && !a.ended.worked && !a.ended.recovered;

// one attempt: what it was, how it went, and per key event where it was against the recording. onEvent: a key event
// chosen (shown on the map, or the replay sent to its moment); selected: the one chosen
export function AttemptView({ a, onEvent, selected }: { a: Attempt; onEvent(k: KeyEvent): void; selected?: number | null }) {
  if (a.kind === 'line-up' && a.lineUp) return <div className="rr-attempt"><div className="pg-section-hd">Lining up · {endedText(a)}</div>
    <div className="pg-hint">{lineUpText(a.lineUp)}</div><div className="pg-hint">Nothing was replayed: lining up with the recorded start didn’t get within Start within.</div></div>;
  if (a.recorded === false) return <div className="rr-attempt"><div className="pg-section-hd">Attempt {a.attempt} · {a.kind ?? 'link'} · {endedText(a)}</div>
    {a.ended?.why && <div className="pg-hint">{a.ended.why}</div>}
    <div className="pg-hint">Not a recorded movement{a.kind === 'clip' ? ' learned from recordings' : ''}: there’s no recording to compare it with.</div></div>;
  if (a.problem) return <div className="rr-attempt"><div className="pg-section-hd">Attempt {a.attempt} · {a.link}</div><div className="pg-warn">{a.problem}</div></div>;
  const e = a.executor!, r = a.readings!;
  return <div className="rr-attempt">
    <div className="pg-section-hd">Attempt {a.attempt} · {endedText(a)}</div>
    {a.ended?.why && <div className="pg-hint">{a.ended.why}</div>}
    {a.ended?.finish && <div className="pg-hint">{finishText(a.ended.finish)}</div>}
    <div className="rr-facts">
      {a.lineUp && <span>{lineUpText(a.lineUp)}</span>}
      {(a.parts ?? 1) > 1 || a.syncs?.length ? <span>{syncText(a)}</span> : null}
      <span>Recorded {s(a.recordedMs)}, started {px(a.startOffsetPx)} from its recorded start</span>
      <span>Executor: {e.state ?? '—'}{e.cause ? ` by ${e.cause}` : ''}{e.error ? ` (${e.error})` : ''} after {s(e.ranMs)}; {e.emitted}/{e.sent} presses sent as OS events{e.sent ? '' : ' (no dispatch record)'}, latest {ms(e.maxLateMs, 1)} late</span>
      <span>Live readings: {r.fresh} new, {r.reused} repeated{r.inferred ? ' (inferred: this trace predates read times)' : ''}, a new one every {ms(r.medianGapMs)} (median){r.readLagMs ? `; read ${ms(r.readLagMs.median)} after capture (median, at most ${ms(r.readLagMs.max)})` : ''}</span>
      <span>Raw error first over {px(a.thresholdPx)} at {s(a.firstOverMs)}{a.firstOverEvent != null ? ` (key event #${a.firstOverEvent})` : ''}; the divergence it ended in began at {s(a.lastOnsetMs)}, and inputs went on {s(a.continuedMs)} after it; at most {px(a.maxErrorPx)}</span>
    </div>
    <Jumps a={a} />
    <ErrorChart a={a} />
    <div className="pg-hint">Counted toward divergence only where the recorded position is within {ms(a.reliableMs)} of a real recorded reading (faint dots aren’t). “~N ms”: interpolated, N ms from the nearest real reading.</div>
    <table className="rr-events"><thead><tr>
      <th>#</th><th>Key</th><th>Due</th><th>Sent</th><th>Late</th><th>Recorded</th><th>Live</th><th>Raw error</th><th>Lag</th><th>Error at lag</th>
    </tr></thead><tbody>
      {a.events!.map(k => <tr key={k.index} className={[k.index === a.firstOverEvent ? 'rr-first' : '', k.index === selected ? 'rr-selected' : ''].join(' ').trim() || undefined}
        title="Show this key event" onClick={() => onEvent(k)}>
        <td>{k.index}</td><td>{k.down ? '↓' : '↑'}{buttonLabel(k.button)}{(a.parts ?? 1) > 1 && k.part != null ? <small> part {k.part + 1}</small> : null}</td><td>{ms(k.at)}</td><td>{ms(k.sentMs, 1)}</td>
        <td>{k.lateMs == null ? '—' : k.lateMs.toFixed(1)}{k.outcome && k.outcome !== 'emitted' ? ` (${k.outcome})` : ''}</td>
        <td>{at(k.recorded)}</td><td>{at(k.live)}</td><td>{px(k.errorPx)}</td>
        <td>{k.lagMs == null ? (k.alignedErrorPx == null ? '—' : 'can’t tell') : `${k.lagMs > 0 ? '+' : ''}${k.lagMs} ms`}</td><td>{px(k.alignedErrorPx)}</td>
      </tr>)}
    </tbody></table>
    <div className="pg-hint">Lag: how far the replay was behind (+) or ahead (−) of the recording around that event, fitted over ±150 ms of readings; “can’t tell” where the player wasn’t moving.</div>
  </div>;
}

export default function ReplayReport({ file, maps, onSeek }: { file: string; maps: Record<string, unknown>; onSeek(t: number): void }) {
  const [report, setReport] = useState<Report | null>(null), [threshold, setThreshold] = useState(8);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const compare = async () => {
    setBusy(true); setError('');
    try { setReport((await window.bridge.policy.invoke('behavior.replay', { file, maps, thresholdPx: threshold })) as Report); }
    catch (e) { setError(cleanError(e)); setReport(null); }
    finally { setBusy(false); }
  };
  return <div className="rr" aria-label="Compare with recording">
    <div className="bt-replay-bar">
      <button className="modal-btn" disabled={!file || busy} onClick={() => void compare()}>{busy ? 'Comparing…' : 'Compare with recording'}</button>
      <label className="pg-hint">Diverged past <input type="number" aria-label="Divergence threshold" min={1} max={200} value={threshold}
        onChange={e => setThreshold(Math.max(1, Number(e.target.value) || 8))} style={{ width: 48 }} /> px</label>
    </div>
    {error && <div className="pg-warn">{error}</div>}
    {report && <>
      {report.notes.map(n => <div key={n} className="pg-hint">{n}</div>)}
      {report.summary && report.attempts.length > 0 && <div className="pg-hint">{summaryText(report.summary)}</div>}
      {!report.attempts.length && <div className="pg-hint">No recorded movement was replayed in this run.</div>}
      {report.attempts.map(a => <AttemptView key={a.attempt} a={a} onEvent={k => k.liveAt != null ? onSeek(k.liveAt) : a.startedAt != null && onSeek(a.startedAt + (k.sentMs ?? k.at))} />)}
    </>}
  </div>;
}
