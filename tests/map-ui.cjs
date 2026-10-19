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
const started = [], asked = [];
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
      if (op === 'behavior.traces') return { runs: [{ file: '2026-10-19 10-00-00.jsonl', when: '2026-10-19 10-00-00', frames: frames.length }] };
      if (op === 'behavior.trace') return { head: { treeId: 'main', buttons: ['right'], reads: ['Player Position'] }, frames };
      if (op === 'map.frame') return { position: [120, 195], level: null, shapes: { Platforms: [[[0, 200], [400, 200]], [[300, 150], [500, 150]]] }, errors: {} };
      if (op === 'map.stats') return { stats: params.forget ? {} : { ab: { runs: 4, fails: 1, ms: 2400 } } };
      if (op === 'map.suggest') return { links: [{ from: 'a', to: 'c', count: 2, ms: 1800, clip: { recording: 'run', from: 1000, to: 2800 } }],
        places: [{ level: null, x: 480, y: 145, n: 3 }] };
      return {};
    });
    ipcMain.handle('play:start', (_, params) => { started.push(params); return { ok: true }; });
    ipcMain.handle('play:stop', () => {});
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
    require('node:fs').writeFileSync(path.join(root, 'build', 'map-ui.png'), (await win.webContents.capturePage()).toPNG());
    const logged = errors.filter(e => !/DevTools|Autofill|ResizeObserver loop/.test(e));
    assert.equal(logged.length, 0, 'Console errors: ' + logged.join(' | '));
    console.log('Map UI: ok');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
