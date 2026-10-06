'use strict';
const crypto = require('node:crypto');

// Bounded collector: one evaluation/save in flight and one replaceable observation.
// Encoding runs in the dedicated Python process, never in Electron's renderer/main thread.
function createCollection({ worker, runtime, send }) {
  const sessions = new Map();
  let pending = null, busy = false, generation = 0, publishedAt = 0;
  const starting = new Set();
  const statuses = () => [...sessions.values()].map(({ doc, ...s }) => s);
  const publish = (force = true) => { if (force || Date.now() - publishedAt >= 125) { publishedAt = Date.now(); send('collection:status', statuses()); } };
  async function start({ graphId, name, scope, windowId, doc, test = false, maxAgeMs = 250 }) {
    if (!graphId || !windowId || !scope) throw Error('Select a game and start capture first');
    if (sessions.get(graphId)?.running || starting.has(graphId)) throw Error('Stop this graph before starting it again');
    if ([...sessions.values()].filter(s => s.running).length >= 8) throw Error('Up to eight collection graphs may run together');
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 10000) throw Error('Input age must be between 0 and 10000 ms');
    const epoch = generation;
    starting.add(graphId);
    try {
      await worker('configure', { graphId, doc, scope });
      if (epoch !== generation) throw Error('Collection start cancelled because the session changed');
      await runtime('collection.frames', { enabled: true, windowId });
      if (epoch !== generation) throw Error('Collection start cancelled because the session changed');
    } finally { starting.delete(graphId); }
    sessions.set(graphId, { graphId, name, scope, windowId, doc, test, maxAgeMs, running: true, saved: 0, fired: 0, skipped: 0, error: '', values: {}, issues: {}, recent: [],
      session: new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex'), revision: crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex'), sequence: 0 });
    publish();
  }
  function stop(graphId, reason = '') {
    generation++;
    for (const s of sessions.values()) if (!graphId || s.graphId === graphId) { s.running = false; if (reason) s.error = reason; }
    if (![...sessions.values()].some(s => s.running)) { pending = null; void runtime('collection.frames', { enabled: false }).catch(() => {}); }
    publish();
  }
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (pending) {
        const snapshot = pending; pending = null;
        let frame;
        for (const s of sessions.values()) {
          if (!s.running) continue;
          try {
            const result = await worker('evaluate', { graphId: s.graphId, snapshot, maxAgeMs: s.maxAgeMs });
            if (!s.running || sessions.get(s.graphId) !== s) continue;
            s.values = result.values; s.issues = result.issues;
            s.fired += result.events.length;
            const grouped = new Map();
            for (const event of result.events) {
              const key = JSON.stringify([event.capture, event.output]);
              if (grouped.has(key)) grouped.get(key).triggers.push(event.trigger);
              else grouped.set(key, { ...event, triggers: [event.trigger] });
            }
            for (const event of grouped.values()) {
              if (!s.running) break;
              if (s.test) { s.recent = [{ trigger: event.trigger, timestamp: snapshot.timestamp, test: true }, ...s.recent].slice(0, 8); continue; }
              try {
                frame ??= await runtime('frame', { timestamp: snapshot.timestamp, raw: true });
                if (!frame?.pixels || frame.timestamp !== snapshot.timestamp) throw Error('The source frame is no longer available');
                if (!s.running) break;
                const saved = await worker('save', { frame, event, snapshot, graphId: s.graphId, name: s.name, session: s.session, revision: s.revision, doc: s.doc, sequence: ++s.sequence });
                s.saved++;
                s.recent = [{ path: saved.path, trigger: event.trigger, timestamp: snapshot.timestamp }, ...s.recent].slice(0, 8);
              } catch (e) {
                s.skipped++; s.error = e.message;
                // A lost source frame is recoverable. Disk/encoding errors require attention.
                if (frame?.pixels) { s.running = false; break; }
              }
            }
          } catch (e) { s.error = e.message; s.running = false; }
        }
        publish(false);
      }
    } finally {
      busy = false;
      if (![...sessions.values()].some(s => s.running)) void runtime('collection.frames', { enabled: false }).catch(() => {});
    }
  }
  function onObservations(snapshot) {
    if (![...sessions.values()].some(s => s.running)) return;
    if (pending) for (const s of sessions.values()) if (s.running) s.skipped++;
    // Image observations are not metadata, and can be very large.
    pending = { timestamp: snapshot.timestamp, frame: snapshot.frame, observations: (snapshot.observations ?? []).filter(o => o.type !== 'image'), tracked: snapshot.tracked ?? [] };
    void drain();
  }
  return { start, stop, onObservations, statuses };
}
module.exports = { createCollection };
