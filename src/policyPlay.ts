// Trained policies, as the Policy Graph and the Play tab both use them: their versions, what playing one
// says, deleting versions (with the corrections recorded while they played), and training a version again
// with those corrections. The worker (worker/worker.py) trains, lists and plays them.
import { buttonLabel } from './Keyboard';
import { playGoal, readGraph } from './graphModel';

export const POLICY_VERSION = 3; // what the worker plays (worker.py VERSION)

export interface Schema { identity: string; fields?: { name: string; type: string }[]; buttons?: { id: string; vk: number }[]; }
export interface ButtonStats { button: string; precision: number; recall: number; f1: number; pressed: number; }
// A trained version of a policy, as the worker saved it, with what it was trained from and how (config,
// features), so it can be trained again with corrections without its graph
export interface PolicyVersion {
  id: string; created: number; version?: number; trainingSamples: number; validationSamples: number; stepMs?: number;
  observationSchema: Schema; actionSchema: Schema; buttons?: ButtonStats[]; policy?: { id: string; name: string } | null;
  outputs?: { id: string; vk: number }[];
  taps?: Record<string, { downMs: number; upMs: number }>; // the buttons the player tapped, pressed to that rhythm in play
  // The corrections it was trained with: how many, their share of each epoch, and the share of their rows it does
  corrections?: { recordings: number; rows: number; share: number; learned: number | null } | null;
  config: {
    recordingIds: string[]; history?: number; skippedReasons?: Record<string, number>; epochs?: number; learningRate?: number;
    correctionShare?: number;
    actionDelayMs?: number; stepMs?: number; columns?: string[] | null; derived?: unknown[]; formulas?: unknown[];
    buttons?: string[]; anchor?: string | null; surface?: string; nearPx?: number;
  };
  features?: { grids?: unknown[]; spatial?: unknown[]; goal?: unknown };
}
// Every Policy node in the graph library under `scope` (src/GraphLibrary.tsx): its id, which is its policy's, its name
// now, and the graph it's in. A policy's versions are filed by that id, so two graphs with one (one pasted from the
// other) train one policy
export interface PolicyNodeInfo { policyId: string; name: string; graphId: string; graph: string; }
export const graphDocumentKey = (scope: string, graphId: string) => `${scope}-document-${graphId}`;

// Where play heads for a policy, from its graph as saved now (playGoal), for playing it from the Play tab
export function savedPlayGoal(scope: string, policyId: string) {
  const node = policyNodes(scope).find(p => p.policyId === policyId);
  if (!node) return null;
  try { return playGoal(readGraph(localStorage.getItem(graphDocumentKey(scope, node.graphId))), policyId); } catch { return null; }
}
export function policyNodes(scope: string): PolicyNodeInfo[] {
  try {
    const library = JSON.parse(localStorage.getItem(scope + '-library') ?? 'null') as { entries?: { id: string; kind: string; name: string }[] } | null;
    return (library?.entries ?? []).filter(e => e.kind === 'policy').flatMap(entry => {
      try {
        const doc = JSON.parse(localStorage.getItem(graphDocumentKey(scope, entry.id)) ?? 'null') as { nodes?: { id: string; data?: { kind?: string; name?: string } }[] } | null;
        return (doc?.nodes ?? []).filter(n => n.data?.kind === 'policy')
          .map(n => ({ policyId: n.id, name: String(n.data?.name ?? '').trim(), graphId: entry.id, graph: entry.name }));
      } catch { return []; }
    });
  } catch { return []; }
}

// What a recording says about itself: a correction was recorded while a version (policyId) played
export interface RecordingInfo { id: string; status?: string; metadata: { correction?: boolean; policyId?: string } }

export interface Latency { ageMs: number | null; sentAgeMs: number | null; arrivedAgeMs?: number | null; askedAgeMs?: number | null; graphMs: number | null; waitMs: number | null; predictMs: number | null; }
export interface PlayStatus { playing: boolean; waiting?: boolean; correcting?: boolean; corrected?: number; modelId?: string; actions?: number; released?: number; missed?: string | null; holding?: string[]; pressed?: Record<string, number>; keyboardFocus?: boolean | null; reason?: string | null; latency?: Latency | null;
  top?: { id: string; p: number } | null; // the button it was surest of in the latest frame, and how sure
  // where a Goal's play aimed in the latest frame: the point, how far, and from what (its plan, route or Target)
  heading?: { kind: 'plan' | 'route' | 'target'; x: number; y: number; distance: number } | null;
  trace?: string | null; // where what it sees is being kept, if it is
  taps?: string[];  // the buttons it taps rather than holds, as the player did
  // Driving (a Planner node's Drive, worker/executor.py): its node and name, and what it's doing in the latest frame
  drive?: boolean; name?: string; driverId?: string | null; driving?: Driving | null; }
export interface Driving {
  phase: 'walk' | 'position' | 'jump' | 'air' | 'arrived' | 'noway' | 'stuck' | 'missing'; text: string; done: number; missed: number;
  misses: { from: [number, number]; to: [number, number]; why: string }[];
  hop?: { from: [number, number]; to: [number, number]; example: number; anchor: [number, number] };
}

// What a version saw while it played beside what it trained on (worker.py, trace_report)
export interface TraceReport {
  frames: number; acted: number; missing: Record<string, number>; trainingRows: number; heldBackRows: number;
  unfamiliar: { playMedian: number; heldBackMedian: number | null; heldBack90: number; beyondHeldBack90: number };
  buttons: { id: string; playerPressed: number; playPressed: number; playChance: number }[];
  pressedNothing: number; playerNothing: number;
  values: { name: string; trainMean: number; trainLow: number; trainHigh: number; playMean: number; playLow: number; playHigh: number; outside: number; shift: number }[];
}

// How old the frames a policy acts on are when their buttons are pressed, and what takes the time
export const latencyText = (l?: Latency | null) => {
  if (!l || l.ageMs === null) return '';
  const ms = (v: number | null) => v === null ? '?' : `${Math.round(v)}`;
  return ` · frames ${ms(l.ageMs)} ms old when acted on (limit 250: graph ${ms(l.graphMs)} ms, template matching wait ${ms(l.waitMs)} ms, sent at ${ms(l.sentAgeMs)}, reached FireFly at ${ms(l.arrivedAgeMs ?? null)}, policy ${ms(l.predictMs)})`;
};

// What a playing policy is doing, in a line
export function playingText(status: PlayStatus): string {
  if (status.waiting) return 'Switch to the game to start (10 s)';
  if (status.drive) {
    const d = status.driving, last = d?.misses?.[d.misses.length - 1];
    return `● ${status.name ?? 'The planner'} is driving: ${d?.text ?? 'starting'}`
      + (d ? ` · ${d.done} hop${d.done === 1 ? '' : 's'} done, ${d.missed} missed${last ? ` (last: from (${last.from.join(', ')}) to (${last.to.join(', ')}), ${last.why})` : ''}` : '')
      + (status.keyboardFocus === false ? ' · ⚠ the game is in front but doesn’t have the keyboard, so its keys go nowhere: click in the game once' : '')
      + (status.released ? ` · ${status.released} frames it couldn’t act on, lately: ${status.missed ?? '?'}` : '')
      + latencyText(status.latency);
  }
  if (status.correcting) return '✋ You’re in control: recording your correction';
  const pressed = Object.entries(status.pressed ?? {});
  return `● Playing${status.keyboardFocus === false ? ' · ⚠ the game is in front but doesn’t have the keyboard, so its keys go nowhere: click in the game once' : ''}`
    + ` · ${status.actions ?? 0} actions · holding ${status.holding?.length ? status.holding.map(b => buttonLabel(b) + (status.taps?.includes(b) ? ' (tapping)' : '')).join(' + ')
      : `nothing${status.top ? `: it chose no button (surest: ${buttonLabel(status.top.id)} ${Math.round(status.top.p * 100)}%, a press needs 50%)` : ''}`}`
    + (pressed.length ? ` (pressed so far: ${pressed.map(([b, n]) => `${buttonLabel(b)} ${n}×`).join(', ')})` : ' (nothing pressed yet)')
    + (status.heading ? ` · heading for (${Math.round(status.heading.x)}, ${Math.round(status.heading.y)}), ${Math.round(status.heading.distance)} px away (${status.heading.kind === 'plan' ? 'planned' : status.heading.kind === 'route' ? 'along the route' : 'its Target'})` : '')
    + (status.released ? ` · ${status.released} frames it couldn’t act on (let go), lately: ${status.missed ?? '?'}` : '')
    + latencyText(status.latency);
}

// How much of each epoch of training the corrections make up, however short they are beside the recordings
// (worker.py CORRECTION_SHARE); 0 is as plain rows
export const DEFAULT_CORRECTION_SHARE = .4;
export const MAX_CORRECTION_SHARE = .9;
export const correctionShareHint = 'How much of each round of training your corrections make up, however short they are beside the recordings. '
  + 'Higher makes the policy follow them more, and the recordings less; 0% counts them as plain rows, which a few seconds of corrections among minutes of recordings barely change.';

// How a Stop button was pressed, for play.log: a click has a count (`detail`), a key pressing it none. A key pressing
// Stop means FireFly was in front with that button focused, while play thought the game was
export const stopHow = (e?: { detail: number }) => e && e.detail === 0 ? 'key' : 'click';
export const cleanError =(e: unknown) => String(e).replace(/^Error: (Error invoking remote method '[^']*': )?(Error: )?/, '');
export const percent = (v: number) => `${Math.round(v * 100)}%`;
// The mean F1 over a version's buttons, on the recordings it held back to check itself with
export const meanF1 = (v: PolicyVersion) => v.buttons?.length ? v.buttons.reduce((n, b) => n + b.f1, 0) / v.buttons.length : null;

// Newest first, as the worker lists them (and as their numbers count down: v1 is the oldest)
export const newestFirst = (versions: PolicyVersion[]) => [...versions].sort((a, b) => b.created - a.created);

// The corrections recorded while any of these versions played
export const correctionsOf = (versions: PolicyVersion[], recordings: RecordingInfo[]) => {
  const own = new Set(versions.map(v => v.id));
  return recordings.filter(r => r.metadata.correction && own.has(r.metadata.policyId ?? ''));
};

// Deletes versions, and the corrections recorded while they played, which belong to them
export async function deleteVersions(versions: PolicyVersion[]) {
  for (const v of versions) await window.bridge.policy.invoke('models.delete', { modelId: v.id });
  const ids = new Set(versions.map(v => v.id));
  const all = ((await window.bridge.invoke('dataset.list')) as { recordings: RecordingInfo[] }).recordings;
  for (const r of all.filter(r => r.metadata.correction && ids.has(r.metadata.policyId ?? '')))
    await window.bridge.invoke('dataset.delete', { recordingId: r.id }).catch(() => {}); // not the one recording now
}

// A new version of a version's policy, trained the way it was (its recordings, values, labels, time step and
// history, saved with it) plus every correction recorded while any version of that policy played, counting
// for correctionShare of training (else as much as they did for it). Every version is trained from scratch;
// this is "this one again, and what I showed it". Recordings deleted since are left out; null when nothing
// it was trained from is left.
export function retrainRequest(version: PolicyVersion, siblings: PolicyVersion[], recordings: RecordingInfo[],
  correctionShare?: number): Record<string, unknown> | null {
  const c = version.config, there = new Set(recordings.filter(r => !r.status || r.status === 'complete').map(r => r.id));
  const fixes = correctionsOf(siblings, recordings).map(r => r.id);
  const recordingIds = [...new Set([...c.recordingIds, ...fixes])].filter(id => there.has(id));
  if (!recordingIds.length) return null;
  return {
    recordingIds, formulas: c.formulas ?? [], columns: c.columns ?? null, derived: c.derived ?? [], grids: version.features?.grids ?? [], spatial: version.features?.spatial ?? [],
    ...(version.features?.goal ? { goal: version.features.goal } : {}),
    buttons: c.buttons ?? null, stepMs: c.stepMs ?? version.stepMs ?? null, history: c.history ?? 2, actionDelayMs: c.actionDelayMs ?? 0,
    anchor: c.anchor ?? null, surface: c.surface ?? 'below', nearPx: c.nearPx ?? 200,
    epochs: c.epochs ?? 60, ...(c.learningRate ? { learningRate: c.learningRate } : {}),
    correctionShare: correctionShare ?? c.correctionShare ?? DEFAULT_CORRECTION_SHARE,
    ...(version.policy ? { policy: version.policy } : {}),
  };
}
