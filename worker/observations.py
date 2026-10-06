"""How recorded observations become the numbers a policy sees, the same way in training and in play.

Numbers, true/false values and vectors are taken as they are; images and text are left out. Everything
else is made by the user's formulas (formulas.py), such as the distance from the player to an enemy or the
shape below the player, and, for datasets from before formulas, by derived values (DERIVED_KINDS). A
dataset puts each recording on one fixed time step (on_grid), so earlier steps mean the same time ago in
every recording and in play. Nothing here knows any game.
"""
import math
from bisect import bisect_left

from formulas import FormulaSet, Missing, columns_of
from shapes import GRID_MODES, count_within, finite, grid_values, lines_of, nearest
from shapes import surface as surface_of

SURFACES = ('below', 'above', 'off')  # which surface relative() measures, if any
NEAR_PX = 200        # by default, shapes this close to the anchor are counted
MAX_INPUTS = 1024    # numbers a policy can see, over all the samples it's shown at once


def relative_size(surface='below'):
    """How many numbers relative() gives for a shapes observation."""
    return 10 if surface == 'off' else 14


def relative_names(surface='below'):
    """What each number relative() gives is, in order."""
    names = [f'{place}.{part}' for place in ('nearest', 'left', 'right') for part in ('dx', 'dy', 'found')]
    if surface != 'off':
        names += [f'{surface}.found', f'{surface}.dy', f'{surface}.leftEnd', f'{surface}.rightEnd']
    return names + ['nearCount']


def relative(items, anchor, surface='below', near_px=NEAR_PX):
    """What a list of shapes says about the anchor's surroundings, as relative_size(surface) numbers:
    the nearest point of any shape, of any to the left and of any to the right (each dx, dy and whether
    there is one); unless surface is 'off', the shape directly below (or above) the anchor (whether
    there is one, how far down or up, and how far its left and right ends are: in a side-view game, the
    edges of the platform stood on); and how many shapes are within near_px. Screen y is down, so below
    is positive dy."""
    lines = lines_of(items)
    out = []
    for side in (0, -1, 1):
        q = nearest(lines, anchor, side)
        out += [q[0] - anchor[0], q[1] - anchor[1], 1.0] if q else [0.0, 0.0, 0.0]
    if surface != 'off':
        found = surface_of(lines, anchor, 1 if surface == 'below' else -1)
        out += [1.0, *found] if found else [0.0, 0.0, 0.0, 0.0]
    out.append(float(count_within(lines, anchor, near_px)))
    return out


# Values made from two observations, chosen when a dataset is made: how far one position is from
# another, where it is relative to it, how two numbers differ, or which shapes are near a position.
# Each needs its two operands, `a` and `b`, of these types.
DERIVED_KINDS = {'offset': ('vector', 'vector'), 'distance': ('vector', 'vector'),
                 'difference': ('number', 'number'), 'shapes': ('vector', 'shapes')}


def derived_names(d):
    """The names of the values a derived definition gives, in order."""
    if d['kind'] == 'offset':
        return [f"{d['name']}.dx", f"{d['name']}.dy"]
    if d['kind'] == 'shapes':
        return [f"{d['name']}.{part}" for part in relative_names(d.get('surface', 'below'))]
    return [d['name']]


def _frame(observations):
    """A sample's observations by name (None stays None: no sample there)."""
    if observations is None or isinstance(observations, dict):
        return observations
    return {o['name']: o for o in observations}


class Featurizer:
    """Turns one sample's observations into a fixed list of numbers, by the observation schema.

    The numbers are every number, true/false value and vector observed, then the derived values (see
    DERIVED_KINDS), then the formulas' (see formulas.py). `columns`, if given, are the only numbers made
    (by name, see names()): an observation none of them comes from isn't read at all, so its being
    invalid doesn't cost a sample. An `anchor` (a vector, from before derived values existed) stands for
    "shapes near the anchor" for every shapes observation, named after it.

    A value that isn't there (an observation not found, a formula with nothing to work on) raises
    Missing, and that sample is skipped.
    """

    def __init__(self, schema, anchor=None, surface='below', near_px=NEAR_PX, columns=None, derived=None, formulas=None, grids=None):
        fields = {f['name']: f for f in schema['fields']}
        self.anchor, self.surface, self.near_px = anchor, surface, near_px
        if anchor is not None and (anchor not in fields or fields[anchor]['type'] != 'vector'):
            raise ValueError('The anchor must be a vector observation, such as a followed region’s Position')
        if derived is None and anchor is not None:
            derived = [{'name': f['name'], 'kind': 'shapes', 'a': anchor, 'b': f['name'], 'surface': surface, 'nearPx': near_px}
                       for f in schema['fields'] if f['type'] == 'shapes']
        self.derived = [self._checked(d, fields) for d in (derived or [])]
        self.formulas = FormulaSet(formulas, schema['fields'])
        if self.formulas.errors():
            raise ValueError('Fix the formulas first: ' + '; '.join(self.formulas.errors()[:3]))
        self.formula_sources = [{'name': e['name'], 'source': e['source'], **({'inputs': e['inputs']} if e['inputs'] else {})}
                                for e in self.formulas.ok()]
        self.depth = self.formulas.depth  # how many grid steps back the formulas look
        # What there is to make, each with the numbers it gives (names)
        self.items = []
        for f in schema['fields']:
            if f['type'] in ('number', 'boolean'):
                self.items.append({'label': f['name'], 'kind': 'observation', 'type': f['type'], 'names': [f['name']]})
            elif f['type'] == 'vector':
                size = f.get('size', 2)
                names = [f"{f['name']}.x", f"{f['name']}.y"] if size == 2 else [f"{f['name']}.{i}" for i in range(size)]
                self.items.append({'label': f['name'], 'kind': 'observation', 'type': 'vector', 'names': names})
        for d in self.derived:
            self.items.append({'label': d['name'], 'kind': 'derived', 'type': d['kind'], 'names': derived_names(d), 'derived': d})
        for e in self.formulas.ok():
            self.items.append({'label': e['name'], 'kind': 'formula', 'type': e['type'], 'names': e['columns']})
        # Grids: a shapes observation as cells over the whole screen, or centred on a position (see
        # grid_cells), which can be a vector observation or a vector formula
        vectors = {f['name'] for f in schema['fields'] if f['type'] == 'vector'} | {e['name'] for e in self.formulas.ok() if e['type'] == 'vector'}
        self.grids = [self._grid(g, fields, vectors) for g in (grids or [])]
        for g in self.grids:
            self.items.append({'label': g['name'], 'kind': 'grid', 'type': 'grid', 'grid': g,
                               'names': [f"{g['name']}.r{r}c{c}" for r in range(g['rows']) for c in range(g['cols'])]})
        if not self.items:
            raise ValueError('Nothing here a policy can learn from: record numbers, true/false values or vectors, '
                             'or add a formula, such as the distance from the player to something')
        self.all_names = [n for item in self.items for n in item['names']]
        twice = sorted({n for n in self.all_names if self.all_names.count(n) > 1})
        if twice:
            raise ValueError('Two values are called ' + ', '.join(twice[:3]) + '; rename a formula')
        if columns is None:
            self.columns, self.keep = None, list(range(len(self.all_names)))
        else:
            if not isinstance(columns, list) or not all(isinstance(c, str) for c in columns):
                raise ValueError('Values are chosen by name')
            unknown = [c for c in columns if c not in self.all_names]
            if unknown:
                raise ValueError('Not among the values these recordings give: ' + ', '.join(unknown[:5]))
            chosen = set(columns)
            self.keep = [i for i, n in enumerate(self.all_names) if n in chosen]
            self.columns = [self.all_names[i] for i in self.keep]
            if not self.keep:
                raise ValueError('Choose at least one value')
        kept, offset = set(self.keep), 0
        grid_columns = set()
        for item in self.items:
            item['wanted'] = any(i in kept for i in range(offset, offset + len(item['names'])))
            if item['kind'] == 'grid':
                grid_columns |= set(range(offset, offset + len(item['names'])))
            offset += len(item['names'])
        self.size = len(self.keep)
        # Earlier steps are shown for every value but the grids: the layout changes slowly, and a grid's
        # cells times the earlier steps would soon be more inputs than there's data for
        self.history_keep = [i for i, column in enumerate(self.keep) if column not in grid_columns]

    @staticmethod
    def _grid(g, fields, vectors=frozenset()):
        name = str(g.get('name', '')).strip() if isinstance(g, dict) else ''
        if not name or len(name) > 60 or '@' in name:
            raise ValueError('Name each grid (up to 60 characters, without @)')
        field = fields.get(g.get('shapes'))
        if not field or field['type'] != 'shapes':
            raise ValueError(f'{name}: a grid is made from a shapes observation, such as platforms')
        cols, rows = g.get('cols'), g.get('rows')
        if type(cols) is not int or type(rows) is not int or not 1 <= cols <= 64 or not 1 <= rows <= 64 or cols * rows > 1024:
            raise ValueError(f'{name}: 1..64 columns and rows, at most 1,024 cells')
        mode = g.get('mode', 'coverage')
        if mode not in GRID_MODES:
            raise ValueError(f'{name}: a cell is its coverage or whether anything is there')
        width, height = g.get('width', 1280), g.get('height', 720)
        if not (finite(width) and finite(height) and width >= 16 and height >= 16):
            raise ValueError(f'{name}: the screen is at least 16 px each way')
        spec = {'name': name, 'shapes': g['shapes'], 'cols': cols, 'rows': rows, 'mode': mode, 'width': width, 'height': height}
        # Centred on a position: cols x rows cells of `cell` px around it, moving with it, rather than the screen
        center = g.get('center')
        if center is not None:
            if center not in vectors:
                raise ValueError(f'{name}: a grid is centred on a position: a vector, such as the player’s Position, or a formula giving one')
            cell = g.get('cell', 40)
            if not (finite(cell) and 4 <= cell <= 400):
                raise ValueError(f'{name}: a cell is 4..400 px')
            spec['center'], spec['cell'] = center, cell
        return spec

    def grid_cells(self, g, values, frames):
        """A grid's cells for a sample (values: its observations by name; frames, for a formula centre: it
        and the samples before it). Over the screen, else centred on g['center']: cols x rows cells of
        g['cell'] px around it, so a cell means the same place beside it wherever it is on the screen
        (and on any map). Raises Missing when the shapes, or the centre, aren't there."""
        item = values.get(g['shapes'])
        if not item or not item.get('valid') or not isinstance(item.get('value'), list):
            raise Missing(f'{g["shapes"]} isn’t found')
        lines = lines_of(item['value'])
        if 'center' not in g:
            width, height = self.screen(values, g)
            return grid_values(lines, width, height, g['cols'], g['rows'], g['mode'])
        if g['center'] in self.formulas.entries:
            center = self.formulas.evaluate(g['center'], frames)
        else:
            point = values.get(g['center'])
            if not point or not point.get('valid'):
                raise Missing(f'{g["center"]} isn’t found')
            center = point.get('value')
        if not (isinstance(center, (list, tuple)) and len(center) >= 2 and finite(center[0]) and finite(center[1])):
            raise Missing(f'{g["center"]} isn’t a position')
        width, height = g['cols'] * g['cell'], g['rows'] * g['cell']
        left, top = center[0] - width / 2, center[1] - height / 2
        moved = [[(x - left, y - top) for x, y in line] for line in lines]
        return grid_values(moved, width, height, g['cols'], g['rows'], g['mode'])

    @staticmethod
    def _checked(d, fields):
        if not isinstance(d, dict) or d.get('kind') not in DERIVED_KINDS:
            raise ValueError('A derived value is an offset, a distance, a difference or shapes near a position')
        name = d.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 60 or '@' in name:
            raise ValueError('Name each derived value (up to 60 characters, without @)')
        for operand, wanted in zip(('a', 'b'), DERIVED_KINDS[d['kind']]):
            field = fields.get(d.get(operand))
            if not field or field['type'] != wanted:
                raise ValueError(f"{name}: {operand.upper()} must be a {wanted} observation")
        out = {'name': name.strip(), 'kind': d['kind'], 'a': d['a'], 'b': d['b']}
        if d['kind'] == 'shapes':
            out['surface'], out['nearPx'] = d.get('surface', 'below'), d.get('nearPx', NEAR_PX)
            if out['surface'] not in SURFACES:
                raise ValueError(f'{name}: measure the surface below or above, or neither')
            if not (type(out['nearPx']) in (int, float) and 1 <= out['nearPx'] <= 5000):
                raise ValueError(f'{name}: count shapes within 1..5000 px')
        return out

    def names(self):
        """A name for each number this makes, in order: an observation's (a vector's are name.x and
        name.y), each derived value's (an offset's name.dx and name.dy, shapes' name.nearest.dx and so
        on, see relative_names), then each formula's (name, or name.x and name.y for a vector)."""
        return [self.all_names[i] for i in self.keep]

    def groups(self):
        """Every value there is to choose from, by the observation, derived value or formula it comes from."""
        return [{'observation': item['label'], 'type': item['type'], 'derived': item['kind'] == 'derived',
                 'formula': item['kind'] == 'formula', 'grid': item['kind'] == 'grid', 'columns': item['names']} for item in self.items]

    def history_names(self):
        """The names of the values shown for earlier steps too: all but the grids'."""
        names = self.names()
        return [names[i] for i in self.history_keep]

    def screen(self, values, g):
        """A grid's screen size: the sample's frame (@frame), else the size the grid was set up for."""
        frame = values.get('@frame') if values else None
        if frame and frame.get('valid') and isinstance(frame.get('value'), list) and len(frame['value']) == 2 and all(finite(v) and v > 0 for v in frame['value']):
            return float(frame['value'][0]), float(frame['value'][1])
        return float(g['width']), float(g['height'])

    def describe(self):
        return {'anchor': None, 'derived': self.derived, 'formulas': self.formula_sources, 'grids': self.grids, 'columns': self.columns,
                'inputs': [{'name': item['label'], 'type': item['type'], 'size': len(item['names'])} for item in self.items]}

    def __call__(self, observations, past=()):
        """The numbers for a sample. past[k-1] is the sample k grid steps earlier (its observations), or
        None where there's none, for formulas that look back (x[-k])."""
        values = _frame(observations)
        frames = [values, *(_frame(p) for p in past)]

        def get(name, kind):
            item = values.get(name)
            if not item or not item.get('valid'):
                raise Missing(f'{name} isn’t found')
            value = item.get('value')
            if kind == 'number' and not finite(value):
                raise Missing(f'{name} isn’t a number')
            if kind == 'boolean' and type(value) is not bool:
                raise Missing(f'{name} isn’t true or false')
            if kind == 'vector' and not (isinstance(value, list) and all(finite(v) for v in value)):
                raise Missing(f'{name} isn’t a vector')
            if kind == 'shapes' and not isinstance(value, list):
                raise Missing(f'{name} isn’t a list of shapes')
            return value

        result = []
        for item in self.items:
            kind, names = item['type'], item['names']
            if not item['wanted']:
                result.extend([0.0] * len(names))  # left out, so not read
            elif item['kind'] == 'formula':
                result.extend(columns_of(self.formulas.evaluate(item['label'], frames), kind))
            elif item['kind'] == 'grid':
                result.extend(self.grid_cells(item['grid'], values, frames))
            elif item['kind'] == 'observation' and kind in ('number', 'boolean'):
                result.append(float(get(item['label'], kind)))
            elif item['kind'] == 'observation':
                value = get(item['label'], 'vector')
                if len(value) != len(names):
                    raise Missing(f'{item["label"]} has {len(value)} parts, not {len(names)}')
                result.extend(float(v) for v in value)
            else:
                d = item['derived']
                a = get(d['a'], DERIVED_KINDS[kind][0])
                b = get(d['b'], DERIVED_KINDS[kind][1])
                if kind == 'offset':
                    result += [float(b[0]) - float(a[0]), float(b[1]) - float(a[1])]
                elif kind == 'distance':
                    result.append(math.hypot(float(b[0]) - float(a[0]), float(b[1]) - float(a[1])))
                elif kind == 'difference':
                    result.append(float(b) - float(a))
                else:
                    result.extend(relative(b, (float(a[0]), float(a[1])), d['surface'], d['nearPx']))
        result = [result[i] for i in self.keep]
        if not all(math.isfinite(v) for v in result):
            raise Missing('a value isn’t a finite number')
        return result


# The fixed time step. Recordings aim at a rate, but frames arrive when they're ready, so samples aren't
# evenly spaced. A dataset puts each recording on an even grid of one step (the same for every
# recording), so one row earlier, history and x[-k] always mean the same time ago.

MIN_STEP_MS, MAX_STEP_MS = 10, 1000


def suggested_step(timestamp_lists, coverage=0.9):
    """The shortest step at which most grid points (coverage) have a sample of their own, over the
    recordings. It starts from the step most samples were taken at, the mean of the intervals near the
    median one (the median alone is off by the frames' jitter, and a step even 1 ms off drifts away from
    the samples), and grows while too many points would be gaps: detection that falls behind now and then
    leaves them, and a row needs its earlier steps too, so a step matching only the fast stretches loses
    most of a recording. Pauses (over 4 typical intervals) don't count either way."""
    gaps = sorted(b - a for ts in timestamp_lists for a, b in zip(ts, ts[1:]) if b > a)
    if not gaps:
        return round(1000 / 15, 1)
    median = gaps[len(gaps) // 2]
    near = [g for g in gaps if median / 2 <= g <= median * 1.5]
    typical = sum(near) / len(near)
    stretches = []
    for ts in timestamp_lists:
        start = 0
        for i in range(1, len(ts) + 1):
            if i == len(ts) or ts[i] - ts[i - 1] > 4 * typical:
                if i - start > 1:
                    stretches.append(ts[start:i])
                start = i

    def covered(step):
        grids = [on_grid(ts, step) for ts in stretches]
        points = sum(len(g) for g in grids)
        return 1 if not points else sum(i is not None for g in grids for i in g) / points

    step = min(max(round(typical, 1), MIN_STEP_MS), MAX_STEP_MS)
    while step < MAX_STEP_MS and covered(step) < coverage:
        step = min(round(step * 1.05, 1), MAX_STEP_MS)
    return float(step)


def held(timestamps, t, step_ms):
    """Index of the sample at time t: the nearest within half a step of it, or None. Frames arrive a few
    ms early or late, and the nearest one stands for that step; the half-step windows don't overlap, so
    a sample stands for one step at most. timestamps are in order."""
    i, best = bisect_left(timestamps, t - step_ms / 2), None
    while i < len(timestamps) and timestamps[i] < t + step_ms / 2:
        if best is None or abs(timestamps[i] - t) < abs(timestamps[best] - t):
            best = i
        i += 1
    return best


def on_grid(timestamps, step_ms, offset=0.0):
    """A recording's samples on an even grid from its first sample (and `offset` ms later): for each
    grid point, the index of the sample there, or None where there's none (a gap, as when detection fell
    behind)."""
    if not timestamps or timestamps[-1] - timestamps[0] < offset:
        return []
    start = timestamps[0] + offset
    return [held(timestamps, start + n * step_ms, step_ms) for n in range(int((timestamps[-1] - start) // step_ms) + 1)]


def phases(timestamps, step_ms, most=4):
    """How many grids, each a fraction of a step later than the one before, a recording's samples fill:
    samples taken twice as often as the step fill two, so the ones between one grid's points are the
    points of another rather than left out. Every grid is still stepMs apart, as play looks back."""
    gaps = sorted(b - a for a, b in zip(timestamps, timestamps[1:]) if b > a)
    if not gaps:
        return 1
    return max(1, min(most, round(step_ms / gaps[len(gaps) // 2])))
