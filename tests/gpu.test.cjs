// Which CUDA build of PyTorch suits a card and driver (electron/gpu.cjs), and the download's record.
// node --test tests/gpu.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const gpu = require('../electron/gpu.cjs');

test('the newest build the driver supports and the card runs', () => {
  assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '13.2', computeCap: '8.6' }).variant, 'cu132');
  assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '13.1', computeCap: '8.6' }).variant, 'cu130');
  assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '12.8', computeCap: '7.5' }).variant, 'cu126');
});

test('cards before Turing get the CUDA 12.6 build, which still runs them', () => {
  for (const cap of ['5.0', '6.1', '7.0'])
    assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '13.2', computeCap: cap }).variant, 'cu126', cap);
});

test('no build: no NVIDIA driver, a card too old, or a driver too old', () => {
  assert.deepEqual(gpu.planFor({ nvidiaSmiOk: false }), { reason: 'no-driver' });
  assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '11.4', computeCap: '3.0' }).reason, 'card');
  const old = gpu.planFor({ nvidiaSmiOk: true, driverCuda: '12.2', computeCap: '6.1' });
  assert.equal(old.reason, 'driver'); assert.equal(old.need, '12.6'); assert.equal(old.driverVersion, 560);
});

test('an nvidia-smi too old to tell the card goes by the driver alone', () => {
  assert.equal(gpu.planFor({ nvidiaSmiOk: true, driverCuda: '13.2', computeCap: null }).variant, 'cu132');
});

test('versions compare as versions', () => {
  assert.ok(gpu.atLeast('12.10', '12.6'));
  assert.ok(!gpu.atLeast('12.5', '12.6'));
  assert.ok(gpu.atLeast('13.0', '12.6'));
});

test('the download in use is the one its record names, while its folder is there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-'));
  try {
    assert.equal(gpu.installed(root), null);
    const dir = path.join(root, 'cu126-1');
    fs.mkdirSync(path.join(dir, 'torch'), { recursive: true });
    fs.writeFileSync(path.join(root, 'installed.json'), JSON.stringify({ variant: 'cu126', dir }));
    assert.equal(gpu.installed(root).variant, 'cu126');
    gpu.remove(root);
    assert.equal(gpu.installed(root), null);
    assert.ok(!fs.existsSync(dir), 'the download was deleted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
