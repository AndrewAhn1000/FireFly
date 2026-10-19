// A Planner node's Drive: with a capture session, its plan along shapes and a destination, Drive sends the Planner's
// request to play (the planner moving the player itself, worker/executor.py), the node and the banner say what it's
// doing, and Stop driving stops it. Needs `npm run build`
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'drive-ui-profile'));
let win; const watchdog = setTimeout(() => { console.error('Drive UI timed out'); app.exit(1); }, 60000);
const fields = [{ name: 'Player', type: 'vector' }, { name: 'platforms', type: 'shapes' }];
const recordings = [{ id: 'run', name: 'Jump quest', status: 'complete', samples: 100, invalidSamples: 0, durationMs: 30000, inputEvents: 40,
  metadata: { started: 1, hz: 20, observationSchema: { identity: 'obs', fields }, actionSchema: { identity: 'act', buttons: [{ id: 'right', vk: 39 }, { id: 'space', vk: 32 }] } } }];
const driven = []; let stopped = 0;

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
      if (op === 'models') return [];
      if (op === 'columns') return { groups: [], fields: [], formulas: [], grids: [], spatial: [], goals: [] };
      if (op === 'planner.preview') return { places: [[0, 195], [40, 195], [300, 145]], moves: [[0, 1], [1, 2]], count: { places: 3, moves: 2 }, recordings: 1, level: null, error: null,
        library: { along: 2, hops: 1, levels: 1, coverage: null }, position: [0, 195], destination: params.goal.plan.destination ? [480, 145] : null, path: null, target: null, next: null, seconds: null };
      if (op === 'preview') return { samples: 900, stepMs: 50, recordings: [{ id: 'run', rows: 900 }], skipped: [], skippedReasons: {}, values: [], inputs: 0, buttons: [] };
      return {};
    });
    ipcMain.handle('play:start', (_, params) => { driven.push(params); return { ok: true }; });
    ipcMain.handle('play:stop', () => { stopped++; });
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const js = code => win.webContents.executeJavaScript(code), errors = [];
    win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(50); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab,.panel-tab-click')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})();0`);
    const send = (channel, value) => win.webContents.send(channel, value);
    await win.loadFile(path.join(root, 'dist/index.html'));
    const state = (id, name, y) => ({ id, type: 'state', position: { x: 0, y }, data: { kind: 'state', name } });
    const graph = { version: 1, nodes: [state('player', 'Player', 0), state('floor', 'platforms', 150),
      { id: 'near', type: 'spatial', position: { x: 250, y: 300 }, data: { kind: 'spatial', name: 'near', inputs: ['platforms'], radii: [100, 250, 500], maxDistance: 1000 } },
      { id: 'goal', type: 'goal', position: { x: 600, y: 0 }, data: { kind: 'goal', name: 'goal', lookAhead: [1, 4], targets: 3, minMove: 20 } },
      { id: 'way', type: 'planner', position: { x: 250, y: 600 }, data: { kind: 'planner', name: 'Way up', mode: 'plan', route: { recording: '', aheadS: 2.5 },
        plan: { cell: 40, aheadS: 2.5, destination: { kind: 'point', x: 480, y: 145 }, places: 'shapes', on: ['platforms'] } } },
      { id: 'recs', type: 'recordings', position: { x: 0, y: 600 }, data: { kind: 'recordings', ids: ['run'] } }],
    edges: [{ id: 'e1', source: 'player', sourceHandle: 'out', target: 'goal', targetHandle: 'in:@position' },
      { id: 'e2', source: 'player', sourceHandle: 'out', target: 'near', targetHandle: 'in:@point' }, { id: 'e3', source: 'floor', sourceHandle: 'out', target: 'near', targetHandle: 'in:platforms' },
      { id: 'e4', source: 'near', sourceHandle: 'out', target: 'way', targetHandle: 'in:@map' }, { id: 'e5', source: 'way', sourceHandle: 'out', target: 'goal', targetHandle: 'in:@target' },
      { id: 'e6', source: 'recs', sourceHandle: 'data', target: 'way', targetHandle: 'in:@data' }] };
    await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem('firefly-policy-graph-%7Bsettings%7D',${JSON.stringify(JSON.stringify(graph))});0`);
    await win.reload();
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
    const planner = `document.querySelector('.react-flow__node[data-id="way"]')`;
    await until(`${planner}&&${planner}.querySelector('[aria-label="Drive"]')`, 'the Drive button');
    await until(`!${planner}.querySelector('[aria-label="Drive"]').disabled`, 'Drive enabled with a session and a destination');
    await js(`${planner}.querySelector('[aria-label="Drive"]').click()`);
    for (let i = 0; i < 60 && !driven.length; i++) await wait(50);
    const asked = driven[0];
    assert.equal(asked.windowId, '123'); assert.equal(asked.driverId, 'way'); assert.equal(asked.name, 'Way up');
    assert.equal(asked.modelId, undefined, 'no policy is played');
    assert.deepEqual(asked.drive.goal.plan.destination, { kind: 'point', x: 480, y: 145 });
    assert.deepEqual(asked.drive.goal.plan.inputs, [{ alias: 'platforms', shapes: ['platforms'] }]);
    assert.equal(asked.drive.goal.position, 'Player'); assert.deepEqual(asked.drive.recordingIds, ['run']);
    // What it's doing, on the node and in the banner
    send('play:status', { playing: true, drive: true, name: 'Way up', driverId: 'way', actions: 12, released: 0,
      driving: { phase: 'position', text: 'running up to a hop to (300, 145): 40 px', done: 2, missed: 1, misses: [{ from: [280, 195], to: [300, 145], why: 'it landed somewhere else' }] } });
    await until(`${planner}.textContent.includes('Stop driving')`, 'Stop driving on the node');
    assert.match(await js(`${planner}.textContent`), /running up to a hop to \(300, 145\): 40 px · 2 done, 1 missed/);
    assert.match(await js(`document.querySelector('.pg-banner-live').textContent`), /Way up is driving: running up.*2 hops done, 1 missed \(last: from \(280, 195\) to \(300, 145\), it landed somewhere else\)/);
    require('node:fs').writeFileSync(path.join(root, 'build', 'drive-ui.png'), (await win.webContents.capturePage()).toPNG());
    await js(`[...${planner}.querySelectorAll('button')].find(b=>b.textContent==='Stop driving').click()`);
    for (let i = 0; i < 60 && !stopped; i++) await wait(50);
    assert.equal(stopped, 1);
    send('play:status', { playing: false, reason: 'Player takeover (a key)', drive: true, name: 'Way up', driverId: 'way' });
    await until(`document.querySelector('.pg-banner')?.textContent.includes('Stopped: Player takeover')`, 'why it stopped');
    await until(`!!${planner}.querySelector('[aria-label="Drive"]')`, 'Drive again');
    // Without a destination it can't
    await js(`(()=>{const s=${planner}.querySelector('[aria-label="Plan destination"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'input');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(200);
    assert.ok(await js(`${planner}.querySelector('[aria-label="Drive"]').disabled === false`), 'enabled: what is wired in is checked when it starts');
    const logged = errors.filter(e => !/DevTools|Autofill|ResizeObserver loop/.test(e));
    assert.equal(logged.length, 0, 'Console errors: ' + logged.join(' | '));
    console.log('Drive UI: ok');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
