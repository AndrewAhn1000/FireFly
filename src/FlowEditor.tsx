import { useEffect, useState, type KeyboardEvent } from 'react';
import InfoTip from './InfoTip';
import {
  accepts, HEX_COLOR, inputTypes, newStep, opSpec, OPS, stepNode, RESERVED_NAMES, TYPE_BADGE,
  type CompiledFlow, type Flow, type FlowOutput, type FlowProblem, type FlowStep, type FlowType, type ParamSpec,
} from './flows';
import type { NodeResult } from './models';
import { oneLine } from './text';

// A runtime validation error, pointed at the step it came from when known
export interface FlowError { output?: string; step?: number; message: string }

// A place a flow's outputs can start from: the model's mask, or a region's pixels
export interface FlowSource { node: string; label: string; type: FlowType }

const PALETTE = ['#00ff00', '#ffd600', '#00e5ff', '#ff4081', '#ff9100', '#b388ff'];

const hasSource = (sources: Record<string, FlowSource>, id: string) => Object.prototype.hasOwnProperty.call(sources, id);

// Graph node holding an output's result
function resultNode(flow: Flow, sources: Record<string, FlowSource>, id: string, seen = new Set<string>()): string | null {
  if (hasSource(sources, id)) return sources[id].node;
  const o = flow.outputs.find(x => x.id === id);
  if (!o || seen.has(id)) return null;
  seen.add(id);
  return o.steps.length ? stepNode(o.id, o.steps.length - 1) : resultNode(flow, sources, o.from, seen);
}

export function summary(r: NodeResult | undefined): string {
  if (!r) return '';
  if (!r.valid) return 'invalid';
  if (r.count !== undefined) return `${r.count} shape${r.count !== 1 ? 's' : ''}`;
  if (typeof r.value === 'number') return `= ${Number.isInteger(r.value) ? r.value : r.value.toFixed(3)}`;
  if (typeof r.value === 'string') return r.value.trim() ? `“${oneLine(r.value, 24)}”` : 'no text';
  if (r.coverage !== undefined) return `${(r.coverage * 100).toFixed(1)}% of frame`;
  return r.type === 'image' ? 'mask' : '';
}

// Text inputs keep a draft and commit on Enter or blur; numbers commit as soon as they parse
export function DraftInput({ value, onCommit, className, placeholder, disabled, multiline }: {
  value: string; onCommit(v: string): void; className?: string; placeholder?: string; disabled?: boolean;
  multiline?: boolean; // wraps long text such as expressions; Shift+Enter adds a line
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const events = {
    onBlur: () => { if (draft !== value) onCommit(draft); },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === 'Escape') setDraft(value);
    },
  };
  return multiline
    ? <textarea className={className} value={draft} placeholder={placeholder} disabled={disabled} spellCheck={false}
        rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 80)))} onChange={e => setDraft(e.target.value)} {...events} />
    : <input className={className} value={draft} placeholder={placeholder} disabled={disabled} spellCheck={false}
        onChange={e => setDraft(e.target.value)} {...events} />;
}

function NumberInput({ spec, value, onChange, disabled }: {
  spec: ParamSpec; value: number; onChange(v: number): void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(d => Number(d) === value ? d : String(value)), [value]);
  const within = (v: number) => Number.isFinite(v) && (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
  return (
    <input type="number" className="flow-num" min={spec.min} max={spec.max} step={spec.step} value={draft} disabled={disabled}
      onChange={e => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value !== '' && within(v)) onChange(v);
      }}
      onBlur={() => setDraft(String(value))} />
  );
}

interface Props {
  flow: Flow;
  compiled: CompiledFlow;
  sources: Record<string, FlowSource>; // what outputs can start from, by the name a step's `from` uses
  defaultSource: string;               // where a new output starts
  newId(): string;                     // an ID for a new output, unique across everything in the graph
  problems: FlowProblem[];
  error: FlowError | null;
  nodes: Record<string, NodeResult>;   // live value of every graph node, when there are any
  live: boolean;                       // live results can be shown, and steps previewed
  liveHint: string;                    // what to do to get them
  maskOf: string;                      // what a previewed mask's share is of: "frame" or "the box"
  preview: string | null;              // previewed graph node
  previewed: (NodeResult & { node: string }) | null;
  onPreview(node: string | null): void;
  locked: boolean;
  canDraw: boolean;                    // outputs can be drawn on the live view
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChange(flow: Flow): void;
  emptyText: string;
  onPickColor?(apply: (hex: string) => void): void; // asks for a colour to be clicked in the frame
}

// The list of a flow's outputs, the steps of the selected one, and what its
// steps produce on the live view.
export default function FlowEditor(props: Props) {
  const {
    flow, compiled, sources, defaultSource, newId, problems, error, nodes, live, liveHint, maskOf, preview, previewed, onPreview,
    locked, canDraw, selectedId, onSelect, onChange, emptyText, onPickColor,
  } = props;
  const selected = flow.outputs.find(o => o.id === selectedId) ?? flow.outputs.find(o => o.record) ?? flow.outputs[0] ?? null;
  const setOutput = (id: string, patch: Partial<FlowOutput>) =>
    onChange({ ...flow, outputs: flow.outputs.map(o => o.id === id ? { ...o, ...patch } : o) });
  const setSteps = (o: FlowOutput, steps: FlowStep[]) => setOutput(o.id, { steps });
  const usedBy = (id: string) => flow.outputs.filter(o => o.id !== id && (o.from === id || o.steps.some(s => s.with === id)));

  const addOutput = () => {
    let n = flow.outputs.length + 1;
    while (flow.outputs.some(o => o.name === `output ${n}`)) n++;
    const id = newId();
    onChange({ ...flow, outputs: [...flow.outputs, {
      id, name: `output ${n}`, from: defaultSource, steps: [], record: false, show: canDraw,
      color: PALETTE[flow.outputs.length % PALETTE.length], label: '',
    }] });
    onSelect(id);
  };
  const removeOutput = (o: FlowOutput) => {
    if (preview?.startsWith(`${o.id}.`)) onPreview(null);
    onChange({ ...flow, outputs: flow.outputs.filter(x => x.id !== o.id) });
    onSelect(null);
  };

  const errorFor = (output: string, step?: number) =>
    [...problems.filter(p => p.output === output && p.step === step).map(p => p.message),
     ...(error && error.output === output && error.step === step ? [error.message] : [])];

  const previewTitle = (() => {
    if (!preview) return '';
    const [outputId, index] = preview.split('.');
    const o = flow.outputs.find(x => x.id === outputId);
    const s = o?.steps[Number(index) - 1];
    return o && s ? `${o.name} › ${Number(index)}. ${opSpec(s.op)?.label ?? s.op}` : preview;
  })();

  return (
    <div className="flow-body">
      <div className="flow-list">
        {flow.outputs.map(o => {
          const type = compiled.types.get(o.id);
          const broken = problems.some(p => p.output === o.id) || error?.output === o.id;
          const node = resultNode(flow, sources, o.id);
          return (
            <div key={o.id} className={`flow-item ${o.id === selected?.id ? 'flow-item-sel' : ''}`} onClick={() => onSelect(o.id)}>
              <span className="flow-dot" style={{ background: o.show && type !== 'number' && type !== 'text' ? o.color : 'transparent', borderColor: o.show ? o.color : 'var(--border)' }} />
              <div className="flow-item-body">
                <span className="flow-item-name">{o.name}</span>
                <span className="flow-item-meta">
                  {type ?? 'broken'}
                  {node && nodes[node] && type !== 'mask' && type !== 'image' && <span className="flow-item-live">{summary(nodes[node])}</span>}
                </span>
              </div>
              {o.record && type !== 'mask' && type !== 'image' && <span className="flow-chip flow-chip-rec" title="Recorded as an observation">REC</span>}
              {broken && <span className="flow-chip flow-chip-err" title="Has a problem">!</span>}
            </div>
          );
        })}
        <button className="flow-add-output" disabled={locked} onClick={addOutput}>+ Add output</button>
      </div>

      <div className="flow-editor">
        {!selected ? <div className="flow-hint">{emptyText}</div> : (() => {
          const o = selected;
          const type = compiled.types.get(o.id);
          const users = usedBy(o.id);
          let end: FlowType | null = hasSource(sources, o.from) ? sources[o.from].type : compiled.types.get(o.from) ?? null;
          const canRecord = type !== undefined && type !== null && type !== 'mask' && type !== 'image';
          return (
            <>
              <div className="flow-out-hd">
                <DraftInput className="flow-name" value={o.name} disabled={locked}
                  onCommit={v => {
                    const name = v.replace(/\s+/g, ' ').trim().slice(0, 80);
                    if (name && !RESERVED_NAMES.includes(name)) setOutput(o.id, { name });
                  }} />
                <button className="train-btn-sm model-delete-btn" disabled={locked || users.length > 0}
                  title={users.length ? `Used by ${users.map(u => u.name).join(', ')}` : 'Delete this output'}
                  onClick={() => removeOutput(o)}>Delete</button>
              </div>
              <div className="flow-row">
                <label>From</label>
                <select className="flow-select" value={o.from} disabled={locked} onChange={e => setOutput(o.id, { from: e.target.value })}>
                  {Object.entries(sources).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
                  {flow.outputs.filter(x => x.id !== o.id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <label className="flow-check" title={canRecord ? 'Publish as an observation: recorded with every sample and available as a State' : 'Only numbers, text and shapes are recorded'}>
                  <input type="checkbox" checked={o.record && canRecord} disabled={locked || !canRecord}
                    onChange={e => setOutput(o.id, { record: e.target.checked })} /> Record
                </label>
                {canDraw && (
                  <>
                    <label className="flow-check" title="Draw on the live view">
                      <input type="checkbox" checked={o.show} disabled={locked || type === 'number' || type === 'text' || type === 'image'}
                        onChange={e => setOutput(o.id, { show: e.target.checked })} /> Show
                    </label>
                    <input type="color" className="model-color" value={o.color} disabled={locked}
                      onChange={e => setOutput(o.id, { color: e.target.value })} />
                    <DraftInput className="flow-label" value={o.label} placeholder="label" disabled={locked}
                      onCommit={v => setOutput(o.id, { label: v.slice(0, 8) })} />
                    <InfoTip wide text="Label: prefix for the index drawn next to each shape on the live view (e.g. P for P0, P1…), matching the item's position in the recorded list. Leave empty for none." />
                  </>
                )}
              </div>
              {errorFor(o.id).map((m, i) => <div key={i} className="flow-problem">{m}</div>)}

              <div className="flow-steps">
                {o.steps.map((s, i) => {
                  const spec = opSpec(s.op);
                  const node = stepNode(o.id, i);
                  const result = nodes[node];
                  const messages = errorFor(o.id, i);
                  if (spec) end = spec.output;
                  const withChoices = spec?.with
                    ? flow.outputs.filter(x => x.id !== o.id && compiled.types.get(x.id) === spec.with!.type)
                    : [];
                  return (
                    <div key={i} className={`flow-step ${messages.length || result?.valid === false ? 'flow-step-err' : ''} ${preview === node ? 'flow-step-preview' : ''}`}>
                      <div className="flow-step-hd">
                        <span className="flow-step-n">{i + 1}</span>
                        <span className="flow-step-name">{spec?.label ?? s.op}</span>
                        {spec && <InfoTip wide text={spec.help} />}
                        <span className="flow-step-live" title={result?.reason}>{summary(result)}</span>
                        <button className={`flow-icon ${preview === node ? 'flow-icon-on' : ''}`} disabled={!live}
                          title={live ? 'Preview this step on the live view' : liveHint}
                          onClick={() => onPreview(preview === node ? null : node)}>👁</button>
                        <button className="flow-icon" disabled={locked || i === 0} title="Move up"
                          onClick={() => { const steps = [...o.steps]; [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; setSteps(o, steps); }}>↑</button>
                        <button className="flow-icon" disabled={locked || i === o.steps.length - 1} title="Move down"
                          onClick={() => { const steps = [...o.steps]; [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; setSteps(o, steps); }}>↓</button>
                        <button className="flow-icon" disabled={locked} title="Remove step"
                          onClick={() => { if (preview?.startsWith(`${o.id}.`)) onPreview(null); setSteps(o, o.steps.filter((_, j) => j !== i)); }}>✕</button>
                      </div>
                      {spec && (
                        <div className="flow-params">
                          {spec.with && (
                            <label className="flow-param">
                              <span>{spec.with.label}</span>
                              <select className="flow-select" value={s.with ?? ''} disabled={locked}
                                onChange={e => setSteps(o, o.steps.map((x, j) => j === i ? { ...x, with: e.target.value || undefined } : x))}>
                                {spec.with.optional && <option value="">None</option>}
                                {!spec.with.optional && !s.with && <option value="">Choose…</option>}
                                {withChoices.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </select>
                            </label>
                          )}
                          {spec.params.map(p => {
                            if (p.key === 'variable' && !s.with) return null;
                            const v = s.params[p.key] ?? p.default;
                            const set = (value: number | string) =>
                              setSteps(o, o.steps.map((x, j) => j === i ? { ...x, params: { ...x.params, [p.key]: value } } : x));
                            if (p.kind === 'color') return (
                              <div key={p.key} className="flow-param">
                                <span>{p.label}{p.help && <InfoTip text={p.help} />}</span>
                                <input type="color" className="model-color" value={HEX_COLOR.test(String(v)) ? String(v) : '#ff0000'} disabled={locked}
                                  onChange={e => set(e.target.value)} />
                                <DraftInput className="flow-label flow-hex" value={String(v)} disabled={locked}
                                  onCommit={text => { if (HEX_COLOR.test(text.trim())) set(text.trim().toLowerCase()); }} />
                                {onPickColor && (
                                  <button className="train-btn-sm" disabled={locked || !live}
                                    title={live ? 'Then click a colour in the Game View' : liveHint}
                                    onClick={() => onPickColor(hex => set(hex))}>Pick from frame</button>
                                )}
                              </div>
                            );
                            return (
                              <label key={p.key} className={`flow-param ${p.kind === 'expression' ? 'flow-param-wide' : ''}`}>
                                <span>{p.label}{p.help && <InfoTip text={p.help} />}</span>
                                {p.kind === 'number' && <NumberInput spec={p} value={Number(v)} onChange={set} disabled={locked} />}
                                {p.kind === 'select' && (
                                  <select className="flow-select" value={String(v)} disabled={locked}
                                    onChange={e => set(typeof p.default === 'number' ? Number(e.target.value) : e.target.value)}>
                                    {p.options!.map(opt => <option key={opt} value={String(opt)}>{opt}</option>)}
                                  </select>
                                )}
                                {(p.kind === 'expression' || p.kind === 'name') && (
                                  <DraftInput className={p.kind === 'expression' ? 'flow-expr' : 'flow-label'} value={String(v)} disabled={locked}
                                    multiline={p.kind === 'expression'}
                                    onCommit={text => { if (text.trim()) set(text.replace(/\s+/g, ' ').trim()); }} />
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {messages.map((m, k) => <div key={k} className="flow-problem">{m}</div>)}
                      {!messages.length && result?.valid === false && result.reason !== 'Upstream input invalid' && (
                        <div className="flow-problem">{result.reason}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!locked && (
                <select className="flow-select flow-add-step" value="" onChange={e => {
                  const spec = opSpec(e.target.value);
                  if (spec) setSteps(o, [...o.steps, newStep(spec)]);
                }}>
                  <option value="">+ Add step…</option>
                  {OPS.filter(spec => !end || accepts(spec, end)).map(spec =>
                    <option key={spec.op} value={spec.op}>{spec.label}  ({inputTypes(spec).map(t => TYPE_BADGE[t].toLowerCase()).join(' or ')} → {TYPE_BADGE[spec.output].toLowerCase()})</option>)}
                </select>
              )}
            </>
          );
        })()}
      </div>

      <div className="flow-preview">
        {!live ? (
          <div className="flow-hint">{liveHint}</div>
        ) : !preview ? (
          <div className="flow-hint">Press 👁 on a step to draw what it produces on the Game View.</div>
        ) : (
          <>
            <div className="flow-preview-hd">
              <span>{previewTitle}</span>
              <button className="flow-icon" title="Stop previewing" onClick={() => onPreview(null)}>✕</button>
            </div>
            {!previewed ? <div className="flow-hint">Waiting for the next frame…</div>
              : !previewed.valid ? <div className="flow-problem">{previewed.reason}</div>
              : Array.isArray(previewed.value) ? <ShapeTable items={previewed.value as Record<string, unknown>[]} count={previewed.count ?? 0} />
              : previewed.coverage !== undefined ? <div className="flow-preview-big">Mask · {(previewed.coverage * 100).toFixed(1)}% of {maskOf}</div>
              : typeof previewed.value === 'string' ? <div className="flow-preview-big flow-preview-text">{previewed.value.trim() || 'No text found'}</div>
              : <div className="flow-preview-big">{summary(previewed)}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// Position and size first, then the other measurements
const COLUMN_ORDER = ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'meanWidth', 'meanHeight', 'area', 'fill', 'band', 'length', 'cx', 'cy'];

// Measurements of previewed shapes; # matches the index drawn on the Game View
function ShapeTable({ items, count }: { items: Record<string, unknown>[]; count: number }) {
  const keys = [...new Set(items.slice(0, 20).flatMap(Object.keys))].filter(k => k !== 'points');
  const columns = [...COLUMN_ORDER.filter(k => keys.includes(k)), ...keys.filter(k => !COLUMN_ORDER.includes(k))];
  const cell = (v: unknown) => typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : Array.isArray(v) ? `[${v.length}]` : String(v ?? '');
  return (
    <>
      <div className="flow-preview-count">{count} shape{count !== 1 ? 's' : ''}{items.length < count ? ` (first ${items.length})` : ''}</div>
      {items.length > 0 && (
        <div className="flow-table-wrap">
          <table className="flow-table">
            <thead><tr><th>#</th>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {items.slice(0, 60).map((item, i) => (
                <tr key={i}><td>{i}</td>{columns.map(c => <td key={c}>{cell(item[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
