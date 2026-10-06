const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCollection} = require('../electron/collection.cjs');
const tick = () => new Promise(r => setImmediate(r));

test('captures the observation source timestamp and survives editor-independent operation', async () => {
  const saved = [], frames = [], events = [];
  const collection = createCollection({
    runtime: async (op, args) => { if (op === 'frame') { frames.push(args.timestamp); return {timestamp: args.timestamp, pixels:'abcd'}; } },
    worker: async (op, args) => {
      if (op === 'evaluate') return {values: {}, issues: {}, events: [{trigger: 'enemy'}]};
      if (op === 'save') { saved.push(args); return {path: 'image.png'}; }
    }, send: (_, s) => events.push(s),
  });
  await collection.start({graphId:'g', name:'Images', scope:'game', windowId:'1', doc:{}});
  collection.onObservations({timestamp:123, observations:[]}); await tick();
  assert.deepEqual(frames, [123]); assert.equal(saved[0].frame.timestamp, 123);
  assert.equal(collection.statuses()[0].saved, 1);
  collection.stop('g');
  collection.onObservations({timestamp:456, observations:[]}); await tick();
  assert.equal(saved.length, 1); assert.ok(events.length > 0);
});

test('test mode writes nothing and overload keeps only the latest pending snapshot', async () => {
  let release, first = true;
  const seen = [];
  const collection = createCollection({runtime: async op => assert.equal(op, 'collection.frames'),
    worker: async (op, args) => {
      if (op === 'evaluate') {
        seen.push(args.snapshot.timestamp);
        if (first) { first = false; await new Promise(r => release = r); }
        return {values:{}, issues:{}, events:[{trigger:'t'}]};
      }
      assert.equal(op, 'configure');
    }, send:()=>{},
  });
  await collection.start({graphId:'g', name:'Test', scope:'game', windowId:'1', doc:{}, test:true});
  for (const timestamp of [1,2,3]) collection.onObservations({timestamp, observations:[]});
  release(); await tick();
  assert.deepEqual(seen, [1,3]);
  assert.equal(collection.statuses()[0].fired, 2);
  assert.equal(collection.statuses()[0].skipped, 1);
  assert.equal(collection.statuses()[0].saved, 0);
});

test('stopping during evaluation prevents a pending screenshot', async () => {
  let release;
  const collection = createCollection({runtime: async op => assert.equal(op, 'collection.frames'),
    worker: async op => { if (op === 'evaluate') { await new Promise(r => release = r); return {events:[{}], values:{}, issues:{}}; } }, send:()=>{}});
  await collection.start({graphId:'g', name:'Test', scope:'game', windowId:'1', doc:{}});
  collection.onObservations({timestamp:1}); collection.stop('g'); release(); await tick();
  assert.equal(collection.statuses()[0].saved, 0);
});
