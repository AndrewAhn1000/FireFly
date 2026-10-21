"""A behaviour tree you build in the Graphs view, run on every frame: nothing in it is about one game.

The tree is {root, nodes: {id: {kind, params, children}}} (src/behaviorModel.ts compiles it from the editor's graph).
Each frame it's ticked from its root, and every node it reaches answers `running`, `success` or `failure`:

  root      runs its child; when the child ends, it starts again on the next frame (`loop`), or the tree is done. Its
            `inputs` ([{name, type}]) make the tree one that another runs (`run`), given their values.
  sequence  its children in order (left to right): fails as soon as one fails, succeeds once all have. A child still
            running is carried on with on the next frame (the ones before it aren't asked again: put a While round it
            to keep checking something).
  fallback  its children in order until one succeeds; fails once all have failed.
  repeat    its child again each time it succeeds, `times` times (0: for ever); fails if it fails.
  retry     its child again each time it fails, up to `times` tries; succeeds once it does.
  invert    its child's success as failure, and failure as success.
  succeed   its child's ending as success, however it ended.
  limit     its child, failing if it's still running after `ms`.
  while     its child for as long as `formula` is true: stops it and fails once it isn't.
  condition `formula`, true (success) or false (failure; so is a value that isn't there).
  press     `keys` pressed together for `ms`, played by the input guard to the millisecond.
  hold      `keys` held until `until` is true (success; failure after `ms`), or for `ms` without one.
  wait      nothing pressed until `until` is true (success; failure after `ms`), or for `ms` without one.
  walk      the `more` keys while `target` is further along `axis` (x or y) than `position` by over `within` px, the
            `less` keys while it's behind: success once within, failure after `ms`.
  clip      the keys of a stretch of a recording (`recording`, `from`, `to`, capture ms) as they were pressed, played
            by the guard to the millisecond: success once it's played.
  set       `name` = `formula`'s value now, which formulas read by that name from then on (success; failure if it
            isn't there).
  run       another tree (`tree`, a graph id), its inputs given by `args` ({input: formula}, worked out when it starts):
            succeeds or fails as that tree's root's child does.
  go        to a place of a map (`map`, a graph id; `place`, a place's id, or `target`, a position formula: the place
            on the player's level nearest it), over the map's links (`MapRun`).

Formulas are worker/formulas.py's, over the observations by name (`backticks` for names with spaces), the tree's
variables (set nodes, and its inputs), and x[-k] for a frame k frames back.

A map (src/mapModel.ts) is places ({id, name, level, x, y}) and links between them ({id, from, to, kind: clip | tree |
keys, ...}; a keys link holds its `keys` until the player is at its place, as the moves a map learns on a grid from
recordings do, which Worker._behavior adds to it), with `position` and `level` formulas saying where the player is and on which level, and `reach`, how near a place
is being at it. Go to plans the quickest way over the links (Dijkstra), each costing what it took when it last worked
(else its own `ms`, its clip's length, or a second), over its chance of working (from how often it has), and runs the
first: a clip played as pressed, or a tree given `from` and `to` (the places' positions) and its `args`. A link has
worked once the player is at its `to` place within `arriveMs` after it ends; else it failed, counts against it, and
after `giveUp` failures in a run it isn't planned again. What links took and how often they worked is kept
(Worker.behavior_step writes it to <root>/maps/<id>.json), so the costs are learned from playing, not from any game's
rules. Not at any place, Go to runs the map's `approach` tree, given `to` (the nearest place's position), as a link's tree is given `from` and `to`."""
import heapq
import math
import re

from formulas import FormulaSet, Missing, bare_name
from observations import level_key
from planner import learn_stat
from movement import deviation, MONITOR_DISTANCE_PX, MONITOR_CONFIRM_MS
from movement_control import controller_for, load_dynamics, model_settings
from positioning import LINE_UP_RANGE, LINE_UP_TAP_MS, LINE_UP_TRIES, TAP_MAX_MS
from tap_response import TAP_MIN_MS, kept_taps

KINDS = {'root', 'sequence', 'fallback', 'repeat', 'retry', 'invert', 'succeed', 'limit', 'while',
         'condition', 'press', 'hold', 'wait', 'walk', 'clip', 'set', 'run', 'go'}
COMPOSITES = {'sequence', 'fallback'}
DECORATORS = {'root', 'repeat', 'retry', 'invert', 'succeed', 'limit', 'while'}
LEAVES = KINDS - COMPOSITES - DECORATORS
MAX_NODES = 500
MAX_DEPTH = 16  # trees running trees
HISTORY = 30    # frames kept for formulas looking back
NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,40}$')
TYPES = ('number', 'boolean', 'vector')
# a map's, unless it says
REACH, GIVE_UP, LINK_MS, ARRIVE_MS, LINK_COST = 24, 3, 10000, 1500, 1000
# A map's recorded movements (its grid's `replay`), unless it says otherwise: how near the recorded start it must be,
# how near the recorded end it counts as there, and how long the player must be still at either
START_PX, ARRIVE_PX, STILL_MS = 6, 6, 80
# Waiting for a State (`replay.sync`): presses up to this long after it turns true wait for it to, and how long past
# its recorded time a wait may run before the movement has failed
SYNC_WINDOW_MS, SYNC_SLACK_MS = 300, 300  # on the user's jump quest, jumps came 180–280 ms after landing
SEGMENT_STATE = ('segs', 'seg', 'anchor', 'sawFalse', 'waiting', 'rose', 'segStart', 'syncWhy', 'syncDestination', 'segSaid', 'shiftX', 'sentAt', 'pendingTransition')
# A wait's State turning true is pending until a reading puts the player at its expected destination (Controller.
# confirms): within this long of it, else it isn't the transition waited for (on the first map's last movement, the
# frame On Ground turned true still had the position from before, 8 px above the line, and the right landing was taken
# for a wrong one)
TRANSITION_CONFIRM_MS = 120
# After a recorded movement fails, nothing is held and the map plans again only once the player is on the ground and
# still (the map's Wait for, and Still for); not within this long, the Go node fails
SETTLE_MS = 4000


def _bounded(value, default, low, high):
    """A setting as a number in [low, high], else the default."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, v)) if math.isfinite(v) else default


def replay_settings(doc):
    """A map's settings for its recorded movements: {startPx, arrivePx, stillMs, lineUp}, lineUp None or {axes: {x|y:
    {less, more}}, tapMs, tries, range}, an axis only with keys both ways. Nothing in them is about a game: what's
    right for one is read off its runs."""
    r = ((doc or {}).get('grid') or {}).get('replay') or {}
    sync = (r.get('sync') or '').strip() if isinstance(r.get('sync'), str) else ''
    out = {'startPx': _bounded(r.get('startPx'), START_PX, 0.5, 200), 'arrivePx': _bounded(r.get('arrivePx'), ARRIVE_PX, 0.5, 400),
           'stillMs': _bounded(r.get('stillMs'), STILL_MS, 0, 2000), 'lineUp': None,
           # a true/false formula presses wait for (such as On Ground): those that came within syncWindowMs after it
           # turned true in a recording wait for it to turn true again in play, rather than for the clock
           'sync': sync or None, 'syncWindowMs': _bounded(r.get('syncWindowMs'), SYNC_WINDOW_MS, 0, 1000),
           # the movement model's own (movement_control.model_settings)
           **model_settings(r)}
    lu = r.get('lineUp') or None
    if isinstance(lu, dict):
        axes = {}
        for axis in ('x', 'y'):
            a = lu.get(axis) or {}
            less = [k for k in a.get('less') or [] if isinstance(k, str)]
            more = [k for k in a.get('more') or [] if isinstance(k, str)]
            if less and more:
                axes[axis] = {'less': less, 'more': more}
        if axes:
            out['lineUp'] = {'axes': axes, 'tapMs': _bounded(lu.get('tapMs'), LINE_UP_TAP_MS, TAP_MIN_MS, TAP_MAX_MS),
                             'tries': int(_bounded(lu.get('tries'), LINE_UP_TRIES, 1, 50)), 'range': _bounded(lu.get('range'), LINE_UP_RANGE, 1, 500)}
    return out


def _ms(v, low=1, high=600000):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and low <= v <= high


def _vector(v):
    return isinstance(v, (list, tuple)) and len(v) >= 2 and all(isinstance(c, (int, float)) for c in v[:2])


class TreeError(ValueError):
    """A tree that isn't right: its message names every node, and `errors` says which, by node id."""

    def __init__(self, message, errors):
        super().__init__(message)
        self.errors = errors


class MapRun:
    """A map while a tree runs: its places and links, what each link took and how often it worked (`stats`, kept
    between runs), and how often each failed in this run (`fails`)."""

    def __init__(self, mid, doc, stats=None):
        self.id, self.doc = mid, doc
        self.places = {p['id']: p for p in doc.get('places') or [] if isinstance(p, dict) and _vector([p.get('x'), p.get('y')])}
        self.aliases = {a: b for a, b in (doc.get('aliases') or {}).items() if a in self.places and b in self.places and a != b}
        self.links = {l['id']: l for l in doc.get('links') or [] if isinstance(l, dict) and l.get('from') in self.places and l.get('to') in self.places}
        self.reach = float(doc.get('reach') or REACH)
        self.give_up = int(doc.get('giveUp') or GIVE_UP)
        self.link_ms = float(doc.get('linkMs') or LINK_MS)
        self.arrive_ms = float(doc.get('arriveMs') or ARRIVE_MS)
        self.replay = replay_settings(doc)
        # the dynamics model its analysis measured, if it has one (movement_control.load_dynamics): only its controller
        # reads it
        self.dynamics = load_dynamics(doc)
        self.stats = {lid: dict(s) for lid, s in (stats or {}).items() if lid in self.links}
        # what taps did, by axis: [[ms, px moved]], kept with its stats (`_taps`) so it's learned across runs
        self.taps = {a: kept_taps(seen) for a, seen in ((stats or {}).get('_taps') or {}).items() if isinstance(seen, list)}
        if self.taps:
            self.stats['_taps'] = self.taps
        self.fails = {}
        self.changed = False

    @property
    def control(self):
        """What depends on what kind of movement it is (movement_control): its model's controller, else the generic
        one, following the map's model."""
        kind = bool(self.dynamics)
        if getattr(self, '_control_kind', None) is not kind:
            self._control, self._control_kind = controller_for(self), kind
        return self._control

    def name(self, pid):
        p = self.places.get(pid)
        if not p:
            return 'nowhere'
        coordinates = f"({p['x']:.0f}, {p['y']:.0f})"
        for marker, target in self.aliases.items():
            if target == pid:
                return f"{self.places[marker].get('name') or 'Destination'} (recorded point {coordinates})"
        return p.get('name') or f'a place at {coordinates}'

    def on_level(self, level):
        return [p for p in self.places.values() if p['id'] not in self.aliases and (p.get('level') or None) == level]

    def nearest(self, level, x, y):
        here = self.on_level(level)
        if not here:
            return None, math.inf
        p = min(here, key=lambda q: math.hypot(q['x'] - x, q['y'] - y))
        return p['id'], math.hypot(p['x'] - x, p['y'] - y)

    def at(self, level, x, y):
        pid, d = self.nearest(level, x, y)
        return pid if pid is not None and d <= min(self.reach, self.places[pid].get('reach', self.reach)) else None

    def cost(self, lid, clips):
        link, s = self.links[lid], self.stats.get(lid) or {}
        ms = s.get('ms') or link.get('ms') or ((clips.get(f'link:{lid}') or {}).get('end')) or LINK_COST
        chance = (s.get('runs', 0) - s.get('fails', 0) + 1) / (s.get('runs', 0) + 2)  # how often it worked, a fair coin to start
        return float(ms) / max(0.05, chance)

    def route(self, start, goal, clips, avoid=()):
        """The quickest way from place `start` to `goal`, as link ids, over links not given up on and not in `avoid`
        (None: none)."""
        best, queue, via = {start: 0.0}, [(0.0, start)], {}
        out = {}
        for lid, l in self.links.items():
            if self.fails.get(lid, 0) < self.give_up and lid not in avoid:
                out.setdefault(l['from'], []).append(lid)
        while queue:
            t, here = heapq.heappop(queue)
            if here == goal:
                break
            if t > best.get(here, math.inf):
                continue
            for lid in out.get(here, ()):
                nxt, spent = self.links[lid]['to'], t + self.cost(lid, clips)
                if spent < best.get(nxt, math.inf):
                    best[nxt], via[nxt] = spent, lid
                    heapq.heappush(queue, (spent, nxt))
        if goal not in via and goal != start:
            return None
        way, at = [], goal
        while at != start:
            way.append(via[at])
            at = self.links[via[at]]['from']
        return way[::-1]

    def learn(self, lid, worked, ms):
        learn_stat(self.stats.setdefault(lid, {'runs': 0, 'fails': 0}), worked, ms)
        if not worked:
            self.fails[lid] = self.fails.get(lid, 0) + 1
        self.changed = True

    def keys_ms(self, lid):
        """How long a keys link may hold its keys before it has failed: twice what it takes, and half a second."""
        link, s = self.links[lid], self.stats.get(lid) or {}
        return 2 * float(s.get('ms') or link.get('ms') or LINK_COST) + 500


class Behavior:
    """A tree, checked and ready to tick. `fields` [{name, type}] are the observations; `clips` {node id, or
    link:<link id>: {keys, timeline, end}} the keys of its clips (Worker._tree_clips reads them from the recordings);
    `trees` {graph id: tree} the trees its Run tree nodes and maps' links run; `maps` {graph id: map} the maps its Go
    to nodes go over, and `stats` {map id: {link id: {runs, fails, ms}}} what their links did before. Raises TreeError
    naming every node that isn't right."""

    def __init__(self, tree, fields, clips=None, trees=None, maps=None, stats=None, tree_id=None, stack=(), shared=None):
        self.errors = {}
        nodes = tree.get('nodes') if isinstance(tree, dict) else None
        root = tree.get('root') if isinstance(tree, dict) else None
        if not isinstance(nodes, dict) or root not in nodes:
            raise TreeError('A behaviour tree needs its Root', {})
        if len(nodes) > MAX_NODES:
            raise TreeError(f'A behaviour tree has up to {MAX_NODES} nodes', {})
        self.nodes, self.root, self.tree_id = nodes, root, tree_id
        self.clips, self.trees, self.maps = clips or {}, trees or {}, maps or {}
        self.fields = [{'name': f['name'], 'type': f['type']} for f in fields]
        # the maps it goes over, shared with the trees it runs (one MapRun per map, for what its links did this run)
        self.shared = shared if shared is not None else {'maps': {}, 'stats': stats or {}}
        for nid, n in nodes.items():
            self._check_node(nid, n)
        taken = {f['name'] for f in self.fields}
        # its inputs, given by a Run tree node (the root's)
        inputs = {}
        for e in (nodes[root].get('params') or {}).get('inputs') or []:
            name, kind = (e or {}).get('name', ''), (e or {}).get('type')
            if not NAME.match(name) or kind not in TYPES:
                self.errors[root] = 'each input needs a name (letters, digits and _) and a type'
            elif name in taken or name in inputs:
                self.errors[root] = f'{name} is taken: name the input something else'
            else:
                inputs[name] = kind
        self.inputs = inputs
        # the trees it runs: Run tree nodes', and its maps' links' and approach trees
        self.runs = {}
        for nid, n in nodes.items():
            if n.get('kind') == 'run' and nid not in self.errors:
                self.runs[nid] = self._child(nid, n['params'].get('tree'), stack)
        self.link_trees = {}
        for nid, n in nodes.items():
            if n.get('kind') == 'go' and nid not in self.errors:
                self._map(nid, n['params'].get('map'), stack)
        # its variables: each set node's name, of its formula's type (worked out over the observations and inputs)
        sets = {nid: n for nid, n in nodes.items() if n.get('kind') == 'set' and nid not in self.errors}
        first = FormulaSet([{'name': self.fname(nid, 'formula'), 'source': n['params'].get('formula', '')} for nid, n in sets.items()],
                           [*self.fields, *({'name': v, 'type': t} for v, t in inputs.items())])
        variables = dict(inputs)
        for nid, n in sets.items():
            name, e = n['params'].get('name', ''), first.entries.get(self.fname(nid, 'formula'))
            if name in taken:
                self.errors[nid] = f'{name} is already an observation: name it something else'
            elif e is None or e['error']:
                self.errors[nid] = e['error'] if e else 'not checked'
            elif variables.get(name, e['type']) != e['type']:
                self.errors[nid] = f'{name} is set to a {e["type"]} here and a {variables[name]} elsewhere'
            else:
                variables[name] = e['type']
        self.variables = variables
        # every formula, over the observations and the variables
        entries, wants = [], {}

        def want(owner, fname, source, kind, label):
            if isinstance(source, str) and source.strip() and fname not in wants:
                entries.append({'name': fname, 'source': source})
                wants[fname] = (owner, kind, label)
        for nid, n in nodes.items():
            if nid in self.errors:
                continue
            for key, kind in self._formulas(n):
                want(nid, self.fname(nid, key), n['params'].get(key), kind, self._label(key))
            if n['kind'] == 'run' and nid in self.runs:
                args = n['params'].get('args') or {}
                for name, kind in self.runs[nid].inputs.items():
                    if not (args.get(name) or '').strip():
                        self.errors[nid] = f'give its input {name} a value'
                    want(nid, self.fname(nid, f'arg {name}'), args.get(name), kind, f'Its input {name}')
            if n['kind'] == 'go' and n['params'].get('map') in self.shared['maps']:
                mr = self.shared['maps'][n['params']['map']]
                want(nid, self.mname(mr.id, 'position'), mr.doc.get('position'), 'vector', 'Its map’s position')
                if mr.replay['sync']:
                    want(nid, self.mname(mr.id, 'sync'), mr.replay['sync'], 'boolean', 'Its map’s Wait for')
                if bare_name(mr.doc.get('level') or '') not in {f['name'] for f in self.fields}:  # a State's name is read as it is (any value)
                    want(nid, self.mname(mr.id, 'level'), mr.doc.get('level'), 'any', 'Its map’s level')
                for key, child in self.link_trees.items():
                    if key[0] != mr.id:
                        continue
                    args = (mr.links[key[1]].get('args') if key[1] in mr.links else (mr.doc.get('approach') or {}).get('args')) or {}
                    for name, kind in child.inputs.items():
                        if name in ('from', 'to'):
                            continue
                        if not (args.get(name) or '').strip():
                            self.errors[nid] = f'its map’s link to {mr.name((mr.links.get(key[1]) or {}).get("to"))} needs its input {name}'
                        want(nid, self.mname(mr.id, f'link {key[1]} arg {name}'), args.get(name), kind, f'A link’s input {name}')
        self.set = FormulaSet(entries, [*self.fields, *({'name': v, 'type': t} for v, t in variables.items())])
        for fname, (owner, kind, label) in wants.items():
            e = self.set.entries[fname]
            if e['error']:
                self.errors.setdefault(owner, f'{label}: {e["error"]}')
            elif kind != 'any' and e['type'] != kind:
                self.errors.setdefault(owner, f'{label} has to give {"true or false" if kind == "boolean" else "a position (a vector)" if kind == "vector" else "a " + kind}, not {e["type"]}')
        if self.errors:
            raise TreeError('; '.join(f'{self._name(nid)}: {msg}' for nid, msg in self.errors.items()), dict(self.errors))
        # the observations its formulas read, for its trace (what it saw, beside what it did)
        self.reads = sorted(({o for e in self.set.ok() for o in e['observations']} - set(variables))
                            | {bare_name(mr.doc.get('level') or '') for mr in self.shared['maps'].values()} & {f['name'] for f in self.fields}
                            | {o for c in [*self.runs.values(), *self.link_trees.values()] if c is not None for o in c.reads})
        own = {k for n in nodes.values() for key in ('keys', 'less', 'more') for k in n['params'].get(key) or []}
        own |= {k for mr in self.shared['maps'].values() for link in mr.links.values() if link.get('kind') == 'keys' for k in link.get('keys') or []}
        own |= {k for mr in self.shared['maps'].values() for a in ((mr.replay['lineUp'] or {}).get('axes') or {}).values() for k in a['less'] + a['more']}
        # the keys its maps' controllers press beyond the recordings' (Controller.keys)
        own |= {k for mr in self.shared['maps'].values() for k in mr.control.keys()}
        clips = {k for c in self.clips.values() for k in c['keys'] + [e[1] for e in c['timeline']]}
        self.buttons = sorted(own | clips | {k for c in [*self.runs.values(), *self.link_trees.values()] for k in c.buttons})
        self.reset()

    # ── checking ──────────────────────────────────────────────────────────────────────────────────────────────────
    @staticmethod
    def fname(nid, key):
        return f'bt {nid} {key}'

    @staticmethod
    def mname(mid, key):
        return f'map {mid} {key}'

    @staticmethod
    def _label(key):
        return {'formula': 'Its formula', 'until': 'Until', 'position': 'Position', 'target': 'Target'}.get(key, key)

    def _name(self, nid):
        n = self.nodes.get(nid) or {}
        return (n.get('params') or {}).get('label') or n.get('kind', 'node')

    @staticmethod
    def _formulas(n):
        kind = n.get('kind')
        if kind in ('condition', 'while'):
            return [('formula', 'boolean')]
        if kind in ('hold', 'wait'):
            return [('until', 'boolean')]
        if kind == 'walk':
            return [('position', 'vector'), ('target', 'vector')]
        if kind == 'set':
            return [('formula', 'any')]
        if kind == 'go' and not n.get('params', {}).get('place'):
            return [('target', 'vector')]
        return []

    def _child(self, owner, tid, stack):
        """Another tree, to run from a Run tree node or a map; its problems said on `owner`."""
        if tid not in self.trees:
            self.errors[owner] = 'choose a tree to run' if not tid else 'the tree it runs is gone'
            return None
        if tid in stack or tid == self.tree_id or len(stack) >= MAX_DEPTH:
            self.errors[owner] = 'the tree it runs runs this one: a loop'
            return None
        try:
            return Behavior(self.trees[tid], self.fields, self.clips, self.trees, self.maps, None, tid, (*stack, self.tree_id), self.shared)
        except TreeError as e:
            self.errors[owner] = f'the tree it runs isn’t right ({e})'
            return None

    def _map(self, owner, mid, stack):
        """A map a Go to node goes over: its run (shared), and the trees its links run."""
        doc = self.maps.get(mid)
        if not isinstance(doc, dict):
            self.errors[owner] = 'choose a map' if not mid else 'the map it goes over is gone'
            return
        if not (doc.get('position') or '').strip():
            self.errors[owner] = 'its map needs the player’s position'
            return
        mr = self.shared['maps'].get(mid) or MapRun(mid, doc, self.shared['stats'].get(mid))
        self.shared['maps'][mid] = mr
        for lid, link in mr.links.items():
            if link.get('kind') == 'tree':
                child = self._child(owner, link.get('tree'), stack)
                if child is not None:
                    self.link_trees[(mid, lid)] = child
            elif link.get('kind') == 'keys':
                if not (isinstance(link.get('keys'), list) and all(isinstance(k, str) for k in link['keys'])):
                    self.errors[owner] = f'its map’s link from {mr.name(link["from"])} to {mr.name(link["to"])} needs a list of keys (empty to wait)'
            elif f'link:{lid}' not in self.clips:
                self.errors[owner] = f'its map’s link from {mr.name(link["from"])} to {mr.name(link["to"])} has no clip'
        approach = doc.get('approach') or {}
        if approach.get('tree'):
            child = self._child(owner, approach['tree'], stack)
            if child is not None:
                self.link_trees[(mid, 'approach')] = child
        p = self.nodes[owner]['params']
        if p.get('place') and p['place'] not in mr.places:
            self.errors[owner] = 'its place is gone from the map'

    def _check_node(self, nid, n):
        kind = n.get('kind') if isinstance(n, dict) else None
        if kind not in KINDS:
            self.errors[nid] = 'not a kind of node a tree has'
            return
        p = n.setdefault('params', {}) if isinstance(n.get('params', {}), dict) else None
        children = n.setdefault('children', [])
        if p is None or not isinstance(children, list) or not all(c in self.nodes for c in children):
            self.errors[nid] = 'not read right'
            return
        if kind in COMPOSITES and not children:
            self.errors[nid] = 'give it children: wire nodes below it'
        elif kind in DECORATORS and len(children) != 1:
            self.errors[nid] = 'give it one child: wire one node below it' if not children else 'it takes one child'
        elif kind in LEAVES and children:
            self.errors[nid] = 'it takes no children'
        elif kind in ('press', 'hold') and not (isinstance(p.get('keys'), list) and p['keys'] and all(isinstance(k, str) for k in p['keys'])):
            self.errors[nid] = 'choose the keys it presses'
        elif kind in ('press', 'hold', 'wait', 'limit', 'walk') and not _ms(p.get('ms')):
            self.errors[nid] = 'give it a time (ms)'
        elif kind in ('condition', 'while', 'set') and not (p.get('formula') or '').strip():
            self.errors[nid] = 'write its formula'
        elif kind == 'walk' and not ((p.get('position') or '').strip() and (p.get('target') or '').strip()):
            self.errors[nid] = 'give it the position and where to walk to'
        elif kind == 'walk' and not (p.get('axis') in ('x', 'y') and (p.get('less') or p.get('more'))
                                     and isinstance(p.get('within'), (int, float)) and p['within'] >= 0):
            self.errors[nid] = 'choose the keys each way, and how near is there'
        elif kind in ('repeat', 'retry') and not (isinstance(p.get('times'), int) and 0 <= p['times'] <= 100000 and (kind == 'repeat' or p['times'] >= 1)):
            self.errors[nid] = 'how many times' + (' (0: for ever)' if kind == 'repeat' else '')
        elif kind == 'clip' and nid not in self.clips:
            self.errors[nid] = 'choose its clip'
        elif kind == 'set' and not NAME.match(p.get('name') or ''):
            self.errors[nid] = 'name the variable (letters, digits and _)'
        elif kind == 'go' and not p.get('place') and not (p.get('target') or '').strip():
            self.errors[nid] = 'choose where to go: a place on the map, or a position'

    # ── running ───────────────────────────────────────────────────────────────────────────────────────────────────
    def reset(self):
        self.state = {}
        self.vars = {}
        self.frames = []
        self.done = None
        self.frame = 0
        self._begin_frame()

    def _begin_frame(self):
        self.keys, self.sequence, self.cancel, self.statuses, self.texts = set(), None, False, {}, []
        self.action = None
        self.tree_statuses, self.map_statuses = {}, {}

    def tick(self, now, values, execution=None, observation_time=None):
        """One frame: the keys to hold, presses for the guard to play from now ([] to stop what it plays, None
        for neither), each node reached and how it answered (`nodes`, and in the trees it ran, `trees` by graph id),
        each map gone over (`maps`: where the player is, the way, the link running, failures), what's running, and the
        tree's ending once it ends (not looping)."""
        self.now = now
        self.shared['execution'] = execution
        self.shared['observation_time'] = now if observation_time is None else observation_time
        self.frame += 1
        self.frames = [values, *self.frames][:HISTORY]
        self.shared['events'] = []  # link attempts begun and ended this frame, in this tree or those it runs
        self._begin_frame()
        if self.done is None:
            r = self._tick(self.root)
            if r != 'running':
                if self.nodes[self.root]['params'].get('loop', True):
                    self._halt(self.root)
                else:
                    self.done = r
        sequence = self.sequence if self.sequence is not None else ([] if self.cancel else None)
        return {'keys': self.keys, 'sequence': sequence, 'action': self.action, 'nodes': self.statuses, 'trees': self.tree_statuses, 'maps': self.map_statuses,
                'text': ' · '.join(self.texts) or None, 'done': self.done, 'events': self.shared['events']}

    def seen(self):
        """The values of the observations its formulas read, this frame (for its trace)."""
        out = {}
        for name in self.reads:
            o = (self.frames[0] if self.frames else {}).get(name)
            out[name] = o.get('value') if o and o.get('valid') else None
        return out

    def read_times(self):
        """When each memory or Lua State it read was read (the runtime's `readAt`) and whether this frame got an
        earlier read again (`reused`), by name: [readAt, reused], for its trace. Others carry neither."""
        out = {}
        for name in self.reads:
            o = (self.frames[0] if self.frames else {}).get(name)
            if o and isinstance(o.get('readAt'), (int, float)):
                out[name] = [round(o['readAt'], 2), bool(o.get('reused'))]
        return out

    def stats(self):
        """What its maps' links did, by map id (to keep), once something changed; else None."""
        changed = {mid: mr.stats for mid, mr in self.shared['maps'].items() if mr.changed}
        for mr in self.shared['maps'].values():
            mr.changed = False
        return changed or None

    def _formula(self, fname):
        """A formula now: its value, or None when something it reads isn't there."""
        first = {**self.frames[0], **{k: {'valid': True, 'value': list(v) if isinstance(v, tuple) else v} for k, v in self.vars.items()}}
        try:
            return self.set.evaluate(fname, [first, *self.frames[1:]])
        except Missing:
            return None

    def _check(self, nid, key):
        return self._formula(self.fname(nid, key))

    def _tick(self, nid):
        n, st = self.nodes[nid], self.state.setdefault(nid, {})
        r = getattr(self, '_' + n['kind'])(nid, n['params'], n['children'], st)
        self.statuses[nid] = r
        return r

    def _halt(self, nid):
        """A node and everything below it stopped and forgotten (a press or clip still playing is stopped too, and so
        is a tree it runs)."""
        st = self.state.pop(nid, None)
        if st and (self._playing(st) or any((st.get(c) or {}).get('tapping') and self._playing(st[c]['tapping']) for c in ('lineUp', 'finish'))):
            self.cancel = True
        if st and st.get('child') is not None:
            self._stop_child(st['child'])
        for c in self.nodes[nid]['children']:
            self._halt(c)

    def _ended(self, nid, r):
        self._halt(nid)
        return r

    # running another tree, inside this one's frame
    def _start_child(self, child, args):
        child.state, child.vars, child.done = {}, dict(args), None

    def _step_child(self, child):
        """Another tree's root's child, ticked in this frame: its keys and presses this tree's, its statuses kept by
        its graph id."""
        if child.frame != self.frame or child.now != self.now:
            child.frame, child.now = self.frame, self.now
            child._begin_frame()
        child.frames, child.keys, child.texts = self.frames, self.keys, self.texts
        r = child._tick(child.nodes[child.root]['children'][0])
        child.statuses[child.root] = r
        self._absorb(child)
        return r

    def _stop_child(self, child):
        child.now = self.now
        child._halt(child.root)
        self._absorb(child)

    def _absorb(self, child):
        if child.sequence is not None:
            self.sequence = child.sequence
            self.action = child.action
        self.cancel = self.cancel or child.cancel
        child.sequence, child.cancel = None, False
        if child.tree_id:
            self.tree_statuses.setdefault(child.tree_id, {}).update(child.statuses)
        for tid, s in child.tree_statuses.items():
            self.tree_statuses.setdefault(tid, {}).update(s)
        self.map_statuses.update(child.map_statuses)

    # control
    def _root(self, nid, p, kids, st):
        return self._tick(kids[0])

    def _sequence(self, nid, p, kids, st):
        i = st.get('i', 0)
        while i < len(kids):
            r = self._tick(kids[i])
            if r == 'running':
                st['i'] = i
                return r
            if r == 'failure':
                return self._ended(nid, 'failure')
            i += 1
        return self._ended(nid, 'success')

    def _fallback(self, nid, p, kids, st):
        i = st.get('i', 0)
        while i < len(kids):
            r = self._tick(kids[i])
            if r == 'running':
                st['i'] = i
                return r
            if r == 'success':
                return self._ended(nid, 'success')
            i += 1
        return self._ended(nid, 'failure')

    def _repeat(self, nid, p, kids, st):
        r = self._tick(kids[0])
        if r == 'failure':
            return self._ended(nid, 'failure')
        if r == 'success':
            st['n'] = st.get('n', 0) + 1
            self._halt(kids[0])
            if p['times'] and st['n'] >= p['times']:
                return self._ended(nid, 'success')
        return 'running'  # again on the next frame

    def _retry(self, nid, p, kids, st):
        r = self._tick(kids[0])
        if r == 'success':
            return self._ended(nid, 'success')
        if r == 'failure':
            st['n'] = st.get('n', 0) + 1
            self._halt(kids[0])
            if st['n'] >= p['times']:
                return self._ended(nid, 'failure')
        return 'running'

    def _invert(self, nid, p, kids, st):
        r = self._tick(kids[0])
        return r if r == 'running' else self._ended(nid, 'failure' if r == 'success' else 'success')

    def _succeed(self, nid, p, kids, st):
        r = self._tick(kids[0])
        return r if r == 'running' else self._ended(nid, 'success')

    def _limit(self, nid, p, kids, st):
        st.setdefault('start', self.now)
        if self.now - st['start'] > p['ms']:
            return self._ended(nid, 'failure')
        r = self._tick(kids[0])
        return r if r == 'running' else self._ended(nid, r)

    def _while(self, nid, p, kids, st):
        if self._check(nid, 'formula') is not True:
            return self._ended(nid, 'failure')
        r = self._tick(kids[0])
        return r if r == 'running' else self._ended(nid, r)

    # leaves
    def _condition(self, nid, p, kids, st):
        self.state.pop(nid, None)
        return 'success' if self._check(nid, 'formula') is True else 'failure'

    def _start(self, st):
        if 'start' not in st:
            st['start'] = self.now
        return self.now - st['start']

    # ── the executor's services to controllers and positioners (movement_control, positioning) ──
    def play(self, st, line, length, keep=None):
        return self._play(st, line, length, keep)

    def playing(self, st):
        return self._playing(st)

    def settled(self, st, name, x, y, still_ms=STILL_MS):
        return self._settled(st, name, x, y, still_ms)

    def say(self, kind, st, **fields):
        """An event for the trace, under the movement attempt of `st`."""
        self._said(kind, st, **fields)

    def sync(self, mr):
        """The map's Wait for now (True, False, or None when it isn't there)."""
        return self._formula(self.mname(mr.id, 'sync'))

    def position_reads(self, mr):
        """The observations the map's position formula read this frame that carry a read time (a memory or Lua
        State's `readAt`; `reused` when the runtime gave this frame an earlier read again)."""
        e = self.set.entries.get(self.mname(mr.id, 'position'))
        frame = self.frames[0] if self.frames else {}
        return [o for name in (e['observations'] if e else ()) if (o := frame.get(name)) and isinstance(o.get('readAt'), (int, float))]

    def release(self, keys):
        """Keys not held this frame."""
        self.keys -= set(keys)

    def hold(self, keys):
        """Keys held this frame (offline, without the guard's feedback, a tap is held a frame at a time)."""
        self.keys |= set(keys)

    def _play(self, st, line, length, keep=None):
        """Submit once; with executor feedback only its acknowledgement ends an action.
        Offline simulations and older guards retain elapsed-time behavior. `keep`: keys the guard leaves held when it
        completes (a movement going on through a wait for its next part)."""
        execution = self.shared.get('execution')
        if not st.get('playing'):
            self.sequence = [list(e) for e in line]
            st['playing'], st['length'] = True, length
            if execution is not None:
                action_id = self.shared.get('next_action', 0) + 1
                self.shared['next_action'] = st['action_id'] = action_id
                self.action = {'id': action_id, 'durationMs': length, **({'keep': sorted(keep)} if keep else {})}
        if execution is not None:
            if execution.get('id') == st.get('action_id'):
                return execution.get('state', 'running')
            return 'running'
        return None

    def _playing(self, st):
        if not st.get('playing'):
            return False
        execution = self.shared.get('execution')
        if execution is not None:
            return execution.get('id') != st.get('action_id') or execution.get('state') not in ('completed', 'cancelled', 'failed')
        return self.now - st.get('start', self.now) < st.get('length', 0)

    def _elapsed_action(self, st, fallback):
        execution = self.shared.get('execution')
        if execution is None:
            return fallback
        if execution.get('id') != st.get('action_id'):
            return 0.0
        return min(st['length'], max(0.0, float(execution.get('elapsedMs', 0))))

    @staticmethod
    def _held(start, line, t):
        held = set(start)
        for at, key, down in line:
            if at > t:
                break
            (held.add if down else held.discard)(key)
        return held

    def _press(self, nid, p, kids, st):
        t = self._start(st)
        line = [[0.0, k, True] for k in p['keys']] + [[float(p['ms']), k, False] for k in p['keys']]
        phase = self._play(st, line, p['ms'])
        t = self._elapsed_action(st, t)
        if phase in ('cancelled', 'failed'):
            self.state.pop(nid, None)
            return 'failure'
        if phase == 'completed' or (phase is None and t >= p['ms']):
            self.state.pop(nid, None)
            return 'success'
        self.keys |= set(p['keys'])
        self.texts.append(f'pressing {"+".join(p["keys"])} {t:.0f}/{p["ms"]:.0f} ms')
        return 'running'

    def _hold(self, nid, p, kids, st):
        t = self._start(st)
        until = (p.get('until') or '').strip()
        if until and self._check(nid, 'until') is True:
            self.state.pop(nid, None)
            return 'success'
        if t >= p['ms']:
            self.state.pop(nid, None)
            return 'failure' if until else 'success'
        self.keys |= set(p['keys'])
        self.texts.append(f'holding {"+".join(p["keys"])}' + (f' until {until}' if until else f' {t:.0f}/{p["ms"]:.0f} ms'))
        return 'running'

    def _wait(self, nid, p, kids, st):
        t = self._start(st)
        until = (p.get('until') or '').strip()
        if until and self._check(nid, 'until') is True:
            self.state.pop(nid, None)
            return 'success'
        if _ms(p.get('ms')) and t >= p['ms']:
            self.state.pop(nid, None)
            return 'failure' if until else 'success'
        self.texts.append(f'waiting until {until}' if until else f'waiting {t:.0f}/{p["ms"]:.0f} ms')
        return 'running'

    def _walk(self, nid, p, kids, st):
        t = self._start(st)
        pos, target = self._check(nid, 'position'), self._check(nid, 'target')
        if pos is None or target is None:
            self.state.pop(nid, None)
            return 'failure'
        k = 0 if p['axis'] == 'x' else 1
        d = float(target[k]) - float(pos[k])
        if abs(d) <= p['within']:
            self.state.pop(nid, None)
            return 'success'
        if t >= p['ms']:
            self.state.pop(nid, None)
            return 'failure'
        keys = p.get('more') if d > 0 else p.get('less')
        if not keys:
            self.state.pop(nid, None)
            return 'failure'  # no keys that way
        self.keys |= set(keys)
        self.texts.append(f'walking {"+".join(keys)}: {abs(d):.0f} px to go')
        return 'running'

    def _clip(self, nid, p, kids, st):
        clip = self.clips[nid]
        r = self._play_clip(st, clip, 'playing its clip')
        if r != 'running':
            self.state.pop(nid, None)
        return r

    def _play_clip(self, st, clip, text):
        t = self._start(st)
        phase = self._play(st, [[0.0, k, True] for k in clip['keys']] + clip['timeline'], clip['end'])
        t = self._elapsed_action(st, t)
        if phase in ('cancelled', 'failed'):
            return 'failure'
        if phase == 'completed' or (phase is None and t >= clip['end']):
            return 'success'
        self.keys |= self._held(clip['keys'], clip['timeline'], t)
        self.texts.append(f'{text} {t:.0f}/{clip["end"]:.0f} ms')
        return 'running'

    def _set(self, nid, p, kids, st):
        self.state.pop(nid, None)
        v = self._check(nid, 'formula')
        if v is None:
            return 'failure'
        self.vars[p['name']] = v
        return 'success'

    def _run(self, nid, p, kids, st):
        child = self.runs[nid]
        if 'child' not in st:
            args = {}
            for name in child.inputs:
                v = self._check(nid, f'arg {name}')
                if v is None:
                    self.state.pop(nid, None)
                    return 'failure'
                args[name] = v
            self._start_child(child, args)
            st['child'] = child
        r = self._step_child(child)
        if r != 'running':
            st.pop('child', None)  # it ended by itself: nothing of it to stop
            self.state.pop(nid, None)
        return r

    # going over a map
    def _go(self, nid, p, kids, st):
        r = self._go_step(nid, p, kids, st)
        if r == 'failure' and st.get('pendingArrival'):
            self._resolve_arrival(st, self.shared['maps'][p['map']], False, 'the map couldn’t go on from where it ended')
        return r

    def _go_step(self, nid, p, kids, st):
        mr = self.shared['maps'][p['map']]
        pos = self._formula(self.mname(mr.id, 'position'))
        if pos is None or not all(math.isfinite(float(v)) for v in pos[:2]):
            if st.get('link') and mr.links[st['link']].get('recorded'):
                since = st.setdefault('missingSince', self.now)
                if self.now - since >= 250:
                    self._fail_link(st, mr, 'position feedback missing for 250 ms; replay stopped', 'feedback')
                    return self._ended(nid, 'failure')
            self._map_status(mr, st, None, None, 'the player’s position isn’t there')
            return 'running' if st.get('link') else self._ended(nid, 'failure')
        st.pop('missingSince', None)
        level = self._map_level(mr)
        x, y = float(pos[0]), float(pos[1])
        st['seenAt'] = (x, y, level)
        if st.get('link'):
            r = self._link(st, mr, level, x, y)
            if r == 'running':
                return r
            return 'running'  # the link ended: plan again on the next frame
        settle = st.get('settle')
        if settle is not None:
            # a recorded movement failed: nothing held (_fail_link let go of everything) until the player is on the
            # ground and still, then the map plans from where it is; a deviation used to end the tree there, and other
            # failures planned at once, a walk then started while the player was still falling
            ready = self._formula(self.mname(mr.id, 'sync')) if mr.replay['sync'] else True
            still = self._settled(settle, 'still', x, y, mr.replay['stillMs'])
            if ready is not True or not still:
                if self.now - settle['since'] > SETTLE_MS:
                    self._map_status(mr, st, None, st.get('dest'), f'{settle["why"]}; the player didn’t land and stop within {SETTLE_MS / 1000:g} s')
                    return self._ended(nid, 'failure')
                self._map_status(mr, st, None, st.get('dest'), f'{settle["why"]}; waiting for the player to land and stop')
                return 'running'
            st.pop('settle')
        if st.get('approach'):
            r = self._step_child(st['child'])
            if r == 'running':
                self._map_status(mr, st, None, None, 'going to the nearest place')
                return r
            st.pop('approach', None); st.pop('child', None)
            if r == 'failure':
                self._map_status(mr, st, None, None, 'its approach tree failed')
                return self._ended(nid, 'failure')
        # where to
        if p.get('place'):
            dest = mr.aliases.get(p['place'], p['place'])
        else:
            target = self._check(nid, 'target')
            dest = mr.nearest(level, float(target[0]), float(target[1]))[0] if target is not None else None
            if dest is None:
                self._map_status(mr, st, None, None, 'its target isn’t there, or no place on this level')
                return self._ended(nid, 'failure')
        at = mr.at(level, x, y)
        # where a movement that worked ended, aside from its place: at its place, until the next movement begins
        # (lining up with it takes frames: forgotten after the first, the map took the walk's start, as near as its
        # end, and lined up back to it), and while lining up has it no further than its range from there
        shifted = st.get('shifted')
        near_px = max(mr.replay['arrivePx'], (mr.replay['lineUp'] or {}).get('range', 0.0)) if st.get('lineUp') else mr.replay['arrivePx']
        if at is None and shifted and math.hypot(x - shifted['at'][0], y - shifted['at'][1]) <= near_px:
            at = shifted['place']
        pending = st.get('pendingArrival')
        if at is None and pending and pending['lid'] in mr.links:
            # a movement that ended on its destination's platform but not at its place (Controller.recoverable: the same
            # ground line, within Line up with taps' range) goes on from its destination, lining up with the next
            # movement there, rather than from whichever place is nearest: 7 px into a 14 px walk, its start and end were
            # equally near, the map took the start, lined up back to it and replayed the walk, three times, and gave up
            to = mr.links[pending['lid']]['to']
            if (mr.places[to].get('level') or None) == level:
                at = to
        if at == dest:
            self._resolve_arrival(st, mr, True, 'at its place')
            self._map_status(mr, st, at, dest, f'at {mr.name(dest)}')
            return self._ended(nid, 'success')
        if at is None:
            near, d = mr.nearest(level, x, y)
            lu = mr.replay['lineUp']
            if near is not None and lu and mr.places[near].get('recorded') and d <= lu['range']:
                if near == dest:  # near enough the end: there's no movement left to line up for
                    self._resolve_arrival(st, mr, True, 'near enough its destination')
                    self._map_status(mr, st, near, dest, f'at {mr.name(dest)} ({d:.0f} px away)')
                    return self._ended(nid, 'success')
                at = near
        if at is None:
            near, d = mr.nearest(level, x, y)
            child = self.link_trees.get((mr.id, 'approach'))
            if near is not None and child is not None and not st.get('approached'):
                args = self._link_args(mr, 'approach', child, {'to': (mr.places[near]['x'], mr.places[near]['y'])})
                if args is None:
                    self._map_status(mr, st, None, dest, 'an input of its approach tree isn’t there')
                    return self._ended(nid, 'failure')
                self._start_child(child, args)
                st.update(approach=True, approached=True, child=child)
                return self._go(nid, p, kids, st)
            self._map_status(mr, st, None, dest, f'not at a place of the map (the nearest, {mr.name(near)}, is {d:.0f} px away)' if near else 'no place of the map on this level')
            return self._ended(nid, 'failure')
        st.pop('approached', None)
        # movements marked unsafe (adaptive takeoff) only when there's no other way, and said so
        unsafe = mr.control.unsafe()
        way = mr.route(at, dest, self.clips, avoid=unsafe)
        forced = None
        if not way and unsafe:
            way = mr.route(at, dest, self.clips)
            forced = [lid for lid in way or () if lid in unsafe]
        if not way:
            out = [lid for lid, n in mr.fails.items() if n >= mr.give_up]
            self._map_status(mr, st, at, dest, f'no way from {mr.name(at)} to {mr.name(dest)}' + (f' ({len(out)} link{"s" if len(out) != 1 else ""} given up on)' if out else ''))
            return self._ended(nid, 'failure')
        lid = way[0]
        link = mr.links[lid]
        if forced:
            self.texts.append(f'no safe way to {mr.name(dest)}: {len(forced)} movement{"s" if len(forced) != 1 else ""} on it marked unsafe')
        if link.get('recorded'):
            # where it starts from and how near it must be, and where else it may begin (Controller.start)
            start = mr.control.start(link, level, self._bounds(mr, link, True))
            (sx, sy), tol = start['at'], start['tol']
            if start.get('region') is not None and mr.control.admits(start, level, x, y) and not (st.get('lineUp') or {}).get('tapping'):
                st.pop('lineUp', None)
                if st.get('regionSaid') != lid and mr.control.distance(level, x, y, sx, sy) > mr.replay['startPx']:
                    st['regionSaid'] = lid
                    self.shared.setdefault('events', []).append({'kind': 'start-region', 'map': mr.id, 'link': lid, 'target': [sx, sy], 'at': [x, y],
                                                                 'offPx': round(mr.control.distance(level, x, y, sx, sy), 1),
                                                                 **start['region']})
            elif mr.control.distance(level, x, y, sx, sy) > tol or st.get('lineUp'):
                r = self._line_up(nid, st, mr, at, dest, x, y, sx, sy, level, tol)
                if r is not None:
                    return r
            if not self._settled(st, 'startStill', x, y, mr.replay['stillMs']):
                since = st.setdefault('settlingSince', self.now)
                self._map_status(mr, st, at, dest, 'waiting for the player to stop at the recorded start')
                if self.now - since > mr.arrive_ms:
                    return self._ended(nid, 'failure')
                return 'running'
            st.pop('startStill', None)
            st.pop('settlingSince', None)
        self._resolve_arrival(st, mr, True, 'the next movement began')
        st.pop('shifted', None)
        st.pop('regionSaid', None)
        st.update(link=lid, way=way, phase='act', start=self.now, playing=False, at=at, dest=dest, forced=bool(forced and lid in forced))
        self._attempt_began(st, mr, lid, link, level, x, y)
        if link.get('kind') == 'tree':
            child = self.link_trees[(mr.id, lid)]
            args = self._link_args(mr, lid, child, {'from': (mr.places[link['from']]['x'], mr.places[link['from']]['y']),
                                                    'to': (mr.places[link['to']]['x'], mr.places[link['to']]['y'])})
            if args is None:
                self._fail_link(st, mr, 'an input of its tree isn’t there', 'input')
                return 'running'
            self._start_child(child, args)
            st['child'] = child
        r = self._link(st, mr, level, x, y)
        return 'running'

    def _map_level(self, mr):
        """The level the player is on by a map's Level: a State's value as it is, else its formula's (None without)."""
        source = (mr.doc.get('level') or '').strip()
        if not source:
            return None
        name = bare_name(source)
        if name is not None and any(f['name'] == name for f in self.fields):
            o = (self.frames[0] if self.frames else {}).get(name)
            raw = o.get('value') if o and o.get('valid') else None
        else:
            raw = self._formula(self.mname(mr.id, 'level'))
        return level_key(list(raw) if isinstance(raw, tuple) else raw) if raw is not None else None

    def _link_args(self, mr, key, child, given):
        """A map's tree's inputs: from, to and target given (those it has), the rest its link's formulas now; None
        when one isn't there."""
        args = {k: v for k, v in given.items() if k in child.inputs}
        for name in child.inputs:
            if name not in args:
                v = self._formula(self.mname(mr.id, f'link {key} arg {name}'))
                if v is None:
                    return None
                args[name] = v
        return args

    def _link(self, st, mr, level, x, y):
        """The link a Go to node is doing: running, or ended (worked, or failed) once the player is at its place or not."""
        lid, link = st['link'], mr.links[st['link']]
        t = self.now - st['start']
        limit = max(mr.link_ms, link.get('ms', 0) + mr.arrive_ms + 1000) if link.get('recorded') else mr.link_ms
        bounds = self._bounds(mr, link, st.get('forced')) if link.get('recorded') else []
        limit += len(bounds) * (SYNC_SLACK_MS + 500)  # its waits may run past their recorded times
        if t > limit and st['phase'] != 'finish':
            return self._fail_link(st, mr, f'it took over {limit / 1000:g} s', 'timeout')
        to = mr.name(link['to'])
        if st['phase'] == 'act':
            if link.get('kind') == 'tree':
                r = self._step_child(st['child'])
                if r == 'failure':
                    st.pop('child', None)
                    return self._fail_link(st, mr, 'its tree failed', 'tree')
                if r == 'success':
                    st.pop('child', None)
            elif link.get('kind') == 'keys':  # held until the player is there
                if mr.at(level, x, y) != link['to']:
                    action = f'holding {"+".join(link["keys"])}' if link['keys'] else 'waiting with keys released'
                    if t > mr.keys_ms(lid):
                        return self._fail_link(st, mr, f'not there after {t / 1000:.1f} s {action}', 'timeout')
                    self.keys |= set(link['keys'])
                    self._map_status(mr, st, st['at'], st['dest'], f'{action} to {to}')
                    return 'running'
                r = 'success'
            else:
                if link.get('recorded') and st.get('playing'):
                    failure = self._monitor_movement(st, link, level, x, y)
                    if failure:
                        return self._fail_link(st, mr, failure, 'deviation')
                if bounds:
                    r = self._play_parts(st, mr, link, bounds, mr.control.played(link, self.clips[f'link:{lid}']), f'its clip to {to}', level, x, y)
                    if r.endswith('-failed'):
                        return self._fail_link(st, mr, st.pop('syncWhy'), r.split('-')[0])
                else:
                    r = self._play_clip(st, mr.control.played(link, self.clips[f'link:{lid}']), f'its clip to {to}')
                if link.get('recorded') and self.action is not None:
                    self.action['supervised'] = True
                if r == 'failure':
                    execution = self.shared.get('execution') or {}
                    ended = execution.get('cause') or execution.get('error') or execution.get('state') or ''
                    return self._fail_link(st, mr, 'its clip was cancelled or failed' + (f' ({ended})' if ended else ''), 'executor')
            if r == 'running':
                self._map_status(mr, st, st['at'], st['dest'], f'to {to}')
                return r
            st.update(phase='arrive', acted=self.now)
        here = mr.at(level, x, y)
        fin = mr.control.completion(link)
        if fin is not None:
            r = mr.control.complete(self, st, link, fin, level, x, y, t)  # its terminal correction (Controller.complete)
            if r is not None:
                st['phase'] = 'finish'
                if 'running' in r:
                    self._map_status(mr, st, st['at'], st['dest'], r['running'])
                    return 'running'
                if 'fail' in r:
                    return self._fail_link(st, mr, r['fail'], 'finish')
                return self._arrived(st, mr, link, mr.at(level, x, y), x, y, t, r['done'])
            # not landed on the line it ends on (yet): its arrival is any movement's
        arrived = here == link['to']
        if link.get('recorded'):
            ex, ey = link['end']
            shift = st.get('shiftX') or 0.0
            if abs(shift) > 0.5:
                # a jump pressed `shift` px from where it was recorded lands, and goes on, that much aside: there is
                # where it ends (the map plans from there, lining up with its next movement)
                arrived = math.hypot(x - ex - shift, y - ey) <= mr.replay['arrivePx']
            else:
                arrived = arrived and math.hypot(x - ex, y - ey) <= mr.replay['arrivePx']
            if not arrived:
                st.pop('endStill', None)
            else:
                arrived = self._settled(st, 'endStill', x, y, mr.replay['stillMs'])
        if arrived:
            return self._arrived(st, mr, link, here, x, y, t, 'direct' if link.get('recorded') else None)
        if self.now - st['acted'] > mr.arrive_ms:
            d = math.hypot(mr.places[link['to']]['x'] - x, mr.places[link['to']]['y'] - y)
            near = mr.control.recoverable(link, level, x, y, st.get('shiftX') or 0.0, d)
            if near:
                # it got there, not to the pixel: what the movement did is learned once lining up says whether it
                # could be put right (_resolve_arrival), not counted as a failed movement now
                return self._fail_link(st, mr, f'it ended {d:.0f} px from {to}, {near}', 'arrival', pending=d)
            return self._fail_link(st, mr, f'it ended {d:.0f} px from {to}', 'arrival')
        self._map_status(mr, st, here, st['dest'], f'arriving at {to}')
        return 'running'

    def _arrived(self, st, mr, link, here, x, y, t, arrival=None):
        """A link that worked: learned, said (with how a recorded movement arrived: 'direct', or 'corrected' by its
        terminal correction), and let go of; the Go node plans on from there."""
        lid = st['link']
        mr.learn(lid, True, t)
        self._attempt_ended(st, mr, lid, True, None, None, t, arrival=arrival)
        if link.get('recorded') and (abs(st.get('shiftX') or 0.0) > 0.5 or here != link['to']):
            # at its place, though aside from it (see _go): a jump pressed aside from its recording, or within Arrive
            # within of its end but outside its place's reach (Start within), so the map goes on from its destination
            st['shifted'] = {'place': link['to'], 'at': [x, y]}
        for k in ('link', 'phase', 'child', 'playing', 'length', 'action_id', 'endStill', 'monitor', 'monitoredAt', 'deviatedSince', 'attempt', 'forced', 'finish', *SEGMENT_STATE, *mr.control.STATE):
            st.pop(k, None)
        st['start'] = self.now
        self._map_status(mr, st, here, st['dest'], f'at {mr.name(link["to"])}')
        return 'success'

    def _monitor_movement(self, st, link, level, x, y):
        execution = self.shared.get('execution')
        observed = self.shared['observation_time']
        if execution is not None:
            if execution.get('id') != st.get('action_id') or execution.get('state') != 'running':
                return None
            started = execution.get('startedAt')
            if not isinstance(started, (int, float)) or not math.isfinite(started):
                return None  # cannot align this frame; main-process feedback timeout applies
        else:
            started = st['start']
        if observed < started or observed <= st.get('monitoredAt', -math.inf):
            return None
        st['monitoredAt'] = observed
        # in parts (waiting for a State), each part's live time maps onto the recording's from where it began: the moment
        # the State turned true (its frame), at the part's recorded start
        live0, rec0 = st.get('anchor') or (None, 0.0)
        until = st['segs'][st['seg']]['until'] if st.get('segs') else link['ms']  # held at the part's end while it waits
        elapsed = min(link['ms'], until, rec0 + observed - (started if live0 is None else live0))
        path = link.get('trajectory') or []
        if not path:
            return 'recorded trajectory is missing; reload the map before replay'
        # after a jump pressed aside from where it was recorded, the rest of the path is that much aside too
        distance, expected = deviation(path, elapsed, level, x - (st.get('shiftX') or 0.0), y)
        okay = distance <= MONITOR_DISTANCE_PX
        st['monitor'] = {'actionId': st.get('action_id'), 'observedAt': observed, 'elapsedMs': round(elapsed, 1),
                         'errorPx': round(distance, 1) if math.isfinite(distance) else None,
                         'expected': expected, 'actual': [x, y], 'state': 'tracking' if okay else 'suspect'}
        if okay:
            st.pop('deviatedSince', None)
            return None
        since = st.setdefault('deviatedSince', observed)
        if observed - since < MONITOR_CONFIRM_MS:
            return None
        st['monitor']['state'] = 'failed'
        detail = f'{distance:.0f} px from its recorded path' if math.isfinite(distance) else 'on a different level from its recorded path'
        return f'movement deviated {elapsed / 1000:.2f} s into replay: {detail} for {observed - since:.0f} ms; remaining inputs cancelled'

    def _bounds(self, mr, link, forced=False):
        """Where a recorded movement is cut into parts, each part after the first starting on its trigger: [{at, kind,
        ...}] in time order, `at` ms into the clip. 'sync': where it waited for the map's Wait for State (its `syncs`).
        Any other kind is its controller's (Controller.triggers, with `forced`: taken though marked unsafe, there being
        no other way), sent when the controller says (Controller.trigger); one at a wait's moment replaces the wait."""
        out = []
        if link.get('syncs') and mr.replay['sync']:
            out += [{**s, 'kind': 'sync'} for s in link['syncs']]
        for t in mr.control.triggers(link, forced):  # its controller's, each replacing a wait at its moment
            out = [b for b in out if abs(b['at'] - t['at']) > 1]
            out.append(t)
        return sorted(out, key=lambda b: b['at'])

    def _segments(self, clip, bounds):
        """A recorded movement in parts, cut at `bounds` (_bounds): each {from, until, line, ms, keep, recorded, held,
        trigger}: its presses from the part's start (the keys held as it begins, down at 0, so they stay down: the
        first `held` of its line), how long it plays (to its last press, but the last part to the movement's end), the
        keys it leaves held for the wait after it, each press's time in the recording, and what starts it (its bound;
        None for the first)."""
        full = [[0.0, k, True] for k in clip['keys']] + [list(e) for e in clip['timeline']]
        cuts = [0.0, *(b['at'] for b in bounds), clip['end']]
        out = []
        for i in range(len(cuts) - 1):
            b0, b1, last = cuts[i], cuts[i + 1], i == len(cuts) - 2
            held = set(clip['keys']) if i == 0 else self._held(clip['keys'], clip['timeline'], b0 - 0.001)
            own = [e for e in full if b0 <= e[0] < b1 or (last and e[0] == b1)]
            if i:
                own = [[b0, k, True] for k in sorted(held)] + own
            line = [[round(at - b0, 1), k, d] for at, k, d in own]
            keep = [] if last else sorted(self._held(clip['keys'], clip['timeline'], b1 - 0.001))
            ms = (b1 - b0) if last else max([at for at, _, _ in line] + [0.0])
            out.append({'from': b0, 'until': b1, 'line': line, 'ms': round(ms, 1), 'keep': keep, 'recorded': [round(at, 1) for at, _, _ in own],
                        'held': len(held) if i else 0, 'trigger': bounds[i - 1] if i else None})
        return out

    def _play_parts(self, st, mr, link, bounds, clip, text, level, x, y):
        """A recorded movement in parts (_segments): each part plays on the guard's clock, keeping the keys held that
        the recording held through the wait after it; the next starts on its trigger. A wait for the map's Wait for
        State (such as On Ground): once it has been false and then true (in that order) since the part before began,
        its presses as long after that moment as they were after it in the recording (a press timed by the clock
        could reach the game before a landing a little later than recorded, which the game ignores). Any other
        trigger is its controller's: once Controller.trigger says, its presses from then as long after it as they were
        in the recording. A wait past its recorded time and SYNC_SLACK_MS (or half as long again, and what the
        controller allows, extra_ms) has failed: '<kind>-failed', why in st['syncWhy']; so has a trigger its controller
        says can't come any more."""
        if 'segs' not in st:
            st.update(segs=self._segments(clip, bounds), seg=0, anchor=(None, 0.0), sawFalse=False, waiting=None, rose=None,
                      segStart=self.now)
            if not st['segs'][0]['line']:  # it starts on a trigger: nothing to play before it
                st['waiting'] = self.now
        segs, k = st['segs'], st['seg']
        seg = segs[k]
        nxt = segs[k + 1] if k + 1 < len(segs) else None
        v = self._formula(self.mname(mr.id, 'sync')) if mr.replay['sync'] else None
        # the wait's own turning false and true: seen after the key that led to it (its `after`) went, when that's in
        # this part, so an earlier landing in the same part isn't taken for the one it waits for
        observed = self.shared['observation_time']
        gate = self._sync_gate(st, seg, nxt)
        if v is False and (gate is None or observed >= gate):
            st['sawFalse'] = True
            st['rose'] = None
            st.pop('pendingTransition', None)
        elif v is True and st['sawFalse'] and st['rose'] is None and nxt and nxt['trigger']['kind'] == 'sync':
            # the turning true is pending until a reading says where it was (Controller.confirms): confirmed at its
            # expected destination, it counts from the moment it turned true; a reading the controller is certain is
            # elsewhere rejects it at once, and none confirming it within TRANSITION_CONFIRM_MS does too (a reading it
            # can't be certain of, as the position can lag the State by a frame, says nothing yet)
            first = st.setdefault('pendingTransition', observed)
            valid, reason, certain = self._sync_destination(mr, nxt['trigger'], level, x, y)
            st['syncDestination'] = reason
            if valid:
                st['rose'] = first
                st.pop('pendingTransition')
            elif certain or observed - first > TRANSITION_CONFIRM_MS:
                if not certain:
                    st['syncDestination'] = f'{reason} (no reading put it there within {TRANSITION_CONFIRM_MS} ms of landing)'
                st['sawFalse'] = False  # a different transition: a new false/true pair is needed
                st.pop('pendingTransition')
        mr.control.frame(self, st, level, x, y)
        if st['waiting'] is None:
            phase = self._play(st, seg['line'], seg['ms'], keep=seg['keep']) if seg['line'] else None
            if k == 0 and not st.get('segSaid'):
                st['segSaid'] = True
                self._segment_said(st, 0)
            if phase in ('cancelled', 'failed'):
                return 'failure'
            # A part whose presses all go at its start (such as a key pressed on a landing, then held into a jump) is
            # done once it's sent: its trigger is looked at in this same update rather than after the guard says it
            # completed, a frame later. The user's last jump waited that frame and was past its safe stretch by then,
            # twice. If its trigger comes in this update too, only the next part is sent: its presses at 0 hold the
            # keys this one leaves held, and the guard starts an action with exactly those down (keys already down stay
            # down), so the keys go as they would have, in order, with no let-go between
            instant = nxt is not None and seg['ms'] <= 0 and bool(seg['line'])
            if instant and self.sequence is not None and st.get('action_id') is not None:
                st['sentAt'] = (self.frame, k, st['action_id'])
            done = instant or phase == 'completed' or (phase is None and self.now - st['segStart'] >= seg['ms'])
            if not done:
                # the keys its presses hold now (as a clip's are said; offline, held a frame at a time)
                self.keys |= self._held(set(), seg['line'], self.now - st['segStart'])
                self.texts.append(f'{text} part {k + 1}/{len(segs)}')
                return 'running'
            if nxt is None:
                return 'success'
            st['waiting'] = self.now
            for key in ('playing', 'length', 'action_id'):
                st.pop(key, None)
        # waiting for its trigger, the recording's held keys held
        self.keys |= set(seg['keep'])
        trigger = nxt['trigger']
        span = nxt['from'] - seg['from']
        allowed = span + max(SYNC_SLACK_MS, span / 2)
        for extra in mr.control.extra_ms(st):  # what its controller's trigger may take longer (Controller.extra_ms)
            allowed += extra
        overdue = self.now - st['segStart'] > allowed
        if trigger['kind'] != 'sync':  # its controller's (Controller.trigger)
            d = mr.control.trigger(self, st, seg, trigger, level, x, y, overdue, span)
            if 'wait' in d:
                self.texts.append(f'{text}: {d["wait"]} (part {k + 1}/{len(segs)})')
                return 'running'
            if 'fail' in d:
                st['syncWhy'] = d['fail']
                return f'{trigger["kind"]}-failed'
            st['shiftX'] = d['offset']
            anchor, shift = self.now + d['lead'], d['lead']
        else:
            valid, reason, certain = self._sync_destination(mr, trigger, level, x, y)
            if st['rose'] is not None and (v is not True or (not valid and certain)):
                st['rose'] = None
                st['sawFalse'] = v is False
                st['syncDestination'] = reason
            if st['rose'] is None:
                if overdue:
                    cond = mr.replay['sync']
                    gate = self._sync_gate(st, seg, nxt)
                    st['syncWhy'] = (f'waited {self.now - st["segStart"]:.0f} ms for {cond} to turn ' + ('true' if st['sawFalse'] else 'false and then true')
                                     + (f' after {trigger.get("afterKey")} went' if gate is not None else '')
                                     + f' at its expected destination (part {k + 1} of {len(segs)}; it did after {span:.0f} ms in the recording)'
                                     + (f': {st["syncDestination"]}' if st.get('syncDestination') else ''))
                    self._said('sync', st, index=k + 1, worked=False, why=st['syncWhy'], waitedMs=round(self.now - st['waiting'], 1))
                    return 'sync-failed'
                self.texts.append(f'{text}: waiting for {mr.replay["sync"]} (part {k + 1}/{len(segs)})')
                return 'running'
            # it turned true: the next part, its presses as long after that moment as in the recording
            late = max(0.0, self.now - st['rose'])
            self._said('sync', st, index=k + 1, worked=True, waitedMs=round(self.now - st['waiting'], 1), lateMs=round(late, 1),
                       transitionAt=round(st['rose'], 1), recordedAt=nxt['from'])
            anchor, shift = st['rose'], -late
        # the keys held through the wait stay down at its start; the rest moved by `shift`
        line = [e if n < nxt['held'] else [max(0.0, round(e[0] + shift, 1)), e[1], e[2]] for n, e in enumerate(nxt['line'])]
        last = k + 1 == len(segs) - 1
        sent = st.pop('sentAt', None)
        st.update(seg=k + 1, anchor=(anchor, nxt['from']), sawFalse=False, waiting=None, rose=None, segStart=self.now, syncDestination=None)
        mr.control.next_part(st)
        self._play(st, line, max(0.0, round(nxt['ms'] + shift, 1)) if last else max([e[0] for e in line] + [0.0]), keep=nxt['keep'])
        if sent and sent[:2] == (self.frame, k):  # the part before went out in this update too: this one carries it
            self._said('segment-merged', st, index=k, into=k + 1, actionId=sent[2])
        self._segment_said(st, k + 1)
        if nxt['ms'] <= 0 and nxt['line'] and k + 2 < len(segs):
            # a part whose presses all go at its start, with a trigger after it: on to that trigger in this update
            return self._play_parts(st, mr, link, bounds, clip, text, level, x, y)
        self.texts.append(f'{text} part {k + 2}/{len(segs)}')
        return 'running'

    def _sync_destination(self, mr, trigger, level, x, y):
        """A State transition is useful only at its recorded destination, on its level, as the map's controller judges
        it (Controller.confirms: within Arrive within of it, or with a model, say, on the same ground line). The
        configured sync formula still supplies additional State constraints (for example grounded and not climbing)."""
        expected = trigger.get('expected')
        if not expected:
            return False, 'the wait has no recorded destination; reload the map', True
        if expected['level'] != level:
            return False, 'the State changed on a different level', True
        ex, ey = expected['position']
        okay, certain = mr.control.confirms(level, x, y, ex, ey)
        return okay, None if okay else f'the State changed away from the expected destination ({ex:.0f}, {ey:.0f})', certain

    def _sync_gate(self, st, seg, nxt):
        """When the key a wait belongs to went in play (the next part's trigger's `after`, mapped from the recording's
        time onto this part's live clock), if it's in the part playing now; else None (any turning since it began)."""
        if not nxt or nxt['trigger']['kind'] != 'sync' or nxt['trigger'].get('after') is None:
            return None
        after = nxt['trigger']['after']
        if not seg['from'] <= after < seg['until']:
            return None
        live0, rec0 = st.get('anchor') or (None, 0.0)
        return (st['segStart'] if live0 is None else live0) + (after - rec0)

    def _said(self, kind, st, **fields):
        self.shared.setdefault('events', []).append({'kind': kind, 'attempt': st.get('attempt'), **fields})

    def _segment_said(self, st, k):
        """For the trace: a part begun, with its action and each press's time in the recording, and where its live time
        maps onto the recording's (the moment the State turned true, the part's recorded start; None: its action's start)."""
        seg = st['segs'][k]
        self._said('segment', st, index=k, actionId=st.get('action_id'), recorded=seg['recorded'],
                   anchor=[None if st['anchor'][0] is None else round(st['anchor'][0], 1), st['anchor'][1]])

    def _settled(self, st, name, x, y, still_ms=STILL_MS):
        old = st.get(name)
        if old is None or math.hypot(x - old[1], y - old[2]) > 1:
            st[name] = (self.now, x, y)
            return False
        return self.now - old[0] >= still_ms

    def _line_up(self, nid, st, mr, at, dest, x, y, sx, sy, level=None, start_px=None):
        """Before a recorded movement: the player further from its recorded start than the map's startPx is tapped
        toward it, with the map's keys each way, one tap at a time, standing still in between (positioning.TapPositioner). None once
        within startPx (the movement can start); else 'running', or the Go node's failure, saying how close it got and
        the least a tap moved it."""
        lu, start_px = mr.replay['lineUp'], (mr.replay['startPx'] if start_px is None else start_px)
        off = mr.control.distance(level, x, y, sx, sy)
        where = f'the recorded start ({sx:.0f}, {sy:.0f})'
        if lu is None or (off > lu['range'] and not st.get('lineUp')):
            st.pop('lineUp', None)
            how = 'set its keys under Line up with taps, or record a pause there' if lu is None else f'it lines up from within {lu["range"]:.0f} px'
            self._map_status(mr, st, at, dest, f'{off:.0f} px from {where}; a replay starts within {start_px:g} px ({how})')
            return self._ended(nid, 'failure')
        s = st.setdefault('lineUp', mr.control.positioner(self).begin(x, y))

        def said(worked, why=None):  # for the trace: how lining up went (and a movement waiting on it)
            if not worked:
                self._resolve_arrival(st, mr, False, f'lining up failed: {why}')
            self.shared.setdefault('events', []).append({
                'kind': 'line-up', 'map': mr.id, 'target': [sx, sy], 'from': s['from'], 'to': [x, y], 'offPx': round(off, 1), 'taps': s['taps'],
                'worked': worked, **({'why': why} if why else {}), **({'alongLine': True} if s.get('along') else {})})
        r = mr.control.positioner(self).step(s, level, x, y, sx, sy, start_px)
        if r['state'] == 'running':
            self._map_status(mr, st, at, dest, f'lining up with {where}: {r["text"]}')
            return 'running'
        st.pop('lineUp', None)
        if r['state'] == 'failed':
            said(False, r['why'])
            self._map_status(mr, st, at, dest, f'lining up with {where}: {r["why"]}' if r['kind'] in ('tap', 'still')
                             else f'couldn’t line up with {where} within {start_px:g} px: {r["why"]}')
            return self._ended(nid, 'failure')
        said(True)
        self._resolve_arrival(st, mr, True, f'lined up in {s["tries"]} tap{"s" if s["tries"] != 1 else ""}')
        self.texts.append(f'lined up with {where}, {off:.1f} px off, in {s["tries"]} tap{"s" if s["tries"] != 1 else ""}')
        return None

    def _attempt_began(self, st, mr, lid, link, level, x, y):
        """A link attempt begun, for the trace: which link, from where, and for a recorded movement what it replays
        (its clip and recorded trajectory), so a report can compare the replay with the recording from the trace alone."""
        attempt = self.shared['attempts'] = self.shared.get('attempts', 0) + 1
        st['attempt'] = attempt
        event = {'kind': 'link', 'attempt': attempt, 'map': mr.id, 'link': lid, 'linkKind': link.get('kind'),
                 'from': link.get('from'), 'to': link.get('to'), 'position': [x, y], 'level': level}
        if link.get('recorded'):
            event['recorded'] = {k: link.get(k) for k in ('clip', 'start', 'end', 'ms', 'trajectory', 'syncs', *mr.control.ANNOTATIONS) if k in link}
            event.update(mr.control.attempt_info(link, st.get('forced')))  # how its controller plays it, and by what model
        self.shared.setdefault('events', []).append(event)

    def _attempt_ended(self, st, mr, lid, worked, cause, why, ms, pending=False, arrival=None):
        """How a link attempt ended, for the trace: worked (a recorded movement's `arrival`: 'direct', or 'corrected' by
        its terminal correction), or its failure's cause (deviation, arrival, finish, timeout, tree, executor, feedback,
        input) and reason."""
        seen = st.get('seenAt')
        self.shared.setdefault('events', []).append({
            'kind': 'link-end', 'attempt': st.get('attempt'), 'map': mr.id, 'link': lid, 'worked': worked, 'ms': round(ms, 1),
            **({'cause': cause, 'why': why} if not worked else {}), **({'pending': True} if pending else {}), **({'arrival': arrival} if arrival else {}),
            **({'actionId': st['action_id']} if st.get('action_id') is not None else {}),
            **({'position': [seen[0], seen[1]], 'level': seen[2]} if seen else {})})

    def _resolve_arrival(self, st, mr, worked, how):
        """A movement that reached its platform but not its place (Controller.recoverable), once lining up has said whether
        it could be put right: learned as worked, its time with the correction's, or as failed. Said in the trace
        (`link-recovered`, the attempt it belongs to)."""
        p = st.pop('pendingArrival', None)
        if p is None:
            return
        if worked:
            seen = st.get('seenAt')
            link = mr.links[p['lid']]
            endpoint = p.get('endpoint', link['end'])
            level = mr.places[link['to']].get('level')
            worked = bool(seen and seen[2] == level and
                          mr.control.distance(level, *seen[:2], *endpoint) <= mr.replay['arrivePx'])
            if not worked:
                how = 'returned to the start for a retry' if seen and seen[2] == mr.places[link['from']].get('level') and (
                    mr.control.distance(seen[2], *seen[:2], *link['start']) <= mr.replay['startPx']) else 'alignment did not reach the intended endpoint'
        ms = p['ms'] + (self.now - p['since'] if worked else 0.0)
        mr.learn(p['lid'], worked, ms)
        self.shared.setdefault('events', []).append({'kind': 'link-recovered', 'attempt': p['attempt'], 'map': mr.id, 'link': p['lid'],
                                                     'worked': worked, 'offPx': round(p['off'], 1), 'how': how, 'ms': round(ms, 1)})

    def _fail_link(self, st, mr, why, cause, pending=None):
        """A link that failed: learned as failed, said, and let go of. `pending` (px off): a movement that reached its
        platform but not its place, learned only once lining up says (_resolve_arrival)."""
        lid = st['link']
        link = mr.links[lid]
        seen = st.get('seenAt')
        if seen:
            mr.control.ending(self, st, seen)
        self._resolve_arrival(st, mr, False, 'another link began before it was lined up')
        if pending is None:
            mr.learn(lid, False, self.now - st['start'])
        else:
            st['pendingArrival'] = {'lid': lid, 'ms': self.now - st['start'], 'attempt': st.get('attempt'), 'off': pending, 'since': self.now,
                                    'endpoint': [link['end'][0] + (st.get('shiftX') or 0.0), link['end'][1]]}
        self._attempt_ended(st, mr, lid, False, cause, why, self.now - st['start'], pending=pending is not None)
        if st.get('child') is not None:
            self._stop_child(st['child'])
        if link.get('recorded'):
            # let go of everything, this frame's held keys too (a part's keys held through a wait stayed down for the
            # frame it failed in), and plan again only once the player has landed and stopped (_go_step)
            self.keys.clear()
            self.cancel = True
            self.sequence = None
            self.action = None
            st['settle'] = {'since': self.now, 'why': f'the link from {mr.name(link["from"])} to {mr.name(link["to"])} failed ({cause})'}
        elif self._playing(st) or ((st.get('finish') or {}).get('tapping') and self._playing(st['finish']['tapping'])):
            self.cancel = True
        for k in ('link', 'phase', 'child', 'playing', 'length', 'action_id', 'endStill', 'startStill', 'settlingSince', 'attempt', 'forced', 'finish', *SEGMENT_STATE, *mr.control.STATE):
            st.pop(k, None)
        st['last'] = f'the link from {mr.name(link["from"])} to {mr.name(link["to"])} failed: {why}'
        st['lastCause'] = cause
        self._map_status(mr, st, None, st.get('dest'), st['last'])
        return 'failure'

    def _map_status(self, mr, st, at, dest, text):
        self.map_statuses[mr.id] = {'at': at, 'dest': dest, 'way': st.get('way') if st.get('link') else None, 'link': st.get('link'),
                                    'fails': dict(mr.fails), 'text': text, **({'last': st['last'], 'lastCause': st.get('lastCause')} if st.get('last') else {}),
                                    **({'position': list(st['seenAt'][:2]), 'level': st['seenAt'][2]} if st.get('seenAt') else {}),
                                    **({'attempt': st['attempt']} if st.get('link') and st.get('attempt') else {}),
                                    **({'monitor': st['monitor']} if st.get('monitor') else {})}
        self.texts.append(text)
