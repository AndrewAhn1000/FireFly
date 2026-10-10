// A window's setup as a file to share (Export… / Import… in the Inspector's Capture Target): the renderer's
// entries (src/windowSetup.ts: its States and Regions, Graphs and recording setup, keyed by {window}) and the
// trained models chosen, each with its .onnx. Nothing in it is a path on the PC it came from: a model's
// source path and dataset folder are left out (the renderer clears Dataset Output folders), and so is the
// device it ran on, which another PC may not have.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const models = require('./models.cjs');

const FORMAT = 'firefly-setup';
const VERSION = 1;
const MAX_BYTES = 1.5 * 2 ** 30; // what's read back: a few models at most

// What a model's info keeps in a file: what it is, its outputs and how it was scored
function modelMeta(m) {
  const { dataDir, ...training } = m.training ?? {};
  return {
    name: m.name, kind: m.kind ?? 'segmentation', classes: m.classes, input: m.input ?? null, threshold: m.threshold, flow: m.flow ?? null,
    source: { kind: m.source?.kind === 'trained' ? 'trained' : 'imported' }, training: m.training ? { ...training, dataDir: null } : null,
  };
}

// Writes the file: entries and parts as the renderer made them, and the chosen models from the library
function writeSetupFile(filePath, { title, entries, parts, cleared, modelIds = [], modelsDir, appVersion }) {
  const library = models.listModels(modelsDir);
  const bundled = modelIds.map(id => {
    const m = library.find(x => x.id === id);
    if (!m || m.missing) throw new Error('A chosen model is no longer in the library');
    const bytes = fs.readFileSync(m.path);
    return { meta: modelMeta(m), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, onnx: bytes.toString('base64') };
  });
  const file = { format: FORMAT, version: VERSION, app: appVersion, exportedAt: new Date().toISOString(), window: title, parts, cleared, entries, models: bundled };
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(file));
  fs.renameSync(temporary, filePath);
  return { size: fs.statSync(filePath).size, models: bundled.length };
}

// Reads and checks a file; what it holds, without the models' bytes, for the renderer to show
function readSetupFile(filePath) {
  if (fs.statSync(filePath).size > MAX_BYTES) throw new Error('That file is too big to be a FireFly setup');
  let file;
  try { file = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { throw new Error('That isn’t a FireFly setup file'); }
  if (file?.format !== FORMAT) throw new Error('That isn’t a FireFly setup file');
  if (file.version > VERSION) throw new Error('That setup was saved by a newer FireFly: update FireFly to import it');
  if (!file.entries || typeof file.entries !== 'object') throw new Error('That setup file is damaged');
  const entries = Object.fromEntries(Object.entries(file.entries).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'));
  const bundled = (Array.isArray(file.models) ? file.models : []).filter(m => m?.meta && typeof m.onnx === 'string');
  return {
    file: { ...file, entries, models: bundled },
    summary: { window: String(file.window ?? ''), exportedAt: file.exportedAt ?? null, app: file.app ?? null, entries, parts: Array.isArray(file.parts) ? file.parts : [],
      models: bundled.map((m, index) => ({ index, name: String(m.meta.name ?? 'Model'), kind: m.meta.kind === 'detector' ? 'detector' : 'segmentation',
        classes: Array.isArray(m.meta.classes) ? m.meta.classes : undefined, size: Number(m.size) || 0 })) },
  };
}

// Adds the file's chosen models to the library: one already there (the same file) is kept as it is; a new
// one gets the name, threshold and outputs it was exported with
async function installModels(file, indexes, modelsDir) {
  const results = [];
  for (const index of indexes) {
    const m = file.models[index];
    if (!m) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-import-'));
    const name = String(m.meta.name ?? 'model').replace(/[^\w .-]+/g, '_').slice(0, 60) || 'model';
    try {
      const bytes = Buffer.from(m.onnx, 'base64');
      if (m.sha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== m.sha256) throw new Error('its file is damaged');
      const onnx = path.join(dir, `${name}.onnx`);
      fs.writeFileSync(onnx, bytes);
      const { model, existing } = await models.importModel(modelsDir, onnx, { trained: m.meta.source?.kind === 'trained' });
      if (!existing) models.updateModel(modelsDir, model.id, { name: m.meta.name, threshold: m.meta.threshold, ...(m.meta.flow ? { flow: m.meta.flow } : {}),
        ...(m.meta.training ? { training: m.meta.training } : {}) });
      results.push({ name: m.meta.name, id: model.id, existing, ok: true });
    } catch (e) {
      results.push({ name: m.meta.name, ok: false, error: e.message });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return results;
}

module.exports = { FORMAT, VERSION, modelMeta, writeSetupFile, readSetupFile, installModels };
