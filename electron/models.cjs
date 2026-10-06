'use strict';
// Trained model library. Each model lives in <root>/<id>/ as a private copy of
// its .onnx file plus a model.json holding the display name, training metrics
// and how it runs on the live capture: its mask threshold and the flow of
// outputs (src/flows.ts) that turns the mask into observations. Copying keeps
// a model intact when a later training run overwrites the same output folder.
// A model is a segmentation UNet (kind 'segmentation', a mask out) or a YOLO
// detector (kind 'detector', boxes of its classes out; its threshold is the
// least confidence a box needs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const OUTPUT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

// --- ONNX inspection ---
// Minimal protobuf walk over ModelProto → GraphProto → input/output
// ValueInfoProto: enough to check that a file matches what the native
// `segment` node feeds it ("image" [N, 3, H, W] in, "logits" out).

function varint(buf, pos) {
  let value = 0, scale = 1, byte;
  do {
    if (pos >= buf.length) throw new Error('truncated varint');
    byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, pos];
}

// Fields of the message in buf[start, end): { field, value } for varints and
// { field, start, end } for length-delimited payloads.
function fields(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    let key, len, value;
    [key, pos] = varint(buf, pos);
    const field = Math.floor(key / 8), wire = key % 8;
    if (wire === 0)      { [value, pos] = varint(buf, pos); out.push({ field, value }); }
    else if (wire === 2) { [len, pos] = varint(buf, pos); out.push({ field, start: pos, end: pos + len }); pos += len; }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  if (pos !== end) throw new Error('truncated message');
  return out;
}

const messages = (buf, msg, field) =>
  fields(buf, msg.start, msg.end).filter(f => f.field === field && f.end !== undefined);

function tensorDims(buf, typeProto) {
  const tensor = messages(buf, typeProto, 1)[0];       // TypeProto.tensor_type
  const shape  = tensor && messages(buf, tensor, 2)[0]; // Tensor.shape
  if (!shape) return null;
  return messages(buf, shape, 1).map(dim => {           // TensorShapeProto.dim
    const parts = fields(buf, dim.start, dim.end);
    const size  = parts.find(f => f.field === 1 && f.value !== undefined);
    const param = parts.find(f => f.field === 2 && f.end !== undefined);
    return size ? size.value : param ? buf.toString('utf8', param.start, param.end) : null;
  });
}

function valueInfo(buf, msg) {
  const info = { name: '', dims: null };
  for (const f of fields(buf, msg.start, msg.end)) {
    if (f.end === undefined) continue;
    if (f.field === 1) info.name = buf.toString('utf8', f.start, f.end);
    if (f.field === 2) info.dims = tensorDims(buf, f);
  }
  return info;
}

function inspectOnnx(buf) {
  const model = { start: 0, end: buf.length };
  const graph = messages(buf, model, 7)[0]; // ModelProto.graph
  if (!graph) throw new Error('no graph found');
  // ModelProto.metadata_props: key/value strings, where Ultralytics puts a detector's task and class names
  const metadata = {};
  for (const entry of messages(buf, model, 14)) {
    const parts = fields(buf, entry.start, entry.end).filter(f => f.end !== undefined);
    const text = n => { const f = parts.find(p => p.field === n); return f ? buf.toString('utf8', f.start, f.end) : ''; };
    metadata[text(1)] = text(2);
  }
  return {
    inputs:  messages(buf, graph, 11).map(m => valueInfo(buf, m)),
    outputs: messages(buf, graph, 12).map(m => valueInfo(buf, m)),
    metadata,
  };
}

// A YOLO detector's input size and class names, or null if the file isn't one: an [N, 3, H, W] image in, and a
// [1, 4 + classes, anchors] (or end-to-end [1, n, 6]) output, as the native detect step runs it
function detectorInput(info) {
  if (info.inputs.length !== 1 || info.outputs.length < 1) return null;
  const dims = info.inputs[0].dims, out = info.outputs[0].dims;
  if (!dims || dims.length !== 4 || (typeof dims[1] === 'number' && dims[1] !== 3)) return null;
  if (!out || out.length !== 3) return null;
  const task = info.metadata.task;
  const raw = typeof out[1] === 'number' && out[1] > 4 && (typeof out[2] !== 'number' || out[2] > out[1]);
  const endToEnd = out[2] === 6 && info.metadata.end2end === 'True';
  if (task !== 'detect' && !raw) return null;
  // names: "{0: 'monster', 1: 'npc'}", a Python dict as Ultralytics writes it
  const classes = [];
  for (const m of (info.metadata.names ?? '').matchAll(/(\d+)\s*:\s*(['"])((?:(?!\2).)*)\2/g)) classes[Number(m[1])] = m[3];
  const count = raw ? out[1] - 4 : classes.length;
  for (let i = 0; i < count; i++) classes[i] ??= `class ${i}`;
  if (!raw && !endToEnd && !classes.length) return null;
  const known = d => typeof d === 'number' && d > 0;
  return { input: known(dims[2]) && known(dims[3]) ? { width: dims[3], height: dims[2] } : null, classes };
}

// Returns the model's input size, or throws if the runtime could not run it.
function segmentationInput(info) {
  const input  = info.inputs.find(v => v.name === 'image');
  const output = info.outputs.find(v => v.name === 'logits');
  if (!input || !output) {
    const names = list => list.map(v => `"${v.name}"`).join(', ') || 'none';
    throw new Error(`expected an input named "image" and an output named "logits" (the format train_unet.py exports), found inputs ${names(info.inputs)} and outputs ${names(info.outputs)}`);
  }
  const dims = input.dims;
  if (dims && (dims.length !== 4 || (typeof dims[1] === 'number' && dims[1] !== 3)))
    throw new Error(`expected an [N, 3, H, W] image input, found [${dims.join(', ')}]`);
  const known = d => typeof d === 'number' && d > 0;
  return dims && known(dims[2]) && known(dims[3]) ? { width: dims[3], height: dims[2] } : null;
}

// --- Library storage ---

function modelDir(root, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid model ID');
  return path.join(root, id);
}

function readMeta(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  // Models saved before flows keep their overlay settings; the app turns them
  // into a flow (src/models.ts). Models saved before detectors are all segmentation.
  return {
    ...meta,
    id: path.basename(dir),
    kind: meta.kind === 'detector' ? 'detector' : 'segmentation',
    threshold: normalizeThreshold(meta.threshold ?? meta.overlay?.threshold),
    flow: meta.flow ?? null,
  };
}

function writeMeta(dir, meta) {
  const file = path.join(dir, 'model.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function withPaths(root, meta) {
  const file = path.join(root, meta.id, meta.file);
  return { ...meta, path: file, missing: !fs.existsSync(file) };
}

function normalizeName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function normalizeThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) ? Math.min(0.99, Math.max(0.01, threshold)) : 0.5;
}

// Checks a flow's structure; the runtime validates the steps themselves.
function validateFlow(flow) {
  const fail = why => { throw new Error(`Invalid outputs: ${why}`); };
  const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!plain(flow) || flow.version !== 1 || !Array.isArray(flow.outputs)) fail('unsupported format');
  if (!Number.isInteger(flow.thickness) || flow.thickness < 1 || flow.thickness > 32) fail('line thickness must be 1..32');
  if (flow.outputs.length > 32) fail('at most 32 outputs');
  const ids = new Set();
  for (const o of flow.outputs) {
    if (!plain(o) || typeof o.id !== 'string' || !OUTPUT_ID.test(o.id) || ids.has(o.id)) fail('each output needs a unique ID');
    ids.add(o.id);
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80) fail('output names must be 1..80 characters');
    if (typeof o.from !== 'string' || o.from.length > 40) fail(`“${o.name}” has no source`);
    if (typeof o.record !== 'boolean' || typeof o.show !== 'boolean') fail(`“${o.name}” has invalid toggles`);
    if (!HEX_COLOR.test(o.color) || typeof o.label !== 'string' || o.label.length > 8) fail(`“${o.name}” has an invalid colour or label`);
    if (!Array.isArray(o.steps) || o.steps.length > 32) fail(`“${o.name}” has too many steps`);
    for (const step of o.steps) {
      if (!plain(step) || typeof step.op !== 'string' || step.op.length > 40 || !plain(step.params)) fail(`“${o.name}” has an invalid step`);
      if (step.with !== undefined && (typeof step.with !== 'string' || step.with.length > 40)) fail(`“${o.name}” has an invalid step input`);
      for (const v of Object.values(step.params))
        if (!(typeof v === 'number' && Number.isFinite(v)) && !(typeof v === 'string' && v.length <= 1000)) fail(`“${o.name}” has an invalid step setting`);
    }
  }
  if (JSON.stringify(flow).length > 60000) fail('too large');
  return flow;
}

function defaultName(src, dataDir) {
  if (dataDir) return path.basename(path.resolve(dataDir));
  const stem = path.basename(src, path.extname(src));
  // runs/unet/best.onnx → "unet": the folder says more than the checkpoint name
  return /^(best|last|model)$/i.test(stem) ? path.basename(path.dirname(path.resolve(src))) : stem;
}

function uniqueName(base, taken) {
  const used = new Set(taken.map(n => n.toLowerCase()));
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) name = `${base} ${n++}`;
  return name;
}

// Metrics from the history.json train_unet.py (IoU) or train_yolo.py (mAP) writes next to its exports.
function trainingMetrics(src) {
  try {
    const history = JSON.parse(fs.readFileSync(path.join(path.dirname(src), 'history.json'), 'utf8'));
    if (!Array.isArray(history) || !history.length) return null;
    const epochs = history[history.length - 1].epoch;
    if (history[0].kind === 'yolo') {
      // As Ultralytics picks its best weights: mostly mAP50-95
      const fitness = h => 0.1 * h.map50 + 0.9 * h.map;
      const best = history.reduce((a, b) => (fitness(b) > fitness(a) ? b : a));
      return { epochs, bestEpoch: best.epoch, map50: best.map50, map: best.map, precision: best.precision, recall: best.recall };
    }
    const best = history.reduce((a, b) => (b.valIou > a.valIou ? b : a));
    return { epochs, bestEpoch: best.epoch, valIou: best.valIou };
  } catch { return null; }
}

function listModels(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const models = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    try { models.push(withPaths(root, readMeta(path.join(root, e.name)))); } catch { /* skip unreadable entries */ }
  }
  return models.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Copies src into the library. Importing a file that is already there (same
// bytes) returns the existing entry instead of adding a duplicate.
async function importModel(root, src, { dataDir, trained } = {}) {
  const buf = await fs.promises.readFile(src);
  let info;
  try { info = inspectOnnx(buf); }
  catch { throw new Error(`${path.basename(src)} is not a valid ONNX model`); }
  // A detector, or else a segmentation model (whose check says what a file needs to be one)
  const detector = detectorInput(info);
  let input = detector?.input ?? null;
  if (!detector) {
    try { input = segmentationInput(info); }
    catch (e) { throw new Error(`${path.basename(src)} can't be run by FireFly: ${e.message}, or a YOLO detector's single [N, 3, H, W] input and [1, 4 + classes, anchors] output`); }
  }

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const models = listModels(root);
  const existing = models.find(m => m.sha256 === sha256);
  if (existing) {
    if (existing.missing) await fs.promises.writeFile(existing.path, buf);
    return { model: { ...existing, missing: false }, existing: true };
  }

  const id = crypto.randomUUID();
  const dir = path.join(root, id);
  const file = path.basename(src);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, file), buf);
  // Large exports keep their weights in an external-data sidecar the graph refers to by name
  if (fs.existsSync(`${src}.data`)) await fs.promises.copyFile(`${src}.data`, path.join(dir, `${file}.data`));

  const metrics = trainingMetrics(src);
  const meta = {
    version: 1,
    id,
    name: uniqueName(defaultName(src, dataDir), models.map(m => m.name)),
    file,
    sha256,
    size: buf.length,
    createdAt: new Date().toISOString(),
    source: { kind: trained ? 'trained' : 'imported', path: path.resolve(src) },
    kind: detector ? 'detector' : 'segmentation',
    ...(detector ? { classes: detector.classes } : {}),
    input,
    training: metrics || dataDir ? { dataDir: dataDir ? path.resolve(dataDir) : null, ...metrics } : null,
    threshold: detector ? 0.25 : 0.5, // a detector's: the least confidence a box needs, as Ultralytics predicts by default
    flow: null,
  };
  writeMeta(dir, meta);
  return { model: withPaths(root, meta), existing: false };
}

function updateModel(root, id, patch) {
  const dir = modelDir(root, id);
  const meta = readMeta(dir);
  if (patch.name !== undefined) {
    const name = normalizeName(patch.name);
    if (!name) throw new Error('Model name cannot be empty');
    meta.name = name;
  }
  if (patch.threshold !== undefined) meta.threshold = normalizeThreshold(patch.threshold);
  // What the model runs on: 'cpu' or 'directml:<adapter>' (src/inference.ts), or null to follow the toolbar
  if (patch.device !== undefined) {
    if (patch.device === null) delete meta.device;
    else if (typeof patch.device === 'string' && /^(cpu|directml:\d{1,3})$/.test(patch.device)) meta.device = patch.device;
    else throw new Error('A model runs on cpu or directml:<adapter>');
  }
  if (patch.flow !== undefined) {
    meta.flow = validateFlow(patch.flow);
    delete meta.overlay; // replaced by the flow
  }
  writeMeta(dir, meta);
  return withPaths(root, meta);
}

function removeModel(root, id) {
  fs.rmSync(modelDir(root, id), { recursive: true, force: true });
}

function modelPath(root, id) {
  return withPaths(root, readMeta(modelDir(root, id))).path;
}

module.exports = { inspectOnnx, detectorInput, listModels, importModel, updateModel, removeModel, modelPath };
