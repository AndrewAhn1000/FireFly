// The play loop (electron/play.cjs) with stand-ins for the runtime, worker and input guard: waiting for
// the game, acting on predictions, recording the player's corrections and carrying on afterwards.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPlay} = require('../electron/play.cjs');
const wait = ms => new Promise(r => setTimeout(r, ms));

function harness(options = {}) {
  const calls = [], statuses = [];
  const state = {focused: true, idleMs: 0, held: false, predict: () => ({buttons: [true, false]}), clock: 0};
  const log = (who, op, params) => { calls.push({who, op, params}); };
  const play = createPlay({
    runtime: async (op, params) => {
      log('runtime', op, params);
      if (op === 'session.schemas') return {observationSchema: {identity: options.identity ?? 'obs'}};
      return {};
    },
    worker: async (op, params) => {
      log('worker', op, params);
      if (op === 'models') return [{id: 'p', created: 1, stepMs: 39.5, observationSchema: {identity: 'obs'},
        actionSchema: {identity: 'act', buttons: [{id: 'left', vk: 37}, {id: 'right', vk: 39}]}},
        {id: 'mover', created: 2, observationSchema: {identity: 'obs'}, policy: {id: 'n1', name: 'Move right'},
        actionSchema: {identity: 'act', buttons: [{id: 'left', vk: 37}, {id: 'right', vk: 39}]}, outputs: [{id: 'right', vk: 39}]}];
      if (op === 'predict') return state.predict();
      return {};
    },
    guard: async (op, params) => {
      log('guard', op, params);
      // As the real guard: a request it refuses unconfigures it, and it's in front only once configured
      if (op === 'configure') state.configured = true;
      if (op === 'focus' && state.oldGuard) { state.configured = false; throw new Error('Unsupported guard operation'); }
      if (op === 'focused') return {focused: state.focused && !!state.configured};
      if (op === 'idle') return {idleMs: state.idleMs, held: state.held};
      if (op === 'apply' && state.stale) throw new Error('Stale observation (312 ms old; the limit is 250); refusing action');
      if (op === 'apply') return {held: 0, ageMs: 80};
      return {};
    },
    stopGuard: () => log('guard', 'stop'),
    send: (channel, value) => statuses.push(value),
    now: () => state.clock, clock: () => state.monotonic ?? 0, pollMs: 5,
  });
  const frame = t => play.onObservations({timestamp: t, observations: [], tracked: []});
  const ops = (who, op) => calls.filter(c => c.who === who && c.op === op);
  return {play, calls, statuses, state, frame, ops};
}

test('waits for the game, then presses what the policy predicts, and lets go when it cannot predict', async () => {
  const h = harness();
  h.state.focused = false;
  await h.play.start({modelId: 'p', windowId: '42'});
  assert.equal(h.ops('guard', 'focus').length, 1, 'Play should bring the game to the front');
  h.frame(1); await wait(10);
  assert.equal(h.ops('guard', 'apply').length, 0, 'Acted before the game was in front');
  assert.equal(h.statuses.at(-1).waiting, true);
  h.state.focused = true;
  h.frame(2); await wait(10);
  assert.deepEqual(h.ops('guard', 'apply')[0].params.buttons, [true, false]);
  h.state.predict = () => { throw new Error('Invalid or missing observation: player'); };
  h.frame(3); await wait(10);
  assert.deepEqual(h.ops('guard', 'apply')[1].params.buttons, [false, false], 'Should let go when there is nothing to act on');
});

test('a guard built before focus still plays once the player switches to the game', async () => {
  const h = harness();
  h.state.oldGuard = true;
  h.state.focused = false;
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  h.state.focused = true;
  h.frame(2); await wait(10);
  assert.equal(h.ops('guard', 'apply').length, 1, 'Refusing focus left the guard unconfigured');
});

test('gives up if the player never switches to the game', async () => {
  const h = harness();
  h.state.focused = false;
  await h.play.start({modelId: 'p', windowId: '42'});
  h.state.clock = 11000;
  h.frame(1); await wait(10);
  assert.equal(h.play.playing, false);
  assert.match(h.statuses.at(-1).reason, /Switch to the game within 10 seconds/);
});

test('a policy trained on other observations is refused', async () => {
  const h = harness({identity: 'other'});
  await assert.rejects(h.play.start({modelId: 'p', windowId: '42'}), /different observations/);
  assert.equal(h.ops('guard', 'configure').length, 0);
});

test('without corrections, taking over stops play', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42'});
  h.play.guardStopped('Human takeover / emergency stop');
  assert.equal(h.play.playing, false);
  assert.equal(h.ops('runtime', 'record.start').length, 0);
});

test('with corrections, taking over records a correction of the policy, and it carries on when the player lets go', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42', corrections: true});
  h.frame(1); await wait(10);
  h.state.idleMs = 0;
  h.play.guardStopped('Human takeover / emergency stop');
  await wait(20);
  assert.equal(h.play.playing, true, 'Taking over ended play');
  const started = h.ops('runtime', 'record.start');
  assert.equal(started.length, 1);
  assert.equal(started[0].params.correction, true);
  assert.equal(started[0].params.policyId, 'p');
  assert.equal(started[0].params.hz, 26, 'A correction is recorded at the step of the policy, 39.5 ms');
  assert.deepEqual(started[0].params.buttons, [{id: 'left', vk: 37}, {id: 'right', vk: 39}]);
  assert.equal(h.statuses.at(-1).correcting, true);
  const applied = h.ops('guard', 'apply').length;
  h.frame(2); await wait(10);
  assert.equal(h.ops('guard', 'apply').length, applied, 'Pressed buttons while the player was in control');
  // Still holding a button, or not idle long enough: the correction goes on
  h.state.idleMs = 2000; h.state.held = true; await wait(20);
  assert.equal(h.ops('runtime', 'record.stop').length, 0);
  h.state.held = false; h.state.idleMs = 1000; await wait(20);
  assert.equal(h.ops('runtime', 'record.stop').length, 0);
  // Let go: the correction is saved and the policy carries on
  h.state.idleMs = 1600; await wait(30);
  assert.equal(h.ops('runtime', 'record.stop').length, 1);
  assert.equal(h.ops('guard', 'configure').length, 2, 'The guard did not start again');
  assert.equal(h.statuses.at(-1).correcting, false);
  assert.equal(h.statuses.at(-1).corrected, 1);
  h.frame(3); await wait(10);
  assert.equal(h.ops('guard', 'apply').length, applied + 1, 'The policy did not carry on');
  // A second takeover is a second correction
  h.state.idleMs = 0;
  h.play.guardStopped('Human takeover / emergency stop'); await wait(20);
  assert.equal(h.ops('runtime', 'record.start').length, 2);
  // Stopping mid-correction keeps what was recorded
  h.play.stop('Stopped');
  await wait(10);
  assert.equal(h.ops('runtime', 'record.stop').length, 2);
  assert.equal(h.play.playing, false);
});

test('a policy that learned some of the buttons presses only those, and its corrections record them all', async () => {
  const h = harness();
  h.state.predict = () => ({buttons: [true]});
  await h.play.start({modelId: 'mover', windowId: '42', corrections: true});
  assert.deepEqual(h.ops('guard', 'configure')[0].params.buttons, [{id: 'right', vk: 39}]);
  h.frame(1); await wait(10);
  assert.deepEqual(h.ops('guard', 'apply')[0].params.buttons, [true]);
  h.play.guardStopped('Human takeover / emergency stop'); await wait(20);
  const started = h.ops('runtime', 'record.start')[0].params;
  assert.deepEqual(started.buttons, [{id: 'left', vk: 37}, {id: 'right', vk: 39}]);
  assert.equal(started.name, 'Correction of Move right');
  assert.equal(started.hz, 15, 'A policy without a step records its corrections at 15 a second');
  h.play.stop('Stopped');
});

test('other guard stops end play even with corrections on', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42', corrections: true});
  h.play.guardStopped('Focus lost, target closed, or action watchdog expired');
  assert.equal(h.play.playing, false);
  assert.equal(h.ops('runtime', 'record.start').length, 0);
});

test('only a real change to what is observed stops play', async () => {
  const h = harness();
  const graph = revision => ({graph: {id: 'live', revision, nodes: [{id: 'a'}]}});
  h.play.beforeRuntime('graph.apply', graph(1));
  h.play.beforeRuntime('observe.tracked', {observations: [{name: 'player'}]});
  await h.play.start({modelId: 'p', windowId: '42'});
  h.play.beforeRuntime('observe.tracked', {observations: [{name: 'player'}]});
  h.play.beforeRuntime('graph.apply', graph(2));
  h.play.beforeRuntime('dataset.list', {});
  assert.equal(h.play.playing, true, 'Sending the same again stopped play');
  h.play.beforeRuntime('observe.tracked', {observations: [{name: 'player'}, {name: 'speed'}]});
  assert.equal(h.play.playing, false);
  assert.match(h.statuses.at(-1).reason, /observes changed/);
});

test('play reports how old what it acts on is, and a stale refusal says where the time went', async () => {
  const h = harness();
  const frame = (t, age) => h.play.onObservations({timestamp: t, observations: [], tracked: [], latency: {graphMs: 12, waitMs: 95, trackingMs: 60, ageMs: age}});
  await h.play.start({modelId: 'p', windowId: '42'});
  for (let t = 1; t <= 2; t++) { frame(t, 120); await wait(10); }
  const latency = h.statuses.at(-1).latency;
  assert.deepEqual([latency.graphMs, latency.waitMs, latency.sentAgeMs, latency.ageMs], [12, 95, 120, 80]);
  assert.equal(typeof latency.predictMs, 'number');
  // The guard refuses one as stale: play stops and says which part took the time
  h.state.stale = true;
  h.state.monotonic = 300;
  frame(3, 240); await wait(20);
  assert.equal(h.play.playing, false);
  assert.match(h.statuses.at(-1).reason,
    /^Stale observation \(312 ms old; the limit is 250\); refusing action: the frame was 240 ms old when the runtime sent it \(the graph took 12 ms, waiting for template matching 95 ms\), 297 ms when FireFly's main process got it, and 297 ms when it was sent to the input guard \(the policy took \d+ ms\)$/);
});

test('a policy that can never predict says why, rather than looking as if it chose to press nothing', async () => {
  const h = harness();
  h.state.predict = () => { throw new Error('Nothing usable 1 step earlier (history)'); };
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  const last = h.statuses.at(-1);
  assert.equal(last.playing, true);
  assert.equal(last.actions, 0);
  assert.equal(last.released, 1);
  assert.equal(last.missed, 'Nothing usable 1 step earlier (history)');
  assert.deepEqual(h.ops('guard', 'apply')[0].params.buttons, [false, false]);
});

test('play says which buttons it holds, and how often it has pressed each', async () => {
  const h = harness();
  const presses = [[true, false], [true, false], [false, false], [true, true]];
  let n = 0;
  h.state.predict = () => ({buttons: presses[n++]});
  await h.play.start({modelId: 'p', windowId: '42'});
  for (let t = 1; t <= 4; t++) { h.frame(t); await wait(10); }
  const last = h.statuses.at(-1);
  assert.deepEqual(last.holding, ['left', 'right']);
  assert.deepEqual(last.pressed, {left: 2, right: 1});  // left pressed, let go, pressed again
});
