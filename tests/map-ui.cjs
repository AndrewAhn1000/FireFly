// Sub-trees, maps and replays in the Graphs view: a tree's Run tree node giving another tree its inputs, a Go to node
// going over a map, Run sending the trees and maps it needs, a tree run by another lit as it runs there, a run stepped
// through frame by frame, and a map built (places added on the canvas, links suggested from recordings, a link's
// tree chosen, what it learned shown). Needs `npm run build`
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'map-ui-profile'));
let win; const watchdog = setTimeout(() => { console.error('Map UI timed out'); app.exit(1); }, 90000);
const fields = [{ name: 'Player Position', type: 'vector' }, { name: 'On Ground', type: 'boolean' }, { name: 'Platforms', type: 'shapes' }];
const recordings = [{ id: 'run', name: 'Jump quest', status: 'complete', samples: 100, invalidSamples: 0, durationMs: 30000, inputEvents: 40,
  metadata: { started: 1, hz: 20, observationSchema: { identity: 'obs', fields }, actionSchema: { identity: 'act', buttons: [{ id: 'right', vk: 39 }, { id: 'space', vk: 32 }] } } }];
const started = [], asked = [], stopped = [];
const frames = [
  { t: 0, now: 50, keys: ['right'], nodes: { root: 'running', run: 'running' }, trees: { walk: { w: 'running' } }, text: 'walking right: 200 px to go', values: { 'Player Position': [100, 195] } },
  { t: 45, now: 95, keys: ['right'], nodes: { root: 'running', run: 'running' }, trees: { walk: { w: 'running' } }, text: 'walking right: 195 px to go', values: { 'Player Position': [105, 195] } },
  { t: 90, now: 140, keys: [], nodes: { root: 'running', run: 'success', go: 'running' }, trees: { walk: { w: 'success' } }, maps: { m: { text: 'to Ledge', at: 'a', dest: 'c', link: 'ab' } },
    text: 'to Ledge', values: { 'Player Position': [300, 195] } }];

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
      if (op === 'behavior.check') return { errors: {}, buttons: ['right'] };
      if (op === 'behavior.traces' && params.treeId !== 'm') return { runs: [{ file: '2026-10-19 10-00-00.jsonl', when: '2026-10-19 10-00-00', frames: frames.length }] };
      if (op === 'behavior.trace') return { head: { treeId: 'main', buttons: ['right'], reads: ['Player Position'] }, frames };
      if (op === 'map.frame') return { position: [120, 195], level: null, shapes: { Platforms: [[[0, 200], [400, 200]], [[300, 150], [500, 150]]] }, errors: {} };
      if (op === 'map.grid') return { execution: 'sequences', places: [[null, 120, 195, 1], [null, 315, 145, 1]],
        moves: [[0, 1, 1800, 1, ['right', 'space']]], linkIds: ['recorded:test'], paths: [[[120, 195], [220, 120], [315, 145]]], recordings: 1, notes: [], synced: 1, waits: 2,
        ...(params.map?.grid?.replay?.ground ? { unsafe: [true], takeoff: { counts: { adapt: 3, unsafe: 1, narrow: 1, timed: 2 }, unsafe: 1,
          model: { walk: 0.125, jump: 0.557, gravity: 0.002, fall: 0.5, jumpKey: 'space', leftKey: 'left', rightKey: 'right', delays: [-14, -3, 22], leaveMs: 68, jumps: 40, rms: { p50: 2.2, p90: 3.7 } } } } : {}) };
      if (op === 'behavior.traces') return { runs: [{ file: 'drive.jsonl', when: '2026-10-19 16-41-21', frames: 90 }] };  // the map's runs
      // as the worker's replay report: a tree link that worked, then a recorded movement that parted from its recording
      if (op === 'behavior.replay') return { notes: [], summary: { attempts: 2, direct: 1, corrected: 0, recovered: 0, failed: 1, unended: 0, retries: 0 }, attempts: [
        { attempt: 1, link: 'ab', map: 'm', kind: 'tree', recorded: false, from: 'a', to: 'b', ended: { worked: true, cause: null, why: null } },
        { attempt: 2, link: 'recorded:test', map: 'm', recorded: true,
          lineUp: { target: [120, 195], from: [131, 195], to: [119, 195], offPx: 1, worked: true, taps: [{ axis: 'x', keys: ['left'], ms: 40, errorPx: 11, movedPx: -12 }] }, recordedStart: [120, 195], recordedEnd: [315, 145], recordedMs: 1800, startOffsetPx: 6.8,
          actionId: 1, durationMs: 1800, startedAt: 1000, thresholdPx: params.thresholdPx, reliableMs: 25, firstOverMs: 900, lastOnsetMs: 900, maxErrorPx: 60, firstOverEvent: 1, continuedMs: 300,
          executor: { state: 'cancelled', cause: 'request', error: null, ranMs: 1200, maxLateMs: 0.2, sent: 2, emitted: 2 },
          ended: { worked: false, cause: 'deviation', why: 'movement deviated 1.20 s into replay' },
          parts: 2, syncs: [{ index: 1, worked: true, waitedMs: 31, lateMs: 15 }], takeoffMode: 'adaptive', unsafe: null,
          jumps: [{ index: 0, at: 500, status: 'adapt', mode: 'adaptive', forced: false, demoX: 170, interval: [168, 190], window: [168, 190], aim: 172,
            plan: { worked: true, leadMs: 30, estX: 172, observedX: 168 }, sent: true, sentMs: 520, takeoffX: 172.4, inInterval: true,
            predicted: { x: 300.5, on: 'target' }, landed: { x: 302, y: 145, on: 'target', ms: 560 }, worked: true, landingErrorPx: 1.5 },
          { index: 1, at: 1400, status: 'timed', why: 'keys change in the air', mode: 'adaptive', sent: true },
          { index: 2, at: 1600, status: 'adapt', mode: 'adaptive', demoX: 240, interval: [236, 250], window: [236, 250], aim: 240,
            plan: { worked: false, why: 'past its safe stretch 236..250: at about 254 by now' }, sent: false }],
          readings: { fresh: 30, reused: 30, inferred: false, medianGapMs: 42, readLagMs: { median: 9, max: 19 } },
          series: [[0, 6.8, 0], [900, 12, 0], [1200, 60, 0]], recordedPath: [[0, 120, 195], [900, 220, 120], [1800, 315, 145]], livePath: [[0, 113, 195], [900, 214, 128], [1200, 230, 190]],
          events: [{ index: 0, at: 0, button: 'right', down: true, sentMs: 0.2, lateMs: 0.2, returnedMs: 0.3, outcome: 'emitted', recorded: { x: 120, y: 195, level: null, nearestMs: 0, interpolated: false },
            live: { x: 113, y: 195, level: null, nearestMs: 0, interpolated: false }, errorPx: 6.8, lagMs: null, alignedErrorPx: 6.8 },
          { index: 1, at: 900, button: 'up', down: true, sentMs: 900.1, lateMs: 0.1, returnedMs: 900.2, outcome: 'emitted', recorded: { x: 220, y: 120, level: null, nearestMs: 0, interpolated: false },
            live: { x: 214, y: 128, level: null, nearestMs: 0, interpolated: false }, errorPx: 10, lagMs: 10, alignedErrorPx: 9 }] },
        { attempt: 'line-up 3', link: null, map: 'm', kind: 'line-up', recorded: false, ended: { worked: false, cause: 'line-up', why: '7.0 px off after 3 taps' },
          lineUp: { target: [315, 145], from: [325, 145], to: [322, 145], offPx: 7, worked: false, why: '7.0 px off after 3 taps', taps: [] } }] };
      if (op === 'map.stats') return { stats: params.forget ? {} : { ab: { runs: 4, fails: 1, ms: 2400 } } };
      if (op === 'map.suggest') return { links: [{ from: 'a', to: 'c', count: 2, ms: 1800, clip: { recording: 'run', from: 1000, to: 2800 } }],
        places: [{ level: null, x: 480, y: 145, n: 3 }] };
      return {};
    });
    ipcMain.handle('play:start', (_, params) => { started.push(params); return { ok: true }; });
    ipcMain.handle('play:stop', (_, how) => { stopped.push(how); });
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const js = code => win.webContents.executeJavaScript(code), errors = [];
    win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(50); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab,.panel-tab-click')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})();0`);
    const choose = (selector, value) => js(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});if(!s)throw Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    const type = (selector, value) => js(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});if(!s)throw Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('input',{bubbles:true}));})();0`);
    const tool = text => js(`[...document.querySelectorAll('.map-editor .collection-toolbar button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    await win.loadFile(path.join(root, 'dist/index.html'));
    const node = (id, kind, x, y, data = {}) => ({ id, type: 'bt', position: { x, y }, data: { kind, ...data } });
    const edge = (id, source, target) => ({ id, source, sourceHandle: 'children', target, targetHandle: 'parent' });
    const main = { version: 1, kind: 'behavior', nodes: [node('root', 'root', 0, 0, { loop: false }), node('seq', 'sequence', 0, 150),
      node('run', 'run', -200, 320, { tree: '', args: {} }), node('go', 'go', 200, 320, { map: '', place: '', target: '' })],
      edges: [edge('a', 'root', 'seq'), edge('b', 'seq', 'run'), edge('c', 'seq', 'go')] };
    const walk = { version: 1, kind: 'behavior', nodes: [node('root', 'root', 0, 0, { loop: false, inputs: [{ name: 'to', type: 'vector' }] }),
      node('w', 'walk', 0, 150, { position: '`Player Position`', target: 'to', axis: 'x', less: ['left'], more: ['right'], within: 6, ms: 5000 })], edges: [edge('a', 'root', 'w')] };
    const up = { version: 1, kind: 'behavior', nodes: [node('root', 'root', 0, 0, { loop: false }), node('p', 'press', 0, 150, { keys: ['space'], ms: 150 })], edges: [edge('a', 'root', 'p')] };
    const map = { version: 1, kind: 'map', position: '`Player Position`', level: '', grounded: '', draw: ['Platforms'], reach: 24, giveUp: 3, linkMs: 10000, arriveMs: 1500, approach: null,
      places: [{ id: 'a', name: 'Start', level: null, x: 100, y: 195 }, { id: 'b', name: 'Takeoff', level: null, x: 270, y: 195 }, { id: 'c', name: 'Ledge', level: null, x: 315, y: 145 }],
      links: [{ id: 'ab', from: 'a', to: 'b', kind: 'tree', tree: 'walk', args: {} }, { id: 'bc', from: 'b', to: 'c', kind: 'tree', tree: 'up', args: {} }] };
    const scope = 'firefly-policy-graph-%7Bsettings%7D';
    const library = { version: 1, selected: 'main', entries: [{ id: 'trees', parent: null, kind: 'folder', name: 'Trees' },
      { id: 'main', parent: 'trees', kind: 'behavior', name: 'Main' }, { id: 'walk', parent: 'trees', kind: 'behavior', name: 'Walk there' },
      { id: 'up', parent: 'trees', kind: 'behavior', name: 'Jump up' }, { id: 'm', parent: 'trees', kind: 'map', name: 'Quest map' }] };
    const set = Object.entries({ library, 'document-main': main, 'document-walk': walk, 'document-up': up, 'document-m': map })
      .map(([k, v]) => `localStorage.setItem(${JSON.stringify(scope + '-' + k)},${JSON.stringify(JSON.stringify(v))});`).join('');
    await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');${set}
      localStorage.setItem(${JSON.stringify(scope + '-document-m-view')},JSON.stringify({x:0,y:0,scale:1}));0`);
    await win.reload();
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
    const n = id => `document.querySelector('.react-flow__node[data-id="${id}"]')`;
    await until(`${n('run')}&&${n('go')}`, 'the tree');
    // Run tree: the other trees offered (not itself), and its inputs asked for
    const offered = await js(`[...${n('run')}.querySelectorAll('[aria-label="Tree to run"] option')].map(o=>o.textContent)`);
    assert.deepEqual(offered, ['Choose a tree…', 'Walk there', 'Jump up']);
    await choose('.react-flow__node[data-id="run"] [aria-label="Tree to run"]', 'walk');
    await until(`!!${n('run')}.querySelector('[aria-label="to (vector)"]')`, 'its input');
    await type('.react-flow__node[data-id="run"] [aria-label="to (vector)"]', 'vec(300, 195)');
    // Go to: the maps, then their places
    await choose('.react-flow__node[data-id="go"] [aria-label="Map to go over"]', 'm');
    await until(`!!${n('go')}.querySelector('[aria-label="Place to go to"]')`, 'the places');
    assert.deepEqual(await js(`[...${n('go')}.querySelectorAll('[aria-label="Place to go to"] option')].map(o=>o.textContent)`),
      ['a position (the nearest place)', 'Start', 'Takeoff', 'Ledge']);
    await choose('.react-flow__node[data-id="go"] [aria-label="Place to go to"]', 'c');
    // checked with what it runs and goes over
    await until(`true`); await wait(600);
    const check = asked.filter(([op]) => op === 'behavior.check').at(-1)[1];
    assert.equal(check.treeId, 'main');
    assert.deepEqual(Object.keys(check.trees).sort(), ['up', 'walk']);
    assert.deepEqual(check.maps.m.places.map(p => p.id), ['a', 'b', 'c']);
    // Run: the trees and maps sent with it
    await until(`!document.querySelector('[aria-label="Run the tree"]').disabled`, 'Run');
    await js(`document.querySelector('[aria-label="Run the tree"]').click()`);
    for (let i = 0; i < 60 && !started.length; i++) await wait(50);
    const b = started[0].behavior;
    assert.equal(b.tree.nodes.run.params.tree, 'walk');
    assert.equal(b.tree.nodes.run.params.args.to, 'vec(300, 195)');
    assert.equal(b.tree.nodes.go.params.place, 'c');
    assert.equal(b.trees.walk.nodes.w.params.target, 'to');
    assert.ok(b.trees.up, 'a link’s tree is sent too');
    assert.equal(b.maps.m.links[1].tree, 'up');
    assert.equal(b.maps.m.position, '`Player Position`');
    // A tree run by another is lit as it runs there
    const playing = { playing: true, behavior: true, treeId: 'main', name: 'Main', graphId: 'main', actions: 3, released: 0,
      tree: { text: 'walking right: 200 px to go', nodes: { root: 'running', seq: 'running', run: 'running' }, trees: { walk: { w: 'running' } },
        maps: { m: { at: 'a', dest: 'c', way: ['ab', 'bc'], link: 'ab', fails: {}, text: 'to Takeoff' } }, done: null } };
    win.webContents.send('play:status', playing);
    await until(`${n('run')}.firstElementChild.classList.contains('bt-running')`, 'the run node lit');
    await js(`document.querySelector('[aria-label="behavior: Walk there"]').click()`);
    await until(`!!${n('w')}`, 'the walk tree');
    win.webContents.send('play:status', playing);
    await until(`${n('w')}.firstElementChild.classList.contains('bt-running')`, 'lit inside the tree running it');
    assert.match(await js(`document.querySelector('.bt-status').textContent`), /Running inside Main/);
    assert.ok(await js(`document.querySelector('[aria-label="Run the tree"]').disabled`), 'a tree with inputs runs only from another');
    win.webContents.send('play:status', { playing: false, behavior: true, treeId: 'main', name: 'Main', graphId: 'main', reason: 'Stopped by the player' });
    // Replay: a run stepped through, its nodes lit as they were, what it held and read
    await js(`document.querySelector('[aria-label="behavior: Main"]').click()`);
    await until(`!!${n('run')}`, 'the main tree');
    await js(`document.querySelector('[aria-label="Replay runs"]').click()`);
    await until(`document.querySelector('.bt-replay-at')?.textContent.includes('frame 1/3')`, 'the replay');
    assert.match(await js(`document.querySelector('.bt-replay').textContent`), /walking right: 200 px to go/);
    assert.match(await js(`document.querySelector('.bt-replay').textContent`), /Player Position\(100, 195\)/);
    assert.ok(await js(`${n('run')}.firstElementChild.classList.contains('bt-running')`));
    await js(`document.querySelector('[aria-label="Next change"]').click()`);
    await until(`document.querySelector('.bt-replay-at').textContent.includes('frame 3/3')`, 'on to where what it did changed');
    await until(`${n('run')}.firstElementChild.classList.contains('bt-success')`, 'lit as it was then');
    assert.match(await js(`document.querySelector('.bt-replay').textContent`), /to Ledge/);
    await js(`document.querySelector('[aria-label="Previous frame"]').click()`);
    await until(`document.querySelector('.bt-replay-at').textContent.includes('frame 2/3')`, 'a frame back');
    require('node:fs').writeFileSync(path.join(root, 'build', 'replay-ui.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('[aria-label="Replay runs"]').click()`);
    // The map: drawn over what FireFly observes, places added on the canvas, links suggested, a link's tree chosen
    await js(`document.querySelector('[aria-label="map: Quest map"]').click()`);
    await until(`!!document.querySelector('[aria-label="Map editor"]')`, 'the map editor');
    assert.match(await js(`document.querySelector('.graph-breadcrumb').textContent`), /Map/);
    const observe = setInterval(() => win.webContents.send('runtime:event', { event: 'observations', result: { observations: [{ name: 'Player Position', valid: true, value: [120, 195] }] } }), 100);
    await until(`!document.querySelector('[title="A place where the player is now"]').disabled`, 'the player’s position, from map.frame');
    clearInterval(observe);
    assert.ok(asked.some(([op, p]) => op === 'map.frame' && p.position === '`Player Position`' && p.draw[0] === 'Platforms'));
    const learned = await js(`document.querySelector('.map-inspector').textContent`);
    assert.match(learned, /1 links run 4 times/);
    // Drive is available directly on the map and bundles its linked trees.
    await choose('[aria-label="Drive destination"]', 'c');
    await until(`!document.querySelector('[aria-label="Drive map"]').disabled`, 'Drive from the map');
    await js(`document.querySelector('[aria-label="Drive map"]').click()`);
    for (let i = 0; i < 60 && started.length < 2; i++) await wait(50);
    const drive = started.at(-1);
    assert.equal(drive.graphId, 'm'); assert.equal(drive.treeId, 'm');
    assert.equal(drive.behavior.tree.nodes.root.params.loop, false);
    assert.deepEqual(drive.behavior.tree.nodes.action.params, {map: 'm', place: 'c', target: ''});
    assert.deepEqual(Object.keys(drive.behavior.trees).sort(), ['up', 'walk']);
    assert.equal(drive.behavior.maps.m.links[1].tree, 'up');
    win.webContents.send('play:status', {...playing, graphId: 'm', treeId: 'm', name: 'Quest map · Drive'});
    await until(`!!document.querySelector('[aria-label="Stop map"]')`, 'Stop replaces Drive');
    await js(`document.querySelector('[aria-label="behavior: Main"]').click()`);
    await until(`!!document.querySelector('[aria-label="Run the tree"]')`, 'another graph');
    await js(`document.querySelector('[aria-label="map: Quest map"]').click()`);
    await until(`!!document.querySelector('[aria-label="Stop map"]')`, 'Stop survives leaving and reopening the map');
    await js(`document.querySelector('[aria-label="Stop map"]').click()`);
    for (let i = 0; i < 40 && !stopped.length; i++) await wait(25);
    assert.equal(stopped.length, 1);
    win.webContents.send('play:status', {playing: false, treeId: 'm', reason: 'Stopped by the player'});
    await until(`document.querySelector('[aria-label="Map execution"]').textContent.includes('Stopped: Stopped by the player')`, 'the stop reason');
    win.webContents.send('play:status', {playing: false, treeId: 'm', reason: 'The tree failed: no way from Start to Destination'});
    await until(`document.querySelector('[aria-label="Map execution"]').textContent.includes('Stopped: The tree failed: no way from Start to Destination')`, 'the actual route failure');
    // + Place, then a click on the canvas
    await tool('+ Place');
    const at = async (x, y, kind = 'pointerdown') => js(`(()=>{const c=document.querySelector('[aria-label="Map"]'),r=c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('${kind}',{bubbles:true,clientX:r.left+${x},clientY:r.top+${y},pointerId:1}));})();0`);
    await at(400, 60);
    const saved = () => js(`JSON.parse(localStorage.getItem(${JSON.stringify(scope + '-document-m')}))`);
    for (let i = 0; i < 40 && (await saved()).places.length < 4; i++) await wait(50);
    let m = await saved();
    assert.equal(m.places.length, 4);
    assert.deepEqual([m.places[3].x, m.places[3].y, m.places[3].name], [400, 60, 'Place 4']);
    await until(`document.querySelector('[aria-label="Place name"]')?.value==='Place 4'`, 'the new place chosen');
    await type('[aria-label="Place name"]', 'Roof');
    // + Link: from Ledge to the Roof, then its tree
    await tool('+ Link');
    await at(315, 145); await at(400, 60);
    for (let i = 0; i < 40 && (await saved()).links.length < 3; i++) await wait(50);
    m = await saved();
    assert.equal(m.places[3].name, 'Roof');
    assert.deepEqual([m.links[2].from, m.links[2].to, m.links[2].kind], ['c', m.places[3].id, 'tree']);
    await until(`document.querySelector('.map-inspector').textContent.includes('Link: Ledge → Roof')`, 'the new link chosen');
    await choose('.map-inspector [aria-label="Tree"]', 'up');
    await until(`document.querySelector('.map-inspector').textContent.includes('Give its Root a vector input named from or to')`, 'what a link’s tree is given');
    // Select: a click on a link chooses it, with what it learned
    await tool('Select');
    await at(185, 195);
    await until(`document.querySelector('.map-inspector').textContent.includes('Link: Start → Takeoff')`, 'the link clicked');
    assert.match(await js(`document.querySelector('.map-inspector').textContent`), /Run 4 times, worked 3, taking 2\.40 s/);
    await js(`[...document.querySelectorAll('.map-inspector label')].find(l=>l.textContent.trim()==='Keys').querySelector('input').click()`);
    await until(`document.querySelector('.map-inspector').textContent.includes('Release keys and wait until the player reaches the next place.')`, 'a no-input link explains its behavior');
    await until(`!document.querySelector('[aria-label="Drive map"]').disabled`, 'no-input links are valid for Drive');
    require('node:fs').writeFileSync(path.join(root, 'build', 'map-wait-ui.png'), (await win.webContents.capturePage()).toPNG());
    // Suggestions from the recordings: a link between two places, and where you stood
    await js(`document.querySelector('[aria-label="Map"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until(`[...document.querySelectorAll('.map-inspector button')].some(b=>b.textContent==='Suggest places and links')`, 'the suggestions');
    await click('Suggest places and links');
    await until(`!!document.querySelector('[aria-label="Suggestions"]')`, 'suggested');
    const sug = asked.filter(([op]) => op === 'map.suggest').at(-1)[1];
    assert.equal(sug.position, '`Player Position`'); assert.deepEqual(sug.recordings, ['run']); assert.equal(sug.places.length, 4);
    await click('Add every link');
    for (let i = 0; i < 40 && (await saved()).links.length < 4; i++) await wait(50);
    m = await saved();
    assert.deepEqual([m.links[3].from, m.links[3].to, m.links[3].kind, m.links[3].clip.recording], ['a', 'c', 'clip', 'run']);
    // An explicit recording link replays only its clip, not the planner.
    await tool('Select'); await at(207.5, 170);
    await until(`!!document.querySelector('[aria-label="Replay selected clip"]')`, 'clip selected');
    win.webContents.send('play:status', {...playing, graphId: 'main', treeId: 'main'});
    await until(`document.querySelector('[aria-label="Replay selected clip"]').disabled`, 'another run blocks replay');
    assert.ok(await js(`document.querySelector('[aria-label="Drive map"]').disabled`));
    win.webContents.send('play:status', {playing: false});
    await until(`!document.querySelector('[aria-label="Replay selected clip"]').disabled`, 'ready to replay');
    await js(`document.querySelector('[aria-label="Replay selected clip"]').click()`);
    for (let i = 0; i < 60 && started.length < 3; i++) await wait(50);
    const replay = started.at(-1);
    assert.equal(replay.behavior.tree.nodes.root.params.loop, false);
    assert.equal(replay.behavior.tree.nodes.action.kind, 'clip');
    assert.deepEqual(replay.behavior.tree.nodes.action.params, {recording: 'run', from: 1000, to: 2800});
    assert.deepEqual(replay.behavior.maps, {});
    assert.deepEqual(replay.behavior.trees, {});
    assert.equal(replay.windowId, '123');
    require('node:fs').writeFileSync(path.join(root, 'build', 'map-ui.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.send('play:status', {playing: false});
    const sequenceObservations = setInterval(() => win.webContents.send('runtime:event', { event: 'observations', result: { observations: [{ name: 'Player Position', valid: true, value: [120, 195] }] } }), 100);
    await js(`document.querySelector('[aria-label="Learn a grid"]').click()`);
    await until(`document.querySelector('[aria-label="Nearest recorded stop"]')?.textContent.includes('(120, 195), 0 px away')`, 'the nearest recorded starting stop');
    clearInterval(sequenceObservations);
    assert.equal(await js(`document.querySelector('[aria-label="Learned movement execution"]').value`), 'sequences');
    // How recorded movements replay: nearer their start than the default, lining up with taps of the keys each way
    await js(`(()=>{const i=document.querySelector('[aria-label="Start within"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'3');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await choose('[aria-label="Add a key moving it left"]', 'left');
    await choose('[aria-label="Add a key moving it right"]', 'right');
    // presses after a landing wait for it: a State as the Wait for formula
    await js(`(()=>{const i=document.querySelector('[aria-label="Wait for (optional)"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'\`Player Position\`.y > 0');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`!!document.querySelector('[aria-label="Presses waiting for it: up to"]')`, 'the wait window once Wait for is set');
    await until(`document.querySelector('.map-settings').textContent.includes('1 of 1 movements wait for')`, 'how many learned movements wait');
    // jumps measured on the ground's lines, and pressed where it's safe: what it measured, and the unsafe movement
    assert.equal(await js(`!!document.querySelector('[aria-label="Press jumps"]')`), false, 'how jumps are pressed, before there are lines to measure them on');
    await choose('[aria-label="Ground lines"]', 'Platforms');
    await until(`!!document.querySelector('[aria-label="Press jumps"]')`, 'how jumps are pressed');
    assert.equal(await js(`document.querySelector('[aria-label="Press jumps"]').value`), 'timed', 'timed as recorded, the baseline, unless chosen');
    await choose('[aria-label="Press jumps"]', 'adaptive');
    await until(`document.querySelector('[aria-label="Jumps measured"]')?.textContent.includes('3 can be pressed where it’s safe')`, 'what measuring the jumps found');
    assert.match(await js(`document.querySelector('[aria-label="Jumps measured"]').textContent`), /Measured from 40 jumps: walking 0\.125 px\/ms.*2 have nowhere safe enough \(1 of them only a few px\), and 2 aren’t ones it knows.*1 movement is unsafe, dashed red/);
    await until(`JSON.parse(localStorage.getItem(${JSON.stringify(scope + '-document-m')})).grid.replay?.lineUp?.x?.more?.[0]==='right'`, 'the line-up keys saved');
    await choose('[aria-label="Drive destination"]', 'g1');
    await js(`document.querySelector('[aria-label="Drive map"]').click()`);
    for (let i = 0; i < 60 && started.length < 4; i++) await wait(50);
    const sequences = started.at(-1);
    assert.equal(sequences.behavior.tree.nodes.action.params.place, 'g1');
    assert.equal(sequences.behavior.maps.m.grid.execution ?? 'sequences', 'sequences');
    assert.ok('grounded' in sequences.behavior.maps.m, 'the optional grounded formula reaches sequence learning');
    assert.deepEqual(sequences.behavior.maps.m.grid.replay, { startPx: 3, lineUp: { x: { less: ['left'], more: ['right'] } }, sync: '`Player Position`.y > 0', ground: 'Platforms', takeoff: 'adaptive' },
      'the replay settings sent with the map');
    win.webContents.send('play:status', {...playing, graphId: 'm', treeId: 'm', tree: {text: 'playing its clip 200/1800 ms', maps: {m: {
      at: 'g0', dest: 'g1', way: ['recorded:test'], link: 'recorded:test', fails: {}, text: 'to recorded stop (315, 145)'}}}});
    await until(`!!document.querySelector('[aria-label="Stop map"]')`, 'sequence Drive offers Stop');
    require('node:fs').writeFileSync(path.join(root, 'build', 'map-sequences-ui.png'), (await win.webContents.capturePage()).toPNG());
    // A recording made while the map is open shows up in its lists, to be ticked, without opening it again
    await choose('[aria-label="Grid recordings"]', 'chosen');
    await until(`document.querySelectorAll('[aria-label="Grid recordings ticked"] input').length===1`, 'the ticked list');
    // shown, not squeezed to nothing by the settings above it in a column taller than the window
    assert.ok(await js(`document.querySelector('[aria-label="Grid recordings ticked"]').clientHeight>10`), 'the ticked list has no height');
    recordings.push({ ...recordings[0], id: 'fresh', name: 'Fresh run', metadata: { ...recordings[0].metadata, started: recordings[0].metadata.started + 1 } });
    await until(`document.querySelector('[aria-label="Grid recordings ticked"]').textContent.includes('Fresh run')`, 'a new recording in the ticked list');
    // Runs: each link it tried in a run of this map, the failed movement chosen, both its paths drawn, a key event zoomed to
    await js(`document.querySelector('[aria-label="Map runs panel"]').click()`);
    await until(`document.querySelectorAll('.map-run-attempt').length===3`, 'the run’s attempts');
    assert.match(await js(`document.querySelectorAll('.map-run-attempt')[2].textContent`), /lining up with \(315, 145\)failed \(line-up\)/);
    // the run's attempts counted by outcome, apart, with how many there were
    assert.match(await js(`document.querySelector('.map-runs-list').textContent`), /2 attempts: 1 straight onto their end, 0 corrected onto it, 0 put right after, 1 failed · 0 retries/);
    assert.equal(asked.filter(([op, p]) => op === 'behavior.traces' && p.treeId === 'm').length > 0, true);
    const compared = asked.find(([op]) => op === 'behavior.replay')[1];
    assert.equal(compared.file, 'drive.jsonl'); assert.ok(compared.maps.m?.position, 'the map, for runs from before traces kept their links');
    assert.ok(await js(`document.querySelectorAll('.map-run-attempt')[2].classList.contains('on')`), 'the last failure chosen');
    await js(`document.querySelectorAll('.map-run-attempt')[1].click()`);
    await until(`document.querySelectorAll('.map-run-attempt')[1].classList.contains('on')`, 'the movement chosen');
    assert.match(await js(`document.querySelectorAll('.map-run-attempt')[1].textContent`), /failed \(deviation\) · lined up in 1 tap · started 6\.8 px off · parted at 0\.90 s · jumps 1\/1 landed \(adaptive\)/);
    // its jumps: where each took off and landed against the model, the one it didn't model, and the one it gave up on
    await until(`document.querySelectorAll('[aria-label="Jumps"] tbody tr').length===3`, 'the movement’s jumps');
    const jumpRows = await js(`[...document.querySelectorAll('[aria-label="Jumps"] tbody tr')].map(r=>r.textContent)`);
    assert.match(jumpRows[0], /pressed where safe: 30 ms after deciding, aiming at 172.*168\.\.190.*172.*on target at 301.*on its target at 302.*1\.5 px/);
    assert.match(jumpRows[1], /timed \(keys change in the air\)/);
    assert.match(jumpRows[2], /past its safe stretch.*not sent/);
    assert.ok(await js(`document.querySelector('.rr-attempt').textContent.includes('Jumps · pressed where it’s safe')`));
    assert.match(await js(`document.querySelector('.rr-facts').textContent`), /Lined up with \(120, 195\) from 11 px off to 1\.0 in 1 tap: ← 40 ms → -12 px/);
    assert.match(await js(`document.querySelector('.rr-facts').textContent`), /Played in 2 parts, waiting 1 time: waited 31 ms after each part's last press/);
    assert.match(await js(`document.querySelectorAll('.map-run-attempt')[0].textContent`), /worked/);
    await js(`document.querySelectorAll('.rr-events tbody tr')[1].click()`);
    await until(`document.querySelectorAll('.rr-events tbody tr')[1].classList.contains('rr-selected')`, 'the key event chosen');
    // the map centred on where the recording was at that key event, (220, 120)
    const centred = `(()=>{const v=JSON.parse(localStorage.getItem(${JSON.stringify(scope + '-document-m-view')}));const c=document.querySelector('[aria-label="Map"]');
      return Math.abs(v.x+c.clientWidth/2/v.scale-220)<1&&Math.abs(v.y+c.clientHeight/2/v.scale-120)<1;})()`;
    await until(centred, 'the map centred on the key event');
    require('node:fs').writeFileSync(path.join(root, 'build', 'map-runs-ui.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelectorAll('.map-run-attempt')[0].click()`);
    await until(`document.querySelector('.map-runs-detail').textContent.includes('there’s no recording to compare it with')`, 'a tree link listed, not compared');
    const logged = errors.filter(e => !/DevTools|Autofill|ResizeObserver loop/.test(e));
    assert.equal(logged.length, 0, 'Console errors: ' + logged.join(' | '));
    console.log('Map UI: ok');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
