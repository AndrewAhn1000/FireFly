import type { Flow } from './flows';
import type { TrainedModel } from './models';

interface Bridge {
  invoke(op: string, params?: Record<string, unknown>): Promise<unknown>;
  pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  runtimeAvailable(): Promise<boolean>;
  runtimeStatus(): Promise<{ ready: boolean; error: string | null }>;
  getThumbnails(): Promise<Record<string, string>>;
  // A live frame, by its capture time, as a lossless PNG (the live view is a JPEG), or null once it's gone
  exactFrame(timestamp: number): Promise<string | null>;
  on(channel: string, handler: (...args: unknown[]) => void): () => void;
  collection: {
    start(params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
    stop(id?: string): Promise<void>;
    status(): Promise<import('./collectionModel').CollectionStatus[]>;
    // A Table node's saved rows, per game (scope) and table name, a page at a time (filter: words every row must hold;
    // sort: a column or savedAt, newest first by default); delete one by key, or all without one
    table(op: 'rows', params: { scope: string; table: string; offset?: number; limit?: number; filter?: string; sort?: { column: string; up: boolean } }): Promise<import('./collectionModel').TableRows>;
    table(op: 'delete', params: { scope: string; table: string; key?: string }): Promise<void>;
    // A Dataset Output folder's saved images, oldest first, then one with its YOLO boxes (fractions of the image)
    datasetList(directory: string): Promise<{ root: string; yolo: boolean; classes: string[]; truncated: boolean; items: { path: string; split: string }[] }>;
    datasetItem(directory: string, relative: string): Promise<{ file: string; image: string; boxes: { cls: number; x: number; y: number; w: number; h: number }[] | null;
      meta: { trigger?: string; savedAt?: string; session?: string; sequence?: number; imageSize?: number[] } | null }>;
    // Moves an image and its label files to the Recycle Bin and deletes its table rows (how many of each)
    datasetDelete(directory: string, relative: string): Promise<{ files: number; rows: number; rowsError: string }>;
  };
  // Behaviour-cloning policies: train, list and play them (events: 'policy:event', 'play:status')
  policy: {
    invoke(op: string, params?: Record<string, unknown>): Promise<unknown>;
    play(params: { modelId: string; windowId: string; corrections?: boolean; graphId?: string }): Promise<{ ok: boolean; error?: string }>;
    stop(): Promise<void>;
    exportDataset(params: Record<string, unknown>): Promise<{ ok: boolean; canceled?: boolean; error?: string; path?: string; manifest?: string; samples?: number; features?: number; buttons?: number; skipped?: string[]; skippedReasons?: Record<string, number>; stepMs?: number }>;
    reveal(file: string): Promise<void>;
  };
  training: {
    pickFolder(): Promise<string | null>;
    // kind: which model the dataset or training is for, the segmentation UNet (default) or a YOLO detector
    checkDataset(dir: string, kind?: 'unet' | 'yolo'): Promise<{ ok: boolean; error?: string; result?: DatasetCheckResult; gridDataUrl?: string }>;
    checkCheckpoint(outDir: string, kind?: 'unet' | 'yolo'): Promise<{ found: boolean; epoch?: number; totalEpochs?: number; valIou?: number; map50?: number; best?: string }>;
    gpuCheck(): Promise<{ available: boolean; name: string | null; nvidiaSmiOk?: boolean; driverCuda?: string | null; wheel?: string | null }>;
    start(params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
    exportOnnx(outDir: string, size: { width: number; height: number } | { kind: 'yolo' }, dataDir?: string): Promise<{ ok: boolean; path?: string; error?: string; model?: TrainedModel; existing?: boolean; modelError?: string }>;
    stop(): Promise<void>;
    pause(): Promise<{ ok: boolean }>;
    unpause(): Promise<{ ok: boolean }>;
  };
  models: {
    list(): Promise<TrainedModel[]>;
    import(src: string, hints?: { dataDir?: string; trained?: boolean }): Promise<{ ok: boolean; error?: string; model?: TrainedModel; existing?: boolean }>;
    update(id: string, patch: { name?: string; threshold?: number; flow?: Flow; device?: string | null }): Promise<{ ok: boolean; error?: string; model?: TrainedModel }>;
    remove(id: string): Promise<{ ok: boolean; error?: string }>;
    reveal(id: string): Promise<void>;
    probe(outDir: string): Promise<string | null>;
  };
}

declare global {
  interface Window { bridge: Bridge; }
}

export {};
