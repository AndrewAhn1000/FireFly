'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, nativeImage, dialog, shell, crashReporter } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const models = require('./models.cjs');
const { createPlay } = require('./play.cjs');
const { createCollection } = require('./collection.cjs');
const datasetPreview = require('./datasetPreview.cjs');
const gpu = require('./gpu.cjs');

const isDev = process.env.NODE_ENV === 'development';

// In dev:       paths are relative to the project root
// In packaged:  python-bundle, worker and the native runtime (with its DLLs, in native/) are
//               extraResources → process.resourcesPath
const _resRoot   = () => app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const NATIVE_DIR    = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, '..', 'build', 'native', 'Release');
const RUNTIME_EXE   = path.join(NATIVE_DIR, 'firefly-runtime.exe');
const PYTHON_EXE    = () => app.isPackaged
  ? path.join(process.resourcesPath, 'python-bundle', 'python.exe')
  : path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
const TRAIN_SCRIPT  = () => path.join(_resRoot(), 'worker', 'train_unet.py');
const CHECK_SCRIPT  = () => path.join(_resRoot(), 'worker', 'check_dataset.py');
const TRAIN_YOLO_SCRIPT = () => path.join(_resRoot(), 'worker', 'train_yolo.py');
const CHECK_YOLO_SCRIPT = () => path.join(_resRoot(), 'worker', 'check_yolo_dataset.py');
// The pretrained YOLO weights (downloaded once) and Ultralytics' own settings, kept with FireFly's data
const YOLO_DIR = path.join(app.getPath('userData'), 'yolo');
const YOLO_MODELS = ['yolo11n', 'yolo11s', 'yolo11m', 'yolo11l', 'yolo11x'];
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const MODELS_DIR = path.join(app.getPath('userData'), 'models');
// A CUDA build of PyTorch FireFly downloaded for training on the card (electron/gpu.cjs), kept with the data
const GPU_DIR = path.join(app.getPath('userData'), 'gpu');
// What Python runs with: UTF-8 output, and the downloaded CUDA build when there is one, which training loads
// before the bundled CPU build (worker/sitecustomize.py)
const pythonEnv = ({ withGpu = true } = {}) => {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  delete env.FIREFLY_GPU_TORCH;
  const cuda = withGpu && gpu.installed(GPU_DIR);
  if (cuda) env.FIREFLY_GPU_TORCH = cuda.dir;
  return env;
};

// --- Crashes: kept, so there's something to read afterwards ---
// Electron handles its processes' crashes itself (Windows keeps no report of them) and keeps no dump
// unless its crash reporter is started: dumps stay on this machine, in <userData>/Crashpad. What ended,
// why, and when goes to <userData>/logs/crashes.log as well as the terminal, which may be gone by then.
crashReporter.start({ uploadToServer: false });
function logCrash(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.error(line);
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crashes.log'), line + '\n');
  } catch { /* the terminal has it */ }
}
app.on('render-process-gone', (_e, contents, details) =>
  logCrash(`The window's page ended: ${details.reason} (exit code ${details.exitCode}) at ${contents.getURL().slice(0, 80)}`));
app.on('child-process-gone', (_e, details) =>
  logCrash(`Electron's ${details.type} process${details.name ? ` (${details.name})` : ''} ended: ${details.reason} (exit code ${details.exitCode})`));

let win = null;
let runtime = null;
let nextId = 1;
const pending = new Map();
let runtimeReady = false;
let runtimeError = null;

// --- Runtime process ---

function spawnRuntime() {
  if (!fs.existsSync(RUNTIME_EXE)) return;
  runtime = spawn(RUNTIME_EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  runtime.stdin.setDefaultEncoding('utf8');
  runtime.stdin.on('error', () => {}); // ignore EPIPE when native exits

  // Chunks are kept until a whole packet is there and joined once: joining each chunk onto what came
  // before copied a frame's megabytes over and over (a pipe delivers it in 64 KB pieces), on the thread
  // that also passes observations to play
  let chunks = [], size = 0;
  runtime.stdout.on('data', chunk => {
    chunks.push(chunk); size += chunk.length;
    while (size >= 5) {
      if (chunks[0].length < 5) chunks = [Buffer.concat(chunks, size)];
      const total = chunks[0].readUInt32LE(0);
      if (size < 4 + total) break;
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      const kind = buf[4];
      const payload = buf.subarray(5, 4 + total);
      const rest = buf.subarray(4 + total);
      chunks = rest.length ? [rest] : []; size = rest.length;
      if (kind === 1) onPacket(payload.toString('utf8'));
      else if (kind === 2) onFrame(payload);
    }
  });

  runtime.on('exit', (code, signal) => {
    // Its reason, if any, went to stderr (inherited, so it's in this terminal); the code says how it ended
    logCrash(`FireFly runtime exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
    runtime = null;
    collection.stop(null, 'The capture runtime exited');
    for (const [, { reject }] of pending) reject(new Error('Runtime exited'));
    pending.clear();
    win?.webContents.send('runtime:disconnected');
  });

  // Auto-init storage after startup health check
  runtimeInvoke('health', {})
    .then(() => runtimeInvoke('storage.init', { directory: DATA_DIR }))
    .then(() => {
      runtimeReady = true;
      win?.webContents.send('runtime:ready');
    })
    .catch(err => {
      runtimeError = err.message;
      win?.webContents.send('runtime:error', err.message);
    });
}

// The runtime sends its latest frame on every poll, so a target that hasn't
// repainted returns the same frame again; it keeps its encoding instead of
// being encoded again. The live view is a JPEG: a PNG of a detailed 800x600
// game frame took 50-100 ms on this thread (4 ms as JPEG), which at a game's
// 24 frames a second kept it busy, and the observations play acts on queued
// behind it (143 ms, making them stale). One frame per BUFFER_GAP_MS also goes
// to the live view's rewind buffer, the same JPEG. What reads exact pixels
// (templates, colours) asks for the frame on screen losslessly: the last few
// raw frames are kept for it (frame:exact).
const BUFFER_GAP_MS = 50;
const BUFFER_JPEG_QUALITY = 90;
const EXACT_KEPT = 8;
let lastFrame = null;           // { timestamp, width, height, dataUrl }
let lastBuffered = -Infinity;   // capture time of the last frame given a JPEG
const recentRaw = new Map();    // capture time → { width, height, pixels }, the last EXACT_KEPT raw frames

function onFrame(payload) {
  const id        = payload.readUInt32LE(0);
  const width     = payload.readUInt32LE(4);
  const height    = payload.readUInt32LE(8);
  const timestamp = payload.readDoubleLE(12);
  const cb = pending.get(id);
  if (!cb) return;
  pending.delete(id);
  try {
    if (cb.raw) {
      cb.resolve({ width, height, timestamp, pixels: payload.subarray(20).toString('base64') });
      return;
    }
    if (!cb.processed && lastFrame && lastFrame.timestamp === timestamp && lastFrame.width === width && lastFrame.height === height) {
      cb.resolve({ ok: true, width, height, timestamp, dataUrl: lastFrame.dataUrl });
      return;
    }
    const pixels = payload.subarray(20);
    const img = nativeImage.createFromBuffer(pixels, { width, height });
    const jpeg = img.toJPEG(BUFFER_JPEG_QUALITY);
    const dataUrl = 'data:image/jpeg;base64,' + jpeg.toString('base64');
    if (!cb.processed) {
      lastFrame = { timestamp, width, height, dataUrl };
      recentRaw.set(timestamp, { width, height, pixels: Buffer.from(pixels) });
      while (recentRaw.size > EXACT_KEPT) recentRaw.delete(recentRaw.keys().next().value);
    }
    const buffered = timestamp < lastBuffered || timestamp - lastBuffered >= BUFFER_GAP_MS;
    if (buffered) lastBuffered = timestamp;
    cb.resolve({ ok: true, width, height, timestamp, dataUrl, jpeg: buffered ? jpeg : undefined });
  } catch (e) {
    cb.reject(e);
  }
}

function onPacket(json) {
  let msg;
  try { msg = JSON.parse(json); } catch { return; }
  if (msg.event) {
    if (msg.event === 'observations') play.onObservations(msg.result);
    if (msg.event === 'observations') collection.onObservations(msg.result);
    if (msg.event === 'capture-error') collection.stop(null, msg.result?.message ?? 'Capture stopped');
    win?.webContents.send('runtime:event', { event: msg.event, result: msg.result });
    return;
  }
  const cb = pending.get(msg.id);
  if (!cb) return;
  pending.delete(msg.id);
  // A frame the live view already has (see runtimeInvoke)
  if (msg.ok && msg.unchanged && lastFrame?.timestamp === msg.timestamp) {
    cb.resolve({ ok: true, width: lastFrame.width, height: lastFrame.height, timestamp: lastFrame.timestamp, dataUrl: lastFrame.dataUrl });
    return;
  }
  if (msg.ok) cb.resolve(msg);
  else cb.reject(new Error(msg.error?.message ?? 'Runtime error'));
}

function runtimeInvoke(op, params) {
  play?.beforeRuntime(op, params);
  if (op === 'start' || op === 'stop') collection?.stop(null, 'Capture session changed');
  return new Promise((resolve, reject) => {
    if (!runtime) return reject(new Error('Runtime not running'));
    const id = nextId++;
    const processed = op === 'frame' && params?.processed === true;
    pending.set(id, { resolve, reject, processed, raw: params?.raw === true });
    // The raw frame the live view has: the runtime answers `unchanged` rather than sending it again
    const since = op === 'frame' && !processed && !params?.raw && params?.timestamp === undefined && lastFrame ? { since: lastFrame.timestamp } : {};
    runtime.stdin.write(JSON.stringify({ v: 1, id, op, ...params, ...since }) + '\n');
  });
}


// --- Policies: the behaviour-cloning worker (worker/worker.py) and the input guard (firefly-input) ---
// Both start only when first needed. The worker trains, lists and runs policies; the guard presses the
// predicted buttons in the captured window, and stops (releasing everything) the moment the player
// touches the keyboard or mouse, the window loses focus, or an observation is too old to act on.

const WORKER_SCRIPT = () => path.join(_resRoot(), 'worker', 'worker.py');
const GUARD_EXE = path.join(NATIVE_DIR, 'firefly-input.exe');

function lineProcess(exe, args, options, onEvent, onExit) {
  const proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const pendingCalls = new Map();
  let next = 1, text = '';
  proc.stdin.on('error', () => {});
  proc.stderr.on('data', d => console.error(String(d)));
  proc.stdout.on('data', chunk => {
    text += chunk.toString('utf8');
    let end;
    while ((end = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, end); text = text.slice(end + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.id) { onEvent(msg); continue; }
      const call = pendingCalls.get(msg.id); pendingCalls.delete(msg.id);
      if (msg.ok) call?.resolve(msg.result); else call?.reject(new Error(msg.error?.message ?? msg.error ?? 'Worker error'));
    }
  });
  proc.on('exit', () => {
    for (const call of pendingCalls.values()) call.reject(new Error('Worker exited'));
    pendingCalls.clear();
    onExit();
  });
  proc.on('error', error => {
    for (const call of pendingCalls.values()) call.reject(error);
    pendingCalls.clear();
    onExit();
  });
  return {
    proc,
    invoke(op, params = {}) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pendingCalls.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ v: 1, id, op, ...params }) + '\n');
      });
    },
  };
}

let policyWorker = null;
function policyInvoke(op, params) {
  if (!policyWorker) {
    if (!fs.existsSync(PYTHON_EXE())) return Promise.reject(new Error('Python not found — run npm run python:setup (dev) or npm run python:bundle first'));
    policyWorker = lineProcess(PYTHON_EXE(), ['-u', WORKER_SCRIPT(), '--root', DATA_DIR],
      { cwd: path.join(_resRoot(), 'worker'), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      msg => win?.webContents.send('policy:event', { event: msg.event, result: msg.result }),
      () => { policyWorker = null; play.stop('The policy worker exited'); });
  }
  return policyWorker.invoke(op, params);
}

// The guard replies in the runtime's packets: u32 length, a kind byte, then JSON
let guard = null;
function guardInvoke(op, params = {}) {
  if (!guard) {
    if (!fs.existsSync(GUARD_EXE)) return Promise.reject(new Error('firefly-input.exe not found — run npm run native:build'));
    const proc = spawn(GUARD_EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    const pendingCalls = new Map();
    let buf = Buffer.alloc(0), next = 1;
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const total = buf.readUInt32LE(0);
        if (buf.length < 4 + total) break;
        let msg; try { msg = JSON.parse(buf.slice(5, 4 + total).toString('utf8').replace(/\0$/, '')); } catch { msg = null; }
        buf = buf.slice(4 + total);
        if (!msg) continue;
        if (msg.event === 'guard-stopped') { play.guardStopped(msg.result?.reason ?? 'The input guard stopped'); continue; }
        const call = pendingCalls.get(msg.id); pendingCalls.delete(msg.id);
        if (msg.ok) call?.resolve(msg); else call?.reject(new Error(msg.error?.message ?? 'Input rejected'));
      }
    });
    proc.on('exit', () => {
      for (const call of pendingCalls.values()) call.reject(new Error('Input guard exited'));
      guard = null;
      play.stop('The input guard exited');
    });
    guard = {
      proc,
      invoke(op2, params2) {
        return new Promise((resolve, reject) => {
          const id = next++;
          pendingCalls.set(id, { resolve, reject });
          proc.stdin.write(JSON.stringify({ v: 1, id, op: op2, ...params2 }) + '\n');
        });
      },
    };
  }
  return guard.invoke(op, params);
}

// Playing a policy, with the player's corrections (see play.cjs)
let playingGraphId = null;
const play = createPlay({
  runtime: runtimeInvoke, guard: guardInvoke, worker: policyInvoke,
  stopGuard: () => { guard?.invoke('stop').catch(() => {}); },
  send: (channel, value) => win?.webContents.send(channel, { ...value, graphId: playingGraphId }),
  // The runtime's capture times are QueryPerformanceCounter milliseconds, as libuv's hrtime is
  clock: () => Number(process.hrtime.bigint()) / 1e6,
});

let collectionWorker = null;
function collectionInvoke(op, params) {
  if (!collectionWorker) {
    if (!fs.existsSync(PYTHON_EXE())) return Promise.reject(new Error('Python not found — run npm run python:setup'));
    collectionWorker = lineProcess(PYTHON_EXE(), ['-u', path.join(_resRoot(), 'worker', 'collection.py')],
      // Table nodes keep what they've saved here, per game, across sessions
      { cwd: path.join(_resRoot(), 'worker'), windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', FIREFLY_TABLES: path.join(DATA_DIR, 'tables.sqlite') } },
      () => {}, () => { collectionWorker = null; collection.stop(null, 'The collection worker exited'); });
  }
  return collectionWorker.invoke(op, params);
}
const collection = createCollection({ worker: collectionInvoke, runtime: runtimeInvoke, send: (channel, value) => win?.webContents.send(channel, value) });
ipcMain.handle('collection:start', async (_e, params) => {
  try { await collection.start(params); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('collection:stop', (_e, id) => collection.stop(id));
ipcMain.handle('collection:status', () => collection.statuses());
// A Dataset Output's saved images, for the preview: the list, then one image with its labels at a time
ipcMain.handle('dataset:list', (_e, directory) => datasetPreview.listDataset(directory));
ipcMain.handle('dataset:item', (_e, directory, relative) => datasetPreview.readItem(directory, relative));
// An image and its labels to the Recycle Bin, then its table rows, so the moment it showed counts as new again
ipcMain.handle('dataset:delete', async (_e, directory, relative) => {
  const { image, files } = await datasetPreview.deleteItem(directory, relative, file => shell.trashItem(file));
  let rows = 0, rowsError = '';
  try { rows = (await collectionInvoke('table.forget_image', { image })).rows; } catch (e) { rowsError = e.message; }
  return { files: files.length, rows, rowsError };
});
// A Table node's rows: read them, or delete one (key) or all of them
ipcMain.handle('collection:table', (_e, op, params) => {
  if (op !== 'rows' && op !== 'delete') return Promise.reject(new Error('Unknown table operation'));
  return collectionInvoke('table.' + op, params);
});

ipcMain.handle('policy:invoke', (_e, op, params) => policyInvoke(op, params ?? {}));
ipcMain.handle('play:start', async (_e, params) => {
  playingGraphId = params.graphId ?? null;
  try { await play.start(params); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('play:stop', () => { play.stop('Stopped'); });
// Writes chosen recordings as a dataset for any trainer, to a file the player picks (see Worker.export)
ipcMain.handle('policy:export', async (_e, params) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export dataset', defaultPath: 'firefly-dataset.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'NumPy', extensions: ['npz'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try { return { ok: true, ...(await policyInvoke('export', { ...params, path: filePath })) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('policy:reveal', (_e, file) => { if (typeof file === 'string') shell.showItemInFolder(file); });

// --- Electron app ---

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#171717',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.on('unresponsive', () => logCrash('The window stopped responding'));
  win.on('responsive', () => logCrash('The window responds again'));
  win.maximize();
  win.show();

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => { win = null; });

  spawnRuntime();
});

app.on('window-all-closed', () => {
  collection.stop(null, 'Closing');
  collectionWorker?.invoke('shutdown').catch(() => {});
  play.stop('Closing');
  policyWorker?.invoke('shutdown').catch(() => {});
  guard?.invoke('shutdown').catch(() => {});
  if (runtime) {
    runtimeInvoke('shutdown', {}).catch(() => {});
    setTimeout(() => runtime?.kill(), 1500);
  }
  app.quit();
});

ipcMain.handle('runtime:invoke',  (_e, op, params) => runtimeInvoke(op, params ?? {}));
ipcMain.handle('runtime:available', () => fs.existsSync(RUNTIME_EXE));
ipcMain.handle('runtime:status',    () => ({ ready: runtimeReady, error: runtimeError }));

// --- Training process ---

let trainProc = null;
let currentTrainOutDir = null;

ipcMain.handle('bridge:pick-file', async (_e, filters) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: filters ?? [{ name: 'ONNX Model', extensions: ['onnx'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('training:pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select Dataset Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('training:start', (_e, params) => {
  if (trainProc) return { ok: false, error: 'Training already running' };
  if (!fs.existsSync(PYTHON_EXE())) return { ok: false, error: 'Python not found — run npm run python:setup (dev) or npm run python:bundle first' };

  const { dataDir, outDir, epochs, batch, base, resume, device, workers, decodeOnce } = params;
  const yolo = params.kind === 'yolo';
  const exportOnnx = yolo || params.exportOnnx; // a YOLO training always exports its best weights (train_yolo.py)
  const { width, height } = modelSize(params);
  currentTrainOutDir = path.resolve(outDir);
  const runOutDir = currentTrainOutDir;
  const onnxPath = path.join(currentTrainOutDir, 'best.onnx'); // where either script exports to
  const workerCount = String(Number.isInteger(workers) && workers >= 0 && workers <= 32 ? workers : 0);
  const args = yolo ? [
    '-u', TRAIN_YOLO_SCRIPT(),
    '--data', dataDir,
    '--out', outDir,
    '--model', YOLO_MODELS.includes(params.model) ? params.model : 'yolo11n',
    '--weights-dir', YOLO_DIR,
    '--epochs', String(epochs),
    '--batch', String(batch),
    '--imgsz', String(Number.isInteger(params.imgsz) && params.imgsz >= 64 && params.imgsz <= 2048 ? params.imgsz : 800),
    '--workers', workerCount,
    '--device', String(device ?? 'auto'),
    ...(resume ? ['--resume'] : []),
  ] : [
    '-u', TRAIN_SCRIPT(),
    '--data', dataDir,
    '--out', outDir,
    '--epochs', String(epochs),
    '--batch', String(batch),
    '--width', String(width), '--height', String(height),
    '--base', String(base),
    '--workers', String(Number.isInteger(workers) && workers >= 0 && workers <= 32 ? workers : 0),
    '--device', String(device ?? 'auto'),
  ];
  if (!yolo) {
    if (exportOnnx) args.push('--export-onnx');
    if (resume) args.push('--resume');
    if (decodeOnce) args.push('--cache');
  }

  trainProc = spawn(PYTHON_EXE(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: pythonEnv() });

  let buf = '';
  trainProc.stdout.setEncoding('utf8');
  trainProc.stdout.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      // A progress bar redraws its line with carriage returns and colours it: keep what's last drawn, plainly
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\r').filter(part => part.trim()).pop() ?? '';
      if (!line.trim()) continue;
      if (line.startsWith('BATCH:')) {
        try { win?.webContents.send('training:batch', JSON.parse(line.slice(6))); } catch {}
      } else if (line.startsWith('PROGRESS:')) {
        try { win?.webContents.send('training:progress', JSON.parse(line.slice(9))); } catch {}
        win?.webContents.send('training:log', line);
      } else {
        win?.webContents.send('training:log', line);
      }
    }
  });

  trainProc.stderr.setEncoding('utf8');
  trainProc.stderr.on('data', chunk => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) win?.webContents.send('training:log', line);
    }
  });

  const proc = trainProc;
  proc.on('exit', async (code, signal) => {
    // Images decoded once are for that training only: the script deletes them as it finishes, but a
    // training stopped here is ended before it can (and its folder is this run's, not currentTrainOutDir,
    // which Stop has already cleared)
    removeDecoded(runOutDir);
    if (trainProc !== proc && trainProc) return; // stopped, and a new training already runs: this one's done
    trainProc = null;
    if (currentTrainOutDir) {
      try { fs.unlinkSync(path.join(currentTrainOutDir, 'pause.flag')); } catch {}
    }
    currentTrainOutDir = null;
    const added = code === 0 && exportOnnx && fs.existsSync(onnxPath)
      ? await addTrainedModel(onnxPath, dataDir) : {};
    const best = path.join(runOutDir, 'weights', 'best.pt');
    win?.webContents.send('training:done', { code, signal, outDir, kind: yolo ? 'yolo' : 'unet', ...added, ...(yolo && fs.existsSync(best) ? { best } : {}) });
  });

  return { ok: true };
});

// A training's decoded images, deleted once whatever held them open has let go (its loader workers can
// outlive it by a moment)
function removeDecoded(outDir, tries = 40) {
  const dir = path.join(outDir, '.decoded');
  if (!fs.existsSync(dir)) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch { if (tries > 0) setTimeout(() => removeDecoded(outDir, tries - 1), 250); }
}

ipcMain.handle('training:stop', () => {
  // The whole tree: ended alone, the trainer leaves its loader workers running (Windows doesn't end a
  // process's children with it), and they hold the decoded images open
  if (trainProc) {
    const pid = trainProc.pid;
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { trainProc.kill(); }
    trainProc = null;
  }
  if (currentTrainOutDir) {
    try { fs.unlinkSync(path.join(currentTrainOutDir, 'pause.flag')); } catch {}
    currentTrainOutDir = null;
  }
});

ipcMain.handle('training:pause', () => {
  if (!currentTrainOutDir) return { ok: false };
  try { fs.writeFileSync(path.join(currentTrainOutDir, 'pause.flag'), ''); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('training:unpause', () => {
  if (!currentTrainOutDir) return { ok: false };
  try { fs.unlinkSync(path.join(currentTrainOutDir, 'pause.flag')); } catch {}
  return { ok: true };
});

// The model's input: width x height, or an older one-number square (imgSize)
function modelSize(p) {
  const ok = n => Number.isInteger(n) && n >= 64 && n <= 2048;
  const square = ok(p?.imgSize) ? p.imgSize : 256;
  return { width: ok(p?.width) ? p.width : square, height: ok(p?.height) ? p.height : square };
}

// A finished training's best weights to ONNX, added to Trained Models: a UNet's at its width x height, a YOLO
// detector's (size {kind: 'yolo'}) at the size it trained at
ipcMain.handle('training:export-onnx', (_e, outDir, size, dataDir) => {
  const { width, height } = modelSize(typeof size === 'number' ? { imgSize: size } : size);
  if (!fs.existsSync(PYTHON_EXE())) return { ok: false, error: 'Python not found' };
  const args = size?.kind === 'yolo'
    ? ['-u', TRAIN_YOLO_SCRIPT(), '--out', outDir, '--weights-dir', YOLO_DIR, '--export-only']
    : ['-u', TRAIN_SCRIPT(), '--out', outDir, '--width', String(width), '--height', String(height),
       '--data', outDir, // unused in export-only mode but required by argparse
       '--export-only'];
  return new Promise(resolve => {
    const proc = spawn(PYTHON_EXE(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; win?.webContents.send('training:log', d.trim()); });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { err += d; });
    proc.on('exit', async code => {
      const match = out.match(/EXPORT_OK:(.+)/);
      if (!match) return resolve({ ok: false, error: err.split('\n').filter(Boolean).pop() ?? `exit ${code}` });
      const onnxPath = match[1].trim();
      resolve({ ok: true, path: onnxPath, ...(await addTrainedModel(onnxPath, dataDir)) });
    });
  });
});

// Adds a finished export to the trained model library. A failure is reported
// alongside the training result instead of failing it.
async function addTrainedModel(onnxPath, dataDir) {
  try {
    const { model, existing } = await models.importModel(MODELS_DIR, onnxPath, { dataDir, trained: true });
    return { model, existing };
  } catch (e) {
    return { modelError: e.message };
  }
}

// A training to resume: its last epoch and score (a UNet's last.pt beside its history, YOLO's under weights/)
ipcMain.handle('training:check-checkpoint', (_e, outDir, kind) => {
  const resolved  = path.resolve(outDir);
  const histPath  = path.join(resolved, 'history.json');
  const lastPt    = kind === 'yolo' ? path.join(resolved, 'weights', 'last.pt') : path.join(resolved, 'last.pt');
  if (!fs.existsSync(histPath) || !fs.existsSync(lastPt)) return { found: false };
  try {
    const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    if (!hist.length) return { found: false };
    const last = hist[hist.length - 1];
    if ((last.kind === 'yolo') !== (kind === 'yolo')) return { found: false }; // the other model's training
    return { found: true, epoch: last.epoch, totalEpochs: last.totalEpochs, valIou: last.valIou, map50: last.map50,
      best: kind === 'yolo' && fs.existsSync(path.join(resolved, 'weights', 'best.pt')) ? path.join(resolved, 'weights', 'best.pt') : undefined };
  } catch { return { found: false }; }
});

// Whether training can run on the card: what nvidia-smi says about it and its driver, the CUDA build that
// suits them (or why there's none), the downloaded build if any, and whether PyTorch as training loads it can
// really calculate on the card. Training runs on the CPU otherwise.
ipcMain.handle('training:gpu-check', async () => {
  const smi = await gpu.readSmi();
  const plan = gpu.planFor(smi);
  const cuda = gpu.installed(GPU_DIR);
  const test = fs.existsSync(PYTHON_EXE()) ? await gpu.testTorch(PYTHON_EXE(), pythonEnv()) : { available: false, error: 'Python not found' };
  return {
    available: !!test.available, name: test.name ?? null, error: test.available ? null : test.error ?? null, torch: test.torch ?? null, vision: test.vision ?? null,
    ...smi, plan, packaged: app.isPackaged, installed: cuda ? { variant: cuda.variant, name: cuda.name ?? null } : null,
    wheel: plan.variant ?? null,
  };
});

// Downloads and tests the CUDA build for the card, into GPU_DIR (the installed app only: a development
// setup installs it into its .venv with pip, as the Train tab says). One at a time; progress as
// training:gpu-progress events.
let gpuInstall = null;
ipcMain.handle('training:gpu-install', async () => {
  if (!app.isPackaged) return { ok: false, error: 'In a development setup, install the CUDA build into .venv with the command the Train tab shows' };
  if (gpuInstall) return { ok: false, error: 'Already downloading' };
  const plan = gpu.planFor(await gpu.readSmi());
  if (!plan.variant) return { ok: false, error: 'There is no CUDA build of PyTorch for this card and driver' };
  try {
    const { bavail, bsize } = await fs.promises.statfs(app.getPath('userData'));
    if (bavail * bsize < 6 * 2 ** 30) return { ok: false, error: `It needs about 6 GB free on the drive FireFly keeps its data on, while it downloads (${(bavail * bsize / 2 ** 30).toFixed(1)} GB free)` };
  } catch { /* the download says so if it runs out */ }
  // The CUDA build of the same versions as the bundled ones, so everything else that needs them still fits
  const versions = await new Promise(resolve => {
    let out = '';
    const p = spawn(PYTHON_EXE(), ['-c', 'import torch, torchvision; print(torch.__version__, torchvision.__version__)'], { stdio: ['ignore', 'pipe', 'ignore'], env: pythonEnv({ withGpu: false }) });
    p.stdout.on('data', d => { out += d; });
    p.on('exit', () => resolve(out.trim().split(/\s+/)));
  });
  if (versions.length < 2) return { ok: false, error: 'Could not read the bundled PyTorch version' };
  const send = progress => win?.webContents.send('training:gpu-progress', { variant: plan.variant, ...progress });
  gpuInstall = gpu.install({ root: GPU_DIR, pythonExe: PYTHON_EXE(), env: pythonEnv({ withGpu: false }), variant: plan.variant,
    torchVersion: versions[0], visionVersion: versions[1], onProgress: send });
  send({ phase: 'download', done: 0, total: 0 });
  const result = await gpuInstall.done;
  gpuInstall = null;
  return result.ok ? { ok: true, variant: plan.variant, name: result.test?.name ?? null } : { ok: false, error: result.error };
});
ipcMain.handle('training:gpu-cancel', () => { gpuInstall?.cancel(); });
// Back to the bundled CPU build: deletes the download
ipcMain.handle('training:gpu-remove', () => {
  if (gpuInstall) return { ok: false, error: 'Wait for the download to finish, or cancel it' };
  if (trainProc) return { ok: false, error: 'Stop training first' };
  try { gpu.remove(GPU_DIR); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('training:check-dataset', (_e, dataDir, kind) => {
  if (!fs.existsSync(PYTHON_EXE())) return { ok: false, error: 'Python venv not found' };
  const tempGrid = path.join(app.getPath('temp'), 'firefly_dataset_check.png');
  try { fs.unlinkSync(tempGrid); } catch {} // the last check's grid isn't this one's
  return new Promise(resolve => {
    const proc = spawn(PYTHON_EXE(), ['-u', kind === 'yolo' ? CHECK_YOLO_SCRIPT() : CHECK_SCRIPT(), '--data', dataDir, '--out', tempGrid],
                       { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let checkResult = null;
    let outBuf = '';
    let errBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      outBuf += chunk;
      const lines = outBuf.split('\n');
      outBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('CHECK_RESULT:')) {
          try { checkResult = JSON.parse(line.slice(13)); } catch {}
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => { errBuf += chunk; });
    proc.on('exit', code => {
      if (!checkResult) {
        const msg = errBuf.trim() || `Check script exited with code ${code}`;
        resolve({ ok: false, error: msg.split('\n').pop() }); // last line is usually the actual error
        return;
      }
      let gridDataUrl = null;
      try {
        const raw = fs.readFileSync(tempGrid);
        gridDataUrl = 'data:image/png;base64,' + raw.toString('base64');
      } catch {}
      resolve({ ok: true, result: checkResult, gridDataUrl });
    });
  });
});

// --- Trained model library ---

ipcMain.handle('models:list', () => models.listModels(MODELS_DIR));

ipcMain.handle('models:import', async (_e, src, hints) => {
  try { return { ok: true, ...(await models.importModel(MODELS_DIR, src, hints ?? {})) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('models:update', (_e, id, patch) => {
  try { return { ok: true, model: models.updateModel(MODELS_DIR, id, patch ?? {}) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('models:delete', (_e, id) => {
  try { models.removeModel(MODELS_DIR, id); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('models:reveal', (_e, id) => {
  try { shell.showItemInFolder(models.modelPath(MODELS_DIR, id)); } catch {}
});

// A best.onnx left in a training output folder, e.g. from before the library existed
ipcMain.handle('models:probe', (_e, outDir) => {
  const onnxPath = path.resolve(outDir, 'best.onnx');
  return fs.existsSync(onnxPath) ? onnxPath : null;
});

// A recent raw frame as a lossless PNG, by its capture time (see onFrame), or null once it's gone
ipcMain.handle('frame:exact', (_e, timestamp) => {
  const frame = recentRaw.get(timestamp);
  return frame ? nativeImage.createFromBuffer(frame.pixels, { width: frame.width, height: frame.height }).toDataURL() : null;
});

ipcMain.handle('windows:thumbnails', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 640, height: 360 },
  });
  const map = {};
  for (const s of sources) {
    if (s.name && !map[s.name]) {
      const png = s.thumbnail.toPNG();
      if (png.length > 0)
        map[s.name] = 'data:image/png;base64,' + png.toString('base64');
    }
  }
  return map;
});
