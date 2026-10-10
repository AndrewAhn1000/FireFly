import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, addEdge, reconnectEdge, useEdgesState, useNodeId, useNodesState, useReactFlow,
  type Connection, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import AliasInput from './FormulaAliasInput';
import { buttonLabel } from './Keyboard';
import { cleanError, correctionShareHint, correctionsOf, DEFAULT_CORRECTION_SHARE, deleteVersions, MAX_CORRECTION_SHARE, meanF1, newestFirst, percent, playingText, POLICY_VERSION, type PlayStatus, type PolicyVersion, type Schema } from './policyPlay';
import { NEW_INPUT, aliasFrom, renameIn } from './formulaInputs';
import { PreservedTextarea, PreservedInput } from './PreservedInputs';
import {
  FORMULA_INPUT_TYPES, GRID_CELL, VALUE_TYPES, compilePolicy, formulaSpecs, gridSpecs, makesCycle, nameOf, readGraph,
  type Compiled, type FormulaCheck, type FormulaData, type GraphDoc, type GraphNode, type GridData, type PolicyData, type RecordingsData, type StateData,
} from './graphModel';

// The Policy Graph: a policy's dataset built as a graph. States (the observations recordings hold) are
// dragged in, formulas relate them to each other, a Recordings node says which recordings are the rows,
// and a Policy node collects the values that are its dataset's columns and the buttons that are its
// labels. Train makes a new version of that named policy, which can be played; the same dataset can be
// exported. The worker (worker/worker.py) checks formulas, previews and trains; this only edits the graph
// and shows what it says. The graph is kept per captured window, like its regions and States.

interface Recording {
  id: string; name: string; status: string; samples: number; invalidSamples: number; durationMs: number;
  metadata: { started: number; hz?: number; observationSchema?: Schema; actionSchema?: Schema; correction?: boolean; policyId?: string };
}
interface Preview {
  samples: number; stepMs: number; recordings: { id: string; rows: number }[]; skipped: string[];
  skippedReasons: Record<string, number>; values: string[]; inputs: number; buttons: { id: string; pressed: number }[];
}
// What the worker says about a grid: its cells in the latest sample, for the Grid node's picture
interface GridCheck { name: string; cols?: number; rows?: number; values: number[] | null; screen?: [number, number] | null; centred?: boolean; error: string | null; }
interface Epoch { epoch: number; validationLoss: number; buttonF1?: number; }

const fmt = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 3 : 1);
const skipText = (skips?: Record<string, number>) => {
  const entries = Object.entries(skips ?? {}).filter(([, n]) => n > 0);
  if (!entries.length) return '';
  const total = entries.reduce((n, [, c]) => n + c, 0);
  return `${total.toLocaleString()} step${total === 1 ? '' : 's'} skipped: ${entries.slice(0, 3).map(([r, n]) => `${r} (${n.toLocaleString()})`).join(', ')}${entries.length > 3 ? ', …' : ''}`;
};

interface Ctx {
  fields: Map<string, string>; recordedAnywhere: Set<string>; labels: Record<string, string>; recordings: Recording[]; checks: Map<string, FormulaCheck>; gridChecks: Map<string, GridCheck>;
  compiled: Record<string, Compiled>; previews: Record<string, Preview | { error: string } | 'loading'>;
  versions: PolicyVersion[]; deleteVersion(v: PolicyVersion, n: number, corrections: number): void;
  deleteAll(versions: PolicyVersion[], name: string, corrections: number): void; status: PlayStatus; training: { nodeId: string; progress: Epoch | null } | null;
  capturing: boolean; windowId: string | null; recordingNow: boolean; corrections: boolean;
  setCorrections(on: boolean): void;
  update(id: string, patch: Record<string, unknown>): void; removeNode(id: string): void; removeInput(id: string, alias: string): void;
  train(id: string, withCorrections?: boolean): void; exportDataset(id: string): void; play(modelId: string): void; stop(): void;
  exported: { nodeId: string; text: string; path?: string } | null;
  wiredInto(nodeId: string, handle: string): string | null; // the name of what's wired into a node's input
  // A formula's inputs: a new one wired from a node, renamed (in the formula's text too), and what can be wired
  addInput(formulaId: string, sourceId: string): void; renameInput(formulaId: string, alias: string, next: string): void;
  inputChoices(formulaId: string): { id: string; label: string }[];
  hot(nodeId: string, handle: string): boolean; // an end of the wire under the pointer
}
const GraphContext = createContext<Ctx | null>(null);
const useGraph = () => useContext(GraphContext)!;

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────────

function StateNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as StateData, type = g.fields.get(d.name);
  const usable = type && FORMULA_INPUT_TYPES.includes(type);
  return <div className={`pg-node pg-state ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-dot" />{g.labels[d.name] ?? d.name}<span className="pg-type">{type ?? '?'}</span><button className="nodrag pg-x pg-node-delete" title={`Delete ${g.labels[d.name] ?? d.name} node`} aria-label="Delete node" onClick={() => g.removeNode(id)}>✕</button></div>
    {g.labels[d.name] && g.labels[d.name] !== d.name && <div className="pg-hint">recorded as {d.name}</div>}
    {!type && <div className="pg-warn">Its type isn't known until FireFly observes it: start a capture session</div>}
    {type && !g.recordedAnywhere.has(d.name) && <div className="pg-hint">Not recorded yet: tick it in the Recordings tab and record</div>}
    {type && !usable && <div className="pg-warn">{type} can't be used</div>}
    {type === 'shapes' && <div className="pg-hint">Shapes are used through a formula</div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

function FormulaNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as FormulaData, check = g.checks.get(d.name.trim());
  const choices = g.inputChoices(id);
  return <div className={`pg-node pg-formula ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">ƒ</span>
      <PreservedInput className="nodrag pg-name" aria-label="Formula name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete formula ${d.name || ''}`} aria-label="Delete formula node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    {d.inputs.map(alias => {
      const from = g.wiredInto(id, `in:${alias}`);
      return <div key={alias} className="pg-input-row">
        <PgHandle type="target" position={Position.Left} id={`in:${alias}`} />
        <AliasInput alias={alias} taken={d.inputs} onRename={next => g.renameInput(id, alias, next)} />
        <span className={`pg-from ${from ? '' : 'pg-unwired'}`} title={from ? `${alias} stands for ${g.labels[from] ?? from}` : 'Wire something into it'}>
          {from ? `← ${g.labels[from] ?? from}` : 'not wired'}</span>
        <button className="nodrag pg-x" title={`Remove input ${alias}`} onClick={() => g.removeInput(id, alias)}>✕</button>
      </div>;
    })}
    <div className="pg-input-row pg-new-input">
      <PgHandle type="target" position={Position.Left} id={NEW_INPUT} extra="pg-handle-new" />
      <span>Drop a wire here for a new input, or</span>
      <select className="nodrag" aria-label="Add an input from" value="" onChange={e => { if (e.target.value) g.addInput(id, e.target.value); }}>
        <option value="">+ input from…</option>
        {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </div>
    <PreservedTextarea className="nodrag nowheel pg-source" aria-label="Formula" rows={2} spellCheck={false} value={d.source}
      placeholder={d.inputs.length >= 2 ? `distance(${d.inputs[0]}, ${d.inputs[1]})` : 'a * 2'}
      onChange={e => g.update(id, { source: e.target.value })} />
    {!check ? <div className="pg-hint">{d.name.trim() ? 'Checking…' : 'Name it to use it'}</div>
      : check.error ? <div className="pg-error">{check.error}</div>
      : <div className="pg-hint">{check.type === 'vector' ? 'vector' : check.type === 'boolean' ? 'true/false' : 'number'} → {check.columns.join(', ')}
          {check.preview && check.preview.rows > 0 && <> · {check.preview.value ? `first ${check.preview.value.map(fmt).join(', ')}` : 'never there'}
            {check.preview.missing > 0 && <span className="pg-missing" title={check.preview.reason ?? ''}> · missing in {check.preview.missing} of {check.preview.rows}</span>}</>}
        </div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

// A node's connection point, lit while the wire under the pointer ends there
function PgHandle({ type, position, id, extra = '' }: { type: 'source' | 'target'; position: Position; id: string; extra?: string }) {
  const g = useGraph(), nodeId = useNodeId() ?? '';
  return <Handle type={type} position={position} id={id} className={`pg-handle ${extra} ${g.hot(nodeId, id) ? 'pg-handle-hot' : ''}`} />;
}


// A heat map of a grid's cells, as the worker worked them out for the latest sample
function GridPicture({ check, cols, rows, centred }: { check?: GridCheck; cols: number; rows: number; centred: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = 216, height = Math.max(24, Math.round(width * rows / cols * (check?.screen ? check.screen[1] / check.screen[0] * cols / rows : 9 / 16)));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    const values = check?.values, cw = c.width / cols, ch = c.height / rows;
    if (values && values.length === cols * rows)
      values.forEach((v, i) => { if (v > 0) { g.fillStyle = `rgba(86, 195, 86, ${0.25 + 0.75 * Math.min(1, v)})`; g.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, Math.ceil(cw), Math.ceil(ch)); } });
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let x = 1; x < cols; x++) { g.beginPath(); g.moveTo(x * cw, 0); g.lineTo(x * cw, c.height); g.stroke(); }
    for (let y = 1; y < rows; y++) { g.beginPath(); g.moveTo(0, y * ch); g.lineTo(c.width, y * ch); g.stroke(); }
    if (centred) { // where it's centred, such as the player
      g.strokeStyle = '#f0a020'; g.lineWidth = 2;
      g.beginPath(); g.arc(c.width / 2, c.height / 2, 4, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1;
    }
  }, [check, cols, rows, height, centred]);
  return <canvas ref={ref} width={width} height={height} className="pg-grid-picture" aria-label="Grid preview" />;
}

function GridNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as GridData, check = g.gridChecks.get(d.name.trim());
  const centre = g.wiredInto(id, 'in:center'), cell = d.cell ?? GRID_CELL;
  const num = (key: 'cols' | 'rows' | 'width' | 'height' | 'cell', min: number, max: number) => (e: ChangeEvent<HTMLInputElement>) =>
    g.update(id, { [key]: Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))) });
  return <div className={`pg-node pg-grid ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">▦</span>
      <PreservedInput className="nodrag pg-name" aria-label="Grid name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete grid ${d.name || ''}`} aria-label="Delete grid node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="in:shapes" />Shapes, such as platforms</div>
    <div className="pg-port" title="Wire a position in, such as the player's, and the grid moves with it: a cell is the same place beside it anywhere on the screen, and on any map">
      <PgHandle type="target" position={Position.Left} id="in:center" />
      {centre ? <>Centred on <b>{g.labels[centre] ?? centre}</b></> : 'Centred on (optional): else the whole screen'}</div>
    <div className="pg-settings">
      <label className="nodrag">Columns<input type="number" min={1} max={64} value={d.cols} onChange={num('cols', 1, 64)} /></label>
      <label className="nodrag">Rows<input type="number" min={1} max={64} value={d.rows} onChange={num('rows', 1, 64)} /></label>
      <label className="nodrag">Each cell<select value={d.mode} onChange={e => g.update(id, { mode: e.target.value })}>
        <option value="coverage">How much is covered</option><option value="present">Whether anything is there</option></select></label>
      {centre
        ? <label className="nodrag" title="Each cell's size: the grid reaches half its width and height either side of the centre">Cell (px)
            <input type="number" min={4} max={400} value={cell} onChange={num('cell', 4, 400)} /></label>
        : <label className="nodrag" title="The screen size used for recordings from before FireFly kept each frame's size">Screen (older recordings)
            <span className="pg-pair"><input type="number" min={16} value={d.width} onChange={num('width', 16, 8000)} />×<input type="number" min={16} value={d.height} onChange={num('height', 16, 8000)} /></span></label>}
    </div>
    {centre && <div className="pg-hint">Reaches {d.cols * cell}×{d.rows * cell} px around it.</div>}
    <GridPicture check={check} cols={d.cols} rows={d.rows} centred={!!centre} />
    {check?.error ? <div className="pg-error">{check.error}</div>
      : <div className="pg-hint">{d.cols * d.rows} values{d.cols * d.rows > 300 ? ': many for a small policy to learn from; record plenty, or use fewer cells' : ''}.
          {check?.values ? ' The latest sample of the recordings, as the policy sees it.' : ' Wire shapes in and choose recordings to see it.'}</div>}
    <PgHandle type="source" position={Position.Right} id="out" />
  </div>;
}

function RecordingsNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as RecordingsData;
  const first = g.recordings.find(r => r.id === d.ids[0]);
  const compatible = (r: Recording) => !first || (r.metadata.observationSchema?.identity === first.metadata.observationSchema?.identity
    && r.metadata.actionSchema?.identity === first.metadata.actionSchema?.identity);
  const toggle = (rid: string, on: boolean) => g.update(id, { ids: on ? [...d.ids, rid] : d.ids.filter(x => x !== rid) });
  return <div className={`pg-node pg-recordings ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">▤</span>Recordings<span className="pg-type">{d.ids.length} chosen</span><button className="nodrag pg-x pg-node-delete" title="Delete recordings node" aria-label="Delete recordings node" onClick={() => g.removeNode(id)}>✕</button></div>
    <div className="nowheel pg-list">
      {!g.recordings.some(r => !r.metadata.correction) && <div className="pg-hint">No complete recordings yet</div>}
      {g.recordings.filter(r => !r.metadata.correction).map(r => {
        const on = d.ids.includes(r.id), ok = compatible(r), empty = r.samples > 0 && r.invalidSamples >= r.samples;
        return <label key={r.id} className={`nodrag pg-rec ${!ok ? 'pg-dim' : ''}`}
          title={!ok ? 'Recorded different observations or buttons than the first one chosen' : empty ? 'No valid samples' : ''}>
          <input type="checkbox" checked={on} disabled={!on && !ok} onChange={e => toggle(r.id, e.target.checked)} />
          <span>{r.metadata.correction ? '✋ ' : ''}{r.name}<small>{r.samples.toLocaleString()} samples · {(r.durationMs / 1000).toFixed(0)} s</small></span>
        </label>;
      })}
    </div>
    <PgHandle type="source" position={Position.Right} id="data" extra="pg-handle-data" />
  </div>;
}

function PolicyNode({ id, data, selected }: NodeProps<GraphNode>) {
  const g = useGraph(), d = data as PolicyData, compiled = g.compiled[id], preview = g.previews[id];
  const recorded = g.recordings.find(r => compiled?.request?.recordingIds.includes(r.id) || false)?.metadata.actionSchema?.buttons
    ?? g.recordings.find(r => r.metadata.actionSchema?.buttons)?.metadata.actionSchema?.buttons ?? [];
  const chosen = d.buttons ?? recorded.map(b => b.id);
  const off = new Set(d.off);
  const versions = g.versions.filter(v => v.policy?.id === id);
  const [allVersions, setAllVersions] = useState(false);
  // Corrections of its versions, deleted ones too: they're still this policy's
  const corrections = correctionsOf(versions, g.recordings);
  const training = g.training?.nodeId === id;
  const setColumn = (cols: string[], on: boolean) => {
    const next = new Set(d.off);
    for (const c of cols) { if (on) next.delete(c); else next.add(c); }
    g.update(id, { off: [...next] });
  };
  const num = (key: 'history' | 'delayMs' | 'epochs', min: number, max: number) => (e: ChangeEvent<HTMLInputElement>) =>
    g.update(id, { [key]: Math.min(max, Math.max(min, Number(e.target.value) || 0)) });
  return <div className={`pg-node pg-policy ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">◎</span>
      <PreservedInput className="nodrag pg-name" aria-label="Policy name" value={d.name} placeholder="Name" onChange={e => g.update(id, { name: e.target.value })} />
      <button className="nodrag pg-x pg-node-delete" title={`Delete policy ${d.name || ''}`} aria-label="Delete policy node" onClick={() => g.removeNode(id)}>✕</button>
    </div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="values" />Values: states and formulas</div>
    <div className="pg-port"><PgHandle type="target" position={Position.Left} id="data" extra="pg-handle-data" />Data: a Recordings node</div>
    <div className="pg-section nowheel">
      <div className="pg-section-hd">Values <small>the dataset's columns</small></div>
      {!compiled?.values.length && <div className="pg-hint">Wire states or formulas in</div>}
      {compiled?.values.map(v => <div key={v.nodeId} className="pg-value">
        <label className="nodrag"><input type="checkbox" checked={v.columns.length > 0 && v.columns.some(c => !off.has(c))}
          onChange={e => setColumn(v.columns, e.target.checked)} /><b>{v.name}</b><small>{v.type === 'grid' ? `grid · ${v.columns.length} cells` : v.type ?? ''}</small></label>
        {v.columns.length > 1 && v.type !== 'grid' && v.columns.map(c => <label key={c} className="nodrag pg-column">
          <input type="checkbox" checked={!off.has(c)} onChange={e => setColumn([c], e.target.checked)} />{c.slice(v.name.length + 1)}
        </label>)}
      </div>)}
      <div className="pg-section-hd">Labels <small>the buttons it learns and presses, of those its recordings recorded (chosen in the Recordings tab)</small></div>
      <div className="pg-buttons">
        {recorded.map(b => <label key={b.id} className="nodrag"><input type="checkbox" checked={chosen.includes(b.id)}
          onChange={e => { const next = e.target.checked ? [...chosen, b.id] : chosen.filter(x => x !== b.id);
            g.update(id, { buttons: next.length === recorded.length ? null : next }); }} />{buttonLabel(b.id)}</label>)}
        {!recorded.length && <div className="pg-hint">Choose recordings to see their buttons</div>}
      </div>
      <div className="pg-settings">
        <label className="nodrag">Time step (ms)<input type="number" min={10} max={1000} value={d.stepMs ?? ''}
          placeholder={preview && typeof preview === 'object' && 'stepMs' in preview ? fmt(preview.stepMs) : 'auto'}
          onChange={e => g.update(id, { stepMs: e.target.value === '' ? null : Number(e.target.value) })} /></label>
        <label className="nodrag">Earlier steps<input type="number" min={0} max={4} value={d.history} onChange={num('history', 0, 4)} /></label>
        <label className="nodrag">Buttons from (ms later)<input type="number" min={0} max={1000} step={50} value={d.delayMs} onChange={num('delayMs', 0, 1000)} /></label>
        <label className="nodrag">Epochs<input type="number" min={1} max={200} value={d.epochs} onChange={num('epochs', 1, 200)} /></label>
      </div>
      <div className="pg-section-hd">Dataset</div>
      {compiled?.problems.map(p => <div key={p} className="pg-warn">{p}</div>)}
      {!compiled?.problems.length && (preview === 'loading' || !preview ? <div className="pg-hint">Working out the dataset…</div>
        : 'error' in preview ? <div className="pg-error">{preview.error}</div>
        : <div className="pg-dataset">
            <div><b>{preview.samples.toLocaleString()}</b> rows × <b>{preview.values.length}</b> values
              {d.history ? ` (${preview.inputs} inputs with ${d.history} earlier step${d.history > 1 ? 's' : ''})` : ''} · {fmt(preview.stepMs)} ms apart</div>
            <div className="pg-hint">{preview.buttons.map(b => `${buttonLabel(b.id)} ${percent(b.pressed)}`).join(' · ')} pressed</div>
            {skipText(preview.skippedReasons) && <div className="pg-missing">{skipText(preview.skippedReasons)}</div>}
            {/* A button no row presses is one the policy learns never to press: say so before training */}
            {(() => { const never = preview.buttons.filter(b => b.pressed === 0).map(b => buttonLabel(b.id));
              return never.length > 0 && <div className="pg-warn">Never pressed in these rows: {never.join(', ')}. The policy will never press {never.length > 1 ? 'them' : 'it'}: record {never.length > 1 ? 'them' : 'it'} being used (the buttons are chosen in the Recordings tab), or untick {never.length > 1 ? 'them' : 'it'} under Labels.</div>; })()}
            {preview.samples > 0 && preview.samples < 500 && <div className="pg-warn">Only {preview.samples} rows ({(preview.samples * preview.stepMs / 1000).toFixed(0)} s of play): a policy learns little from so few. Record more, several minutes of the behaviour.</div>}
          </div>)}
      <div className="pg-actions">
        <button className="nodrag modal-btn pg-train" disabled={!compiled?.request || !!g.training || g.recordingNow} onClick={() => g.train(id)}>
          {training ? `Training… ${g.training?.progress ? `${g.training.progress.epoch}/${d.epochs}` : ''}` : versions.length ? 'Train a new version' : 'Train'}</button>
        <button className="nodrag modal-btn pg-export" disabled={!compiled?.request || !!g.training} onClick={() => g.exportDataset(id)}>Export dataset…</button>
      </div>
      {g.exported?.nodeId === id && <div className="pg-hint">{g.exported.text}{g.exported.path &&
        <> <a href="#" className="nodrag" onClick={e => { e.preventDefault(); void window.bridge.policy.reveal(g.exported!.path!); }}>Show in folder</a></>}</div>}
      {versions.length > 0 && <>
        <div className="pg-section-hd pg-versions-hd">Versions
          {(() => {
            const playingOne = g.status.playing && versions.some(v => v.id === g.status.modelId);
            return <button className="nodrag pg-link pg-delete-all" disabled={playingOne || training}
              title={playingOne ? 'Stop the version playing first' : training ? 'Wait for training to finish' : `Delete all ${versions.length} versions${corrections.length ? `, and their ${corrections.length} corrections` : ''}`}
              onClick={() => g.deleteAll(versions, d.name || 'this policy', corrections.length)}>Delete all</button>;
          })()}
        </div>
        {(allVersions ? versions : versions.slice(0, 5)).map((v, i) => {
          const playing = g.status.playing && g.status.modelId === v.id;
          const f1 = meanF1(v);
          const fixes = corrections.filter(r => r.metadata.policyId === v.id).length; // recorded while it played
          return <div key={v.id} className="pg-version">
            <span><b>v{versions.length - i}</b> {new Date(v.created * 1000).toLocaleString()}
              <small>{(v.trainingSamples + v.validationSamples).toLocaleString()} rows{f1 !== null ? ` · F1 ${percent(f1)}` : ''}{fixes ? ` · ${fixes} correction${fixes > 1 ? 's' : ''}` : ''}</small></span>
            <span className="pg-version-actions">
              {v.version !== POLICY_VERSION ? <small className="pg-hint">older FireFly</small>
                : playing ? <button className="nodrag modal-btn pg-stop" onClick={g.stop}>Stop</button>
                : <button className="nodrag modal-btn pg-play" disabled={!g.capturing || !g.windowId || g.recordingNow || g.status.playing}
                    title={!g.capturing ? 'Start a capture session first' : g.recordingNow ? 'Stop recording first' : ''} onClick={() => g.play(v.id)}>Play</button>}
              <button className="nodrag pg-delete" disabled={playing} title={playing ? 'Stop it first' : `Delete v${versions.length - i}`}
                aria-label={`Delete v${versions.length - i}`} onClick={() => g.deleteVersion(v, versions.length - i, fixes)}>✕</button>
            </span>
          </div>;
        })}
        {versions.length > 5 && <button className="nodrag pg-link" onClick={() => setAllVersions(!allVersions)}>
          {allVersions ? 'Show the newest 5' : `Show all ${versions.length} versions`}</button>}
        <label className="nodrag pg-option"><input type="checkbox" checked={g.corrections} onChange={e => g.setCorrections(e.target.checked)} /> Record my corrections while it plays</label>
        <div className="pg-hint">{corrections.length ? `${corrections.length} correction${corrections.length === 1 ? '' : 's'} recorded` : 'No corrections yet'}
          {corrections.length > 0 && <button className="nodrag modal-btn pg-inline" disabled={!compiled?.request || !!g.training || g.recordingNow}
            onClick={() => g.train(id, true)}>Train with corrections</button>}</div>
        {corrections.length > 0 && (() => {
          const share = d.correctionShare ?? DEFAULT_CORRECTION_SHARE;
          return <label className="nodrag pg-share" title={correctionShareHint}>They count
            <input type="range" aria-label="How much the corrections count" min={0} max={MAX_CORRECTION_SHARE} step={.05} value={share}
              disabled={!!g.training} onChange={e => g.update(id, { correctionShare: Number(e.target.value) })} />
            <b>{share === 0 ? 'as plain rows' : `${percent(share)} of training`}</b>
          </label>;
        })()}
      </>}
    </div>
  </div>;
}

const nodeTypes: NodeTypes = { state: StateNode, formula: FormulaNode, recordings: RecordingsNode, policy: PolicyNode, grid: GridNode };

// ── The editor ───────────────────────────────────────────────────────────────────────────────────────

// stateLabels: each observation's States, by name. A State that reads a region's value or a model output
// is recorded under that output's name (“hp %” as “bar level”), so it's shown by the State's name.
// observed: every State's observation and its type (and whatever else FireFly observes now), which the
// graph is built from; States are dragged in from the app's States list.
export interface PolicyGraphProps { active: boolean; online: boolean; capturing: boolean; windowId: string | null; recording: boolean; storageKey: string; stateLabels: Record<string, string>; graphId?: string;
  observed: Record<string, string>;
  graphOf?: string | null; // the window whose graph this is
  frameSize?: { w: number; h: number } | null; } // the captured window's size, for a new grid's screen

export default function PolicyGraph(props: PolicyGraphProps) {
  return <div className={`pg ${props.active ? '' : 'pg-off'}`}>
    {props.active && <ReactFlowProvider><Editor key={props.storageKey} {...props} /></ReactFlowProvider>}
  </div>;
}

function Editor({ online, capturing, windowId, recording, storageKey, stateLabels, observed, graphOf, frameSize, graphId }: PolicyGraphProps) {
  const initial = useMemo(() => readGraph(localStorage.getItem(storageKey)), [storageKey]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const flow = useReactFlow();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [checks, setChecks] = useState<Map<string, FormulaCheck>>(new Map());
  const [gridChecks, setGridChecks] = useState<Map<string, GridCheck>>(new Map());
  const [previews, setPreviews] = useState<Ctx['previews']>({});
  const [status, setStatus] = useState<PlayStatus>({ playing: false });
  const [training, setTraining] = useState<Ctx['training']>(null);
  const [corrections, setCorrections] = useState(true);
  const [exported, setExported] = useState<Ctx['exported']>(null);
  const [error, setError] = useState('');
  const doc: GraphDoc = useMemo(() => ({ version: 1, nodes, edges }), [nodes, edges]);

  // Kept per captured window, a moment after the last change
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges })); }
    catch { setError('Could not save graph: local storage is full'); }
  }, [nodes, edges, storageKey]);

  // The recordings as they are now: deleted in the Recordings tab while this is open, one has to go from
  // the Recordings nodes too (below), so the list is read again every few seconds
  const [recordingsRead, setRecordingsRead] = useState(false);
  const refresh = useCallback(async () => {
    try {
      if (online) {
        setRecordings(((await window.bridge.invoke('dataset.list')) as { recordings: Recording[] }).recordings.filter(r => r.status === 'complete'));
        setRecordingsRead(true);
      }
      setVersions(newestFirst(await window.bridge.policy.invoke('models') as PolicyVersion[]));
    } catch (e) { setError(cleanError(e)); }
  }, [online]);
  // A version and the corrections recorded while it played go together
  const deleteVersion = useCallback(async (v: PolicyVersion, n: number, count: number) => {
    if (!window.confirm(`Delete v${n} (${new Date(v.created * 1000).toLocaleString()})? It can't be played again${count ? `, and its ${count} correction${count > 1 ? 's are' : ' is'} deleted with it` : ''}.`)) return;
    try { await deleteVersions([v]); await refresh(); }
    catch (e) { setError(cleanError(e)); }
  }, [refresh]);
  // Every version of a policy at once, with all of their corrections
  const deleteAll = useCallback(async (vs: PolicyVersion[], name: string, count: number) => {
    if (!window.confirm(`Delete all ${vs.length} version${vs.length > 1 ? 's' : ''} of ${name}? ${vs.length > 1 ? 'They' : 'It'} can't be played again${count ? `, and the ${count} correction${count > 1 ? 's' : ''} recorded while they played ${count > 1 ? 'are' : 'is'} deleted with them` : ''}. Its graph and recordings are kept.`)) return;
    try { await deleteVersions(vs); await refresh(); }
    catch (e) { setError(cleanError(e)); await refresh(); }
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!online) return;
    const timer = setInterval(async () => {
      try { setRecordings(((await window.bridge.invoke('dataset.list')) as { recordings: Recording[] }).recordings.filter(r => r.status === 'complete')); }
      catch { /* the next try, or Refresh, reads it */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [online]);
  // A recording that's gone (deleted) is no longer chosen, once the list has been read from the runtime
  useEffect(() => {
    if (!recordingsRead) return;
    // (corrections too: they belong to their versions, and come with Train with corrections)
    const known = new Set(recordings.filter(r => !r.metadata.correction).map(r => r.id));
    setNodes(ns => {
      let changed = false;
      const next = ns.map(n => {
        if (n.data.kind !== 'recordings' || n.data.ids.every(id => known.has(id))) return n;
        changed = true;
        return { ...n, data: { ...n.data, ids: n.data.ids.filter(id => known.has(id)) } };
      });
      return changed ? next : ns;
    });
  }, [recordings, recordingsRead, setNodes]);
  useEffect(() => {
    const offs = [
      window.bridge.on('policy:event', (msg: unknown) => {
        const { event, result } = msg as { event: string; result: Epoch };
        if (event === 'training') setTraining(t => t ? { ...t, progress: result } : t);
      }),
      window.bridge.on('play:status', (s: unknown) => setStatus(s as PlayStatus)),
    ];
    return () => offs.forEach(off => off());
  }, []);

  // The observations a policy can use: those the chosen recordings hold (else the latest recording's)
  const schemaRecording = useMemo(() => {
    const chosen = nodes.flatMap(n => n.data.kind === 'recordings' ? n.data.ids : []);
    return recordings.find(r => r.id === chosen[0]) ?? recordings[0];
  }, [nodes, recordings]);
  // Every observation's type: what FireFly observes now (the States), else what a recording holds. A
  // policy is built from States, whether or not anything has recorded them yet; what each recording
  // holds is what a policy's recordings are checked against (compilePolicy)
  const fields = useMemo(() => new Map([...Object.entries(observed),
    ...(schemaRecording?.metadata.observationSchema?.fields ?? []).filter(f => !(f.name in observed)).map(f => [f.name, f.type] as [string, string])]),
    [observed, schemaRecording]);
  const holds = useMemo(() => new Map(recordings.map(r => [r.id, new Set((r.metadata.observationSchema?.fields ?? []).map(f => f.name))])), [recordings]);
  const recordedAnywhere = useMemo(() => new Set([...holds.values()].flatMap(s => [...s])), [holds]);

  // The worker checks every formula (a moment after the last change), with a preview over the recording
  const specs = useMemo(() => formulaSpecs(doc), [doc]);
  const grids = useMemo(() => gridSpecs(doc), [doc]);
  const fieldList = useMemo(() => [...fields].map(([name, type]) => ({ name, type })), [fields]);
  const specKey = JSON.stringify([specs, grids, schemaRecording?.id, fieldList]);
  useEffect(() => {
    if ((!schemaRecording && !fieldList.length) || (!specs.length && !grids.length)) { setChecks(new Map()); setGridChecks(new Map()); return; }
    let alive = true;
    const timer = setTimeout(() => {
      window.bridge.policy.invoke('columns', { recordingIds: schemaRecording ? [schemaRecording.id] : [], fields: fieldList, formulas: specs, grids })
        .then((r: unknown) => {
          if (!alive) return;
          const res = r as { formulas: FormulaCheck[]; grids?: GridCheck[] };
          setChecks(new Map(res.formulas.map(f => [f.name, f])));
          setGridChecks(new Map((res.grids ?? []).map(g => [g.name, g])));
        })
        .catch(e => { if (alive) setError(cleanError(e)); });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [specKey]);

  const compiled = useMemo(() => Object.fromEntries(nodes.filter(n => n.data.kind === 'policy')
    .map(n => [n.id, compilePolicy(doc, n.id, fields, checks, holds)])), [doc, fields, checks, holds]);

  // Each policy's dataset as the worker would make it, worked out again a moment after it changes
  const previewKey = JSON.stringify(Object.entries(compiled).map(([id, c]) => [id, c.request]));
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      for (const [id, c] of Object.entries(compiled)) {
        if (!c.request) continue;
        setPreviews(p => ({ ...p, [id]: 'loading' }));
        window.bridge.policy.invoke('preview', { ...c.request })
          .then((r: unknown) => { if (alive) setPreviews(p => ({ ...p, [id]: r as Preview })); })
          .catch(e => { if (alive) setPreviews(p => ({ ...p, [id]: { error: cleanError(e) } })); });
      }
    }, 800);
    return () => { alive = false; clearTimeout(timer); };
  }, [previewKey]);

  const update = useCallback((id: string, patch: Record<string, unknown>) =>
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } as GraphNode['data'] } : n)), [setNodes]);
  const removeInput = useCallback((id: string, alias: string) => {
    setNodes(ns => ns.map(n => n.id === id && n.data.kind === 'formula' ? { ...n, data: { ...n.data, inputs: n.data.inputs.filter(a => a !== alias) } } : n));
    setEdges(es => es.filter(e => !(e.target === id && e.targetHandle === `in:${alias}`)));
  }, [setNodes, setEdges]);
  const removeNode = useCallback((id: string) => { setNodes(ns => ns.filter(n => n.id !== id)); setEdges(es => es.filter(e => e.source !== id && e.target !== id)); }, [setNodes, setEdges]);

  const train = useCallback(async (id: string, withCorrections = false) => {
    const c = compiled[id];
    if (!c?.request) return;
    const node = nodes.find(n => n.id === id)!, { epochs, correctionShare } = node.data as PolicyData;
    let recordingIds = c.request.recordingIds;
    if (withCorrections) {
      const own = new Set(versions.filter(v => v.policy?.id === id).map(v => v.id));
      recordingIds = [...new Set([...recordingIds, ...recordings.filter(r => r.metadata.correction && own.has(r.metadata.policyId ?? '')).map(r => r.id)])];
    }
    setTraining({ nodeId: id, progress: null }); setError('');
    try {
      await window.bridge.policy.invoke('train', { ...c.request, recordingIds, epochs, correctionShare: correctionShare ?? DEFAULT_CORRECTION_SHARE });
      await refresh();
    } catch (e) { setError(cleanError(e)); }
    setTraining(null);
  }, [compiled, nodes, versions, recordings, refresh]);

  const exportDataset = useCallback(async (id: string) => {
    const c = compiled[id];
    if (!c?.request) return;
    setExported(null);
    const res = await window.bridge.policy.exportDataset({ ...c.request });
    if (res.ok && res.path) setExported({ nodeId: id, path: res.path,
      text: `Exported ${(res.samples ?? 0).toLocaleString()} rows of ${res.features ?? 0} values${res.stepMs ? `, ${res.stepMs} ms apart` : ''}.` });
    else if (!res.canceled) setError(res.error ?? 'Could not export');
  }, [compiled]);

  const play = useCallback(async (modelId: string) => {
    if (!windowId) return;
    setError('');
    const res = await window.bridge.policy.play({ modelId, windowId, corrections, graphId });
    if (!res.ok) setError(res.error ?? 'Could not start playing');
  }, [windowId, corrections, graphId]);

  // Wiring: a value into a formula input or a Policy's Values, a Recordings node into a Policy's Data.
  // An input takes one wire, so a new one replaces it
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = nodes.find(n => n.id === c.source), target = nodes.find(n => n.id === c.target);
    if (!source || !target || source.id === target.id) return false;
    const handle = c.targetHandle ?? '';
    if (source.data.kind === 'recordings') return target.data.kind === 'policy' && handle === 'data';
    if (source.data.kind === 'grid') return target.data.kind === 'policy' && handle === 'values';
    if (target.data.kind === 'grid') {
      if (handle === 'in:shapes') return source.data.kind === 'state' && fields.get(source.data.name) === 'shapes';
      // Its centre: a position, from a state or a formula (a formula's type may not be known yet)
      const type = source.data.kind === 'state' ? fields.get(source.data.name) : source.data.kind === 'formula' ? checks.get(nameOf(source) ?? '')?.type : 'none';
      return handle === 'in:center' && (!type || type === 'vector');
    }
    if (source.data.kind !== 'state' && source.data.kind !== 'formula') return false;
    const type = source.data.kind === 'state' ? fields.get(source.data.name) : checks.get(nameOf(source) ?? '')?.type ?? 'number';
    if (target.data.kind === 'policy') return handle === 'values' && (!type || VALUE_TYPES.includes(type));
    if (target.data.kind === 'formula') return handle.startsWith('in:') && (!type || FORMULA_INPUT_TYPES.includes(type)) && !makesCycle(doc, source.id, target.id);
    return false;
  }, [nodes, fields, checks, doc]);

  // A formula's inputs: a new one for a node wired in (named after it), renamed, and what can be wired in
  const labelOf = useCallback((node: GraphNode) => { const name = nameOf(node) ?? ''; return stateLabels[name] ?? name; }, [stateLabels]);
  const addInput = useCallback((formulaId: string, sourceId: string) => {
    const formula = nodes.find(n => n.id === formulaId), source = nodes.find(n => n.id === sourceId);
    if (formula?.data.kind !== 'formula' || !source) return;
    const alias = aliasFrom(labelOf(source), formula.data.inputs);
    setNodes(ns => ns.map(n => n.id === formulaId && n.data.kind === 'formula' ? { ...n, data: { ...n.data, inputs: [...n.data.inputs, alias] } } : n));
    setEdges(es => addEdge({ source: sourceId, sourceHandle: 'out', target: formulaId, targetHandle: `in:${alias}` }, es));
  }, [nodes, labelOf, setNodes, setEdges]);
  const renameInput = useCallback((formulaId: string, alias: string, next: string) => {
    setNodes(ns => ns.map(n => n.id === formulaId && n.data.kind === 'formula'
      ? { ...n, data: { ...n.data, inputs: n.data.inputs.map(a => a === alias ? next : a), source: renameIn(n.data.source, alias, next) } } : n));
    setEdges(es => es.map(e => e.target === formulaId && e.targetHandle === `in:${alias}` ? { ...e, targetHandle: `in:${next}`, id: `${e.id}~${next}` } : e));
  }, [setNodes, setEdges]);
  const inputChoices = useCallback((formulaId: string) => nodes
    .filter(n => (n.data.kind === 'state' || n.data.kind === 'formula') && n.id !== formulaId && nameOf(n)
      && isValidConnection({ source: n.id, sourceHandle: 'out', target: formulaId, targetHandle: NEW_INPUT }))
    .map(n => ({ id: n.id, label: `${n.data.kind === 'formula' ? 'ƒ ' : ''}${labelOf(n)}` })), [nodes, isValidConnection, labelOf]);

  const onConnect = useCallback((c: Connection) => {
    if (c.targetHandle === NEW_INPUT) { addInput(c.target, c.source); return; }
    setEdges(es => {
      const single = c.targetHandle?.startsWith('in:') || c.targetHandle === 'data'; // a formula's or grid's input, a policy's data
      return addEdge({ ...c, animated: c.targetHandle === 'data' }, single ? es.filter(e => !(e.target === c.target && e.targetHandle === c.targetHandle)) : es);
    });
  }, [setEdges, addInput]);
  // A wire's end dragged somewhere else moves it there; dropped where nothing takes it, the wire goes
  const reconnected = useRef(true);
  const onReconnectStart = useCallback(() => { reconnected.current = false; }, []);
  const onReconnect = useCallback((old: Edge, c: Connection) => {
    reconnected.current = true;
    if (c.targetHandle === NEW_INPUT) { setEdges(es => es.filter(e => e.id !== old.id)); addInput(c.target, c.source); return; }
    setEdges(es => {
      const single = c.targetHandle?.startsWith('in:') || c.targetHandle === 'data';
      const rest = single ? es.filter(e => e.id === old.id || !(e.target === c.target && e.targetHandle === c.targetHandle)) : es;
      return reconnectEdge(old, c, rest);
    });
  }, [setEdges, addInput]);
  const onReconnectEnd = useCallback((_: unknown, edge: Edge) => {
    if (!reconnected.current) setEdges(es => es.filter(e => e.id !== edge.id));
    reconnected.current = true;
  }, [setEdges]);
  // The wire under the pointer, shown in full: drawn thicker and bright, above the others, and its ends lit
  const [hotEdge, setHotEdge] = useState<Edge | null>(null);
  const shownEdges = useMemo(() => hotEdge ? edges.map(e => e.id === hotEdge.id ? { ...e, className: 'pg-edge-hot', zIndex: 1000 } : e) : edges, [edges, hotEdge]);
  const hot = useCallback((nodeId: string, handle: string) => !!hotEdge
    && ((hotEdge.target === nodeId && hotEdge.targetHandle === handle) || (hotEdge.source === nodeId && (hotEdge.sourceHandle ?? 'out') === handle)), [hotEdge]);

  // Dragging from the palette: a state, a formula, a Recordings node or a Policy
  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/firefly-node');
    if (!raw) return;
    const item = JSON.parse(raw) as { kind: string; name?: string };
    const position = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = crypto.randomUUID();
    const count = (kind: string) => nodes.filter(n => n.data.kind === kind).length + 1;
    const data: GraphNode['data'] = item.kind === 'state' ? { kind: 'state', name: item.name! }
      : item.kind === 'formula' ? { kind: 'formula', name: `formula ${count('formula')}`, source: '', inputs: ['a', 'b'] }
      : item.kind === 'recordings' ? { kind: 'recordings', ids: [] }
      : item.kind === 'grid' ? { kind: 'grid', name: `grid ${count('grid')}`, cols: 16, rows: 9, mode: 'coverage', width: frameSize?.w ?? 1280, height: frameSize?.h ?? 720 }
      : { kind: 'policy', name: `Policy ${count('policy')}`, buttons: null, off: [], stepMs: null, history: 2, delayMs: 0, epochs: 60 };
    setNodes(ns => [...ns, { id, type: data.kind, position, data }]);
  }, [flow, nodes, setNodes]);
  // A graph as text, to keep, share or start from: copied to the clipboard, or pasted in place of this one
  const [copied, setCopied] = useState(false);
  const copyGraph = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ version: 1, nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })), edges }, null, 1));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch (e) { setError('Could not copy: ' + cleanError(e)); }
  };
  const pasteGraph = async () => {
    try {
      let pasted: GraphDoc | null = null;
      try { pasted = JSON.parse(await navigator.clipboard.readText()) as GraphDoc; } catch { /* not JSON */ }
      if (pasted?.version !== 1 || !Array.isArray(pasted.nodes) || !Array.isArray(pasted.edges) || !pasted.nodes.length) {
        setError('The clipboard doesn’t hold a Policy Graph'); return;
      }
      if (nodes.length > 2 && !window.confirm('Replace this graph with the one on the clipboard?')) return;
      setNodes(pasted.nodes); setEdges(pasted.edges); setError('');
      setTimeout(() => flow.fitView(), 50);
    } catch (e) { setError('Could not paste: ' + cleanError(e)); }
  };
  const drag = (item: { kind: string; name?: string }) => (e: DragEvent) => {
    e.dataTransfer.setData('application/firefly-node', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
  };

  const unassigned = versions.filter(v => !v.policy && v.version === POLICY_VERSION);
  const ctx: Ctx = { fields, recordedAnywhere, labels: stateLabels, recordings, checks, gridChecks, compiled, previews, versions, deleteVersion, deleteAll, status, training, capturing, windowId, recordingNow: recording,
    corrections, setCorrections, update, removeNode, removeInput, train, exportDataset, play, stop: () => void window.bridge.policy.stop(), exported,
    wiredInto: (nodeId, handle) => nameOf(nodes.find(n => n.id === edges.find(e => e.target === nodeId && e.targetHandle === handle)?.source)) ?? null,
    addInput, renameInput, inputChoices, hot };

  return <GraphContext.Provider value={ctx}>
    <aside className="pg-palette" aria-label="Nodes to add">
      <div className="pg-hint pg-graph-of" title="Each window has its own Policy Graph">{graphOf ? <>Graph for <b>{graphOf}</b>{!windowId ? ' (the last window used)' : ''}</> : 'Start a session on a window to keep a graph for it'}</div>
      <div className="pg-palette-hd">Drag onto the graph</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'formula' })}><span className="pg-glyph">ƒ</span>Formula</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'grid' })} title="Shapes, such as platforms, as a grid over the whole screen"><span className="pg-glyph">▦</span>Grid</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'recordings' })}><span className="pg-glyph">▤</span>Recordings</div>
      <div className="pg-palette-item pg-kind" draggable onDragStart={drag({ kind: 'policy' })}><span className="pg-glyph">◎</span>Policy</div>
      <div className="pg-hint pg-drag-states">Drag States in from the States list on the right.</div>
      {unassigned.length > 0 && <>
        <div className="pg-palette-hd">Earlier policies</div>
        {unassigned.slice(0, 8).map(v => <div key={v.id} className="pg-palette-policy">
          <span>{new Date(v.created * 1000).toLocaleString()}</span>
          {status.playing && status.modelId === v.id ? <button className="modal-btn" onClick={ctx.stop}>Stop</button>
            : <button className="modal-btn" disabled={!capturing || !windowId || recording || status.playing} onClick={() => void play(v.id)}>Play</button>}
        </div>)}
      </>}
      <div className="pg-palette-hd">Graph</div>
      <div className="pg-palette-row">
        <button className="modal-btn" title="Copy this graph to the clipboard, as text" onClick={() => void copyGraph()}>{copied ? 'Copied' : 'Copy graph'}</button>
        <button className="modal-btn" title="Replace this graph with one copied to the clipboard" onClick={() => void pasteGraph()}>Paste graph</button>
      </div>
      <div className="pg-palette-hd">Help</div>
      <div className="pg-hint">Wire states into a Formula's inputs (a, b…) and write what it works out, such as <code>distance(a, b)</code>. Wire states, formulas and grids into a Policy's Values: they're its dataset's columns. A Grid lays shapes, such as platforms, over the whole screen in cells. A Recordings node wired into Data is its rows. Delete or Backspace removes what’s selected, or click ✕ on any node.</div>
    </aside>
    <div className="pg-canvas" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
      {(error || status.reason) && <div className="pg-banner">{error || `Stopped: ${status.reason}`}<button className="pg-x" onClick={() => { setError(''); setStatus(s => ({ ...s, reason: null })); }}>✕</button></div>}
      {status.playing && <div className="pg-banner pg-banner-live">{playingText(status)}
        <button className="modal-btn" onClick={ctx.stop}>Stop</button></div>}
      <ReactFlow nodes={nodes} edges={shownEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        isValidConnection={isValidConnection} nodeTypes={nodeTypes} colorMode="dark" fitView={!localStorage.getItem(storageKey + '-view')} defaultViewport={JSON.parse(localStorage.getItem(storageKey + '-view') ?? 'null') ?? undefined} minZoom={0.3} maxZoom={1.5}
        onMoveEnd={(_, viewport) => localStorage.setItem(storageKey + '-view', JSON.stringify(viewport))}
        edgesReconnectable reconnectRadius={20} onReconnect={onReconnect} onReconnectStart={onReconnectStart} onReconnectEnd={onReconnectEnd}
        onEdgeMouseEnter={(_, e) => setHotEdge(e)} onEdgeMouseLeave={() => setHotEdge(null)}
        deleteKeyCode={['Delete', 'Backspace']}>
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </GraphContext.Provider>;
}
