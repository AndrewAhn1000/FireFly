// States turned off aren't read, run or recorded, and scripts reading them are told so; a hidden Lua Region's
// script stops; States can be kept in folders (dragged in, a folder's switch, rename, collapse, the State
// dialog's Folder, deleting one moves its States out), kept per window. Needs `npm run build`:
// electron tests/state-folders-ui.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'state-folders-ui-profile'));
let win, calls = [], tracked = null, recordingEvent = null;
const watchdog = setTimeout(() => { console.error('State folders UI timed out'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  try {
    const image = nativeImage.createFromBitmap(Buffer.alloc(320 * 200 * 4, 90), { width: 320, height: 200 });
    ipcMain.handle('runtime:available', () => true); ipcMain.handle('runtime:status', () => ({ ready: true, error: null }));
    ipcMain.handle('windows:thumbnails', () => ({})); ipcMain.handle('models:probe', () => null); ipcMain.handle('collection:status', () => []);
    ipcMain.handle('models:list', () => []);
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false }));
    ipcMain.handle('runtime:invoke', async (_, op, params) => {
      if (op === 'windows') return { windows: [{ id: '123', title: 'States fixture', pid: 1 }] };
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width: 320, height: 200 }; }
      if (op === 'dataset.list') return { recordings: [] };
      if (op === 'observe.fields') return { fields: [], excluded: [] };
      if (op === 'observe.tracked') tracked = params.observations;
      if (op === 'memory.read') { calls.push({ op, address: params.address }); return { value: 7 }; }
      if (op === 'memory.run_script') {
        calls.push({ op, script: params.script, states: params.states, regions: params.regions });
        await wait(5);
        return { value: params.script.includes('{') ? [] : 1, windowW: 320, windowH: 200, clientArea: { x: 0, y: 0, w: 1, h: 1 }, regionsRead: [], timestamp: performance.now() };
      }
      return { ok: true };
    });
    win = new BrowserWindow({ width: 1500, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 120; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click();0`);
    const row = name => `[...document.querySelectorAll('.state-row')].find(r=>r.querySelector('.state-name').textContent===${JSON.stringify(name)})`;
    // What's been run or read lately, from a fresh log
    const lately = async (ms = 400) => { calls = []; await wait(ms); return calls; };
    const ranScript = (log, text) => log.some(c => c.op === 'memory.run_script' && c.script === text);
    const start = async () => {
      await until(`!!document.querySelector('.win-item')`);
      await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
      await click('Start Session');
      await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    };

    await win.loadFile(path.join(root, 'dist/index.html'));
    const states = [
      { id: 'cam', name: 'Camera', type: 'vector', source: 'script', script: 'return 1', scriptWidth: 0, scriptHeight: 0 },
      { id: 'hp', name: 'HP', type: 'number', source: 'memory', address: '0x10', offsets: [], byteType: 'u32' },
      { id: 'mobs', name: 'Mobs', type: 'number', source: 'script', script: 'return 2', scriptWidth: 0, scriptHeight: 0 },
    ];
    const regions = [{ id: 'mon', label: 'Monsters', x: 0, y: 0, w: 0, h: 0, templates: [], source: 'script', script: 'return {}', scriptWidth: 800, scriptHeight: 600 }];
    await js(`localStorage.clear();localStorage.setItem('firefly-states-'+encodeURIComponent('States fixture'),${JSON.stringify(JSON.stringify(states))});
      localStorage.setItem('firefly-regions-'+encodeURIComponent('States fixture'),${JSON.stringify(JSON.stringify(regions))});0`);
    await start();
    await until(`!!${row('Camera')}`);
    let log = await lately();
    assert.ok(ranScript(log, 'return 1') && ranScript(log, 'return 2') && ranScript(log, 'return {}') && log.some(c => c.op === 'memory.read'), 'everything runs');
    await until(`!!(window.__t = 1)`); // let observe.tracked go out
    for (let i = 0; i < 50 && !tracked?.some(d => d.name === 'Camera'); i++) await wait(40);
    assert.ok(tracked.some(d => d.name === 'Camera'), 'Camera recorded');

    // Turning a State off: its script stops, the runtime stops reading and recording it, scripts reading it are told it's off
    await js(`document.querySelector('[aria-label="Camera on"]').click();0`);
    await until(`document.querySelector('[aria-label="Camera on"]').getAttribute('aria-checked')==='false'`);
    await until(`${row('Camera')}.textContent.includes('off')`);
    await wait(150);
    log = await lately();
    assert.ok(!ranScript(log, 'return 1'), 'a State turned off still ran');
    assert.ok(ranScript(log, 'return 2'), 'the others still run');
    const sent = log.find(c => c.op === 'memory.run_script').states;
    assert.equal(sent.find(d => d.name === 'Camera').off, true, 'scripts are told Camera is off');
    for (let i = 0; i < 50 && tracked.some(d => d.name === 'Camera'); i++) await wait(40);
    assert.ok(!tracked.some(d => d.name === 'Camera') && tracked.some(d => d.name === 'HP'), 'Camera is no longer read for recordings');
    // A memory State turned off isn't read
    await js(`document.querySelector('[aria-label="HP on"]').click();0`);
    await wait(150);
    assert.ok(!(await lately()).some(c => c.op === 'memory.read'), 'a memory State turned off was still read');

    // Hiding a Lua Region stops its script, and scripts reading it are told it's hidden
    await js(`document.querySelector('[aria-label="Hide Monsters"]').click();0`);
    await wait(150);
    log = await lately();
    assert.ok(!ranScript(log, 'return {}'), 'a hidden Lua Region still ran');
    assert.equal(log.find(c => c.op === 'memory.run_script').regions.find(r => r.label === 'Monsters').off, true);
    await js(`document.querySelector('[aria-label="Show Monsters"]').click();0`);
    await wait(150);
    assert.ok(ranScript(await lately(), 'return {}'), 'shown again, it runs again');

    // Folders: made, dragged into, switched off as one, renamed, collapsed
    await click('+ Folder');
    await until(`!!document.querySelector('.state-folder')`);
    await js(`(()=>{const dt=new DataTransfer();const r=${row('Mobs')};r.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
      const f=document.querySelector('.state-folder');f.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
      f.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));r.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));})();0`);
    await until(`!!document.querySelector('.state-folder-body')?.textContent.includes('Mobs')`, 'Mobs dragged into the folder');
    assert.equal(await js(`document.querySelector('.state-folder-count').textContent`), '1');
    await js(`document.querySelector('[aria-label="Folder 1 on"]').click();0`);
    await until(`document.querySelector('[aria-label="Mobs on"]').getAttribute('aria-checked')==='false'`, 'the folder turned Mobs off');
    await wait(150);
    assert.ok(!ranScript(await lately(), 'return 2'), 'the folder switch stopped its scripts');
    await js(`document.querySelector('[aria-label="Folder 1 on"]').click();0`);
    await until(`document.querySelector('[aria-label="Mobs on"]').getAttribute('aria-checked')==='true'`, 'and on again');
    await js(`(()=>{const i=document.querySelector('.state-folder-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Combat');i.dispatchEvent(new Event('input',{bubbles:true}));})();0`);
    await until(`document.querySelector('.state-folder-name').value==='Combat'`);
    await js(`document.querySelector('.state-folder-hd').click();0`);
    await until(`!document.querySelector('.state-folder-body')`, 'collapsed');
    await js(`document.querySelector('.state-folder-hd').click();0`);
    await until(`!!document.querySelector('.state-folder-body')`, 'opened');

    // The State dialog puts a State in a folder
    await js(`document.querySelector('[aria-label="Edit HP"]').click();0`);
    await until(`!!document.querySelector('[aria-label="State folder"]')`);
    const folderId = await js(`[...document.querySelector('[aria-label="State folder"]').options].find(o=>o.textContent==='Combat').value`);
    await js(`(()=>{const s=document.querySelector('[aria-label="State folder"]');s.value=${JSON.stringify(folderId)};s.dispatchEvent(new Event('change',{bubbles:true}));})();0`);
    await click('Save Changes');
    await until(`document.querySelector('.state-folder-body').textContent.includes('HP')`, 'HP moved by the dialog');
    assert.equal(await js(`document.querySelector('[aria-label="HP on"]').getAttribute('aria-checked')`), 'false', 'editing a State keeps it off');

    // Kept per window: folders, what's in them and what's off, after the page is reloaded
    await wait(200);
    await win.reload();
    await start();
    await until(`!!document.querySelector('.state-folder')`, 'the folder kept');
    assert.equal(await js(`document.querySelector('.state-folder-name').value`), 'Combat');
    assert.equal(await js(`document.querySelector('.state-folder-count').textContent`), '2');
    assert.equal(await js(`document.querySelector('[aria-label="Camera on"]').getAttribute('aria-checked')`), 'false', 'Camera still off');
    await wait(200);
    assert.ok(!ranScript(await lately(), 'return 1'), 'Camera stays off after a reload');

    // While recording, nothing can be turned on or off
    win.webContents.send('runtime:event', { event: 'recording', result: { active: true, id: 'r', samples: 0 } });
    await until(`document.querySelector('[aria-label="Camera on"]').disabled && document.querySelector('[aria-label="Combat on"]').disabled`, 'switches locked while recording');
    win.webContents.send('runtime:event', { event: 'recording', result: { active: false, samples: 0 } });
    await until(`!document.querySelector('[aria-label="Camera on"]').disabled`);

    win.webContents.invalidate(); await wait(150);
    fs.writeFileSync(path.join(root, 'build/state-folders-ui.png'), (await win.webContents.capturePage()).toPNG());

    // Deleting a folder keeps its States, at the top level
    await js(`document.querySelector('[aria-label="Delete folder Combat"]').click();0`);
    await until(`!document.querySelector('.state-folder')`);
    assert.equal(await js(`document.querySelectorAll('.state-row').length`), 3, 'its States were kept');

    assert.deepEqual(errors, []);
    console.log('PASS: States turned off stop running and recording (scripts told), memory too, hidden Lua Regions stop, folders: drag in, folder switch, rename, collapse, dialog, kept after reload, locked while recording, delete keeps States.');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/state-folders-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
