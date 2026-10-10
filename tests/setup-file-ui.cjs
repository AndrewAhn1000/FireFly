// Sharing a setup as a file: one window's States, Regions, Graphs, recording setup and the trained model its
// States read go into a .firefly file (with nothing in it naming a place on this PC), and someone else imports
// it into a window titled differently, with an empty model library. The file code is the real one
// (electron/setupFile.cjs, src/windowSetup.ts); the save and open dialogs and the runtime are stand-ins.
// Needs `npm run build` and runs/yolo/first/best.onnx: electron tests/setup-file-ui.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
const profile = path.join(root, 'build', 'setup-file-ui-profile');
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);
const models = require('../electron/models.cjs');
const setupFile = require('../electron/setupFile.cjs');
const mine = path.join(profile, 'models-mine'), theirs = path.join(profile, 'models-theirs');
const shared = path.join(profile, 'Shared setup.firefly');
let win, library = mine, windowTitle = 'Game A', opened = null;
const watchdog = setTimeout(() => { console.error('Setup file UI timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  try {
    const { model } = await models.importModel(mine, path.join(root, 'runs/yolo/first/best.onnx'), { trained: true });
    models.updateModel(mine, model.id, { name: 'Mob finder', threshold: 0.4 });
    const image = nativeImage.createFromBitmap(Buffer.alloc(320 * 200 * 4, 90), { width: 320, height: 200 });
    for (const [name, result] of [['runtime:available', true], ['runtime:status', { ready: true, error: null }], ['windows:thumbnails', {}], ['models:probe', null], ['collection:status', []]])
      ipcMain.handle(name, () => result);
    ipcMain.handle('models:list', () => models.listModels(library));
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false, plan: { reason: 'no-driver' } }));
    ipcMain.handle('policy:invoke', (_, op) => op === 'models' ? [] : {});
    ipcMain.handle('runtime:invoke', async (_, op) => {
      if (op === 'windows') return { windows: [{ id: '1', title: windowTitle, pid: 1 }] };
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width: 320, height: 200 }; }
      if (op === 'dataset.list') return { recordings: [] };
      if (op === 'observe.fields') return { fields: [], excluded: [] };
      return { ok: true };
    });
    // The real file code behind stand-in dialogs: saved to, and opened from, one file
    ipcMain.handle('setup:export', (_, params) => ({ ok: true, path: shared, ...setupFile.writeSetupFile(shared, { ...params, modelsDir: library, appVersion: '0.0.0-test' }) }));
    ipcMain.handle('setup:open', () => { const { file, summary } = setupFile.readSetupFile(shared); opened = file; return { ok: true, token: 't1', summary, path: shared }; });
    ipcMain.handle('setup:install-models', async (_, token, indexes) => ({ ok: true, models: await setupFile.installModels(opened, indexes, library) }));
    ipcMain.handle('setup:close', () => { opened = null; });

    win = new BrowserWindow({ width: 1500, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const click = (text, scope = 'document') => js(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})();0`);
    const start = async () => {
      await until(`!!document.querySelector('.win-item')`);
      await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
      await click('Start Session');
      await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    };

    // My window's setup, as FireFly saved it
    await win.loadFile(path.join(root, 'dist/index.html'));
    const enc = encodeURIComponent('Game A'), scope = `firefly-policy-graph-${enc}`;
    const seed = {
      [`firefly-states-${enc}`]: [{ id: 's1', name: 'Mobs', type: 'collection', source: 'model', output: 'screen_monsters (detected)' }, { id: 's2', name: 'Camera', type: 'vector', source: 'script', script: 'return {x=1,y=2}', folderId: 'f1' }],
      [`firefly-state-folders-${enc}`]: [{ id: 'f1', name: 'Memory' }],
      [`firefly-regions-${enc}`]: [{ id: 'r1', label: 'Mini map', x: .01, y: .05, w: .2, h: .2, templates: [] }],
      [`firefly-record-setup-${enc}`]: { buttons: ['left', 'space'], hz: 20 },
      [`${scope}-library`]: { version: 1, selected: 'g1', entries: [{ id: 'g1', parent: null, kind: 'collection', name: 'Screenshots' }] },
      [`${scope}-document-g1`]: { version: 1, nodes: [{ id: 'o1', type: 'output', position: { x: 0, y: 0 }, data: { kind: 'output', directory: path.join(os.homedir(), 'FireFly', 'dataset'), pattern: '{map}/{sequence}' } }], edges: [] },
    };
    await js(`localStorage.clear();${Object.entries(seed).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(JSON.stringify(v))});`).join('')}0`);
    await win.reload();
    await start();

    // Export: every part, and the model the Mobs State reads ticked to start with
    await click('Export…');
    await until(`!!document.querySelector('[aria-label="Export the setup"]')`);
    assert.equal(await js(`document.querySelector('[aria-label="Include Mob finder"]').checked`), true, 'the model its States read is ticked');
    await click('Export…', `document.querySelector('[aria-label="Export the setup"]')`);
    await until(`document.querySelector('.setup-message')?.textContent.includes('Exported to')`, 'exported');
    assert.match(await js(`document.querySelector('.setup-message').textContent`), /with 1 model\)\. 1 Dataset Output folder left out/);
    const text = fs.readFileSync(shared, 'utf8'), file = JSON.parse(text);
    assert.equal(file.format, 'firefly-setup'); assert.equal(file.window, 'Game A');
    assert.ok(Object.keys(file.entries).every(k => k.includes('{window}')), 'keyed by {window}');
    for (const where of [os.homedir(), os.homedir().replace(/\\/g, '\\\\'), os.userInfo().username + '\\', profile])
      assert.ok(!text.includes(where), `the file names a place on this PC: ${where}`);
    assert.deepEqual(Object.keys(file.models[0].meta.source), ['kind'], 'a model’s source path is left out');
    assert.equal(file.models[0].meta.training?.dataDir ?? null, null, 'and so is its dataset folder');
    assert.ok(file.models[0].meta.training?.map50 > 0.5, 'its scores are kept');

    // Someone else: their own window, titled differently, and an empty library
    library = theirs; windowTitle = 'Game B';
    await js(`localStorage.clear();0`);
    await win.reload();
    await start();
    await click('Import…');
    await until(`!!document.querySelector('[aria-label="Import a setup"]')`);
    await click('From a file…');
    await until(`!!document.querySelector('[aria-label="Import a setup file"]')`, 'the file import dialog');
    const dialog = await js(`document.querySelector('[aria-label="Import a setup file"]').textContent`);
    assert.match(dialog, /Saved from the window “Game A”/);
    assert.match(dialog, /States and Regions \(2 states, 1 region\)/);
    assert.match(dialog, /Mob finder/);
    assert.match(dialog, /Replaces its 1 graph, its recording setup for “Game B”/, 'the empty graph and default recording setup a new window gets');
    await click('Import', `document.querySelector('[aria-label="Import a setup file"]')`);
    await until(`document.querySelector('.setup-message')?.textContent.includes('Imported the setup from “Game A”')`, 'imported');
    assert.match(await js(`document.querySelector('.setup-message').textContent`), /1 model added to Trained Models/);
    // Their window has it all now, under its own title
    await until(`[...document.querySelectorAll('.state-row .state-name')].map(n=>n.textContent).join()==='Camera,Mobs' || [...document.querySelectorAll('.state-row .state-name')].length===2`, 'the States');
    assert.ok(await js(`!!document.querySelector('.state-folder') && document.querySelector('.state-folder-name').value==='Memory'`), 'the folder');
    const got = await js(`Object.fromEntries(Object.keys(localStorage).filter(k=>k.includes(encodeURIComponent('Game B'))).map(k=>[k,localStorage.getItem(k)]))`);
    const encB = encodeURIComponent('Game B');
    assert.equal(JSON.parse(got[`firefly-regions-${encB}`])[0].label, 'Mini map');
    assert.deepEqual(JSON.parse(got[`firefly-record-setup-${encB}`]), { buttons: ['left', 'space'], hz: 20 });
    assert.equal(JSON.parse(got[`firefly-policy-graph-${encB}-document-g1`]).nodes[0].data.directory, '', 'they choose their own dataset folder');
    // The model, with the name, threshold and outputs it was exported with
    const added = models.listModels(theirs);
    assert.equal(added.length, 1); assert.equal(added[0].name, 'Mob finder'); assert.equal(added[0].threshold, 0.4);
    assert.equal(added[0].kind, 'detector'); assert.ok(added[0].training?.map50 > 0.5, 'its scores came too');
    assert.ok(!JSON.stringify(added[0]).includes(path.join(root, 'runs')), 'it doesn’t point at the exporter’s files');

    // Importing it again: the model they have is kept, not added twice
    await click('Import…'); await until(`!!document.querySelector('[aria-label="Import a setup"]')`);
    await click('From a file…'); await until(`!!document.querySelector('[aria-label="Import a setup file"]')`);
    await click('Import', `document.querySelector('[aria-label="Import a setup file"]')`);
    await until(`document.querySelector('.setup-message')?.textContent.includes('1 you already had')`, 'kept the model they had');
    assert.equal(models.listModels(theirs).length, 1);

    assert.deepEqual(errors, []);
    console.log('PASS: export with the model its States read, nothing naming this PC in the file, import into a differently titled window with an empty library (States, folders, Regions, recording setup, graphs with folders cleared, the model with its outputs and scores), and a second import keeps the model they had.');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/setup-file-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
