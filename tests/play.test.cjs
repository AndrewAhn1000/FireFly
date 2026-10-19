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
      if (op === 'session.schemas') return {observationSchema: {identity: options.identity ?? 'obs'}, actionSchema: {identity: `act-${params.buttons.map(b => b.id).join('+')}`}};
      if (op === 'record.stop' && state.recordStopMs) await wait(state.recordStopMs);
      return {};
    },
    worker: async (op, params) => {
      log('worker', op, params);
      if (op === 'models') return [{id: 'p', created: 1, stepMs: 39.5, observationSchema: {identity: 'obs'},
        actionSchema: {identity: 'act', buttons: [{id: 'left', vk: 37}, {id: 'right', vk: 39}]}},
        {id: 'mover', created: 2, observationSchema: {identity: 'obs'}, policy: {id: 'n1', name: 'Move right'},
        actionSchema: {identity: 'act', buttons: [{id: 'left', vk: 37}, {id: 'right', vk: 39}]}, outputs: [{id: 'right', vk: 39}]},
        {id: 'hitter', created: 3, observationSchema: {identity: 'obs'}, taps: {right: {downMs: 100, upMs: 100}},
        actionSchema: {identity: 'act', buttons: [{id: 'left', vk: 37}, {id: 'right', vk: 39}]}}];
      if (op === 'load' && params.trace) return {trace: 'C:/traces/p/1.jsonl'};
      if (op === 'predict') return state.predict();
      if (op === 'behavior.load') return {buttons: [{id: 'space', vk: 32}], trace: 'C:/traces/behavior/1.jsonl'};
      if (op === 'behavior.step') return state.tick();
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
      if (op === 'apply' && state.strict && !state.configured) throw new Error('Input guardian is not configured');
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
  assert.equal(h.ops('guard', 'apply')[0].params.actionSchema, 'act-right', 'the action schema of the buttons the guard has, as the guard checks');
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
    /^Stale observation \(312 ms old; the limit is 250\); refusing action: the frame was 240 ms old when the runtime sent it \(the graph 12 ms, waiting for template matching 95 ms\), 297 ms when FireFly's main process got it, and 297 ms when it was sent to the input guard \(the policy took \d+ ms\)$/);
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

test('a frame while a correction is being saved waits for the guard, rather than stopping play', async () => {
  const h = harness();
  h.state.strict = true;
  await h.play.start({modelId: 'p', windowId: '42', corrections: true});
  h.frame(1); await wait(10);
  // The player takes over: the guard stops itself, unconfigured
  h.state.configured = false; h.state.idleMs = 0;
  h.play.guardStopped('Human takeover / emergency stop (key 0x41 (A))');
  await wait(15);
  // They let go; saving the correction takes a while, and frames keep arriving meanwhile
  h.state.recordStopMs = 40; h.state.idleMs = 1600;
  for (let t = 2; t < 8; t++) { h.frame(t); await wait(8); }
  await wait(40);
  assert.equal(h.play.playing, true, `Play stopped: ${h.statuses.at(-1).reason}`);
  assert.equal(h.statuses.at(-1).correcting, false);
  assert.equal(h.statuses.at(-1).corrected, 1);
  const before = h.ops('guard', 'apply').length;
  h.frame(9); await wait(10);
  assert.equal(h.ops('guard', 'apply').length, before + 1, 'The policy did not carry on once the guard was configured');
  h.play.stop('Done');
});

test('a refusal because the guard just stopped itself waits for its reason: a takeover starts a correction', async () => {
  const h = harness();
  h.state.strict = true;
  await h.play.start({modelId: 'p', windowId: '42', corrections: true});
  h.frame(1); await wait(10);
  // The guard stops itself, and this frame's buttons reach it before its stop reaches play
  h.state.configured = false;
  h.frame(2); await wait(10);
  assert.equal(h.play.playing, true, 'A refusal from a guard that had just stopped ended play');
  h.play.guardStopped('Human takeover / emergency stop (key 0x41 (A))');
  await wait(10);
  assert.equal(h.ops('runtime', 'record.start').length, 1, 'The takeover did not start a correction');
  assert.equal(h.statuses.at(-1).correcting, true);
  h.play.stop('Done');
});

test('a guard that stays unconfigured with no stop of its own still ends play, saying so', async () => {
  const h = harness();
  h.state.strict = true;
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  h.state.configured = false;
  h.state.clock = 100; h.frame(2); await wait(10);
  assert.equal(h.play.playing, true);
  h.state.clock = 1200; h.frame(3); await wait(10);
  assert.equal(h.play.playing, false);
  assert.match(h.statuses.at(-1).reason, /not configured/);
});

test('a watchdog stop says which part fell behind: frames stopping, or one prediction taking too long', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42'});
  h.state.monotonic = 1000; h.frame(1); await wait(10);
  h.state.monotonic = 1400;
  h.play.guardStopped('Action watchdog expired: no action for 309 ms (detection or the policy fell behind)');
  assert.match(h.statuses.at(-1).reason, /no frame had come from the runtime for 400 ms/);

  const slow = harness();
  let finish;
  slow.state.predict = () => new Promise(resolve => { finish = () => resolve({buttons: [false, false]}); });
  await slow.play.start({modelId: 'p', windowId: '42'});
  slow.state.clock = 0; slow.frame(1); await wait(10);
  slow.state.clock = 320;
  slow.play.guardStopped('Action watchdog expired: no action for 309 ms (detection or the policy fell behind)');
  assert.match(slow.statuses.at(-1).reason, /the policy was still working out one frame after 320 ms/);
  finish();
});

test('a stale refusal names the runtime part that held the frame, such as a slow Lua State', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  h.state.stale = true;
  h.play.onObservations({timestamp: 2, observations: [], tracked: [], probeMs: {platforms: 860, 'Map Id': 2},
    latency: {graphMs: 1, waitMs: 0, ageMs: 887, pickupMs: 3, probesMs: 862, queuedMs: 0, takenMs: 21}});
  await wait(20);
  assert.match(h.statuses.at(-1).reason, /\(picking the frame up 3 ms, reading the Lua and memory States 862 ms \(the slowest, platforms, 860 ms\), waiting for the detection worker 0 ms, the graph 1 ms, taking its result 21 ms, waiting for template matching 0 ms\)/);
});

test('a policy pressing nothing says which button it was surest of, and how sure', async () => {
  const h = harness();
  h.state.predict = () => ({buttons: [false, false], probabilities: [0.31, 0.12]});
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  const status = h.statuses.at(-1);
  assert.deepEqual(status.holding, []);
  assert.deepEqual(status.top, {id: 'left', p: 0.31});
  h.play.stop('Done');
});

test('where it heads is the graph’s now: sent with the version it loads, and nothing when there is none', async () => {
  const h = harness();
  const goal = {plan: {cell: 40, aheadS: 2.5, destination: {kind: 'point', x: 10, y: 20}}};
  await h.play.start({modelId: 'p', windowId: '42', goal});
  assert.deepEqual(h.ops('worker', 'load')[0].params.goal, goal);
  h.play.stop('Done');
  const plain = harness();
  await plain.play.start({modelId: 'p', windowId: '42'});
  assert.equal('goal' in plain.ops('worker', 'load')[0].params, false);
  plain.play.stop('Done');
});

test('where it is heading this frame reaches the status', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42'});
  h.state.predict = () => ({buttons: [true, false], probabilities: [.9, .1], heading: {kind: 'plan', x: 1420, y: 210, distance: 380}});
  h.frame(1); await wait(20);
  assert.deepEqual(h.statuses.at(-1).heading, {kind: 'plan', x: 1420, y: 210, distance: 380});
  h.play.stop('Done');
});

test('keeping what it sees: asked for when it loads, said while it plays, and stopped with it', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42', trace: true});
  assert.equal(h.ops('worker', 'load')[0].params.trace, true);
  assert.equal(h.statuses.at(-1).trace, 'C:/traces/p/1.jsonl');
  h.play.stop('Done'); await wait(10);
  assert.equal(h.ops('worker', 'trace.close').length, 1);
  const plain = harness();
  await plain.play.start({modelId: 'p', windowId: '42'});
  assert.equal(plain.ops('worker', 'load')[0].params.trace, false);
  plain.play.stop('Done'); await wait(10);
  assert.equal(plain.ops('worker', 'trace.close').length, 0);
});

test('a frame picked up late says which requests held the runtime, or that none did', async () => {
  const h = harness();
  await h.play.start({modelId: 'p', windowId: '42'});
  h.frame(1); await wait(10);
  h.state.stale = true;
  h.play.onObservations({timestamp: 2, observations: [], tracked: [], latency: {graphMs: 1, waitMs: 0, ageMs: 335, pickupMs: 330, probesMs: 4, queuedMs: 0, takenMs: 0,
    heldBy: [{op: 'memory.run_script', ms: 180}, {op: 'memory.run_script', ms: 120}, {op: 'frame', ms: 25}]}});
  await wait(20);
  assert.match(h.statuses.at(-1).reason, /picking the frame up 330 ms \(the runtime was busy answering memory\.run_script for 300 ms, answering frame for 25 ms\)/);
  const quiet = harness();
  await quiet.play.start({modelId: 'p', windowId: '42'});
  quiet.frame(1); await wait(10);
  quiet.state.stale = true;
  quiet.play.onObservations({timestamp: 2, observations: [], tracked: [], latency: {graphMs: 1, waitMs: 0, ageMs: 300, pickupMs: 290, probesMs: 4, queuedMs: 0, takenMs: 0, heldBy: []}});
  await wait(20);
  assert.match(quiet.statuses.at(-1).reason, /picking the frame up 290 ms \(nothing the runtime measured held it: capture itself, or the PC, was slow\)/);
  // A result taken late: what held the loop then, the runtime's own work and a blocked write named as they are
  const taken = harness();
  await taken.play.start({modelId: 'p', windowId: '42'});
  taken.frame(1); await wait(10);
  taken.state.stale = true;
  taken.play.onObservations({timestamp: 2, observations: [], tracked: [], latency: {graphMs: 1, waitMs: 0, ageMs: 256, pickupMs: 11, probesMs: 3, queuedMs: 0, takenMs: 240,
    heldBy: [{op: 'frame', ms: 238, part: 'taken', request: true}, {op: "writing to FireFly, which wasn't reading", ms: 236, part: 'taken', request: false},
      {op: 'memory.run_script', ms: 30, part: 'pickup', request: true}]}});
  await wait(20);
  const reason = taken.statuses.at(-1).reason;
  assert.match(reason, /picking the frame up 11 ms,/, 'a quick pickup isn’t explained');
  assert.match(reason, /taking its result 240 ms \(the runtime was busy answering frame for 238 ms, writing to FireFly, which wasn't reading for 236 ms\)/);
});

test('a button the player tapped is tapped to their rhythm while the policy holds it; one held stays held', async () => {
  const h = harness();
  h.state.predict = () => ({buttons: [true, true]});
  await h.play.start({modelId: 'hitter', windowId: '42'});
  const applied = [];
  for (const t of [0, 50, 100, 150, 200, 250, 300]) { h.state.clock = t; h.frame(t + 1); await wait(10); applied.push(h.ops('guard', 'apply').at(-1).params.buttons); }
  assert.deepEqual(applied.map(b => b[1]), [true, true, false, false, true, true, false]);  // right: 100 ms down, 100 up
  assert.deepEqual(applied.map(b => b[0]), [true, true, true, true, true, true, true]);   // left: held
  assert.deepEqual(h.statuses.at(-1).taps, ['right']);
  // Let go, it's up at once, and starts down again when held again
  h.state.predict = () => ({buttons: [false, false]});
  h.state.clock = 350; h.frame(400); await wait(10);
  assert.deepEqual(h.ops('guard', 'apply').at(-1).params.buttons, [false, false]);
  h.state.predict = () => ({buttons: [false, true]});
  h.state.clock = 400; h.frame(450); await wait(10);
  assert.deepEqual(h.ops('guard', 'apply').at(-1).params.buttons, [false, true]);
  h.play.stop('Done');
});

test('a behaviour tree presses what each frame of it says, lights its nodes, and ends play when it ends', async () => {
  const h = harness();
  h.state.monotonic = 1100;
  h.state.tick = () => ({buttons: [true], sequence: [[0, 0, true], [150, 0, false]], status: {text: 'pressing space 0/150 ms', nodes: {root: 'running', p: 'running'}, done: null}});
  await h.play.start({windowId: '42', behavior: {tree: {root: 'root', nodes: {}}, fields: [], buttons: [{id: 'space', vk: 32}]}, name: 'Jump quest', treeId: 'g1'});
  assert.equal(h.ops('worker', 'behavior.load').length, 1);
  assert.deepEqual(h.ops('guard', 'configure')[0].params.buttons, [{id: 'space', vk: 32}], 'only the keys its nodes press');
  h.frame(1000); await wait(10);
  const step = h.ops('worker', 'behavior.step')[0].params;
  assert.ok(step.ageMs >= 100 && step.ageMs < 120, `the frame's age and a step's time: ${step.ageMs}`);
  const applied = h.ops('guard', 'apply')[0].params;
  assert.deepEqual(applied.buttons, [true]);
  assert.deepEqual(applied.sequence, [[0, 0, true], [150, 0, false]], 'its presses for the guard to play to the ms');
  const s = h.statuses.at(-1);
  assert.equal(s.behavior, true); assert.equal(s.treeId, 'g1'); assert.equal(s.name, 'Jump quest');
  assert.deepEqual(s.tree.nodes, {root: 'running', p: 'running'});
  h.state.tick = () => ({buttons: [false], status: {text: null, nodes: {root: 'success'}, done: 'success'}});
  h.state.clock = 500; h.frame(1100); await wait(10);
  assert.equal(h.statuses.at(-1).playing, false);
  assert.equal(h.statuses.at(-1).reason, 'The tree succeeded');
  assert.equal(h.statuses.at(-1).treeId, 'g1');
});
