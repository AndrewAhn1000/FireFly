// A trained YOLO detector runs from Trained Models and its outputs are edited in the Outputs tab.
// The library is the real one (models.cjs imports runs/yolo/first/best.onnx), the runtime a stand-in whose
// applied graph is then evaluated by the real firefly-graph.exe on a dataset image.
// Needs `npm run build`, the native build, and a trained detector: electron tests/detector-ui.cjs [best.onnx] [image.png]
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
const profile = path.join(root, 'build', 'detector-ui-profile');
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);
const models = require('../electron/models.cjs');
const args = process.argv.slice(2).filter(a => !a.startsWith('-') && a !== '.' && !a.endsWith('detector-ui.cjs'));
const onnx = path.resolve(args[0] ?? path.join(root, 'runs/yolo/first/best.onnx'));
const imageFile = path.resolve(args[1] ?? path.join(root, 'dataset/images/val/1010000/000010.png'));
const MODELS = path.join(profile, 'models');
let win, graph, applied = 0;
const watchdog = setTimeout(() => { console.error('Detector UI timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  try {
    const { model } = await models.importModel(MODELS, onnx, { trained: true });
    assert.equal(model.kind, 'detector');
    assert.ok(model.classes.length > 0, 'the detector names its classes');
    const image = nativeImage.createFromPath(imageFile);
    const { width, height } = image.getSize();
    ipcMain.handle('runtime:available', () => true); ipcMain.handle('runtime:status', () => ({ ready: true, error: null }));
    ipcMain.handle('windows:thumbnails', () => ({})); ipcMain.handle('models:probe', () => null); ipcMain.handle('collection:status', () => []);
    ipcMain.handle('models:list', () => models.listModels(MODELS));
    ipcMain.handle('models:update', (_e, id, patch) => ({ ok: true, model: models.updateModel(MODELS, id, patch ?? {}) }));
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false }));
    const event = (event, result) => win.webContents.send('runtime:event', { event, result });
    ipcMain.handle('runtime:invoke', async (_, op, params) => {
      if (op === 'inference.devices') return { devices: [{ id: 'cpu', provider: 'cpu', device: 0, label: 'CPU' },
        { id: 'directml:0', provider: 'directml', device: 0, label: 'GPU · Test adapter' }, { id: 'directml:1', provider: 'directml', device: 1, label: 'GPU · Broken adapter' }] };
      // The second adapter can't run anything
      if (op === 'graph.apply' && params.graph.nodes.some(n => n.params?.provider === 'directml' && n.params.device === 1)) throw Error('Adapter lost');
      if (op === 'windows') return { windows: [{ id: '123', title: 'Detector fixture', pid: 1 }] };
      if (op === 'graph.apply') { graph = params.graph; applied++; }
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width, height }; }
      if (op === 'dataset.list') return { recordings: [] };
      return { ok: true };
    });
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click();0`);
    const tab = text => js(`[...document.querySelectorAll('.bottom-center-panel .panel-tab')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click();0`);
    const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
    const waitFor = async (check, what) => { for (let i = 0; i < 100; i++) { if (check()) return; await wait(40); } throw Error('Condition failed: ' + what); };

    await win.loadFile(path.join(root, 'dist/index.html'));
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);

    // Trained Models: listed and described as a detector, with its scores and classes
    await tab('Trained Models');
    await until(`!!document.querySelector('.model-row')`);
    assert.match(await text('.model-row-meta'), /Detector · \d+ class/);
    await js(`document.querySelector('.model-row').click();0`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Run on live capture'))`);
    const detail = await text('.model-detail');
    assert.match(detail, /mAP50/); assert.match(detail, /Object detector/);
    for (const c of model.classes) assert.ok(detail.includes(c), `the detail lists class ${c}`);
    for (const c of model.classes) assert.ok(detail.includes(`${c} (detected)`), `“${c} (detected)” is an output`);

    // Run: the graph finds the boxes, splits them by class, draws and publishes each class
    await click('Run on live capture');
    await until(`true`); for (let i = 0; i < 50 && !graph?.nodes.some(n => n.op === 'detect'); i++) await wait(40);
    const detect = graph.nodes.find(n => n.op === 'detect');
    assert.ok(detect, 'the live graph runs the detector');
    assert.equal(detect.params.model, model.path); assert.equal(detect.params.confidence, 0.25); assert.equal(detect.params.provider, 'cpu');
    assert.ok(!graph.nodes.some(n => n.op === 'segment' || n.op === 'coverage'), 'a detector has no mask');
    model.classes.forEach((c, i) => {
      assert.ok(graph.nodes.some(n => n.op === 'filter' && n.inputs[0] === 'detect' && n.params.expression === `class == ${i}`), `boxes of ${c}`);
      assert.ok(graph.nodes.some(n => n.op === 'publish' && n.params.name === `${c} (detected)`), `publishes ${c} (detected)`);
    });
    assert.equal(graph.nodes.filter(n => n.op === 'draw_shapes').length, model.classes.length);

    // The same graph, evaluated by the runtime on a real frame
    const graphFile = path.join(root, 'build', 'detector-ui-graph.json'), display = path.join(root, 'build', 'detector-ui-display.png');
    fs.writeFileSync(graphFile, JSON.stringify(graph));
    const out = execFileSync(path.join(root, 'build/native/Release/firefly-graph.exe'), [graphFile, imageFile, display], { encoding: 'utf8' });
    const evaluated = JSON.parse(out.slice(out.indexOf('{')));
    const counts = {};
    for (const c of model.classes) {
      const list = evaluated.observations;
      const o = Array.isArray(list) ? list.find(x => x.name === `${c} (detected)`) : list?.[`${c} (detected)`] ?? evaluated[`${c} (detected)`];
      assert.ok(o, `the runtime evaluates ${c} (detected): ${out.slice(0, 400)}`);
      counts[c] = o.count ?? o.value?.items?.length ?? o.items?.length ?? 0;
    }
    assert.ok(Object.values(counts).some(n => n > 0), `the detector finds something in ${imageFile}: ${JSON.stringify(counts)}`);

    // Live status from the runtime's observations, and a failing detector reported as the model's error
    const observations = model.classes.map(c => ({ name: `${c} (detected)`, type: 'shapes', valid: true, count: counts[c] }));
    const schema = () => js(`0`).then(() => ({ id: graph.id, version: graph.revision }));
    event('observations', { schema: await schema(), observations, nodes: { frame: { valid: true, value: { width, height } }, detect: { type: 'shapes', valid: true, count: 1 } }, latencyMs: 42 });
    await until(`document.querySelector('.model-status')?.textContent.includes('42 ms/frame')`, 'running status');
    const status = await text('.model-status');
    assert.ok(model.classes.some(c => status.includes(`${c} (detected) ${counts[c]}`)), status);
    assert.ok(!status.includes('of frame detected'), status);
    await wait(150);
    event('observations', { schema: await schema(), observations: [], nodes: { detect: { valid: false, reason: 'ONNX model load failed' } } });
    await until(`document.querySelector('.model-status-err')?.textContent.includes('ONNX model load failed')`, 'detector error');

    // Runs on: its own device, whatever the toolbar says, saved with it and applied at once; one it can't
    // start on puts it back and says why; Same as toolbar follows the toolbar again
    const detectParams = () => graph.nodes.find(n => n.op === 'detect').params;
    const device = async value => js(`(()=>{const s=document.querySelector('[aria-label="Model device"]');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    assert.equal(await js(`document.querySelector('[aria-label="Model device"]').value`), '');
    assert.match(await js(`document.querySelector('[aria-label="Model device"] option').textContent`), /Same as toolbar \(CPU\)/);
    await device('directml:0');
    await waitFor(() => detectParams().provider === 'directml' && detectParams().device === 0, 'the detector on the GPU');
    await waitFor(() => models.listModels(MODELS)[0].device === 'directml:0', 'the device saved');
    assert.equal(await js(`document.querySelector('[aria-label="Model inference device"]').value`), 'cpu', 'the toolbar is left alone');
    await device('directml:1');
    await until(`document.querySelector('.models-notice-error')?.textContent.includes('Adapter lost')`, 'the failed device reported');
    assert.equal(await js(`document.querySelector('[aria-label="Model device"]').value`), 'directml:0', 'it went back to where it ran');
    assert.equal(detectParams().provider, 'directml'); assert.equal(models.listModels(MODELS)[0].device, 'directml:0');
    await js(`document.querySelector('.models-notice-close')?.click();0`);
    await device('');
    await waitFor(() => detectParams().provider === 'cpu', 'back on the toolbar\'s CPU');
    await waitFor(() => models.listModels(MODELS)[0].device === undefined, 'the device cleared');

    // Outputs: a Confidence slider, sources of all boxes or one class, and the per-class template
    await tab('Outputs');
    await until(`!!document.querySelector('.flow-panel')`);
    assert.match(await text('.flow-hd'), /Confidence/);
    assert.doesNotMatch(await text('.flow-hd'), /Threshold/);
    const templates = await js(`[...document.querySelectorAll('.flow-hd select')[1].options].map(o=>o.textContent)`);
    assert.deepEqual(templates.slice(1), ['One output per class']);
    await js(`document.querySelector('.flow-item').click();0`);
    await until(`!!document.querySelector('.flow-row select')`);
    const sources = await js(`[...document.querySelector('.flow-row select').options].map(o=>o.textContent)`);
    assert.ok(sources.includes('All detections'), sources.join());
    for (const c of model.classes) assert.ok(sources.includes(`Class: ${c}`), sources.join());

    // Raising the confidence re-applies the graph with it, and saves it with the model
    const before = applied;
    await js(`(()=>{const s=document.querySelector('.flow-hd input[type=range]');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(s,'0.5');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    for (let i = 0; i < 100 && !(applied > before && graph.nodes.find(n => n.op === 'detect').params.confidence === 0.5); i++) await wait(40);
    assert.equal(graph.nodes.find(n => n.op === 'detect').params.confidence, 0.5);
    for (let i = 0; i < 50 && models.listModels(MODELS)[0].threshold !== 0.5; i++) await wait(40);
    assert.equal(models.listModels(MODELS)[0].threshold, 0.5);

    // A new output starts from all the boxes, and counting them records a number
    await click('+ Add output');
    await until(`document.querySelectorAll('.flow-item').length === ${model.classes.length + 1}`);
    assert.equal(await js(`document.querySelector('.flow-row select').value`), 'detections');
    const added = models.listModels(MODELS)[0];
    for (let i = 0; i < 50 && (models.listModels(MODELS)[0].flow?.outputs.length ?? 0) !== model.classes.length + 1; i++) await wait(40);
    assert.equal(models.listModels(MODELS)[0].flow.outputs.at(-1).from, 'detections', JSON.stringify(added.flow));

    win.webContents.invalidate(); await wait(150);
    fs.writeFileSync(path.join(root, 'build/detector-ui.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log(`PASS: detector listed (${model.classes.join(', ')}), run with per-class outputs, its own device (saved, applied, rolled back on failure), runtime found ${JSON.stringify(counts)}, live status and errors, Outputs sources, confidence saved and applied.`);
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/detector-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
