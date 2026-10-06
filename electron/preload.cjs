'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  invoke:           (op, params) => ipcRenderer.invoke('runtime:invoke', op, params),
  runtimeAvailable: ()           => ipcRenderer.invoke('runtime:available'),
  runtimeStatus:    ()           => ipcRenderer.invoke('runtime:status'),
  getThumbnails:    ()           => ipcRenderer.invoke('windows:thumbnails'),
  exactFrame:       (timestamp)  => ipcRenderer.invoke('frame:exact', timestamp),
  on: (channel, handler) => {
    const wrapped = (_e, ...args) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  pickFile: (filters) => ipcRenderer.invoke('bridge:pick-file', filters),
  collection: {
    start: params => ipcRenderer.invoke('collection:start', params),
    stop: id => ipcRenderer.invoke('collection:stop', id),
    status: () => ipcRenderer.invoke('collection:status'),
    table: (op, params) => ipcRenderer.invoke('collection:table', op, params),
    datasetList: directory => ipcRenderer.invoke('dataset:list', directory),
    datasetItem: (directory, relative) => ipcRenderer.invoke('dataset:item', directory, relative),
    datasetDelete: (directory, relative) => ipcRenderer.invoke('dataset:delete', directory, relative),
  },
  policy: {
    invoke: (op, params) => ipcRenderer.invoke('policy:invoke', op, params),
    play:   (params)     => ipcRenderer.invoke('play:start', params),
    stop:   ()           => ipcRenderer.invoke('play:stop'),
    exportDataset: (params) => ipcRenderer.invoke('policy:export', params),
    reveal: (file)       => ipcRenderer.invoke('policy:reveal', file),
  },
  training: {
    pickFolder:       ()       => ipcRenderer.invoke('training:pick-folder'),
    checkDataset:     (dir, kind) => ipcRenderer.invoke('training:check-dataset', dir, kind),
    checkCheckpoint:  (dir, kind) => ipcRenderer.invoke('training:check-checkpoint', dir, kind),
    gpuCheck:         ()       => ipcRenderer.invoke('training:gpu-check'),
    start:            (params) => ipcRenderer.invoke('training:start', params),
    exportOnnx:       (dir, sz, dataDir) => ipcRenderer.invoke('training:export-onnx', dir, sz, dataDir),
    stop:             ()       => ipcRenderer.invoke('training:stop'),
    pause:            ()       => ipcRenderer.invoke('training:pause'),
    unpause:          ()       => ipcRenderer.invoke('training:unpause'),
  },
  models: {
    list:   ()           => ipcRenderer.invoke('models:list'),
    import: (src, hints) => ipcRenderer.invoke('models:import', src, hints),
    update: (id, patch)  => ipcRenderer.invoke('models:update', id, patch),
    remove: (id)         => ipcRenderer.invoke('models:delete', id),
    reveal: (id)         => ipcRenderer.invoke('models:reveal', id),
    probe:  (outDir)     => ipcRenderer.invoke('models:probe', outDir),
  },
});
