// The Train tab says why training isn't on the GPU and what would make it: no NVIDIA driver, a driver too old
// (NVIDIA's own driver, not Windows Update), a development setup's pip command for the exact versions, and in
// the installed app the GPU support download (progress, then on and ticked, then removable); training on the
// CPU is never blocked. The GPU check, download and removal are stand-ins. Needs `npm run build`:
// electron tests/gpu-ui.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), wait = ms => new Promise(r => setTimeout(r, ms));
app.setPath('userData', path.join(root, 'build', 'gpu-ui-profile'));
let win;
const watchdog = setTimeout(() => { console.error('GPU UI timed out'); app.exit(1); }, 60000);

const smi = { nvidiaSmiOk: true, driverCuda: '13.2', gpuName: 'NVIDIA GeForce GTX 1060', computeCap: '6.1', driverVersion: '591.86', torch: '2.14.0+cpu', vision: '0.29.1+cpu' };
let info = { available: false, name: null, ...smi, plan: { reason: 'driver', need: '12.6', driverVersion: 560 }, driverCuda: '12.2', driverVersion: '531.18', packaged: true, installed: null };
let checks = 0, installs = 0, removes = 0;

app.whenReady().then(async () => {
  try {
    for (const [name, result] of [['runtime:available', true], ['runtime:status', { ready: true, error: null }], ['windows:thumbnails', {}], ['models:list', []], ['models:probe', null], ['collection:status', []]])
      ipcMain.handle(name, () => result);
    ipcMain.handle('runtime:invoke', (_, op) => op === 'windows' ? { windows: [] } : op === 'dataset.list' ? { recordings: [] } : op === 'observe.fields' ? { fields: [] } : {});
    ipcMain.handle('policy:invoke', (_, op) => op === 'models' ? [] : {});
    ipcMain.handle('training:check-checkpoint', () => ({ found: false }));
    ipcMain.handle('training:gpu-check', () => { checks++; return info; });
    ipcMain.handle('training:gpu-install', async () => {
      installs++;
      const send = p => win.webContents.send('training:gpu-progress', { variant: 'cu126', ...p });
      send({ phase: 'download', done: 2 ** 30, total: 2.5 * 2 ** 30 });
      await wait(400);
      send({ phase: 'test' });
      await wait(200);
      info = { ...info, available: true, name: smi.gpuName, torch: '2.14.0+cu126', installed: { variant: 'cu126', name: smi.gpuName } };
      return { ok: true, variant: 'cu126', name: smi.gpuName };
    });
    ipcMain.handle('training:gpu-remove', () => { removes++; info = { ...info, available: false, torch: '2.14.0+cpu', installed: null }; return { ok: true }; });
    win = new BrowserWindow({ width: 1500, height: 1000, show: false, webPreferences: { offscreen: true, preload: path.join(root, 'electron/preload.cjs'), backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    const js = code => win.webContents.executeJavaScript(code);
    const until = async (code, what = code) => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(40); } throw Error('UI condition failed: ' + what); };
    const gpuText = () => js(`document.querySelector('.train-gpu-install')?.textContent ?? ''`);
    const press = label => js(`(()=>{const b=[...document.querySelectorAll('.train-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing '+${JSON.stringify(label)});b.click();})();0`);
    const gpuBox = `[...document.querySelectorAll('.train-panel label')].find(l=>l.textContent.includes('Use GPU (CUDA)')).querySelector('input')`;

    await win.loadFile(path.join(root, 'dist/index.html'));
    await js(`localStorage.clear();0`); await win.reload();
    await until(`!!document.querySelector('.train-kind')`);

    // A driver too old: training on the CPU, what driver it needs and where to get it, and Check again
    await until(`document.querySelector('.train-gpu-install')?.textContent.includes('needs CUDA 12.6')`, 'the driver message');
    let text = await gpuText();
    assert.match(text, /Training runs on the CPU for now/);
    assert.match(text, /supports CUDA 12\.2, and training on your NVIDIA GeForce GTX 1060 needs CUDA 12\.6: driver 560 or newer \(you have 531\.18\)/);
    assert.match(text, /Windows Update usually doesn’t install NVIDIA’s newest driver: get it from nvidia\.com\/drivers/);
    assert.equal(await js(`${gpuBox}.disabled`), true);
    assert.match(await js(`document.querySelector('.train-gpu-status').textContent`), /training on the CPU/);
    // After updating the driver, Check again finds a build to download
    info = { ...info, driverCuda: '13.2', driverVersion: '591.86', plan: { variant: 'cu126', cuda: '12.6', aboutGb: 2.5 } };
    const before = checks;
    await press('Check again');
    await until(`document.querySelector('.train-gpu-install')?.textContent.includes('Download GPU support')`, 'the download offer');
    assert.ok(checks > before);
    assert.match(await gpuText(), /FireFly can download PyTorch’s GPU build for your NVIDIA GeForce GTX 1060 \(CUDA 12\.6, about 2\.5 GB/);

    // Download: progress, then the card is used and Use GPU is ticked
    await press('Download GPU support');
    await until(`document.querySelector('.train-gpu-install')?.textContent.includes('1.00 of 2.50 GB')`, 'download progress');
    assert.equal(await js(`document.querySelector('.train-gpu-bar div').style.width`), '40%');
    await until(`document.querySelector('.train-gpu-note')?.textContent.includes('with the GPU support FireFly downloaded')`, 'GPU support in use');
    assert.equal(installs, 1);
    assert.equal(await js(`${gpuBox}.checked && !${gpuBox}.disabled`), true, 'Use GPU ticked once downloaded');
    assert.match(await js(`document.querySelector('.train-gpu-ok').textContent`), /GTX 1060/);
    win.webContents.invalidate(); await wait(150);
    fs.writeFileSync(path.join(root, 'build/gpu-ui.png'), (await win.webContents.capturePage()).toPNG());

    // Remove it: back to the CPU, and the offer again
    await js(`window.confirm = () => true;0`);
    await js(`[...document.querySelectorAll('.train-panel button')].find(b=>b.textContent.trim()==='Remove GPU support').click();0`);
    await until(`document.querySelector('.train-gpu-install')?.textContent.includes('Download GPU support')`, 'removed');
    assert.equal(removes, 1);
    assert.equal(await js(`${gpuBox}.checked`), false);

    // A development setup: the pip command for the exact versions and build
    info = { ...info, packaged: false };
    await press('Download GPU support').catch(() => {}); // not there in development; reload instead
    await win.reload();
    await until(`document.querySelector('.train-gpu-cmd')`, 'the pip command');
    assert.equal(await js(`document.querySelector('.train-gpu-cmd').textContent`),
      '.venv\\Scripts\\pip install torch==2.14.0+cu126 torchvision==0.29.1+cu126 --index-url https://download.pytorch.org/whl/cu126 --no-deps --force-reinstall');

    // No NVIDIA driver at all
    info = { available: false, name: null, nvidiaSmiOk: false, plan: { reason: 'no-driver' }, packaged: true, installed: null };
    await win.reload();
    await until(`document.querySelector('.train-gpu-install')?.textContent.includes('No NVIDIA graphics card was found')`, 'no NVIDIA');

    assert.deepEqual(errors, []);
    console.log('PASS: GPU messages say training runs on the CPU and why (old driver: which one and from NVIDIA; no NVIDIA), Check again, download with progress then used and ticked, remove, and the exact pip command in development.');
    clearTimeout(watchdog); win.destroy(); app.exit(0);
  } catch (e) {
    console.error(e); clearTimeout(watchdog);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'build/gpu-ui-failure.png'), (await win.webContents.capturePage()).toPNG());
    app.exit(1);
  }
});
