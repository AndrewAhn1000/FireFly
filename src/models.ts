// Trained model library entries (stored by electron/models.cjs) and the capture
// graph that runs one of them, and the values read from regions, over the live view.
import { inferenceChoice, type InferenceChoice } from './inference';
import { compileFlow, platformer, RESERVED_NAMES, TEMPLATES, type CompiledFlow, type Flow, type FlowRoot, type FlowTemplate, type FlowType, type GraphNode } from './flows';

// How models saved before flows were drawn; converted to a flow on load
interface LegacyOverlay { color?: string; terrain?: boolean; ladderColor?: string }

export interface TrainedModel {
  id: string;
  name: string;
  path: string;     // FireFly's copy of the .onnx file
  missing: boolean; // that copy was deleted outside the app
  size: number;
  createdAt: string;
  source: { kind: 'trained' | 'imported'; path: string };
  // A segmentation UNet (a mask out), or a YOLO detector (boxes of its classes out)
  kind?: 'segmentation' | 'detector';
  classes?: string[]; // a detector's, by class number
  input: { width: number; height: number } | null;
  training: {
    dataDir: string | null; epochs?: number; bestEpoch?: number; valIou?: number;
    map50?: number; map?: number; precision?: number; recall?: number; // a detector's, at its best epoch
  } | null;
  threshold: number; // a mask pixel's least probability, or a detector box's least confidence
  device?: string;   // what it runs on ('cpu', 'directml:<adapter>'); absent: whatever the toolbar's Inference says
  flow: Flow | null; // null until the outputs are first edited
  overlay?: LegacyOverlay;
}

// A value the runtime reported for a graph node or recorded output
export interface NodeResult {
  type?: string;
  valid: boolean;
  reason?: string;
  value?: unknown;
  count?: number;    // shapes
  coverage?: number; // previewed masks
}

// Feedback for the running model, read from the runtime's per-frame observations.
export interface ModelLive {
  modelId: string;
  phase: 'loading' | 'running' | 'error';
  latencyMs?: number;
  coverage?: number | null;
  observations?: Record<string, NodeResult>; // recorded outputs by name
  nodes?: Record<string, NodeResult>;        // every step, values summarised
  preview?: (NodeResult & { node: string }) | null;
  error?: string;
}

export const isDetector = (model: TrainedModel | null | undefined) => model?.kind === 'detector';
export const detectorClasses = (model: TrainedModel) => model.classes ?? [];

// Colours a detector's classes are drawn in by default
const CLASS_COLORS = ['#ff5252', '#40c4ff', '#ffd600', '#69f0ae', '#e040fb', '#ff9100', '#18ffff', '#eeff41'];

// A detector's outputs to start from: each class's boxes, drawn and recorded as "<class> (detected)"
export function detectorFlow(classes: string[]): Flow {
  return {
    version: 1, thickness: 2,
    outputs: classes.map((name, i) => ({
      id: `class${i}`, name: `${name} (detected)`, from: `class:${i}`, steps: [], record: true, show: true,
      color: CLASS_COLORS[i % CLASS_COLORS.length], label: (name.trim()[0] ?? 'd').toUpperCase(),
    })),
  };
}

// What a detector's outputs can start from: every box, or one class's
export function detectorRoots(model: TrainedModel): Record<string, FlowRoot & { label: string }> {
  const roots: Record<string, FlowRoot & { label: string }> = { detections: { node: 'detect', type: 'shapes', label: 'All detections' } };
  detectorClasses(model).forEach((name, i) => { roots[`class:${i}`] = { node: `class.${i}`, type: 'shapes', label: `Class: ${name}` }; });
  return roots;
}

// The templates a model's outputs can start from
export const modelTemplates = (model: TrainedModel): FlowTemplate[] => isDetector(model)
  ? [{ id: 'classes', label: 'One output per class', description: 'Each class’s boxes, drawn and recorded under its own name.', build: () => detectorFlow(detectorClasses(model)) }]
  : TEMPLATES;

export function modelFlow(model: TrainedModel): Flow {
  if (model.flow) return model.flow;
  if (isDetector(model)) return detectorFlow(detectorClasses(model));
  const legacy = model.overlay;
  if (!legacy) return TEMPLATES.find(t => t.id === 'objects')!.build();
  if (legacy.terrain === false) {
    const outline = TEMPLATES.find(t => t.id === 'outline')!.build();
    outline.outputs[0].color = legacy.color ?? '#00ff00';
    return outline;
  }
  return platformer(legacy.color ?? '#00ff00', legacy.ladderColor ?? '#ffd600');
}

export const compileModel = (model: TrainedModel, names?: Set<string>): CompiledFlow =>
  compileFlow(modelFlow(model), isDetector(model) ? detectorRoots(model) : { mask: { node: 'mask', type: 'mask' } }, 'frame', names);

// A region whose pixels are read by a flow of steps, wherever the box is on the frame
export interface RegionSource { id: string; x: number; y: number; w: number; h: number; flow: Flow }

interface RegionLike { id: string; x: number; y: number; w: number; h: number; source?: string; match?: boolean; flow?: Flow }

// Values can only be read from a box that stays put: script regions have none, and
// a region following an object moves every frame while the graph's crop is fixed
export const readsValues = (r: RegionLike) => r.source !== 'script' && r.match !== true;

// The regions that have values to read
export const regionSources = (regions: RegionLike[]): RegionSource[] =>
  regions.filter(r => readsValues(r) && r.flow && r.flow.outputs.length > 0)
    .map(r => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, flow: r.flow! }));

// Prefix of a region's graph nodes and outputs
export const regionKey = (id: string) => `r${id.replace(/-/g, '').slice(0, 8)}`;
export const regionCropNode = (id: string) => `crop-${regionKey(id)}`;

// The box as fractions of the frame, so it reads the same part of it at any window size
function regionCrop(r: RegionSource): GraphNode {
  const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
  const x = clamp(r.x, 0, 0.999), y = clamp(r.y, 0, 0.999);
  return {
    id: regionCropNode(r.id), op: 'crop', inputs: ['frame'],
    params: { unit: 'fraction', x, y, width: clamp(r.w, 0.001, 1 - x), height: clamp(r.h, 0.001, 1 - y) },
  };
}

// Compiles each model's flow in turn, then each region's, so that names recorded by an
// earlier one are taken. A region's flow starts from the crop of its box.
export function compileLive(models: TrainedModel[], regions: RegionSource[]) {
  const names = new Set<string>(RESERVED_NAMES);
  const compiledModels = new Map<string, CompiledFlow>();
  for (const m of models) compiledModels.set(m.id, compileModel(m, names));
  const compiledRegions = new Map<string, CompiledFlow>();
  for (const r of regions) {
    const crop = regionCrop(r);
    const compiled = compileFlow(r.flow, { region: { node: crop.id, type: 'image' } }, 'frame', names);
    compiledRegions.set(r.id, { ...compiled, nodes: compiled.nodes.length ? [crop, ...compiled.nodes] : [] });
  }
  return { models: compiledModels, regions: compiledRegions };
}

// Where a running model's steps are in the live graph. With one model running they keep the names they
// always had, so recordings made with it keep their observation identity (node names are part of it);
// with several, each model's are prefixed with its own key so that they can't clash.
export const modelKey = (id: string) => `m${id.replace(/-/g, '').slice(0, 8)}`;
export const modelPrefix = (model: TrainedModel, running: TrainedModel[]) => running.length > 1 ? `${modelKey(model.id)}.` : '';

// A model's own steps, by the names its flow gives them, out of every step's results
export function ownNodes<T>(nodes: Record<string, T>, prefix: string): Record<string, T> {
  if (!prefix) return nodes;
  const own: Record<string, T> = {};
  for (const [id, v] of Object.entries(nodes)) if (id.startsWith(prefix)) own[id.slice(prefix.length)] = v;
  return own;
}

// The share of the frame the mask covers, available whatever the flow
export const COVERAGE = '@coverage';

// Observations a model provides to the state system (a detector has no mask to cover anything)
export function modelOutputs(model: TrainedModel | null): { name: string; label: string; type: FlowType }[] {
  const recorded = model ? compileModel(model).recorded : [];
  return [
    ...recorded.map(r => ({ name: r.name, label: r.name, type: r.type })),
    ...(isDetector(model) ? [] : [{ name: COVERAGE, label: 'Detected area', type: 'number' as const }]),
  ];
}

export function modelOutput(live: ModelLive | null, name: string): unknown {
  if (live?.phase !== 'running') return undefined;
  const recorded = live.observations?.[name];
  // States saved before flows used "coverage" for the detected area
  if (name === COVERAGE || (name === 'coverage' && !recorded)) return live.coverage ?? undefined;
  return recorded?.valid ? recorded.value : undefined;
}

// What the runtime reported for the latest frame of the live graph, whether or
// not a model is running: recorded outputs by name, and every step's value.
export interface StreamLive {
  observations: Record<string, NodeResult>;
  nodes: Record<string, NodeResult>;
  preview: (NodeResult & { node: string }) | null;
  latencyMs?: number;
}

// The current value of a recorded output, or undefined until there is a valid one
export function recordedValue(live: StreamLive | null, name: string): unknown {
  const recorded = live?.observations[name];
  return recorded?.valid ? recorded.value : undefined;
}

export interface CaptureGraph {
  version: 1; id: string; revision: number;
  nodes: { id: string; op: string; inputs: string[]; params: Record<string, unknown> }[];
}

// The steps that run a model on the frame, which its flow starts from: a segmentation model's mask (and
// how much of the frame it covers, evaluated but not published: the UI reads it from the per-node debug
// output), or a detector's boxes and each class's
function modelRootNodes(model: TrainedModel, toolbar: InferenceChoice): GraphNode[] {
  const inference = modelInference(model, toolbar);
  if (isDetector(model)) return [
    { id: 'detect', op: 'detect', inputs: ['frame'], params: { model: model.path, confidence: model.threshold, iou: 0.7, ...inference } },
    ...detectorClasses(model).map((_, i) => ({ id: `class.${i}`, op: 'filter', inputs: ['detect'], params: { expression: `class == ${i}` } })),
  ];
  return [
    { id: 'mask', op: 'segment', inputs: ['frame'], params: { model: model.path, threshold: model.threshold, ...inference } },
    { id: 'coverage', op: 'coverage', inputs: ['mask'], params: {} },
  ];
}

// What a model runs on: its own device, or the toolbar's
export const modelInference = (model: TrainedModel, toolbar: InferenceChoice): InferenceChoice =>
  model.device ? inferenceChoice(model.device) : toolbar;

// The graph the detection worker evaluates on the newest available frame. Each running model
// segments the frame (or finds a detector's boxes, also split by class) and runs its flow of
// outputs on the mask (or boxes), one model after another, each drawing over what the ones before
// drew; the frame with all of it drawn on is available in Detection view. The regions'
// flows read their boxes off the frame, model or not. Steps with problems are
// left out (compileFlow reports them) so the rest keeps running.
export function liveGraph(models: TrainedModel[], revision: number, regions: RegionSource[] = [], inference: InferenceChoice = { provider: 'cpu', device: 0 }): CaptureGraph {
  const frame = { id: 'frame', op: 'frame', inputs: [], params: {} };
  const compiled = compileLive(models, regions);
  const regionNodes = [...compiled.regions.values()].flatMap(r => r.nodes);
  if (!models.length) return {
    version: 1, id: 'default', revision,
    nodes: [frame, ...regionNodes, { id: 'out', op: 'publish', inputs: ['frame'], params: { name: 'frame' } }],
  };
  const modelNodes: GraphNode[] = [];
  let display = 'frame';
  for (const model of models) {
    const flow = compiled.models.get(model.id)!;
    const nodes = [...modelRootNodes(model, inference), ...flow.nodes];
    const prefix = modelPrefix(model, models);
    const own = new Set(nodes.map(n => n.id));
    const name = (id: string) => own.has(id) ? prefix + id : id;
    // A flow's first drawing goes on the frame; here, on what the models before it drew
    const start = display;
    for (const n of nodes) modelNodes.push({
      ...n, id: name(n.id),
      inputs: n.inputs.map((input, i) => i === 0 && input === 'frame' && (n.op === 'draw_shapes' || n.op === 'draw_contours') ? start : name(input)),
    });
    if (flow.display !== 'frame') display = name(flow.display);
  }
  return {
    version: 1, id: models.length === 1 ? `model-${models[0].id}` : `models-${models.map(m => modelKey(m.id)).join('-')}`, revision,
    nodes: [frame, ...modelNodes, ...regionNodes, { id: 'out', op: 'publish', inputs: [display], params: { name: 'annotated' } }],
  };
}
