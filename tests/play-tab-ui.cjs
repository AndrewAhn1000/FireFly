// The Play tab plays a trained version as it is or with corrections, shows what it's doing, and trains a new
// version with the corrections from what the version saved (no graph needed); the Policy node's Delete all
// deletes every version of its policy with their corrections. Versions are listed newest first. The worker,
// player and runtime are stand-ins. Needs `npm run build`: electron tests/play-tab-ui.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'play-tab-ui-profile'));
let win;
const watchdog = setTimeout(() => { console.error('Play tab UI timed out'); app.exit(1); }, 90000);

const version = (id, created, policy, extra = {}) => ({
  id, created, version: 3, trainingSamples: 800, validationSamples: 200, stepMs: 66, policy,
  observationSchema: { identity: 'obs' }, actionSchema: { identity: 'act' },
  buttons: [{ button: 'right', precision: .8, recall: .8, f1: .8, pressed: .3 }, { button: 'space', precision: .6, recall: .6, f1: .6, pressed: .1 }],
  outputs: [{ id: 'right', vk: 39 }, { id: 'space', vk: 32 }],
  config: { recordingIds: ['r1', 'r9'], formulas: [{ name: 'twice', source: 'error * 2' }], columns: ['twice'], derived: [], buttons: ['right', 'space'],
            stepMs: 66, history: 2, actionDelayMs: 0, epochs: 5, anchor: null, surface: 'below', nearPx: 200 },
  features: { grids: [{ name: 'floor', cols: 4, rows: 3 }] }, ...extra,
});
const walker = { id: 'legacy', name: 'Walker' };
// Not in order: the list is shown newest first whatever order it comes in
let versions = [version('w1', 100, walker), version('j1', 150, { id: 'other', name: 'Jumper' }), version('w2', 200, walker), version('e1', 50, null, { version: 2 })];
let recordings = [
  { id: 'r1', name: 'Run', status: 'complete', samples: 900, durationMs: 60000, invalidSamples: 0, metadata: { started: 1 } },
  { id: 'c1', name: 'Fix 1', status: 'complete', samples: 40, durationMs: 3000, invalidSamples: 0, metadata: { started: 2, correction: true, policyId: 'w1' } },
  { id: 'c2', name: 'Fix 2', status: 'complete', samples: 40, durationMs: 3000, invalidSamples: 0, metadata: { started: 3, correction: true, policyId: 'w2' } },
  { id: 'c3', name: 'Fix 3', status: 'complete', samples: 40, durationMs: 3000, invalidSamples: 0, metadata: { started: 4, correction: true, policyId: 'j1' } },
];
const played = [], trained = [], deletedModels = [], deletedRecordings = [];
let stopped = 0, finishTraining = null;

app.whenReady().then(async () => {
  try {
    const image = nativeImage.createFromBitmap(Buffer.alloc(320 * 200 * 4, 90), { width: 320, height: 200 });
    ipcMain.handle('runtime:available', () => true); ipcMain.handle('runtime:status', () => ({ ready: true, error: null }));
    ipcMain.handle('windows:thumbnails', () => ({})); ipcMain.handle('models:probe', () => null); ipcMain.handle('collection:status', () => []);
    ipcMain.handle('models:list', () => []);
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false }));
    ipcMain.handle('runtime:invoke', async (_, op, params) => {
      if (op === 'windows') return { windows: [{ id: '123', title: 'Test Game', pid: 1 }] };
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width: 320, height: 200 }; }
      if (op === 'dataset.list') return { recordings };
      if (op === 'dataset.delete') { deletedRecordings.push(params.recordingId); recordings = recordings.filter(r => r.id !== params.recordingId); return { ok: true }; }
      if (op === 'observe.fields') return { fields: [], excluded: [] };
      return { ok: true };
    });
    ipcMain.handle('policy:invoke', async (_, op, params) => {
      if (op === 'models') return versions;
      if (op === 'models.delete') { deletedModels.push(params.modelId); versions = versions.filter(v => v.id !== params.modelId); return { ok: true }; }
      if (op === 'train') {
        trained.push(params);
        await new Promise(resolve => { finishTraining = resolve; });
        const made = version('w3', 300, params.policy);
        versions = [...versions, made];
        return made;
      }
      return {};
    });
    ipcMain.handle('play:start', (_, params) => { played.push(params); return { ok: true }; });
    ipcMain.handle('play:stop', () => { stopped++; });
    win = new BrowserWindow({ width: 1500, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`(()=>{const b=[...document.querySelectorAll('button,.panel-tab,.panel-tab-click')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)throw Error('Missing '+${JSON.stringify(text)});b.click();})();0`);
    // A button in the Play tab's detail, not one of the same name elsewhere (the capture's Stop)
    const play = label => js(`(()=>{const b=[...document.querySelectorAll('.play-detail button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)}));if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click();})();0`);
    const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
    const send = (channel, value) => win.webContents.send(channel, value);

    await win.loadFile(path.join(root, 'dist/index.html'));
    const graph = { version: 1, nodes: [{ id: 'legacy', type: 'policy', position: { x: 80, y: 90 }, data: { kind: 'policy', name: 'Walker', buttons: null, off: [], stepMs: null, history: 2, delayMs: 0, epochs: 5 } }], edges: [] };
    await js(`localStorage.clear();localStorage.setItem('firefly-last-window','Test Game');localStorage.setItem('firefly-policy-graph-Test%20Game',${JSON.stringify(JSON.stringify(graph))});0`);
    await win.reload();
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);

    // Every policy and its versions, newest first; the newest is chosen
    await click('Play');
    await until(`document.querySelectorAll('.play-version').length === 4`);
    assert.deepEqual(await js(`[...document.querySelectorAll('.play-group-hd')].map(h=>h.firstChild.textContent)`), ['Walker', 'Jumper', 'Earlier policies']);
    assert.deepEqual(await js(`[...document.querySelectorAll('.play-group')][0].textContent.match(/v\\d/g)`), ['v2', 'v1']);
    assert.match(await text('.play-title'), /Walker v2/);
    assert.match(await text('.play-detail'), /Presses →, Space/);
    assert.match(await text('.play-detail'), /2 corrections recorded while Walker's versions played \(1 while this one played\)/);

    // Play as it is, and with corrections
    await play('▶ Play');
    await until(`true`); for (let i = 0; i < 50 && !played.length; i++) await wait(40);
    assert.deepEqual(played[0], { modelId: 'w2', windowId: '123', corrections: false });
    send('play:status', { playing: true, modelId: 'w2', actions: 5, holding: ['right'], pressed: { right: 3 } });
    await until(`document.querySelector('.play-live')?.textContent.includes('holding →')`, 'live play status');
    assert.match(await text('.play-live'), /5 actions.*pressed so far: → 3×/);
    assert.ok(await js(`!!document.querySelector('.play-version-sel .play-dot')`), 'the version playing is marked');
    await play('■ Stop');
    for (let i = 0; i < 50 && !stopped; i++) await wait(40);
    assert.equal(stopped, 1);
    send('play:status', { playing: false, modelId: 'w2', reason: 'You took over' });
    await until(`document.querySelector('.play-stopped')?.textContent.includes('You took over')`);
    await play('▶ Play and record my corrections');
    for (let i = 0; i < 50 && played.length < 2; i++) await wait(40);
    assert.equal(played[1].corrections, true);
    send('play:status', { playing: false, modelId: 'w2', reason: null });

    // How much the corrections count: 40% of training unless chosen (this version saved none), chosen on a slider
    const slide = (selector, value) => js(`(()=>{const i=document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'${value}');i.dispatchEvent(new Event('input',{bubbles:true}));})();0`);
    assert.match(await text('.play-share'), /40% of training/);
    await slide('.play-share input', 0);
    await until(`document.querySelector('.play-share').textContent.includes('as plain rows')`, '0 shown as plain rows');
    await slide('.play-share input', .7);
    await until(`document.querySelector('.play-share').textContent.includes('70% of training')`, 'the chosen share shown');

    // Train a new version with the corrections: what this version was trained from, plus every Walker correction,
    // counting as much as was chosen
    await play('Train a new version with my corrections');
    for (let i = 0; i < 50 && !trained.length; i++) await wait(40);
    const request = trained[0];
    assert.deepEqual(request.recordingIds, ['r1', 'c1', 'c2'], 'its recordings (one deleted since left out) and Walker’s corrections');
    assert.deepEqual(request.formulas, [{ name: 'twice', source: 'error * 2' }]);
    assert.deepEqual(request.columns, ['twice']); assert.deepEqual(request.buttons, ['right', 'space']);
    assert.deepEqual(request.grids, [{ name: 'floor', cols: 4, rows: 3 }]);
    assert.equal(request.stepMs, 66); assert.equal(request.history, 2); assert.equal(request.epochs, 5);
    assert.deepEqual(request.policy, walker);
    assert.equal(request.correctionShare, .7, 'the corrections’ chosen share');
    send('policy:event', { event: 'training', result: { epoch: 2, validationLoss: .4 } });
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Training… 2/5'))`, 'training progress');
    finishTraining();
    await until(`document.querySelector('.play-title')?.textContent.includes('Walker v3')`, 'the new version chosen');
    assert.ok(await js(`!!document.querySelector('.play-new')`));

    // A version from an older FireFly can't play
    await js(`[...document.querySelectorAll('.play-version')].find(b=>b.closest('.play-group').textContent.startsWith('Earlier')).click();0`);
    await until(`document.querySelector('.play-detail')?.textContent.includes('older FireFly')`);
    assert.ok(!(await js(`[...document.querySelectorAll('.play-detail button')].some(b=>b.textContent.includes('▶ Play'))`)));
    win.webContents.invalidate(); await wait(150);
    await js(`[...document.querySelectorAll('.play-version')][0].click();0`); await wait(150);
    fs.writeFileSync(path.join(root, 'build/play-tab-ui.png'), (await win.webContents.capturePage()).toPNG());

    // The Policy node: its versions newest first, and Delete all deletes them with their corrections only
    await click('Graphs');
    await until(`!!document.querySelector('.pg-delete-all')`, 'the Policy node’s Delete all');
    assert.deepEqual(await js(`[...document.querySelectorAll('.pg-version b')].map(b=>b.textContent)`), ['v3', 'v2', 'v1']);
    // The Policy node chooses how much its corrections count too, and keeps it with the graph
    assert.match(await text('.pg-share'), /40% of training/);
    await slide('.pg-share input', .25);
    await until(`document.querySelector('.pg-share').textContent.includes('25% of training')`, 'the node’s chosen share shown');
    // (the graph library keeps the graph under a key of its own)
    const keptShare = () => js(`Object.keys(localStorage).filter(k=>k.startsWith('firefly-policy-graph-Test%20Game')).map(k=>{try{return JSON.parse(localStorage.getItem(k))}catch{return null}})
      .flatMap(g=>g?.nodes??[]).find(n=>n.id==='legacy')?.data.correctionShare`);
    for (let i = 0; i < 50 && await keptShare() !== .25; i++) await wait(40);
    assert.equal(await keptShare(), .25, 'kept with the graph');
    await js(`window.confirm = () => true; document.querySelector('.pg-delete-all').click();0`);
    for (let i = 0; i < 50 && deletedModels.length < 3; i++) await wait(40);
    await until(`!document.querySelector('.pg-version')`, 'the versions gone');
    assert.deepEqual(deletedModels.sort(), ['w1', 'w2', 'w3']);
    assert.deepEqual(deletedRecordings.sort(), ['c1', 'c2'], 'Walker’s corrections, not Jumper’s');
    assert.ok(versions.some(v => v.id === 'j1'), 'another policy’s version was kept');

    assert.deepEqual(errors, []);
    console.log('PASS: Play tab lists policies newest first, plays as is and with corrections, live status and stop, trains a new version with corrections from what the version saved, older versions can’t play; Policy node Delete all deletes every version with its corrections only.');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/play-tab-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
