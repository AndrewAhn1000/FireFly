import { useEffect, useState } from 'react';
import { TYPE_BADGE } from './flows';
import InfoTip from './InfoTip';
import type { InferenceDevice } from './inference';
import { compileModel, detectorClasses, isDetector, type ModelLive, type TrainedModel } from './models';
import { oneLine } from './text';

interface Props {
  models: TrainedModel[];
  selected: TrainedModel | null;
  runningIds: string[];              // the models running now, any number at once
  lives: Record<string, ModelLive>;  // each running model's feedback
  devices: InferenceDevice[];        // what models can run on here
  toolbarDevice: string;             // what the toolbar's Inference says, which a model follows by default
  onDevice(id: string, device: string | null): void;
  captureActive: boolean;
  recording: boolean;
  notice: { kind: 'info' | 'error'; text: string } | null;
  suggestion: string | null; // a best.onnx in the training output folder that isn't in the library
  onSelect(id: string): void;
  onImport(src?: string, hints?: { trained?: boolean }): void;
  onDismissNotice(): void;
  onRun(model: TrainedModel): void;
  onStop(id: string): void;
  onRename(id: string, name: string): void;
  onEditOutputs(id: string): void;
  onReveal(id: string): void;
  onDelete(id: string): void;
}

const pct       = (v: number) => `${(v * 100).toFixed(1)}%`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate  = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fileSize  = (bytes: number) => bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const baseName  = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const iouBench  = (v: number) => v > 0.80 ? '🟢 excellent' : v > 0.65 ? '🟢 good' : v > 0.50 ? '🟡 decent' : '🟠 low';
const mapBench  = (v: number) => v > 0.90 ? '🟢 excellent' : v > 0.75 ? '🟢 good' : v > 0.50 ? '🟡 decent' : '🟠 low';
const classList = (m: TrainedModel) => detectorClasses(m).join(', ');

function rowMeta(m: TrainedModel) {
  const classes = detectorClasses(m).length;
  return [
    isDetector(m) ? `Detector · ${classes} class${classes !== 1 ? 'es' : ''}` : null,
    m.training?.valIou !== undefined ? `IoU ${pct(m.training.valIou)}` : null,
    m.training?.map50 !== undefined ? `mAP50 ${pct(m.training.map50)}` : null,
    m.input ? `${m.input.width}×${m.input.height}` : null,
    shortDate(m.createdAt),
  ].filter(Boolean).join(' · ');
}

export default function ModelsPanel(props: Props) {
  const { models, selected, runningIds, notice, suggestion, onSelect, onImport, onDismissNotice } = props;
  const running = runningIds.length;
  return (
    <div className="models-panel">
      <div className="models-list-pane">
        <div className="models-list-hd">
          <span className="models-count">{models.length} model{models.length !== 1 ? 's' : ''}{running > 0 ? ` · ${running} running` : ''}</span>
          <button className="train-btn-sm" onClick={() => onImport()}>Import .onnx…</button>
        </div>
        {notice && (
          <div className={`models-notice models-notice-${notice.kind}`}>
            <span>{notice.text}</span>
            <button className="models-notice-close" onClick={onDismissNotice}>✕</button>
          </div>
        )}
        <div className="models-list">
          {models.map(m => (
            <div key={m.id} className={`model-row ${m.id === selected?.id ? 'model-row-sel' : ''}`} onClick={() => onSelect(m.id)}>
              <span className={`model-dot ${runningIds.includes(m.id) ? 'model-dot-on' : ''}`} />
              <div className="model-row-body">
                <span className="model-row-name">{m.name}</span>
                <span className="model-row-meta">{rowMeta(m)}</span>
              </div>
              {runningIds.includes(m.id) && <span className="model-chip model-chip-live">LIVE</span>}
              {m.missing && <span className="model-chip model-chip-missing">missing</span>}
            </div>
          ))}
          {models.length === 0 && (
            <div className="models-empty">
              <div className="models-empty-title">No trained models yet</div>
              <div className="models-empty-sub">Models show up here automatically when a training run finishes.</div>
              {suggestion && (
                <button className="train-btn-primary models-empty-btn" onClick={() => onImport(suggestion, { trained: true })} title={suggestion}>
                  + Add {baseName(suggestion.replace(/[\\/][^\\/]+$/, ''))}/{baseName(suggestion)}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="models-detail-pane">
        {selected
          ? <ModelDetail key={selected.id} model={selected} {...props} />
          : (
            <div className="models-howto">
              <div className="models-howto-step"><b>1</b><span>Train a model in the <i>Train</i> tab, or import an .onnx file.</span></div>
              <div className="models-howto-step"><b>2</b><span>Give it a name you'll recognise.</span></div>
              <div className="models-howto-step"><b>3</b><span>Press <i>Run</i> to show detections over live capture. Several models can run at once. <i>Detection view</i> shows each drawing on its original frame.</span></div>
            </div>
          )}
      </div>
    </div>
  );
}

function ModelDetail({ model, runningIds, lives, devices, toolbarDevice, captureActive, recording, models, onRun, onStop, onDevice, onRename, onEditOutputs, onReveal, onDelete }: Props & { model: TrainedModel }) {
  const [name, setName] = useState(model.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setName(model.name), [model.name]);

  const running = runningIds.includes(model.id);
  // The models it runs beside: every frame goes through each of them in turn
  const others  = runningIds.filter(id => id !== model.id).map(id => models.find(m => m.id === id)).filter((m): m is TrainedModel => !!m);
  const locked  = recording && running; // the runtime can't swap its graph mid-recording
  const recorded = compileModel(model).recorded;
  const t = model.training;
  const liveHere = lives[model.id] ?? null;
  // Names a model run before it records already (or any running one, for a model not running yet): this
  // one's outputs of those names aren't recorded
  const before = running ? runningIds.slice(0, runningIds.indexOf(model.id)) : runningIds;
  const earlier = others.filter(m => before.includes(m.id));
  const taken = new Set(earlier.flatMap(m => compileModel(m).recorded.map(r => r.name)));
  const clashes = recorded.filter(r => taken.has(r.name)).map(r => r.name);

  const commitName = () => {
    const next = name.replace(/\s+/g, ' ').trim();
    if (!next) setName(model.name);
    else if (next !== model.name) onRename(model.id, next);
  };

  let status: { tone: 'ok' | 'dim' | 'err'; text: string } | null = null;
  if (liveHere?.phase === 'error')      status = { tone: 'err', text: liveHere.error ?? 'Model failed' };
  else if (!running)                    status = null;
  else if (!captureActive)              status = { tone: 'dim', text: 'Start a capture session to see the overlay' };
  else if (liveHere?.phase !== 'running') status = { tone: 'dim', text: 'Loading model…' };
  else {
    const counts = recorded.flatMap(r => {
      const o = liveHere.observations?.[r.name];
      if (!o?.valid) return [];
      return [o.count !== undefined ? `${r.name} ${o.count}`
        : typeof o.value === 'number' ? `${r.name} ${+o.value.toFixed(3)}`
        : typeof o.value === 'string' ? `${r.name} “${oneLine(o.value, 16)}”` : null];
    });
    status = {
      tone: 'ok',
      text: [
        'Running',
        liveHere.latencyMs !== undefined ? `${Math.round(liveHere.latencyMs)} ms/frame${others.length ? ' for all running models' : ''}` : null,
        ...(counts.length ? counts : liveHere.coverage != null ? [`${pct(liveHere.coverage)} of frame detected`] : []),
      ].filter(Boolean).join(' · '),
    };
  }

  return (
    <div className="model-detail">
      <input className="model-name-input" value={name} spellCheck={false} maxLength={80} title="Rename model"
        onChange={e => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={e => {
          const input = e.currentTarget;
          if (e.key === 'Enter') input.blur();
          // Blur after the revert renders so commitName sees the original name
          if (e.key === 'Escape') { setName(model.name); setTimeout(() => input.blur(), 0); }
        }} />
      <div className="model-source">
        {isDetector(model) ? 'Object detector (YOLO) · ' : ''}{model.source.kind === 'trained' ? `Trained${t?.dataDir ? ` on ${baseName(t.dataDir)}` : ''}` : 'Imported'} · added {longDate(model.createdAt)}
      </div>

      {model.missing && (
        <div className="models-notice models-notice-error">
          FireFly's copy of this model was deleted. Import the .onnx file again to restore it.
        </div>
      )}

      <div className="train-metric-row model-stats">
        {isDetector(model) ? <>
        <span className="train-metric">
          <span>mAP50 <InfoTip text="How well its boxes find the objects in validation images it never trained on, at its best epoch: a box counts when it overlaps the true one by half or more and has the right class. Above 75% works well for following objects." /></span>
          <b style={{ color: '#4fc3f7' }}>{t?.map50 !== undefined ? pct(t.map50) : '–'}</b>
          <span className="train-metric-bench">{t?.map50 !== undefined ? mapBench(t.map50) : 'not recorded'}</span>
        </span>
        <span className="train-metric">
          <span>mAP50-95 <InfoTip text="The same, averaged over stricter overlaps (50% to 95%): how tight its boxes are." /></span>
          <b>{t?.map !== undefined ? pct(t.map) : '–'}</b>
        </span>
        <span className="train-metric" title={classList(model)}>
          <span>Classes</span>
          <b className="model-classes">{classList(model) || '–'}</b>
        </span>
        </> : (
        <span className="train-metric">
          <span>Val IoU <InfoTip text="Overlap between predicted and true masks on validation images the model never trained on, at its best epoch. Above 65% works for detection, above 80% is production-quality." /></span>
          <b style={{ color: '#4fc3f7' }}>{t?.valIou !== undefined ? pct(t.valIou) : '–'}</b>
          <span className="train-metric-bench">{t?.valIou !== undefined ? iouBench(t.valIou) : 'not recorded'}</span>
        </span>)}
        <span className="train-metric">
          <span>Best epoch</span>
          <b>{t?.bestEpoch !== undefined ? `${t.bestEpoch} / ${t.epochs}` : '–'}</b>
        </span>
        <span className="train-metric">
          <span>Input</span>
          <b>{model.input ? `${model.input.width}×${model.input.height}` : 'dynamic'}</b>
        </span>
        <span className="train-metric">
          <span>Size</span>
          <b>{fileSize(model.size)}</b>
        </span>
      </div>

      <div className="model-section-hd">Outputs</div>
      <div className="model-outputs">
        {recorded.length
          ? recorded.map(r => (
              <span key={r.name} className="model-output-chip" title={`Recorded as “${r.name}” (${r.type})`}>
                {r.name}<span className="flow-chip">{TYPE_BADGE[r.type]}</span>
              </span>
            ))
          : <span className="model-hint">Nothing recorded yet: outputs only draw on the live view.</span>}
        <button className="train-btn-sm" onClick={() => onEditOutputs(model.id)}>Edit outputs →</button>
      </div>

      <label className="model-device-row" title={locked ? 'Stop recording before changing what it runs on' : 'What this model runs on. Each model can run on its own: a light one on the CPU beside a heavy one on the GPU, say. What it runs on is part of what recordings are made with.'}>
        Runs on
        <select aria-label="Model device" className="flow-select" value={model.device ?? ''} disabled={locked}
          onChange={e => onDevice(model.id, e.target.value || null)}>
          <option value="">Same as toolbar ({toolbarDevice})</option>
          {devices.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          {model.device && !devices.some(d => d.id === model.device) && <option value={model.device} disabled>Saved device unavailable</option>}
        </select>
      </label>
      {model.device && !devices.some(d => d.id === model.device) && (
        <div className="models-notice models-notice-error">The device this model was set to run on isn’t available on this PC. Choose another.</div>
      )}

      <div className="model-run-row">
        {running
          ? <button className="train-btn-stop" disabled={recording} onClick={() => onStop(model.id)}>⏹ Stop model</button>
          : <button className="train-btn-primary" disabled={recording || model.missing} onClick={() => onRun(model)}>▶ Run on live capture</button>}
      </div>
      {recording && <div className="model-hint">Stop recording to change which models run.</div>}
      {!recording && others.length > 0 && (
        <div className="model-hint">
          {running ? 'Runs' : 'Will run'} beside {others.map(m => `“${m.name}”`).join(', ')}. Every frame goes through each model in turn, so each one adds its time to every frame.
        </div>
      )}
      {clashes.length > 0 && (
        <div className="models-notice models-notice-error">
          {earlier.length > 1 ? 'Another running model records' : `“${earlier[0]?.name}” records`} {clashes.map(n => `“${n}”`).join(', ')} already, so this model’s isn’t recorded. Rename it in Edit outputs.
        </div>
      )}
      {status && <div className={`model-status model-status-${status.tone}`}>{status.tone === 'ok' && <span className="model-dot model-dot-on" />}{status.text}</div>}

      <div className="model-footer">
        <span className="model-path" title={model.source.path}>From {model.source.path}</span>
        <button className="train-btn-sm" onClick={() => onReveal(model.id)}>Show in folder</button>
        <button className="train-btn-sm model-delete-btn" disabled={locked} onClick={() => setConfirmDelete(true)}>Delete…</button>
      </div>

      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><span className="modal-title">Delete “{model.name}”?</span></div>
            <div className="modal-body-text">
              This removes FireFly's copy of the model. The original file at <span className="model-path-inline">{model.source.path}</span> is not touched.
            </div>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="modal-btn modal-btn-danger" onClick={() => { setConfirmDelete(false); onDelete(model.id); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
