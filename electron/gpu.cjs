// GPU training for the installed app. Its bundled Python has the CPU build of PyTorch (the CUDA builds are
// gigabytes), so FireFly downloads the CUDA build that suits the card and driver when asked: into
// <userData>/gpu/<build>, never into the app, so a failed or cancelled download can't break the bundled
// Python, and an app update doesn't throw it away. Python loads it first when FIREFLY_GPU_TORCH names that
// folder (worker/sitecustomize.py). Nothing is used before a real calculation on the card has worked.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// PyTorch's Windows CUDA builds of the version FireFly pins (2.14), newest first, each with the least CUDA
// version the driver must support and the oldest card (compute capability) it runs on: CUDA 13 dropped every
// card before Turing (7.5), such as the GTX 10 series, which the CUDA 12.6 build still runs.
const BUILDS = [
  { variant: 'cu132', cuda: '13.2', minCapability: 7.5 },
  { variant: 'cu130', cuda: '13.0', minCapability: 7.5 },
  { variant: 'cu126', cuda: '12.6', minCapability: 5.0 },
];
const OLDEST_DRIVER = '12.6';      // the least any build needs
const DRIVER_FOR_OLDEST = 560;     // the NVIDIA driver version that supports it
const ABOUT_GB = 2.5;              // roughly what a CUDA build of PyTorch downloads

// "12.10" against "12.6", as versions rather than numbers
const atLeast = (version, least) => {
  const [a, b] = String(version).split('.').map(Number), [c, d] = String(least).split('.').map(Number);
  return a > c || (a === c && (b || 0) >= (d || 0));
};

// The build to install for a card and driver, or why there's none: 'no-driver' (nvidia-smi didn't answer),
// 'card' (too old for any build) or 'driver' (too old for the build the card needs)
function planFor({ nvidiaSmiOk, driverCuda, computeCap }) {
  if (!nvidiaSmiOk || !driverCuda) return { reason: 'no-driver' };
  const capability = computeCap != null && Number.isFinite(Number(computeCap)) ? Number(computeCap) : null;
  if (capability !== null && capability < 5.0) return { reason: 'card', capability };
  const suited = BUILDS.filter(b => capability === null || capability >= b.minCapability);
  const build = suited.find(b => atLeast(driverCuda, b.cuda));
  if (build) return { variant: build.variant, cuda: build.cuda, aboutGb: ABOUT_GB };
  return { reason: 'driver', need: suited[suited.length - 1]?.cuda ?? OLDEST_DRIVER, driverVersion: DRIVER_FOR_OLDEST };
}

const run = (cmd, args, options = {}) => new Promise(resolve => {
  let out = '';
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...options });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => { out += d; });
  proc.on('error', () => resolve({ code: -1, out }));
  proc.on('exit', code => resolve({ code, out }));
});

// What nvidia-smi says: the card, its compute capability (older drivers don't know that field) and the CUDA
// version the driver supports (only in its plain report's header)
async function readSmi() {
  const plain = await run('nvidia-smi', []);
  if (plain.code !== 0) return { nvidiaSmiOk: false };
  const driverCuda = plain.out.match(/CUDA Version:\s*([\d.]+)/)?.[1] ?? null;
  let query = await run('nvidia-smi', ['--query-gpu=name,compute_cap,driver_version', '--format=csv,noheader']);
  let [name, computeCap, driverVersion] = query.code === 0 ? query.out.split('\n')[0].split(',').map(s => s.trim()) : [];
  if (query.code !== 0) {
    query = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
    [name, driverVersion] = query.code === 0 ? query.out.split('\n')[0].split(',').map(s => s.trim()) : [];
    computeCap = null;
  }
  return { nvidiaSmiOk: true, driverCuda, gpuName: name || null, computeCap: computeCap || null, driverVersion: driverVersion || null };
}

// Whether PyTorch, as Python loads it (with the downloaded build when env names one), can calculate on the
// card: a real sum, since a build without the card's architecture says CUDA is available and then fails
const TORCH_TEST = [
  'import json',
  "r = {'available': False}",
  'try:',
  '    import torch',
  "    r['torch'] = torch.__version__; r['cuda'] = torch.version.cuda",
  '    import torchvision',
  "    r['vision'] = torchvision.__version__",
  '    if torch.cuda.is_available():',
  "        r['name'] = torch.cuda.get_device_name(0)",
  '        x = torch.ones(64, device="cuda")',
  "        r['available'] = float((x * 2).sum()) == 128.0",
  'except Exception as e:',
  "    r['error'] = (str(e).strip().splitlines() or [type(e).__name__])[0][:300]",
  "print('GPU:' + json.dumps(r))",
].join('\n');
async function testTorch(pythonExe, env) {
  const { out } = await run(pythonExe, ['-c', TORCH_TEST], { env });
  const line = out.split('\n').find(l => l.startsWith('GPU:'));
  try { return line ? JSON.parse(line.slice(4)) : { available: false, error: 'Python gave no answer' }; }
  catch { return { available: false, error: 'Python gave no answer' }; }
}

// The downloaded build in use, if any: <root>/installed.json names its folder
function installed(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'installed.json'), 'utf8'));
    return manifest?.dir && fs.existsSync(path.join(manifest.dir, 'torch')) ? manifest : null;
  } catch { return null; }
}

// Downloads a build into a fresh folder beside the old one, tests it, and only then makes it the one in use.
// onProgress gets {phase, done, total}; cancel() stops it and leaves nothing behind.
function install({ root, pythonExe, env, variant, torchVersion, visionVersion, onProgress }) {
  const index = `https://download.pytorch.org/whl/${variant}`;
  const target = path.join(root, `${variant}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const base = v => String(v).split('+')[0];
  // Only torch and torchvision: everything else they need is already in the bundled Python
  const args = ['-m', 'pip', 'install', '--no-deps', '--no-cache-dir', '--disable-pip-version-check', '--progress-bar', 'raw',
    '--target', target, '--index-url', index, `torch==${base(torchVersion)}+${variant}`, `torchvision==${base(visionVersion)}+${variant}`];
  let proc = null, cancelled = false, log = '';
  const done = new Promise(resolve => {
    proc = spawn(pythonExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    const take = d => {
      log = (log + d).slice(-4000);
      // pip's raw progress: "Progress 123 of 456" bytes, for the file it's downloading
      for (const m of String(d).matchAll(/Progress (\d+) of (\d+)/g)) onProgress?.({ phase: 'download', done: Number(m[1]), total: Number(m[2]) });
      if (/Installing collected packages/.test(d)) onProgress?.({ phase: 'install' });
    };
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', take); proc.stderr.on('data', take);
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('exit', code => resolve(code === 0 ? { ok: true } : { ok: false, error: cancelled ? 'Cancelled' : lastLine(log) || `pip ended with ${code}` }));
  }).then(async result => {
    if (!result.ok) { fs.rmSync(target, { recursive: true, force: true }); return result; }
    onProgress?.({ phase: 'test' });
    const test = await testTorch(pythonExe, { ...env, FIREFLY_GPU_TORCH: target });
    if (!test.available) {
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: false, error: `It downloaded, but couldn't calculate on your card${test.error ? `: ${test.error}` : ''}` };
    }
    const previous = installed(root);
    fs.writeFileSync(path.join(root, 'installed.json'), JSON.stringify({ variant, dir: target, torch: test.torch, cuda: test.cuda, name: test.name, at: new Date().toISOString() }, null, 2));
    if (previous && previous.dir !== target) fs.rmSync(previous.dir, { recursive: true, force: true });
    return { ok: true, test };
  });
  return {
    done,
    cancel() {
      cancelled = true;
      // pip's own children too (Windows doesn't end them with it)
      if (proc?.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    },
  };
}
const lastLine = text => text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^Progress \d+ of \d+/.test(l)).pop() ?? '';

// Takes the downloaded build away: Python goes back to the bundled CPU one
function remove(root) {
  const current = installed(root);
  if (current) fs.rmSync(current.dir, { recursive: true, force: true });
  fs.rmSync(path.join(root, 'installed.json'), { force: true });
}

module.exports = { BUILDS, planFor, readSmi, testTorch, installed, install, remove, atLeast, ABOUT_GB };
