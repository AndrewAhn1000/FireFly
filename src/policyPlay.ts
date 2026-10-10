// Trained policies, as the Policy Graph and the Play tab both use them: their versions, what playing one
// says, deleting versions (with the corrections recorded while they played), and training a version again
// with those corrections. The worker (worker/worker.py) trains, lists and plays them.
import { buttonLabel } from './Keyboard';

export const POLICY_VERSION = 3; // what the worker plays (worker.py VERSION)

export interface Schema { identity: string; fields?: { name: string; type: string }[]; buttons?: { id: string; vk: number }[]; }
export interface ButtonStats { button: string; precision: number; recall: number; f1: number; pressed: number; }
// A trained version of a policy, as the worker saved it, with what it was trained from and how (config,
// features), so it can be trained again with corrections without its graph
export interface PolicyVersion {
  id: string; created: number; version?: number; trainingSamples: number; validationSamples: number; stepMs?: number;
  observationSchema: Schema; actionSchema: Schema; buttons?: ButtonStats[]; policy?: { id: string; name: string } | null;
  outputs?: { id: string; vk: number }[];
  // The corrections it was trained with: how many, their share of each epoch, and the share of their rows it does
  corrections?: { recordings: number; rows: number; share: number; learned: number | null } | null;
  config: {
    recordingIds: string[]; history?: number; skippedReasons?: Record<string, number>; epochs?: number; learningRate?: number;
    correctionShare?: number;
    actionDelayMs?: number; stepMs?: number; columns?: string[] | null; derived?: unknown[]; formulas?: unknown[];
    buttons?: string[]; anchor?: string | null; surface?: string; nearPx?: number;
  };
  features?: { grids?: unknown[] };
}
// What a recording says about itself: a correction was recorded while a version (policyId) played
export interface RecordingInfo { id: string; status?: string; metadata: { correction?: boolean; policyId?: string } }

export interface Latency { ageMs: number | null; sentAgeMs: number | null; arrivedAgeMs?: number | null; askedAgeMs?: number | null; graphMs: number | null; waitMs: number | null; predictMs: number | null; }
export interface PlayStatus { playing: boolean; waiting?: boolean; correcting?: boolean; corrected?: number; modelId?: string; actions?: number; released?: number; missed?: string | null; holding?: string[]; pressed?: Record<string, number>; keyboardFocus?: boolean | null; reason?: string | null; latency?: Latency | null; }

// How old the frames a policy acts on are when their buttons are pressed, and what takes the time
export const latencyText = (l?: Latency | null) => {
  if (!l || l.ageMs === null) return '';
  const ms = (v: number | null) => v === null ? '?' : `${Math.round(v)}`;
  return ` · acting on frames ${ms(l.ageMs)} ms old (graph ${ms(l.graphMs)} · waiting for matching ${ms(l.waitMs)} · sent at ${ms(l.sentAgeMs)} · reached FireFly at ${ms(l.arrivedAgeMs ?? null)} · policy ${ms(l.predictMs)}; limit 250)`;
};

// What a playing policy is doing, in a line
export function playingText(status: PlayStatus): string {
  if (status.waiting) return 'Switch to the game to start (10 s)';
  if (status.correcting) return '✋ You’re in control: recording your correction';
  const pressed = Object.entries(status.pressed ?? {});
  return `● Playing${status.keyboardFocus === false ? ' · ⚠ the game is in front but doesn’t have the keyboard, so its keys go nowhere: click in the game once' : ''}`
    + ` · ${status.actions ?? 0} actions · holding ${status.holding?.length ? status.holding.map(buttonLabel).join(' + ') : 'nothing'}`
    + (pressed.length ? ` (pressed so far: ${pressed.map(([b, n]) => `${buttonLabel(b)} ${n}×`).join(', ')})` : ' (nothing pressed yet)')
    + (status.released ? ` · ${status.released} frames it couldn’t act on (let go), lately: ${status.missed ?? '?'}` : '')
    + latencyText(status.latency);
}

// How much of each epoch of training the corrections make up, however short they are beside the recordings
// (worker.py CORRECTION_SHARE); 0 is as plain rows
export const DEFAULT_CORRECTION_SHARE = .4;
export const MAX_CORRECTION_SHARE = .9;
export const correctionShareHint = 'How much of each round of training your corrections make up, however short they are beside the recordings. '
  + 'Higher makes the policy follow them more, and the recordings less; 0% counts them as plain rows, which a few seconds of corrections among minutes of recordings barely change.';

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
    recordingIds, formulas: c.formulas ?? [], columns: c.columns ?? null, derived: c.derived ?? [], grids: version.features?.grids ?? [],
    buttons: c.buttons ?? null, stepMs: c.stepMs ?? version.stepMs ?? null, history: c.history ?? 2, actionDelayMs: c.actionDelayMs ?? 0,
    anchor: c.anchor ?? null, surface: c.surface ?? 'below', nearPx: c.nearPx ?? 200,
    epochs: c.epochs ?? 60, ...(c.learningRate ? { learningRate: c.learningRate } : {}),
    correctionShare: correctionShare ?? c.correctionShare ?? DEFAULT_CORRECTION_SHARE,
    ...(version.policy ? { policy: version.policy } : {}),
  };
}
