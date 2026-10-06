// User-editable flows that turn pixels into observations. Each output is a
// named list of steps (native/geometry.cpp) starting from a source: a model's
// mask, or the pixels of a region. A step can also start from another output.
// Flows compile into graph nodes.

export type FlowType = 'image' | 'mask' | 'shapes' | 'number' | 'text';

// How a type is named on a badge, and in a sentence
export const TYPE_BADGE: Record<FlowType, string> = { image: 'IMAGE', mask: 'MASK', shapes: 'SHAPES', number: 'NUM', text: 'TEXT' };
const TYPE_NOUN: Record<FlowType, string> = { image: 'an image', mask: 'a mask', shapes: 'shapes', number: 'a number', text: 'text' };

export interface FlowStep {
  op: string;
  params: Record<string, number | string>;
  with?: string; // another output's id, feeding the step's second input
}

export interface FlowOutput {
  id: string;      // stable; names graph nodes and references
  name: string;    // observation name when recorded
  from: string;    // the flow's source ('mask' or 'region') or another output's id
  steps: FlowStep[];
  record: boolean; // publish as an observation, for recordings and States
  show: boolean;   // draw on the live view
  color: string;
  label: string;   // prefix of the index labels drawn on the live view, '' for none
}

export interface Flow { version: 1; thickness: number; outputs: FlowOutput[] }

export interface ParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'expression' | 'name' | 'color';
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  default: number | string;
  help?: string;
}

export interface OpSpec {
  op: string;
  label: string;
  help: string;
  input: FlowType | FlowType[]; // what it can be given
  output: FlowType;
  with?: { type: FlowType; label: string; optional: boolean };
  params: ParamSpec[];
  // The runtime operation and settings this step runs as, when they differ from its own
  native?(params: Record<string, number | string>): { op: string; params: Record<string, unknown> };
}

export const inputTypes = (spec: OpSpec): FlowType[] => Array.isArray(spec.input) ? spec.input : [spec.input];
export const accepts = (spec: OpSpec, type: FlowType) => inputTypes(spec).includes(type);

const direction: ParamSpec = { key: 'direction', label: 'Direction', kind: 'select', options: ['vertical', 'horizontal'], default: 'vertical' };

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const OPS: OpSpec[] = [
  {
    op: 'color', label: 'Pick a colour', input: 'image', output: 'mask',
    help: 'Keeps the pixels close to one colour, such as the red of a health bar. Tolerance is how far red, green and blue may each differ from it: raise it if part of the colour is missed, lower it if other things are caught.',
    params: [
      { key: 'color', label: 'Colour', kind: 'color', default: '#ff0000' },
      { key: 'tolerance', label: 'Tolerance', kind: 'number', min: 0, max: 255, step: 1, default: 40 },
    ],
    native: p => {
      const rgb = HEX_COLOR.test(String(p.color)) ? parseInt(String(p.color).slice(1), 16) : 0xff0000;
      const tolerance = Number(p.tolerance);
      const range = (c: number) => [Math.max(0, c - tolerance), Math.min(255, c + tolerance)];
      const [rMin, rMax] = range((rgb >> 16) & 255), [gMin, gMax] = range((rgb >> 8) & 255), [bMin, bMax] = range(rgb & 255);
      return { op: 'threshold', params: { rMin, rMax, gMin, gMax, bMin, bMax } };
    },
  },
  {
    op: 'morph', label: 'Clean up', input: 'mask', output: 'mask',
    help: 'Close fills small holes and gaps, open removes specks, dilate grows the mask and erode shrinks it.',
    params: [
      { key: 'operation', label: 'Operation', kind: 'select', options: ['close', 'open', 'dilate', 'erode'], default: 'close' },
      { key: 'width', label: 'Width', kind: 'number', min: 1, max: 255, step: 1, default: 3 },
      { key: 'height', label: 'Height', kind: 'number', min: 1, max: 255, step: 1, default: 3 },
    ],
  },
  {
    op: 'runs', label: 'Keep runs', input: 'mask', output: 'mask',
    help: 'Keeps the pixels on straight runs whose length is in range. Tall vertical runs pick out ladders, poles and walls; long horizontal runs pick out floors.',
    params: [
      direction,
      { key: 'min', label: 'Min length', kind: 'number', min: 1, max: 65535, step: 1, default: 1 },
      { key: 'max', label: 'Max length', kind: 'number', min: 0, max: 65535, step: 1, default: 0, help: '0 for no limit' },
    ],
  },
  {
    op: 'combine', label: 'Combine masks', input: 'mask', output: 'mask',
    with: { type: 'mask', label: 'With', optional: false },
    help: 'Subtracts, intersects or adds another output’s mask.',
    params: [{ key: 'operation', label: 'Operation', kind: 'select', options: ['subtract', 'intersect', 'union'], default: 'subtract' }],
  },
  {
    op: 'run_length', label: 'Measure run length', input: 'mask', output: 'number',
    help: 'Median length of the runs up to Max length, e.g. how thick platforms are. Later steps can use it to size things relative to what’s on screen.',
    params: [direction, { key: 'max', label: 'Max length', kind: 'number', min: 0, max: 65535, step: 1, default: 0, help: '0 for no limit' }],
  },
  {
    op: 'coverage', label: 'Measure coverage', input: 'mask', output: 'number',
    help: 'Fraction of the image the mask covers.',
    params: [],
  },
  {
    op: 'reach', label: 'Measure reach', input: 'mask', output: 'number',
    help: 'How far the mask reaches across the image from one edge, from 0 (nothing) to 1 (all the way): the level of a bar or gauge. Gaps inside it, such as digits drawn on a bar, don’t count.',
    params: [{ key: 'from', label: 'From', kind: 'select', options: ['left', 'right', 'top', 'bottom'], default: 'left', help: 'The edge the bar fills from' }],
  },
  {
    op: 'ocr', label: 'Read text', input: ['image', 'mask'], output: 'text',
    help: 'Reads the text in the box with Windows’ text recognition. Light text on a dark ground is turned around and small text is enlarged first. If it misreads, isolate the letters first with Pick a colour and Clean up, or set Accuracy to careful. Windows needs a text recognition language installed: Settings › Time & language › Language & region.',
    params: [
      { key: 'accuracy', label: 'Accuracy', kind: 'select', options: ['normal', 'careful'], default: 'normal', help: 'Careful reads the box at several sizes and keeps the answer most of them agree on: better with small or unusual text, and a few times slower.' },
      { key: 'invert', label: 'Invert', kind: 'select', options: ['auto', 'off', 'on'], default: 'auto', help: 'Text reads best dark on a light ground. Auto turns light text on a dark ground around; choose on or off when it guesses wrong.' },
      { key: 'scale', label: 'Enlarge', kind: 'number', min: 0, max: 8, step: 1, default: 0, help: 'How many times bigger the box is made before it is read. 0 chooses from its height, so that small text is about 48 pixels tall.' },
      { key: 'language', label: 'Language', kind: 'name', default: 'auto', help: 'auto uses the languages Windows has for you. Or give a language tag such as en-US, de-DE or ja.' },
    ],
  },
  {
    op: 'number_in_text', label: 'Find a number', input: 'text', output: 'number',
    help: 'Picks a number out of text: in “Lv. 42” the first number is 42, and in “340 / 500” the first is 340 and the second 500. A thousands comma (1,234) and decimals (2.5) belong to the number, and a minus sign counts when it starts the text or follows a space. With no such number in the text there is no value.',
    params: [{ key: 'which', label: 'Which number', kind: 'number', min: 1, max: 32, step: 1, default: 1, help: '1 is the first number in the text, 2 the second, and so on' }],
  },
  {
    op: 'components', label: 'Find regions', input: 'mask', output: 'shapes',
    help: 'Each connected blob becomes a shape measured by x, y, width, height, area, cx, cy (centre), fill (how solid its box is), meanWidth, meanHeight and touchesTop/Bottom/Left/Right.',
    params: [
      { key: 'minArea', label: 'Min area', kind: 'number', min: 1, max: 1e9, step: 1, default: 1 },
      { key: 'connectivity', label: 'Connectivity', kind: 'select', options: [8, 4], default: 8 },
    ],
  },
  {
    op: 'trace', label: 'Trace lines', input: 'mask', output: 'shapes',
    with: { type: 'number', label: 'Band height', optional: true },
    help: 'Follows horizontal bands column by column into lines, like the walking surface of platforms. Lines are measured by band (thickness) and length.',
    params: [
      { key: 'position', label: 'Line position', kind: 'number', min: 0, max: 1, step: 0.05, default: 0, help: 'Where the line sits in its band: 0 top edge, 0.5 centre, 1 bottom edge' },
      { key: 'maxStep', label: 'Max step', kind: 'number', min: 1, max: 1000, step: 1, default: 8, help: 'Largest change of a band’s top between neighbouring columns; bigger jumps start a new line' },
      { key: 'maxGap', label: 'Max gap', kind: 'number', min: 0, max: 1000, step: 1, default: 3, help: 'Columns a band may skip before its line ends' },
      { key: 'stack', label: 'Stack split', kind: 'number', min: 0, max: 100, step: 0.1, default: 1.5, help: 'Runs this many bands tall are two bands stacked (e.g. a ramp over a platform) and trace separately; 0 turns this off' },
      { key: 'maxBand', label: 'Max band', kind: 'number', min: 0, max: 65535, step: 1, default: 0, help: 'Cap on a line’s measured band; 0 for none' },
    ],
  },
  {
    op: 'filter', label: 'Filter', input: 'shapes', output: 'shapes',
    with: { type: 'number', label: 'Variable', optional: true },
    help: 'Keeps the shapes for which the expression is true. Use their measurements with and/or/not, comparisons, + - * /, min(), max() and abs(). A variable input is available under its name.',
    params: [
      { key: 'expression', label: 'Keep where', kind: 'expression', default: 'area >= 20' },
      { key: 'variable', label: 'Variable name', kind: 'name', default: 'value' },
    ],
  },
  {
    op: 'join', label: 'Join gaps', input: 'shapes', output: 'shapes',
    with: { type: 'mask', label: 'Only across', optional: true },
    help: 'Joins lines end to start across short gaps. Given a mask, only where the mask fills the gap, like a ladder that cut through a platform.',
    params: [
      { key: 'maxGap', label: 'Max gap', kind: 'number', min: 1, max: 65535, step: 1, default: 80 },
      { key: 'maxRise', label: 'Max rise', kind: 'number', min: 0, max: 1e6, step: 1, default: 20, help: 'Largest height difference between the ends' },
    ],
  },
  {
    op: 'simplify', label: 'Simplify', input: 'shapes', output: 'shapes',
    help: 'Smooths lines, then reduces them to as few straight segments as stay within the tolerance.',
    params: [
      { key: 'smooth', label: 'Smooth', kind: 'number', min: 0, max: 1000, step: 1, default: 0, help: 'Averages over ± this many pixels' },
      { key: 'epsilon', label: 'Tolerance', kind: 'number', min: 0, max: 1000, step: 0.5, default: 2 },
    ],
  },
  {
    op: 'segments', label: 'Split into segments', input: 'shapes', output: 'shapes',
    help: 'Splits lines into straight segments {x1, y1, x2, y2}, ordered top to bottom in rows, then left to right.',
    params: [{ key: 'rowHeight', label: 'Row height', kind: 'number', min: 1, max: 10000, step: 1, default: 16 }],
  },
  {
    op: 'axis_line', label: 'Centre line', input: 'shapes', output: 'shapes',
    help: 'A line through each region’s centre along its length, measured by width (vertical) or thickness (horizontal). Suits ladders, ropes and poles.',
    params: [direction],
  },
  {
    op: 'snap', label: 'Snap ends', input: 'shapes', output: 'shapes',
    with: { type: 'shapes', label: 'Onto', optional: false },
    help: 'Moves each line’s ends up or down onto the nearest line of another output, like the bottom of a ladder onto the floor it stands on.',
    params: [
      { key: 'tolerance', label: 'Tolerance', kind: 'number', min: 0, max: 1e6, step: 1, default: 20, help: 'Farthest an end moves' },
      { key: 'reach', label: 'Reach', kind: 'number', min: 0, max: 1e6, step: 1, default: 0, help: 'How far past a target line’s ends it still counts' },
    ],
  },
  {
    op: 'rasterize', label: 'To mask', input: 'shapes', output: 'mask',
    help: 'Draws the shapes back into a mask, for combining or joining.',
    params: [{ key: 'thickness', label: 'Line thickness', kind: 'number', min: 1, max: 64, step: 1, default: 1 }],
  },
  {
    op: 'count', label: 'Count', input: 'shapes', output: 'number',
    help: 'How many shapes there are.',
    params: [],
  },
  {
    op: 'calculate', label: 'Calculate', input: 'number', output: 'number',
    with: { type: 'number', label: 'Second number', optional: true },
    help: 'Works out a new number from this one, which is called value. For example value * 100 gives a percentage, value * 250 turns a 0–1 level into hit points out of 250, and value < 0.3 gives 1 while low and 0 otherwise. A second number from another output is available under the name you give it. You can use + - * / %, comparisons, and/or/not, min(), max() and abs().',
    params: [
      { key: 'expression', label: 'Result', kind: 'expression', default: 'value * 100' },
      { key: 'variable', label: 'Second number’s name', kind: 'name', default: 'other' },
    ],
  },
];

export const opSpec = (op: string) => OPS.find(s => s.op === op);

export const newStep = (spec: OpSpec): FlowStep =>
  ({ op: spec.op, params: Object.fromEntries(spec.params.map(p => [p.key, p.default])) });

// Graph node ID of an output's step
export const stepNode = (output: string, step: number) => `${output}.${step + 1}`;

export interface GraphNode { id: string; op: string; inputs: string[]; params: Record<string, unknown> }

export interface FlowProblem { output: string; step?: number; message: string }

export interface CompiledFlow {
  nodes: GraphNode[];
  display: string;   // node holding the image shown on the live view
  types: Map<string, FlowType | null>;
  recorded: { name: string; type: FlowType; output: string }[];
  problems: FlowProblem[];
}

const hex = (color: string) => parseInt(color.slice(1), 16);

// The live view publishes its display image as "annotated", or as "frame" with no model
export const RESERVED_NAMES = ['annotated', 'frame'];

// Where a flow's outputs can start from: a graph node and what it holds
export interface FlowRoot { node: string; type: FlowType }

// roots names the sources a flow starts from ('mask' for a model, 'region' for a region).
// names holds the observation names already taken, so flows compiled into one graph don't clash.
export function compileFlow(
  flow: Flow, roots: Record<string, FlowRoot>, frame: string, names = new Set<string>(RESERVED_NAMES),
): CompiledFlow {
  const byId = new Map(flow.outputs.map(o => [o.id, o]));
  const results = new Map<string, { node: string; type: FlowType | null }>();
  const visiting = new Set<string>();
  const nodes: GraphNode[] = [];
  const problems: FlowProblem[] = [];

  const result = (id: string, user: string): { node: string; type: FlowType | null } => {
    if (Object.prototype.hasOwnProperty.call(roots, id)) return roots[id];
    const done = results.get(id);
    if (done) return done;
    const o = byId.get(id);
    if (!o) {
      problems.push({ output: user, message: 'Uses an output that no longer exists' });
      return { node: '', type: null };
    }
    if (visiting.has(id)) {
      problems.push({ output: user, message: `“${o.name}” and “${byId.get(user)?.name}” use each other in a loop` });
      return { node: '', type: null };
    }
    visiting.add(id);
    let current = result(o.from, id);
    // A step with a problem is left out, and so is everything after it
    o.steps.forEach((step, i) => {
      const spec = opSpec(step.op);
      let ok = true;
      const problem = (message: string) => { problems.push({ output: id, step: i, message }); ok = false; };
      if (!spec) { problem(`Unknown step “${step.op}”`); current = { node: '', type: null }; return; }
      const inputs = [current.node];
      if (current.type && !accepts(spec, current.type))
        problem(`${spec.label} needs ${inputTypes(spec).map(t => TYPE_NOUN[t]).join(' or ')}, but gets ${TYPE_NOUN[current.type]}`);
      if (spec.with && step.with) {
        const other = result(step.with, id);
        if (other.type && other.type !== spec.with.type)
          problem(`“${spec.with.label}” must be an output of ${TYPE_NOUN[spec.with.type]}`);
        inputs.push(other.node);
      } else if (spec.with && !spec.with.optional)
        problem(`Choose an output for “${spec.with.label}”`);
      const params: Record<string, number | string> = {};
      for (const p of spec.params) {
        if (p.key === 'variable' && !step.with) continue;
        params[p.key] = step.params[p.key] ?? p.default;
        if (p.kind === 'color' && !HEX_COLOR.test(String(params[p.key]))) problem(`${p.label} must look like #ff0000`);
      }
      const node = ok && inputs.every(Boolean) ? stepNode(id, i) : '';
      if (node) {
        const run = spec.native ? spec.native(params) : { op: spec.op, params };
        nodes.push({ id: node, op: run.op, inputs, params: run.params });
      }
      current = { node, type: spec.output };
    });
    visiting.delete(id);
    results.set(id, current);
    return current;
  };

  const types = new Map<string, FlowType | null>();
  for (const o of flow.outputs) types.set(o.id, result(o.id, o.id).type);

  let display = frame;
  const recorded: CompiledFlow['recorded'] = [];
  for (const o of flow.outputs) {
    const { node, type } = results.get(o.id)!;
    if (!node || !type) continue;
    if (o.show && (type === 'mask' || type === 'shapes')) {
      const id = `draw.${o.id}`;
      nodes.push(type === 'shapes'
        ? { id, op: 'draw_shapes', inputs: [display, node], params: { color: o.color, thickness: flow.thickness, label: o.label, style: 'auto' } }
        : { id, op: 'draw_contours', inputs: [display, node], params: { r: hex(o.color) >> 16, g: (hex(o.color) >> 8) & 0xff, b: hex(o.color) & 0xff, thickness: flow.thickness } });
      display = id;
    }
    if (o.record && type !== 'mask' && type !== 'image') {
      if (names.has(o.name)) { problems.push({ output: o.id, message: `Another output is already recorded as “${o.name}”` }); continue; }
      names.add(o.name);
      nodes.push({ id: `record.${o.id}`, op: 'publish', inputs: [node], params: { name: o.name } });
      recorded.push({ name: o.name, type, output: o.id });
    }
  }
  return { nodes, display, types, recorded, problems };
}

// ── Templates ────────────────────────────────────────────────────────────────

const output = (o: Partial<FlowOutput> & Pick<FlowOutput, 'id' | 'name' | 'from' | 'steps'>): FlowOutput =>
  ({ record: false, show: false, color: '#00ff00', label: '', ...o });

const step = (op: string, params: FlowStep['params'] = {}, withOutput?: string): FlowStep => {
  const spec = opSpec(op)!;
  return { op, params: { ...newStep(spec).params, ...params }, ...(withOutput ? { with: withOutput } : {}) };
};

export interface FlowTemplate { id: string; label: string; description: string; build(): Flow }

export const TEMPLATES: FlowTemplate[] = [
  {
    id: 'objects', label: 'Objects',
    description: 'Every blob the model marks, with its box, centre and size, plus how many there are.',
    build: () => ({
      version: 1, thickness: 2,
      outputs: [
        output({ id: 'objects', name: 'objects', from: 'mask', record: true, show: true,
          steps: [step('morph', { operation: 'open' }), step('components', { minArea: 20 })] }),
        output({ id: 'objectCount', name: 'object count', from: 'objects', record: true, steps: [step('count')] }),
      ],
    }),
  },
  {
    id: 'platformer', label: 'Platforms & ladders',
    description: 'Walkable platform segments and ladders/ropes for side-scrollers, tuned for masks drawn like the wz extractor’s: 24 px platform bands with the walking line 6 px from the top, 44 px ladders, 10 px ropes.',
    build: () => platformer('#00ff00', '#ffd600'),
  },
  {
    id: 'outline', label: 'Mask outline',
    description: 'Only outlines what the model marks on the live view.',
    build: () => ({ version: 1, thickness: 2, outputs: [output({ id: 'mask', name: 'mask', from: 'mask', show: true, steps: [] })] }),
  },
];

// Ladders are tall runs shaped like strips, taller than a stack of two
// platform bands unless the frame edge cuts them off. Platforms are what's
// left, traced along the walking line and rejoined where a ladder crossed them.
export function platformer(platformColor: string, ladderColor: string): Flow {
  return {
    version: 1, thickness: 2,
    outputs: [
      output({ id: 'clean', name: 'clean mask', from: 'mask', steps: [step('morph', { operation: 'close', width: 3, height: 5 })] }),
      output({ id: 'band', name: 'band height', from: 'clean', steps: [step('run_length', { direction: 'vertical', max: 40 })] }),
      output({ id: 'ladderRegions', name: 'ladder regions', from: 'clean', steps: [
        step('runs', { direction: 'vertical', min: 41 }),
        step('components'),
        step('filter', {
          variable: 'band',
          expression: 'meanWidth >= 4 and meanWidth <= 80 and fill >= 0.65 and ((touchesTop or touchesBottom) and height >= meanWidth or height >= max(48, 2.5 * band) and height >= 1.8 * meanWidth)',
        }, 'band'),
      ] }),
      output({ id: 'ladderMask', name: 'ladder mask', from: 'ladderRegions', steps: [step('rasterize')] }),
      output({ id: 'platformLines', name: 'platform lines', from: 'clean', steps: [
        step('combine', { operation: 'subtract' }, 'ladderMask'),
        step('trace', { position: 0.25, maxStep: 8, maxGap: 3, stack: 1.5, maxBand: 40 }, 'band'),
        step('join', { maxGap: 80, maxRise: 20 }, 'ladderMask'),
        step('filter', { expression: 'length >= 24 and band >= 4' }),
      ] }),
      output({ id: 'platforms', name: 'platforms', from: 'platformLines', record: true, show: true, color: platformColor, label: 'P',
        steps: [step('simplify', { smooth: 4, epsilon: 3 }), step('segments', { rowHeight: 16 })] }),
      output({ id: 'ladders', name: 'ladders', from: 'ladderRegions', record: true, show: true, color: ladderColor, label: 'L',
        steps: [step('axis_line', { direction: 'vertical' }), step('snap', { tolerance: 20, reach: 25 }, 'platformLines')] }),
    ],
  };
}

// ── Region templates ─────────────────────────────────────────────────────────
// Values read from the pixels of a region. Most look for a colour in the box; two read its text.

export interface RegionTemplate {
  id: string;
  label: string;
  description: string;
  result: FlowType;    // what the value it adds is
  usesColor: boolean;  // it looks for a colour, so the box is sampled for the one to start from
  // The outputs to add: newId makes an ID unique to the region, name is what the value is called
  build(newId: () => string, name: string, color: string): FlowOutput[];
}

export const REGION_TEMPLATES: RegionTemplate[] = [
  {
    id: 'bar', label: 'Bar level', result: 'number', usesColor: true,
    description: 'How full a bar or gauge is, from 0 to 1, by how far its colour reaches across the box.',
    build: (newId, name, color) => [output({ id: newId(), name, from: 'region', record: true, steps: [
      step('color', { color }), step('morph', { operation: 'close', width: 3, height: 3 }), step('reach', { from: 'left' })] })],
  },
  {
    id: 'amount', label: 'Colour amount', result: 'number', usesColor: true,
    description: 'How much of the box is one colour, from 0 to 1.',
    build: (newId, name, color) => [output({ id: newId(), name, from: 'region', record: true, steps: [
      step('color', { color }), step('coverage')] })],
  },
  {
    id: 'present', label: 'Colour present', result: 'number', usesColor: true,
    description: '1 while the colour shows in the box and 0 when it doesn’t, such as a buff icon or an open window.',
    build: (newId, name, color) => [output({ id: newId(), name, from: 'region', record: true, steps: [
      step('color', { color }), step('coverage'), step('calculate', { expression: 'value > 0.02' })] })],
  },
  {
    id: 'text', label: 'Text (OCR)', result: 'text', usesColor: false,
    description: 'The text written in the box, read with Windows’ text recognition: a map name, a quest, a line of dialogue.',
    build: (newId, name) => [output({ id: newId(), name, from: 'region', record: true, steps: [step('ocr')] })],
  },
  {
    id: 'number-text', label: 'Number (OCR)', result: 'number', usesColor: false,
    description: 'A number written in the box, such as a level, a score or an amount of money, read with text recognition.',
    build: (newId, name) => [output({ id: newId(), name, from: 'region', record: true, steps: [step('ocr'), step('number_in_text')] })],
  },
];

// The most common clearly coloured colour in RGBA pixel data, as #rrggbb, or null when
// there is only grey and dark: a good first guess at what to look for in a box
export function dominantColor(rgba: ArrayLike<number>): string | null {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 60 || max - min < 60) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  if (!best) return null;
  const hexByte = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, '0');
  return `#${hexByte(best.r)}${hexByte(best.g)}${hexByte(best.b)}`;
}
