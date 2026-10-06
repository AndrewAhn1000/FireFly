import { useMemo } from 'react';
import FlowEditor, { type FlowError, type FlowSource } from './FlowEditor';
import { compileFlow, REGION_TEMPLATES, type Flow, type FlowProblem } from './flows';
import { regionCropNode, type NodeResult } from './models';

export interface ValuesRegion { id: string; label: string; flow?: Flow }

interface Props {
  regions: ValuesRegion[];            // the regions that can have values
  region: ValuesRegion | null;        // the one being edited
  onSelectRegion(id: string): void;
  problems: FlowProblem[];
  error: FlowError | null;
  nodes: Record<string, NodeResult>;  // live value of every graph node
  live: boolean;                      // capture is running
  recording: boolean;
  preview: string | null;
  previewed: (NodeResult & { node: string }) | null;
  onPreview(node: string | null): void;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChange(flow: Flow): void;
  onAddValue(template: string): void;
  onPickColor(apply: (hex: string) => void): void;
}

const EMPTY_FLOW: Flow = { version: 1, thickness: 2, outputs: [] };

// What the values of a region are read from: its pixels, cropped out of the frame
export default function ValuesPanel(props: Props) {
  const { regions, region, onSelectRegion, problems, error, nodes, live, recording, preview, previewed, onPreview,
    selectedId, onSelect, onChange, onAddValue, onPickColor } = props;
  const flow = region?.flow ?? EMPTY_FLOW;
  const sources = useMemo(() => {
    const found: Record<string, FlowSource> = {};
    if (region) found.region = { node: regionCropNode(region.id), label: `Pixels of ${region.label}`, type: 'image' };
    return found;
  }, [region]);
  const compiled = useMemo(() => compileFlow(flow, { region: { node: region ? regionCropNode(region.id) : '', type: 'image' } }, 'frame'), [flow, region]);

  if (!region) return (
    <div className="flow-empty">
      Draw a region on the Game View, then turn what’s inside it into a value here, such as how full a health bar is.
    </div>
  );

  const locked = recording; // recordings keep the observations they started with

  return (
    <div className="flow-panel">
      <div className="flow-hd">
        <span className="flow-hd-lbl">Values of</span>
        <select className="flow-select" value={region.id} onChange={e => { onPreview(null); onSelect(null); onSelectRegion(e.target.value); }}>
          {regions.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select className="flow-select" value="" disabled={locked} onChange={e => { if (e.target.value) onAddValue(e.target.value); }}>
          <option value="">Add a value…</option>
          {REGION_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <span className="flow-hd-note">Values are read from what’s inside the box and recorded with every sample.</span>
      </div>

      {error && !error.output && <div className="flow-banner flow-banner-err">{error.message}</div>}
      {locked && <div className="flow-banner">Recording: values are locked until it stops.</div>}

      {flow.outputs.length === 0 ? (
        <div className="flow-starts">
          <div className="flow-hint">Nothing is read from {region.label} yet. Start from one of these, then adjust its steps:</div>
          {REGION_TEMPLATES.map(t => (
            <button key={t.id} className="flow-start" disabled={locked} onClick={() => onAddValue(t.id)}>
              <b>{t.label}</b>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
      ) : (
        <FlowEditor
          flow={flow} compiled={compiled} sources={sources} defaultSource="region"
          newId={() => `${regionCropNode(region.id).slice('crop-'.length)}_${crypto.randomUUID().slice(0, 8)}`}
          problems={problems} error={error} nodes={nodes}
          live={live} liveHint="Start capture to see each step’s live result and preview steps on the Game View."
          maskOf="the box" preview={preview} previewed={previewed} onPreview={onPreview}
          locked={locked} canDraw={false} selectedId={selectedId} onSelect={onSelect} onChange={onChange}
          emptyText="Add an output, or start from Add a value…"
          onPickColor={onPickColor}
        />
      )}
    </div>
  );
}
