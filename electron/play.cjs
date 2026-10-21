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
// A behaviour tree: with `behavior` (from the Graphs view: worker/behavior.py, behavior.load and behavior.step)
// instead of a policy, the tree presses the keys, behind the same guard; the player taking over stops it. Each frame's
// node statuses go with the status, for the editor to light up.
//
// The runtime, guard and worker are passed in (each `(op, params) => Promise`), so this can be tested
// without them; `send(channel, value)` tells the app.

// How long before a takeover a correction starts: the moments the policy got wrong, before the player's first key
// (the player sees it go wrong and reacts in about this long)
const CORRECTION_BEFORE_MS = 300;

function createPlay({ runtime, guard, stopGuard, worker, send, now = Date.now, clock = () => Number(process.hrtime.bigint()) / 1e6,
  focusWaitMs = 10000, correctionIdleMs = 1500, pollMs = 200, unconfiguredWaitMs = 1000, heartbeatMs = 50 }) {
  let play = null; // { modelId, windowId, observationSchema, actionSchema, buttons, busy, engaged, actions, released, started, corrections, correcting, corrected, policyName }
  let correctionTimer = null;
  let actionTimer = null;

  function status(reason, stopped = {}) {
    send('play:status', play
      ? { playing: true, waiting: !play.engaged, correcting: !!play.correcting, corrected: play.corrected,
          modelId: play.modelId, actions: play.actions, released: play.released, missed: play.missed ?? null, holding: play.holding ?? [], pressed: play.counts ?? {}, keyboardFocus: play.keyboardFocus ?? null, started: play.started, latency: play.latency ?? null, top: play.top ?? null, heading: play.heading ?? null,
          trace: play.trace ?? null, taps: Object.keys(play.taps ?? {}), execution: play.execution ?? null,
          ...(play.behavior ? { behavior: true, name: play.policyName, treeId: play.treeId ?? null, tree: play.tree ?? null } : {}) }
      : { playing: false, reason: reason ?? null, ...stopped });
  }

  async function start({ modelId, windowId, corrections = false, trace = false, goal = null, name = null, behavior = null, treeId = null }) {
    if (play) stop('Restarted');
    if (behavior) return startTree({ windowId, behavior, name, treeId });
    const model = (await worker('models')).find(m => m.id === modelId);
    if (!model) throw new Error('That policy no longer exists');
    // What it presses is what it learned (a Policy node can choose some of the recorded buttons); a
    // correction still records every button, so it trains together with the recordings it came from
    const recorded = model.actionSchema.buttons.map(({ id, vk }) => ({ id, vk }));
    const buttons = (model.outputs ?? recorded).map(({ id, vk }) => ({ id, vk }));
    const current = await runtime('session.schemas', { buttons: recorded });
    if (current.observationSchema.identity !== model.observationSchema.identity)
      throw new Error('This policy was trained on different observations than FireFly makes now. Run the same model, regions and recorded States it was trained with, or train it again.');
    // With trace, the worker keeps what it sees each frame, to compare with what it trained on (trace.report)
    // goal: where play heads, from the graph now (the Goal's target, route or plan), in place of what it trained with
    const loaded = await worker('load', { modelId, observationSchema: model.observationSchema.identity, actionSchema: model.actionSchema.identity, trace: !!trace,
      ...(goal ? { goal } : {}) });
    // Bring the game to the front, so the player needn't click it: a click in the game is input to it.
    // Windows can refuse; then play waits for the player to switch, as before. It's asked before the
    // guard is configured, since a guard that refuses a request (one built before `focus`) unconfigures.
    await guard('focus', { windowId: String(windowId) }).catch(() => {});
    await guard('configure', { windowId: String(windowId), buttons, observationSchema: model.observationSchema.identity });
    // Each frame's action schema is the guard's: that of the buttons it's configured with, which for a policy that
    // learned some of the recorded buttons isn't the recordings' (every frame was refused as a schema mismatch)
    const pressed = buttons.length === recorded.length ? model.actionSchema.identity : (await runtime('session.schemas', { buttons })).actionSchema.identity;
    play = { modelId, windowId: String(windowId), observationSchema: model.observationSchema.identity, actionSchema: pressed,
      buttons, recorded, busy: false, engaged: false, actions: 0, released: 0, started: now(),
      corrections: !!corrections, correcting: null, corrected: 0, trace: loaded?.trace ?? null,
      // The buttons the player tapped, and how (worker.py, taps_of): held by the policy, they're pressed and let go
      // to that rhythm, since a game that attacks once a press does it once for a key held down
      taps: model.taps ?? {}, tapping: new Map(),
      policyName: model.policy?.name ?? new Date(model.created * 1000).toLocaleString(),
      // Corrections are recorded at the policy's own step: a row needs a sample at each of its earlier
      // steps, and at 15 a second a 40 ms policy found them almost never (26 corrections gave 3 rows)
      correctionHz: Math.min(30, Math.max(5, Math.ceil(1000 / (model.stepMs || 66.7)))) };
    status();
  }

  // A behaviour tree runs: checked and loaded once, the guard pressing only the keys its nodes press
  async function startTree({ windowId, behavior, name, treeId }) {
    const loaded = await worker('behavior.load', behavior);
    const buttons = loaded.buttons.map(({ id, vk }) => ({ id, vk }));
    const current = await runtime('session.schemas', { buttons });
    await guard('focus', { windowId: String(windowId) }).catch(() => {});
    const configured = await guard('configure', { windowId: String(windowId), buttons, observationSchema: current.observationSchema.identity, sequenceProtocol: 1 });
    play = { behavior: true, modelId: null, windowId: String(windowId), observationSchema: current.observationSchema.identity, actionSchema: current.actionSchema.identity,
      buttons, recorded: buttons, busy: false, engaged: false, actions: 0, released: 0, started: now(), corrections: false, correcting: null, corrected: 0,
      trace: loaded.trace ?? null, taps: {}, tapping: new Map(), policyName: name ?? 'the tree', treeId, stepMs: 5, correctionHz: 15, tree: null, treeSent: 0,
      sequenceProtocol: configured?.sequenceProtocol === 1, execution: { id: 0, state: 'idle' }, dispatches: [], dispatchAsked: 0 };
    const running = play;
    if (running.sequenceProtocol) {
      actionTimer = setInterval(() => renewAction(running), heartbeatMs);
      actionTimer.unref?.();
    }
    status();
  }

  function executionStatus(current, execution) {
    if (!execution || play !== current) return;
    const previous = current.execution;
    // An in-flight heartbeat can return after an apply for a newer action.
    if (previous && (execution.id < previous.id ||
        (execution.id === previous.id && previous.state !== 'running' && previous.state !== 'idle' && execution.state === 'running'))) return;
    current.execution = execution;
    const before = (current.holding ?? []).join();
    if (Array.isArray(execution.held)) current.holding = current.buttons.filter(b => execution.held.includes(b.vk)).map(b => b.id);
    else if (execution.state !== 'running' && execution.id) current.holding = [];
    if (previous?.id !== execution.id || previous?.state !== execution.state || before !== (current.holding ?? []).join()) status();
    if (execution.id > current.dispatchAsked && ['completed', 'cancelled', 'failed'].includes(execution.state)) fetchDispatch(current, execution.id);
  }

  // How each press of an ended action went (the guard's `dispatch`: due, sent and returned times, and whether an OS
  // event went), asked for once per action and handed to the tree's next step, which keeps it in its trace
  function fetchDispatch(current, actionId) {
    current.dispatchAsked = actionId;
    const fetched = guard('dispatch', { actionId }).then(reply => { if (reply?.dispatch) current.dispatches.push(reply.dispatch); }, () => {});
    (current.dispatchFetches ??= []).push(fetched);
  }

  // A tree's trace closed with the record of its last action too: the one it stopped on (a movement that failed ends
  // the tree before another step could keep it), and any fetched since the last step. It names its file, so a run
  // started at once after isn't the one closed
  async function closeTrace(current) {
    const last = current.execution?.id ?? 0;
    if (current.sequenceProtocol && last > (current.dispatchAsked ?? 0)) fetchDispatch(current, last);
    await Promise.allSettled(current.dispatchFetches ?? []);
    const dispatch = current.dispatches?.splice(0) ?? [];
    await worker('trace.close', { file: current.trace, ...(dispatch.length ? { dispatch } : {}) });
  }

  async function renewAction(current) {
    if (play !== current || current.correcting || current.renewing || current.execution?.state !== 'running') return;
    if (current.supervised?.id === current.execution.id && clock() - current.supervised.checked > 500) {
      stop('Recorded movement stopped: no fresh position check for 500 ms');
      return;
    }
    current.renewing = true;
    try {
      const reply = await guard('heartbeat', { actionId: current.execution.id,
        actionSchema: current.actionSchema, observationSchema: current.observationSchema });
      executionStatus(current, reply?.execution);
    } catch (e) { if (play === current) stop(e.message); }
    finally { current.renewing = false; }
  }

  function stop(reason) {
    if (!play) return;
    const current = play;
    play = null;
    clearInterval(correctionTimer);
    clearInterval(actionTimer);
    current.pending = null;
    if (current.correcting) endCorrection(current);
    stopGuard();
    if (current.trace) closeTrace(current).catch(() => {});
    status(reason, current.behavior ? { behavior: true, name: current.policyName, treeId: current.treeId ?? null, tree: current.tree ?? null } : {});
  }

  // The guard stopped by itself and let go of everything: the player taking over, focus lost, or its watchdog
  function guardStopped(reason) {
    if (!play) return;
    if (play.corrections && !play.correcting && /takeover/i.test(reason)) startCorrection(play);
    else stop(/watchdog/i.test(reason) ? `${reason}: ${behind(play)}` : reason);
  }

  // Which fell behind, for a watchdog stop: frames stopped coming (the runtime: the graph, a Lua State, waiting
  // for template matching), one frame's prediction took that long, or the guard was slow to take its buttons
  function behind(current) {
    const ms = v => `${Math.round(v)} ms`;
    const parts = [];
    if (current.predicting != null) parts.push(`the policy was still working out one frame after ${ms(now() - current.predicting)}`);
    else if (current.applying != null) parts.push(`the input guard hadn't taken one frame's buttons after ${ms(now() - current.applying)}`);
    if (current.lastArrived != null) {
      const since = clock() - current.lastArrived;
      parts.push(since > 150 ? `no frame had come from the runtime for ${ms(since)}, so the runtime fell behind (the graph, a Lua State, or waiting for template matching)`
        : `the last frame came ${ms(since)} before`);
      if (current.frameGap) parts.push(`the longest wait between frames in the last 10 s was ${ms(current.frameGap.ms)}`);
    }
    if (current.latency) parts.push(`the last frame acted on: ${describeLatency(current.latency)}`);
    return parts.join('; ') || 'nothing had been acted on yet';
  }

  async function startCorrection(current) {
    const id = `correction-${now()}-${Math.random().toString(16).slice(2, 8)}`;
    current.correcting = { id, since: now() };
    status();
    try {
      await runtime('record.start', { recordingId: id, name: `Correction of ${current.policyName}`, buttons: current.recorded,
        hz: current.correctionHz, correction: true, policyId: current.modelId,
        // The moments just before the takeover, labelled with the keys the player took over with: what the policy
        // got wrong, which a correction otherwise starts just after
        beforeMs: CORRECTION_BEFORE_MS });
    } catch (e) { if (play === current) stop('Could not record your correction: ' + e.message); return; }
    clearInterval(correctionTimer);
    correctionTimer = setInterval(async () => {
      if (play !== current || !current.correcting) { clearInterval(correctionTimer); return; }
      try {
        const { idleMs, held } = await guard('idle');
        if (idleMs < correctionIdleMs || held || play !== current || !current.correcting) return;
        clearInterval(correctionTimer);
        // The correction is saved, then the guard starts again as when Play was pressed, and only then does the
        // policy carry on: it stays the player's turn until the guard is configured, since a frame acted on in
        // between was refused ("not configured") and that stopped play
        await runtime('record.stop').catch(() => {});
        if (play !== current || !current.correcting) return;
        await guard('configure', { windowId: current.windowId, buttons: current.buttons, observationSchema: current.observationSchema });
        if (play !== current || !current.correcting) return;
        current.correcting = null;
        current.corrected++;
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
    // A slow result cannot cancel a valid bounded clip merely by reaching the
    // guard late. It also cannot advance the tree or authorize another action.
    if (current.sequenceProtocol && current.execution?.id && clock() - result.timestamp > 250) return;
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
    const executionAtStep = current.execution;
    let buttons, predicted = true, sequence = null, action = null, ended = null;
    const asked = now();
    current.predicting = asked;
    if (current.behavior) {
      try {
        const dispatch = current.dispatches?.splice(0) ?? [];
        const stepped = await worker('behavior.step', { observations, timestamp: result.timestamp, ageMs: clock() - result.timestamp + current.stepMs + 2,
          ...(current.sequenceProtocol ? { execution: executionAtStep } : {}), ...(dispatch.length ? { dispatch } : {}) });
        current.stepMs = 0.8 * current.stepMs + 0.2 * (now() - asked);
        buttons = stepped.buttons;
        sequence = Array.isArray(stepped.sequence) ? stepped.sequence : null;
        action = stepped.action ?? null;
        if (action) current.supervised = action.supervised ? { id: action.id, checked: result.timestamp } : null;
        for (const map of Object.values(stepped.status?.maps ?? {})) {
          const checked = map?.monitor;
          if (current.supervised && checked?.actionId === current.supervised.id &&
              Number.isFinite(checked.observedAt) && checked.observedAt <= result.timestamp) {
            current.supervised.checked = Math.max(current.supervised.checked, checked.observedAt);
          }
        }
        const was = JSON.stringify(current.tree);
        current.tree = stepped.status ?? null;
        ended = stepped.status?.done ?? null;
        // the nodes lit in the editor: sent when they change, at most ten times a second
        if (JSON.stringify(current.tree) !== was && now() - current.treeSent >= 100) { current.treeSent = now(); status(); }
      } catch (e) {
        buttons = current.buttons.map(() => false);
        sequence = []; // Failed conditions/evaluation must cancel a running clip.
        predicted = false;
        current.missed = String(e?.message ?? e).replace(/^Error: /, '');
      } finally { current.predicting = null; }
      if (play !== current) return;
    } else try {
      const predicted = await worker('predict', { observationSchema: current.observationSchema, observations, timestamp: result.timestamp, frame: result.frame });
      buttons = predicted.buttons;
      // The button it was surest of, pressed or not: a policy pressing nothing says how close it came (a button
      // needs 50%), since nothing pressed looked like play being stuck
      const p = Array.isArray(predicted.probabilities) ? predicted.probabilities : [];
      const best = p.reduce((b, v, i) => (typeof v === 'number' && v > (p[b] ?? -1) ? i : b), 0);
      current.top = p.length && current.buttons[best] ? { id: current.buttons[best].id, p: p[best] } : null;
      current.heading = predicted.heading ?? null;
    } catch (e) {
      // Nothing to act on in this frame, such as the player not being found: let go of everything, and
      // say why, since a policy that can never predict looks like one that decides to press nothing
      buttons = current.buttons.map(() => false);
      predicted = false;
      current.top = null;
      current.missed = String(e?.message ?? e).replace(/^Error: /, '');
    } finally { current.predicting = null; }
    if (play !== current || current.correcting) return;
    // A continuation already authorized by the guard needs no stale apply.
    // Cancellation and new actions still pass through the guard's checks.
    if (current.sequenceProtocol && executionAtStep?.state === 'running' && sequence === null && predicted) {
      await renewAction(current);
      return;
    }
    // Where the time went, from the frame's capture to its buttons (the runtime's part, then the policy's)
    const took = result.latency ?? {};
    // The slowest Lua or memory State read for it, by name
    const slowest = Object.entries(result.probeMs ?? {}).sort((a, b) => b[1] - a[1])[0];
    const latency = { graphMs: took.graphMs ?? null, waitMs: took.waitMs ?? null, sentAgeMs: took.ageMs ?? null,
      pickupMs: took.pickupMs ?? null, probesMs: took.probesMs ?? null, queuedMs: took.queuedMs ?? null, takenMs: took.takenMs ?? null,
      heldBy: Array.isArray(took.heldBy) ? took.heldBy : null,
      slowestProbe: slowest ? { name: slowest[0], ms: slowest[1] } : null,
      arrivedAgeMs: arrived - result.timestamp, predictMs: now() - asked, askedAgeMs: clock() - result.timestamp, ageMs: null };
    if (!current.behavior) buttons = tapped(current, buttons, now());
    let applied;
    current.applying = now();
    try {
      applied = await guard('apply', { buttons, timestamp: result.timestamp, actionSchema: current.actionSchema, observationSchema: current.observationSchema,
        ...(sequence ? { sequence } : {}), ...(current.sequenceProtocol && action ? { actionId: action.id, durationMs: action.durationMs, ...(Array.isArray(action.keep) && action.keep.length ? { keep: action.keep } : {}) } : {}) });
      executionStatus(current, applied?.execution);
      current.unconfiguredSince = null;
    } catch (e) {
      current.applying = null;
      // The guard stopped itself (the player taking over, focus lost, its watchdog) and its stop is on its way,
      // after this frame's buttons: it says why, and a takeover starts a correction rather than ending play.
      // Stopping here hid that reason behind this one, and ended play with corrections on.
      if (/not configured/i.test(e.message)) {
        current.unconfiguredSince ??= now();
        if (now() - current.unconfiguredSince < unconfiguredWaitMs) return;
      }
      // Too old to act on: say which part took the time
      if (/stale/i.test(e.message)) throw new Error(`${e.message}: ${describeLatency(latency)}`);
      throw e;
    }
    current.applying = null;
    latency.ageMs = applied?.ageMs ?? null;
    if (typeof applied?.keyboardFocus === 'boolean' && applied.keyboardFocus !== current.keyboardFocus) { current.keyboardFocus = applied.keyboardFocus; status(); }
    current.latency = latency;
    if (predicted) current.actions++; else current.released++;
    // The tree came to its end (its root not looping): it's done, and says how
    if (ended && play === current) {
      const detail = typeof current.tree?.text === 'string' ? current.tree.text.trim() : '';
      stop(ended === 'success' ? 'The tree succeeded' : `The tree failed${detail ? ': ' + detail : ''}`);
      return;
    }
    // What it's holding now, and how often it has pressed each button: a policy that decides to press
    // nothing looks the same as one whose presses the game ignores, unless it says which
    const held = current.sequenceProtocol && Array.isArray(applied?.execution?.held)
      ? current.buttons.filter(b => applied.execution.held.includes(b.vk)).map(b => b.id)
      : current.buttons.filter((_, i) => buttons[i]).map(b => b.id);
    current.counts = current.counts ?? {};
    for (const id of held) if (!(current.holding ?? []).includes(id)) current.counts[id] = (current.counts[id] ?? 0) + 1;
    if (held.join() !== (current.holding ?? []).join()) { current.holding = held; status(); }
    if ((current.actions + current.released) % 15 === 1) status();
  }

  // The policy's buttons with its tapped ones pressed to their rhythm: held, a tapped button is down for downMs, up
  // for upMs, and down again, for as long as the policy holds it; let go, it's up at once and starts over next time
  function tapped(current, buttons, at) {
    return buttons.map((on, i) => {
      const id = current.buttons[i]?.id, tap = current.taps[id];
      if (!tap) return on;
      if (!on) { current.tapping.delete(id); return false; }
      const s = current.tapping.get(id);
      if (!s) { current.tapping.set(id, { down: true, since: at }); return true; }
      if (at - s.since >= (s.down ? tap.downMs : tap.upMs)) { s.down = !s.down; s.since = at; }
      return s.down;
    });
  }

  // A frame's journey in words: how old it was when FireFly sent it, and what took the time
  function describeLatency(l) {
    const ms = v => (typeof v === 'number' && isFinite(v) ? `${Math.round(v)} ms` : '?');
    // The runtime's parts, from a runtime that measures them (older ones say only the graph and the wait)
    const parts = [];
    // What held the runtime while the frame waited for it, by what it was: the app's requests, the runtime's own work,
    // writing to FireFly while it wasn't reading; for picking the frame up, or for taking its result (a runtime
    // from before says only the first, without `part`)
    const heldIn = part => {
      const held = (l.heldBy ?? []).filter(h => (h.part ?? 'pickup') === part)
        .reduce((m, h) => { const key = h.request === false ? h.op : `answering ${h.op}`; return m.set(key, (m.get(key) ?? 0) + h.ms); }, new Map());
      return held.size ? ` (the runtime was busy ${[...held].map(([what, t]) => `${what} for ${ms(t)}`).join(', ')})`
        : l.heldBy ? ` (nothing the runtime measured held it${part === 'pickup' ? ': capture itself, or the PC, was slow' : ': the PC was slow'})` : '';
    };
    if (l.pickupMs != null) parts.push(`picking the frame up ${ms(l.pickupMs)}${l.pickupMs >= 50 ? heldIn('pickup') : ''}`);
    if (l.probesMs != null) parts.push(`reading the Lua and memory States ${ms(l.probesMs)}${l.slowestProbe && l.probesMs >= 20 ? ` (the slowest, ${l.slowestProbe.name}, ${ms(l.slowestProbe.ms)})` : ''}`);
    if (l.queuedMs != null) parts.push(`waiting for the detection worker ${ms(l.queuedMs)}`);
    parts.push(`the graph ${ms(l.graphMs)}`);
    if (l.takenMs != null) parts.push(`taking its result ${ms(l.takenMs)}${l.takenMs >= 50 ? heldIn('taken') : ''}`);
    parts.push(`waiting for template matching ${ms(l.waitMs)}`);
    return `the frame was ${ms(l.sentAgeMs)} old when the runtime sent it (${parts.join(', ')}), `
      + `${ms(l.arrivedAgeMs)} when FireFly's main process got it, and ${ms(l.askedAgeMs)} when it was sent to the input guard (the policy took ${ms(l.predictMs)})`;
  }

  function onObservations(result) {
    if (!play || !result) return;
    const arrived = clock();
    // When frames come, busy or not, for a watchdog stop's reason
    if (play.lastArrived != null) {
      const gap = arrived - play.lastArrived;
      if (!play.frameGap || gap >= play.frameGap.ms || arrived - play.frameGap.at > 10000) play.frameGap = { ms: gap, at: arrived };
    }
    play.lastArrived = arrived;
    if (play.lastTimestamp != null && result.timestamp <= play.lastTimestamp) return;
    play.lastTimestamp = result.timestamp;
    if (play.busy) { play.pending = { result, arrived }; return; }
    processObservation(play, result, arrived);
  }

  function processObservation(current, result, arrived) {
    current.busy = true;
    actOn(current, result, arrived)
      // The guard refused and let go of every button (focus lost, a stale observation, a held
      // modifier), or the player never switched to the game
      .catch(e => { if (play === current) stop(e.message); })
      .finally(() => {
        current.busy = false;
        const pending = current.pending;
        current.pending = null;
        if (play === current && pending) processObservation(current, pending.result, pending.arrived);
      });
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
