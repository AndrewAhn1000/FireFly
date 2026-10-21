// A behaviour tree in the Graphs view: what's wrong with a node said on it (the worker's behavior.check), its keys and
// formulas edited, a clip found in a recording, Run sending the tree with its children in order, its nodes lit while it
// runs and why it stopped, and a run's recorded movement compared with its recording. Needs `npm run build`
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'behavior-ui-profile'));
let win; const watchdog = setTimeout(() => { console.error('Behavior UI timed out'); app.exit(1); }, 60000);
const fields = [{ name: 'Player Position', type: 'vector' }, { name: 'On Ground', type: 'boolean' }];
const recordings = [{ id: 'run', name: 'Jump quest', status: 'complete', samples: 100, invalidSamples: 0, durationMs: 30000, inputEvents: 40,
  metadata: { started: 1, hz: 20, observationSchema: { identity: 'obs', fields }, actionSchema: { identity: 'act', buttons: [{ id: 'right', vk: 39 }, { id: 'space', vk: 32 }] } } }];
const started = [], asked = [];

app.whenReady().then(async () => {
  try {
    const image = nativeImage.createFromBitmap(Buffer.alloc(320 * 200 * 4, 90), { width: 320, height: 200 });
    for (const [name, result] of [['runtime:available', true], ['runtime:status', { ready: true, error: null }], ['windows:thumbnails', {}], ['models:list', []], ['models:probe', null],
      ['training:check-checkpoint', { found: false }], ['training:gpu-check', { available: false }], ['collection:status', []]]) ipcMain.handle(name, () => result);
    ipcMain.handle('runtime:invoke', async (_, op) => {
      if (op === 'windows') return { windows: [{ id: '123', title: 'Test Game', pid: 1 }] };
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width: 320, height: 200 }; }
      if (op === 'dataset.list') return { recordings };
      if (op === 'observe.fields') return { fields, excluded: [] };
      return { ok: true };
    });
    ipcMain.handle('policy:invoke', (_, op, params) => {
      asked.push([op, params]);
      if (op === 'models') return [];
      // as the worker: a condition without a formula, and a press without keys, are wrong
      if (op === 'behavior.check') {
        const errors = {};
        for (const [id, n] of Object.entries(params.tree.nodes)) {
          if (n.kind === 'condition' && !(n.params.formula ?? '').trim()) errors[id] = 'write its formula';
          if (n.kind === 'press' && !(n.params.keys ?? []).length) errors[id] = 'choose the keys it presses';
        }
        return { errors, buttons: [] };
      }
      if (op === 'behavior.traces') return { runs: [{ file: 'run.jsonl', when: '2026-10-19 15-37-26', frames: 3 }] };
      if (op === 'behavior.trace') return { head: { treeId: 'tree', buttons: ['right', 'space'] }, frames: [0, 500, 1000].map(t => ({
        t: 1000 + t, now: 1070 + t, keys: ['right'], nodes: { root: 'running' }, text: 'its clip', values: {} })) };
      // as the worker's replay report: one attempt that diverged at 0.5 s
      if (op === 'behavior.replay') return { notes: [], attempts: [{ attempt: 1, link: 'recorded:x', map: 'm', recordedMs: 1000, startOffsetPx: 1.5, actionId: 1, durationMs: 1000, startedAt: 999,
        executor: { state: 'cancelled', cause: 'request', error: null, ranMs: 700, maxLateMs: 0.4, sent: 2, emitted: 2 },
        ended: { worked: false, cause: 'deviation', why: 'movement deviated' },
        readings: { fresh: 20, reused: 20, inferred: false, medianGapMs: 42, readLagMs: { median: 3, max: 9 } },
        thresholdPx: params.thresholdPx, reliableMs: 25, firstOverMs: 500, lastOnsetMs: 500, maxErrorPx: 40, firstOverEvent: 1, continuedMs: 200,
        series: [[0, 0, 0], [250, 2, 10], [500, 30, 5], [700, 40, 5]],
        events: [0, 1].map(i => ({ index: i, at: i * 500, button: i ? 'space' : 'right', down: true, sentMs: i * 500 + 0.4, lateMs: 0.4, returnedMs: i * 500 + 0.5, outcome: 'emitted',
          recorded: { x: 10 * i, y: 100, level: null, nearestMs: 0, interpolated: false }, live: { x: 10 * i + 30 * i, y: 100, level: null, nearestMs: 5, interpolated: true },
          errorPx: 30 * i, lagMs: i ? null : 0, alignedErrorPx: i ? 30 : 0 })) }] };
      if (op === 'clips.list') return { start: 0, stands: 3, note: null, clips: [
        { from: 1000, to: 3000, ms: 2000, start: [150, 195], end: [480, 145], dx: 330, dy: -50, keys: [[0, 'right', true], [1200, 'space', true]] }] };
      return {};
    });
    ipcMain.handle('play:start', (_, params) => { started.push(params); return { ok: true }; });
    ipcMain.handle('play:stop', () => {});
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const js = code => win.webContents.executeJavaScript(code), errors = [];
    win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(50); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab,.panel-tab-click')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})();0`);
    await win.loadFile(path.join(root, 'dist/index.html'));
    const node = (id, kind, x, y, data = {}) => ({ id, type: 'bt', position: { x, y }, data: { kind, ...data } });
    const doc = { version: 1, kind: 'behavior', nodes: [node('root', 'root', 0, 0, { loop: false }), node('seq', 'sequence', 0, 150),
      // its children out of order in the list: they run by where they are, left to right
      node('press', 'press', 300, 320, { keys: [], ms: 150 }), node('cond', 'condition', -300, 320, { formula: '' }),
      node('clip', 'clip', 700, 0, {})],
    edges: [{ id: 'a', source: 'root', sourceHandle: 'children', target: 'seq', targetHandle: 'parent' },
      { id: 'b', source: 'seq', sourceHandle: 'children', target: 'press', targetHandle: 'parent' }, { id: 'c', source: 'seq', sourceHandle: 'children', target: 'cond', targetHandle: 'parent' }] };
    const scope = 'firefly-policy-graph-%7Bsettings%7D';
    const library = { version: 1, selected: 'tree', entries: [{ id: 'trees', parent: null, kind: 'folder', name: 'Trees' }, { id: 'tree', parent: 'trees', kind: 'behavior', name: 'Climb' }] };
    await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem(${JSON.stringify(scope + '-library')},${JSON.stringify(JSON.stringify(library))});
      localStorage.setItem(${JSON.stringify(scope + '-document-tree')},${JSON.stringify(JSON.stringify(doc))});0`);
    await win.reload();
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
    const n = id => `document.querySelector('.react-flow__node[data-id="${id}"]')`;
    await until(`${n('root')}&&${n('cond')}`, 'the tree');
    assert.match(await js(`document.querySelector('.graph-breadcrumb').textContent`), /Behavior tree/);
    // What's wrong, on the nodes, and Run held back until it's put right
    await until(`${n('cond')}.textContent.includes('write its formula')`, 'the condition says what’s wrong');
    assert.match(await js(`${n('press')}.textContent`), /choose the keys it presses/);
    assert.ok(await js(`document.querySelector('[aria-label="Run the tree"]').disabled`));
    assert.match(await js(`document.querySelector('.bt-status').textContent`), /2 nodes to put right · 1 not under the Root/);
    // A State into the condition's formula, and space into the press
    await js(`(()=>{const s=${n('cond')}.querySelector('[aria-label="Put a State in True when"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'On Ground');s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    await until(`${n('cond')}.querySelector('[aria-label="True when"]').value==='\`On Ground\`'`, 'the State put in, in backticks');
    await js(`(()=>{const s=${n('press')}.querySelector('[aria-label="Add a key to Keys"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'space');s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    await until(`${n('press')}.querySelector('.bt-chip')?.textContent.includes('Space')`, 'space chosen');
    await until(`!document.querySelector('[aria-label="Run the tree"]').disabled`, 'Run once nothing is wrong');
    // A clip found in a recording, measured by the player's position
    await js(`[...${n('clip')}.querySelectorAll('button')].find(b=>b.textContent==='Find clips').click()`);
    await until(`${n('clip')}.querySelectorAll('.bt-clip-row').length===1`, 'the clips');
    const clipCall = asked.find(([op]) => op === 'clips.list')[1];
    assert.equal(clipCall.recording, 'run'); assert.equal(clipCall.position, '`Player Position`');  // a formula: the State's name in backticks
    await js(`${n('clip')}.querySelector('.bt-clip-row').click()`);
    await until(`${n('clip')}.textContent.includes('Jump quest · 2.00 s')`, 'the clip chosen');
    // Run: the tree under the Root, children left to right, the keys FireFly can press
    await js(`document.querySelector('[aria-label="Run the tree"]').click()`);
    for (let i = 0; i < 60 && !started.length; i++) await wait(50);
    const p = started[0];
    assert.equal(p.windowId, '123'); assert.equal(p.treeId, 'tree'); assert.equal(p.name, 'Climb');
    assert.equal(p.behavior.tree.root, 'root');
    assert.deepEqual(p.behavior.tree.nodes.seq.children, ['cond', 'press']);
    assert.deepEqual(p.behavior.tree.nodes.press.params.keys, ['space']);
    assert.equal(p.behavior.tree.nodes.cond.params.formula, '`On Ground`');
    assert.equal(p.behavior.tree.nodes.root.params.loop, false);
    assert.ok(!p.behavior.tree.nodes.clip, 'not under the Root: not sent');
    assert.deepEqual(p.behavior.buttons.find(b => b.id === 'space'), { id: 'space', vk: 32 });
    // Lit while it runs
    win.webContents.send('play:status', { playing: true, behavior: true, treeId: 'tree', name: 'Climb', graphId: 'tree', actions: 3, released: 0,
      tree: { text: 'pressing space 40/150 ms', nodes: { root: 'running', seq: 'running', cond: 'success', press: 'running' }, done: null } });
    await until(`${n('press')}.querySelector('.bt-running')||${n('press')}.firstElementChild.classList.contains('bt-running')`, 'the press lit as running');
    assert.ok(await js(`${n('cond')}.firstElementChild.classList.contains('bt-success')`));
    assert.match(await js(`document.querySelector('.bt-status').textContent`), /Climb is running: pressing space 40\/150 ms/);
    assert.ok(await js(`[...document.querySelectorAll('.collection-toolbar button')].some(b=>b.textContent==='Stop')`));
    require('node:fs').writeFileSync(path.join(root, 'build', 'behavior-ui.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.send('play:status', { playing: false, behavior: true, treeId: 'tree', name: 'Climb', graphId: 'tree', reason: 'The tree succeeded' });
    await until(`document.querySelector('.bt-status').textContent.includes('Stopped: The tree succeeded')`, 'why it stopped');
    // Replay: the run's recorded movement against its recording, and a key event clicked going to its moment
    await js(`document.querySelector('[aria-label="Replay runs"]').click();0`);
    await until(`document.querySelector('.bt-replay-at')?.textContent.includes('frame 1/3')`, 'the run loaded');
    await click('Movement');
    await js(`(()=>{const i=document.querySelector('[aria-label="Divergence threshold"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'12');i.dispatchEvent(new Event('input',{bubbles:true}));})();0`);
    await click('Compare with recording');
    await until(`document.querySelectorAll('.rr-events tbody tr').length===2`, 'the key events');
    const compared = asked.find(([op]) => op === 'behavior.replay')[1];
    assert.equal(compared.file, 'run.jsonl'); assert.equal(compared.thresholdPx, 12); assert.ok(compared.maps && typeof compared.maps === 'object', 'the map bundle, for older traces');
    const facts = await js(`document.querySelector('.rr-facts').textContent`);
    assert.match(facts, /cancelled by request/); assert.match(facts, /first over 12\.0 px at 0\.50 s \(key event #1\)/); assert.match(facts, /went on 0\.20 s after it/);
    assert.match(facts, /read 3 ms after capture/);
    assert.ok(await js(`document.querySelectorAll('.rr-events tbody tr')[1].classList.contains('rr-first')`), 'the first event over the threshold marked');
    assert.match(await js(`document.querySelectorAll('.rr-events tbody tr')[1].textContent`), /\(10, 100\).*\(40, 100\) ~5 ms.*30\.0 px.*can’t tell/);
    await js(`document.querySelectorAll('.rr-events tbody tr')[1].click();0`);
    await until(`document.querySelector('.bt-replay-at').textContent.includes('frame 2/3')`, 'the replay at that key event');
    const logged = errors.filter(e => !/DevTools|Autofill|ResizeObserver loop/.test(e));
    assert.equal(logged.length, 0, 'Console errors: ' + logged.join(' | '));
    console.log('Behavior UI: ok');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
