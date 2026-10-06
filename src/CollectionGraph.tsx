import { useState, useEffect, useMemo, createContext, useContext, useCallback, useRef, type DragEvent } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, addEdge, reconnectEdge, useNodesState, useEdgesState, useReactFlow, useUpdateNodeInternals, type NodeProps, type Connection, type Viewport, type Edge } from '@xyflow/react';
import { collectionDefaults, collectionInputs, canConnectCollection, emptyCollection, migrateTables, logicInputs, nextLogicInput, type TableMatch, type CollectionData, type CollectionNode, type CollectionKind, type CollectionDoc, type CollectionStatus, type CaptureRegion } from './collectionModel';
import TableViewer from './TableViewer';
import DatasetViewer from './DatasetViewer';
import AliasInput from './FormulaAliasInput';
import { NEW_INPUT, aliasFrom, isAlias, renameIn } from './formulaInputs';
import { PreservedTextarea, PreservedInput } from './PreservedInputs';

interface Props { storageKey: string; graphId: string; name: string; scope: string; windowId: string | null; capturing: boolean; observed: Record<string, string>; stateLabels: Record<string, string>; regions: CaptureRegion[]; status?: CollectionStatus; }
interface Context {
  update(id: string, patch: Partial<CollectionData>): void; removeNode(id: string): void; fields: Record<string, string>; labels: Record<string, string>; regions: CaptureRegion[]; status?: CollectionStatus; locked: boolean;
  addInput(id: string, source: string): void; renameInput(id: string, alias: string, next: string): void; removeInput(id: string, alias: string): void;
  inputChoices(id: string): { id: string; label: string }[]; wiredInto(id: string, alias: string): string | undefined;
  incomingNode(id: string, handle?: string): CollectionNode | undefined;
  wiredType(id: string, alias: string): string | undefined; openTable(name: string): void; openDataset(directory: string): void;
}
const Context = createContext<Context>(null!);
const titles: Record<CollectionKind, string> = { state: 'State', condition: 'Condition', logic: 'Logic', formula: 'Formula', trigger: 'Trigger', capture: 'Capture image', format: 'Format Dataset', output: 'Dataset Output', table: 'Table' };

function CollectionCard({ id, data: d, selected }: NodeProps<CollectionNode>) {
  const ctx = useContext(Context), update = (patch: Partial<CollectionData>) => ctx.update(id, patch);
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [id, d.inputs, d.operator, updateInternals]);
  const text = (label: string, key: 'name' | 'value' | 'upper' | 'source' | 'pattern' | 'labels') => <label>{label}<PreservedInput aria-label={label} value={d[key] ?? ''} onChange={e => update({ [key]: e.target.value })} /></label>;
  const number = (label: string, key: 'holdMs' | 'intervalMs' | 'cooldownMs' | 'width' | 'height' | 'quality' | 'valSplit') => <label>{label}<input aria-label={label} type="number" min={0} value={d[key] ?? 0} onChange={e => update({ [key]: Number(e.target.value) })} /></label>;
  const select = (label: string, key: 'operator' | 'mode' | 'area' | 'format' | 'metadata' | 'formatType', choices: [string, string][]) => <label>{label}<select aria-label={label} value={d[key]} onChange={e => update({ [key]: e.target.value })}>{choices.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>;
  const val = ctx.status?.values[id], issue = ctx.status?.issues[id];
  return <div className={`pg-node collection-node ${d.kind === 'table' ? 'collection-table' : ''} ${selected ? 'pg-selected' : ''}`}>
    <div className="pg-title"><span className="pg-glyph">{d.kind === 'state' ? '●' : d.kind === 'trigger' ? 'ϟ' : d.kind === 'format' ? '⛶' : d.kind === 'output' ? '▤' : d.kind === 'table' ? '▦' : '◇'}</span><span>{titles[d.kind]}</span><button className="nodrag pg-x pg-node-delete" disabled={ctx.locked} title={`Delete ${titles[d.kind]} node`} aria-label={`Delete ${titles[d.kind]} node`} onClick={() => ctx.removeNode(id)}>✕</button></div>
    {d.kind === 'formula' || d.kind === 'table' || d.kind === 'logic' ? <>
      {(d.kind === 'logic' ? logicInputs(d) : d.inputs ?? []).map(alias => {
        const from = ctx.wiredInto(id, alias);
        return <div className="pg-input-row" key={alias}>
          <Handle className="pg-handle" type="target" position={Position.Left} id={alias} />
          {d.kind !== 'logic' && <AliasInput alias={alias} taken={d.inputs ?? []} disabled={ctx.locked} onRename={next => ctx.renameInput(id, alias, next)} />}
          <span className={`pg-from ${from ? '' : 'pg-unwired'}`} title={from ? (d.kind === 'logic' ? from : `${alias} stands for ${from}`) : 'Wire something into it'}>{from ? `← ${from}` : 'not wired'}</span>
          {d.kind === 'table' && <select className="nodrag collection-match" aria-label={`Match ${alias}`} disabled={ctx.locked} value={d.match?.[alias] ?? 'same'}
            title="Same value: compare only with rows holding this value. Any new item: new while it holds an item those rows didn't. Any value: kept with the row, not compared."
            onChange={e => update({ match: { ...(d.match ?? {}), [alias]: e.target.value as TableMatch } })}>
            <option value="same">Same value</option><option value="any">Any new item</option><option value="store">Any value</option>
          </select>}
          <button className="nodrag pg-x" disabled={ctx.locked} title={`Remove input ${alias}`} onClick={() => ctx.removeInput(id, alias)}>✕</button>
        </div>;
      })}
      {!(d.kind === 'logic' && d.operator === 'not' && logicInputs(d).length > 0) && <div className="pg-input-row pg-new-input">
        <Handle className="pg-handle pg-handle-new" type="target" position={Position.Left} id={NEW_INPUT} />
        <span>{d.kind === 'table' ? 'Drop a wire here for a new column, or' : d.kind === 'logic' ? 'Drop a condition here, or' : 'Drop a wire here for a new input, or'}</span>
        <select className="nodrag" aria-label={d.kind === 'table' ? 'Add a column from' : 'Add an input from'} value="" disabled={ctx.locked} onChange={e => { if (e.target.value) ctx.addInput(id, e.target.value); }}>
          <option value="">{d.kind === 'table' ? '+ column from…' : '+ input from…'}</option>
          {ctx.inputChoices(id).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>}
    </> : d.kind === 'format' ? <>
      <div className="pg-port"><Handle type="target" position={Position.Left} id="image" />Image</div>
      {(d.inputs ?? []).map(alias => {
        const from = ctx.wiredInto(id, alias);
        return <div className="pg-input-row" key={alias}>
          <Handle className="pg-handle" type="target" position={Position.Left} id={alias} />
          <AliasInput alias={alias} taken={d.inputs ?? []} disabled={ctx.locked} onRename={next => ctx.renameInput(id, alias, next)} />
          <span className={`pg-from ${from ? '' : 'pg-unwired'}`} title={from ? `${alias} stands for ${from}` : 'Wire something into it'}>{from ? `← ${from}` : 'not wired'}</span>
          <PreservedInput
            aria-label={`Class for ${alias}`}
            className="nodrag collection-class-input"
            placeholder="class name"
            disabled={ctx.locked}
            value={d.classes?.[alias] ?? alias}
            onChange={e => update({ classes: { ...(d.classes ?? {}), [alias]: e.target.value } })}
            title="Class name or ID for YOLO label"
          />
          <button className="nodrag pg-x" disabled={ctx.locked} title={`Remove input ${alias}`} onClick={() => ctx.removeInput(id, alias)}>✕</button>
        </div>;
      })}
      <div className="pg-input-row pg-new-input">
        <Handle className="pg-handle pg-handle-new" type="target" position={Position.Left} id={NEW_INPUT} />
        <span>Drop a state wire here, or</span>
        <select className="nodrag" aria-label="Add state input from" value="" disabled={ctx.locked} onChange={e => { if (e.target.value) ctx.addInput(id, e.target.value); }}>
          <option value="">+ state input…</option>
          {ctx.inputChoices(id).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
    </> : collectionInputs(d).map(handle => <div className="pg-port" key={handle}><Handle type="target" position={Position.Left} id={handle} />{handle === 'in' ? (d.kind === 'capture' ? 'Trigger event' : d.kind === 'output' ? 'Image / Formatted' : 'Value') : handle}</div>)}
    <fieldset disabled={ctx.locked} className="nodrag nowheel collection-fields">
      {d.kind !== 'state' && d.kind !== 'table' && text('Name', 'name')}
      {d.kind === 'state' && <><label>State<select aria-label="State" value={d.name} onChange={e => update({ name: e.target.value })}><option value={d.name}>{ctx.labels[d.name] ?? d.name}</option>{Object.keys(ctx.fields).filter(f => f !== d.name && ctx.fields[f] !== 'image').map(f => <option key={f} value={f}>{ctx.labels[f] ?? f}</option>)}</select></label><small>{ctx.fields[d.name] ?? 'Unavailable'}</small></>}
      {d.kind === 'condition' && <>{select('Compare', 'operator', [['true', 'Is true'], ['false', 'Is false'], ['gt', 'Greater than'], ['ge', 'At least'], ['lt', 'Less than'], ['le', 'At most'], ['eq', 'Equals'], ['ne', 'Does not equal'], ['between', 'Between'], ['changed', 'Changed']])}{!['true', 'false', 'changed'].includes(d.operator!) && text('Value', 'value')}{d.operator === 'between' && text('Upper value', 'upper')}</>}
      {d.kind === 'logic' && select('Combine', 'operator', [['all', 'All (AND)'], ['any', 'Any (OR)'], ['not', 'Not']])}
      {d.kind === 'formula' && <><label>Expression<PreservedTextarea className="nodrag nowheel" aria-label="Expression" value={d.source} onChange={e => update({ source: e.target.value })} /></label><small>Use the input names above, e.g. count_within(enemies, player, 150) &gt; 2. Timing belongs in Trigger nodes.</small></>}
      {d.kind === 'trigger' && <>{select('Fire', 'mode', [['rise', 'When true'], ['fall', 'When false'], ['repeat', 'Repeat while true']])}{number('Hold for (ms)', 'holdMs')}{d.mode === 'repeat' && number('Every (ms)', 'intervalMs')}{number('Cooldown (ms)', 'cooldownMs')}<label className="collection-check"><input type="checkbox" checked={d.initial} onChange={e => update({ initial: e.target.checked })} />Fire if already satisfied at start</label></>}
      {d.kind === 'capture' && <>{select('Area', 'area', [['window', 'Full window'], ['crop', 'Fixed region crop']])}{d.area === 'crop' && <label>Region<select aria-label="Capture region" value={d.regionId ?? ''} onChange={e => { const r = ctx.regions.find(r => r.id === e.target.value); if (r) update({ regionId: r.id, crop: { x: r.x, y: r.y, w: r.w, h: r.h } }); }}><option value="">Choose region…</option>{ctx.regions.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select><small>Uses the region's saved rectangle.</small></label>}{select('Image format', 'format', [['png', 'PNG (lossless)'], ['jpeg', 'JPEG']])}{d.format === 'jpeg' && number('Quality', 'quality')}{number('Resize width (0 = original)', 'width')}{number('Resize height (0 = original)', 'height')}</>}
      {d.kind === 'table' && <>
        {text('Table name', 'name')}
        <small>True while the values are new to the table, as each column's Match says: wire it into a Trigger (Repeat while true). When a screenshot that Trigger fires is saved, the values become a row and stop being new. Tables with one name share their rows in every graph for this game.</small>
      </>}
      {d.kind === 'format' && <>
        {select('Format', 'formatType', [['yolo', 'YOLO Object Detection (txt + data.yaml)']])}
        {number('Validation split (%)', 'valSplit')}
        <small>Wires from State nodes provide bounding boxes for each class. Formats train/val images and labels.</small>
      </>}
      {d.kind === 'output' && (() => {
        const fedBy = ctx.incomingNode(id, 'in');
        const isFormat = fedBy?.data.kind === 'format';
        return <>
          <label>Dataset folder<PreservedInput aria-label="Dataset folder" value={d.directory} onChange={e => update({ directory: e.target.value })} /></label>
          <button className="modal-btn" onClick={() => void window.bridge.training.pickFolder().then(directory => { if (directory) update({ directory }); })}>Choose folder</button>
          {text('Filename pattern', 'pattern')}
          <small>{'{session}/{trigger}/{sequence}'}<br />Also: {'{timestamp}, {graph}, {state:name}'}. Extension is added.</small>
          {isFormat ? (
            <div className="pg-hint" style={{ color: 'var(--accent)', marginTop: 4 }}>
              ✓ Outputting {fedBy!.data.formatType?.toUpperCase() ?? 'YOLO'} dataset formatted by <b>{fedBy!.data.name}</b> ({fedBy!.data.valSplit ?? 20}% val split, {fedBy!.data.inputs?.length ?? 0} classes)
            </div>
          ) : (
            <>
              {select('Metadata', 'metadata', [['yolo', 'YOLO dataset (images + labels + data.yaml)'], ['json', 'JSON per image'], ['jsonl', 'JSONL manifest'], ['csv', 'CSV manifest'], ['none', 'Images only']])}
              {d.metadata === 'yolo' && <>{number('Validation split (%)', 'valSplit')}<small>Splits into images/train, images/val, labels/train, labels/val, and generates data.yaml. Bounding boxes in selected states are normalized automatically.</small></>}
              <details><summary>State fields ({d.fields?.length ?? 0})</summary>{Object.keys(ctx.fields).filter(f => ctx.fields[f] !== 'image').map(f => <label className="collection-check" key={f}><input type="checkbox" checked={d.fields?.includes(f) ?? false} onChange={e => update({ fields: e.target.checked ? [...(d.fields ?? []), f] : d.fields?.filter(x => x !== f) })} />{ctx.labels[f] ?? f}</label>)}</details>
              {text('Custom labels (JSON object)', 'labels')}
              <small>{d.metadata === 'yolo' ? 'For YOLO: {"states": {"monsters": 0, "npcs": 1}} or {"classes": ["monsters", "npcs"]}. Defaults to field order.' : 'States retain source-frame coordinates. Metadata includes crop, resize and state age.'}</small>
            </>
          )}
        </>;
      })()}
    </fieldset>
    {d.kind === 'table' && <div className="collection-table-open"><button className="nodrag modal-btn" onClick={() => ctx.openTable(d.name)}>Open table</button></div>}
    {d.kind === 'output' && <div className="collection-table-open"><button className="nodrag modal-btn" disabled={!d.directory} title={d.directory ? 'Step through the saved images with their labels' : 'Choose a dataset folder first'} onClick={() => ctx.openDataset(d.directory!)}>Preview images</button></div>}
    {ctx.status && <div className={issue ? 'pg-error' : 'pg-hint'}>{issue ?? (val === null || val === undefined ? 'Unknown' : d.kind === 'table' && typeof val === 'string' ? val : JSON.stringify(val).slice(0, 140))}</div>}
    {d.kind !== 'output' && <Handle type="source" position={Position.Right} id="out" />}
  </div>;
}
const nodeTypes = { collection: CollectionCard };
export default function CollectionGraph(props: Props) { return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>; }
function Editor(props: Props) {
  const initial = useMemo(() => { try { const d = JSON.parse(localStorage.getItem(props.storageKey) ?? 'null'); if (d?.version === 1 && Array.isArray(d.nodes) && Array.isArray(d.edges)) {
    return migrateTables(d as CollectionDoc);
  } } catch { /* new */ } return emptyCollection(); }, [props.storageKey]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes), [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [maxAgeMs, setMaxAgeMs] = useState(initial.maxAgeMs ?? 250), [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const flow = useReactFlow(), locked = !!props.status?.running || starting;
  const doc = useMemo<CollectionDoc>(() => ({ version: 1, nodes, edges, maxAgeMs }), [nodes, edges, maxAgeMs]);
  useEffect(() => { try { localStorage.setItem(props.storageKey, JSON.stringify(doc)); } catch { setError('Could not save graph: local storage is full'); } }, [props.storageKey, doc]);
  const update = (id: string, patch: Partial<CollectionData>) => {
    if (locked) return;
    setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
    if (patch.inputs) setEdges(es => es.filter(e => e.target !== id || patch.inputs!.includes(e.targetHandle ?? '')));
    // Not takes one input: switching to it keeps the first and lets go of the rest
    const node = nodes.find(n => n.id === id);
    if (patch.operator === 'not' && node?.data.kind === 'logic') {
      const kept = logicInputs({ ...node.data, operator: 'not' });
      setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, inputs: kept } } : n));
      setEdges(es => es.filter(e => e.target !== id || kept.includes(e.targetHandle ?? '')));
    }
  };
  const valid = useCallback((c: Connection, excludeEdgeId?: string) => {
    const activeEdges = excludeEdgeId ? edges.filter(e => e.id !== excludeEdgeId) : edges;
    if (locked || !canConnectCollection(nodes, activeEdges, c.source, c.target, c.targetHandle ?? 'in')) return false;
    const source = nodes.find(n => n.id === c.source), target = nodes.find(n => n.id === c.target);
    const type = source?.data.kind === 'state' ? props.observed[source.data.name] : undefined;
    if (target?.data.kind === 'formula' && type && !['number', 'boolean', 'vector', 'shapes'].includes(type)) return false;
    if (target?.data.kind === 'format' && c.targetHandle !== 'image' && type && !['shapes', 'vector'].includes(type)) return false;
    if (target?.data.kind === 'table' && type === 'image') return false;
    if (target?.data.kind === 'logic' && type && type !== 'boolean') return false;
    return true;
  }, [locked, nodes, edges, props.observed]);
  const labelOf = useCallback((n: CollectionNode) => n.data.kind === 'state' ? props.stateLabels[n.data.name] ?? n.data.name : n.data.name, [props.stateLabels]);
  const addInput = useCallback((id: string, sourceId: string) => {
    if (!valid({ source: sourceId, target: id, sourceHandle: 'out', targetHandle: NEW_INPUT })) return;
    const targetNode = nodes.find(n => n.id === id), source = nodes.find(n => n.id === sourceId);
    if (!targetNode || !source) return;
    if (targetNode.data.kind === 'logic') {
      const alias = nextLogicInput(logicInputs(targetNode.data));
      setNodes(ns => ns.map(n => n.id === id ? { ...n, data: { ...n.data, inputs: [...logicInputs(n.data), alias] } } : n));
      setEdges(es => addEdge({ source: sourceId, sourceHandle: 'out', target: id, targetHandle: alias }, es));
    } else if (targetNode.data.kind === 'formula' || targetNode.data.kind === 'format' || targetNode.data.kind === 'table') {
      const alias = aliasFrom(labelOf(source), targetNode.data.inputs ?? []);
      // A list (such as animation numbers) is compared item by item; anything else by its value
      const match: TableMatch = source.data.kind === 'state' && props.observed[source.data.name] === 'shapes' ? 'any' : 'same';
      setNodes(ns => ns.map(n => n.id === id ? {
        ...n,
        data: {
          ...n.data,
          inputs: [...(n.data.inputs ?? []), alias],
          classes: n.data.kind === 'format' ? { ...(n.data.classes ?? {}), [alias]: alias } : n.data.classes,
          match: n.data.kind === 'table' ? { ...(n.data.match ?? {}), [alias]: match } : n.data.match
        }
      } : n));
      setEdges(es => addEdge({ source: sourceId, sourceHandle: 'out', target: id, targetHandle: alias }, es));
    }
  }, [valid, nodes, labelOf, setNodes, setEdges, props.observed]);
  const reconnected = useRef(true);
  const onReconnectStart = useCallback(() => { reconnected.current = false; }, []);
  const onReconnect = useCallback((old: Edge, c: Connection) => {
    reconnected.current = true;
    if (!valid(c, old.id)) return;
    if (c.targetHandle === NEW_INPUT) {
      setEdges(es => es.filter(e => e.id !== old.id));
      addInput(c.target, c.source);
      return;
    }
    setEdges(es => {
      const rest = es.filter(e => e.id === old.id || !(e.target === c.target && e.targetHandle === c.targetHandle));
      return reconnectEdge(old, c, rest);
    });
  }, [valid, addInput, setEdges]);
  const onReconnectEnd = useCallback((_: unknown, edge: Edge) => {
    if (!reconnected.current && edge) {
      setEdges(es => es.filter(e => e.id !== edge.id));
    }
    reconnected.current = true;
  }, [setEdges]);
  const renameInput = (id: string, alias: string, next: string) => {
    const targetNode = nodes.find(n => n.id === id);
    if (locked || !targetNode || (targetNode.data.kind !== 'formula' && targetNode.data.kind !== 'format' && targetNode.data.kind !== 'table') || !targetNode.data.inputs?.includes(alias) || !isAlias(next) || targetNode.data.inputs.includes(next)) return;
    setNodes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const nextClasses = { ...(n.data.classes ?? {}) };
      if (alias in nextClasses) {
        nextClasses[next] = nextClasses[alias];
        delete nextClasses[alias];
      }
      return {
        ...n,
        data: {
          ...n.data,
          inputs: n.data.inputs!.map(a => a === alias ? next : a),
          source: n.data.kind === 'formula' ? renameIn(n.data.source ?? '', alias, next) : n.data.source,
          classes: n.data.kind === 'format' ? nextClasses : n.data.classes,
          match: n.data.match && alias in n.data.match ? Object.fromEntries(Object.entries(n.data.match).map(([k, m]) => [k === alias ? next : k, m])) : n.data.match
        }
      };
    }));
    setEdges(es => es.map(e => e.target === id && e.targetHandle === alias ? { ...e, targetHandle: next } : e));
  };
  const removeInput = (id: string, alias: string) => {
    if (locked) return;
    setNodes(ns => ns.map(n => {
      if (n.id !== id) return n;
      const nextClasses = { ...(n.data.classes ?? {}) };
      delete nextClasses[alias];
      return {
        ...n,
        data: {
          ...n.data,
          inputs: (n.data.kind === 'logic' ? logicInputs(n.data) : n.data.inputs)?.filter(a => a !== alias),
          classes: n.data.kind === 'format' ? nextClasses : n.data.classes,
          match: n.data.match && Object.fromEntries(Object.entries(n.data.match).filter(([k]) => k !== alias))
        }
      };
    }));
    setEdges(es => es.filter(e => e.target !== id || e.targetHandle !== alias));
  };
  const inputChoices = (id: string) => nodes.filter(n => valid({ source: n.id, sourceHandle: 'out', target: id, targetHandle: NEW_INPUT })).map(n => ({ id: n.id, label: labelOf(n) }));
  const wiredInto = (id: string, alias: string) => {
    const source = nodes.find(n => n.id === edges.find(e => e.target === id && e.targetHandle === alias)?.source);
    return source ? labelOf(source) : undefined;
  };
  // What's wired into an input, when it's a State: its observation's type (a list State is 'shapes')
  const wiredType = (id: string, alias: string) => {
    const source = incomingNode(id, alias);
    return source?.data.kind === 'state' ? props.observed[source.data.name] : undefined;
  };
  const [openTable, setOpenTable] = useState<string | null>(null), [openDataset, setOpenDataset] = useState<string | null>(null);
  const incomingNode = (id: string, handle = 'in') => {
    const edge = edges.find(e => e.target === id && (e.targetHandle ?? 'in') === handle);
    return edge ? nodes.find(n => n.id === edge.source) : undefined;
  };
  const add = (kind: CollectionKind, name?: string, position = { x: Math.min(0, ...nodes.map(n => n.position.x)) - 280, y: 80 }) => setNodes(ns => [...ns, { id: crypto.randomUUID(), type: 'collection', position, data: collectionDefaults(kind, name ?? (kind === 'state' ? Object.keys(props.observed).find(f => props.observed[f] !== 'image') : undefined)) }]);
  const drop = (e: DragEvent) => {
    e.preventDefault(); if (locked) return;
    try { const item = JSON.parse(e.dataTransfer.getData('application/firefly-node')); if (item.kind in titles) add(item.kind, item.name, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })); } catch { /* other drag */ }
  };
  const run = async (test: boolean) => {
    setStarting(true); setError('');
    try { const result = await window.bridge.collection.start({ graphId: props.graphId, name: props.name, scope: props.scope, windowId: props.windowId, doc, test, maxAgeMs }); if (!result.ok) setError(result.error ?? 'Could not start'); }
    catch (e) { setError(String(e)); } finally { setStarting(false); }
  };
  const removeNode = (id: string) => {
    if (locked) return;
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
  };
  let viewport: Viewport | undefined;
  try { viewport = JSON.parse(localStorage.getItem(props.storageKey + '-view') ?? 'null') ?? undefined; } catch { /* initial view */ }
  return <Context.Provider value={{ update, removeNode, addInput, renameInput, removeInput, inputChoices, wiredInto, incomingNode, wiredType, openTable: setOpenTable, openDataset: setOpenDataset, fields: props.observed, labels: props.stateLabels, regions: props.regions, status: props.status, locked }}>
    <div className="collection-editor">
      <div className="collection-toolbar">
        <button className="modal-btn" disabled={!props.capturing || locked} onClick={() => void run(true)}>Test</button>
        <button className="modal-btn primary" disabled={!props.capturing || locked} onClick={() => void run(false)}>Start Collection</button>
        <button className="modal-btn" disabled={!props.status?.running} onClick={() => void window.bridge.collection.stop(props.graphId)}>Stop</button>
        <label title="Maximum age of a held input relative to this screenshot's frame; processing delay is separate">Input age limit <input aria-label="Input age limit" type="number" min={0} max={10000} disabled={locked} value={maxAgeMs} onChange={e => setMaxAgeMs(Number(e.target.value))} /> ms</label>
        <span>{props.status ? `${props.status.test ? 'Test' : 'Saved'}: ${props.status.test ? props.status.fired : props.status.saved} · skipped ${props.status.skipped}` : 'Stopped'}</span>
      </div>
      {(error || props.status?.error) && <div className="collection-error">{error || props.status?.error}</div>}
      <div className="collection-body">
        <aside className="pg-palette">
          <div className="pg-palette-hd">Add nodes</div>
          {(Object.keys(titles) as CollectionKind[]).map(kind => <button key={kind} className="pg-palette-item" disabled={locked} draggable={!locked} onDragStart={e => e.dataTransfer.setData('application/firefly-node', JSON.stringify({ kind }))} onClick={() => { add(kind); setTimeout(() => void flow.fitView({ duration: 200 }), 50); }}>{titles[kind]}</button>)}
          <div className="pg-hint">Drag States from the list on the right. Connect conditions → Trigger → Capture image → Dataset Output.</div>
          <div className="pg-hint">Test evaluates live triggers without writing images. Stop before editing a running graph.</div>
          <div className="pg-palette-hd">Recent captures</div>
          {props.status?.recent.map((r, i) => <div key={i} className="collection-recent"><b>{r.trigger}</b><span>{r.test ? 'Would capture' : r.path?.split(/[\\/]/).pop()}</span>{r.path && <button className="modal-btn" onClick={() => void window.bridge.policy.reveal(r.path!)}>Show file</button>}</div>)}
          <div className="pg-palette-hd">Output preview</div>
          {nodes.filter(n => n.data.kind === 'output').map(n => {
            const isFormat = edges.some(e => e.target === n.id && nodes.find(src => src.id === e.source)?.data.kind === 'format');
            const isYolo = isFormat || n.data.metadata === 'yolo';
            return <div className="collection-recent" key={n.id}>
              <b>{n.data.name}</b>
              <code>{isYolo ? 'images/{train,val}/… + labels/… + data.yaml' : `${(n.data.pattern ?? '').replace(/\{session\}/g, 'session-001').replace(/\{sequence\}/g, '000001').replace(/\{trigger\}/g, 'trigger').replace(/\{graph\}/g, props.name).replace(/\{timestamp\}/g, '1234.5').replace(/\{state:[^}]+\}/g, 'state-value')}.png / .jpg`}</code>
              <span>{isYolo ? 'YOLO dataset' : `${n.data.metadata} · ${n.data.fields?.length ?? 0} state fields`}</span>
            </div>;
          })}
        </aside>
        <div className="pg-canvas" onDragOver={e => e.preventDefault()} onDrop={drop}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={locked ? undefined : onEdgesChange}
            nodesConnectable={!locked} nodesDraggable={!locked} deleteKeyCode={locked ? null : ['Delete', 'Backspace']}
            edgesReconnectable={!locked} reconnectRadius={20}
            onReconnect={locked ? undefined : onReconnect}
            onReconnectStart={locked ? undefined : onReconnectStart}
            onReconnectEnd={locked ? undefined : onReconnectEnd}
            onConnect={c => {
              if (!valid(c)) return;
              if (c.targetHandle === NEW_INPUT) { addInput(c.target, c.source); return; }
              setEdges(es => addEdge(c, es.filter(e => !(e.target === c.target && e.targetHandle === c.targetHandle))));
            }}
            isValidConnection={c => valid(c as Connection)} defaultViewport={viewport} fitView={!viewport} minZoom={0.25} maxZoom={1.5} colorMode="dark"
            onMoveEnd={(_, v) => localStorage.setItem(props.storageKey + '-view', JSON.stringify(v))}>
            <Background gap={20} /><Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
    {openTable !== null && <TableViewer scope={props.scope} table={openTable} onClose={() => setOpenTable(null)} />}
    {openDataset !== null && <DatasetViewer directory={openDataset} onClose={() => setOpenDataset(null)} />}
  </Context.Provider>;
}
