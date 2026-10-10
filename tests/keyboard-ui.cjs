// The buttons a recording holds are chosen on a whole keyboard: clicked or pressed, Shift, Ctrl and Alt
// too, the keys that open Windows' menus or stay switched on can't be chosen, every other key can be at
// once, and record.start gets them in the order recordings always had them. Needs `npm run build`:
// electron tests/keyboard-ui.cjs
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
const profile = path.join(root, 'build', 'keyboard-ui-profile');
fs.rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);
let win, started = null;
const watchdog = setTimeout(() => { console.error('Keyboard UI timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  try {
    const image = nativeImage.createFromBitmap(Buffer.alloc(320 * 200 * 4, 90), { width: 320, height: 200 });
    ipcMain.handle('runtime:available', () => true); ipcMain.handle('runtime:status', () => ({ ready: true, error: null }));
    ipcMain.handle('windows:thumbnails', () => ({})); ipcMain.handle('models:probe', () => null); ipcMain.handle('collection:status', () => []);
    ipcMain.handle('models:list', () => []);
    ipcMain.handle('training:check-checkpoint', () => ({ found: false })); ipcMain.handle('training:gpu-check', () => ({ available: false }));
    ipcMain.handle('runtime:invoke', async (_, op, params) => {
      if (op === 'windows') return { windows: [{ id: '123', title: 'Keyboard fixture', pid: 1 }] };
      if (op === 'frame') { await wait(20); return { dataUrl: image.toDataURL(), timestamp: Date.now(), width: 320, height: 200 }; }
      if (op === 'dataset.list') return { recordings: [] };
      if (op === 'observe.fields') return { fields: [], excluded: [] };
      if (op === 'record.start') { started = params; return { ok: true }; }
      return { ok: true };
    });
    win = new BrowserWindow({ width: 1500, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const click = text => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})).click();0`);
    const key = label => `document.querySelector('.kb [aria-label=${JSON.stringify(label)}]')`;
    const press = code => js(`window.dispatchEvent(new KeyboardEvent('keydown',{code:${JSON.stringify(code)},key:${JSON.stringify(code)},bubbles:true,cancelable:true}));0`);
    const chips = () => js(`[...document.querySelectorAll('.key-chip')].map(c=>c.firstChild.textContent)`);

    await win.loadFile(path.join(root, 'dist/index.html'));
    await until(`!!document.querySelector('.win-item')`);
    await js(`document.querySelector('.win-item').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));0`);
    await click('Start Session');
    await until(`!!document.querySelector('[aria-label="Preview source"]')`);
    await js(`[...document.querySelectorAll('.bottom-center-panel .panel-tab')].find(b=>b.textContent.includes('Recordings')).click();0`);
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Choose on keyboard'))`);
    assert.deepEqual(await chips(), ['LMB', 'RMB', 'W', 'A', 'S', 'D', 'Space'], 'the defaults');

    // The whole keyboard: chosen keys lit, blocked ones greyed out and saying why
    await click('Choose on keyboard');
    await until(`!!document.querySelector('.kb-dialog .kb-board')`);
    assert.ok(await js(`document.querySelectorAll('.kb-key').length`) >= 104, 'a full keyboard');
    assert.equal(await js(`${key('W')}.getAttribute('aria-pressed')`), 'true');
    for (const blocked of ['Win', 'Caps', 'PrtSc', 'Num', 'Menu']) {
      assert.equal(await js(`[...document.querySelectorAll('.kb-key-blocked')].some(k=>k.textContent===${JSON.stringify(blocked)}&&k.disabled&&k.title.length>20)`), true, `${blocked} can't be chosen and says why`);
    }
    // Keys sized and placed as on a keyboard: Space wider than a letter, the number pad's + two rows tall
    const box = label => js(`(()=>{const r=${key(label)}.getBoundingClientRect();return {w:r.width,h:r.height,x:r.x};})()`);
    const space = await box('Space'), q = await box('Q'), plus = await box('Num +');
    assert.ok(space.w > 5 * q.w && plus.h > 1.8 * q.h, JSON.stringify({ space, q, plus }));

    // Chosen by clicking, and by pressing; the number pad's Enter is the same key as the main one
    await js(`${key('F1')}.click();0`);
    await press('Insert'); await press('KeyW'); await press('NumpadEnter'); await press('BracketLeft');
    await until(`${key('Enter')}.getAttribute('aria-pressed')==='true'`);
    assert.equal(await js(`document.querySelectorAll('.kb [aria-label="Enter"][aria-pressed="true"]').length`), 2, 'both Enter keys lit');
    assert.equal(await js(`${key('W')}.getAttribute('aria-pressed')`), 'false', 'pressing a chosen key leaves it out');
    // Shift, Ctrl and Alt are chosen as other keys are: pressed on their own (the browser marks Ctrl's own
    // press as Ctrl held) or clicked, and either side's key is the same button
    await press('ShiftLeft');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'ControlRight',ctrlKey:true,bubbles:true,cancelable:true}));0`);
    await until(`${key('Ctrl')}.getAttribute('aria-pressed')==='true'`, 'Ctrl chosen by pressing it');
    for (const m of ['Shift', 'Ctrl'])
      assert.equal(await js(`document.querySelectorAll('.kb [aria-label="${m}"][aria-pressed="true"]').length`), 2, `both ${m} keys lit`);
    assert.equal(await js(`${key('Alt')}.disabled`), false, 'Alt can be chosen');
    // A modifier pressed with a key chooses nothing, and Escape closes the keyboard
    await js(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyT',ctrlKey:true,bubbles:true}));0`);
    assert.equal(await js(`${key('T')}.getAttribute('aria-pressed')`), 'false');
    await js(`${key('LMB')}.click();0`);
    await press('Escape');
    await until(`!document.querySelector('.kb-dialog')`, 'Escape closes it');
    assert.deepEqual(await chips(), ['RMB', 'A', 'S', 'D', 'Space', 'F1', 'Enter', '[', 'Insert', 'Shift', 'Ctrl'], 'in the order recordings hold them');

    // There's no limit short of the whole keyboard: every one of these is taken (11 chosen before)
    await click('Choose on keyboard');
    await until(`!!document.querySelector('.kb-dialog')`);
    for (const l of 'BCEFGHIJKLMNOPQRTUVXYZ') await js(`${key(l)}.click();0`);
    assert.equal(await js(`[...'BCEFGHIJKLMNOPQRTUVXYZ'].every(l=>document.querySelector('.kb [aria-label="'+l+'"]').getAttribute('aria-pressed')==='true')`), true, 'every letter taken');
    assert.equal(await js(`${key('F2')}.disabled`), false, 'more can still be chosen');
    await js(`${key('Q')}.click();0`);
    await js(`${key('F2')}.click();0`);
    win.webContents.invalidate(); await wait(150);
    fs.writeFileSync(path.join(root, 'build/keyboard-ui.png'), (await win.webContents.capturePage()).toPNG());
    // A chosen mouse button is lit like a chosen key
    assert.equal(await js(`getComputedStyle(${key('RMB')}).backgroundColor`), await js(`getComputedStyle(${key('F1')}).backgroundColor`), 'the chosen mouse button lit');
    await click('Done');

    // A chip's ✕ leaves a button out too, and record.start gets them with their key codes, in the order
    // recordings always had them (the original buttons first)
    await js(`document.querySelector('[aria-label="Stop recording B"]').click();0`);
    await until(`!document.querySelector('[aria-label="Stop recording B"]')`);
    await click('Start recording');
    for (let i = 0; i < 50 && !started; i++) await wait(40);
    const ids = started.buttons.map(b => b.id);
    assert.equal(ids.length, 32);
    assert.deepEqual(ids.slice(0, 9), ['rmb', 'a', 's', 'd', 'space', 'e', 'r', 'f', 'g']);
    assert.deepEqual(ids.slice(-7), ['f1', 'f2', 'enter', 'bracketleft', 'insert', 'shift', 'ctrl']);
    const vk = id => started.buttons.find(b => b.id === id)?.vk;
    assert.deepEqual([vk('f1'), vk('f2'), vk('insert'), vk('enter'), vk('bracketleft'), vk('h'), vk('shift'), vk('ctrl')], [112, 113, 45, 13, 219, 72, 16, 17]);
    assert.ok(ids.indexOf('c') < ids.indexOf('h'), 'the original buttons keep their place');
    // Kept for the window
    const saved = JSON.parse(await js(`localStorage.getItem('firefly-record-setup-' + encodeURIComponent('Keyboard fixture'))`));
    assert.ok(saved.buttons.includes('f2') && !saved.buttons.includes('b'));

    assert.deepEqual(errors, []);
    console.log('PASS: whole keyboard, Shift/Ctrl/Alt choosable, blocked keys explained, click and press to choose, both Enters one key, no 24 limit, chips, record.start in the old order with key codes, kept per window.');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/keyboard-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
