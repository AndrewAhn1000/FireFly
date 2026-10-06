'use strict';
// Reads a collection output folder for the dataset preview: its saved images in the order they were saved, and for
// each one its picture, YOLO label boxes and the metadata written beside it. Only reads, and only inside the folder.
const fs = require('node:fs');
const path = require('node:path');

const IMAGE = /\.(png|jpe?g)$/i;
const MAX_IMAGES = 100000;

function rootOf(directory) {
  if (typeof directory !== 'string' || !directory || !path.isAbsolute(directory)) throw new Error('Choose an absolute dataset folder');
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('The dataset folder does not exist yet: nothing has been saved');
  return root;
}

// A path under root, refusing anything that leaves it
function inside(root, relative) {
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) throw new Error('That file is outside the dataset folder');
  return file;
}

function walk(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= MAX_IMAGES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (IMAGE.test(entry.name)) found.push(full);
  }
}

// data.yaml's class names, as FireFly writes them ("  0: name" under names:)
function classNames(root) {
  const yaml = path.join(root, 'data.yaml');
  if (!fs.existsSync(yaml)) return [];
  const names = [];
  for (const m of fs.readFileSync(yaml, 'utf8').matchAll(/^\s+(\d+):\s*(.+?)\s*$/gm)) names[Number(m[1])] = m[2];
  return Array.from(names, (n, i) => n ?? `class ${i}`);
}

// A YOLO dataset keeps images under images/<split>/… and labels at the same place under labels/
function labelsFor(root, image) {
  const relative = path.relative(path.join(root, 'images'), image);
  if (relative.startsWith('..')) return null;
  const base = path.join(root, 'labels', relative).replace(IMAGE, '');
  return { txt: base + '.txt', json: base + '.json', split: relative.split(path.sep)[0] };
}

function listDataset(directory) {
  const root = rootOf(directory);
  const yolo = fs.existsSync(path.join(root, 'images'));
  const found = [];
  walk(yolo ? path.join(root, 'images') : root, found);
  const items = found.map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file, undefined, { numeric: true }))
    .map(({ file }) => ({ path: path.relative(root, file).split(path.sep).join('/'), split: yolo ? labelsFor(root, file)?.split ?? '' : '' }));
  return { root, yolo, classes: classNames(root), items, truncated: found.length >= MAX_IMAGES };
}

function readItem(directory, relative) {
  const root = rootOf(directory);
  if (typeof relative !== 'string' || !IMAGE.test(relative)) throw new Error('Not an image in this dataset');
  const file = inside(root, relative);
  const bytes = fs.readFileSync(file);
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  const paths = labelsFor(root, file);
  // Boxes as YOLO writes them: class and centre/size as fractions of the image
  let boxes = null;
  if (paths && fs.existsSync(paths.txt)) {
    boxes = fs.readFileSync(paths.txt, 'utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
      .filter(v => v.length === 5 && v.every(Number.isFinite))
      .map(([cls, x, y, w, h]) => ({ cls, x, y, w, h }));
  }
  const metaFile = paths ? paths.json : file + '.json';
  let meta = null;
  if (fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      meta = { trigger: m.trigger, savedAt: m.savedAt, session: m.session, sequence: m.sequence, imageSize: m.imageSize };
    } catch { /* an unreadable sidecar leaves just the image */ }
  }
  return { file, image: `data:${mime};base64,${bytes.toString('base64')}`, boxes, meta };
}

// Removes an image and the files written beside it (its YOLO label and metadata, or a plain output's JSON) through
// trash (the Recycle Bin, so it can be undone); returns the image's full path, for its table rows to go too
async function deleteItem(directory, relative, trash) {
  const root = rootOf(directory);
  if (typeof relative !== 'string' || !IMAGE.test(relative)) throw new Error('Not an image in this dataset');
  const image = inside(root, relative);
  if (!fs.existsSync(image)) throw new Error('That image is no longer there');
  const paths = labelsFor(root, image);
  const files = [image, ...(paths ? [paths.txt, paths.json] : [image + '.json'])].filter(f => fs.existsSync(f));
  for (const file of files) await trash(file);
  return { image, files };
}

module.exports = { listDataset, readItem, deleteItem };
