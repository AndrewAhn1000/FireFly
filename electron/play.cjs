'use strict';
// Playing a trained policy in the captured window, with the player's corrections.
//
// Every processed frame's observations go to the policy (the worker), and its buttons to the input
// guard (firefly-input). Play is pressed in FireFly, so nothing is acted on until the player switches to
// the game, and if they don't within focusWaitMs it gives up; from then on, leaving the game stops it.
//
// Corrections: with them on, the player taking over doesn't end play. What they do from then on is
// recorded, marked as a correction of this policy, until they've let go for correctionIdleMs (no input,
// none of its buttons held), and then the policy carries on. Training on the policy's recordings and its
// corrections teaches it what to do where it went wrong.
//
// The runtime, guard and worker are passed in (each `(op, params) => Promise`), so this can be tested
// without them; `send(channel, value)` tells the app.

function createPlay({ runtime, guard, stopGuard, worker, send, now = Date.now, clock = () => Number(process.hrtime.bigint()) / 1e6,
  focusWaitMs = 10000, correctionIdleMs = 1500, pollMs = 200 }) {
  let play = null; // { modelId, windowId, observationSchema, actionSchema, buttons, busy, engaged, actions, released, started, corrections, correcting, corrected, policyName }
  let correctionTimer = null;

  function status(reason) {
    send('play:status', play
      ? { playing: true, waiting: !play.engaged, correcting: !!play.correcting, corrected: play.corrected,
          modelId: play.modelId, actions: play.actions, released: play.released, missed: play.missed ?? null, holding: play.holding ?? [], pressed: play.counts ?? {}, keyboardFocus: play.keyboardFocus ?? null, started: play.started, latency: play.latency ?? null }
      : { playing: false, reason: reason ?? null });
  }

  async function start({ modelId, windowId, corrections = false }) {
    if (play) stop('Restarted');
    const model = (await worker('models')).find(m => m.id === modelId);
    if (!model) throw new Error('That policy no longer exists');
    // What it presses is what it learned (a Policy node can choose some of the recorded buttons); a
    // correction still records every button, so it trains together with the recordings it came from
    const recorded = model.actionSchema.buttons.map(({ id, vk }) => ({ id, vk }));
    const buttons = (model.outputs ?? recorded).map(({ id, vk }) => ({ id, vk }));
    const current = await runtime('session.schemas', { buttons: recorded });
    if (current.observationSchema.identity !== model.observationSchema.identity)
      throw new Error('This policy was trained on different observations than FireFly makes now. Run the same model, regions and recorded States it was trained with, or train it again.');
    await worker('load', { modelId, observationSchema: model.observationSchema.identity, actionSchema: model.actionSchema.identity });
    // Bring the game to the front, so the player needn't click it: a click in the game is input to it.
    // Windows can refuse; then play waits for the player to switch, as before. It's asked before the
    // guard is configured, since a guard that refuses a request (one built before `focus`) unconfigures.
    await guard('focus', { windowId: String(windowId) }).catch(() => {});
    await guard('configure', { windowId: String(windowId), buttons, observationSchema: model.observationSchema.identity });
    play = { modelId, windowId: String(windowId), observationSchema: model.observationSchema.identity, actionSchema: model.actionSchema.identity,
      buttons, recorded, busy: false, engaged: false, actions: 0, released: 0, started: now(),
      corrections: !!corrections, correcting: null, corrected: 0,
      policyName: model.policy?.name ?? new Date(model.created * 1000).toLocaleString(),
      // Corrections are recorded at the policy's own step: a row needs a sample at each of its earlier
      // steps, and at 15 a second a 40 ms policy found them almost never (26 corrections gave 3 rows)
      correctionHz: Math.min(30, Math.max(5, Math.ceil(1000 / (model.stepMs || 66.7)))) };
    status();
  }

  function stop(reason) {
    if (!play) return;
    const current = play;
    play = null;
    clearInterval(correctionTimer);
    if (current.correcting) endCorrection(current);
    stopGuard();
    status(reason);
  }

  // The guard stopped by itself and let go of everything: the player taking over, focus lost, or its watchdog
  function guardStopped(reason) {
    if (!play) return;
    if (play.corrections && !play.correcting && /takeover/i.test(reason)) startCorrection(play);
    else stop(reason);
  }

  async function startCorrection(current) {
    const id = `correction-${now()}-${Math.random().toString(16).slice(2, 8)}`;
    current.correcting = { id, since: now() };
    status();
    try {
      await runtime('record.start', { recordingId: id, name: `Correction of ${current.policyName}`, buttons: current.recorded,
        hz: current.correctionHz, correction: true, policyId: current.modelId });
    } catch (e) { if (play === current) stop('Could not record your correction: ' + e.message); return; }
    clearInterval(correctionTimer);
    correctionTimer = setInterval(async () => {
      if (play !== current || !current.correcting) { clearInterval(correctionTimer); return; }
      try {
        const { idleMs, held } = await guard('idle');
        if (idleMs < correctionIdleMs || held || play !== current || !current.correcting) return;
        clearInterval(correctionTimer);
        await endCorrection(current);
        // The policy carries on: the guard starts again, as when Play was pressed
        await guard('configure', { windowId: current.windowId, buttons: current.buttons, observationSchema: current.observationSchema });
        status();
      } catch (e) { if (play === current) stop(e.message); }
    }, pollMs);
  }

  async function endCorrection(current) {
    if (!current.correcting) return;
    current.correcting = null;
    current.corrected++;
    await runtime('record.stop').catch(() => {});
  }

  async function actOn(current, result, arrived) {
    if (current.correcting) return; // the player is in control
    if (!current.engaged) {
      const { focused } = await guard('focused');
      if (!focused) {
        if (now() - current.started > focusWaitMs) throw new Error(`Switch to the game within ${focusWaitMs / 1000} seconds of pressing Play`);
        return;
      }
      current.engaged = true;
      status();
    }
    const observations = [...(result.observations ?? []), ...(result.tracked ?? [])];
    let buttons, predicted = true;
    const asked = now();
    try {
      buttons = (await worker('predict', { observationSchema: current.observationSchema, observations, timestamp: result.timestamp, frame: result.frame })).buttons;
    } catch (e) {
      // Nothing to act on in this frame, such as the player not being found: let go of everything, and
      // say why, since a policy that can never predict looks like one that decides to press nothing
      buttons = current.buttons.map(() => false);
      predicted = false;
      current.missed = String(e?.message ?? e).replace(/^Error: /, '');
    }
    if (play !== current || current.correcting) return;
    // Where the time went, from the frame's capture to its buttons (the runtime's part, then the policy's)
    const took = result.latency ?? {};
    const latency = { graphMs: took.graphMs ?? null, waitMs: took.waitMs ?? null, sentAgeMs: took.ageMs ?? null,
      arrivedAgeMs: arrived - result.timestamp, predictMs: now() - asked, askedAgeMs: clock() - result.timestamp, ageMs: null };
    let applied;
    try {
      applied = await guard('apply', { buttons, timestamp: result.timestamp, actionSchema: current.actionSchema, observationSchema: current.observationSchema });
    } catch (e) {
      // Too old to act on: say which part took the time
      if (/stale/i.test(e.message)) throw new Error(`${e.message}: ${describeLatency(latency)}`);
      throw e;
    }
    latency.ageMs = applied?.ageMs ?? null;
    if (typeof applied?.keyboardFocus === 'boolean' && applied.keyboardFocus !== current.keyboardFocus) { current.keyboardFocus = applied.keyboardFocus; status(); }
    current.latency = latency;
    if (predicted) current.actions++; else current.released++;
    // What it's holding now, and how often it has pressed each button: a policy that decides to press
    // nothing looks the same as one whose presses the game ignores, unless it says which
    const held = current.buttons.filter((_, i) => buttons[i]).map(b => b.id);
    current.counts = current.counts ?? {};
    for (const id of held) if (!(current.holding ?? []).includes(id)) current.counts[id] = (current.counts[id] ?? 0) + 1;
    if (held.join() !== (current.holding ?? []).join()) { current.holding = held; status(); }
    if ((current.actions + current.released) % 15 === 1) status();
  }

  // A frame's journey in words: how old it was when FireFly sent it, and what took the time
  function describeLatency(l) {
    const ms = v => (typeof v === 'number' && isFinite(v) ? `${Math.round(v)} ms` : '?');
    return `the frame was ${ms(l.sentAgeMs)} old when the runtime sent it (the graph took ${ms(l.graphMs)}, waiting for template matching ${ms(l.waitMs)}), `
      + `${ms(l.arrivedAgeMs)} when FireFly's main process got it, and ${ms(l.askedAgeMs)} when it was sent to the input guard (the policy took ${ms(l.predictMs)})`;
  }

  function onObservations(result) {
    if (!play || play.busy || !result) return;
    const arrived = clock();
    const current = play;
    current.busy = true;
    actOn(current, result, arrived)
      // The guard refused and let go of every button (focus lost, a stale observation, a held
      // modifier), or the player never switched to the game
      .catch(e => { if (play === current) stop(e.message); })
      .finally(() => { current.busy = false; });
  }

  // What FireFly observes changing mid-play would feed the policy inputs it wasn't trained on. The app
  // sends the same graph and recorded States again now and then (as when a recording ends), which
  // changes nothing, so only a change stops play.
  const lastObserved = new Map();
  function beforeRuntime(op, params) {
    let changed = op === 'start' || op === 'stop';
    if (op === 'graph.apply' || op === 'observe.tracked' || op === 'observe.recorded') {
      const key = JSON.stringify(op === 'graph.apply' ? { ...params?.graph, revision: 0 } : params);
      changed = lastObserved.get(op) !== key;
      lastObserved.set(op, key);
    }
    if (changed && play) stop('What FireFly observes changed');
  }

  return { start, stop, guardStopped, onObservations, beforeRuntime, get playing() { return !!play; } };
}

module.exports = { createPlay };
