"""How recorded observations become the numbers a policy sees, the same way in training and in play.

Numbers, true/false values and vectors are taken as they are; images and text are left out. Everything
else is made by the user's formulas (formulas.py), such as the distance from the player to an enemy or the
shape below the player, and, for datasets from before formulas, by derived values (DERIVED_KINDS). A
dataset puts each recording on one fixed time step (on_grid), so earlier steps mean the same time ago in
every recording and in play. Nothing here knows any game.
"""
import bisect
import json
import math
import time
from bisect import bisect_left

from formulas import FormulaSet, Missing, bare_name, columns_of
from shapes import GRID_MODES, count_within, finite, grid_values, lines_of, nearest
import spatial as spatial_
import planner as planner_
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


# A Goal's target while a dataset is made: where the player got to a little later, filled in by the dataset (see
# Featurizer.goal and Worker._rows) after the rest of a row is worked out
HINDSIGHT = object()


# Following a route: the recorded path is searched near where the player last was on it (from a second before to
# three after) and, if nothing there is this near, everywhere (a fall, or a new start). Searching everywhere, the
# route is rejoined at the nearest point not above the player (ROUTE_STEP px allowed, for steps and slopes): a player
# can walk or drop to one but not rise to it, and the nearest point overhead (pressing Play on a floor the route
# doesn't go along) gave a goal straight up, further than any it trained on, and it stood still
ROUTE_NEAR = 60
ROUTE_STEP = 40
ROUTE_BEHIND_MS, ROUTE_AHEAD_MS = 1000, 3000


def route_point(path, times, position, last):
    """Where the player is along a route (path: [[ms, x, y], ...] in order, times its ms): the index of the nearest
    point, looked for near `last` first (so a route passing a place twice keeps to the pass the player is on), else
    the nearest not above the player, else the nearest."""
    px, py = position

    def away(i):
        return math.hypot(path[i][1] - px, path[i][2] - py)

    if last is not None:
        lo = bisect.bisect_left(times, times[last] - ROUTE_BEHIND_MS)
        hi = bisect.bisect_right(times, times[last] + ROUTE_AHEAD_MS)
        near = min(range(lo, hi), key=away)
        if away(near) <= ROUTE_NEAR:
            return near
    level = [i for i in range(len(path)) if path[i][2] >= py - ROUTE_STEP]
    return min(level or range(len(path)), key=away)


def level_key(value):
    """A Level observation's value as the key places are kept under: numbers alike whether read as 3 or 3.0."""
    if value is None:
        return None
    if isinstance(value, bool):
        return str(value)
    if finite(value):
        return repr(float(value))
    return value if isinstance(value, str) else json.dumps(value, sort_keys=True)


PLAN_DESTINATIONS = ('point', 'input', 'end', 'place')


def goal_names(g):
    """A Goal's columns: the way to its target, forward (positive ahead) with facing, else dx; dy; and how far; and
    with `hint`, the plan's next move: per button whether the next move uses it (next.<button>), then how many px
    along the way until one does (soon.<button>)."""
    hint = (g.get('hint') or {}).get('buttons') or []
    return ([f"{g['name']}.forward" if 'facing' in g else f"{g['name']}.dx", f"{g['name']}.dy", f"{g['name']}.dist"]
            + [f"{g['name']}.next.{b}" for b in hint] + [f"{g['name']}.soon.{b}" for b in hint])


def no_hint(g):
    """A hint with no plan to go on: no key next, none soon."""
    hint = (g.get('hint') or {}).get('buttons') or []
    return [0.0] * len(hint) + [float(planner_.HINT_CAP)] * len(hint)


def goal_numbers(g, position, target, facing_left=None):
    """The way from position to target as a Goal's columns, no further than the farthest its training went (`cap`):
    a target farther than any it learned on reads as far, the same way, and comes into reach as the player nears."""
    dx, dy = float(target[0]) - float(position[0]), float(target[1]) - float(position[1])
    dist = math.hypot(dx, dy)
    cap = g.get('cap')
    if cap and dist > cap:
        dx, dy, dist = dx * cap / dist, dy * cap / dist, float(cap)
    return [-dx if facing_left else dx, dy, dist]


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

    def __init__(self, schema, anchor=None, surface='below', near_px=NEAR_PX, columns=None, derived=None, formulas=None, grids=None, spatial=None, goal=None):
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
        # Spatial nodes: how shapes lie around a point (spatial.py), from an observation or a formula
        booleans = {f['name'] for f in schema['fields'] if f['type'] == 'boolean'} | {e['name'] for e in self.formulas.ok() if e['type'] == 'boolean'}
        self.spatial = [spatial_.checked(s, fields, vectors, booleans) for s in (spatial or [])]
        for s in self.spatial:
            self.items.append({'label': s['name'], 'kind': 'spatial', 'type': 'spatial', 'spatial': s,
                               'names': spatial_.field_columns(s['name'], [e['alias'] for e in s['sets']], s['fields'])})
        # A Goal: the way to a target, from a position; in training the target is where the position got to a little
        # later (hindsight, see Worker._rows), in play what's wired into its Target
        self.goal = self._goal(goal, vectors, booleans, set(fields) | {e['name'] for e in self.formulas.ok()}) if goal else None
        if self.goal:
            self.items.append({'label': self.goal['name'], 'kind': 'goal', 'type': 'goal', 'goal': self.goal, 'names': goal_names(self.goal)})
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
            if item['kind'] in ('grid', 'goal'):
                grid_columns |= set(range(offset, offset + len(item['names'])))
            offset += len(item['names'])
        self.size = len(self.keep)
        # Earlier steps are shown for every value but the grids and the goal: the layout changes slowly, and a grid's
        # cells times the earlier steps would soon be more inputs than there's data for; a goal is the moment's own
        self.history_keep = [i for i, column in enumerate(self.keep) if column not in grid_columns]
        # Where each of the goal's columns is among those kept, for filling in its hindsight target
        names = self.names()
        self.goal_slots = [names.index(n) if n in names else None for n in goal_names(self.goal)] if self.goal else []

    @staticmethod
    def _goal(g, vectors, booleans, names=frozenset()):
        name = str(g.get('name', '')).strip() if isinstance(g, dict) else ''
        if not name or len(name) > 60 or '@' in name:
            raise ValueError('Name the Goal (up to 60 characters, without @)')
        if g.get('position') not in vectors:
            raise ValueError(f'{name}: wire a position into Position, such as the player’s, a vector state or formula')
        if g.get('facing') is not None and g['facing'] not in booleans:
            raise ValueError(f'{name}: Facing is true or false (true facing left)')
        if g.get('target') is not None and g['target'] not in vectors:
            raise ValueError(f'{name}: Target is a position, a vector state or formula')
        look = g.get('lookAhead', [1, 4])
        if not (isinstance(look, list) and len(look) == 2 and all(finite(v) and 0.1 <= v <= 30 for v in look) and look[0] <= look[1]):
            raise ValueError(f'{name}: look ahead 0.1..30 s, the shortest first')
        targets, move = g.get('targets', 3), g.get('minMove', 20)
        if type(targets) is not int or not 1 <= targets <= 8:
            raise ValueError(f'{name}: 1..8 targets for each moment')
        if not (finite(move) and 0 <= move <= 10000):
            raise ValueError(f'{name}: moved at least 0..10000 px')
        spec = {'name': name, 'position': g['position'], 'lookAhead': [float(look[0]), float(look[1])], 'targets': targets, 'minMove': move}
        for key in ('facing', 'target'):
            if g.get(key) is not None:
                spec[key] = g[key]
        # Play following a route: where the player went in a recording (route.recording), aiming aheadS seconds along
        # it from where the player is; its path ([ms, x, y] by time) is worked out when it trains, and kept with it
        route = g.get('route')
        if route is not None:
            if 'target' in spec:
                raise ValueError(f'{name}: play follows a route or goes to its Target, not both')
            if not (isinstance(route, dict) and isinstance(route.get('recording'), str) and route['recording']
                    and finite(route.get('aheadS')) and 0.1 <= route['aheadS'] <= 30):
                raise ValueError(f'{name}: a route is a recording, and how far along it to aim (0.1..30 s)')
            spec['route'] = {'recording': route['recording'], 'aheadS': float(route['aheadS'])}
            path = g.get('path')
            if path is not None:
                if not (isinstance(path, list) and len(path) >= 2 and all(
                        isinstance(p, list) and len(p) == 3 and all(finite(v) for v in p) for p in path)):
                    raise ValueError(f'{name}: its route is a list of [ms, x, y]')
                spec['path'] = path
        # Play planned over a map (planner.py; src/mapModel.ts): toward a destination (a place of the map, a point, a
        # position wired in, or where a recording ended), aiming aheadS seconds along the quickest of the map's links
        # and the moves it learned on a grid; the places and moves (`graph`) are worked out when it trains or plays
        # (Worker._learn_plan), and kept with it. Versions from before maps planned on a grid of their own, learned
        # from `recordings` (else the policy's), with a Level observation's name in `level`: they still play
        plan = g.get('plan')
        if plan is not None and isinstance(plan, dict) and isinstance(plan.get('map'), dict):
            if 'target' in spec or 'route' in spec:
                raise ValueError(f'{name}: play plans, follows a route or goes to its Target: one of them')
            m, dest = plan['map'], plan.get('destination')
            if not (finite(plan.get('aheadS')) and 0.1 <= plan['aheadS'] <= 30):
                raise ValueError(f'{name}: aim 0.1..30 s ahead along its map')
            if not (isinstance(m.get('position'), str) and m['position'].strip()):
                raise ValueError(f'{name}: its map needs the player’s position: open the map and say where the player is')
            places = {p['id']: p for p in m.get('places') or [] if isinstance(p, dict) and isinstance(p.get('id'), str)}
            if not (isinstance(dest, dict) and dest.get('kind') in PLAN_DESTINATIONS):
                raise ValueError(f'{name}: choose where play heads: a place of its map, a position wired in, or where a recording ended')
            if dest['kind'] == 'place' and dest.get('place') not in places:
                raise ValueError(f'{name}: choose the place of its map play heads for' + (' (the one chosen was taken off the map)' if dest.get('place') else ''))
            if dest['kind'] == 'point' and not (finite(dest.get('x')) and finite(dest.get('y'))):
                raise ValueError(f'{name}: choose where play heads')
            if dest['kind'] == 'input' and dest.get('name') not in vectors:
                raise ValueError(f'{name}: wire a position into its Destination')
            if dest['kind'] == 'end' and not (isinstance(dest.get('recording'), str) and dest['recording']):
                raise ValueError(f'{name}: choose the recording whose end play heads for')
            grid = m.get('grid')
            if grid is not None and not (isinstance(grid, dict) and finite(grid.get('cell')) and 8 <= grid['cell'] <= 400):
                raise ValueError(f'{name}: its map learns places 8..400 px a side')
            if not places and grid is None:
                raise ValueError(f'{name}: its map has no places: add some, or have it learn a grid from recordings')
            spec['plan'] = {'map': {k: m.get(k) for k in ('id', 'name', 'position', 'level', 'reach', 'places', 'links', 'grid')},
                            'aheadS': float(plan['aheadS']),
                            'destination': {k: v for k, v in dest.items() if k in ('kind', 'x', 'y', 'name', 'recording', 'level', 'place')},
                            **({'graph': plan['graph']} if isinstance(plan.get('graph'), dict) else {})}
        elif plan is not None:
            if 'target' in spec or 'route' in spec:
                raise ValueError(f'{name}: play plans, follows a route or goes to its Target: one of them')
            dest = plan.get('destination') if isinstance(plan, dict) else None
            if not (isinstance(plan, dict) and finite(plan.get('cell', planner_.CELL)) and 8 <= plan.get('cell', planner_.CELL) <= 400
                    and finite(plan.get('aheadS')) and 0.1 <= plan['aheadS'] <= 30):
                raise ValueError(f'{name}: a plan has places 8..400 px a side and aims 0.1..30 s ahead')
            if not (isinstance(dest, dict) and dest.get('kind') in PLAN_DESTINATIONS):
                raise ValueError(f'{name}: choose where play heads: a point on the map, a position wired in, or where a recording ended')
            if dest['kind'] == 'point' and not (finite(dest.get('x')) and finite(dest.get('y'))):
                raise ValueError(f'{name}: click the map where play heads')
            if dest['kind'] == 'input' and dest.get('name') not in vectors:
                raise ValueError(f'{name}: wire a position into the planner’s Destination')
            if dest['kind'] == 'end' and not (isinstance(dest.get('recording'), str) and dest['recording']):
                raise ValueError(f'{name}: choose the recording whose end play heads for')
            if plan.get('level') is not None and plan['level'] not in names:
                raise ValueError(f'{name}: its Level, {plan["level"]}, isn’t observed')
            if plan.get('places', 'grid') != 'grid':
                raise ValueError(f'{name}: places along shapes were taken out: its Planner plans on a grid (a behaviour tree’s Go to plans over a map you make)')
            spec['plan'] = {'places': 'grid', 'cell': float(plan.get('cell', planner_.CELL)), 'aheadS': float(plan['aheadS']),
                            'destination': {k: v for k, v in dest.items() if k in ('kind', 'x', 'y', 'name', 'recording', 'level')},
                            **({'level': plan['level']} if plan.get('level') is not None else {}),
                            **({'recordings': list(plan['recordings'])} if plan.get('recordings') else {}),
                            **({'graph': plan['graph']} if isinstance(plan.get('graph'), dict) else {})}
        if 'plan' in spec:
            plan = g['plan']
            # Keep away from: inputs whose shapes the way avoids, as they are each frame (monsters)
            avoid = plan.get('avoid') or []
            if not (isinstance(avoid, list) and all(isinstance(e, dict) and isinstance(e.get('alias'), str) and isinstance(e.get('shapes'), list)
                                                    and all(n in names for n in e['shapes']) for e in avoid)):
                raise ValueError(f'{name}: keep away from the shapes of its Spatial node’s inputs')
            if avoid:
                spec['plan']['avoid'] = [{'alias': e['alias'], 'shapes': list(e['shapes']), **({'read': e['read']} if e.get('read') else {})} for e in avoid]
            spec['plan']['learn'] = plan.get('learn', True) is not False   # from moves that don't happen in play
        # The plan's next move, for the policy: per button of `hint.buttons` (its labels)
        hint = g.get('hint')
        if hint and hint is not True:  # True: asked for, its buttons the policy's (Worker.dataset puts them in)
            buttons = hint.get('buttons') if isinstance(hint, dict) else None
            if not (isinstance(buttons, list) and buttons and all(isinstance(b, str) and b for b in buttons)):
                raise ValueError(f'{name}: the plan’s next move is for the buttons the policy presses')
            spec['hint'] = {'buttons': list(buttons)}
        if g.get('cap') is not None:
            if not (finite(g['cap']) and g['cap'] > 0):
                raise ValueError(f'{name}: the farthest target is a distance')
            spec['cap'] = g['cap']
        return spec

    def route_target(self, position):
        """Where play aims following a route: the point of the path aheadS seconds on from where the player is on it
        (the end, near the end)."""
        g = self.goal
        if getattr(self, '_route_times', None) is None:
            self._route_times = [p[0] for p in g['path']]
            self.route_at = None
        times = self._route_times
        self.route_at = route_point(g['path'], times, position, self.route_at)
        j = min(bisect.bisect_left(times, times[self.route_at] + 1000 * g['route']['aheadS']), len(times) - 1)
        return g['path'][j][1], g['path'][j][2]

    def plan_level(self, values):
        """The level a sample is on: by its map's Level (a State's value as it is, else its formula's), or a plan from
        before maps' Level observation (None without one)."""
        plan = self.goal['plan']
        if 'map' in plan:
            source = (plan['map'].get('level') or '').strip()
            if not source:
                return None
            name = bare_name(source)
            if name is None or name not in self.formulas.fields:
                if getattr(self, '_level_set', None) is None:
                    self._level_set = FormulaSet([{'name': 'level', 'source': source}], [{'name': n, 'type': t} for n, t in self.formulas.fields.items()])
                    if self._level_set.entries['level']['error']:
                        raise ValueError(f'{self.goal["name"]}: its map’s Level: {self._level_set.entries["level"]["error"]}')
                try:
                    v = self._level_set.evaluate('level', [values])
                except Missing:
                    return None
                return level_key(list(v) if isinstance(v, tuple) else v)
        else:
            name = plan.get('level')
            if name is None:
                return None
        item = values.get(name)
        return level_key(item.get('value')) if item and item.get('valid') else None

    def plan_destination(self, values, frames):
        """Where a plan heads, as a point: the one clicked, where a recording ended, or what's wired in now. A point
        on a level (clicked, or where a recording ended, with a Level wired in) is only there on that level."""
        dest = self.goal['plan']['destination']
        if dest['kind'] == 'input':
            v = self._value(dest['name'], values, frames, 'vector')
            return float(v[0]), float(v[1])
        if dest['kind'] == 'place':
            place = next(p for p in self.goal['plan']['map']['places'] if p['id'] == dest['place'])
            dest = {'x': place['x'], 'y': place['y'], 'level': place.get('level')}
        if 'x' not in dest:
            raise Missing(f'{self.goal["name"]}: where its recording ended is worked out when it trains')
        here = self.plan_level(values)
        if dest.get('level') is not None and here is not None and dest['level'] != here:
            raise Missing(f'{self.goal["name"]}: its destination is on another level ({dest["level"]}; you’re on {here})')
        return float(dest['x']), float(dest['y'])

    def plan_planner(self, values, wait=False):
        """The planner for what was learned (one for the whole grid)."""
        if getattr(self, '_planner', None) is None:
            self._planner = planner_.Planner(self.goal['plan']['graph'])
        return self._planner

    def plan_target(self, values, frames, position):
        """Where play aims planning from what the player has done (planner.py)."""
        g = self.goal
        if 'graph' not in g['plan']:
            raise Missing(f'{g["name"]}: its places and moves are learned when it trains')
        self.plan_planner(values)
        planner = self._planner
        level = self.plan_level(values)
        target, way = planner.target(level, position, self.plan_destination(values, frames),
                                     1000 * g['plan']['aheadS'], self.plan_away(values, planner))
        if target is None:
            raise Missing(f'{g["name"]}: no move you’ve made leads from here to its destination')
        self._plan_way = [[round(planner.places[i][1], 1), round(planner.places[i][2], 1)] for i in way[:60]]
        self.plan_attempt(planner, way, g['plan'].get('learn', True))
        if 'hint' in g:
            self._plan_hint = planner.hint(way, g['hint']['buttons'])
        return target

    def plan_away(self, values, planner):
        """Extra time for moves ending near the shapes to keep away from, as they are in this sample (or None)."""
        avoid = self.goal['plan'].get('avoid')
        if not avoid:
            return None
        points = [(float(x), float(y)) for entry in avoid for line, _ in spatial_.shapes_of(self.shapes_of_set(entry, values)) for x, y in line]
        if not points:
            return None
        near = planner_.KEEP_AWAY_PX

        def away(place):
            px, py = planner.places[place][1], planner.places[place][2]
            return planner_.AWAY_MS if any(abs(x - px) <= near and abs(y - py) <= near for x, y in points) else 0.0
        return away

    def plan_attempt(self, planner, way, learn=True):
        """Learning from how moves go: the move the plan makes first is timed from when it's first planned; made (the
        player at its end), what it took is kept for a map's own link; still at its start after twice its usual time
        (and half a second), it failed, and with `learn` costs more from then on (Planner.penalize), so the way round
        it is planned if there's one. A map's own links' outcomes go in map_outcomes, for its stats."""
        now = time.monotonic() * 1000
        attempt = getattr(self, '_attempt', None)
        if attempt is not None and attempt[0] is planner and way and way[0] == attempt[2]:
            self._outcome(planner, attempt[1], attempt[2], True, now - attempt[3])
            attempt = self._attempt = None
        if not way or len(way) < 2:
            self._attempt = None
            return
        a, b = way[0], way[1]
        if attempt is None or attempt[0] is not planner or attempt[1:3] != (a, b):
            self._attempt = (planner, a, b, now)
            return
        ms = planner.edges.get((a, b), (0, ()))[0]
        if now - attempt[3] > 2 * ms + 500:
            if learn:
                planner.penalize(a, b)
            self._outcome(planner, a, b, False, now - attempt[3])
            self._attempt = None

    def _outcome(self, planner, a, b, worked, ms):
        lid, plan = planner.link_of.get((a, b)), self.goal['plan']
        if lid is not None and 'map' in plan:
            self.__dict__.setdefault('map_outcomes', []).append((plan['map'].get('id'), lid, worked, round(ms, 1)))

    def plan_hint(self, values, position, target):
        """The plan's next move toward a target (a hindsight one, in training): its planner, the level's made at once."""
        g = self.goal
        if 'plan' not in g or 'graph' not in g['plan']:
            return no_hint(g)
        try:
            planner = self.plan_planner(values, wait=True)
        except Missing:
            return no_hint(g)
        level = self.plan_level(values)
        start, goal = planner.place_at(level, *position), planner.place_at(level, *target)
        way = planner.path(start, goal) if start is not None and goal is not None else None
        return planner.hint(way, g['hint']['buttons']) if way else no_hint(g)

    def goal_origin(self, values, frames):
        """Where a sample's Goal is measured from, and which way it faces (None without facing)."""
        g = self.goal
        position = self._value(g['position'], values, frames, 'vector')
        facing = self._value(g['facing'], values, frames, 'boolean') if 'facing' in g else None
        return (float(position[0]), float(position[1])), facing

    def goal_values(self, values, frames, target=None):
        """A Goal's columns: toward `target`, else (in play) toward what's wired into its Target; with HINDSIGHT
        none yet, to be filled in once the dataset knows where the player got to (Worker._rows)."""
        if target is HINDSIGHT:
            return [0.0, 0.0, 0.0] + no_hint(self.goal)
        g = self.goal
        position, facing = self.goal_origin(values, frames)
        if target is None:
            self.heading = None
            if 'plan' in g:
                target = self.plan_target(values, frames, position)
            elif 'path' in g:
                target = self.route_target(position)
            elif 'route' in g:
                raise Missing(f'{g["name"]}: its route is worked out when it trains')
            elif 'target' not in g:
                raise Missing(f'{g["name"]} has no target: wire a position into its Target')
            else:
                target = self._value(g['target'], values, frames, 'vector')
            # where play is heading, for the banner: what it aims at this frame, how far, and from what
            self.heading = {'kind': 'plan' if 'plan' in g else 'route' if 'path' in g else 'target',
                            'x': round(float(target[0]), 1), 'y': round(float(target[1]), 1),
                            'distance': round(math.hypot(float(target[0]) - position[0], float(target[1]) - position[1]), 1),
                            **({'map': g['plan']['map'].get('id'), 'way': self._plan_way, 'at': [round(position[0], 1), round(position[1], 1)]}
                               if 'plan' in g and 'map' in g['plan'] else {})}
            hint = self._plan_hint if 'plan' in g and 'hint' in g else no_hint(g)
            return goal_numbers(g, position, target, facing) + hint
        # a target given (a hindsight one, by Worker._rows): the plan's next move toward it
        return goal_numbers(g, position, target, facing) + (self.plan_hint(values, position, target) if 'hint' in g else [])

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

    def _value(self, name, values, frames, kind):
        """An observation's or a formula's value for a sample, as a Spatial node's point (vector) or facing."""
        if name in self.formulas.entries:
            value = self.formulas.evaluate(name, frames)
        else:
            item = values.get(name)
            if not item or not item.get('valid'):
                raise Missing(f'{name} isn’t found')
            value = item.get('value')
        if kind == 'vector' and not (isinstance(value, (list, tuple)) and len(value) >= 2 and finite(value[0]) and finite(value[1])):
            raise Missing(f'{name} isn’t a position')
        if kind == 'boolean' and type(value) is not bool:
            raise Missing(f'{name} isn’t true or false')
        return value

    def spatial_values(self, s, values, frames):
        """A Spatial node's columns for a sample. A set that isn't there (its State not read this frame) is
        empty, as nothing near; the point, or facing, not being there raises Missing."""
        point = self._value(s['point'], values, frames, 'vector')
        facing = self._value(s['facing'], values, frames, 'boolean') if 'facing' in s else None
        out = []
        for entry in s['sets']:
            own = [f for f in s['fields'] if spatial_.applies(f, entry['alias'])]
            out += spatial_.evaluate(self.shapes_of_set(entry, values), (float(point[0]), float(point[1])), facing,
                                     own, s['maxDistance'])[0]
        return out

    @classmethod
    def shapes_of_set(cls, entry, values):
        """A Spatial node input's shapes, read as it says (spatial.read_as: a script's {x, y, w, h} as its box)."""
        return spatial_.read_as(cls.shapes_in(entry['shapes'], values), entry.get('read', 'point'))

    @staticmethod
    def shapes_in(names, values):
        """Every shape of these observations together; one that isn't there adds none."""
        items = []
        for name in names:
            item = values.get(name)
            if item and item.get('valid') and isinstance(item.get('value'), list):
                items += item['value']
        return items

    def spatial_picture(self, s, values, frames):
        """What a Spatial node draws for a sample (spatial.picture)."""
        point = self._value(s['point'], values, frames, 'vector')
        facing = self._value(s['facing'], values, frames, 'boolean') if 'facing' in s else None
        item = values.get(s['bounds']) if 'bounds' in s else None
        bounds = item.get('value') if item and item.get('valid') else None  # shapes, or a table (spatial.box_of)
        return spatial_.picture([(e['alias'], self.shapes_of_set(e, values)) for e in s['sets']],
                                (float(point[0]), float(point[1])), facing, s['fields'], bounds, s['maxDistance'])

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
                 'formula': item['kind'] == 'formula', 'grid': item['kind'] == 'grid', 'spatial': item['kind'] == 'spatial',
                 'columns': item['names']} for item in self.items]

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
        return {'anchor': None, 'derived': self.derived, 'formulas': self.formula_sources, 'grids': self.grids, 'spatial': self.spatial,
                'goal': self.goal, 'columns': self.columns,
                'inputs': [{'name': item['label'], 'type': item['type'], 'size': len(item['names'])} for item in self.items]}

    def __call__(self, observations, past=(), goal=None):
        """The numbers for a sample. past[k-1] is the sample k grid steps earlier (its observations), or
        None where there's none, for formulas that look back (x[-k]). goal: the Goal's target, HINDSIGHT while a dataset
        is made, or None for what's wired into its Target (play)."""
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
            elif item['kind'] == 'spatial':
                result.extend(self.spatial_values(item['spatial'], values, frames))
            elif item['kind'] == 'goal':
                result.extend(self.goal_values(values, frames, goal))
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
