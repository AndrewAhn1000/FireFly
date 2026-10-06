// Several trained models run at once: a segmentation UNet and a YOLO detector from the real library (models.cjs
// imports runs/unet/best.onnx and runs/yolo/first/best.onnx), the runtime a stand-in whose applied graph is then
// evaluated by the real firefly-graph.exe on a dataset image.
// Needs `npm run build`, the native build and both trained models: electron tests/multi-model-ui.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
const profile = path.join(root, 'build', 'multi-model-ui-profile');
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);
const models = require('../electron/models.cjs');
const imageFile = path.join(root, 'dataset/images/val/1010000/000010.png');
const MODELS = path.join(profile, 'models');
let win, graph;
const graphs = [];
const watchdog = setTimeout(() => { console.error('Multi-model UI timed out'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  try {
    const unet = (await models.importModel(MODELS, path.join(root, 'runs/unet/best.onnx'), { trained: true })).model;
    const yolo = (await models.importModel(MODELS, path.join(root, 'runs/yolo/first/best.onnx'), { trained: true })).model;
    unet.name = 'Terrain'; yolo.name = 'Mobs';
    models.updateModel(MODELS, unet.id, { name: 'Terrain' }); models.updateModel(MODELS, yolo.id, { name: 'Mobs' });
    assert.equal(unet.kind, 'segmentation'); assert.equal(yolo.kind, 'detector');
    const image = nativeImage.createFromPath(imageFile);
    const { width, height } = image.getSize();
    ipcMain.handle('runtime:available', () => true); ipcMain.handle('runtime:status', () => ({ ready: true, error: null }));
    ipcMain.handle('windows:thumbnails', () => ({})); ipcMain.handle('models:probe', () => null); ipcMain.handle('collection:status', () => []);
    ipcMain.handle('models:list', () => models.listModels(MODELS));
    ipcMain.handle('models:update', (_e, id, patch) => ({ ok: true, model: models.updateModel(MODELS, id, patch ?? {}) }));
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false }));
    const event = (event, result) => win.webContents.send('runtime:event', { event, result });
    ipcMain.handle('runtime:invoke', async (_, op, params) => {
      if (op === 'inference.devices') return { devices: [{ id: 'cpu', provider: 'cpu', device: 0, label: 'CPU' }] };
      if (op === 'windows') return { windows: [{ id: '123', title: 'Multi-model fixture', pid: 1 }] };
      if (op === 'graph.apply') { graph = params.graph; graphs.push(graph); }
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width, height }; }
      if (op === 'dataset.list') return { recordings: [] };
      return { ok: true };
    });
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const waitFor = async (check, what) => { for (let i = 0; i < 150; i++) { if (check()) return; await wait(40); } throw Error('Condition failed: ' + what); };
    const click = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click();0`);
    const tab = text => js(`[...document.querySelectorAll('.bottom-center-panel .panel-tab')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click();0`);
    const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
    const pick = name => js(`[...document.querySelectorAll('.model-row')].find(r=>r.textContent.includes(${JSON.stringify(name)})).click();0`);
    const ids = () => graph.nodes.map(n => n.id);
    const key = id => `m${id.replace(/-/g, '').slice(0, 8)}.`;

    await win.loadFile(path.join(root, 'dist/index.html'));
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    await tab('Trained Models');
    await until(`document.querySelectorAll('.model-row').length === 2`);

    // One model: its steps keep the names they always had, so recordings made with it keep their identity
    await pick('Terrain');
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Run on live capture'))`);
    await click('Run on live capture');
    await waitFor(() => graph?.nodes.some(n => n.op === 'segment'), 'the UNet runs');
    const alone = graph;
    assert.ok(ids().includes('mask') && ids().includes('coverage'), ids().join());

    // A second model runs beside it: both in one graph, each model's steps under its own key, drawing in turn
    await pick('Mobs');
    await until(`document.querySelector('.model-detail')?.textContent.includes('Will run beside “Terrain”')`, 'beside hint');
    await click('Run on live capture');
    await waitFor(() => graph.nodes.some(n => n.op === 'detect') && graph.nodes.some(n => n.op === 'segment'), 'both models run');
    const u = key(unet.id), y = key(yolo.id);
    assert.equal(new Set(ids()).size, ids().length, 'no step is named twice');
    for (const id of ['mask', 'coverage']) assert.ok(ids().includes(u + id), `${u}${id} in ${ids().join()}`);
    assert.ok(ids().includes(y + 'detect'));
    yolo.classes.forEach((c, i) => {
      assert.ok(graph.nodes.some(n => n.id === `${y}class.${i}` && n.inputs[0] === `${y}detect`));
      assert.ok(graph.nodes.some(n => n.op === 'publish' && n.params.name === `${c} (detected)`));
    });
    const node = id => graph.nodes.find(n => n.id === id);
    const draws = graph.nodes.filter(n => n.op === 'draw_shapes' || n.op === 'draw_contours');
    const uDraws = draws.filter(n => n.id.startsWith(u)), yDraws = draws.filter(n => n.id.startsWith(y));
    assert.ok(uDraws.length && yDraws.length, 'both models draw');
    assert.equal(uDraws[0].inputs[0], 'frame', 'the first model draws on the frame');
    assert.equal(yDraws[0].inputs[0], uDraws.at(-1).id, 'the second draws over what the first drew');
    assert.equal(node('out').inputs[0], yDraws.at(-1).id, 'the display is everything drawn');
    await until(`document.querySelectorAll('.vp-model-badge').length === 2`, 'a badge per model');
    assert.match(await text('.models-count'), /2 running/);
    assert.match(await text('.statusbar'), /Models: Terrain, Mobs/);

    // The runtime evaluates both on a real frame
    const graphFile = path.join(root, 'build', 'multi-model-graph.json'), display = path.join(root, 'build', 'multi-model-display.png');
    fs.writeFileSync(graphFile, JSON.stringify(graph));
    const out = execFileSync(path.join(root, 'build/native/Release/firefly-graph.exe'), [graphFile, imageFile, display], { encoding: 'utf8' });
    const evaluated = JSON.parse(out.slice(out.indexOf('{')));
    const observed = name => (Array.isArray(evaluated.observations) ? evaluated.observations.find(o => o.name === name) : evaluated.observations?.[name]);
    const monsters = observed(`${yolo.classes[0]} (detected)`);
    assert.ok(monsters?.valid && (monsters.count ?? monsters.value?.length) > 0, JSON.stringify(monsters));
    const recordedByUnet = (await js(`0`), models.listModels(MODELS).find(m => m.id === unet.id));
    assert.ok(recordedByUnet);
    const objects = observed('objects');
    assert.ok(objects?.valid, `the UNet's objects: ${JSON.stringify(objects)}`);

    // Feedback per model, from one frame's results: the detector failing doesn't stop the UNet reporting
    const observations = [{ name: 'objects', type: 'shapes', valid: true, count: 3 }];
    event('observations', {
      schema: { id: graph.id, version: graph.revision }, observations, latencyMs: 55,
      nodes: { frame: { valid: true, value: { width, height } }, [u + 'mask']: { type: 'image', valid: true }, [u + 'coverage']: { type: 'number', valid: true, value: 0.2 },
        [u + 'objects.0']: { type: 'shapes', valid: true, count: 3 }, [y + 'detect']: { valid: false, reason: 'Detector exploded' } },
    });
    await until(`document.querySelector('.model-status-err')?.textContent.includes('Detector exploded')`, 'the detector error on Mobs');
    await pick('Terrain');
    await until(`document.querySelector('.model-status')?.textContent.includes('55 ms/frame for all running models')`, 'Terrain running');

    // A name the earlier model records already isn't recorded for the later one, and the later one says so
    await tab('Outputs');
    await until(`!!document.querySelector('.flow-panel')`);
    await js(`(()=>{const s=document.querySelector('.flow-hd select');s.value=${JSON.stringify(unet.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    await until(`[...document.querySelectorAll('.flow-item')].some(i=>i.textContent.includes('objects'))`);
    await js(`[...document.querySelectorAll('.flow-item')].find(i=>i.querySelector('.flow-item-name').textContent==='objects').click();0`);
    await until(`!!document.querySelector('.flow-name')`);
    const clash = `${yolo.classes[0]} (detected)`;
    await js(`(()=>{const e=document.querySelector('.flow-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(clash)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})();0`);
    await waitFor(() => graph.nodes.filter(n => n.op === 'publish' && n.params.name === clash).length === 1
      && graph.nodes.some(n => n.op === 'publish' && n.params.name === clash && n.id.startsWith(u)), 'the clashing name recorded once, by the UNet');
    await tab('Trained Models');
    await pick('Mobs');
    await until(`document.querySelector('.model-detail .models-notice-error')?.textContent.includes('“Terrain” records')`, 'the clash notice');

    // Stopping one leaves the other running alone, under the names it has alone
    await click('Stop model');
    await waitFor(() => !graph.nodes.some(n => n.op === 'detect') && graph.nodes.some(n => n.op === 'segment'), 'only the UNet');
    assert.ok(ids().includes('mask') && !ids().some(id => id.startsWith(u)), ids().join());
    await until(`document.querySelectorAll('.vp-model-badge').length === 1`);
    assert.deepEqual(alone.nodes.filter(n => n.op === 'segment').map(n => n.id), graph.nodes.filter(n => n.op === 'segment').map(n => n.id));

    win.webContents.invalidate(); await wait(150);
    fs.writeFileSync(path.join(root, 'build/multi-model-ui.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log(`PASS: two models in one graph (${graph.nodes.length} steps alone, ${graphs.reduce((n, g) => Math.max(n, g.nodes.length), 0)} together), drawn in turn and evaluated by the runtime, feedback per model, recorded names kept apart, stopping one leaves the other under its own names.`);
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/multi-model-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
