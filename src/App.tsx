import React, { useState, useEffect, useCallback, useMemo, useReducer, useRef } from 'react';
import InfoTip from './InfoTip';
import TemplatePicker from './TemplatePicker';
import ModelsPanel from './ModelsPanel';
import OutputsPanel, { type FlowError } from './OutputsPanel';
import ValuesPanel from './ValuesPanel';
import RecordingsPanel from './RecordingsPanel';
import type { GpuInfo } from './bridge';
import PlayPanel from './PlayPanel';
import { inferenceChoice, type InferenceDevice } from './inference';
import Keyboard, { BUTTONS, MAX_BUTTONS } from './Keyboard';
import Transport from './Transport';
import GraphLibrary from './GraphLibrary';
import { stateValueError } from './stateValues';
import { scriptRegionBoxes, luaRegionSnapshot, type ScriptGeometry, type RegionBoxSnapshot } from './scriptRegions';
import LuaScriptEditor from './LuaScriptEditor';
import { luaPollRunner, luaStateDefinitions } from './luaPolling';
import LookThumb, { MATCH_LOOKS, type MatchLook } from './LookThumb';
import MaskEditor from './MaskEditor';
import { DraftInput } from './FlowEditor';
import { FrameBuffer, blobToDataUrl, type BufferedFrame } from './frameBuffer';
import {
  compileLive, COVERAGE, liveGraph, modelFlow, modelOutput, modelOutputs, modelPrefix, ownNodes, readsValues, recordedValue, regionKey, regionSources,
  type ModelLive, type NodeResult, type StreamLive, type TrainedModel,
} from './models';
import { dominantColor, REGION_TEMPLATES, RESERVED_NAMES, type Flow, type FlowProblem, type FlowType } from './flows';
import { oneLine } from './text';
import { TEMPLATE_DETECTED, TEMPLATE_SETTLE_MS, REGION_POSITION, REGION_VELOCITY, REGION_MATCHES, MOTION_LABELS, settle, strongestMatch, templateDetected, selectedTemplateIds, type RegionMotion, type Settled, type TemplateMatch, type TemplateSnapshot } from './templateMatching';

function formatEta(sec: number): string {
  if (sec < 90)     return `~${Math.round(sec)}s`;
  if (sec < 3600)   { const m = Math.round(sec / 60); return `~${m}m`; }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

interface WindowInfo      { id: string; title: string; pid: number; }
interface RecordingStatus { active: boolean; samples: number; id: string; queued?: number; error?: string; sampleHz?: number; focused?: boolean; }
// How fast things actually happen, as the runtime measures them: new frames from the game (a window only
// yields one when it redraws), graph results, and how long the graph takes a frame (median of the last few)
interface Rates { frameHz: number; detectionHz: number; detectionMs: number; }
interface Template        { id: string; cropUrl: string; maskUrl?: string; } // maskUrl: which pixels count, white (see MaskEditor)
// The corners a following box is stretched between when its object changes size: a patch of each, how big
// the patches are (px), and where and how big the box was when they were taken (fractions of the frame)
interface Corners         { tl: Template; br: Template; size: number; at: { x: number; y: number }; box: { w: number; h: number }; plain: boolean; }
// match: template matching moves the box to follow its object; without it the box stays where it was put
// fit: the box also takes the size of the object, found by its corners rather than by a template of the whole
// flow: the values read from what's inside the box (see flows.ts)
interface Region          { id: string; label: string; x: number; y: number; w: number; h: number; templates: Template[]; source?: 'manual' | 'script'; script?: string; scriptWidth?: number; scriptHeight?: number; visible?: boolean; match?: boolean; multiMatch?: boolean; matchThreshold?: number; searchReach?: number | 'window'; matchOn?: MatchLook; fit?: boolean; corners?: Corners; flow?: Flow; }
interface ScriptBox       { x: number; y: number; w: number; h: number; }
interface ScriptRegionReading {
  value: unknown;
  geometry: ScriptGeometry;
  width: number;
  height: number;
}

// What the live view draws over a frame besides the regions themselves
interface ModelDrawing    { dataUrl: string; width: number; height: number; timestamp: number; }
interface FrameValues {
  states: Record<string, unknown>;
  errors: Record<string, string | undefined>;
  boxes: Record<string, ScriptBox>;
  templates: Record<string, TemplateSnapshot>;
  confidence: Record<string, number>;
  outputs: Record<string, unknown>;
}
interface FrameOverlay extends FrameValues {
  script: Record<string, ScriptBox[]>;
  readings: Record<string, ScriptRegionReading>;
  matches: TemplateMatch[];
  model?: ModelDrawing | null;
  size: { w: number; h: number } | null;
}
interface FrameResponse   { pending?: boolean; dataUrl?: string; timestamp?: number; width?: number; height?: number; jpeg?: Uint8Array<ArrayBuffer>; }
// Live, or paused on the frame captured at t (rewinding pauses)
type StreamView = { mode: 'live' } | { mode: 'paused'; t: number };
type AppStatus  = 'loading' | 'no-runtime' | 'connecting' | 'ready' | 'error';
type IxMode     = 'idle' | 'drawing' | 'moving' | 'resizing';
type Handle     = 'nw' | 'ne' | 'sw' | 'se';
type StateType  = 'number' | 'boolean' | 'vector' | 'category' | 'text' | 'image' | 'object' | 'collection' | 'grid';
type ByteType   = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'u64' | 'i64' | 'f32' | 'f64' | 'utf8' | 'utf16';

interface GameState {
  id: string; name: string; type: StateType;
  observationName?: string; // keep graph references stable when a State's display name is edited
  source: 'region' | 'memory' | 'script' | 'model';
  regionId?: string; templateId?: string; templateIds?: string[];
  settleMs?: number; // a template state: how long a new answer has to hold before the state takes it
  address?: string; offsets?: string[]; byteType?: ByteType;
  script?: string; scriptWidth?: number; scriptHeight?: number;
  output?: string; // name of a recorded output: of the running model, or of the region's values
  off?: boolean;      // turned off: not read, run or recorded, and a script reading it is told so
  folderId?: string;  // the folder it's listed in (StateFolder), else the top level
}
// A folder States are listed in, kept per window with them
interface StateFolder { id: string; name: string; collapsed?: boolean }
// What a State row carries when dragged onto a folder: its id
const STATE_DRAG = 'application/firefly-state';

type StateDialogData = {
  id?: string;
  name: string; type: StateType; source: 'region' | 'memory' | 'script' | 'model';
  regionId: string; address: string; offsets: string[]; byteType: ByteType;
  script: string; scriptWidth?: number; scriptHeight?: number; output: string; templateId?: string; templateIds?: string[];
  folderId?: string;
};

// A UNet's epoch scores IoU; a YOLO detector's (kind 'yolo') precision, recall and mAP
interface TrainProgress     { kind?: 'yolo'; epoch: number; totalEpochs: number; trainLoss: number; trainIou: number; valLoss: number; valIou: number; lr: number; sec: number;
                              precision?: number; recall?: number; map50?: number; map?: number; }
interface TrainBatch        { epoch: number; step: number; total: number; loss: number; }
// A YOLO dataset's check (kind 'yolo') counts images (pairs) and boxes per split and class instead of mask coverage
interface DatasetCheckResult { pairs: number; sampledCount: number; coverageMean: number; coverageMin: number; coverageMax: number; emptyMasks: number; emptyPct: number; sizeMismatches: number; warnings: string[]; pass: boolean;
                               kind?: 'yolo'; splits?: Record<string, { images: number; boxes: number }>; classes?: { name: string; boxes: number; color: string }[]; }
type TrainKind = 'unet' | 'yolo';
// What a YOLO training is told: its own dataset, output, epochs and batch (kept apart from the UNet's), which
// pretrained model it starts from and the image size it trains at
interface YoloTrainConfig { dataDir: string; outDir: string; epochs: number; batch: number; model: string; imgsz: number; }
const YOLO_MODELS: [string, string][] = [['yolo11n', 'Nano: fastest, smallest'], ['yolo11s', 'Small'], ['yolo11m', 'Medium'], ['yolo11l', 'Large'], ['yolo11x', 'Extra large: most accurate, slowest']];

// The buttons a recording can hold, chosen on a whole keyboard (src/Keyboard.tsx)
const BUTTON_DEFS = BUTTONS;

const DEFAULTS = new Set(['lmb', 'rmb', 'w', 'a', 's', 'd', 'space']);

const CORNER_SIZE = 12; // px, of the patches cut from the corners of a box that follows an object by them
const FIT_GROWTH = 3;   // how many times bigger than it was an object can get and still be found by them
const CORNER_REACH = 96; // px, how far from where they were corners are looked for, unless the region says otherwise
const NEAR_REACH = 100;  // px, how far from where it was a region looks once it's set to look only near there

// Whether a region's box takes its size from the corners of its object, rather than from a template of it
const fitsCorners = (r: Region) => r.fit === true && !!r.corners && !r.multiMatch;
// Whether a region has anything to follow its object by
const hasAnchors = (r: Region) => fitsCorners(r) || r.templates.length > 0;
// The least confidence a match needs to move a region's box, chosen in the region editor. A region that
// never had one chosen keeps what it had: 45% following one object, 75% matching every instance or by corners.
const matchThreshold = (r: Region) => r.matchThreshold ?? (r.multiMatch || fitsCorners(r) ? 0.75 : 0.45);
// How far from where its object was last found a region looks for it, in window px, or null for the whole window
// every frame. Multi-match always looks through the whole window; corners look near where they were by default.
const searchReach = (r: Region): number | null =>
  r.multiMatch && !fitsCorners(r) ? null : r.searchReach === 'window' ? null : r.searchReach ?? (fitsCorners(r) ? CORNER_REACH : null);
// Where a followed region's object was last found, as fractions of the frame
interface LiveBox         { x: number; y: number; w: number; h: number; }
// A region where it is on screen: at its object's last place while it follows one, else where it was put
const placedAt = (r: Region, live: Record<string, LiveBox>): Region => live[r.id] ? { ...r, ...live[r.id] } : r;
// A copy of a per-region record without one region, or with none at all
function without<T>(record: Record<string, T>, regionId?: string): Record<string, T> {
  if (regionId === undefined) return {};
  const next = { ...record };
  delete next[regionId];
  return next;
}

const STATE_TYPES: { value: StateType; label: string; desc: string }[] = [
  { value: 'number',     label: 'Number',           desc: 'HP, speed, XP, distance, currency' },
  { value: 'boolean',    label: 'Boolean',           desc: 'Grounded, visible, menu open' },
  { value: 'vector',     label: 'Vector',            desc: 'Position, velocity, direction' },
  { value: 'category',   label: 'Category / Enum',   desc: 'One of several named states' },
  { value: 'text',       label: 'Text',              desc: 'OCR, dialogue, objectives' },
  { value: 'image',      label: 'Image',             desc: 'Visual crop for a model' },
  { value: 'object',     label: 'Object / Struct',   desc: 'Entity with named fields' },
  { value: 'collection', label: 'Collection / List', desc: 'Any number of items' },
  { value: 'grid',       label: 'Grid / Tensor',     desc: 'Spatial maps, multidimensional data' },
];

const BYTE_TYPES: { value: ByteType; label: string }[] = [
  { value: 'u8',    label: '1 Byte — uint8 (0 to 255)' },
  { value: 'i8',    label: '1 Byte — int8 (−128 to 127)' },
  { value: 'u16',   label: '2 Bytes — uint16 / WORD' },
  { value: 'i16',   label: '2 Bytes — int16' },
  { value: 'u32',   label: '4 Bytes — uint32 / DWORD (default)' },
  { value: 'i32',   label: '4 Bytes — int32' },
  { value: 'u64',   label: '8 Bytes — uint64 / QWORD' },
  { value: 'i64',   label: '8 Bytes — int64' },
  { value: 'f32',   label: 'Float — 32-bit IEEE 754' },
  { value: 'f64',   label: 'Double — 64-bit IEEE 754' },
  { value: 'utf8',  label: 'Text — UTF-8 string' },
  { value: 'utf16', label: 'Text — UTF-16 / widechar string' },
];

const STATE_BADGE: Record<StateType, string> = {
  number: 'NUM', boolean: 'BOOL', vector: 'VEC', category: 'ENUM',
  text: 'TXT', image: 'IMG', object: 'OBJ', collection: 'LIST', grid: 'GRID',
};

const DEFAULT_SCRIPT = `-- Available functions:
--   get_module_base("module.exe")   base address of a loaded module
--   read_u8/i8/u16/i16/u32/i32/u64/i64/f32/f64(addr)
--   read_ptr(addr)                  8-byte pointer dereference
--   read_str(addr, maxLen)          null-terminated UTF-8
-- Return any number, boolean, string, or table.

local base = get_module_base("game.exe") + 0x00000000  -- replace offset
return read_f32(base + 0x10)
`;

const DEFAULT_REGION_SCRIPT = `-- Return a box or array of boxes in game pixel coordinates.
-- Coordinates are relative to the top-left of the captured window.
-- Available: get_module_base, list_modules, get_window_size, read_*
--
-- Box formats:
--   { x1, y1, x2, y2 }        two corners; w/h computed automatically
--   { x1, y1, x2, y2, w, h }  two corners + explicit box size
--   { x, y, w, h }             top-left + size (legacy)

local sz = get_window_size()
return { x1=0, y1=0, x2=sz.w, y2=sz.h }
`;

// The type of state that holds a value read by a flow, and how the value is described when choosing one
const stateTypeOf = (type: FlowType): StateType => type === 'shapes' ? 'collection' : type === 'text' ? 'text' : 'number';
const valueKind = (type: FlowType) => type === 'shapes' ? 'list of shapes' : type === 'text' ? 'text' : 'number';

// Points a state draft at a model observation; a placeholder name follows it
function pickModelOutput(d: StateDialogData, name: string, outputs: ReturnType<typeof modelOutputs>): StateDialogData {
  const output = outputs.find(o => o.name === name) ?? outputs[0];
  const placeholder = /^State \d+$/.test(d.name) || outputs.some(o => o.label === d.name);
  return {
    ...d, source: 'model', output: output.name,
    type: stateTypeOf(output.type),
    name: placeholder ? output.label : d.name,
  };
}

// A state's value that doesn't exist yet: it's made from a template when the state is added
const NEW_VALUE = '@new:';

// Points a state draft at a region and one of the values read from it, or at a new one
function pickRegionValue(d: StateDialogData, regionId: string, output: string, values: { name: string; type: FlowType }[]): StateDialogData {
  const existing = values.find(v => v.name === output) ?? (output.startsWith(NEW_VALUE) ? undefined : values[0]);
  const chosen = existing?.name ?? (output.startsWith(NEW_VALUE) ? output : `${NEW_VALUE}${REGION_TEMPLATES[0].id}`);
  const type = existing?.type ?? REGION_TEMPLATES.find(t => `${NEW_VALUE}${t.id}` === chosen)?.result ?? 'number';
  return { ...d, source: 'region', regionId, output: chosen, templateId: undefined, templateIds: undefined, type: stateTypeOf(type) };
}

// "ladders.2: …" from the runtime names the output and step that failed
function graphError(message: string): FlowError {
  const text = message.replace(/^(Error: )?(Error invoking remote method '[^']*': )?(Error: )?/, '');
  const step = /^([A-Za-z][\w-]*)\.(\d+): (.*)$/s.exec(text);
  if (step) return { output: step[1], step: Number(step[2]) - 1, message: step[3] };
  const output = /^(?:draw|record)\.([A-Za-z][\w-]*): (.*)$/s.exec(text);
  if (output) return { output: output[1], message: output[2] };
  return { message: text };
}

// A state's live value: what its model or region reads, or what its memory address or script last gave
// What a template state's settled answer was worked out for
const settleKey = (s: GameState) => JSON.stringify([selectedTemplateIds(s) ?? null, s.settleMs ?? TEMPLATE_SETTLE_MS]);

function stateValue(s: GameState, live: { capturing: boolean; model: ModelLive | null; stream: StreamLive | null; values: Record<string, unknown>; templates: Record<string, TemplateSnapshot>; motion: Record<string, RegionMotion>; settled: Record<string, Settled>; regions: Region[]; frame?: { w: number; h: number } | null }): unknown {
  // Every match: a point at each one's centre, in window px, as the runtime records it (multi-match: every
  // instance; following one object, its box while it's found)
  if (s.source === 'region' && s.output === REGION_MATCHES) {
    if (!live.capturing || !live.frame) return undefined;
    const region = live.regions.find(r => r.id === s.regionId), { w: W, h: H } = live.frame;
    if (region?.multiMatch) return (live.templates[s.regionId ?? '']?.matches ?? [])
      .map(m => ({ x: (m.x + m.w / 2) * W, y: (m.y + m.h / 2) * H, w: m.w * W, h: m.h * H, confidence: m.confidence, templateId: m.templateId }));
    const at = live.motion[s.regionId ?? '']?.position;
    return at ? [{ x: at[0], y: at[1] }] : [];
  }
  if (s.source === 'region' && s.output === TEMPLATE_DETECTED) {
    const raw = templateDetected(live.capturing ? live.templates[s.regionId ?? ''] ?? null : null, s.regionId ?? '', selectedTemplateIds(s), live.regions.find(r => r.id === s.regionId)?.templates.map(t => t.id) ?? []);
    const settled = live.settled[s.id];
    return raw === undefined ? undefined : settled?.key === settleKey(s) ? settled.value ?? raw : raw;
  }
  // A followed region's position or velocity is null while its object is lost, and unknown until it's followed
  if (s.source === 'region' && (s.output === REGION_POSITION || s.output === REGION_VELOCITY))
    return live.capturing ? live.motion[s.regionId ?? '']?.[s.output === REGION_POSITION ? 'position' : 'velocity'] : undefined;
  return s.source === 'model' ? modelOutput(live.capturing ? live.model : null, s.output ?? COVERAGE)
    : s.source === 'region' ? recordedValue(live.capturing ? live.stream : null, s.output ?? '')
    : live.values[s.id];
}


function formatStateValue(s: GameState, val: unknown): string {
  if (val === null || val === undefined) return '–';
  if (s.type === 'vector' && Array.isArray(val) && val.length === 2 && val.every(v => typeof v === 'number'))
    return `(${Math.round(val[0])}, ${Math.round(val[1])})`;
  if (Array.isArray(val)) return `${(val as unknown[]).length} items`;
  if (typeof val === 'object') {
    const keys = Object.keys(val as object);
    return keys.length <= 2 ? `{${keys.join(', ')}}` : `{${keys[0]}, …}`;
  }
  if (s.type === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number')
    return Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, '');
  return typeof val === 'string' ? oneLine(val, 40) || '(no text)' : String(val);
}

function renderStateVal(val: unknown, depth = 0): React.ReactNode {
  if (val === null || val === undefined) return <span className="sv-nil">–</span>;
  if (typeof val === 'boolean') return <span className={val ? 'sv-true' : 'sv-false'}>{String(val)}</span>;
  if (typeof val === 'number')
    return <span className="sv-num">{Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, '')}</span>;
  if (typeof val === 'string') return val.trim() ? <span className="sv-str">{val}</span> : <span className="sv-nil">(no text)</span>;
  if (depth >= 3)
    return Array.isArray(val)
      ? <span className="sv-more">[{(val as unknown[]).length}]</span>
      : <span className="sv-more">…</span>;
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className="sv-nil">(empty)</span>;
    return (
      <div className="sv-arr">
        {(val as unknown[]).map((item, i) => (
          <div key={i} className="sv-arr-row">
            <span className="sv-idx">{i}</span>
            <div className="sv-cell">{renderStateVal(item, depth + 1)}</div>
          </div>
        ))}
      </div>
    );
  }
  const entries = Object.entries(val as Record<string, unknown>);
  if (entries.length === 0) return <span className="sv-nil">(empty)</span>;
  if (depth === 0) {
    return (
      <div className="sv-obj">
        {entries.map(([k, v]) => (
          <div key={k} className="sv-field">
            <span className="sv-key">{k}:</span>
            <div className="sv-cell">{renderStateVal(v, 1)}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <span className="sv-inline-obj">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && <span className="sv-sep"> · </span>}
          <span className="sv-key">{k}:</span>
          {renderStateVal(v, depth + 1)}
        </span>
      ))}
    </span>
  );
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const H = 8; // handle half-size in px

export default function App() {
  const [status, setStatus]               = useState<AppStatus>('loading');
  const [error, setError]                 = useState('');
  const [windows, setWindows]             = useState<WindowInfo[]>([]);
  const [thumbnails, setThumbnails]       = useState<Record<string, string>>({});
  const [filter, setFilter]               = useState('');
  const [page, setPage]                   = useState(0);
  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  // The last window a session was started on: with none chosen (as after starting FireFly), the Policy
  // Graph is that window's, rather than an empty one that looked as if the graph had gone
  const [lastTitle, setLastTitle] = useState<string | null>(() => { try { return localStorage.getItem('firefly-last-window'); } catch { return null; } });
  useEffect(() => {
    if (!selectedTitle) return;
    setLastTitle(selectedTitle);
    try { localStorage.setItem('firefly-last-window', selectedTitle); } catch { /* quota */ }
  }, [selectedTitle]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ windowId: string; title: string } | null>(null);
  const [createDialog, setCreateDialog]   = useState<{ id?: string; label: string; templates: Template[]; source: 'manual' | 'script'; script: string; scriptWidth?: number; scriptHeight?: number } | null>(null);
  const regionScriptTestVersion = useRef(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [activeButtons, setActiveButtons] = useState<Set<string>>(new Set(DEFAULTS));
  const [recordHz, setRecordHz] = useState(15); // samples a recording aims for each second, 5..30
  const [recording, setRecording]         = useState<RecordingStatus | null>(null);
  const [elapsed, setElapsed]             = useState(0);
  const [frameUrl, setFrameUrl]           = useState<string | null>(null);
  const [regions, setRegionsState]        = useState<Region[]>([]);
  // Every region that follows its object; the runtime matches them all in the same frame. Results
  // arrive with every frame and go into refs, which the canvas draws from; the React state that
  // shows them elsewhere is refreshed at most every 125 ms (40 ms while the Graph View is shown).
  const [trackedIds, setTrackedIdsState]  = useState<ReadonlySet<string>>(new Set());
  const [trackConfs, setTrackConfs]       = useState<Record<string, number>>({});
  const trackConfsRef = useRef<Record<string, number>>({});
  // Kept apart from `regions`, which are the boxes as created and edited and are saved: following
  // an object moves only these, so it neither saves the regions nor recompiles their flows
  const [liveBoxes, setLiveBoxes]         = useState<Record<string, LiveBox>>({});
  const liveBoxesRef = useRef<Record<string, LiveBox>>({});
  const [gameStates, setGameStates]       = useState<GameState[]>([]);
  const gameStatesRef = useRef(gameStates);
  gameStatesRef.current = gameStates;
  const [stateValues, setStateValues]     = useState<Record<string, unknown>>({});
  const [stateReadErrors, setStateReadErrors] = useState<Record<string, string | undefined>>({});
  const [stateDialog, setStateDialog]     = useState<StateDialogData | null>(null);
  const [keyboardOpen, setKeyboardOpen]   = useState(false); // choosing the buttons recorded on a whole keyboard
  const [stateFolders, setStateFolders]   = useState<StateFolder[]>([]);
  const [draggingState, setDraggingState] = useState<string | null>(null); // a State row being dragged
  const [dropFolder, setDropFolder]       = useState<string | null>(null);  // the folder it would go into ('' the top level)
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [scriptPreview, setScriptPreview] = useState<{ result?: unknown; error?: string; running: boolean } | null>(null);
  const scriptTestVersion = useRef(0);
  // Turns States off (not read, run or recorded; a script reading one is told it's off) or on again.
  // What they showed is cleared, so a value from before isn't taken for a current one.
  const setStatesOff = (ids: string[], off: boolean) => {
    const set = new Set(ids);
    setGameStates(prev => prev.map(s => !set.has(s.id) ? s : off ? { ...s, off: true } : (({ off: _, ...rest }) => rest)(s)));
    const clear = <T,>(prev: Record<string, T>) => { const next = { ...prev }; for (const id of ids) delete next[id]; return next; };
    setStateValues(clear); setStateReadErrors(clear);
  };
  const showStateDialog = (draft: StateDialogData | null) => {
    ++scriptTestVersion.current;
    setScriptPreview(null);
    setStateDialog(draft);
  };
  const editState = (s: GameState) => showStateDialog({
    id: s.id, name: s.name, type: s.type, source: s.source,
    regionId: s.regionId ?? '', output: s.output ?? '',
    address: s.address ?? '', offsets: [...(s.offsets ?? [])], byteType: s.byteType ?? 'u32',
    script: s.script ?? DEFAULT_SCRIPT, templateId: s.templateId,
    scriptWidth: s.scriptWidth ?? 0, scriptHeight: s.scriptHeight ?? 0,
    templateIds: s.templateIds === undefined ? undefined : [...s.templateIds],
    folderId: s.folderId,
  });
  const [regionScriptBoxes, setRegionScriptBoxes] = useState<Record<string, ScriptBox[]>>({});
  const regionScriptBoxesRef = useRef<Record<string, ScriptBox[]>>({});
  const [regionReadings, setRegionReadings] = useState<Record<string, ScriptRegionReading>>({});
  const regionReadingsRef = useRef<Record<string, ScriptRegionReading>>({});
  const luaRegionSnapshots = useRef<Record<string, RegionBoxSnapshot>>({});
  const getLuaRegions = useCallback(() => luaRegionSnapshot(regionsRef.current, luaRegionSnapshots.current), []);
  // The memory and Lua States scripts can read as states.Name, each read by the runtime when a script asks for it
  const getLuaStates = useCallback(() => luaStateDefinitions(gameStatesRef.current), []);
  const luaStateItems = useMemo(() => {
    const readable = new Set(luaStateDefinitions(gameStates).map(d => d.id));
    return gameStates.filter(s => readable.has(s.id))
      .map(s => ({ id: s.id, label: s.name, detail: `${s.source === 'memory' ? 'Memory' : 'Lua'} State · ${s.type}` }));
  }, [gameStates]);
  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set());
  const [selSubBox, setSelSubBox] = useState<{ regionId: string; idx: number } | null>(null);
  const [hiddenSubBoxes, setHiddenSubBoxes] = useState<Record<string, Set<number>>>({});
  const hiddenSubBoxesRef = useRef<Record<string, Set<number>>>({});
  // Every instance multi-match found, per region
  const [templateMatchBoxes, setTemplateMatchBoxes] = useState<Record<string, TemplateMatch[]>>({});
  const templateMatchBoxesRef = useRef<Record<string, TemplateMatch[]>>({});
  const [regionScriptPreview, setRegionScriptPreview] = useState<{ boxes?: ScriptBox[]; error?: string; running: boolean } | null>(null);

  // ── Live stream: a minute of history to pause and rewind ──────────────────
  const [frameBuf]                        = useState(() => new FrameBuffer<FrameOverlay>());
  const [view, setViewState]              = useState<StreamView>({ mode: 'live' });
  const [bufSpan, setBufSpan]             = useState({ oldest: 0, newest: 0 });
  const viewRef        = useRef<StreamView>({ mode: 'live' });
  const liveUrlRef     = useRef<string | null>(null);        // newest live frame
  const liveFrameT     = useRef<number | null>(null);        // when the runtime captured it
  const frozenOverlay  = useRef<FrameOverlay | null>(null);  // overlay of the frame a paused view shows
  const liveFrameOverlay = useRef<FrameOverlay | null>(null);
  // Boxes moved or resized while paused: they stay where they were put, whichever frame is shown, until going live
  const pausedEdits    = useRef<Record<string, LiveBox>>({});
  const showToken      = useRef(0);
  const stopping       = useRef(false);                      // capture is being stopped on purpose

  // ── Training ──────────────────────────────────────────────────────────────
  const [bottomTab, setBottomTab]     = useState<'train' | 'models' | 'outputs' | 'values' | 'recordings' | 'play' | 'region'>('train');
  const [trainStatus, setTrainStatus] = useState<'idle' | 'running' | 'paused' | 'done' | 'error'>('idle');
  const [exportState, setExportState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [exportError, setExportError] = useState('');
  // workers: processes reading images while it trains, 0 = automatic (4 with a GPU, none on the CPU);
  // decodeOnce: images decoded into raw files before the first epoch (and deleted afterwards)
  // width x height: the model's input, which images are fitted into keeping their proportions (it used to
  // be one square imgSize, which a saved config may still hold)
  // kind: which model the tab trains; yolo: the detector's own settings (the rest are the UNet's, or shared: GPU, workers)
  const [trainConfig, setTrainConfig] = useState<{ kind: TrainKind; dataDir: string; outDir: string; epochs: number; batch: number; width: number; height: number; base: number; useGpu: boolean; workers: number; decodeOnce: boolean; yolo: YoloTrainConfig }>(() => {
    const yoloDefaults: YoloTrainConfig = { dataDir: '', outDir: 'runs/yolo/train', epochs: 100, batch: 16, model: 'yolo11n', imgsz: 800 };
    const defaults = { kind: 'unet' as TrainKind, dataDir: '', outDir: 'runs/unet', epochs: 50, batch: 4, width: 512, height: 512, base: 32, useGpu: false, workers: 0, decodeOnce: false, yolo: yoloDefaults };
    try {
      const s = localStorage.getItem('firefly-train-config');
      if (s) {
        const { imgSize, ...saved } = JSON.parse(s) as Record<string, unknown>;
        const square = typeof imgSize === 'number' ? { width: imgSize, height: imgSize } : {};
        return { ...defaults, ...square, ...saved, yolo: { ...yoloDefaults, ...(saved.yolo as Partial<YoloTrainConfig> | undefined) } };
      }
    } catch {}
    return defaults;
  });
  // The settings of the model being trained that both have: dataset, output, epochs and batch
  const trainJob = trainConfig.kind === 'yolo' ? trainConfig.yolo : trainConfig;
  const setTrainJob = (patch: Partial<Pick<YoloTrainConfig, 'dataDir' | 'outDir' | 'epochs' | 'batch'>>) =>
    setTrainConfig(c => c.kind === 'yolo' ? { ...c, yolo: { ...c.yolo, ...patch } } : { ...c, ...patch });
  const [yoloBest, setYoloBest] = useState<string | null>(null); // a finished YOLO training's best weights
  const sizeInput = (n: number) => Math.min(2048, Math.max(64, Math.round((+n || 64) / 8) * 8));
  const [checkpointInfo, setCheckpointInfo] = useState<{ found: boolean; epoch?: number; totalEpochs?: number; valIou?: number; map50?: number; best?: string } | null>(null);
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  // Downloading GPU support (the installed app): where it is, and what went wrong
  const [gpuDownload, setGpuDownload] = useState<{ phase: 'download' | 'install' | 'test'; done?: number; total?: number } | null>(null);
  const [gpuError, setGpuError] = useState('');
  const [trainProgress, setTrainProgress] = useState<TrainProgress[]>([]);
  const [trainBatch,    setTrainBatch]    = useState<TrainBatch | null>(null);
  const [datasetCheck,  setDatasetCheck]  = useState<null | 'checking' | { ok: boolean; error?: string; result?: DatasetCheckResult; gridDataUrl?: string }>(null);
  const [trainLogs, setTrainLogs]     = useState<string[]>([]);
  const [trainError, setTrainError]   = useState('');

  // ── Trained models ────────────────────────────────────────────────────────
  const [models, setModelsState]      = useState<TrainedModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [runningModelIds, setRunningModelIds] = useState<string[]>([]); // the models running, in the order they were run
  const [modelLives, setModelLives]   = useState<Record<string, ModelLive>>({}); // each running model's feedback
  const [modelNotice, setModelNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [modelSuggestion, setModelSuggestion] = useState<string | null>(null);
  const [trainedModel, setTrainedModel] = useState<{ model: TrainedModel; existing: boolean } | null>(null);
  const [modelsUnseen, setModelsUnseen] = useState(false); // a training run added a model the user hasn't looked at yet
  const [flowIssues, setFlowIssues] = useState<{ modelId: string; problems: FlowProblem[]; error: FlowError | null } | null>(null);
  const [previewNode, setPreviewNode] = useState<string | null>(null); // step of the live graph drawn on the live view
  const [processedView, setProcessedView] = useState(false);
  const [modelDrawing, setModelDrawing] = useState<ModelDrawing | null>(null);
  const modelDrawingRef = useRef<ModelDrawing | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const showProcessed = processedView || previewNode !== null;
  const [inferenceId, setInferenceId] = useState(() => localStorage.getItem('firefly-inference-device') ?? 'cpu');
  const inferenceRef = useRef(inferenceId);
  const [inferenceDevices, setInferenceDevices] = useState<InferenceDevice[]>([{ id: 'cpu', provider: 'cpu', device: 0, label: 'CPU' }]);
  const [inferenceChanging, setInferenceChanging] = useState(false);
  // How many threads the CPU runs models on: a runtime setting, so it doesn't change the observation schema
  const [cpuThreads, setCpuThreads] = useState(() => Number(localStorage.getItem('firefly-cpu-threads')) || 2);
  const [maxThreads, setMaxThreads] = useState(0);
  const [inferenceError, setInferenceError] = useState('');
  const detectionAt = useRef<number | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const ratesRef = useRef<{ durations: number[]; shown: number }>({ durations: [], shown: 0 });
  const templateAt = useRef<number | null>(null);
  const [detectionAge, setDetectionAge] = useState<number | null>(null);
  const [trackingAge, setTrackingAge] = useState<number | null>(null); // template matching runs on a worker of its own, so it lags on its own
  // What the runtime reports for the live graph, model or not; the regions' values come from here
  const [streamLive, setStreamLive] = useState<StreamLive | null>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null); // the captured window's size in px, as of its last frame
  const [viewTab, setViewTab] = useState<'game' | 'graph'>('game');
  const [regionIssues, setRegionIssues] = useState<{ problems: FlowProblem[]; error: FlowError | null } | null>(null);
  const [valuesRegionId, setValuesRegionId] = useState<string | null>(null);
  const [valuesOutputId, setValuesOutputId] = useState<string | null>(null);
  const [colorPick, setColorPick] = useState<((hex: string) => void) | null>(null); // waiting for a colour to be clicked in the frame
  const colorPickRef = useRef<((hex: string) => void) | null>(null);
  const appliedRegions = useRef('[]'); // the regions' values in the graph the runtime has
  const bottomTabRef      = useRef(bottomTab);
  const viewTabRef        = useRef(viewTab);
  const modelsRef         = useRef<TrainedModel[]>([]);
  const runningModelsRef  = useRef<TrainedModel[]>([]);
  const liveGraphRef      = useRef({ id: 'default', revision: 0 }); // graph the runtime is evaluating
  const modelLiveAt       = useRef(0);
  const applyTimer        = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settingsSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const trainLogRef    = useRef<HTMLDivElement>(null);
  const trainStartTime = useRef<number>(0);
  // When the first batch of this training was reported, and its step: the estimate before an epoch has
  // finished is timed from there, since what comes before (starting Python, loading the dataset, decoding
  // the images once, minutes of it) isn't training, and counted as the first 1% of an epoch it made a
  // 50-epoch run look like 200 hours
  const firstBatch = useRef<{ time: number; step: number } | null>(null);
  const frameUrlRef          = useRef<string | null>(null);
  const trackedIdsRef        = useRef<ReadonlySet<string>>(new Set());

  const changeLuaScript = (editor: 'region' | 'state', script: string) => {
    if (editor === 'region') {
      ++regionScriptTestVersion.current; setRegionScriptPreview(null);
      setCreateDialog(d => d && { ...d, script });
    } else {
      ++scriptTestVersion.current; setScriptPreview(null);
      setStateDialog(d => d && { ...d, script });
    }
  };
  const regionsRef = useRef<Region[]>([]);
  const setRegions = useCallback((u: Region[] | ((p: Region[]) => Region[])) => {
    const next = typeof u === 'function' ? u(regionsRef.current) : u;
    regionsRef.current = next;
    setRegionsState(next);
  }, []);

  const setView = useCallback((v: StreamView) => { viewRef.current = v; setViewState(v); }, []);

  const startedAt = useRef<number | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveImgRef = useRef<HTMLImageElement>(null);

  // Interaction state machine
  const ix = useRef<{
    mode: IxMode; selId: string | null; selBoxIdx: number | null;
    drawStart: {x:number;y:number}|null; drawEnd: {x:number;y:number}|null;
    moveStart: {x:number;y:number}|null; orig: Region|null;
    working: Region|null; handle: Handle|null;
  }>({ mode:'idle', selId:null, selBoxIdx:null, drawStart:null, drawEnd:null, moveStart:null, orig:null, working:null, handle:null });
  // The selection lives in ix, which React doesn't watch, so choosing a region shows its editor through this
  const [, showSelection] = useReducer((n: number) => n + 1, 0);
  // Editing a region happens in the Region tab at the bottom, which choosing or drawing one opens
  const setShowTemplate = useCallback((on: boolean) => { if (on) { setBottomTab('region'); showSelection(); } }, []);
  const [maskFor, setMaskFor] = useState<string | null>(null); // the template whose mask is being painted

  // Keep a ref to the latest frame URL so snapshot callbacks aren't stale
  useEffect(() => { frameUrlRef.current = frameUrl; }, [frameUrl]);

  const setTrackedIds = useCallback((u: (ids: ReadonlySet<string>) => ReadonlySet<string>) => {
    trackedIdsRef.current = u(trackedIdsRef.current);
    setTrackedIdsState(trackedIdsRef.current);
  }, []);

  // What the latest match found for each region. A region's templates are sent with a context of their
  // own, and a result carrying any other context is from before they changed.
  const [templateSnapshots, setTemplateSnapshots] = useState<Record<string, TemplateSnapshot>>({});
  const templateSnapshotsRef = useRef<Record<string, TemplateSnapshot>>({});
  // Where each followed region's box is and how fast it moves, as the runtime works them out
  const [regionMotion, setRegionMotion] = useState<Record<string, RegionMotion>>({});
  const regionMotionRef = useRef<Record<string, RegionMotion>>({});
  // Each template state's answer as it has settled (see settle in templateMatching.ts)
  const [templateSettled, setTemplateSettled] = useState<Record<string, Settled>>({});
  const templateSettledRef = useRef<Record<string, Settled>>({});
  const templateContextsRef = useRef(new Map<string, string>());
  // Shows what the refs hold now
  const publishTracking = useCallback(() => {
    setTrackConfs(trackConfsRef.current);
    setTemplateSnapshots(templateSnapshotsRef.current);
    setTemplateMatchBoxes(templateMatchBoxesRef.current);
    setLiveBoxes(liveBoxesRef.current);
    setRegionMotion(regionMotionRef.current);
    setTemplateSettled(templateSettledRef.current);
  }, []);
  // Shows them once the interval since it last did has passed, so the last result is always shown
  const trackingShownAt = useRef(0);
  const trackingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleTracking = useCallback(() => {
    if (trackingTimer.current) return;
    const due = trackingShownAt.current + 125 - performance.now();
    trackingTimer.current = setTimeout(() => {
      trackingTimer.current = null;
      trackingShownAt.current = performance.now();
      publishTracking();
    }, Math.max(0, due));
  }, [publishTracking]);
  // Forgets what matching last found for a region, or for all of them
  const forgetMatches = useCallback((regionId?: string) => {
    templateMatchBoxesRef.current = without(templateMatchBoxesRef.current, regionId);
    templateSnapshotsRef.current = without(templateSnapshotsRef.current, regionId);
    trackConfsRef.current = without(trackConfsRef.current, regionId);
    regionMotionRef.current = without(regionMotionRef.current, regionId);
    const settled = { ...templateSettledRef.current };
    for (const s of gameStatesRef.current) if (regionId === undefined || s.regionId === regionId) delete settled[s.id];
    templateSettledRef.current = settled;
    publishTracking();
  }, [publishTracking]);

  const stopTracking = useCallback((regionId: string) => {
    if (!trackedIdsRef.current.has(regionId)) return;
    templateContextsRef.current.delete(regionId);
    // The box stays where its object was last found. That's the region editor changing the box, so it's saved.
    const box = liveBoxesRef.current[regionId];
    if (box) {
      liveBoxesRef.current = without(liveBoxesRef.current, regionId);
      setRegions(regs => regs.map(r => r.id === regionId ? { ...r, ...box } : r));
    }
    setTrackedIds(ids => { const next = new Set(ids); next.delete(regionId); return next; });
    window.bridge.invoke('template.remove', { region: regionId }).catch(() => {});
    forgetMatches(regionId);
    if (!trackedIdsRef.current.size) { templateAt.current = null; setTrackingAge(null); }
  }, [setTrackedIds, forgetMatches, setRegions]);

  // Stops following every region, as when capture starts on a window
  const stopAllTracking = useCallback(() => {
    templateContextsRef.current.clear();
    liveBoxesRef.current = {};
    setTrackedIds(() => new Set());
    window.bridge.invoke('template.clear').catch(() => {});
    forgetMatches();
    templateAt.current = null; setTrackingAge(null);
  }, [setTrackedIds, forgetMatches]);

  // Hands the runtime what to follow a region's object by: templates of it, or the two corners its box
  // stretches between. The other regions it follows carry on as they were.
  const syncTemplates = useCallback((regionId: string) => {
    const context = crypto.randomUUID();
    templateContextsRef.current.set(regionId, context);
    forgetMatches(regionId);
    const region = regionsRef.current.find(r => r.id === regionId);
    const png = (t: Template) => t.cropUrl.split(',')[1];
    const corners = region && fitsCorners(region) ? region.corners : undefined;
    window.bridge.invoke('template.set', corners ? {
      region: regionId, context,
      templates: [{ key: corners.tl.id, role: 'tl', data: png(corners.tl) }, { key: corners.br.id, role: 'br', data: png(corners.br) }],
      multiMatch: false,
      threshold: region ? matchThreshold(region) : 0.75,
      reach: region ? searchReach(region) ?? -1 : -1,
      hint: corners.at,
      largest: { w: Math.min(1, corners.box.w * FIT_GROWTH), h: Math.min(1, corners.box.h * FIT_GROWTH) },
    } : {
      region: regionId, context,
      templates: (region?.templates ?? []).map(t => ({ key: t.id, data: png(t), ...(t.maskUrl ? { mask: t.maskUrl.split(',')[1] } : {}) })),
      multiMatch: region?.multiMatch ?? false,
      preprocess: region?.matchOn ?? 'color',
      threshold: region ? matchThreshold(region) : 0.75,
      reach: region ? searchReach(region) ?? -1 : -1,
      // Looking only near where it was starts from where the box is now
      ...(region ? { hint: (({ x, y, w, h }) => ({ x, y, w, h }))(placedAt(region, liveBoxesRef.current)) } : {}),
    }).catch(() => {});
  }, [forgetMatches]);

  // Sends a region's templates again once a control that's being dragged, such as the threshold, has settled
  const syncTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const syncTemplatesSoon = useCallback((regionId: string) => {
    clearTimeout(syncTimers.current.get(regionId));
    syncTimers.current.set(regionId, setTimeout(() => {
      syncTimers.current.delete(regionId);
      if (trackedIdsRef.current.has(regionId)) syncTemplates(regionId);
    }, 150));
  }, [syncTemplates]);

  const startTracking = useCallback((regionId: string) => {
    const region = regionsRef.current.find(r => r.id === regionId);
    if (!region || !hasAnchors(region)) return;
    syncTemplates(regionId);
    setTrackedIds(ids => new Set(ids).add(regionId));
  }, [syncTemplates, setTrackedIds]);

  // Where a region's box is on screen, which is what it's grabbed, drawn and cut a template by: paused, where it
  // was when that frame was captured, or where it's been put since; live, where its object was followed to
  const shownAt = useCallback((r: Region): Region => {
    const frozen = frozenOverlay.current;
    if (!frozen) return placedAt(r, liveBoxesRef.current);
    const box = pausedEdits.current[r.id] ?? frozen.boxes[r.id];
    return box ? { ...r, ...box } : r; // made after that frame: where it was put
  }, []);

  const addTemplate = useCallback((regionId: string, boundsOverride?: { x: number; y: number; w: number; h: number }) => {
    const region = regionsRef.current.find(r => r.id === regionId);
    const url    = frameUrlRef.current;
    if (!region || !url) return;
    // The box as it's shown over the frame on screen, which is the frame the template is cut from
    const bounds = region.source === 'script' ? boundsOverride : boundsOverride ?? shownAt(region);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    const img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const cx = Math.round(bounds.x * iw), cy = Math.round(bounds.y * ih);
      const cw = Math.max(1, Math.round(bounds.w * iw)), ch = Math.max(1, Math.round(bounds.h * ih));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d')!.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      const cropUrl = c.toDataURL('image/png');
      const tid = crypto.randomUUID();
      // setRegions updates regionsRef synchronously, so the new template is available immediately after
      setRegions(regs => regs.map(r => r.id === regionId ? { ...r, templates: [...r.templates, { id: tid, cropUrl }] } : r));
      setShowTemplate(true);
      // The region may have been switched off, or deleted, while the frame loaded
      const current = regionsRef.current.find(r => r.id === regionId);
      if (!current || (current.source !== 'script' && !current.match)) return;
      // startTracking reads regionsRef which was updated synchronously by setRegions above
      startTracking(regionId);
    };
    img.src = url;
  }, [setRegions, startTracking, shownAt]);

  // Template matching makes a region follow its object; off, the box stays where it was put. Any
  // number of regions can follow their objects at once.
  const setRegionMatching = useCallback((regionId: string, on: boolean) => {
    const region = regionsRef.current.find(r => r.id === regionId);
    if (!region) return;
    if (!on) {
      setRegions(regs => regs.map(r => r.id === regionId ? { ...r, match: false } : r));
      stopTracking(regionId);
      return;
    }
    if (!hasAnchors(region) && !frameUrlRef.current) return; // no frame to take a template from
    setRegions(regs => regs.map(r => r.id === regionId ? { ...r, match: true } : r));
    if (!hasAnchors(region)) addTemplate(regionId);
    else startTracking(regionId);
  }, [setRegions, stopTracking, startTracking, addTemplate]);

  // Cuts a patch from each corner of a region's box in the frame on screen, and from then on the box
  // stretches between where the patches are found: it grows and shrinks with its object, such as a
  // mini map that changes size. The box should be drawn tight around the object, and what is inside
  // a patch has to look the same at every size the object takes.
  const snapCorners = useCallback((regionId: string, size?: number) => {
    const saved = regionsRef.current.find(r => r.id === regionId);
    const region = saved && shownAt(saved);
    const url = frameUrlRef.current;
    if (!region || !url) return;
    const img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const x = Math.round(region.x * iw), y = Math.round(region.y * ih);
      const w = Math.max(1, Math.round(region.w * iw)), h = Math.max(1, Math.round(region.h * ih));
      const n = Math.max(4, Math.min(size ?? region.corners?.size ?? CORNER_SIZE, Math.floor(Math.min(w, h) / 2)));
      let plain = false;
      const cut = (sx: number, sy: number): Template => {
        const c = document.createElement('canvas');
        c.width = n; c.height = n;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(img, sx, sy, n, n, 0, 0, n, n);
        // A patch of one flat colour matches flat areas everywhere, so it can't be told from them
        const px = g.getImageData(0, 0, n, n).data;
        let sum = 0, sum2 = 0;
        for (let i = 0; i < px.length; i += 4) {
          const luma = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          sum += luma; sum2 += luma * luma;
        }
        const count = px.length / 4;
        if (Math.sqrt(Math.max(0, sum2 / count - (sum / count) ** 2)) < 4) plain = true;
        return { id: crypto.randomUUID(), cropUrl: c.toDataURL('image/png') };
      };
      const corners: Corners = {
        tl: cut(x, y), br: cut(x + w - n, y + h - n), size: n, plain,
        at: { x: region.x, y: region.y }, box: { w: region.w, h: region.h },
      };
      // Matching every instance asks something else of the templates, so corners take its place
      setRegions(regs => regs.map(r => r.id === regionId ? { ...r, x: region.x, y: region.y, w: region.w, h: region.h, fit: true, corners, multiMatch: false } : r));
      if (region.multiMatch) forgetMatches(regionId);
      setShowTemplate(true);
      // The region may have been switched off, or deleted, while the frame loaded
      const current = regionsRef.current.find(r => r.id === regionId);
      if (!current || !current.match) return;
      startTracking(regionId);
    };
    img.src = url;
  }, [setRegions, startTracking, forgetMatches, shownAt]);

  // Lets the box of a region that follows its object grow and shrink with it, by its corners; off, it keeps its template's size
  const setRegionFit = useCallback((regionId: string, on: boolean) => {
    if (on) { snapCorners(regionId); return; }
    setRegions(regs => regs.map(r => r.id === regionId ? { ...r, fit: false, corners: undefined } : r));
    if (trackedIdsRef.current.has(regionId)) syncTemplates(regionId);
  }, [setRegions, snapCorners, syncTemplates]);

  // ── Values read from a region ─────────────────────────────────────
  // The most common clearly coloured colour in a region's box on the frame on screen: a good
  // first guess at what to look for, such as the fill of a bar
  const guessColor = useCallback((region: Region) => new Promise<string>(resolve => {
    const url = frameUrlRef.current;
    if (!url) { resolve('#ff0000'); return; }
    const img = new Image();
    img.onload = () => {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const w = Math.max(1, Math.round(region.w * iw)), h = Math.max(1, Math.round(region.h * ih));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, Math.round(region.x * iw), Math.round(region.y * ih), w, h, 0, 0, w, h);
      resolve(dominantColor(g.getImageData(0, 0, w, h).data) ?? '#ff0000');
    };
    img.onerror = () => resolve('#ff0000');
    img.src = url;
  }), []);

  // Adds a value read from a region's box, starting from a template, and returns its name
  const addRegionValue = useCallback((regionId: string, templateId: string, wanted?: string): string | null => {
    const region = regionsRef.current.find(r => r.id === regionId);
    const template = REGION_TEMPLATES.find(t => t.id === templateId);
    if (!region || !template) return null;
    const compiled = compileLive(runningModelsRef.current, regionSources(regionsRef.current));
    const taken = new Set<string>(RESERVED_NAMES);
    compiled.models.forEach(m => m.recorded.forEach(o => taken.add(o.name)));
    compiled.regions.forEach(r => r.recorded.forEach(o => taken.add(o.name)));
    const base = (wanted?.trim() || template.label.toLowerCase()).slice(0, 70);
    let name = base, n = 2;
    while (taken.has(name)) name = `${base} ${n++}`;
    (template.usesColor ? guessColor(region) : Promise.resolve('#ff0000')).then(color => {
      const outputs = template.build(() => `${regionKey(regionId)}_${crypto.randomUUID().slice(0, 8)}`, name, color);
      setRegions(regs => regs.map(r => r.id === regionId
        ? { ...r, flow: { version: 1, thickness: 2, ...r.flow, outputs: [...(r.flow?.outputs ?? []), ...outputs] } } : r));
      setValuesOutputId(outputs[0].id);
    });
    return name;
  }, [guessColor, setRegions]);

  const setRegionFlow = useCallback((regionId: string, flow: Flow) =>
    setRegions(regs => regs.map(r => r.id === regionId ? { ...r, flow } : r)), [setRegions]);

  const openValues = useCallback((regionId: string) => {
    setValuesRegionId(regionId); setValuesOutputId(null); setBottomTab('values');
  }, []);

  // Waits for a colour to be clicked in the frame on screen. A previewed step tints the
  // frame, so the preview is cleared first and the click waits for a plain frame.
  const startColorPick = useCallback((apply: (hex: string) => void) => {
    const arm = () => { colorPickRef.current = apply; setColorPick(() => apply); };
    if (previewNode || processedView) { setPreviewNode(null); setProcessedView(false); setTimeout(arm, 400); } else arm();
  }, [previewNode, processedView]);

  // ── Trained model library ─────────────────────────────────────────
  const setModels = useCallback((next: TrainedModel[]) => {
    modelsRef.current = next;
    setModelsState(next);
    runningModelsRef.current = runningModelsRef.current.map(m => next.find(x => x.id === m.id) ?? m);
  }, []);

  const refreshModels = useCallback(async () => {
    setModels(await window.bridge.models.list());
  }, [setModels]);

  // Point the runtime's per-frame graph at the running models, or back to the plain frame
  const applyLiveGraph = useCallback(async (models: TrainedModel[]) => {
    const prev = liveGraphRef.current;
    const sources = regionSources(regionsRef.current);
    const graph = liveGraph(models, prev.revision + 1, sources, inferenceChoice(inferenceRef.current));
    liveGraphRef.current = { id: graph.id, revision: graph.revision };
    modelDrawingRef.current = null; setModelDrawing(null);
    try {
      await window.bridge.invoke('graph.apply', { graph });
      appliedRegions.current = JSON.stringify(sources);
    } catch (e) {
      if (liveGraphRef.current.revision === graph.revision) liveGraphRef.current = prev;
      throw e;
    }
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    let alive = true;
    window.bridge.invoke('inference.devices').then(async (res: any) => {
      if (!alive) return;
      if (Array.isArray(res.devices)) setInferenceDevices(res.devices);
      // The saved thread count, within what this machine has
      const max = Number(res.maxThreads) || 0;
      setMaxThreads(max);
      if (max) {
        const threads = Math.min(max, Math.max(1, Number(localStorage.getItem('firefly-cpu-threads')) || 2));
        await window.bridge.invoke('inference.threads', { threads });
        if (alive) setCpuThreads(threads);
      }
    }).catch(e => { if (alive) setInferenceError(String(e)); });
    return () => { alive = false; };
  }, [status]);

  const changeThreads = async (threads: number) => {
    setInferenceError('');
    try {
      await window.bridge.invoke('inference.threads', { threads });
      setCpuThreads(threads);
      localStorage.setItem('firefly-cpu-threads', String(threads));
    } catch (e) { setInferenceError(String(e)); }
  };

  const changeInference = async (id: string) => {
    if (recording?.active || inferenceChanging) return;
    const previous = inferenceRef.current;
    inferenceRef.current = id;
    setInferenceChanging(true); setInferenceError('');
    try {
      await applyLiveGraph(runningModelsRef.current);
      setInferenceId(id);
      localStorage.setItem('firefly-inference-device', id);
      setModelLives(Object.fromEntries(runningModelsRef.current.map(m => [m.id, { modelId: m.id, phase: 'loading' as const }])));
    } catch (e) { inferenceRef.current = previous; setInferenceError(String(e)); }
    finally { setInferenceChanging(false); }
  };

  // Which models run on the live capture, all in one graph, each frame going through one after another. The
  // ones already running keep their feedback; one that fails to start (started) is reported on it.
  const setRunningModels = useCallback(async (next: TrainedModel[], started: TrainedModel | null = null) => {
    clearTimeout(applyTimer.current);
    const prev = runningModelsRef.current;
    runningModelsRef.current = next;
    setRunningModelIds(next.map(m => m.id));
    setPreviewNode(null);
    setModelLives(lives => Object.fromEntries(next.map(m => [m.id,
      m.id !== started?.id && lives[m.id]?.phase === 'running' ? lives[m.id] : { modelId: m.id, phase: 'loading' as const }])));
    modelLiveAt.current = 0;
    try {
      await applyLiveGraph(next);
    } catch (e) {
      runningModelsRef.current = prev;
      setRunningModelIds(prev.map(m => m.id));
      const msg = String(e).replace(/^Error: /, '');
      if (started) setModelLives(lives => ({ ...lives, [started.id]: { modelId: started.id, phase: 'error', error: msg } }));
      else setError(msg);
    }
  }, [applyLiveGraph]);
  const runModel = useCallback((model: TrainedModel) =>
    setRunningModels([...runningModelsRef.current.filter(m => m.id !== model.id), model], model), [setRunningModels]);
  const stopModel = useCallback((id: string) =>
    setRunningModels(runningModelsRef.current.filter(m => m.id !== id)), [setRunningModels]);

  // Threshold and output edits are saved shortly after, and re-applied live
  // when the model is running (the flow check below reports what fails)
  const updateModelSettings = useCallback((id: string, patch: { threshold?: number; flow?: Flow }) => {
    const next = modelsRef.current.map(m => m.id === id ? { ...m, ...patch } : m);
    setModels(next);
    const model = next.find(m => m.id === id);
    if (!model) return;
    clearTimeout(settingsSaveTimers.current[id]);
    settingsSaveTimers.current[id] = setTimeout(async () => {
      const res = await window.bridge.models.update(id, { threshold: model.threshold, flow: modelFlow(model) });
      if (!res.ok) setModelNotice({ kind: 'error', text: res.error ?? 'Saving outputs failed' });
    }, 400);
    if (runningModelsRef.current.some(m => m.id === id)) {
      clearTimeout(applyTimer.current);
      applyTimer.current = setTimeout(() => { applyLiveGraph(runningModelsRef.current).catch(() => {}); }, 150);
    }
  }, [setModels, applyLiveGraph]);

  // What a model runs on (null: the toolbar's choice). A running model moves at once; if it can't start
  // there, it goes back to where it was and says why.
  const setModelDevice = useCallback(async (id: string, device: string | null) => {
    const before = modelsRef.current.find(m => m.id === id);
    if (!before) return;
    const withDevice = (m: TrainedModel, d: string | null): TrainedModel => { const { device: _, ...rest } = m; return d ? { ...rest, device: d } : rest; };
    const put = (d: string | null) => setModels(modelsRef.current.map(m => m.id === id ? withDevice(m, d) : m));
    put(device);
    if (runningModelsRef.current.some(m => m.id === id)) {
      setModelLives(lives => ({ ...lives, [id]: { modelId: id, phase: 'loading' } }));
      try { await applyLiveGraph(runningModelsRef.current); }
      catch (e) {
        put(before.device ?? null);
        await applyLiveGraph(runningModelsRef.current).catch(() => {});
        setModelNotice({ kind: 'error', text: `“${before.name}” couldn't run there: ${String(e).replace(/^Error: /, '')}` });
        return;
      }
    }
    const res = await window.bridge.models.update(id, { device });
    if (!res.ok) setModelNotice({ kind: 'error', text: res.error ?? 'Saving the device failed' });
  }, [setModels, applyLiveGraph]);

  const renameModel = useCallback(async (id: string, name: string) => {
    const res = await window.bridge.models.update(id, { name });
    if (res.ok && res.model) setModels(modelsRef.current.map(m => m.id === id ? { ...m, name: res.model!.name } : m));
    else setModelNotice({ kind: 'error', text: res.error ?? 'Rename failed' });
  }, [setModels]);

  const importModel = useCallback(async (src?: string, hints?: { trained?: boolean }) => {
    const file = src ?? await window.bridge.pickFile();
    if (!file) return;
    setModelNotice({ kind: 'info', text: 'Importing…' });
    const res = await window.bridge.models.import(file, hints);
    if (!res.ok || !res.model) { setModelNotice({ kind: 'error', text: res.error ?? 'Import failed' }); return; }
    await refreshModels();
    setSelectedModelId(res.model.id);
    setModelNotice(res.existing ? { kind: 'info', text: `Already in your library as “${res.model.name}”` } : null);
  }, [refreshModels]);

  const deleteModel = useCallback(async (id: string) => {
    if (runningModelsRef.current.some(m => m.id === id)) {
      await stopModel(id);
      if (runningModelsRef.current.some(m => m.id === id)) return; // couldn't stop it
    }
    clearTimeout(settingsSaveTimers.current[id]);
    const res = await window.bridge.models.remove(id);
    if (!res.ok) { setModelNotice({ kind: 'error', text: res.error ?? 'Delete failed' }); return; }
    setModels(modelsRef.current.filter(m => m.id !== id));
    setTrainedModel(t => t?.model.id === id ? null : t);
  }, [stopModel, setModels]);

  // A training run (or ONNX export) produced a model: select it and flag the tab until it's opened
  const noteTrainedModel = useCallback((model: TrainedModel, existing: boolean) => {
    refreshModels();
    setTrainedModel({ model, existing });
    setSelectedModelId(model.id);
    if (!existing && bottomTabRef.current !== 'models') setModelsUnseen(true);
  }, [refreshModels]);

  useEffect(() => {
    bottomTabRef.current = bottomTab;
    if (bottomTab === 'models') setModelsUnseen(false);
  }, [bottomTab]);

  useEffect(() => { viewTabRef.current = viewTab; }, [viewTab]);

  useEffect(() => { refreshModels(); }, [refreshModels]);

  // The regions' values as the graph takes them: their boxes and flows
  const regionValuesKey = useMemo(() => JSON.stringify(regionSources(regions)), [regions]);
  const isRecordingNow = recording?.active === true;

  // Check the outputs of the model being edited and the regions' values: problems
  // the compiler finds, then the runtime's own validation of the steps
  useEffect(() => {
    if (status !== 'ready') { setFlowIssues(null); setRegionIssues(null); return; }
    const model = models.find(m => m.id === selectedModelId) ?? models.find(m => runningModelIds.includes(m.id)) ?? models[0] ?? null;
    // The edited model where it runs, or after the running ones: names they record are taken
    const running = runningModelIds.map(id => models.find(m => m.id === id)).filter((m): m is TrainedModel => !!m);
    const list = !model || running.some(m => m.id === model.id) ? running : [...running, model];
    let alive = true;
    const timer = setTimeout(async () => {
      const sources = regionSources(regionsRef.current);
      const compiled = compileLive(list, sources);
      const prefix = model ? modelPrefix(model, list) : '';
      let error: FlowError | null = null;
      try { await window.bridge.invoke('graph.validate', { graph: liveGraph(list, 1, sources, inferenceChoice(inferenceRef.current)) }); }
      catch (e) { error = graphError(prefix ? String(e).split(prefix).join('') : String(e)); }
      if (!alive) return;
      // A step's error belongs to the flow it names; one about the whole graph is shown to both
      const regionError = !!error?.output && sources.some(r => r.flow.outputs.some(o => o.id === error!.output));
      setFlowIssues(model ? { modelId: model.id, problems: compiled.models.get(model.id)?.problems ?? [], error: regionError ? null : error } : null);
      setRegionIssues({
        problems: [...compiled.regions.values()].flatMap(r => r.problems),
        error: error && (regionError || !error.output) ? error : null,
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [models, selectedModelId, runningModelIds, status, regionValuesKey]);

  useEffect(() => {
    if (status !== 'ready' || !captureActive) return;
    window.bridge.invoke('graph.preview', { node: previewNode }).catch(() => {});
  }, [previewNode, captureActive, status]);

  // The graph follows the regions' values: their boxes and steps. Recordings keep
  // the observations they started with, so changes wait for them to stop.
  useEffect(() => {
    if (!captureActive || isRecordingNow || regionValuesKey === appliedRegions.current) return;
    const timer = setTimeout(() => { applyLiveGraph(runningModelsRef.current).catch(() => {}); }, 200);
    return () => clearTimeout(timer);
  }, [regionValuesKey, captureActive, isRecordingNow, applyLiveGraph]);

  // Which observations recordings hold. Everything observed stays available to States and to playing a
  // policy; what's left out here only isn't recorded. A choice is kept per window by name, and an
  // observation nobody chose for is recorded unless it's an image, which the trainer can't use.
  const [observedFields, setObservedFields] = useState<{ name: string; type: string }[]>([]);
  const [recordChoices, setRecordChoices] = useState<Record<string, boolean>>({});
  const [probeMs, setProbeMs] = useState<Record<string, number>>({}); // how long each memory or Lua State took to read
  const isRecorded = useCallback((f: { name: string; type: string }) => recordChoices[f.name] ?? f.type !== 'image', [recordChoices]);
  const excludedKey = useMemo(() => JSON.stringify(observedFields.filter(f => !isRecorded(f)).map(f => f.name).sort()),
    [observedFields, isRecorded]);
  useEffect(() => {
    if (!captureActive || isRecordingNow) return;
    let alive = true;
    const read = () => window.bridge.invoke('observe.fields').then((r: any) => {
      if (!alive || !Array.isArray(r.fields)) return;
      const fields = (r.fields as { name: string; type: string }[]).map(({ name, type }) => ({ name, type }));
      setObservedFields(cur => JSON.stringify(cur) === JSON.stringify(fields) ? cur : fields);
    }).catch(() => {});
    void read();
    const timer = setInterval(read, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [captureActive, isRecordingNow]);
  useEffect(() => {
    if (!captureActive || isRecordingNow) return;
    const timer = setTimeout(() => {
      window.bridge.invoke('observe.recorded', { exclude: JSON.parse(excludedKey) })
        .catch(e => setError(`Recorded observations: ${String(e)}`));
    }, 150);
    return () => clearTimeout(timer);
  }, [excludedKey, captureActive, isRecordingNow]);

  // What the States read from followed regions are recorded too, beside the graph's observations: each
  // state's position, velocity or detected templates, named after it. The runtime takes them only
  // between recordings, since they're part of what a recording's schema says it holds.
  // Every State as a recorded observation: what the runtime reads itself (a followed region's position,
  // velocity or templates, a memory address, a Lua script) under the State's name, and what the graph
  // publishes (a region's value, a model output) under that output's name
  const recordedStates = useMemo(() => {
    const seen = new Set<string>();
    const unique = (base: string) => { let name = base, n = 2; while (seen.has(name)) name = `${base} ${n++}`; seen.add(name); return name; };
    const definitions: Record<string, unknown>[] = [];
    const observationOf: Record<string, string | null> = {};
    for (const s of gameStates) {
      if (s.off) { observationOf[s.id] = null; continue; } // nothing is read for it, so nothing is recorded
      if (s.source === 'memory') {
        if (!s.address) { observationOf[s.id] = null; continue; }
        const name = unique(s.observationName ?? s.name);
        definitions.push({ name, value: 'memory', address: s.address, offsets: s.offsets ?? [], byteType: s.byteType ?? 'u32' });
        observationOf[s.id] = name;
      } else if (s.source === 'script') {
        if (!s.script) { observationOf[s.id] = null; continue; }
        const name = unique(s.observationName ?? s.name);
        definitions.push({ name, value: 'script', script: s.script, type: s.type, scriptWidth: s.scriptWidth ?? 0, scriptHeight: s.scriptHeight ?? 0 });
        observationOf[s.id] = name;
      } else if (s.source === 'region') {
        const region = regions.find(r => r.id === s.regionId);
        const value = s.output === REGION_POSITION ? 'position' : s.output === REGION_VELOCITY ? 'velocity' : s.output === REGION_MATCHES ? 'matches'
          : s.output === TEMPLATE_DETECTED ? 'detected' : null;
        if (!value) { observationOf[s.id] = s.output ?? null; continue; } // one of the region's values, published by the graph
        if (!region) { observationOf[s.id] = null; continue; }
        const name = unique(s.observationName ?? s.name);
        const ids = selectedTemplateIds(s);
        definitions.push({ name, region: region.id, value,
          ...(value === 'detected' ? { templates: ids === undefined ? null : ids.filter(id => region.templates.some(t => t.id === id)),
            settleMs: s.settleMs ?? TEMPLATE_SETTLE_MS } : {}) });
        observationOf[s.id] = name;
      } else {
        // A model output published by the graph; the model's detected area is only shown, never published
        const output = s.output ?? COVERAGE;
        observationOf[s.id] = output === COVERAGE ? null : output;
      }
    }
    return { definitions, observationOf };
  }, [gameStates, regions]);
  // What the Policy Graph is built from: every State's observation with its type, and whatever else
  // FireFly observes now (whose types, when it's capturing, are the ones that count)
  const policyObserved = useMemo(() => {
    const typeOf: Partial<Record<StateType, string>> = { number: 'number', boolean: 'boolean', vector: 'vector', collection: 'shapes', text: 'text', image: 'image' };
    const observed: Record<string, string> = {};
    for (const s of gameStates) {
      const observation = recordedStates.observationOf[s.id], type = typeOf[s.type];
      if (observation && type) observed[observation] = type;
    }
    for (const f of observedFields) observed[f.name] = f.type;
    return observed;
  }, [gameStates, recordedStates, observedFields]);
  const trackedKey = useMemo(() => JSON.stringify(recordedStates.definitions), [recordedStates]);
  useEffect(() => {
    if (!captureActive || isRecordingNow) return;
    const timer = setTimeout(() => {
      window.bridge.invoke('observe.tracked', { observations: JSON.parse(trackedKey) })
        .catch(e => setError(`Recording States: ${String(e)}`));
    }, 150);
    return () => clearTimeout(timer);
  }, [trackedKey, captureActive, isRecordingNow]);

  // While the library is empty, offer a model left in the training output folder
  useEffect(() => {
    if (bottomTab !== 'models' || models.length > 0 || !trainConfig.outDir) { setModelSuggestion(null); return; }
    let alive = true;
    window.bridge.models.probe(trainConfig.outDir).then(p => { if (alive) setModelSuggestion(p); });
    return () => { alive = false; };
  }, [bottomTab, models.length, trainConfig.outDir]);

  // ── Runtime connection ────────────────────────────────────────────
  useEffect(() => {
    const offs: (() => void)[] = [];
    offs.push(window.bridge.on('runtime:ready',        () => setStatus('ready')));
    offs.push(window.bridge.on('runtime:disconnected', () => {
      setStatus('error'); setError('Runtime process exited unexpectedly.');
      setCaptureActive(false); setRecording(null);
    }));
    offs.push(window.bridge.on('runtime:error', (msg: unknown) => { setStatus('error'); setError(String(msg)); }));
    offs.push(window.bridge.on('runtime:event', (msg: unknown) => {
      const { event, result } = msg as { event: string; result: any };
      if (event === 'recording') { setRecording(result); return; }
      if (event === 'detection-status') {
        detectionAt.current = result.timestamp;
        // Shown twice a second at most; the graph's time is the median of its last 15 frames, so one slow frame doesn't show
        const r = ratesRef.current;
        if (typeof result.durationMs === 'number') r.durations = [...r.durations.slice(-14), result.durationMs];
        const now = performance.now();
        if (now - r.shown > 500 && typeof result.frameHz === 'number') {
          r.shown = now;
          const sorted = [...r.durations].sort((a, b) => a - b);
          setRates({ frameHz: result.frameHz, detectionHz: result.detectionHz ?? 0, detectionMs: sorted[sorted.length >> 1] ?? 0 });
        }
        return;
      }
      if (event === 'detection-error') { setError(`Detection: ${result.message}`); return; }
      if (event === 'capture-error') { setCaptureActive(false); setError(result.message); return; }
      if (event === 'observations') {
        const graph = liveGraphRef.current;
        if (result?.schema?.id !== graph.id || result?.schema?.version !== graph.revision) return;
        // Drawings update at detection speed, independent of the throttled
        // inspector readouts and of raw frame delivery. Never bake them into capture.
        const drawing = result.displayOverlay as ModelDrawing | null | undefined;
        modelDrawingRef.current = drawing ?? null;
        setModelDrawing(drawing ?? null);
        const now = performance.now();
        // Arrives every frame; 8 Hz is plenty for readouts and states, but the Graph View shows motion
        if (now - modelLiveAt.current < 125) return;
        modelLiveAt.current = now;
        const observations: ModelLive['observations'] = {};
        for (const o of result.observations ?? []) observations[o.name] = o;
        setStreamLive({ observations, nodes: result.nodes ?? {}, preview: result.preview ?? null, latencyMs: result.latencyMs });
        setProbeMs(result.probeMs && typeof result.probeMs === 'object' ? result.probeMs as Record<string, number> : {});
        const frame = result.nodes?.frame;
        if (frame?.valid && frame.value) {
          const { width: w, height: h } = frame.value as { width: number; height: number };
          setFrameSize(cur => cur && cur.w === w && cur.h === h ? cur : { w, h });
        }
        const running = runningModelsRef.current;
        if (!running.length) return;
        const lives: Record<string, ModelLive> = {};
        for (const model of running) {
          const prefix = modelPrefix(model, running);
          const nodes = ownNodes<NodeResult>(result.nodes ?? {}, prefix);
          const { mask, detect, coverage } = nodes;
          const core = mask ?? detect; // the segmentation or detector step
          const preview = result.preview && typeof result.preview.node === 'string' && result.preview.node.startsWith(prefix)
            ? { ...result.preview, node: result.preview.node.slice(prefix.length) } : null;
          lives[model.id] = core && !core.valid
            ? { modelId: model.id, phase: 'error', error: String(core.reason ?? 'Model failed') }
            : {
                modelId: model.id, phase: 'running', latencyMs: result.latencyMs,
                coverage: coverage?.valid ? coverage.value as number : null,
                observations, nodes, preview,
              };
        }
        setModelLives(lives);
        return;
      }
      if (event === 'template.match') {
        // One result per region, all from the same frame
        const boxes = { ...templateMatchBoxesRef.current }, confs = { ...trackConfsRef.current };
        const snapshots = { ...templateSnapshotsRef.current }, moves: Record<string, LiveBox> = {};
        const found: Record<string, boolean> = {}; // whether the region's object is there at all this frame
        const motion = { ...regionMotionRef.current };
        const vector = (v: unknown): [number, number] | null => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number') ? [v[0], v[1]] : null;
        let any = false;
        const updated = new Set<string>();
        for (const r of Array.isArray(result.regions) ? result.regions : []) {
          const rid = r?.region;
          if (typeof rid !== 'string' || !trackedIdsRef.current.has(rid) || r.context !== templateContextsRef.current.get(rid)) continue;
          any = true; updated.add(rid);
          const region = regionsRef.current.find(x => x.id === rid);
          if (r.error) setError(`Following ${region?.label ?? 'a region'}: ${r.error}`);
          const list = Array.isArray(r.matches) ? r.matches as TemplateMatch[] : [];
          const best = Array.isArray(r.matches) ? strongestMatch(list)
            : r.found !== false && Number(r.confidence) >= (region ? matchThreshold(region) : 0.45) ? r as TemplateMatch : undefined;
          // Lua Regions own their geometry; template events must not replace their empty result.
          if (region?.source !== 'script') {
            if (!r.error) luaRegionSnapshots.current[rid] = { boxes: Array.isArray(r.matches) ? list : best ? [best] : [], timestamp: result.timestamp ?? 0 };
            else delete luaRegionSnapshots.current[rid];
          }
          // How well the best place matched, even when it's under the threshold, so the threshold can be chosen by it
          confs[rid] = best?.confidence ?? (Number(r.confidence) || 0);
          // Script output is the overlay for a Lua Region, even when that output is empty.
          boxes[rid] = region?.source === 'script' ? [] : list;
          // Corner fitting has no whole-template identity, so it cannot supply template states.
          // Following one object, every template that won a place of its own is there, not only the best,
          // so each of the region's template states can be true at once
          const detected = Array.isArray(r.detected) && region
            ? (r.detected as TemplateMatch[]).filter(m => m.confidence >= matchThreshold(region)) : best ? [best] : [];
          if (region && !fitsCorners(region)) snapshots[rid] = { regionId: rid, matches: Array.isArray(r.matches) ? list : detected };
          else delete snapshots[rid];
          if (best) moves[rid] = { x: best.x, y: best.y, w: best.w, h: best.h };
          // Multi-match finding nothing is an answer (none there); following one object, it's not knowing
          found[rid] = Array.isArray(r.matches) || !!best;
          // The runtime's, which only counts a match that reached the threshold
          motion[rid] = best ? { position: vector(r.position), velocity: vector(r.velocity) } : { position: null, velocity: null };
        }
        if (!any) return;
        templateAt.current = typeof result.timestamp === 'number' ? result.timestamp : null;
        templateMatchBoxesRef.current = boxes;
        trackConfsRef.current = confs;
        templateSnapshotsRef.current = snapshots;
        regionMotionRef.current = motion;
        const at = typeof result.timestamp === 'number' ? result.timestamp : null;
        const settled = { ...templateSettledRef.current };
        for (const s of gameStatesRef.current) {
          if (s.source !== 'region' || s.output !== TEMPLATE_DETECTED || !s.regionId || !updated.has(s.regionId)) continue;
          const region = regionsRef.current.find(x => x.id === s.regionId);
          const raw = templateDetected(snapshots[s.regionId] ?? null, s.regionId, selectedTemplateIds(s), region?.templates.map(t => t.id) ?? []);
          settled[s.id] = settle(settled[s.id], raw, at, settleKey(s), s.settleMs ?? TEMPLATE_SETTLE_MS, found[s.regionId] ?? true);
        }
        templateSettledRef.current = settled;
        // Both matching modes move the region's box to the strongest instance: on screen, not in the saved regions.
        // A box being moved or resized by hand stays with the mouse, and the others carry on.
        // Historical geometry is stored separately; keep the live positions ready for Go Live.
        const held = ix.current.mode === 'moving' || ix.current.mode === 'resizing' ? ix.current.selId : null;
        const next = { ...liveBoxesRef.current };
        for (const [id, box] of Object.entries(moves)) if (id !== held) next[id] = box;
        liveBoxesRef.current = next;
        if (viewTabRef.current === 'game') redrawRef.current();
        scheduleTracking();
      }
    }));
    window.bridge.runtimeAvailable().then(async ok => {
      if (!ok) { setStatus('no-runtime'); return; }
      setStatus('connecting');
      const { ready, error } = await window.bridge.runtimeStatus();
      if (ready) { setStatus('ready'); return; }
      if (error) { setStatus('error'); setError(error); }
    });
    // Training events
    offs.push(window.bridge.on('training:log', (line: unknown) => {
      const s = String(line);
      if (s === 'PAUSED')  { setTrainStatus('paused');  return; }
      if (s === 'RESUMED') { setTrainStatus('running'); return; }
      setTrainLogs(prev => { const next = [...prev, s]; return next.length > 500 ? next.slice(-500) : next; });
      setTimeout(() => { if (trainLogRef.current) trainLogRef.current.scrollTop = trainLogRef.current.scrollHeight; }, 0);
    }));
    offs.push(window.bridge.on('training:progress', (p: unknown) => {
      setTrainProgress(prev => [...prev, p as TrainProgress]);
    }));
    offs.push(window.bridge.on('training:batch', (p: unknown) => {
      const b = p as TrainBatch;
      if (!firstBatch.current) firstBatch.current = { time: Date.now(), step: b.step };
      setTrainBatch(b);
    }));
    offs.push(window.bridge.on('training:done', (info: unknown) => {
      const { code, outDir, kind, best, model, existing, modelError } = info as {
        code: number | null; outDir?: string; kind?: TrainKind; best?: string; model?: TrainedModel; existing?: boolean; modelError?: string;
      };
      setTrainStatus(code === 0 ? 'done' : 'error');
      setYoloBest(best ?? null);
      if (outDir) window.bridge.training.checkCheckpoint(outDir, kind).then(setCheckpointInfo);
      if (model) noteTrainedModel(model, !!existing);
      if (modelError) setTrainError(`Training finished, but the model couldn't be added to Trained Models: ${modelError}`);
    }));

    return () => offs.forEach(f => f());
  }, []);

  // ── Persist trainConfig ───────────────────────────────────────────
  useEffect(() => {
    try { localStorage.setItem('firefly-train-config', JSON.stringify(trainConfig)); } catch {}
  }, [trainConfig]);

  // ── Checkpoint detection ──────────────────────────────────────────
  useEffect(() => {
    if (!trainJob.outDir) { setCheckpointInfo(null); return; }
    window.bridge.training.checkCheckpoint(trainJob.outDir, trainConfig.kind).then(info => setCheckpointInfo(info));
  }, [trainJob.outDir, trainConfig.kind]);

  // ── GPU detection (on mount, and again on Check again or after GPU support is downloaded) ──
  const checkGpu = useCallback(async () => {
    setGpuInfo(null);
    const info = await window.bridge.training.gpuCheck();
    setGpuInfo(info);
    if (!info.available) setTrainConfig(c => ({ ...c, useGpu: false }));
    return info;
  }, []);
  useEffect(() => { void checkGpu(); }, [checkGpu]);
  useEffect(() => window.bridge.on('training:gpu-progress', (p: unknown) => setGpuDownload(p as typeof gpuDownload)), []);
  const downloadGpu = async () => {
    setGpuError(''); setGpuDownload({ phase: 'download' });
    const res = await window.bridge.training.gpuInstall();
    setGpuDownload(null);
    if (!res.ok) { if (res.error !== 'Cancelled') setGpuError(res.error ?? 'Could not download GPU support'); return; }
    const info = await checkGpu();
    if (info.available) setTrainConfig(c => ({ ...c, useGpu: true })); // downloaded to be used
  };
  const removeGpu = async () => {
    if (!window.confirm('Remove GPU support? Training goes back to the CPU, and the download (about 2.5 GB) is deleted.')) return;
    const res = await window.bridge.training.gpuRemove();
    if (!res.ok) setGpuError(res.error ?? 'Could not remove GPU support');
    await checkGpu();
  };

  // ── Recording timer ───────────────────────────────────────────────
  useEffect(() => {
    if (recording?.active) {
      if (!startedAt.current) startedAt.current = Date.now();
      timerRef.current = setInterval(() => setElapsed(Date.now() - startedAt.current!), 500);
    } else {
      clearInterval(timerRef.current ?? undefined);
      timerRef.current = null; startedAt.current = null; setElapsed(0);
    }
    return () => clearInterval(timerRef.current ?? undefined);
  }, [recording?.active]);

  // Keep the values available when a frame arrives. Polls and game frames are asynchronous;
  // this is a history of displayed readings, not an atomic snapshot of game memory.
  // Updates replace their maps/arrays, so unchanged readings can be shared across frames.
  // What States reading a model see: every running model's observations (their names can't clash), and the
  // detected area of the first running segmentation model
  const modelsLive = useMemo<ModelLive | null>(() => {
    const lives = runningModelIds.map(id => modelLives[id]).filter((l): l is ModelLive => l?.phase === 'running');
    if (!lives.length) return null;
    return { ...lives[0], coverage: lives.find(l => l.coverage != null)?.coverage ?? null };
  }, [runningModelIds, modelLives]);

  const frameValues = useMemo<FrameValues>(() => ({
    states: Object.fromEntries(gameStates.map(s => [s.id, s.off ? undefined : stateValue(s, {
      capturing: captureActive, model: modelsLive, stream: streamLive, values: stateValues,
      templates: templateSnapshots, motion: regionMotion, settled: templateSettled, regions, frame: frameSize,
    })])),
    errors: stateReadErrors,
    boxes: Object.fromEntries(regions.filter(r => r.source !== 'script').map(r => {
      const { x, y, w, h } = placedAt(r, liveBoxes);
      return [r.id, { x, y, w, h }];
    })),
    templates: templateSnapshots,
    confidence: trackConfs,
    outputs: Object.fromEntries(regions.flatMap(r => (r.flow?.outputs ?? []).filter(o => o.record)
      .map(o => [o.name, recordedValue(captureActive ? streamLive : null, o.name)]))),
  }), [gameStates, captureActive, modelsLive, streamLive, stateValues, templateSnapshots,
    regionMotion, templateSettled, regions, frameSize, stateReadErrors, liveBoxes, trackConfs]);
  const frameValuesRef = useRef(frameValues);
  frameValuesRef.current = frameValues;
  const frameSizeRef = useRef(frameSize);
  frameSizeRef.current = frameSize;

  // ── Live frame polling ────────────────────────────────────────────
  // While the view is live, each new frame goes into the rewind buffer and onto the screen; paused,
  // neither changes, so the history being scrubbed through holds still.
  useEffect(() => {
    if (!captureActive) {
      detectionAt.current = null; templateAt.current = null; setDetectionAge(null); setTrackingAge(null);
      modelDrawingRef.current = null; setModelDrawing(null); setDisplaySize(null);
      setFrameUrl(null);
      frameBuf.clear();
      setBufSpan({ oldest: 0, newest: 0 });
      setStreamLive(null);
      liveUrlRef.current = null; liveFrameT.current = null; frozenOverlay.current = null; liveFrameOverlay.current = null;
      pausedEdits.current = {};
      showToken.current++;
      setView({ mode: 'live' });
      return;
    }
    stopping.current = false;
    // Rewind images belong to one view; never reuse raw images as processed frames.
    frameBuf.clear(); setBufSpan({ oldest: 0, newest: 0 });
    setFrameUrl(null); liveUrlRef.current = null; liveFrameT.current = null;
    frozenOverlay.current = null; liveFrameOverlay.current = null; pausedEdits.current = {}; showToken.current++; setView({ mode: 'live' });
    let running = true;
    let rafId = 0;
    let lastT: number | undefined;
    let spanAt = 0;
    let ageAt = 0;
    const poll = async () => {
      if (!running) return;
      try {
        const res = await window.bridge.invoke('frame', { processed: showProcessed }) as FrameResponse;
        if (!running) return;
        if (performance.now() - ageAt > 250 && res.timestamp !== undefined) {
          ageAt = performance.now();
          setDetectionAge(detectionAt.current === null ? null : Math.max(0, res.timestamp - detectionAt.current));
          setTrackingAge(templateAt.current === null ? null : Math.max(0, res.timestamp - templateAt.current));
        }
        // The runtime repeats its latest frame while the target hasn't repainted
        if (!res.pending && res.dataUrl && (res.timestamp === undefined || res.timestamp !== lastT)) {
          lastT = res.timestamp;
          const t = res.timestamp ?? performance.now();
          if (res.width && res.height) setFrameSize(cur => cur?.w === res.width && cur?.h === res.height ? cur : { w: res.width!, h: res.height! });
          liveUrlRef.current = res.dataUrl;
          liveFrameT.current = t;
          const overlay: FrameOverlay = {
            ...frameValuesRef.current,
            script: regionScriptBoxesRef.current,
            readings: regionReadingsRef.current,
            matches: Object.values(templateMatchBoxesRef.current).flat(),
            model: !showProcessed && modelDrawingRef.current && modelDrawingRef.current.timestamp <= t ? modelDrawingRef.current : null,
            size: res.width && res.height ? { w: res.width, h: res.height } : frameSizeRef.current,
          };
          liveFrameOverlay.current = overlay;
          // Paused, the rewind history holds still: new frames would push the oldest out and slide the scrub
          // bar under the moment being looked for. Going live again shows the newest frame at once.
          if (res.jpeg && viewRef.current.mode === 'live') {
            const kept = frameBuf.push(t, new Blob([res.jpeg], { type: 'image/jpeg' }), overlay);
            const now = performance.now();
            if (kept && now - spanAt > 250) { spanAt = now; setBufSpan({ oldest: frameBuf.oldest!, newest: frameBuf.newest! }); }
          }
          if (viewRef.current.mode === 'live') setFrameUrl(res.dataUrl);
        }
      } catch (e) {
        if (!running) return;
        // The runtime drops its capture target on any frame failure (e.g. the
        // target went 5s without repainting), so treat this as capture having
        // stopped rather than retrying forever against a target that's gone.
        // Polls that fail because capture is being stopped on purpose are expected.
        if (!stopping.current) {
          setCaptureActive(false);
          setError(String(e));
          return;
        }
      }
      if (running) rafId = requestAnimationFrame(() => { poll(); });
    };
    poll();
    return () => { running = false; cancelAnimationFrame(rafId); };
  }, [captureActive, frameBuf, setView, showProcessed]);

  // ── Window list ───────────────────────────────────────────────────
  const refreshWindows = useCallback(async () => {
    try {
      const [res, thumbs] = await Promise.all([
        window.bridge.invoke('windows') as Promise<{ windows: WindowInfo[] }>,
        window.bridge.getThumbnails(),
      ]);
      setWindows(res.windows ?? []);
      setThumbnails(thumbs);
      setPage(0); setError('');
    } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => { if (status === 'ready') refreshWindows(); }, [status, refreshWindows]);

  useEffect(() => {
    if (status !== 'connecting') return;
    const id = setInterval(async () => {
      const { ready, error } = await window.bridge.runtimeStatus();
      if (ready)  { setStatus('ready'); clearInterval(id); }
      if (error)  { setStatus('error'); setError(error); clearInterval(id); }
    }, 2000);
    return () => clearInterval(id);
  }, [status]);

  // ── ROI canvas ────────────────────────────────────────────────────
  const getImgBounds = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = liveImgRef.current;
    if (!canvas) return null;
    const cw = canvas.width, ch = canvas.height;
    const nw = img?.naturalWidth  || cw;
    const nh = img?.naturalHeight || ch;
    const scale = Math.min(1, Math.min(cw / nw, ch / nh));
    const rw = nw * scale, rh = nh * scale;
    return { rw, rh, ox: (cw - rw) / 2, oy: (ch - rh) / 2 };
  }, []);

  const toNorm = useCallback((px: number, py: number) => {
    const b = getImgBounds();
    if (!b) return null;
    return {
      x: Math.max(0, Math.min(1, (px - b.ox) / b.rw)),
      y: Math.max(0, Math.min(1, (py - b.oy) / b.rh)),
    };
  }, [getImgBounds]);

  const hitHandle = useCallback((px: number, py: number, r: Region): Handle | null => {
    const b = getImgBounds();
    if (!b) return null;
    const corners: { key: Handle; cx: number; cy: number }[] = [
      { key: 'nw', cx: b.ox + r.x * b.rw,             cy: b.oy + r.y * b.rh },
      { key: 'ne', cx: b.ox + (r.x + r.w) * b.rw,     cy: b.oy + r.y * b.rh },
      { key: 'sw', cx: b.ox + r.x * b.rw,             cy: b.oy + (r.y + r.h) * b.rh },
      { key: 'se', cx: b.ox + (r.x + r.w) * b.rw,     cy: b.oy + (r.y + r.h) * b.rh },
    ];
    return corners.find(c => Math.abs(px - c.cx) <= H && Math.abs(py - c.cy) <= H)?.key ?? null;
  }, [getImgBounds]);

  const hitRegion = (norm: {x:number;y:number}, regs: Region[]): Region | null => {
    for (let i = regs.length - 1; i >= 0; i--) {
      const r = regs[i];
      if (norm.x >= r.x && norm.x <= r.x + r.w && norm.y >= r.y && norm.y <= r.y + r.h) return r;
    }
    return null;
  };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cr = canvas.getBoundingClientRect();
    canvas.width = cr.width; canvas.height = cr.height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, cr.width, cr.height);

    const b = getImgBounds();
    if (!b) return;
    const { rw, rh, ox, oy } = b;
    const tracked = trackedIdsRef.current;

    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, rw, rh);
    ctx.clip();

    const drawBox = (r: Region, selected: boolean, preview = false) => {
      const following = !preview && tracked.has(r.id);
      const px = ox + r.x * rw, py = oy + r.y * rh, pw = r.w * rw, ph = r.h * rh;
      ctx.setLineDash(preview ? [4, 3] : []);
      const accentColor = following ? '#69f0ae' : '#4fc3f7';
      ctx.strokeStyle = preview ? '#ffd54f' : (selected ? '#ffffff' : accentColor);
      ctx.lineWidth   = (selected || following) ? 2 : 1;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = preview ? '#ffd54f18' : (selected ? `${accentColor}30` : `${accentColor}18`);
      ctx.fillRect(px, py, pw, ph);
      ctx.setLineDash([]);

      if (!preview) {
        ctx.font = '11px ui-monospace,monospace';
        const labelText = following ? `⬤ ${r.label}` : r.label;
        const tw = ctx.measureText(labelText).width;
        ctx.fillStyle = following ? '#69f0aecc' : `${accentColor}cc`;
        ctx.fillRect(px, Math.max(0, py - 17), tw + 6, 17);
        ctx.fillStyle = '#fff';
        ctx.fillText(labelText, px + 3, Math.max(12, py - 4));
      }

      if (selected && r.source !== 'script') {
        [{ x: px, y: py }, { x: px + pw, y: py }, { x: px, y: py + ph }, { x: px + pw, y: py + ph }].forEach(({ x, y }) => {
          ctx.fillStyle = '#fff';
          ctx.fillRect(x - H, y - H, H * 2, H * 2);
          ctx.strokeStyle = accentColor; ctx.lineWidth = 1.5;
          ctx.strokeRect(x - H, y - H, H * 2, H * 2);
        });
      }
    };

    const { selId, selBoxIdx, mode, working, drawStart, drawEnd } = ix.current;
    // A paused view draws what its frame was captured with, not the live values
    const frozen = frozenOverlay.current;
    const scriptBoxes = frozen ? frozen.script : regionScriptBoxesRef.current;
    regionsRef.current.forEach(r => {
      if (r.visible === false) return;
      if (r.id === selId && (mode === 'moving' || mode === 'resizing')) return;
      if (r.source === 'script') {
        const boxes = scriptBoxes[r.id] ?? [];
        const hidden = hiddenSubBoxesRef.current[r.id];
        boxes.forEach((box, i) => {
          if (hidden?.has(i)) return;
          const isSel = r.id === selId && (selBoxIdx === null || selBoxIdx === i);
          drawBox({ ...r, ...box, label: `${r.label} ${i + 1}` }, isSel);
        });
      } else {
        drawBox(shownAt(r), r.id === selId);
      }
    });
    if (working && (mode === 'moving' || mode === 'resizing')) drawBox(working, true);
    if (mode === 'drawing' && drawStart && drawEnd) {
      const x = Math.min(drawStart.x, drawEnd.x), y = Math.min(drawStart.y, drawEnd.y);
      drawBox({ id:'', label:'', x, y, w: Math.abs(drawEnd.x - drawStart.x), h: Math.abs(drawEnd.y - drawStart.y), templates: [] }, false, true);
    }

    const matchBoxes = frozen ? frozen.matches : Object.values(templateMatchBoxesRef.current).flat();
    if (matchBoxes.length > 0) {
      matchBoxes.forEach(m => {
        const px = ox + m.x * rw, py = oy + m.y * rh, pw = m.w * rw, ph = m.h * rh;
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px, py, pw, ph);
        ctx.fillStyle = '#ff980028';
        ctx.fillRect(px, py, pw, ph);
      });
    }

    ctx.restore();
  }, [getImgBounds, regionScriptBoxes, hiddenSubBoxes, templateMatchBoxes, shownAt]);
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  // A hidden Game View has no size to draw in, so it draws again when it comes back
  useEffect(() => { if (viewTab === 'game') redraw(); }, [regions, viewTab, redraw]);

  // Redraw when live frame updates (keeps boxes visible on live feed)
  useEffect(() => { if (captureActive && viewTab === 'game') redraw(); }, [frameUrl, view, captureActive, viewTab, redraw]);

  // ── Pause and rewind ──────────────────────────────────────────────
  const syncSpan = useCallback(() => {
    setBufSpan({ oldest: frameBuf.oldest ?? 0, newest: frameBuf.newest ?? 0 });
  }, [frameBuf]);

  // Pauses on a buffered frame, which appears as soon as it's decoded
  const showFrame = useCallback((f: BufferedFrame<FrameOverlay>) => {
    const token = ++showToken.current;
    // Stop live frame replacement immediately, then publish the image and readings together.
    const previous = viewRef.current.mode === 'paused' ? viewRef.current : { mode: 'paused' as const, t: liveFrameT.current ?? f.t };
    if (viewRef.current.mode === 'live') {
      frozenOverlay.current = liveFrameOverlay.current;
      setView(previous);
    }
    viewRef.current = { mode: 'paused', t: f.t };
    blobToDataUrl(f.blob).then(url => {
      if (token !== showToken.current) return;
      frozenOverlay.current = f.extra;
      setFrameUrl(url);
      setView({ mode: 'paused', t: f.t });
    }).catch(() => {
      if (token === showToken.current) setView(previous);
    });
    syncSpan();
  }, [setView, syncSpan]);

  // Pauses on the frame that's on screen
  const pause = useCallback(() => {
    const t = liveFrameT.current;
    if (viewRef.current.mode !== 'live' || t === null || !liveFrameOverlay.current) return;
    ++showToken.current;
    frozenOverlay.current = liveFrameOverlay.current;
    setView({ mode: 'paused', t });
    syncSpan();
    // Some frame providers only supply a data URL. Retain the paused frame in that case too.
    const url = liveUrlRef.current, overlay = frozenOverlay.current;
    const token = showToken.current;
    if (url && (frameBuf.newest === null || t > frameBuf.newest))
      fetch(url).then(r => r.blob()).then(blob => { if (token === showToken.current && frameBuf.push(t, blob, overlay)) syncSpan(); }).catch(() => {});
  }, [setView, syncSpan, frameBuf]);

  const goLive = useCallback(() => {
    if (viewRef.current.mode === 'live') return;
    showToken.current++;
    frozenOverlay.current = null; pausedEdits.current = {};
    setView({ mode: 'live' });
    if (liveUrlRef.current) setFrameUrl(liveUrlRef.current);
    redraw();
  }, [setView, redraw]);

  const togglePause = useCallback(() => {
    if (viewRef.current.mode === 'live') pause(); else goLive();
  }, [pause, goLive]);

  // The paused frame's time, or the newest frame's while live
  const viewTime = useCallback(() => {
    const v = viewRef.current;
    return v.mode === 'paused' ? v.t : (liveFrameT.current ?? frameBuf.newest);
  }, [frameBuf]);

  const stepFrame = useCallback((direction: -1 | 1) => {
    const from = viewTime();
    if (from === null) return;
    const f = direction < 0 ? frameBuf.before(from) : frameBuf.after(from);
    if (f) showFrame(f);
  }, [frameBuf, viewTime, showFrame]);

  const jumpBy = useCallback((ms: number) => {
    const from = viewTime();
    if (from === null) return;
    const f = frameBuf.nearest(from + ms);
    if (f) showFrame(f);
  }, [frameBuf, viewTime, showFrame]);

  const seekTo = useCallback((fromOldestMs: number) => {
    const oldest = frameBuf.oldest;
    if (oldest === null) return;
    const f = frameBuf.nearest(oldest + fromOldestMs);
    if (f) showFrame(f);
  }, [frameBuf, showFrame]);

  // The arrow keys move the selected region a pixel of the frame at a time, and with Shift resize it
  // (right and down grow it, left and up shrink it, its top-left staying put); Ctrl makes either 10 px.
  // Snapped to whole pixels, it changes on screen at once and is saved once the keys have rested for
  // 300 ms, so holding a key doesn't save it, and apply the graph, on every repeat.
  const nudgeTimer = useRef<number | null>(null);
  const nudgeRegion = useCallback((dx: number, dy: number, dw = 0, dh = 0) => {
    const sid = ix.current.selId, img = liveImgRef.current;
    const fw = img?.naturalWidth || frameSize?.w, fh = img?.naturalHeight || frameSize?.h;
    const r = sid ? regionsRef.current.find(x => x.id === sid) : undefined;
    if (!sid || !r || r.source === 'script' || !fw || !fh || ix.current.mode !== 'idle') return false;
    const placed = shownAt(r);
    const MIN_PX = 4; // the smallest a box can be made
    const w0 = Math.round(placed.w * fw), h0 = Math.round(placed.h * fh);
    // Moving keeps the size and stops at the frame's edges; resizing keeps the top-left and stops there too
    const px = Math.max(0, Math.min(fw - w0, Math.round(placed.x * fw) + dx)), py = Math.max(0, Math.min(fh - h0, Math.round(placed.y * fh) + dy));
    const w = Math.max(Math.min(MIN_PX, w0), Math.min(fw - px, w0 + dw)), h = Math.max(Math.min(MIN_PX, h0), Math.min(fh - py, h0 + dh));
    const box = { x: px / fw, y: py / fh, w: w / fw, h: h / fh };
    // Paused, it stays where it's put over every frame stepped to; live, it's held there until it's saved
    if (frozenOverlay.current) pausedEdits.current = { ...pausedEdits.current, [sid]: box };
    else liveBoxesRef.current = { ...liveBoxesRef.current, [sid]: box };
    redraw();
    if (nudgeTimer.current !== null) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => {
      nudgeTimer.current = null;
      liveBoxesRef.current = without(liveBoxesRef.current, sid);
      setRegions(regs => regs.map(x => x.id === sid ? { ...x, ...box } : x));
    }, 300);
    return true;
  }, [frameSize, redraw, shownAt]);

  // The transport keys act on the Game View, so they wait while it's hidden
  useEffect(() => {
    if (!captureActive || viewTab !== 'game') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key] && ix.current.selId && !e.metaKey && !e.altKey) {
        const [ax, ay] = arrows[e.key], step = e.ctrlKey ? 10 : 1;
        const done = e.shiftKey ? nudgeRegion(0, 0, ax * step, ay * step) : nudgeRegion(ax * step, ay * step);
        if (done) { e.preventDefault(); return; }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape' && ix.current.selId && ix.current.mode === 'idle') {
        ix.current.selId = null; redraw(); return; // the arrows step through frames again
      }
      if (e.key === ' ') {
        if (el?.tagName === 'BUTTON') return; // a focused button takes Space itself
        e.preventDefault(); togglePause();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.shiftKey) jumpBy(direction * 5000); else stepFrame(direction);
      } else if (e.key === 'End') {
        e.preventDefault(); goLive();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [captureActive, viewTab, togglePause, jumpBy, stepFrame, goLive, nudgeRegion, redraw]);

  // The colour of the frame on screen at a point given as fractions of the frame
  const frameColorAt = (nx: number, ny: number): string | null => {
    const img = liveImgRef.current;
    if (!img || !img.naturalWidth) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(Math.min(c.width - 1, Math.floor(nx * c.width)), Math.min(c.height - 1, Math.floor(ny * c.height)), 1, 1).data;
    return `#${[px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  };

  useEffect(() => {
    if (!colorPick) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { colorPickRef.current = null; setColorPick(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [colorPick]);

  useEffect(() => {
    if (!captureActive) { colorPickRef.current = null; setColorPick(null); }
  }, [captureActive]);

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const norm = toNorm(px, py);
    if (!norm) return;
    // Picking a colour takes the click, instead of drawing or moving a box
    if (colorPickRef.current) {
      const apply = colorPickRef.current;
      colorPickRef.current = null; setColorPick(null);
      const hex = frameColorAt(norm.x, norm.y);
      if (hex) apply(hex);
      return;
    }
    const state = ix.current;

    const onScreen = regionsRef.current.filter(r => r.source !== 'script' && r.visible !== false).map(shownAt);
    if (state.selId) {
      const sel = onScreen.find(r => r.id === state.selId);
      if (sel) {
        const h = hitHandle(px, py, sel);
        if (h) {
          state.mode = 'resizing'; state.handle = h;
          state.orig = { ...sel }; state.working = { ...sel };
          state.moveStart = norm; return;
        }
      }
    }

    const hit = hitRegion(norm, onScreen);
    if (hit) {
      state.mode = 'moving'; state.selId = hit.id;
      state.orig = { ...hit }; state.working = { ...hit };
      state.moveStart = norm; state.drawStart = null;
      setShowTemplate(true); showSelection();
      return;
    }

    state.mode = 'drawing'; state.selId = null;
    state.working = null; state.drawStart = norm; state.drawEnd = null;
    redraw();
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const norm = toNorm(px, py);
    if (!norm) return;
    const state = ix.current;
    const canvas = canvasRef.current;

    if (state.mode === 'idle' && canvas) {
      let cursor = 'crosshair';
      const onScreen = regionsRef.current.filter(r => r.source !== 'script' && r.visible !== false).map(shownAt);
      if (state.selId) {
        const sel = onScreen.find(r => r.id === state.selId);
        if (sel && hitHandle(px, py, sel)) cursor = 'nwse-resize';
      }
      if (cursor === 'crosshair' && hitRegion(norm, onScreen)) cursor = 'move';
      canvas.style.cursor = cursor;
      return;
    }

    if (state.mode === 'moving' && state.orig && state.moveStart) {
      const dx = norm.x - state.moveStart.x, dy = norm.y - state.moveStart.y;
      state.working = {
        ...state.orig,
        x: Math.max(0, Math.min(1 - state.orig.w, state.orig.x + dx)),
        y: Math.max(0, Math.min(1 - state.orig.h, state.orig.y + dy)),
      };
      redraw(); return;
    }

    if (state.mode === 'resizing' && state.orig && state.handle) {
      const o = state.orig;
      let { x, y, w, h } = o;
      if (state.handle === 'nw') { x = Math.min(norm.x, o.x + o.w - 0.01); y = Math.min(norm.y, o.y + o.h - 0.01); w = o.x + o.w - x; h = o.y + o.h - y; }
      if (state.handle === 'ne') { w = Math.max(0.01, norm.x - o.x); y = Math.min(norm.y, o.y + o.h - 0.01); h = o.y + o.h - y; }
      if (state.handle === 'sw') { x = Math.min(norm.x, o.x + o.w - 0.01); w = o.x + o.w - x; h = Math.max(0.01, norm.y - o.y); }
      if (state.handle === 'se') { w = Math.max(0.01, norm.x - o.x); h = Math.max(0.01, norm.y - o.y); }
      x = Math.max(0, x); y = Math.max(0, y); w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
      state.working = { ...state.orig, x, y, w, h };
      redraw(); return;
    }

    if (state.mode === 'drawing' && state.drawStart) {
      state.drawEnd = norm; redraw();
    }
  };

  const onMouseUp = () => {
    const state = ix.current;
    if ((state.mode === 'moving' || state.mode === 'resizing') && state.working) {
      const w = state.working; const sid = state.selId!;
      // Moved by hand, the box is where it was put until its object is found again; paused, over every frame
      liveBoxesRef.current = without(liveBoxesRef.current, sid);
      if (frozenOverlay.current) pausedEdits.current = { ...pausedEdits.current, [sid]: { x: w.x, y: w.y, w: w.w, h: w.h } };
      setRegions(regs => regs.map(r => r.id === sid ? { ...w, templates: r.templates } : r));
      state.mode = 'idle'; state.working = null; redraw(); return;
    }
    if (state.mode === 'drawing' && state.drawStart && state.drawEnd) {
      const s = state.drawStart, e = state.drawEnd;
      const x = Math.min(s.x, e.x), y = Math.min(s.y, e.y);
      const w = Math.abs(e.x - s.x), h = Math.abs(e.y - s.y);
      if (w > 0.02 && h > 0.02) {
        const id = crypto.randomUUID();
        setRegions(regs => [...regs, { id, label: `Region ${regs.length + 1}`, x, y, w, h, templates: [] }]);
        state.selId = id;
        setShowTemplate(true);
      }
    }
    state.mode = 'idle'; state.drawStart = null; state.drawEnd = null; redraw();
  };

  const onMouseLeave = () => {
    const state = ix.current;
    if (state.mode === 'drawing') { state.mode = 'idle'; state.drawStart = null; state.drawEnd = null; redraw(); }
  };

  // A move or resize ends wherever the button is let go, not only over the canvas. Otherwise the box
  // would stay held by a drag that's over, and following its object would leave it behind.
  const onMouseUpRef = useRef(onMouseUp);
  onMouseUpRef.current = onMouseUp;
  useEffect(() => {
    const up = () => { if (ix.current.mode === 'moving' || ix.current.mode === 'resizing') onMouseUpRef.current(); };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // ── Persistence ───────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedTitle) return;
    const key = `firefly-regions-${encodeURIComponent(selectedTitle)}`;
    try {
      if (regions.length > 0) localStorage.setItem(key, JSON.stringify(regions));
      else localStorage.removeItem(key);
    } catch { /* quota exceeded */ }
  }, [regions, selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    const key = `firefly-states-${encodeURIComponent(selectedTitle)}`;
    try {
      if (gameStates.length > 0) localStorage.setItem(key, JSON.stringify(gameStates));
      else localStorage.removeItem(key);
    } catch { /* quota exceeded */ }
  }, [gameStates, selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    const key = `firefly-state-folders-${encodeURIComponent(selectedTitle)}`;
    try {
      if (stateFolders.length > 0) localStorage.setItem(key, JSON.stringify(stateFolders));
      else localStorage.removeItem(key);
    } catch { /* quota exceeded */ }
  }, [stateFolders, selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    try { localStorage.setItem(`firefly-recorded-${encodeURIComponent(selectedTitle)}`, JSON.stringify(recordChoices)); }
    catch { /* quota exceeded */ }
  }, [recordChoices, selectedTitle]);

  useEffect(() => {
    if (!selectedTitle) return;
    try { localStorage.setItem(`firefly-record-setup-${encodeURIComponent(selectedTitle)}`, JSON.stringify({ buttons: [...activeButtons], hz: recordHz })); }
    catch { /* quota exceeded */ }
  }, [activeButtons, recordHz, selectedTitle]);

  // ── Memory / script state polling ────────────────────────────────
  useEffect(() => {
    // A State turned off isn't read, and a hidden Lua Region's script doesn't run
    const memStates    = gameStates.filter(s => s.source === 'memory' && s.address && !s.off);
    const scriptStates = gameStates.filter(s => s.source === 'script' && s.script && !s.off);
    const scriptRegions = regions.filter(r => r.source === 'script' && r.script && r.visible !== false);
    if (!captureActive || (memStates.length === 0 && scriptStates.length === 0 && scriptRegions.length === 0)) return;
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      const stateUpdates: Record<string, unknown> = {};
      const readErrors: Record<string, string | undefined> = {};
      const boxUpdates: Record<string, ScriptBox[]> = {};
      const readingUpdates: Record<string, ScriptRegionReading> = {};
      const snapshotUpdates: Record<string, RegionBoxSnapshot | undefined> = {};
      const regionInputs = getLuaRegions();
      const runLua = luaPollRunner((op, args) => window.bridge.invoke(op, args), regionInputs, getLuaStates());
      await Promise.all([
        ...memStates.map(async s => {
          try {
            const res = await window.bridge.invoke('memory.read', {
              address: s.address, offsets: s.offsets ?? [], byteType: s.byteType ?? 'u32',
            }) as { value: unknown };
            if (res.value == null) readErrors[s.id] = 'Memory returned no value; keeping the last value.';
            else { stateUpdates[s.id] = res.value; readErrors[s.id] = undefined; }
          } catch (error) { readErrors[s.id] = String(error); }
        }),
        ...scriptStates.map(async s => {
          try {
            const res = await runLua(s.script!, s.scriptWidth ?? 0, s.scriptHeight ?? 0);
            if (res.value == null) readErrors[s.id] = 'Lua returned nil; keeping the last value.';
            else { stateUpdates[s.id] = res.value; readErrors[s.id] = undefined; }
          } catch (error) { readErrors[s.id] = String(error); }
        }),
        ...scriptRegions.map(async r => {
          try {
            const res = await runLua(r.script!, r.scriptWidth ?? 0, r.scriptHeight ?? 0, r.id);
            if (res.value == null) throw Error('Lua returned no Region result');
            const geometry = { windowW: res.windowW || liveImgRef.current?.naturalWidth, windowH: res.windowH || liveImgRef.current?.naturalHeight, clientArea: res.clientArea };
            boxUpdates[r.id] = scriptRegionBoxes(res.value, geometry, r.scriptWidth, r.scriptHeight);
            readingUpdates[r.id] = { value: res.value, geometry, width: r.scriptWidth || geometry.windowW || 0, height: r.scriptHeight || geometry.windowH || 0 };
            snapshotUpdates[r.id] = { boxes: boxUpdates[r.id], timestamp: res.timestamp ?? 0 };
          } catch { snapshotUpdates[r.id] = undefined; } // Keep the displayed overlay; failed data is unavailable to scripts.
        }),
      ]);
      if (alive) {
        for (const [id, snapshot] of Object.entries(snapshotUpdates)) {
          if (snapshot) luaRegionSnapshots.current[id] = snapshot;
          else delete luaRegionSnapshots.current[id];
        }
        if (Object.keys(stateUpdates).length > 0) setStateValues(prev => ({ ...prev, ...stateUpdates }));
        if (Object.keys(readErrors).length > 0) setStateReadErrors(prev => ({ ...prev, ...readErrors }));
        if (Object.keys(boxUpdates).length > 0) {
          // Publish the raw reading and converted boxes as one batch, including their history refs.
          regionScriptBoxesRef.current = { ...regionScriptBoxesRef.current, ...boxUpdates };
          regionReadingsRef.current = { ...regionReadingsRef.current, ...readingUpdates };
          setRegionScriptBoxes(regionScriptBoxesRef.current);
          setRegionReadings(regionReadingsRef.current);
        }
        requestAnimationFrame(poll);
      }
    };
    requestAnimationFrame(poll);
    return () => { alive = false; };
  }, [captureActive, gameStates, regions, getLuaRegions, getLuaStates]);

  // ── Capture ───────────────────────────────────────────────────────
  const stopCapture = useCallback(async () => {
    stopping.current = true;
    try {
      if (recording?.active) await window.bridge.invoke('record.stop');
      await window.bridge.invoke('stop');
      setCaptureActive(false); setRecording(null); setFrameUrl(null);
    } catch (e) { stopping.current = false; setError(String(e)); }
  }, [recording]);

  const selectWindow = useCallback(async (id: string, title: string) => {
    if (captureActive) {
      stopping.current = true;
      try {
        if (recording?.active) await window.bridge.invoke('record.stop');
        await window.bridge.invoke('stop');
        setCaptureActive(false); setRecording(null); setFrameUrl(null);
      } catch { stopping.current = false; }
    }
    setSelectedId(id);
    setSelectedTitle(title);
    luaRegionSnapshots.current = {};
    ++scriptTestVersion.current;
    setStateDialog(null); setScriptPreview(null); setSelectedStateId(null);
    ++regionScriptTestVersion.current;
    setCreateDialog(null); setRegionScriptPreview(null);
    try {
      const saved = localStorage.getItem(`firefly-regions-${encodeURIComponent(title)}`);
      setRegions(saved ? (JSON.parse(saved) as Region[]) : []);
    } catch { setRegions([]); }
    try {
      const saved = localStorage.getItem(`firefly-states-${encodeURIComponent(title)}`);
      setGameStates(saved ? (JSON.parse(saved) as GameState[]) : []);
      const folders = localStorage.getItem(`firefly-state-folders-${encodeURIComponent(title)}`);
      setStateFolders(folders ? (JSON.parse(folders) as StateFolder[]) : []);
    } catch { setGameStates([]); }
    try {
      const saved = JSON.parse(localStorage.getItem(`firefly-record-setup-${encodeURIComponent(title)}`) ?? 'null') as { buttons?: string[]; hz?: number } | null;
      setActiveButtons(new Set(saved?.buttons ?? DEFAULTS));
      setRecordHz(Math.min(30, Math.max(5, saved?.hz ?? 15)));
    } catch { setActiveButtons(new Set(DEFAULTS)); setRecordHz(15); }
    try {
      const saved = localStorage.getItem(`firefly-recorded-${encodeURIComponent(title)}`);
      setRecordChoices(saved ? JSON.parse(saved) as Record<string, boolean> : {});
    } catch { setRecordChoices({}); }
    setStateValues({}); setStateReadErrors({}); setFrameSize(null);
    regionReadingsRef.current = {}; setRegionReadings({});
    stopAllTracking();
    ix.current = { mode:'idle', selId:null, selBoxIdx:null, drawStart:null, drawEnd:null, moveStart:null, orig:null, working:null, handle:null };
    try {
      await applyLiveGraph(runningModelsRef.current);
      await window.bridge.invoke('start', { windowId: id });
      setCaptureActive(true); setError('');
      // Every region set to follow its object picks that up again
      for (const r of regionsRef.current) if (r.match && hasAnchors(r)) startTracking(r.id);
    } catch (e) { setError(String(e)); }
  }, [captureActive, recording, setRegions, applyLiveGraph, startTracking, stopAllTracking]);

  const startRecording = useCallback(async () => {
    const buttons = BUTTON_DEFS.filter(b => activeButtons.has(b.id)).map(({ id, vk }) => ({ id, vk }));
    if (!buttons.length) { setError('Select at least one button to record.'); return; }
    try {
      // The States recorded are the ones defined now, even if they changed a moment ago
      await window.bridge.invoke('observe.tracked', { observations: JSON.parse(trackedKey) });
      await window.bridge.invoke('observe.recorded', { exclude: JSON.parse(excludedKey) });
      await window.bridge.invoke('record.start', { recordingId: crypto.randomUUID(), name: `Recording ${new Date().toLocaleString()}`, buttons, hz: recordHz });
      setBottomTab('recordings');
      setError('');
    } catch (e) { setError(String(e)); }
  }, [activeButtons, trackedKey, excludedKey, recordHz]);

  const stopRecording = useCallback(async () => {
    try { await window.bridge.invoke('record.stop'); } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => {
    if (!keyboardOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setKeyboardOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboardOpen]);

  // A recording holds at most MAX_BUTTONS buttons, so one more isn't taken once that many are chosen
  const toggleButton = useCallback((id: string) => setActiveButtons(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else if (next.size < MAX_BUTTONS) next.add(id);
    return next;
  }), []);

  const handleUploadFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        const cropUrl = e.target?.result as string;
        if (!cropUrl) return;
        setCreateDialog(prev => prev ? { ...prev, templates: [...prev.templates, { id: crypto.randomUUID(), cropUrl }] } : null);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleCreateRegion = useCallback(() => {
    if (!createDialog) return;
    if (createDialog.id && recording?.active) return;
    if (createDialog.source === 'script' && (!regionScriptPreview || regionScriptPreview.running || regionScriptPreview.error)) return;
    const previous = createDialog.id ? regionsRef.current.find(r => r.id === createDialog.id) : undefined;
    if (createDialog.id && !previous) return;
    const id    = previous?.id ?? crypto.randomUUID();
    const label = createDialog.label.trim() || `Region ${regionsRef.current.length + 1}`;
    const isScript = createDialog.source === 'script';
    const slot  = regionsRef.current.length % 9;
    // Templates uploaded here are there to be matched; a region without any stays put
    const following = !isScript && createDialog.templates.length > 0;
    const newRegion: Region = {
      ...previous, id, label, templates: createDialog.templates,
      source: createDialog.source,
      ...(following ? { match: true } : {}),
      ...(isScript
        ? { script: createDialog.script, scriptWidth: createDialog.scriptWidth, scriptHeight: createDialog.scriptHeight, x: 0, y: 0, w: 0, h: 0 }
        : { x: 0.1 + (slot % 3) * 0.3, y: 0.1 + Math.floor(slot / 3) * 0.3, w: 0.2, h: 0.2 }),
    };
    setRegions(prev => previous ? prev.map(r => r.id === id ? newRegion : r) : [...prev, newRegion]);
    if (isScript) {
      delete luaRegionSnapshots.current[id];
      regionReadingsRef.current = without(regionReadingsRef.current, id);
      setRegionReadings(regionReadingsRef.current);
      setRegionScriptBoxes(prev => { const next = { ...prev, [id]: regionScriptPreview?.boxes ?? [] }; regionScriptBoxesRef.current = next; return next; });
      setHiddenSubBoxes(prev => { const next = { ...prev }; delete next[id]; hiddenSubBoxesRef.current = next; return next; });
    }
    ix.current.selId = isScript ? null : id;
    setShowTemplate(following);
    ++regionScriptTestVersion.current;
    setCreateDialog(null);
    setRegionScriptPreview(null);
    if (following) startTracking(id);
  }, [createDialog, regionScriptPreview, recording?.active, setRegions, startTracking]);

  const handleTestRegionScript = useCallback(async () => {
    if (!createDialog?.script?.trim()) return;
    const version = ++regionScriptTestVersion.current;
    setRegionScriptPreview({ running: true });
    try {
      const res = await window.bridge.invoke('memory.run_script', { script: createDialog.script, regions: getLuaRegions(), states: getLuaStates(), regionId: createDialog.id, scriptWidth: createDialog.scriptWidth ?? 0, scriptHeight: createDialog.scriptHeight ?? 0 }) as { value: unknown } & ScriptGeometry;
      const boxes = scriptRegionBoxes(res.value, { ...res, windowW: res.windowW || liveImgRef.current?.naturalWidth, windowH: res.windowH || liveImgRef.current?.naturalHeight }, createDialog.scriptWidth, createDialog.scriptHeight);
      if (version === regionScriptTestVersion.current) setRegionScriptPreview({ boxes, running: false });
    } catch (e) {
      if (version === regionScriptTestVersion.current) setRegionScriptPreview({ error: String(e), running: false });
    }
  }, [createDialog?.script, createDialog?.scriptWidth, createDialog?.scriptHeight, createDialog?.id, getLuaRegions, getLuaStates]);

  const handleTestScript = useCallback(async () => {
    if (!stateDialog?.script.trim()) return;
    const version = ++scriptTestVersion.current;
    setScriptPreview({ running: true });
    try {
      const res = await window.bridge.invoke('memory.run_script', { script: stateDialog.script, regions: getLuaRegions(), states: getLuaStates(), ...(stateDialog.id ? { stateId: stateDialog.id } : {}), scriptWidth: stateDialog.scriptWidth ?? 0, scriptHeight: stateDialog.scriptHeight ?? 0 }) as { value: unknown };
      if (version === scriptTestVersion.current) setScriptPreview({ result: res.value, running: false });
    } catch (e) {
      if (version === scriptTestVersion.current) setScriptPreview({ error: String(e), running: false });
    }
  }, [stateDialog?.script, stateDialog?.scriptWidth, stateDialog?.scriptHeight, stateDialog?.id, getLuaRegions, getLuaStates]);

  const scriptPreviewError = scriptPreview?.error ?? (stateDialog?.source === 'script' && scriptPreview && !scriptPreview.running
    ? stateValueError(stateDialog.type, scriptPreview.result) : null);

  const handleSaveState = useCallback(() => {
    if (!stateDialog || (stateDialog.source === 'region' && stateDialog.output === TEMPLATE_DETECTED && selectedTemplateIds(stateDialog)?.length === 0)) return;
    if (stateDialog.id && recording?.active) return;
    if (stateDialog.source === 'script' && (!scriptPreview || scriptPreviewError || scriptPreview.running)) return;
    const previous = stateDialog.id ? gameStates.find(s => s.id === stateDialog.id) : undefined;
    if (stateDialog.id && !previous) return;
    const name = stateDialog.name.trim() || `State ${gameStates.length + 1}`;
    let output = stateDialog.output;
    if (stateDialog.source === 'region' && output.startsWith(NEW_VALUE)) {
      // A new value is called what the state is, and opens in the Values tab to be adjusted
      output = addRegionValue(stateDialog.regionId, output.slice(NEW_VALUE.length), name) ?? '';
      openValues(stateDialog.regionId);
    }
    const s: GameState = {
      id: previous?.id ?? crypto.randomUUID(), name, type: stateDialog.type, source: stateDialog.source,
      ...(previous?.off ? { off: true } : {}),
      ...(stateDialog.folderId && stateFolders.some(f => f.id === stateDialog.folderId) ? { folderId: stateDialog.folderId } : {}),
      ...(previous ? { observationName: previous.observationName ?? recordedStates.observationOf[previous.id] ?? undefined } : {}),
      ...(stateDialog.source === 'region'
        ? { regionId: stateDialog.regionId, output, ...(output === TEMPLATE_DETECTED ? { templateIds: selectedTemplateIds(stateDialog), ...(previous?.settleMs !== undefined ? { settleMs: previous.settleMs } : {}) } : {}) }
        : stateDialog.source === 'memory'
        ? { address: stateDialog.address.trim(), offsets: stateDialog.offsets.filter(o => o.trim()), byteType: stateDialog.byteType }
        : stateDialog.source === 'model'
        ? { output: stateDialog.output }
        : { script: stateDialog.script, scriptWidth: stateDialog.scriptWidth ?? 0, scriptHeight: stateDialog.scriptHeight ?? 0 }),
    };
    setGameStates(prev => previous ? prev.map(value => value.id === s.id ? s : value) : [...prev, s]);
    setStateValues(prev => { const next = { ...prev }; delete next[s.id]; return next; });
    setStateReadErrors(prev => { const next = { ...prev }; delete next[s.id]; return next; });
    ++scriptTestVersion.current;
    setStateDialog(null);
    setScriptPreview(null);
  }, [stateDialog, gameStates, stateFolders, recording?.active, scriptPreview, scriptPreviewError, recordedStates.observationOf, addRegionValue, openValues]);

  const PAGE_SIZE    = 5;
  const isRecording  = recording?.active === true;
  const paused       = view.mode === 'paused';
  const historical = paused ? frozenOverlay.current : null;
  const visibleDrawing = paused ? historical?.model : modelDrawing;
  const visibleScriptBoxes = paused ? historical?.script ?? {} : regionScriptBoxes;
  const visibleTemplates = paused ? historical?.templates ?? {} : templateSnapshots;
  const visibleStateValues = paused ? historical?.states ?? {} : frameValues.states;
  const visibleStateErrors = paused ? historical?.errors ?? {} : stateReadErrors;
  const visibleSize = paused ? historical?.size : frameSize;
  const spanMs       = Math.max(0, bufSpan.newest - bufSpan.oldest);
  const positionMs   = view.mode === 'paused' ? Math.min(spanMs, Math.max(0, view.t - bufSpan.oldest)) : spanMs;
  const selectedWin  = windows.find(w => w.id === selectedId);
  const filteredWins = windows.filter(w => w.title.toLowerCase().includes(filter.toLowerCase()));
  const totalPages   = Math.max(1, Math.ceil(filteredWins.length / PAGE_SIZE));
  const safePage     = Math.min(page, totalPages - 1);
  const pageWins     = filteredWins.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const ready        = status === 'ready';
  const runningModels = runningModelIds.map(id => models.find(m => m.id === id)).filter((m): m is TrainedModel => !!m);
  const selectedModel = models.find(m => m.id === selectedModelId) ?? runningModels[0] ?? models[0] ?? null;
  // Observations States can read: what the running (or else the selected) models record, the detected area once
  const outputsOf = (list: TrainedModel[]) => list.flatMap(m => modelOutputs(m)).filter((o, i, all) => all.findIndex(x => x.name === o.name) === i);
  const runningOutputs = outputsOf(runningModels);
  // Never empty (a new State and the State dialog start from its first): with no model, or none recording
  // anything, it's the detected area, as it always was
  const stateOutputs  = (() => {
    const list = runningModels.length ? runningOutputs : outputsOf(selectedModel ? [selectedModel] : []);
    return list.length ? list : modelOutputs(null);
  })();
  const runningNames = runningModels.map(m => `“${m.name}”`).join(', ');
  // What the regions record, compiled together with the models' outputs so that names can't clash
  const liveCompiled = useMemo(() => compileLive(runningModels.length ? runningModels : selectedModel ? [selectedModel] : [], regionSources(regions)),
    [runningModelIds.join(), models, selectedModel, regions]);
  const readable = regions.filter(r => readsValues(r) || hasAnchors(r));
  const pickStateRegion = (d: StateDialogData, regionId: string, output: string): StateDialogData => {
    const r = regions.find(r => r.id === regionId);
    // A region that follows its object by its corners alone has nothing else to read
    const motion = output === REGION_POSITION || output === REGION_VELOCITY || output === REGION_MATCHES ? output
      : r && fitsCorners(r) && !r.templates.length && !readsValues(r) ? REGION_POSITION : null;
    if (r && motion && hasAnchors(r))
      return { ...d, source: 'region', regionId, output: motion, type: motion === REGION_MATCHES ? 'collection' : 'vector', templateId: undefined, templateIds: undefined };
    if (r?.templates.length && (output === TEMPLATE_DETECTED || !readsValues(r)))
      return { ...d, source: 'region', regionId, output: TEMPLATE_DETECTED, type: 'boolean',
        templateId: undefined, templateIds: d.regionId === regionId ? selectedTemplateIds(d) : undefined };
    return pickRegionValue(d, regionId, output, liveCompiled.regions.get(regionId)?.recorded ?? []);
  };
  const templateLabel = (region: Region | undefined, ids?: string[]) => ids === undefined ? 'Any winning template'
    : ids.length === 0 ? 'No templates selected'
    : ids.map(id => region?.templates.some(t => t.id === id) ? `Template ${region.templates.findIndex(t => t.id === id) + 1}` : 'Deleted template').join(', ');

  // Editing the chosen region, in the Region tab: its box, its templates and their masks, how matches are accepted
  const regionEditor = ix.current.selId ? (() => {
                      const reg = regions.find(r => r.id === ix.current.selId);
                      if (!reg) return null;
                      const isTracked = trackedIds.has(reg.id);
                      const isScriptReg = reg.source === 'script';
                      const subIdx = selSubBox?.regionId === reg.id ? selSubBox.idx : null;
                      const subBox = isScriptReg ? (visibleScriptBoxes[reg.id]?.[subIdx ?? 0] ?? null) : null;
                      const activeBox = isScriptReg ? subBox : paused ? shownAt(reg) : placedAt(reg, liveBoxes);
                      const subLabel = subIdx !== null ? `${reg.label} ${subIdx + 1}` : reg.label;
                      const matching = !isScriptReg && reg.match === true;
                      // Templates can be added, removed or taken again whether or not the region follows its object: they're kept, and used once it does
                      const templateSection = (
                        <>
                          <div className="rtp-thumbs-row">
                            {reg.templates.map((t, i) => (
                              <div key={t.id} className={`rtp-thumb-wrap ${maskFor === t.id ? 'rtp-thumb-picked' : ''}`} role="button" tabIndex={0}
                                title="Click to choose which of its pixels count" onClick={() => setMaskFor(cur => cur === t.id ? null : t.id)}>
                                {(() => {
                                  // Outlined while it's what the object matches, so frames no template covers show up
                                  const now = isTracked && !!visibleTemplates[reg.id]?.matches.some(m => m.templateId === t.id);
                                  return <LookThumb src={t.cropUrl} look={isScriptReg ? 'color' : reg.matchOn ?? 'color'} className={`rtp-thumb ${now ? 'rtp-thumb-now' : ''}`}
                                    alt={`Template ${i + 1}`} title={`Template ${i + 1}${now ? ' · matching now' : ''}`} />;
                                })()}<span className="rtp-template-label">{i + 1}</span>
                                {t.maskUrl && <span className="rtp-thumb-masked" title="Some of its pixels are left out">mask</span>}
                                <button className="rtp-thumb-del" onClick={e => {
                                  e.stopPropagation();
                                  if (maskFor === t.id) setMaskFor(null);
                                  setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, templates: x.templates.filter(tt => tt.id !== t.id) } : x));
                                  if (isTracked) syncTemplates(reg.id);
                                }}>✕</button>
                              </div>
                            ))}
                            {captureActive && (
                              <button className="rtp-thumb-add" disabled={!activeBox} onClick={() => addTemplate(reg.id, subBox ?? undefined)} title={activeBox ? 'Snap current frame as new template' : 'No box available to capture'}>+</button>
                            )}
                          </div>
                          {reg.templates.length === 0 && !captureActive && (
                            <div className="rtp-img-placeholder">Start capture to add templates</div>
                          )}
                          {(() => {
                            const t = reg.templates.find(x => x.id === maskFor);
                            if (!t) return reg.templates.length > 0 && <div className="rtp-hint">Click a template to choose which of its pixels count, leaving out the background around the object.</div>;
                            return <>
                              <label className="rtp-lbl">Template {reg.templates.indexOf(t) + 1}: which pixels count</label>
                              <MaskEditor key={t.id} src={t.cropUrl} mask={t.maskUrl} onChange={maskUrl => {
                                setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, templates: x.templates.map(tt => tt.id === t.id ? { ...tt, maskUrl } : tt) } : x));
                                if (isTracked) syncTemplatesSoon(reg.id);
                              }} />
                              <div className="rtp-hint">A mask costs matching time: about 3.5× with Match on Colour, 2× with Grayscale. Grayscale with a search reach keeps it cheap.</div>
                            </>;
                          })()}
                          {!isScriptReg && reg.templates.length > 0 && (() => {
                            // What the templates and the frame are matched on; thumbnails show them that way
                            const look = MATCH_LOOKS.find(l => l.id === (reg.matchOn ?? 'color'))!;
                            return <>
                              <label className="rtp-match-on">Match on
                                <select aria-label="Match on" value={look.id} onChange={e => {
                                  setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, matchOn: e.target.value as MatchLook } : x));
                                  if (isTracked) syncTemplates(reg.id);
                                }}>
                                  {MATCH_LOOKS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                                </select>
                              </label>
                              <div className="rtp-hint">{look.hint} No choice here makes up for a pose none of the templates show: add templates of those.</div>
                            </>;
                          })()}
                        </>
                      );
                      // The corners the box stretches between, in place of the templates, when it resizes with its object
                      const c = reg.corners;
                      const cornersSection = c && (
                        <>
                          <div className="rtp-thumbs-row">
                            {(['tl', 'br'] as const).map(k => (
                              <div key={k} className="rtp-thumb-wrap">
                                <img src={c[k].cropUrl} className="rtp-thumb rtp-thumb-corner" alt="" />
                                <span className="rtp-thumb-tag">{k === 'tl' ? 'Top-left' : 'Bottom-right'}</span>
                              </div>
                            ))}
                            {captureActive && (
                              <button className="rtp-thumb-add" onClick={() => snapCorners(reg.id)} title="Take the corners again from the box as it is now">↻</button>
                            )}
                          </div>
                          <div className="rtp-corner-size">
                            <span>Corner size</span>
                            <DraftInput className="rtp-input rtp-input-num" value={String(c.size)} disabled={!captureActive}
                              onCommit={v => { const n = parseInt(v, 10); if (n >= 4 && n <= 48) snapCorners(reg.id, n); }} />
                            <span>px</span>
                          </div>
                          {c.plain && <div className="rtp-hint rtp-warn">A corner is nearly one flat colour, which can’t be told from anywhere else of that colour. Draw the box tighter, or make the corner size bigger.</div>}
                        </>
                      );
                      return (
                        <div className="region-template-panel">
                          <div className="rtp-header">
                            <span className="rtp-title">Region — {subLabel}</span>
                            <button className="rtp-close" title="Let go of this region" onClick={() => { ix.current.selId = null; setMaskFor(null); redraw(); showSelection(); }}>✕</button>
                          </div>
                          <div className="rtp-body rtp-columns">
                            <div className="rtp-fields rtp-col">
                              <label className="rtp-lbl">Label</label>
                              <input
                                className="rtp-input"
                                value={reg.label}
                                onChange={e => setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, label: e.target.value } : x))}
                              />
                              <label className="rtp-lbl">Bounds</label>
                              <div className="rtp-coords">
                                {(() => {
                                  if (!activeBox) return <span className="rtp-empty-bounds">{!isScriptReg ? 'No bounds in this frame' : (visibleScriptBoxes[reg.id]?.length ?? 0) === 0 ? 'No boxes returned' : 'Selected box is no longer available'}</span>;
                                  const iw = visibleSize?.w || liveImgRef.current?.naturalWidth  || 1;
                                  const ih = visibleSize?.h || liveImgRef.current?.naturalHeight || 1;
                                  return <>
                                    <span>X <b>{Math.round(activeBox.x * iw)}px</b></span>
                                    <span>Y <b>{Math.round(activeBox.y * ih)}px</b></span>
                                    <span>W <b>{Math.round(activeBox.w * iw)}px</b></span>
                                    <span>H <b>{Math.round(activeBox.h * ih)}px</b></span>
                                  </>;
                                })()}
                              </div>
                              {isScriptReg && (() => {
                                const reading = paused ? historical?.readings[reg.id] : regionReadings[reg.id];
                                if (!reading) return null;
                                const value = Array.isArray(reading.value) ? reading.value[subIdx ?? 0] : reading.value;
                                const area = reading.geometry.clientArea ?? { x: 0, y: 0, w: 1, h: 1 };
                                const iw = visibleSize?.w || liveImgRef.current?.naturalWidth || 1;
                                const ih = visibleSize?.h || liveImgRef.current?.naturalHeight || 1;
                                const number = (n: number) => Number(n.toFixed(4));
                                return <details className="rtp-lua-reading">
                                  <summary>Lua reading · before scaling</summary>
                                  <div className="state-val-panel">{value === undefined ? <span className="sv-nil">No entry returned</span> : renderStateVal(value)}</div>
                                  <div className="rtp-hint">Raw Lua result used for these bounds. Identical scripts with the same coordinate settings share one reading per refresh.</div>
                                  <div className="rtp-lua-conversion">
                                    <span>Script size <b>{reading.width} × {reading.height}</b></span>
                                    <span>Capture size <b>{iw} × {ih}</b></span>
                                    <span>Scale X <b>{number(area.w * iw / reading.width)}</b> · Y <b>{number(area.h * ih / reading.height)}</b></span>
                                    <span>Offset X <b>{number(area.x * iw)}px</b> · Y <b>{number(area.y * ih)}px</b></span>
                                  </div>
                                </details>;
                              })()}
                              {frameUrl && activeBox && (() => {
                                const iw = visibleSize?.w || liveImgRef.current?.naturalWidth  || 1;
                                const ih = visibleSize?.h || liveImgRef.current?.naturalHeight || 1;
                                const rw = activeBox.w * iw, rh = activeBox.h * ih;
                                if (rw < 1 || rh < 1) return null;
                                const MAXW = 360, MAXH = 240; // a column of the Region tab
                                const scale = Math.min(MAXW / rw, MAXH / rh, 4);
                                const pw = Math.round(rw * scale), ph = Math.round(rh * scale);
                                return (
                                  <div className="rtp-live-preview" style={{ width: pw, height: ph }}>
                                    <img src={frameUrl} style={{
                                      position: 'absolute',
                                      left: `${-activeBox.x * iw * scale}px`,
                                      top:  `${-activeBox.y * ih * scale}px`,
                                      width: `${iw * scale}px`,
                                      height: `${ih * scale}px`,
                                      imageRendering: 'pixelated',
                                    }} alt="" />
                                  </div>
                                );
                              })()}
                              {!isScriptReg && (() => {
                                const recorded = (reg.flow?.outputs ?? []).filter(o => o.record);
                                const show = (v: unknown) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3))
                                  : Array.isArray(v) ? `${v.length} shape${v.length !== 1 ? 's' : ''}` : v === undefined ? '–'
                                  : typeof v === 'string' ? oneLine(v, 22) || '(no text)' : String(v);
                                return (
                                  <>
                                    <label className="rtp-lbl">Values</label>
                                    {matching ? (
                                      <div className="rtp-hint">Values are read from a box that stays put. This one follows its object, so turn off template matching to read values from it.</div>
                                    ) : (
                                      <>
                                        {recorded.map(o => (
                                          <div key={o.id} className="rtp-value">
                                            <span>{o.name}</span>
                                            <b>{show(paused ? historical?.outputs[o.name] : recordedValue(captureActive ? streamLive : null, o.name))}</b>
                                          </div>
                                        ))}
                                        {recorded.length === 0 && <div className="rtp-hint">Read a number or some text from what’s inside the box, such as how full a bar is or a level.</div>}
                                        <button className="rtp-snap" onClick={() => openValues(reg.id)}>
                                          {(reg.flow?.outputs.length ?? 0) > 0 ? 'Edit values…' : 'Read a value from this box…'}
                                        </button>
                                      </>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                            <div className="rtp-fields rtp-col">
                              {isScriptReg && templateSection}
                              {!isScriptReg && (() => {
                                const canFollow = matching || reg.templates.length > 0 || !!frameUrl;
                                return (
                                  <>
                                    <label className="rtp-lbl">Template matching</label>
                                    <label className="rtp-checkbox-row">
                                      <input
                                        type="checkbox"
                                        checked={matching}
                                        disabled={!canFollow}
                                        onChange={e => setRegionMatching(reg.id, e.target.checked)}
                                      />
                                      Follow the object in this box
                                    </label>
                                    <div className="rtp-hint">
                                      {!canFollow ? 'Start capture to take the template from a frame.'
                                        : matching ? 'The box follows what’s inside it, alongside any other regions that follow theirs.'
                                        : 'Off: the box stays where you put it.'}
                                    </div>
                                    {!reg.multiMatch && (
                                      <>
                                        <label className="rtp-checkbox-row">
                                          <input
                                            type="checkbox"
                                            checked={reg.fit === true}
                                            disabled={reg.fit !== true && !frameUrl}
                                            onChange={e => setRegionFit(reg.id, e.target.checked)}
                                          />
                                          Resize the box with the object
                                        </label>
                                        <div className="rtp-hint">
                                          {reg.fit ? 'The box stretches between the object’s top-left and bottom-right corners, wherever they are found, so it grows and shrinks with the object.'
                                            : 'Off: the box keeps the size of the template. For an object whose size changes, such as a mini map, draw the box tight around it, then turn this on.'}
                                        </div>
                                      </>
                                    )}
                                    {fitsCorners(reg) ? cornersSection : templateSection}
                                    {!matching && (reg.templates.length > 0 || fitsCorners(reg)) && (
                                      <div className="rtp-hint">Not following now: {fitsCorners(reg) ? 'the corners are' : 'these templates are'} kept, and used once it follows its object.</div>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                            <div className="rtp-fields rtp-col">
                              {matching && reg.templates.length > 0 && !fitsCorners(reg) && (
                                <>
                                  <label className="rtp-lbl">Multi-Match</label>
                                  <label className="rtp-checkbox-row">
                                    <input
                                      type="checkbox"
                                      checked={reg.multiMatch ?? false}
                                      onChange={e => {
                                        const mm = e.target.checked;
                                        setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, multiMatch: mm } : x));
                                        if (isTracked) syncTemplates(reg.id);
                                        if (!mm) forgetMatches(reg.id);
                                      }}
                                    />
                                    Match all instances
                                  </label>
                                  <div className="rtp-hint">The region follows the highest-confidence match. Orange boxes show all instances; competing templates at the same instance use the strongest match.</div>
                                </>
                              )}
                              {(matching || isScriptReg) && hasAnchors(reg) && (
                                <>
                                  <label className="rtp-lbl">Accept matches from</label>
                                  <div className="rtp-threshold-row">
                                    <input
                                      type="range" min={0} max={1} step={0.01} aria-label="Least confidence to accept"
                                      value={matchThreshold(reg)}
                                      onChange={e => {
                                        const thr = parseFloat(e.target.value);
                                        setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, matchThreshold: thr } : x));
                                        if (isTracked) syncTemplatesSoon(reg.id);
                                      }}
                                    />
                                    <span className="rtp-threshold-val">{Math.round(matchThreshold(reg) * 100)}%</span>
                                  </div>
                                  <div className="rtp-hint">The box only moves to a match at least this confident. Raise it above what the scenery scores so the box can't jump there; lower it to keep hold through poses the templates don't cover.</div>
                                </>
                              )}
                              {(matching || isScriptReg) && hasAnchors(reg) && (fitsCorners(reg) || !reg.multiMatch) && (() => {
                                const reach = searchReach(reg);
                                const setReach = (v: number | 'window', soon = false) => {
                                  setRegions(prev => prev.map(x => x.id === reg.id ? { ...x, searchReach: v } : x));
                                  if (isTracked) { if (soon) syncTemplatesSoon(reg.id); else syncTemplates(reg.id); }
                                };
                                return (
                                  <>
                                    <label className="rtp-lbl">Search</label>
                                    <label className="rtp-checkbox-row">
                                      <input type="checkbox" checked={reach !== null}
                                        onChange={e => setReach(e.target.checked ? (fitsCorners(reg) ? CORNER_REACH : NEAR_REACH) : 'window')} />
                                      Only near where it was
                                    </label>
                                    {reach !== null && (
                                      <div className="rtp-threshold-row">
                                        <input type="range" min={10} max={500} step={10} aria-label="How far from where it was to look"
                                          value={reach} onChange={e => setReach(parseInt(e.target.value, 10), true)} />
                                        <span className="rtp-threshold-val">±{reach} px</span>
                                      </div>
                                    )}
                                    <div className="rtp-hint">{reach === null
                                      ? 'Looks through the whole window every frame, so the box goes wherever the best match is.'
                                      : `Looks only this far from where the object was last found, so the box can't jump to lookalikes elsewhere${fitsCorners(reg) ? '' : ', and template states only see what\'s near it'}. It also looks ahead, where the object was heading. If the object isn't there, the same frame looks twice as far, and further, until it's found or the whole window has been searched, so it's found on the frame it's in.`}</div>
                                  </>
                                );
                              })()}
                              {isTracked && (
                                <>
                                  <label className="rtp-lbl">Confidence</label>
                                  <div className="rtp-conf-bar-wrap">
                                    {(() => {
                                      const conf = (paused ? historical?.confidence[reg.id] : trackConfs[reg.id]) ?? 0, least = matchThreshold(reg);
                                      return <>
                                        <div className="rtp-conf-bar" style={{ width: `${(conf * 100).toFixed(0)}%`, background: conf >= least ? '#69f0ae' : '#ef5350' }} />
                                        <div className="rtp-conf-mark" style={{ left: `${least * 100}%` }} title={`Accepted from ${Math.round(least * 100)}%`} />
                                        <span className="rtp-conf-val">{(conf * 100).toFixed(0)}%</span>
                                      </>;
                                    })()}
                                  </div>
                                </>
                              )}
                              {isScriptReg && reg.templates.length > 0 && (isTracked
                                ? <button className="rtp-snap rtp-stop-track" onClick={() => { stopTracking(reg.id); redraw(); }}>⏹ Stop Tracking</button>
                                : <button className="rtp-snap" onClick={() => startTracking(reg.id)}>▶ Start Tracking</button>
                              )}
                              {!isTracked && !isScriptReg && <div className="rtp-hint">Threshold, search and confidence show once the region follows its object.</div>}
                            </div>
                          </div>
                        </div>
                      );
  })() : null;

  // Setting up a recording, in the Recordings tab: start and stop, how often, the buttons, and what it holds
  const observedByName = new Map(observedFields.map(f => [f.name, f]));
  const claimed = new Set(Object.values(recordedStates.observationOf).filter((n): n is string => !!n));
  const fieldRow = (f: { name: string; type: string }, label: string, detail?: string) => (
    <label key={`${label}-${f.name}`} className="rec-field">
      <input type="checkbox" checked={isRecorded(f)} disabled={isRecording}
        onChange={e => setRecordChoices(c => ({ ...c, [f.name]: e.target.checked }))} />
      <span className="rec-field-name">{label}</span>
      {detail && <span className="rec-field-type" title={detail}>{detail}</span>}
      <span className="rec-field-type">{f.type}</span>
    </label>
  );
  const notObserved = (s: GameState) => {
    const observation = recordedStates.observationOf[s.id];
    if (s.off) return 'Turned off';
    if (!captureActive) return 'Start capture to see what can be recorded';
    if (observation === null) return s.source === 'model' ? 'The detected area isn’t recorded; record one of the model’s outputs'
      : s.source === 'region' ? 'Its region was deleted' : 'Set it up first';
    if (s.source === 'model') return runningModels.length ? `No running model records “${observation}”; turn on recording for it in Outputs` : 'Run the model to record it';
    if (s.source === 'region' && (s.output === REGION_POSITION || s.output === REGION_VELOCITY || s.output === REGION_MATCHES || s.output === TEMPLATE_DETECTED))
      return 'Waiting for the runtime…';
    return `Not observed right now: add “${observation}” to the region’s Values`;
  };
  // What a recording can actually take a second, and what holds it back: a sample needs a new frame from
  // the game, and the graph to have finished the one before
  const rateNote = (() => {
    if (!captureActive || !rates) return null;
    const perSecond = (hz: number) => `${hz >= 10 ? Math.round(hz) : hz.toFixed(1)} a second`;
    const graphHz = rates.detectionMs > 0 ? 1000 / rates.detectionMs : Infinity;
    const frameHz = rates.frameHz > 0 ? rates.frameHz : 0;
    if (!frameHz) return { text: 'The game isn\u2019t drawing new frames, so nothing can be recorded until it does.', limited: true };
    const possible = Math.min(recordHz, frameHz, graphHz);
    const reason = possible >= recordHz * 0.95 ? ''
      : frameHz <= graphHz ? ` The game draws about ${Math.round(frameHz)} frames a second, and each sample needs a new frame.`
      : ` The graph takes about ${Math.round(rates.detectionMs)} ms a frame${modelsLive && runningModels.some(m => (m.device ?? inferenceId) === 'cpu') ? `; running ${runningModels.length > 1 ? 'the models' : 'the model'} on the GPU (Inference, in the toolbar, or each model's Runs on in Trained Models) is much faster` : ''}.`;
    if (isRecording) {
      const hz = recording?.sampleHz ?? 0;
      return { text: `Recording ${perSecond(hz)} (aiming for ${recordHz}).${hz < recordHz * 0.9 ? reason : ''}`, limited: hz < recordHz * 0.9 };
    }
    return { text: possible >= recordHz * 0.95 ? `Records ${perSecond(recordHz)}.` : `Records about ${perSecond(possible)}, not ${recordHz}.${reason}`, limited: possible < recordHz * 0.95 };
  })();

  const recordingSetup = (
    <div className="rec-setup">
      {isRecording
        ? <button className="insp-btn insp-btn-stop" onClick={stopRecording}>■ Stop recording · {fmt(elapsed)} · {recording!.samples.toLocaleString()} samples{recording?.sampleHz ? ` · ${Math.round(recording.sampleHz)}/s` : ''}</button>
        : <button className="insp-btn insp-btn-record" disabled={!captureActive} onClick={startRecording}><span className="rec-dot-sm" /> Start recording</button>}
      {!captureActive && <div className="insp-hint">Start a capture session to record.</div>}
      <label className="rec-setup-row">Samples per second
        <input type="number" min={5} max={30} value={recordHz} disabled={isRecording} aria-label="Samples per second"
          onChange={e => setRecordHz(Math.min(30, Math.max(5, Number(e.target.value) || 15)))} />
      </label>
      {rateNote && <div className={`insp-hint${rateNote.limited ? ' rec-rate-limited' : ''}`} aria-label="Recording rate">{rateNote.text}</div>}
      {isRecording && recording?.focused === false && <div className="insp-hint rec-rate-limited" role="status">The game isn’t the window in front, so these samples have no buttons and can’t be trained on. Click into the game.</div>}
      {!isRecording && captureActive && <div className="insp-hint">Buttons are recorded only while the game is the window in front: after starting, click into the game.</div>}
      <div className="rec-setup-lbl">Buttons recorded</div>
      <div className="key-grid" aria-label="Buttons recorded">
        {BUTTON_DEFS.filter(b => activeButtons.has(b.id)).map(b => (
          <span key={b.id} className="key-btn key-btn-on key-chip">{b.label}
            {!isRecording && <button type="button" className="key-chip-x" aria-label={`Stop recording ${b.label}`} title={`Don’t record ${b.label}`} onClick={() => toggleButton(b.id)}>✕</button>}
          </span>
        ))}
        {activeButtons.size === 0 && <span className="insp-hint">None chosen yet</span>}
      </div>
      <div className="rec-setup-keys">
        <button type="button" className="train-btn-sm" disabled={isRecording} onClick={() => setKeyboardOpen(true)}>⌨ Choose on keyboard…</button>
        <span className="insp-hint">{activeButtons.size} of {MAX_BUTTONS} buttons</span>
      </div>
      {keyboardOpen && (
        <div className="modal-overlay" onClick={() => setKeyboardOpen(false)}>
          <div className="modal-card kb-dialog" role="dialog" aria-label="Choose the buttons recorded" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><span className="modal-title">Buttons recorded</span></div>
            <div className="kb-dialog-body">
              <div className="kb-dialog-hint">
                Click the keys and mouse buttons to record, or press them. {activeButtons.size} of {MAX_BUTTONS} chosen.
                Greyed-out keys can’t be recorded or pressed by a policy: hover over one to see why.
              </div>
              <Keyboard selected={activeButtons} onToggle={toggleButton} disabled={isRecording} listen />
              <div className="kb-dialog-chosen">
                {activeButtons.size ? BUTTON_DEFS.filter(b => activeButtons.has(b.id)).map(b => b.label).join(' · ') : 'Nothing chosen yet'}
              </div>
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" disabled={isRecording || !activeButtons.size} onClick={() => setActiveButtons(new Set())}>Clear all</button>
              <button className="modal-btn" onClick={() => setKeyboardOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <div className="rec-setup-lbl">States recorded</div>
      {gameStates.length === 0 && <div className="insp-hint">No States yet. Add them in the Inspector.</div>}
      {gameStates.map(s => {
        const observation = recordedStates.observationOf[s.id];
        const field = observation ? observedByName.get(observation) : undefined;
        const took = observation !== null && observation !== undefined ? probeMs[observation] : undefined;
        const detail = [observation && observation !== s.name ? `as “${observation}”` : '',
          took !== undefined ? `${took.toFixed(1)} ms` : ''].filter(Boolean).join(' · ');
        return field ? fieldRow(field, s.name, detail || undefined)
          : <div key={s.id} className="rec-field rec-field-off" title={notObserved(s)}>
              <input type="checkbox" checked={false} disabled readOnly /><span className="rec-field-name">{s.name}</span>
              <span className="rec-field-type">{notObserved(s)}</span>
            </div>;
      })}
      {observedFields.some(f => !claimed.has(f.name)) && <>
        <div className="rec-setup-lbl">Other observations</div>
        {observedFields.filter(f => !claimed.has(f.name)).map(f => fieldRow(f, f.name))}
      </>}
      <div className="insp-hint">Unticked observations are only left out of recordings; States and playing a policy still see them. Images aren't recorded unless ticked, since policies can't learn from them. Memory and Lua States are read as each frame is sent for detection, and show how long they take.</div>
    </div>
  );

  // ── Splash ────────────────────────────────────────────────────────
  if (status === 'loading') return <div className="splash"><span className="splash-msg">Initializing…</span></div>;
  if (status === 'no-runtime') return (
    <div className="splash">
      <div className="splash-icon">!</div>
      <span className="splash-title">Native runtime not built</span>
      <span className="splash-sub">Run these commands, then restart:</span>
      <pre className="splash-code">npm run native:setup{'\n'}npm run native:configure{'\n'}npm run native:build</pre>
    </div>
  );
  if (status === 'error') return (
    <div className="splash">
      <div className="splash-icon">!</div>
      <span className="splash-title">Runtime error</span>
      <span className="splash-sub">{error}</span>
    </div>
  );

  // ── Editor ────────────────────────────────────────────────────────
  return (
    <div className="editor">

      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-brand">FireFly</div>
        <div className="toolbar-actions">
          {captureActive && (!isRecording
            ? <button className="tbtn tbtn-record" onClick={startRecording}><span className="rec-dot-sm" /> Record</button>
            : <button className="tbtn tbtn-record-active" onClick={stopRecording}><span className="rec-dot-sm anim" /> {fmt(elapsed)}</button>
          )}
        </div>
        <div className="toolbar-status">
          <span className={`status-dot ${ready ? 'status-dot-on' : 'status-dot-off'}`} />
          <span className="status-label">{ready ? 'Connected' : 'Connecting…'}</span>
        </div>
      </div>

      {/* Workspace */}
      <div className="workspace">

        {/* Hierarchy */}
        <div className="panel panel-left">
          <div className="panel-tabbar">
            <span className="panel-tab active">Hierarchy</span>
            <button className="panel-tab-btn" onClick={refreshWindows} title="Refresh">↺</button>
          </div>
          <div className="search-bar">
            <input className="search-input" placeholder="Search windows…" value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <div className="hierarchy-list">
            {status === 'connecting' && <div className="hierarchy-empty">Connecting to runtime…</div>}
            {status === 'ready' && filteredWins.length === 0 && (
              <div className="hierarchy-empty">{filter ? 'No matches' : 'No windows found — click ↺'}</div>
            )}
            {pageWins.map(w => {
              const hasSaved = !!localStorage.getItem(`firefly-regions-${encodeURIComponent(w.title)}`);
              return (
              <div
                key={w.id}
                className={`win-item ${highlightedId === w.id ? 'selected' : ''} ${captureActive && selectedId === w.id ? 'capturing' : ''}`}
                onClick={() => ready && setHighlightedId(w.id)}
                onDoubleClick={() => ready && setConfirmDialog({ windowId: w.id, title: w.title })}
                title="Double-click to start session"
              >
                <div className="win-thumb">
                  {thumbnails[w.title]
                    ? <img src={thumbnails[w.title]} className="win-thumb-img" alt="" />
                    : <div className="win-thumb-empty">▣</div>}
                </div>
                <div className="win-meta">
                  <span className="win-title">{w.title}</span>
                  <span className="win-pid">
                    PID {w.pid}
                    {hasSaved && <span className="win-saved-badge" title="Session data saved">●</span>}
                  </span>
                </div>
              </div>
            );})}
          </div>
          {filteredWins.length > PAGE_SIZE && (
            <div className="pagination">
              <button className="pg-btn" disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹</button>
              <span className="pg-label">{safePage + 1} / {totalPages}</span>
              <button className="pg-btn" disabled={safePage >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>›</button>
            </div>
          )}
        </div>

        {/* Center column */}
        <div className="center-col">

          {/* Game View and Graph View — top half. The Game View stays mounted behind the Graph View so its frame and canvas carry on. */}
          <div className="viewport-wrap" style={viewTab === 'graph' ? { flex: 1, minHeight: 0 } : undefined}>
            <div className="panel-tabbar">
              <span className={`panel-tab panel-tab-click ${viewTab === 'game' ? 'active' : ''}`} onClick={() => setViewTab('game')}>Game View</span>
              <span className={`panel-tab panel-tab-click ${viewTab === 'graph' ? 'active' : ''}`} onClick={() => setViewTab('graph')}>Graphs</span>
              <label className="inference-control" title={recording?.active ? 'Stop recording before changing inference hardware' : 'Hardware for model inference, for every model whose Runs on (in Trained Models) is Same as toolbar; template matching runs on the CPU, on a worker of its own'}>
                Inference
                <select aria-label="Model inference device" value={inferenceId} disabled={status !== 'ready' || !!recording?.active || inferenceChanging} onChange={e => { void changeInference(e.target.value); }}>
                  {inferenceDevices.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
                  {!inferenceDevices.some(d => d.id === inferenceId) && <option value={inferenceId} disabled>Saved device unavailable — choose CPU</option>}
                </select>
              </label>
              {(inferenceId === 'cpu' || models.some(m => m.device === 'cpu')) && maxThreads > 0 && (
                <label className="inference-control" title="How many threads the CPU runs the model on. More is faster, but leaves less for capture, template matching and the game. Doesn't change what recordings hold.">
                  Threads
                  <select aria-label="CPU threads for the model" value={cpuThreads} onChange={e => { void changeThreads(Number(e.target.value)); }}>
                    {Array.from({ length: maxThreads }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}{n === 2 ? ' (default)' : ''}</option>)}
                  </select>
                </label>
              )}
              {!inferenceDevices.some(d => d.provider === 'directml') && <span className="inference-note" title="GPU inference requires the DirectML runtime and a DirectX 12 capable GPU">GPU unavailable</span>}
              {captureActive && viewTab === 'game' && <>
                <select className="preview-mode" aria-label="Preview source" value={showProcessed ? 'processed' : 'live'} onChange={e => { setProcessedView(e.target.value === 'processed'); if (e.target.value === 'live') setPreviewNode(null); }}>
                  <option value="live">Live capture</option><option value="processed">Detection view</option>
                </select>
                <span className="viewport-fps" title="How far the latest completed detection frame, and the latest template match, are behind the preview's capture time">{paused ? 'Paused' : showProcessed ? 'Processed frames' : detectionAge === null ? 'Live · detecting…' : `Live · detection ${Math.round(detectionAge)} ms${trackedIds.size > 0 && trackingAge !== null ? ` · tracking ${Math.round(trackingAge)} ms` : ''} behind`}</span>
              </>}
            </div>
            {inferenceError && <div className="inference-error" role="alert">{inferenceError}</div>}
            <div className={`viewport ${viewTab === 'game' ? '' : 'viewport-off'}`}>
              {!selectedId && (
                <div className="viewport-hint">
                  <div className="viewport-hint-icon">▣</div>
                  <div className="viewport-hint-title">No capture target</div>
                  <div className="viewport-hint-sub">Double-click a window in the Hierarchy panel to start a session</div>
                </div>
              )}
              {selectedId && (
                <div className="vp-preview">
                  <div className={`vp-preview-img-wrap ${paused ? 'vp-paused' : ''}`}>
                    {frameUrl
                      ? <img ref={liveImgRef} src={frameUrl} className="vp-preview-img" alt="" onLoad={e => {
                          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                          setDisplaySize(cur => cur?.w === w && cur?.h === h ? cur : { w, h });
                        }} />
                      : <div className="vp-preview-placeholder capturing-icon">▣</div>
                    }
                    {captureActive && frameUrl && !showProcessed && visibleDrawing &&
                      visibleDrawing.width === displaySize?.w && visibleDrawing.height === displaySize?.h && (
                      <img className="vp-preview-img vp-model-drawing" src={visibleDrawing.dataUrl} alt=""
                        data-source-timestamp={visibleDrawing.timestamp} aria-hidden="true" />
                    )}
                    {isRecording && (
                      <div className="vp-rec-overlay">
                        <div className="vr-badge"><span className="rec-dot-sm anim" /> REC</div>
                        <div className="vr-stats">
                          <span className="vr-val">{recording!.samples.toLocaleString()}</span>
                          <span className="vr-lbl">samples</span>
                          <span className="vr-sep">·</span>
                          <span className="vr-val">{fmt(elapsed)}</span>
                        </div>
                        {recording?.focused === false && <div className="vr-unfocused" role="status">Click into the game: its buttons are only recorded while it’s the window in front</div>}
                      </div>
                    )}
                    {!isRecording && captureActive && !paused && <div className="vp-live-badge">{showProcessed ? 'DETECTION' : 'LIVE'}</div>}
                    {captureActive && paused && <div className={`vp-live-badge vp-live-badge-paused ${isRecording ? 'vp-badge-bottom' : ''}`}>PAUSED</div>}
                    {captureActive && runningModels.length > 0 && (
                      <div className="vp-model-badges">
                        {runningModels.map((m, i) => {
                          const live = modelLives[m.id] ?? null;
                          // The graph's time is the whole frame's: shown once, on the last model
                          const last = i === runningModels.length - 1;
                          return (
                            <div key={m.id} className={`vp-model-badge ${live?.phase === 'error' ? 'vp-model-badge-err' : ''}`} title={live?.error ?? `Overlay from “${m.name}”`}>
                              <span className="vp-model-name">◆ {m.name}</span>
                              {last && live?.phase === 'running' && live.latencyMs !== undefined && <span className="vp-model-ms">{Math.round(live.latencyMs)} ms</span>}
                              {live?.phase === 'error' && <span className="vp-model-ms">error</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <canvas
                      ref={canvasRef}
                      className="vp-roi-canvas"
                      onMouseDown={onMouseDown}
                      onMouseMove={onMouseMove}
                      onMouseUp={onMouseUp}
                      onMouseLeave={onMouseLeave}
                    />
                    {colorPick && <div className="vp-pick-hint">Click a colour in the frame · Esc to cancel</div>}
                  </div>
                  {captureActive && (
                    <Transport
                      live={!paused} spanMs={spanMs} positionMs={positionMs}
                      onToggle={togglePause} onSeek={seekTo} onJump={jumpBy} onStep={stepFrame} onLive={goLive}
                    />
                  )}
                  <div className="vp-preview-bar">
                    <span className="vp-preview-title">{selectedWin?.title}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {captureActive && !isRecording && <button className="vp-btn vp-btn-capture" onClick={startRecording}>⏺ Record</button>}
                      {captureActive && isRecording   && <button className="vp-btn vp-btn-stop" onClick={stopRecording}>⏹ Stop Recording</button>}
                      {captureActive                  && <button className="vp-btn vp-btn-stop" onClick={stopCapture}>■ Stop</button>}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <GraphLibrary
              regions={regions}
              active={viewTab === 'graph'}
              online={ready}
              capturing={captureActive}
              windowId={captureActive ? selectedId : null}
              recording={isRecording}
              storageKey={`firefly-policy-graph-${encodeURIComponent(selectedTitle || lastTitle || 'any')}`}
              graphOf={selectedTitle || lastTitle}
              observed={policyObserved}
              frameSize={frameSize}
              stateLabels={gameStates.reduce<Record<string, string>>((labels, s) => {
                // A State that reads a region's value or a model output is recorded under that output's name
                const observation = recordedStates.observationOf[s.id];
                if (observation) labels[observation] = labels[observation] ? `${labels[observation]}, ${s.name}` : s.name;
                return labels;
              }, {})}
            />
          </div>

          {/* Bottom panel — train / trained models / outputs */}
          <div className="bottom-center-panel" style={viewTab === 'graph' ? { display: 'none' } : undefined}>
            <div className="panel-tabbar">
              <span className={`panel-tab ${bottomTab === 'train' ? 'active' : ''}`} onClick={() => setBottomTab('train')} style={{ cursor: 'pointer' }}>Train</span>
              <span className={`panel-tab ${bottomTab === 'models' ? 'active' : ''}`} onClick={() => setBottomTab('models')} style={{ cursor: 'pointer' }}>
                Trained Models
                {models.length > 0 && (
                  <span className={`panel-tab-count ${modelsUnseen ? 'panel-tab-count-new' : ''}`} title={modelsUnseen ? 'New model from training' : undefined}>{models.length}</span>
                )}
              </span>
              <span className={`panel-tab ${bottomTab === 'outputs' ? 'active' : ''}`} onClick={() => setBottomTab('outputs')} style={{ cursor: 'pointer' }}>Outputs</span>
              <span className={`panel-tab ${bottomTab === 'values' ? 'active' : ''}`} onClick={() => setBottomTab('values')} style={{ cursor: 'pointer' }}>Values</span>
              <span role="tab" aria-selected={bottomTab === 'region'} className={`panel-tab ${bottomTab === 'region' ? 'active' : ''}`} onClick={() => setBottomTab('region')} style={{ cursor: 'pointer' }}>Region</span>
              <span role="tab" aria-selected={bottomTab === 'recordings'} className={`panel-tab ${bottomTab === 'recordings' ? 'active' : ''}`} onClick={() => setBottomTab('recordings')} style={{ cursor: 'pointer' }}>Recordings{isRecording && <span className="rec-dot-sm anim" />}</span>
              <span role="tab" aria-selected={bottomTab === 'play'} className={`panel-tab ${bottomTab === 'play' ? 'active' : ''}`} onClick={() => setBottomTab('play')} style={{ cursor: 'pointer' }}>Play</span>
            </div>
            <RecordingsPanel active={bottomTab === 'recordings'} online={ready} recording={recording} setup={recordingSetup}/>
            {/* Mounted while hidden, so it keeps up with a policy playing from the Policy Graph too */}
            <div className="play-tab" hidden={bottomTab !== 'play'}>
              <PlayPanel active={bottomTab === 'play'} online={ready} capturing={captureActive} windowId={selectedId} recording={isRecording} />
            </div>
            {bottomTab === 'region' && (
              <div className="region-tab">
                {regionEditor ?? <div className="region-tab-empty">Click a region in the Game View, or one under Regions in the Inspector, to edit it here. Draw a box on the Game View to make one.</div>}
              </div>
            )}
            {bottomTab === 'outputs' && (
              <OutputsPanel
                models={models}
                model={selectedModel}
                onSelectModel={setSelectedModelId}
                running={!!selectedModel && runningModelIds.includes(selectedModel.id)}
                live={selectedModel ? modelLives[selectedModel.id] ?? null : null}
                recording={isRecording}
                problems={selectedModel && flowIssues?.modelId === selectedModel.id ? flowIssues.problems : []}
                error={selectedModel && flowIssues?.modelId === selectedModel.id ? flowIssues.error : null}
                preview={(() => {
                  // The previewed step by the name the model's flow gives it, inside the graph of every running model
                  const prefix = selectedModel && runningModelIds.includes(selectedModel.id) ? modelPrefix(selectedModel, runningModels) : '';
                  return previewNode && previewNode.startsWith(prefix) ? previewNode.slice(prefix.length) : null;
                })()}
                onPreview={node => setPreviewNode(node && selectedModel && runningModelIds.includes(selectedModel.id) ? modelPrefix(selectedModel, runningModels) + node : node)}
                onChange={patch => selectedModel && updateModelSettings(selectedModel.id, patch)}
                onRun={() => selectedModel && runModel(selectedModel)}
                onStop={() => selectedModel && stopModel(selectedModel.id)}
              />
            )}
            {bottomTab === 'values' && (() => {
              const region = readable.find(r => r.id === valuesRegionId) ?? readable.find(r => r.id === ix.current.selId) ?? readable[0] ?? null;
              const ids = new Set((region?.flow?.outputs ?? []).map(o => o.id));
              const mine = (item: { output?: string }) => !!item.output && ids.has(item.output);
              return (
                <ValuesPanel
                  regions={readable.map(r => ({ id: r.id, label: r.label, flow: r.flow }))}
                  region={region && { id: region.id, label: region.label, flow: region.flow }}
                  onSelectRegion={setValuesRegionId}
                  problems={(regionIssues?.problems ?? []).filter(mine)}
                  error={regionIssues?.error && (!regionIssues.error.output || mine(regionIssues.error)) ? regionIssues.error : null}
                  nodes={streamLive?.nodes ?? {}}
                  live={captureActive}
                  recording={isRecording}
                  preview={previewNode}
                  previewed={previewNode && streamLive?.preview?.node === previewNode ? streamLive.preview : null}
                  onPreview={setPreviewNode}
                  selectedId={valuesOutputId}
                  onSelect={setValuesOutputId}
                  onChange={flow => region && setRegionFlow(region.id, flow)}
                  onAddValue={template => region && addRegionValue(region.id, template)}
                  onPickColor={startColorPick}
                />
              );
            })()}
            {bottomTab === 'models' && (
              <ModelsPanel
                models={models}
                selected={selectedModel}
                runningIds={runningModelIds}
                lives={modelLives}
                devices={inferenceDevices}
                toolbarDevice={inferenceDevices.find(d => d.id === inferenceId)?.label ?? 'CPU'}
                onDevice={setModelDevice}
                captureActive={captureActive}
                recording={isRecording}
                notice={modelNotice}
                suggestion={modelSuggestion}
                onSelect={setSelectedModelId}
                onImport={importModel}
                onDismissNotice={() => setModelNotice(null)}
                onRun={runModel}
                onStop={stopModel}
                onRename={renameModel}
                onEditOutputs={id => { setSelectedModelId(id); setBottomTab('outputs'); }}
                onReveal={id => window.bridge.models.reveal(id)}
                onDelete={deleteModel}
              />
            )}
            {bottomTab === 'train' && (() => {
              const latest = trainProgress[trainProgress.length - 1];
              const checkPassed = datasetCheck !== null && datasetCheck !== 'checking' && datasetCheck.ok === true && datasetCheck.result?.pass === true;
              const batchFracForBar = (latest && trainBatch && trainBatch.epoch > latest.epoch)
                ? (trainBatch.step / trainBatch.total) / latest.totalEpochs : 0;
              const pct = latest ? Math.round(((latest.epoch / latest.totalEpochs) + batchFracForBar) * 100) : 0;
              const isRunning = trainStatus === 'running';
              const isPaused = trainStatus === 'paused';
              const isActive = isRunning || isPaused;
              const yolo = trainConfig.kind === 'yolo';
              return (
                <div className="train-panel">
                  <div className="train-left">
                    <div className="train-config">
                      <div className="train-kind" role="tablist" aria-label="Model to train">
                        {([['unet', 'Segmentation (UNet)'], ['yolo', 'Object detection (YOLO)']] as const).map(([kind, label]) => (
                          <button key={kind} role="tab" aria-selected={trainConfig.kind === kind} disabled={isActive}
                            className={`train-kind-btn ${trainConfig.kind === kind ? 'active' : ''}`}
                            onClick={() => { setTrainConfig(c => ({ ...c, kind })); setDatasetCheck(null); setYoloBest(null); }}>{label}</button>
                        ))}
                      </div>
                      <div className="train-kind-hint">{yolo
                        ? 'Finds things as boxes, such as monsters, NPCs and portals: trained on a YOLO dataset (images, label files and data.yaml), as a Dataset Output with Format Dataset saves one.'
                        : 'Marks which pixels belong to something, such as platforms and ladders: trained on images and their masks.'}</div>
                      <div className="train-config-row">
                        <label>Dataset <InfoTip wide text={yolo
                          ? `The YOLO dataset folder: the one holding data.yaml, with images/train, images/val and labels/train, labels/val. A collection graph's Dataset Output with Format Dataset writes exactly this.`
                          : `Folder must contain either:\n• images/ and masks/ subfolders (auto-split)\n• train/images/, train/masks/, val/images/, val/masks/ (pre-split)\n\nEach image needs a matching mask with the same filename. Masks are palette PNGs where pixel value 0 = background and any value > 0 = foreground.`} /></label>
                        <div className="train-folder-row">
                          <input className="train-input" value={trainJob.dataDir} readOnly placeholder="No folder selected" />
                          <button className="train-btn-sm" disabled={isActive} onClick={async () => {
                            const p = await window.bridge.training.pickFolder();
                            if (p) { setTrainJob({ dataDir: p }); setDatasetCheck(null); }
                          }}>Browse</button>
                          {trainJob.dataDir && (() => {
                            const chk = datasetCheck;
                            const passed = chk && chk !== 'checking' && chk.ok && chk.result?.pass;
                            if (chk === 'checking') return <button className="train-btn-sm train-btn-checking" disabled>Checking…</button>;
                            if (passed)             return <button className="train-btn-sm train-btn-pass" disabled>✓ Passed</button>;
                            return (
                              <button className="train-btn-sm train-btn-check" disabled={isActive} onClick={async () => {
                                setDatasetCheck('checking');
                                const r = await window.bridge.training.checkDataset(trainJob.dataDir, trainConfig.kind);
                                setDatasetCheck(r);
                              }}>Check Dataset</button>
                            );
                          })()}
                        </div>
                        {datasetCheck && datasetCheck !== 'checking' && (() => {
                          const chk = datasetCheck;
                          const res = chk.result;
                          const passed = chk.ok && res?.pass;
                          return (
                            <div className={`ds-check-panel ${passed ? 'ds-check-pass' : 'ds-check-fail'}`}>
                              {!chk.ok && <div className="ds-check-error">{chk.error}</div>}
                              {res && <>
                                {res.kind === 'yolo'
                                  ? <div className="ds-check-summary">
                                      {passed ? '✓' : '✗'} {res.pairs.toLocaleString()} images
                                      {res.splits && ` (${Object.entries(res.splits).map(([split, n]) => `${n.images} ${split}`).join(', ')})`}
                                      {res.classes?.map(c => <span key={c.name} className="ds-check-class"><i style={{ background: c.color }} />{c.name} {c.boxes.toLocaleString()}</span>)}
                                    </div>
                                  : <div className="ds-check-summary">
                                      {passed ? '✓' : '✗'} {res.pairs.toLocaleString()} pairs found
                                      {res.sampledCount > 0 && ` · mean coverage ${(res.coverageMean * 100).toFixed(1)}%`}
                                    </div>}
                                {res.warnings.map((w, i) => <div key={i} className="ds-check-warning">⚠ {w}</div>)}
                                {chk.gridDataUrl && (
                                  <div className="ds-check-grid-wrap">
                                    <div className="ds-check-grid-hint">{res.kind === 'yolo'
                                      ? 'sample images with their label boxes, coloured by class: verify the boxes sit on the right things'
                                      : 'image | mask (green = foreground) | zoomed crop — verify green pixels land on the right objects'}</div>
                                    <img className="ds-check-grid" src={chk.gridDataUrl} alt="dataset preview" />
                                  </div>
                                )}
                              </>}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="train-config-row">
                        <label>Output <InfoTip wide text={yolo
                          ? "Folder where this training is saved: weights/best.pt (the best validation score) and weights/last.pt (the latest, to resume from), with results.csv and charts of how it went."
                          : "Folder where the trained model is saved. After training you'll find best.pt (best val score), last.pt (final epoch), and optionally unet.onnx for use in the native engine."} /></label>
                        <input className="train-input" value={trainJob.outDir} disabled={isActive}
                          onChange={e => setTrainJob({ outDir: e.target.value })} />
                      </div>
                      <div className="train-config-grid">
                        <div className="train-config-field">
                          <label>Epochs <InfoTip text={yolo
                            ? "How many full passes over the dataset. 100 is a good start for a small dataset; the best epoch is kept whatever comes after it."
                            : "How many full passes over the dataset. More epochs = longer training. 50 is a good starting point; increase if the model is still improving."} /></label>
                          <input type="number" className="train-input-sm" value={trainJob.epochs} min={1} max={1000} disabled={isActive}
                            onChange={e => setTrainJob({ epochs: Math.max(1, +e.target.value) })} />
                        </div>
                        <div className="train-config-field">
                          <label>Batch <InfoTip text={yolo
                            ? "Images processed together per step. 16 suits a GPU with 8 GB or more; lower it if training runs out of memory (it halves the batch itself once if it does)."
                            : "Images processed together per step. Larger batches train faster but use more memory. Use 2–4 on CPU, 8–16 with a GPU."} /></label>
                          <input type="number" className="train-input-sm" value={trainJob.batch} min={1} max={64} disabled={isActive}
                            onChange={e => setTrainJob({ batch: Math.max(1, +e.target.value) })} />
                        </div>
                        {yolo ? <>
                          <div className="train-config-field">
                            <label>Model <InfoTip wide text="Which pretrained YOLO11 to start from. Larger is more accurate but slower to train and to run; Nano is the place to start, especially with a small dataset. Its weights are downloaded once (a few MB for Nano, more for larger ones)." /></label>
                            <select className="train-input-sm" aria-label="YOLO model" value={trainConfig.yolo.model} disabled={isActive}
                              onChange={e => setTrainConfig(c => ({ ...c, yolo: { ...c.yolo, model: e.target.value } }))}>
                              {YOLO_MODELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </div>
                          <div className="train-config-field">
                            <label>Image size <InfoTip wide text="The size images are trained at, their longer side in pixels, in steps of 32. Your screenshots' own width keeps small objects as sharp as they are (800 for an 800 × 600 game); smaller trains faster but small things suffer." /></label>
                            <input type="number" className="train-input-sm" aria-label="Image size" value={trainConfig.yolo.imgsz} min={64} max={2048} step={32} disabled={isActive}
                              onChange={e => setTrainConfig(c => ({ ...c, yolo: { ...c.yolo, imgsz: +e.target.value || c.yolo.imgsz } }))}
                              onBlur={e => setTrainConfig(c => ({ ...c, yolo: { ...c.yolo, imgsz: Math.min(2048, Math.max(64, Math.round((+e.target.value || 800) / 32) * 32)) } }))} />
                          </div>
                        </> : <>
                          <div className="train-config-field">
                            <label>Width × height <InfoTip wide text="The model's input size, in pixels. Training images, and the game's frames when it runs, are fitted into it keeping their proportions, with black filling what's left: set it to your game's window size (800 × 600 for MapleStory v83) to train at full scale, or smaller (such as 400 × 304) for speed at the cost of detail; thin platforms and ropes suffer first. It needn't be square, and it goes in steps of 8. Larger takes more memory and time, in training and in every frame live." /></label>
                            <span className="train-size-pair">
                              <input type="number" className="train-input-sm" aria-label="Width" value={trainConfig.width} min={64} max={2048} step={8} disabled={isActive}
                                onChange={e => setTrainConfig(c => ({ ...c, width: +e.target.value || c.width }))}
                                onBlur={e => setTrainConfig(c => ({ ...c, width: sizeInput(+e.target.value) }))} />
                              ×
                              <input type="number" className="train-input-sm" aria-label="Height" value={trainConfig.height} min={64} max={2048} step={8} disabled={isActive}
                                onChange={e => setTrainConfig(c => ({ ...c, height: +e.target.value || c.height }))}
                                onBlur={e => setTrainConfig(c => ({ ...c, height: sizeInput(+e.target.value) }))} />
                            </span>
                          </div>
                          <div className="train-config-field">
                            <label>Base ch <InfoTip wide text="Controls model size. 32 = lighter & faster (good for CPU). 64 = standard quality but uses twice the memory. Start at 32 on CPU." /></label>
                            <input type="number" className="train-input-sm" value={trainConfig.base} min={8} max={128} step={8} disabled={isActive}
                              onChange={e => setTrainConfig(c => ({ ...c, base: Math.max(8, +e.target.value) }))} />
                          </div>
                        </>}
                        <div className="train-config-field">
                          <label>Workers <InfoTip wide text={`Processes that read and prepare images while the model trains. 0 is automatic: 4 with a GPU, none on the CPU. Range: 4–32, and no more than this PC's CPU threads (${navigator.hardwareConcurrency || '?'} here); each takes about 0.3–0.5 GB of memory. A rough guide to how many a GPU keeps busy (reading image files / with “Decode the images once”, which needs fewer): entry (GTX 1650–1660, RTX 3050) 4–6 / 2–4; mid (RTX 2060–3070, 4060) 6–10 / 4; high (RTX 3080–3090, 4070–4090) 8–16 / 4–8; top (RTX 5080–5090) 12–32 / 6–8. Training on the CPU: 2–4, since they compete with training for the same cores.${gpuInfo?.name ? ` This PC's GPU: ${gpuInfo.name}.` : ''} Too few, and epochs are slow with the GPU mostly idle; more than needed only costs memory.`} /></label>
                          <input type="number" className="train-input-sm" value={trainConfig.workers} min={0} max={32} disabled={isActive}
                            onChange={e => setTrainConfig(c => ({ ...c, workers: Math.min(32, Math.max(0, Math.round(+e.target.value) || 0)) }))} />
                        </div>
                      </div>
                      {!yolo && <label className="rtp-checkbox-row" style={{ marginBottom: 8 }}>
                        <input type="checkbox" checked={trainConfig.decodeOnce} disabled={isActive}
                          onChange={e => setTrainConfig(c => ({ ...c, decodeOnce: e.target.checked }))} />
                        Decode the images once before training
                        <InfoTip wide text={`Every epoch otherwise decodes every image file (PNG) and resizes it, which is most of an epoch's time when the GPU is fast. With this on, they're decoded once, at the training size, into raw files next to the output, before the first epoch, and epochs only read them; the files are deleted when training ends, however it ends. It needs disk space: ${
                          datasetCheck && datasetCheck !== 'checking' && datasetCheck.result?.pairs
                            ? `about ${(datasetCheck.result.pairs * trainConfig.width * trainConfig.height * 3.125 / 2 ** 30).toFixed(1)} GB for these ${datasetCheck.result.pairs.toLocaleString()} images at ${trainConfig.width} × ${trainConfig.height}`
                            : `about 3 bytes a pixel, so ${(trainConfig.width * trainConfig.height * 3.125 / 2 ** 20).toFixed(2)} MB an image at ${trainConfig.width} × ${trainConfig.height} (check the dataset to see its total)`
                        }; without enough free, training reads the files as before.`} />
                      </label>}
                      <label className="rtp-checkbox-row" style={{ marginBottom: 8 }}>
                        <input type="checkbox"
                          checked={trainConfig.useGpu}
                          disabled={isActive || gpuInfo?.available === false}
                          onChange={e => setTrainConfig(c => ({ ...c, useGpu: e.target.checked }))} />
                        Use GPU (CUDA)
                        {gpuInfo === null && <span className="train-gpu-status train-gpu-checking">detecting…</span>}
                        {gpuInfo?.available && <span className="train-gpu-status train-gpu-ok">{gpuInfo.name ?? 'GPU detected'}</span>}
                        {gpuInfo?.available === false && <span className="train-gpu-status train-gpu-none">training on the CPU</span>}
                      </label>
                      {/* Why the card isn't used, and what would make it: the GPU is never needed, training runs on the CPU without it */}
                      {gpuInfo && (() => {
                        const card = gpuInfo.gpuName ?? 'graphics card', plan = gpuInfo.plan ?? {};
                        const again = <button className="train-btn-sm" disabled={isActive || !!gpuDownload} onClick={() => void checkGpu()}>Check again</button>;
                        const remove = gpuInfo.installed && <button className="train-btn-sm" disabled={isActive || !!gpuDownload} onClick={() => void removeGpu()}>Remove GPU support</button>;
                        if (gpuInfo.available) return gpuInfo.installed
                          ? <div className="train-gpu-note">Training on your {card} with the GPU support FireFly downloaded (PyTorch {gpuInfo.torch}). {remove}</div> : null;
                        let body: React.ReactNode;
                        if (gpuInfo.installed) body = <>FireFly downloaded GPU support for your {card}, but PyTorch couldn’t calculate on it{gpuInfo.error ? <>: <i>{gpuInfo.error}</i></> : ''}. Training runs on the CPU. If you’ve changed your graphics card or driver since, remove it and download it again. {again} {remove}</>;
                        else if (plan.reason === 'no-driver') body = <>No NVIDIA graphics card was found, or its driver isn’t installed, so training runs on the CPU. Training on the GPU needs an NVIDIA card. {again}</>;
                        else if (plan.reason === 'card') body = <>Your {card} is too old for PyTorch’s GPU builds (compute capability {plan.capability}; they need 5.0 or newer), so training runs on the CPU.</>;
                        else if (plan.reason === 'driver') body = <>Training runs on the CPU for now. Your NVIDIA driver supports CUDA {gpuInfo.driverCuda}, and training on your {card} needs CUDA {plan.need}: driver {plan.driverVersion} or newer{gpuInfo.driverVersion ? ` (you have ${gpuInfo.driverVersion})` : ''}. Windows Update usually doesn’t install NVIDIA’s newest driver: get it from <b>nvidia.com/drivers</b> or the NVIDIA App, restart, then {again}</>;
                        else if (gpuInfo.packaged) body = gpuDownload
                          ? <>{gpuDownload.phase === 'download'
                                ? <>Downloading GPU support{gpuDownload.total ? `: ${(gpuDownload.done! / 2 ** 30).toFixed(2)} of ${(gpuDownload.total / 2 ** 30).toFixed(2)} GB` : '…'}
                                    <div className="train-gpu-bar"><div style={{ width: `${gpuDownload.total ? Math.round(gpuDownload.done! / gpuDownload.total * 100) : 0}%` }} /></div></>
                                : gpuDownload.phase === 'install' ? 'Installing GPU support…' : `Testing it on your ${card}…`}
                              {gpuDownload.phase === 'download' && <button className="train-btn-sm" onClick={() => void window.bridge.training.gpuCancel()}>Cancel</button>}</>
                          : <>Training runs on the CPU. FireFly can download PyTorch’s GPU build for your {card} (CUDA {plan.cuda}, about {plan.aboutGb} GB, kept with FireFly’s data) and train on it, many times faster.{' '}
                              <button className="train-btn-sm train-gpu-download" disabled={isActive} onClick={() => void downloadGpu()}>Download GPU support</button></>;
                        else body = <>PyTorch in <code>.venv</code> has no CUDA support, so training runs on the CPU. For your {card}, run this in a terminal, then restart FireFly:
                          <code className="train-gpu-cmd">{`.venv\\Scripts\\pip install torch==${(gpuInfo.torch ?? '').split('+')[0]}+${plan.variant} torchvision==${(gpuInfo.vision ?? '').split('+')[0]}+${plan.variant} --index-url https://download.pytorch.org/whl/${plan.variant} --no-deps --force-reinstall`}</code></>;
                        return <div className="train-gpu-install">{body}{gpuError && <div className="train-error">{gpuError}</div>}</div>;
                      })()}
                      {trainError && <div className="train-error">{trainError}</div>}
                      <div className="train-actions">
                        {isRunning && (
                          <>
                            <button className="train-btn-pause" onClick={async () => {
                              await window.bridge.training.pause();
                              setTrainStatus('paused');
                            }}>⏸ Pause</button>
                            <button className="train-btn-stop" onClick={() => {
                              window.bridge.training.stop();
                              setTrainStatus('idle');
                              window.bridge.training.checkCheckpoint(trainJob.outDir, trainConfig.kind).then(setCheckpointInfo);
                            }}>⏹ Stop</button>
                          </>
                        )}
                        {isPaused && (
                          <>
                            <button className="train-btn-primary" onClick={async () => {
                              await window.bridge.training.unpause();
                              setTrainStatus('running');
                            }}>▶ Resume</button>
                            <button className="train-btn-stop" onClick={() => {
                              window.bridge.training.stop();
                              setTrainStatus('idle');
                              window.bridge.training.checkCheckpoint(trainJob.outDir, trainConfig.kind).then(setCheckpointInfo);
                            }}>⏹ Stop</button>
                          </>
                        )}
                        {!isActive && (() => {
                          const ckpt = checkpointInfo;
                          const doStart = async (resume: boolean) => {
                            setTrainLogs([]); setTrainProgress([]); setTrainBatch(null); setTrainError(''); firstBatch.current = null;
                            setTrainedModel(null); setExportState('idle'); setYoloBest(null);
                            trainStartTime.current = Date.now();
                            setTrainStatus('running');
                            const res = await window.bridge.training.start(yolo ? {
                              kind: 'yolo', dataDir: trainJob.dataDir, outDir: trainJob.outDir,
                              epochs: trainJob.epochs, batch: trainJob.batch, model: trainConfig.yolo.model, imgsz: trainConfig.yolo.imgsz,
                              resume, device: trainConfig.useGpu ? 'cuda' : 'cpu', workers: trainConfig.workers,
                            } : {
                              dataDir: trainConfig.dataDir, outDir: trainConfig.outDir,
                              epochs: trainConfig.epochs, batch: trainConfig.batch,
                              width: sizeInput(trainConfig.width), height: sizeInput(trainConfig.height), base: trainConfig.base,
                              exportOnnx: true, resume,
                              device: trainConfig.useGpu ? 'cuda' : 'cpu',
                              workers: trainConfig.workers, decodeOnce: trainConfig.decodeOnce,
                            });
                            if (!res.ok) { setTrainStatus('error'); setTrainError(res.error ?? 'Failed to start'); }
                          };
                          return ckpt?.found ? (
                            <div className="train-resume-row">
                              <button className="train-btn-primary" onClick={() => doStart(true)}>
                                ▶ Resume epoch {ckpt.epoch}/{ckpt.totalEpochs}
                                {yolo ? (ckpt.map50 !== undefined ? ` · mAP50 ${(ckpt.map50 * 100).toFixed(1)}%` : '') : ckpt.valIou !== undefined ? ` · IoU ${(ckpt.valIou * 100).toFixed(1)}%` : ''}
                              </button>
                              <button className="train-btn-stop" disabled={!checkPassed} onClick={() => doStart(false)}>↺ Start Fresh</button>
                            </div>
                          ) : (
                            <button className="train-btn-primary" disabled={!checkPassed} onClick={() => doStart(false)}>▶ Start Training</button>
                          );
                        })()}
                      </div>
                    </div>

                    {(isActive || trainProgress.length > 0) && (() => {
                      // ETA computation
                      let etaStr = '';
                      if (isActive) {
                        if (latest && trainProgress.length > 0) {
                          const avgSec = trainProgress.reduce((s, p) => s + p.sec, 0) / trainProgress.length;
                          const batchFrac = (trainBatch && trainBatch.epoch > latest.epoch)
                            ? trainBatch.step / trainBatch.total : 0;
                          const remSec = (latest.totalEpochs - latest.epoch - batchFrac) * avgSec;
                          if (remSec > 0) etaStr = formatEta(remSec) + ' remaining';
                        } else if (trainBatch && firstBatch.current && trainBatch.step > firstBatch.current.step) {
                          // Batches a second since the first was reported, over what's left of this epoch and the rest
                          const seconds = (Date.now() - firstBatch.current.time) / 1000;
                          const perBatch = seconds / (trainBatch.step - firstBatch.current.step);
                          const frac = trainBatch.step / trainBatch.total;
                          if (frac > 0.01 && seconds > 5) {
                            const remSec = perBatch * trainBatch.total * (trainJob.epochs - frac);
                            etaStr = formatEta(remSec) + ' remaining (est.)';
                          }
                        }
                      }
                      return (
                      <div className="train-metrics-panel">
                        <div className="train-progress-bar-wrap">
                          {latest
                            ? <div className="train-progress-bar" style={{ width: `${pct}%` }} />
                            : trainBatch
                              ? <div className="train-progress-bar" style={{ width: `${Math.round(trainBatch.step / trainBatch.total * 100)}%` }} />
                              : <div className="train-progress-bar train-progress-indeterminate" />
                          }
                          <span className="train-progress-label">
                            {latest
                              ? (trainBatch && trainBatch.epoch > latest.epoch
                                  ? `Epoch ${trainBatch.epoch} / ${latest.totalEpochs} · Batch ${trainBatch.step} / ${trainBatch.total}`
                                  : `Epoch ${latest.epoch} / ${latest.totalEpochs}`)
                              : trainBatch
                                ? `Epoch 1 / ${trainJob.epochs} · Batch ${trainBatch.step} / ${trainBatch.total}`
                                : trainLogs.length > 3 ? 'Epoch 1 running…' : 'Loading dataset…'
                            }
                            {isPaused && ' ⏸ paused'}
                          </span>
                        </div>
                        {etaStr && <div className="train-eta">{etaStr}</div>}
                        {latest?.kind === 'yolo' && (() => {
                          const pct = (v?: number) => `${((v ?? 0) * 100).toFixed(1)}%`;
                          const map50 = latest.map50 ?? 0;
                          return <div className="train-metric-row">
                            <span className="train-metric"><span>Train Loss <InfoTip text="How wrong the boxes and classes are on training images (box, class and distribution losses added up). Lower is better; it should keep falling." /></span><b>{latest.trainLoss.toFixed(3)}</b></span>
                            <span className="train-metric"><span>Val Loss <InfoTip text="The same on validation images, which it never trains on. If it rises while Train Loss falls, the model is memorising rather than learning." /></span><b>{latest.valLoss.toFixed(3)}</b></span>
                            <span className="train-metric"><span>Precision <InfoTip text="Of the boxes it draws, how many are right. Low precision: it sees things that aren't there." /></span><b>{pct(latest.precision)}</b></span>
                            <span className="train-metric"><span>Recall <InfoTip text="Of the things in the images, how many it finds. Low recall: it misses things." /></span><b>{pct(latest.recall)}</b></span>
                            <span className="train-metric"><span>mAP50 <InfoTip text="The main score: how well its boxes find and match the labelled ones (overlapping at least half), across confidence levels, averaged over classes. Above 70% is useful, above 85% very good." /></span><b style={{ color: '#4fc3f7' }}>{pct(map50)}</b><span className="train-metric-bench">{map50 > 0.85 ? '🟢 excellent' : map50 > 0.7 ? '🟢 good' : map50 > 0.5 ? '🟡 decent' : '🟠 learning'}</span></span>
                            <span className="train-metric"><span>mAP50-95 <InfoTip text="The same, but asking for ever tighter boxes (50% to 95% overlap). Stricter and always lower; it shows how exactly the boxes fit." /></span><b>{pct(latest.map)}</b></span>
                          </div>;
                        })()}
                        {latest && latest.kind !== 'yolo' && (
                          <div className="train-metric-row">
                            <span className="train-metric"><span>Train Loss <InfoTip text="How wrong the model is on training images. Lower is better. Starts around 0.7, good models reach below 0.3. If this stops dropping the model has stopped learning." /></span><b>{latest.trainLoss.toFixed(4)}</b><span className="train-metric-bench">{latest.trainLoss < 0.25 ? '🟢 great' : latest.trainLoss < 0.35 ? '🟡 good' : latest.trainLoss < 0.5 ? '🟠 learning' : '🔴 early'}</span></span>
                            <span className="train-metric"><span>Train IoU <InfoTip text="Overlap accuracy on training images (0–100%). Measures how well the predicted mask covers the true mask. Above 65% is good, above 80% is excellent." /></span><b style={{ color: '#69f0ae' }}>{(latest.trainIou * 100).toFixed(1)}%</b><span className="train-metric-bench">{latest.trainIou > 0.80 ? '🟢 excellent' : latest.trainIou > 0.65 ? '🟢 good' : latest.trainIou > 0.50 ? '🟡 decent' : '🟠 learning'}</span></span>
                            <span className="train-metric"><span>Val Loss <InfoTip text="How wrong the model is on held-out images it has never trained on. Should stay close to Train Loss — a large gap means overfitting (memorising rather than learning)." /></span><b>{latest.valLoss.toFixed(4)}</b><span className="train-metric-bench">{latest.valLoss < 0.25 ? '🟢 great' : latest.valLoss < 0.35 ? '🟡 good' : latest.valLoss < 0.5 ? '🟠 learning' : '🔴 early'}</span></span>
                            <span className="train-metric"><span>Val IoU <InfoTip text="The real accuracy score — overlap on images the model has never seen. Above 65% works for detection, above 80% is production-quality. If this is much lower than Train IoU the model is overfitting." /></span><b style={{ color: '#4fc3f7' }}>{(latest.valIou * 100).toFixed(1)}%</b><span className="train-metric-bench">{latest.valIou > 0.80 ? '🟢 excellent' : latest.valIou > 0.65 ? '🟢 good' : latest.valIou > 0.50 ? '🟡 decent' : '🟠 learning'}</span></span>
                          </div>
                        )}
                        {trainStatus === 'done' && <div className="train-done">✓ Training complete — saved to {trainJob.outDir}</div>}
                        {yolo && (yoloBest ?? checkpointInfo?.best) && (
                          <div className="train-model-cta">
                            <span>Best weights: <code>{yoloBest ?? checkpointInfo?.best}</code></span>
                            <button className="train-btn-sm" onClick={() => void window.bridge.policy.reveal((yoloBest ?? checkpointInfo?.best)!)}>Show file</button>
                          </div>
                        )}
                        {trainedModel && (
                          <div className="train-model-cta">
                            <span>{trainedModel.existing ? 'Already in' : 'Added to'} Trained Models as “{models.find(m => m.id === trainedModel.model.id)?.name ?? trainedModel.model.name}”</span>
                            <button className="train-btn-sm" onClick={() => { setSelectedModelId(trainedModel.model.id); setBottomTab('models'); }}>View →</button>
                          </div>
                        )}
                        {(trainStatus === 'done' || checkpointInfo?.found || (yolo && checkpointInfo?.best)) && (
                          <div className="train-done-row">
                            <button className="train-export-btn"
                              disabled={exportState === 'running'}
                              title={`Export ${yolo ? 'the best weights' : 'best.pt'} to ONNX and add it to Trained Models`}
                              onClick={async () => {
                                setExportState('running'); setExportError('');
                                // A detector exports at the size it trained at
                                const res = await window.bridge.training.exportOnnx(trainConfig.outDir, yolo ? { kind: 'yolo' } : { width: sizeInput(trainConfig.width), height: sizeInput(trainConfig.height) }, trainConfig.dataDir);
                                if (!res.ok) { setExportState('error'); setExportError(res.error ?? 'Export failed'); return; }
                                setExportState('done');
                                if (res.model) noteTrainedModel(res.model, !!res.existing);
                                if (res.modelError) { setExportState('error'); setExportError(`Exported, but couldn't add it to Trained Models: ${res.modelError}`); }
                              }}>
                              {exportState === 'running' ? 'Exporting…' : exportState === 'done' ? '✓ Exported ONNX' : 'Export ONNX'}
                            </button>
                            {exportState === 'error' && <span className="train-export-err">{exportError}</span>}
                          </div>
                        )}
                      </div>
                      );
                    })()}
                  </div>

                  <div className="train-log-wrap" ref={trainLogRef}>
                    {trainLogs.length === 0
                      ? <span className="train-log-empty">Logs will appear here</span>
                      : trainLogs.map((l, i) => <div key={i} className={`train-log-line ${l.startsWith('PROGRESS:') ? 'train-log-prog' : ''}`}>{l.startsWith('PROGRESS:') ? '' : l}</div>)
                    }
                  </div>
                </div>
              );
            })()}
          </div>

        </div>

        {/* Inspector */}
        <div className="panel panel-right">
          <div className="panel-tabbar">
            <span className="panel-tab active">Inspector</span>
          </div>
          <div className="inspector">

            <div className="insp-section">
              <div className="insp-section-hd"><span>Capture Target</span></div>
              <div className="insp-row">
                <span className="insp-lbl">Window</span>
                <span className={`insp-val ${!selectedWin ? 'insp-val-none' : ''}`}>{selectedWin?.title ?? 'None'}</span>
              </div>
              <div className="insp-row">
                <span className="insp-lbl">Status</span>
                <span className={`insp-badge ${captureActive ? 'badge-active' : 'badge-idle'}`}>{captureActive ? 'Capturing' : 'Idle'}</span>
              </div>
            </div>

            {selectedId && (
              <div className="insp-section">
                <div className="insp-section-hd">
                  <span>Regions</span>
                  <div style={{ display:'flex', gap:4 }}>
                    <button className="insp-section-action" onClick={() => { ++regionScriptTestVersion.current; setRegionScriptPreview(null); setCreateDialog({ label: 'Region', templates: [], source: 'manual', script: DEFAULT_REGION_SCRIPT, scriptWidth: 800, scriptHeight: 600 }); }}>+ New</button>
                    {regions.length > 0 && <button className="insp-section-action" onClick={() => { setRegions([]); stopAllTracking(); ix.current.selId = null; redraw(); }}>Clear all</button>}
                  </div>
                </div>
                {regions.length === 0 && <div className="insp-hint" style={{ padding: '6px 0 4px' }}>Draw on the game view or click + New</div>}
                {regions.map(r => {
                  const isScript = r.source === 'script';
                  const boxes = visibleScriptBoxes[r.id] ?? [];
                  const isExpanded = expandedRegions.has(r.id);
                  const isSel = ix.current.selId === r.id;
                  const isVisible = r.visible !== false;
                  return (
                    <div key={r.id}>
                      <div className={`region-row ${isSel ? 'region-row-sel' : ''} ${!isVisible ? 'region-row-hidden' : ''}`}
                        onClick={() => {
                          ix.current.selId = r.id; ix.current.selBoxIdx = null;
                          setSelSubBox(null); redraw(); setShowTemplate(true); showSelection();
                        }}>
                        {isScript && (
                          <button className="region-expand-btn" onClick={ev => {
                            ev.stopPropagation();
                            setExpandedRegions(prev => {
                              const next = new Set(prev);
                              next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                              return next;
                            });
                          }}>{isExpanded ? '▾' : '▸'}</button>
                        )}
                        {!isScript && <span style={{ width: 14, flexShrink: 0 }} />}
                        <span className="region-swatch" style={{ opacity: isVisible ? 1 : 0.3 }} />
                        {isScript && !isVisible && <span className="region-off-tag" title="Hidden: its Lua script isn't running">off</span>}
                        <input className="region-label" value={r.label}
                          onChange={e => setRegions(prev => prev.map(x => x.id === r.id ? { ...x, label: e.target.value } : x))} />
                        {isScript && <button className="state-edit" aria-label={`Edit region ${r.label}`} disabled={isRecording} title={isRecording ? 'Stop recording before editing Regions' : 'Edit Lua Region'}
                          onClick={ev => {
                            ev.stopPropagation(); ++regionScriptTestVersion.current; setRegionScriptPreview(null);
                            setCreateDialog({ id: r.id, label: r.label, templates: r.templates, source: 'script', script: r.script ?? '', scriptWidth: r.scriptWidth ?? 0, scriptHeight: r.scriptHeight ?? 0 });
                          }}>Edit</button>}
                        <button className="region-vis-btn" aria-label={`${isVisible ? 'Hide' : 'Show'} ${r.label}`}
                          title={isScript ? (isVisible ? 'Hide: also stops running its Lua script' : 'Show, and run its Lua script again') : isVisible ? 'Hide' : 'Show'}
                          onClick={ev => {
                          ev.stopPropagation();
                          setRegions(prev => prev.map(x => x.id === r.id ? { ...x, visible: !isVisible } : x));
                          if (isScript && isVisible) {
                            // Its script stops, so its boxes are gone, for the Game View and for scripts reading it
                            delete luaRegionSnapshots.current[r.id];
                            const { [r.id]: _boxes, ...boxes } = regionScriptBoxesRef.current;
                            regionScriptBoxesRef.current = boxes; setRegionScriptBoxes(boxes);
                          }
                          redraw();
                        }}>{isVisible ? '◉' : '○'}</button>
                        <button className="region-del" onClick={ev => {
                          ev.stopPropagation();
                          setRegions(prev => prev.filter(x => x.id !== r.id));
                          if (ix.current.selId === r.id) { ix.current.selId = null; ix.current.selBoxIdx = null; setSelSubBox(null); redraw(); }
                          stopTracking(r.id);
                        }}>✕</button>
                      </div>
                      {isScript && isExpanded && (
                        <div className="region-sub-list">
                          {boxes.length === 0 && <div className="region-sub-item region-sub-empty">No boxes returned</div>}
                          {(() => {
                            const nw = visibleSize?.w || liveImgRef.current?.naturalWidth  || 1;
                            const nh = visibleSize?.h || liveImgRef.current?.naturalHeight || 1;
                            return boxes.map((box, i) => {
                            const isSubSel = selSubBox?.regionId === r.id && selSubBox?.idx === i;
                            const isSubHidden = hiddenSubBoxes[r.id]?.has(i) ?? false;
                            const px = Math.round(box.x * nw), py = Math.round(box.y * nh);
                            const pw = Math.round(box.w * nw), ph = Math.round(box.h * nh);
                            return (
                              <div key={i}
                                className={`region-sub-item ${isSubSel ? 'region-sub-item-sel' : ''} ${isSubHidden ? 'region-sub-item-hidden' : ''}`}
                                onClick={() => {
                                  ix.current.selId = r.id; ix.current.selBoxIdx = i;
                                  setSelSubBox({ regionId: r.id, idx: i }); redraw(); setShowTemplate(true);
                                }}>
                                <span className="region-sub-name">{i + 1}</span>
                                <span className="region-sub-coords">{px},{py} · {pw}×{ph}px</span>
                                <button className="region-vis-btn region-sub-vis" title={isSubHidden ? 'Show' : 'Hide'} onClick={ev => {
                                  ev.stopPropagation();
                                  setHiddenSubBoxes(prev => {
                                    const next = { ...prev };
                                    const set = new Set(next[r.id] ?? []);
                                    isSubHidden ? set.delete(i) : set.add(i);
                                    next[r.id] = set;
                                    hiddenSubBoxesRef.current = next;
                                    return next;
                                  });
                                  redraw();
                                }}>{isSubHidden ? '○' : '◉'}</button>
                              </div>
                            );
                          });})()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {selectedId && (
              <div className="insp-section">
                <div className="insp-section-hd">
                  <span>States</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                  <button className="insp-section-action" onClick={() => showStateDialog({
                    name: `State ${gameStates.length + 1}`,
                    type: 'number', source: 'memory',
                    regionId: regions[0]?.id ?? '',
                    address: '', offsets: [], byteType: 'u32',
                    script: DEFAULT_SCRIPT, output: stateOutputs[0].name,
                  })}>+ New</button>
                  <button className="insp-section-action" title="A folder to keep States in" onClick={() =>
                    setStateFolders(prev => [...prev, { id: crypto.randomUUID(), name: `Folder ${prev.length + 1}` }])}>+ Folder</button>
                  </div>
                </div>
                {gameStates.length === 0 && (
                  <div className="insp-hint">Track memory addresses, region values or model observations</div>
                )}
                {(() => {
                const renderState = (s: GameState) => {
                  const isModel = s.source === 'model';
                  const isRegion = s.source === 'region';
                  const stateRegion = isRegion ? regions.find(r => r.id === s.regionId) : undefined;
                  const output = s.output ?? COVERAGE;
                  const isTemplate = isRegion && s.output === TEMPLATE_DETECTED;
                  const isMotion = isRegion && (s.output === REGION_POSITION || s.output === REGION_VELOCITY || s.output === REGION_MATCHES);
                  const outputLabel = output === COVERAGE || output === 'coverage' ? 'Detected area' : output;
                  const val = visibleStateValues[s.id];
                  const hasValue = val !== undefined;
                  const valueError = s.source === 'script' && hasValue ? stateValueError(s.type, val) : null;
                  const isOpen = selectedStateId === s.id;
                  const waiting = s.off ? 'Turned off: switch it on to read it' : paused ? 'No value in this frame' : !captureActive ? 'Start capture to read'
                    : isRegion && !stateRegion ? 'This region was deleted'
                    : isMotion && stateRegion ? (!hasAnchors(stateRegion) ? `Add a template to ${stateRegion.label} so it can follow its object`
                      : !trackedIds.has(stateRegion.id) ? `Turn on “Follow the object in this box” for ${stateRegion.label} to read it` : 'Waiting for value…')
                    : isTemplate ? (selectedTemplateIds(s)?.some(id => !stateRegion?.templates.some(t => t.id === id)) ? 'Selected templates were deleted; update the selection below' : 'Enable template matching on this region with corner resizing off')
                    : isRegion && stateRegion && !readsValues(stateRegion)
                      ? `${stateRegion.label} follows an object, so nothing can be read from it; turn off its template matching`
                    : isRegion && !s.output ? `Add a value to ${stateRegion?.label ?? 'the region'} in the Values tab, then pick it for this state`
                    : isRegion && !liveCompiled.regions.get(s.regionId ?? '')?.recorded.some(o => o.name === s.output)
                      ? `${stateRegion?.label} doesn’t record “${s.output}”; see its Values`
                    : isModel && !runningModels.length ? 'Run a model from Trained Models to read'
                    : isModel && outputLabel === 'Detected area' && !runningOutputs.some(o => o.name === COVERAGE)
                      ? 'Only a segmentation model detects an area; run one to read it'
                    : isModel && outputLabel !== 'Detected area' && !runningOutputs.some(o => o.name === output)
                      ? `${runningNames} ${runningModels.length > 1 ? 'don’t' : 'doesn’t'} record “${output}”; see ${runningModels.length > 1 ? 'their' : 'its'} Outputs`
                    : 'Waiting for value…';
                  return (
                    <div key={s.id}>
                      <div
                        className={`state-row ${isOpen ? 'state-row-open' : ''}${s.off ? ' state-row-off' : ''}`}
                        onClick={() => setSelectedStateId(p => p === s.id ? null : s.id)}
                        // Dragged onto the Policy Graph, a State is a node for the observation it's recorded as;
                        // onto a folder, it moves there
                        draggable
                        title={valueError ?? (recordedStates.observationOf[s.id] && viewTab === 'graph' ? 'Drag onto the Policy Graph' : 'Drag onto a folder to move it there')}
                        onDragStart={ev => {
                          ev.dataTransfer.setData(STATE_DRAG, s.id);
                          const observation = recordedStates.observationOf[s.id];
                          if (observation && !valueError) ev.dataTransfer.setData('application/firefly-node', JSON.stringify({ kind: 'state', name: observation }));
                          ev.dataTransfer.effectAllowed = 'move';
                          setDraggingState(s.id);
                        }}
                        onDragEnd={() => { setDraggingState(null); setDropFolder(null); }}
                      >
                        <button type="button" role="switch" aria-checked={!s.off} aria-label={`${s.name} on`}
                          className={`state-switch${s.off ? '' : ' state-switch-on'}`} disabled={isRecording}
                          title={isRecording ? 'Stop recording before turning States on or off'
                            : s.off ? 'Turned off: not read, run or recorded. Click to turn it on.' : 'On. Click to turn it off: it stops being read (its script stops running) and recorded.'}
                          onClick={ev => { ev.stopPropagation(); setStatesOff([s.id], !s.off); }} />
                        <span className={`state-badge state-badge-${s.type}`}>{STATE_BADGE[s.type]}</span>
                        <div className="state-row-body">
                          <span className="state-name">{s.name}</span>
                          <span className="state-src-label">
                            {s.source === 'region'
                              ? `▣ ${stateRegion?.label ?? 'Region'}${s.output ? ` · ${s.output === TEMPLATE_DETECTED ? templateLabel(regions.find(r => r.id === s.regionId), selectedTemplateIds(s)) : MOTION_LABELS[s.output] ?? s.output}` : ''}`
                              : s.source === 'script'
                              ? '⌘ Lua script'
                              : isModel
                              ? `◆ Model · ${outputLabel}`
                              : `⬡ ${s.address ?? ''}`}
                          </span>
                        </div>
                        {s.off ? <span className="state-off-tag">off</span> : valueError ? <span className="sv-err">Invalid type</span> : hasValue && (
                          <span className={`state-val-chip ${s.type === 'boolean' ? (val ? 'state-val-true' : 'state-val-false') : ''}`}>
                            {formatStateValue(s, val)}
                          </span>
                        )}
                        {!s.off && visibleStateErrors[s.id] && <span className="state-read-status" title={visibleStateErrors[s.id]}>{hasValue ? 'Last value' : 'Read failed'}</span>}
                        <button className="state-edit" aria-label={`Edit ${s.name}`} title={isRecording ? 'Stop recording before editing States' : 'Edit State'} disabled={isRecording}
                          onClick={ev => { ev.stopPropagation(); editState(s); }}>Edit</button>
                        <button className="state-del" onClick={ev => { ev.stopPropagation(); setGameStates(prev => prev.filter(x => x.id !== s.id)); if (isOpen) setSelectedStateId(null); }}>✕</button>
                      </div>
                      {isOpen && (
                        <div className="state-val-panel">
                          {isTemplate && stateRegion && <TemplatePicker label={`Templates for ${s.name}`}
                            templates={stateRegion.templates} selected={selectedTemplateIds(s)}
                            onChange={ids => setGameStates(prev => prev.map(v => v.id === s.id ? { ...v, templateId: undefined, templateIds: ids } : v))}/>}
                          {isTemplate && <>
                            <div className="rtp-threshold-row">
                              <span className="rtp-hint" style={{ margin: 0 }}>Ignore changes shorter than</span>
                              <input type="range" min={0} max={1000} step={50} aria-label={`Settle time for ${s.name}`}
                                value={s.settleMs ?? TEMPLATE_SETTLE_MS}
                                onChange={e => { const ms = parseInt(e.target.value, 10); setGameStates(prev => prev.map(v => v.id === s.id ? { ...v, settleMs: ms } : v)); }} />
                              <span className="rtp-threshold-val">{s.settleMs ?? TEMPLATE_SETTLE_MS} ms</span>
                            </div>
                            <div className="rtp-hint">Usually 0: a moment the object isn’t recognised in keeps the state as it was (up to 0.5 s), and a template that’s winning keeps winning unless another matches clearly better. Set this only if the state still flickers; every change then waits this long.</div>
                          </>}
                          {valueError ? <span className="sv-err">{valueError}</span> : hasValue ? renderStateVal(val) : <span className="sv-nil">{waiting}</span>}
                        </div>
                      )}
                    </div>
                  );
                };
                // A State dragged over a folder, or over the top level, goes there when dropped
                const dropTarget = (folderId: string) => ({
                  onDragOver: (ev: React.DragEvent) => {
                    if (!ev.dataTransfer.types.includes(STATE_DRAG)) return;
                    ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move';
                    if (dropFolder !== folderId) setDropFolder(folderId);
                  },
                  onDrop: (ev: React.DragEvent) => {
                    const id = ev.dataTransfer.getData(STATE_DRAG);
                    if (!id) return;
                    ev.preventDefault(); ev.stopPropagation();
                    setGameStates(prev => prev.map(v => v.id !== id ? v : folderId ? { ...v, folderId } : (({ folderId: _, ...rest }) => rest)(v)));
                    setDraggingState(null); setDropFolder(null);
                  },
                });
                const known = new Set(stateFolders.map(f => f.id));
                const loose = gameStates.filter(s => !s.folderId || !known.has(s.folderId));
                return <>
                  {stateFolders.map(f => {
                    const inside = gameStates.filter(s => s.folderId === f.id);
                    const anyOn = inside.some(s => !s.off);
                    const setFolder = (patch: Partial<StateFolder>) => setStateFolders(prev => prev.map(x => x.id === f.id ? { ...x, ...patch } : x));
                    return (
                      <div key={f.id} className={`state-folder${dropFolder === f.id ? ' state-folder-drop' : ''}`} {...dropTarget(f.id)}>
                        <div className="state-folder-hd" onClick={() => setFolder({ collapsed: !f.collapsed })}>
                          <span className="state-folder-arrow">{f.collapsed ? '▸' : '▾'}</span>
                          <input className="state-folder-name" value={f.name} aria-label="Folder name" spellCheck={false}
                            onClick={ev => ev.stopPropagation()} onChange={e => setFolder({ name: e.target.value })}
                            onBlur={e => { if (!e.target.value.trim()) setFolder({ name: 'Folder' }); }} />
                          <span className="state-folder-count">{inside.length}</span>
                          {inside.length > 0 && (
                            <button type="button" role="switch" aria-checked={anyOn} aria-label={`${f.name} on`}
                              className={`state-switch${anyOn ? ' state-switch-on' : ''}${anyOn && inside.some(s => s.off) ? ' state-switch-mixed' : ''}`} disabled={isRecording}
                              title={isRecording ? 'Stop recording before turning States on or off' : anyOn ? 'Turn off every State in this folder' : 'Turn on every State in this folder'}
                              onClick={ev => { ev.stopPropagation(); setStatesOff(inside.map(s => s.id), anyOn); }} />
                          )}
                          <button className="insp-section-action" title="A new State in this folder" onClick={ev => {
                            ev.stopPropagation();
                            showStateDialog({ name: `State ${gameStates.length + 1}`, type: 'number', source: 'memory', regionId: regions[0]?.id ?? '',
                              address: '', offsets: [], byteType: 'u32', script: DEFAULT_SCRIPT, output: stateOutputs[0].name, folderId: f.id });
                          }}>+</button>
                          <button className="state-del" aria-label={`Delete folder ${f.name}`} title="Delete the folder: its States move out of it, they aren't deleted" onClick={ev => {
                            ev.stopPropagation();
                            setGameStates(prev => prev.map(v => v.folderId === f.id ? (({ folderId: _, ...rest }) => rest)(v) : v));
                            setStateFolders(prev => prev.filter(x => x.id !== f.id));
                          }}>✕</button>
                        </div>
                        {!f.collapsed && <div className="state-folder-body">
                          {inside.map(renderState)}
                          {inside.length === 0 && <div className="insp-hint">Drag States here, or add one with +</div>}
                        </div>}
                      </div>
                    );
                  })}
                  <div className={`state-loose${draggingState && stateFolders.length ? ' state-loose-target' : ''}${dropFolder === '' ? ' state-folder-drop' : ''}`} {...dropTarget('')}>
                    {loose.map(renderState)}
                    {draggingState && gameStates.find(s => s.id === draggingState)?.folderId && <div className="insp-hint">Drop here to take it out of its folder</div>}
                  </div>
                </>;
                })()}
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Create region dialog */}
      {createDialog && (
        <div className="modal-overlay" onClick={() => { ++regionScriptTestVersion.current; setCreateDialog(null); setRegionScriptPreview(null); }}>
          <div className={`modal-card ${createDialog.source === 'script' ? 'modal-card-script' : ''}`} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{createDialog.id ? 'Edit Region' : 'New Region'}</span>
            </div>
            <div className="modal-form">
              <label className="modal-form-lbl">Label</label>
              <input
                aria-label="Region label"
                className="modal-form-input"
                value={createDialog.label}
                onChange={e => setCreateDialog(d => d ? { ...d, label: e.target.value } : null)}
                autoFocus
                onKeyDown={e => e.key === 'Enter' && createDialog.source === 'manual' && handleCreateRegion()}
              />

              <label className="modal-form-lbl">Source</label>
              <div className="state-source-toggle">
                {(['manual', 'script'] as const).map(src => (
                  <button key={src} className={`state-src-btn ${createDialog.source === src ? 'active' : ''}`}
                    disabled={!!createDialog.id}
                    onClick={() => { ++regionScriptTestVersion.current; setCreateDialog(d => d ? { ...d, source: src } : null); setRegionScriptPreview(null); }}>
                    {src === 'manual' ? 'Manual' : 'Lua Script'}
                  </button>
                ))}
              </div>

              {createDialog.source === 'manual' && (
                <>
                  <label className="modal-form-lbl">Templates <span className="modal-form-sub">(optional — upload images to use for matching)</span></label>
                  <input ref={uploadInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => handleUploadFiles(e.target.files)} />
                  <div
                    className="modal-upload-zone"
                    onClick={() => uploadInputRef.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); handleUploadFiles(e.dataTransfer.files); }}
                  >
                    {createDialog.templates.length === 0
                      ? <span className="modal-upload-hint">Click or drag &amp; drop images here</span>
                      : (
                        <div className="modal-upload-thumbs">
                          {createDialog.templates.map((t, i) => (
                            <div key={t.id} className="rtp-thumb-wrap">
                              <img src={t.cropUrl} className="rtp-thumb" alt={`Template ${i + 1}`} title={`Template ${i + 1}`} /><span className="rtp-template-label">{i + 1}</span>
                              <button className="rtp-thumb-del" onClick={ev => { ev.stopPropagation(); setCreateDialog(d => d ? { ...d, templates: d.templates.filter(x => x.id !== t.id) } : null); }}>✕</button>
                            </div>
                          ))}
                          <button className="rtp-thumb-add" onClick={ev => { ev.stopPropagation(); uploadInputRef.current?.click(); }} title="Add more">+</button>
                        </div>
                      )
                    }
                  </div>
                </>
              )}

              {createDialog.source === 'script' && (
                <>
                  <label className="modal-form-lbl">Script coordinate size</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="modal-form-input" aria-label="Script coordinate width" type="number" min={0} value={createDialog.scriptWidth ?? 0}
                      onChange={e => { ++regionScriptTestVersion.current; setRegionScriptPreview(null); setCreateDialog(d => d && { ...d, scriptWidth: Number(e.target.value) }); }} />
                    <span>×</span>
                    <input className="modal-form-input" aria-label="Script coordinate height" type="number" min={0} value={createDialog.scriptHeight ?? 0}
                      onChange={e => { ++regionScriptTestVersion.current; setRegionScriptPreview(null); setCreateDialog(d => d && { ...d, scriptHeight: Number(e.target.value) }); }} />
                  </div>
                  <span className="modal-form-sub">Use the resolution your coordinates come from (e.g. 800 × 600). FireFly scales boxes and accounts for the title bar automatically. 0 uses the current game window dimension.</span>
                  <label className="modal-form-lbl">
                    Lua Script <span className="modal-form-sub">— return {'{ x, y, w, h }'} in game pixels</span>
                  </label>
                  <LuaScriptEditor label="Region Lua script" value={createDialog.script} onChange={value => changeLuaScript('region', value)} regions={regions} states={luaStateItems} excludeId={createDialog.id} />
                  <div className="script-test-bar">
                    <button className="script-test-btn" onClick={handleTestRegionScript} disabled={!createDialog.script.trim() || regionScriptPreview?.running === true}>
                      {regionScriptPreview?.running ? 'Running…' : 'Run Script'}
                    </button>
                    {regionScriptPreview && !regionScriptPreview.running && (
                      <span className={`script-test-status ${regionScriptPreview.error ? 'script-test-err' : 'script-test-ok'}`}>
                        {regionScriptPreview.error ? '✕ Error' : `✓ ${regionScriptPreview.boxes?.length ?? 0} box${(regionScriptPreview.boxes?.length ?? 0) !== 1 ? 'es' : ''}`}
                      </span>
                    )}
                    {!regionScriptPreview && <span className="script-test-hint">Run the script to validate before saving</span>}
                  </div>
                  {regionScriptPreview && !regionScriptPreview.running && (
                    <div className="state-val-panel">
                      {regionScriptPreview.error
                        ? <span className="sv-err">{regionScriptPreview.error}</span>
                        : regionScriptPreview.boxes?.map((b, i) => (
                            <div key={i} className="sv-arr-row">
                              <span className="sv-idx">{i}</span>
                              <div className="sv-cell">
                                <span className="sv-inline-obj">
                                  {(['x','y','w','h'] as const).map((k, ki) => (
                                    <span key={k}>
                                      {ki > 0 && <span className="sv-sep"> · </span>}
                                      <span className="sv-key">{k}:</span>
                                      <span className="sv-num">{Math.round((b[k]) * (k === 'x' || k === 'w' ? (liveImgRef.current?.naturalWidth || 1) : (liveImgRef.current?.naturalHeight || 1)))}</span>
                                    </span>
                                  ))}
                                </span>
                              </div>
                            </div>
                          ))
                      }
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => { ++regionScriptTestVersion.current; setCreateDialog(null); setRegionScriptPreview(null); }}>Cancel</button>
              <button
                className="modal-btn modal-btn-confirm"
                onClick={handleCreateRegion}
                disabled={(!!createDialog.id && isRecording) || (createDialog.source === 'script' && (!regionScriptPreview || !!regionScriptPreview.error || regionScriptPreview.running))}
              >{createDialog.id ? 'Save Changes' : 'Create Region'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create or edit a State */}
      {stateDialog && (
        <div className="modal-overlay" onClick={() => showStateDialog(null)}>
          <div className="modal-card modal-card-script" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{stateDialog.id ? 'Edit State' : 'New State'}</span>
            </div>
            <div className="modal-form">
              <label className="modal-form-lbl">Name</label>
              <input
                className="modal-form-input" autoFocus aria-label="State name"
                value={stateDialog.name}
                onChange={e => setStateDialog(d => d && { ...d, name: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && handleSaveState()}
              />

              {stateFolders.length > 0 && <>
                <label className="modal-form-lbl">Folder</label>
                <select aria-label="State folder" className="modal-form-select" value={stateDialog.folderId ?? ''}
                  onChange={e => setStateDialog(d => d && { ...d, folderId: e.target.value || undefined })}>
                  <option value="">No folder</option>
                  {stateFolders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </>}

              <label className="modal-form-lbl">Type</label>
              <select aria-label="State type" className="modal-form-select" value={stateDialog.type} disabled={stateDialog.source === 'model' || stateDialog.source === 'region'}
                title={stateDialog.source === 'model' || stateDialog.source === 'region' ? 'Set by the value it reads' : undefined}
                onChange={e => setStateDialog(d => d && { ...d, type: e.target.value as StateType })}>
                {STATE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
                ))}
              </select>

              <label className="modal-form-lbl">Source</label>
              <div className="state-source-toggle">
                {(['memory', 'script', 'region', 'model'] as const).map(src => (
                  <button key={src} className={`state-src-btn ${stateDialog.source === src ? 'active' : ''}`}
                    onClick={() => {
                      ++scriptTestVersion.current;
                      setScriptPreview(null);
                      setStateDialog(d => {
                        if (!d) return d;
                        if (src === 'model') return pickModelOutput(d, d.output, stateOutputs);
                        if (src !== 'region') return { ...d, source: src };
                        const regionId = readable.some(r => r.id === d.regionId) ? d.regionId : readable[0]?.id ?? '';
                        return pickStateRegion(d, regionId, d.output);
                      });
                      if (src !== 'script') setScriptPreview(null);
                    }}>
                    {src === 'memory' ? 'Memory' : src === 'script' ? 'Lua Script' : src === 'region' ? 'Region' : 'Model'}
                  </button>
                ))}
              </div>

              {stateDialog.source === 'model' && (
                <>
                  <label className="modal-form-lbl">
                    Observation <span className="modal-form-sub">(from the models running in Trained Models)</span>
                  </label>
                  <select aria-label="State value" className="modal-form-select" value={stateDialog.output}
                    onChange={e => setStateDialog(d => d && pickModelOutput(d, e.target.value, stateOutputs))}>
                    {stateOutputs.map(o => <option key={o.name} value={o.name}>{o.label} — {valueKind(o.type)}</option>)}
                  </select>
                  {!runningModels.length && (
                    <div className="modal-form-hint">No model is running. Values appear once you press Run in Trained Models.</div>
                  )}
                </>
              )}

              {stateDialog.source === 'script' && (
                <>
                  <label className="modal-form-lbl">
                    Lua Script <span className="modal-form-sub">(sandboxed — no file/network access)</span>
                  </label>
                  <label className="modal-form-lbl">Region reference coordinate size</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="modal-form-input" aria-label="State reference width" type="number" min={0} value={stateDialog.scriptWidth ?? 0}
                      onChange={e => { ++scriptTestVersion.current; setScriptPreview(null); setStateDialog(d => d && { ...d, scriptWidth: Number(e.target.value) }); }} />
                    <span>×</span>
                    <input className="modal-form-input" aria-label="State reference height" type="number" min={0} value={stateDialog.scriptHeight ?? 0}
                      onChange={e => { ++scriptTestVersion.current; setScriptPreview(null); setStateDialog(d => d && { ...d, scriptHeight: Number(e.target.value) }); }} />
                  </div>
                  <span className="modal-form-sub">Region boxes use this coordinate size. Use 800 × 600 for original game coordinates, or 0 for current client dimensions. The script's returned value is unchanged.</span>
                  <LuaScriptEditor label="State Lua script" value={stateDialog.script} onChange={value => changeLuaScript('state', value)} regions={regions} states={luaStateItems} excludeId={stateDialog.id} />
                  <div className="script-test-bar">
                    <button
                      className="script-test-btn"
                      onClick={handleTestScript}
                      disabled={!stateDialog.script.trim() || scriptPreview?.running === true}
                    >
                      {scriptPreview?.running ? 'Running…' : 'Run Script'}
                    </button>
                    {scriptPreview && !scriptPreview.running && (
                      <span className={`script-test-status ${scriptPreviewError ? 'script-test-err' : 'script-test-ok'}`}>
                        {scriptPreviewError ? '✕ Error' : '✓ OK'}
                      </span>
                    )}
                    {stateDialog.source === 'script' && !scriptPreview && (
                      <span className="script-test-hint">Run the script to preview output before saving</span>
                    )}
                  </div>
                  {scriptPreview && !scriptPreview.running && (
                    <div className="state-val-panel">
                      {scriptPreviewError
                        ? <span className="sv-err">{scriptPreviewError}</span>
                        : renderStateVal(scriptPreview.result)}
                    </div>
                  )}
                </>
              )}

              {stateDialog.source === 'region' && (() => {
                const values = liveCompiled.regions.get(stateDialog.regionId)?.recorded ?? [];
                const chosenRegion = regions.find(r => r.id === stateDialog.regionId);
                return (
                  <>
                    <label className="modal-form-lbl">Region</label>
                    {readable.length === 0
                      ? <div className="modal-form-hint">{'No eligible regions — draw a region or add matching templates first.'}</div>
                      : <select aria-label="State region" className="modal-form-select" value={stateDialog.regionId}
                          onChange={e => setStateDialog(d => d && pickStateRegion(d, e.target.value, d.output))}>
                          {readable.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>}
                    {readable.length > 0 && (
                      <>
                        <label className="modal-form-lbl">Value <span className="modal-form-sub">(what to read from the box)</span></label>
                        <select aria-label="State value" className="modal-form-select" value={stateDialog.output}
                          onChange={e => setStateDialog(d => d && pickStateRegion(d, d.regionId, e.target.value))}>
                          {values.map(v => <option key={v.name} value={v.name}>{v.name} — {valueKind(v.type)}</option>)}
                          {chosenRegion && readsValues(chosenRegion) && REGION_TEMPLATES.map(t => <option key={t.id} value={`${NEW_VALUE}${t.id}`}>New: {t.label}</option>)}
                          {!!chosenRegion?.templates.length && <option value={TEMPLATE_DETECTED}>Template detected — boolean</option>}
                          {chosenRegion && hasAnchors(chosenRegion) && <>
                            <option value={REGION_POSITION}>Position — vector</option>
                            <option value={REGION_VELOCITY}>Velocity — vector</option>
                            <option value={REGION_MATCHES}>Every match — shapes</option>
                          </>}
                        </select>
                        {(stateDialog.output === REGION_POSITION || stateDialog.output === REGION_VELOCITY) && (
                          <div className="modal-form-hint">
                            {stateDialog.output === REGION_POSITION
                              ? 'Where the centre of the box is in the window, in px (x right, y down).'
                              : 'How fast the centre of the box moves, in px per second (x right, y down), over the last tenth of a second.'}
                            {' '}Read while the region follows its object; empty while the object is lost.{chosenRegion?.multiMatch ? ' With Multi-Match on, it\u2019s the strongest match.' : ''}
                          </div>
                        )}
                        {stateDialog.output === REGION_MATCHES && (
                          <div className="modal-form-hint">
                            Where every match is: a point at the centre of each, in window px, with its size, how well it matched and which template.
                            {chosenRegion?.multiMatch ? ' Multi-Match is on, so that\u2019s every instance, such as every monster.' : ' Turn on Multi-Match in the region for every instance; following one object, it\u2019s just that one.'}
                            {' '}None is an empty list. Use it through a formula, such as nearest(monsters, p) or count_within(monsters, p, 150).
                          </div>
                        )}
                        {stateDialog.output === TEMPLATE_DETECTED && chosenRegion && <>
                          <TemplatePicker label="State templates" templates={chosenRegion.templates} selected={selectedTemplateIds(stateDialog)}
                            onChange={ids => setStateDialog(d => d && { ...d, templateId: undefined, templateIds: ids })}/>
                          <div className="modal-form-hint">Enable template matching on this region to read it; corner resizing must be off.</div>
                        </>}
                        {stateDialog.output.startsWith(NEW_VALUE) && (() => {
                          const template = REGION_TEMPLATES.find(t => t.id === stateDialog.output.slice(NEW_VALUE.length));
                          return (
                            <div className="modal-form-hint">
                              {template?.description}{' '}
                              {template?.usesColor === false
                                ? 'It opens in the Values tab so you can adjust how the text is read.'
                                : 'It looks for the most common colour in the box and opens in the Values tab so you can adjust it.'}
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </>
                );
              })()}

              {stateDialog.source === 'memory' && (
                <>
                  <label className="modal-form-lbl">Base Address <span className="modal-form-sub">(hex)</span></label>
                  <input
                    className="modal-form-input modal-form-mono"
                    placeholder="0x7FFF1234"
                    value={stateDialog.address}
                    onChange={e => setStateDialog(d => d && { ...d, address: e.target.value })}
                  />

                  <label className="modal-form-lbl">
                    Pointer Offsets <span className="modal-form-sub">(optional — each dereferences the previous address)</span>
                  </label>
                  {stateDialog.offsets.map((off, i) => (
                    <div key={i} className="state-offset-row">
                      <input
                        className="modal-form-input modal-form-mono"
                        placeholder="0x00"
                        value={off}
                        onChange={e => setStateDialog(d => {
                          if (!d) return null;
                          const offsets = [...d.offsets]; offsets[i] = e.target.value;
                          return { ...d, offsets };
                        })}
                      />
                      <button className="state-offset-del"
                        onClick={() => setStateDialog(d => d && { ...d, offsets: d.offsets.filter((_, j) => j !== i) })}>✕</button>
                    </div>
                  ))}
                  <button className="state-offset-add"
                    onClick={() => setStateDialog(d => d && { ...d, offsets: [...d.offsets, ''] })}>
                    + Add Offset
                  </button>

                  <label className="modal-form-lbl">Read As</label>
                  <select className="modal-form-select" value={stateDialog.byteType}
                    onChange={e => setStateDialog(d => d && { ...d, byteType: e.target.value as ByteType })}>
                    {BYTE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => showStateDialog(null)}>Cancel</button>
              <button
                className="modal-btn modal-btn-confirm"
                onClick={handleSaveState}
                title={stateDialog.id && isRecording ? 'Stop recording before editing States' : undefined}
                disabled={(!!stateDialog.id && isRecording) || (stateDialog.source === 'script' && (!scriptPreview || !!scriptPreviewError || scriptPreview.running))
                  || (stateDialog.source === 'region' && (!readable.some(r => r.id === stateDialog.regionId) || (stateDialog.output === TEMPLATE_DETECTED && selectedTemplateIds(stateDialog)?.length === 0)))}
              >{stateDialog.id ? 'Save Changes' : 'Add State'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Session confirmation dialog */}
      {confirmDialog && (() => {
        const dlg = confirmDialog;
        const thumb = thumbnails[dlg.title];
        const savedKey = `firefly-regions-${encodeURIComponent(dlg.title)}`;
        let savedCount = 0;
        try { const s = localStorage.getItem(savedKey); if (s) savedCount = (JSON.parse(s) as Region[]).length; } catch {}
        return (
          <div className="modal-overlay" onClick={() => setConfirmDialog(null)}>
            <div className="modal-card" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Start Session</span>
              </div>
              {thumb && <img src={thumb} className="modal-thumb" alt="" />}
              <div className="modal-win-title">{dlg.title}</div>
              {captureActive && selectedWin && (
                <div className="modal-warn">Stops current capture of "{selectedWin.title}"</div>
              )}
              {savedCount > 0
                ? <div className="modal-session-info">Resuming — {savedCount} region{savedCount !== 1 ? 's' : ''} from last session</div>
                : <div className="modal-session-info modal-session-new">New session</div>
              }
              <div className="modal-actions">
                <button className="modal-btn modal-btn-cancel" onClick={() => setConfirmDialog(null)}>Cancel</button>
                <button className="modal-btn modal-btn-confirm" onClick={() => { setConfirmDialog(null); selectWindow(dlg.windowId, dlg.title); }}>Start Session</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Status bar */}
      <div className="statusbar">
        <span className={`sb-dot ${ready ? 'sb-dot-on' : 'sb-dot-off'}`} />
        <span className="sb-seg">{ready ? 'Runtime connected' : 'Connecting…'}</span>
        {captureActive && <><span className="sb-sep">|</span><span className="sb-seg">Capturing: {selectedWin?.title}</span></>}
        {runningModels.length > 0 && <><span className="sb-sep">|</span><span className="sb-seg">{runningModels.length > 1 ? 'Models' : 'Model'}: {runningModels.map(m => m.name).join(', ')}</span></>}
        {isRecording && <><span className="sb-sep">|</span><span className="sb-seg sb-rec"><span className="rec-dot-sm anim" /> {recording!.samples.toLocaleString()} samples · {fmt(elapsed)}</span></>}
        {error && <><span className="sb-sep">|</span><span className="sb-seg sb-err">{error} <button className="sb-err-close" onClick={() => setError('')}>✕</button></span></>}
      </div>
    </div>
  );
}
