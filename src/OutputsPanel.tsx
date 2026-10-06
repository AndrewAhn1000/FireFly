import { useMemo, useState } from 'react';
import FlowEditor from './FlowEditor';
import { type Flow, type FlowProblem } from './flows';
import { compileModel, detectorRoots, isDetector, modelFlow, modelTemplates, type ModelLive, type TrainedModel } from './models';

export type { FlowError } from './FlowEditor';
import type { FlowError } from './FlowEditor';

interface Props {
  models: TrainedModel[];
  model: TrainedModel | null;
  onSelectModel(id: string): void;
  running: boolean;     // this model is running
  live: ModelLive | null;
  recording: boolean;
  problems: FlowProblem[];
  error: FlowError | null;
  preview: string | null; // previewed graph node
  onPreview(node: string | null): void;
  onChange(patch: { flow?: Flow; threshold?: number }): void;
  onRun(): void;
  onStop(): void;
}

const MODEL_SOURCES = { mask: { node: 'mask', label: 'Model mask', type: 'mask' as const } };

export default function OutputsPanel(props: Props) {
  const { models, model, onSelectModel, running, live, recording, problems, error, preview, onPreview, onChange, onRun, onStop } = props;
  const flow = useMemo(() => model ? modelFlow(model) : null, [model]);
  const compiled = useMemo(() => model ? compileModel(model) : null, [model]);
  // A detector's outputs start from its boxes, all or one class's; a segmentation model's from its mask
  const sources = useMemo(() => model && isDetector(model) ? detectorRoots(model) : MODEL_SOURCES, [model]);
  const templates = useMemo(() => model ? modelTemplates(model) : [], [model]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [template, setTemplate] = useState<string | null>(null);

  if (!model || !flow || !compiled) return (
    <div className="flow-empty">Add a model in <b>Trained Models</b> to define what it outputs.</div>
  );

  const nodes = running ? live?.nodes ?? {} : {};
  const locked = recording && running; // recordings keep the observations they started with
  const setFlow = (next: Flow) => onChange({ flow: next });
  const previewed = preview && live?.preview?.node === preview ? live.preview : null;
  const detector = isDetector(model);

  return (
    <div className="flow-panel">
      <div className="flow-hd">
        <span className="flow-hd-lbl">Outputs of</span>
        <select className="flow-select" value={model.id} onChange={e => { onPreview(null); setSelectedId(null); onSelectModel(e.target.value); }}>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <span className="flow-hd-field" title={detector ? 'Confidence a box needs to count as a detection' : 'Probability a pixel needs to count as part of the mask'}>
          {detector ? 'Confidence' : 'Threshold'}
          <input type="range" min={0.05} max={0.95} step={0.01} value={model.threshold} disabled={locked}
            onChange={e => onChange({ threshold: parseFloat(e.target.value) })} />
          <span className="flow-hd-val">{model.threshold.toFixed(2)}</span>
        </span>
        <span className="flow-hd-field" title="Thickness of the lines drawn on the live view">
          Lines
          <input type="number" className="flow-num" min={1} max={12} value={flow.thickness} disabled={locked}
            onChange={e => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 12) setFlow({ ...flow, thickness: v }); }} />
          px
        </span>
        <select className="flow-select" value="" disabled={locked} onChange={e => setTemplate(e.target.value || null)}>
          <option value="">Start from a template…</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span className="flow-hd-run">
          {running
            ? <button className="train-btn-sm" disabled={recording} onClick={onStop}>⏹ Stop</button>
            : <button className="train-btn-sm flow-run" disabled={recording || model.missing} onClick={onRun}>▶ Run</button>}
        </span>
      </div>

      {template && (() => {
        const t = templates.find(x => x.id === template);
        if (!t) return null;
        return (
          <div className="flow-banner">
            <span><b>{t.label}:</b> {t.description} Replace this model’s outputs?</span>
            <button className="train-btn-sm" onClick={() => { onPreview(null); setSelectedId(null); setFlow(t.build()); setTemplate(null); }}>Replace</button>
            <button className="train-btn-sm" onClick={() => setTemplate(null)}>Cancel</button>
          </div>
        );
      })()}
      {error && !error.output && <div className="flow-banner flow-banner-err">{error.message}</div>}
      {locked && <div className="flow-banner">Recording: outputs are locked until it stops.</div>}

      <FlowEditor
        flow={flow} compiled={compiled} sources={sources} defaultSource={detector ? 'detections' : 'mask'}
        newId={() => `o${crypto.randomUUID().slice(0, 8)}`}
        problems={problems} error={error} nodes={nodes}
        live={running} liveHint="Run this model to see each step’s live result and preview steps on the Game View."
        maskOf="frame" preview={preview} previewed={previewed} onPreview={onPreview}
        locked={locked} canDraw selectedId={selectedId} onSelect={setSelectedId} onChange={setFlow}
        emptyText="This model has no outputs. Add one, or start from a template."
      />
    </div>
  );
}
