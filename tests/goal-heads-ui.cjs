// Where a Goal heads in play: graphs from before maps migrated (a Goal that followed a route heads along it; a Planner
// that planned on a grid becomes a Map graph beside its policy graph, the Goal heading over it to a place made of the
// point it headed for, with what it kept away from rewired), the Goal's Heads for choices reaching the worker as its
// route, plan over the map or target, and the map learning its grid. Needs `npm run build`
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'goal-heads-ui-profile'));
let win; const watchdog = setTimeout(() => { console.error('Goal heads UI timed out'); app.exit(1); }, 90000);
const asked = { preview: [], grid: [] };
const fields = [{ name: 'Player', type: 'vector' }, { name: 'Face Left', type: 'boolean' }, { name: 'platforms', type: 'shapes' }, { name: 'Map Id', type: 'number' }];
const recording = (id, name, started) => ({ id, name, status: 'complete', samples: 100, invalidSamples: 0, durationMs: 30000, inputEvents: 0,
  metadata: { started, hz: 15, observationSchema: { identity: 'obs', fields }, actionSchema: { identity: 'act', buttons: [{ id: 'k1', vk: 49 }] } } });
const recordings = [recording('old', 'First run', 1), recording('new', 'Second run', 2)];

app.whenReady().then(async () => {
  try {
    for (const [name, result] of [['runtime:available', true], ['runtime:status', { ready: true, error: null }], ['windows:thumbnails', {}], ['models:list', []], ['models:probe', null],
      ['training:check-checkpoint', { found: false }], ['training:gpu-check', { available: false }], ['collection:status', []]]) ipcMain.handle(name, () => result);
    ipcMain.handle('runtime:invoke', async (_, op) => op === 'windows' ? { windows: [] } : op === 'dataset.list' ? { recordings } : op === 'observe.fields' ? { fields, excluded: [] } : { ok: true });
    ipcMain.handle('policy:invoke', (_, op, params) => {
      if (op === 'models') return [];
      if (op === 'columns') return { groups: [], fields: [], formulas: [], grids: [], spatial: [], goals: (params.goals ?? []).map(g => ({ name: g.name, columns: [`${g.name}.forward`, `${g.name}.dy`, `${g.name}.dist`], values: null, moved: null, error: null })) };
      if (op === 'preview') { asked.preview.push(params); return { samples: 900, stepMs: 66, recordings: [{ id: 'old', rows: 900 }], skipped: [], skippedReasons: {}, values: params.columns, inputs: params.columns.length, buttons: [{ id: 'k1', pressed: .3 }] }; }
      if (op === 'map.grid') { asked.grid.push(params); return { places: [['1.0', 0, 200, 4], ['1.0', 40, 200, 3]], moves: [[0, 1, 200, 3, ['k1']]], count: { places: 2, moves: 1 }, recordings: 1, execution: params.map.grid.execution ?? 'sequences', notes: [], linkIds: ['recorded:demo'] }; }
      if (op === 'map.stats') return { stats: {} };
      if (op === 'map.frame') return { position: null, level: null, shapes: {}, errors: {} };
      return {};
    });
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const js = code => win.webContents.executeJavaScript(code), errors = [];
    win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(50); } throw Error('UI condition failed: ' + what); };
    const choose = (selector, value) => js(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});if(!s)throw Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    await win.loadFile(path.join(root, 'dist/index.html'));
    const state = (id, name, y) => ({ id, type: 'state', position: { x: 0, y }, data: { kind: 'state', name } });
    const policy = { id: 'pol', type: 'policy', position: { x: 900, y: 0 }, data: { kind: 'policy', name: 'Navigate', buttons: null, off: [], stepMs: null, history: 0, delayMs: 0, epochs: 60 } };
    const common = [state('player', 'Player', 0), state('face', 'Face Left', 120), { id: 'recs', type: 'recordings', position: { x: 500, y: 600 }, data: { kind: 'recordings', ids: ['old'] } }, policy];
    const wires = [{ id: 'e1', source: 'player', sourceHandle: 'out', target: 'goal', targetHandle: 'in:@position' }, { id: 'e2', source: 'face', sourceHandle: 'out', target: 'goal', targetHandle: 'in:@facing' },
      { id: 'e4', source: 'goal', sourceHandle: 'out', target: 'pol', targetHandle: 'values' }, { id: 'e5', source: 'face', sourceHandle: 'out', target: 'pol', targetHandle: 'values' },
      { id: 'e6', source: 'recs', sourceHandle: 'data', target: 'pol', targetHandle: 'data' }];
    // From before Planners: a Goal following the first run's route
    const routed = { version: 1, nodes: [...common, { id: 'goal', type: 'goal', position: { x: 500, y: 0 }, data: { kind: 'goal', name: 'goal', lookAhead: [1, 4], targets: 3, minMove: 20, route: { recording: 'old', aheadS: 2 } } }],
      edges: wires };
    // From before maps: a Planner planning on a grid toward a clicked point, by Map Id, keeping away from the platforms
    const planned = { version: 1, nodes: [...common, state('map', 'Map Id', 240), state('floor', 'platforms', 360),
      { id: 'goal', type: 'goal', position: { x: 500, y: 0 }, data: { kind: 'goal', name: 'goal', lookAhead: [1, 4], targets: 3, minMove: 20, hint: true } },
      { id: 'near', type: 'spatial', position: { x: 250, y: 400 }, data: { kind: 'spatial', name: 'near', inputs: ['platforms'], radii: [100, 250, 500], maxDistance: 1000 } },
      { id: 'plan', type: 'planner', position: { x: 250, y: 200 }, data: { kind: 'planner', name: 'planner', mode: 'plan', route: { recording: '', aheadS: 2.5 },
        plan: { cell: 30, aheadS: 1.5, destination: { kind: 'point', x: 200, y: 100, level: '1.0' }, avoid: ['platforms'], learn: false } } }],
      edges: [...wires, { id: 'p1', source: 'plan', sourceHandle: 'out', target: 'goal', targetHandle: 'in:@target' }, { id: 'p2', source: 'map', sourceHandle: 'out', target: 'plan', targetHandle: 'in:@level' },
        { id: 'p3', source: 'near', sourceHandle: 'out', target: 'plan', targetHandle: 'in:@map' }, { id: 'p4', source: 'recs', sourceHandle: 'data', target: 'plan', targetHandle: 'in:@data' },
        { id: 'p5', source: 'player', sourceHandle: 'out', target: 'near', targetHandle: 'in:@point' }, { id: 'p6', source: 'floor', sourceHandle: 'out', target: 'near', targetHandle: 'in:platforms' }] };
    const scope = 'firefly-policy-graph-%7Bsettings%7D';
    const library = { version: 1, selected: 'g1', entries: [{ id: 'f', parent: null, kind: 'folder', name: 'Policies' },
      { id: 'g1', parent: 'f', kind: 'policy', name: 'Route' }, { id: 'g2', parent: 'f', kind: 'policy', name: 'Planned' }] };
    const set = Object.entries({ library, 'document-g1': routed, 'document-g2': planned })
      .map(([k, v]) => `localStorage.setItem(${JSON.stringify(scope + '-' + k)},${JSON.stringify(JSON.stringify(v))});`).join('');
    await js(`localStorage.clear();${set}0`);
    await win.reload(); await wait(600);
    await js(`[...document.querySelectorAll('button,.panel-tab-click')].find(b=>b.textContent.trim()==='Graphs').click();0`);
    const goal = `document.querySelector('.graph-page:not(.pg-off) .react-flow__node[data-id="goal"]')`;  // policy graphs opened stay mounted, hidden
    // The routed Goal heads along its recording
    await until(`${goal}?.querySelector('[aria-label="Goal heads for"]')?.value==='route'`, 'the route as Heads for');
    assert.equal(await js(`${goal}.querySelector('[aria-label="Route recording"]').value`), 'old');
    for (let i = 0; i < 80 && !asked.preview.length; i++) await wait(50);
    await wait(900);
    assert.deepEqual(asked.preview.at(-1).goal, { name: 'goal', position: 'Player', facing: 'Face Left', route: { recording: 'old', aheadS: 2 }, lookAhead: [1, 4], targets: 3, minMove: 20 });
    // The Planner became a Map graph beside its policy graph
    const saved = key => js(`JSON.parse(localStorage.getItem(${JSON.stringify(scope + '-')}+${JSON.stringify(key)}))`);
    const lib = await saved('library');
    const made = lib.entries.find(e => e.kind === 'map');
    assert.deepEqual([made.name, made.parent], ['planner map', 'f']);
    assert.ok(await js(`!!document.querySelector('[aria-label="map: planner map"]')`), 'listed in the directory');
    const map = await saved(`document-${made.id}`);
    assert.deepEqual([map.position, map.level, map.grid], ['Player', '`Map Id`', { cell: 30, recordings: ['old'] }]);
    assert.deepEqual(map.places.map(p => [p.name, p.x, p.y, p.level]), [['Destination', 200, 100, '1.0']]);
    const doc = await saved('document-g2');
    assert.ok(!doc.nodes.some(n => n.type === 'planner'), 'the Planner gone');
    const heads = doc.nodes.find(n => n.id === 'goal').data.heads;
    assert.deepEqual(heads, { kind: 'map', map: made.id, destination: { kind: 'place', place: map.places[0].id }, aheadS: 1.5, avoid: ['platforms'], learn: false });
    assert.ok(doc.edges.some(e => e.source === 'near' && e.target === 'goal' && e.targetHandle === 'in:@avoid'), 'what it kept away from, wired into the Goal');
    // The planned Goal: over the map, to the place, its plan sent with the map's places and grid
    await js(`document.querySelector('[aria-label="policy: Planned"]').click()`);
    await until(`${goal}?.querySelector('[aria-label="Goal heads for"]')?.value==='map'`, 'the map as Heads for');
    assert.equal(await js(`${goal}.querySelector('[aria-label="Goal map"]').value`), made.id);
    assert.equal(await js(`${goal}.querySelector('[aria-label="Goal destination"]').value`), `place:${map.places[0].id}`);
    assert.ok(await js(`${goal}.querySelector('[aria-label="Plan next move as values"]').checked`));
    const planOf = () => asked.preview.at(-1)?.goal?.plan;
    for (let i = 0; i < 80 && !planOf(); i++) await wait(50);
    let plan = planOf();
    assert.ok(plan, 'the plan sent');
    assert.deepEqual([plan.map.id, plan.map.name, plan.map.position, plan.map.level, plan.map.grid.cell], [made.id, 'planner map', 'Player', '`Map Id`', 30]);
    assert.deepEqual(plan.destination, { kind: 'place', place: map.places[0].id });
    assert.deepEqual(plan.avoid, [{ alias: 'platforms', shapes: ['platforms'] }]);
    assert.equal(plan.learn, false);
    assert.equal(asked.preview.at(-1).goal.hint, true);
    // Where a recording ended, then the Target
    await choose('.graph-page:not(.pg-off) .react-flow__node[data-id="goal"] [aria-label="Goal destination"]', 'end');
    await until(`!!${goal}.querySelector('[aria-label="Destination recording"]')`, 'the recording to choose');
    for (let i = 0; i < 80 && planOf()?.destination.kind !== 'end'; i++) await wait(50);
    assert.deepEqual(planOf().destination, { kind: 'end', recording: 'new' });
    await choose('.graph-page:not(.pg-off) .react-flow__node[data-id="goal"] [aria-label="Goal heads for"]', 'target');
    await until(`${goal}.textContent.includes('Target: where play goes')`, 'the Target port');
    // The map: learning its grid
    await js(`document.querySelector('[aria-label="map: planner map"]').click()`);
    await until(`!!document.querySelector('[aria-label="Learn a grid"]')`, 'the map editor');
    assert.ok(await js(`document.querySelector('[aria-label="Learn a grid"]').checked`));
    await until(`document.querySelector('.map-settings').textContent.includes('2 places and 1 moves learned from 1 recording')`, 'what it learned');
    assert.deepEqual([asked.grid.at(-1).map.grid, asked.grid.at(-1).map.position], [{ cell: 30, recordings: ['old'] }, 'Player']);
    assert.ok(await js(`document.querySelector('[aria-label="Drive map"]').disabled`), 'Drive requires a capture session');
    assert.equal(await js(`document.querySelector('[aria-label="Drive destination"]').value`), map.places[0].id, 'migrated destination is offered');
    assert.equal(await js(`document.querySelector('[aria-label="Learned movement execution"]').value`), 'sequences');
    assert.match(await js(`document.querySelector('.map-settings').textContent`), /Start within 6 px/);
    await choose('[aria-label="Learned movement execution"]', 'keys');
    for (let i = 0; i < 80 && asked.grid.at(-1).map.grid.execution !== 'keys'; i++) await wait(50);
    assert.equal(asked.grid.at(-1).map.grid.execution, 'keys');
    await choose('[aria-label="Learned movement execution"]', 'sequences');
    for (let i = 0; i < 80 && asked.grid.at(-1).map.grid.execution !== 'sequences'; i++) await wait(50);
    assert.equal(asked.grid.at(-1).map.grid.execution, 'sequences');
    require('node:fs').writeFileSync(path.join(root, 'build', 'goal-heads-ui.png'), (await win.webContents.capturePage()).toPNG());
    const logged = errors.filter(e => !/DevTools|Autofill|ResizeObserver loop/.test(e));
    assert.equal(logged.length, 0, 'Console errors: ' + logged.join(' | '));
    console.log('Goal heads UI: ok');
    clearTimeout(watchdog); app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
});
