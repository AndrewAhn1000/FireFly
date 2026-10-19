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

A map (src/mapModel.ts) is places ({id, name, level, x, y}) and links between them ({id, from, to, kind: clip | tree,
...}), with `position` and `level` formulas saying where the player is and on which level, and `reach`, how near a place
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

from formulas import FormulaSet, Missing
from observations import level_key

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
        self.links = {l['id']: l for l in doc.get('links') or [] if isinstance(l, dict) and l.get('from') in self.places and l.get('to') in self.places}
        self.reach = float(doc.get('reach') or REACH)
        self.give_up = int(doc.get('giveUp') or GIVE_UP)
        self.link_ms = float(doc.get('linkMs') or LINK_MS)
        self.arrive_ms = float(doc.get('arriveMs') or ARRIVE_MS)
        self.stats = {lid: dict(s) for lid, s in (stats or {}).items() if lid in self.links}
        self.fails = {}
        self.changed = False

    def name(self, pid):
        p = self.places.get(pid)
        return (p.get('name') or 'a place') if p else 'nowhere'

    def on_level(self, level):
        return [p for p in self.places.values() if (p.get('level') or None) == level]

    def nearest(self, level, x, y):
        here = self.on_level(level)
        if not here:
            return None, math.inf
        p = min(here, key=lambda q: math.hypot(q['x'] - x, q['y'] - y))
        return p['id'], math.hypot(p['x'] - x, p['y'] - y)

    def at(self, level, x, y):
        pid, d = self.nearest(level, x, y)
        return pid if d <= self.reach else None

    def cost(self, lid, clips):
        link, s = self.links[lid], self.stats.get(lid) or {}
        ms = s.get('ms') or link.get('ms') or ((clips.get(f'link:{lid}') or {}).get('end')) or LINK_COST
        chance = (s.get('runs', 0) - s.get('fails', 0) + 1) / (s.get('runs', 0) + 2)  # how often it worked, a fair coin to start
        return float(ms) / max(0.05, chance)

    def route(self, start, goal, clips):
        """The quickest way from place `start` to `goal`, as link ids, over links not given up on (None: none)."""
        best, queue, via = {start: 0.0}, [(0.0, start)], {}
        out = {}
        for lid, l in self.links.items():
            if self.fails.get(lid, 0) < self.give_up:
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
        s = self.stats.setdefault(lid, {'runs': 0, 'fails': 0})
        s['runs'] += 1
        if worked:
            s['ms'] = round(ms if not s.get('ms') else 0.7 * s['ms'] + 0.3 * ms, 1)
        else:
            s['fails'] += 1
            self.fails[lid] = self.fails.get(lid, 0) + 1
        self.changed = True


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
                            | {o for c in [*self.runs.values(), *self.link_trees.values()] if c is not None for o in c.reads})
        own = {k for n in nodes.values() for key in ('keys', 'less', 'more') for k in n['params'].get(key) or []}
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
        self.tree_statuses, self.map_statuses = {}, {}

    def tick(self, now, values):
        """One frame: the keys to hold, presses for the guard to play from now ([] to stop what it plays, None
        for neither), each node reached and how it answered (`nodes`, and in the trees it ran, `trees` by graph id),
        each map gone over (`maps`: where the player is, the way, the link running, failures), what's running, and the
        tree's ending once it ends (not looping)."""
        self.now = now
        self.frame += 1
        self.frames = [values, *self.frames][:HISTORY]
        self._begin_frame()
        if self.done is None:
            r = self._tick(self.root)
            if r != 'running':
                if self.nodes[self.root]['params'].get('loop', True):
                    self._halt(self.root)
                else:
                    self.done = r
        sequence = self.sequence if self.sequence is not None else ([] if self.cancel else None)
        return {'keys': self.keys, 'sequence': sequence, 'nodes': self.statuses, 'trees': self.tree_statuses, 'maps': self.map_statuses,
                'text': ' · '.join(self.texts) or None, 'done': self.done}

    def seen(self):
        """The values of the observations its formulas read, this frame (for its trace)."""
        out = {}
        for name in self.reads:
            o = (self.frames[0] if self.frames else {}).get(name)
            out[name] = o.get('value') if o and o.get('valid') else None
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
        if st and st.get('playing') and self.now - st.get('start', self.now) < st.get('length', 0):
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

    def _play(self, st, line, length):
        """Presses for the guard to play, once, from when the node started."""
        if not st.get('playing'):
            self.sequence = [list(e) for e in line]
            st['playing'], st['length'] = True, length

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
        self._play(st, line, p['ms'])
        if t >= p['ms']:
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
        self._play(st, [[0.0, k, True] for k in clip['keys']] + clip['timeline'], clip['end'])
        if t >= clip['end']:
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
        mr = self.shared['maps'][p['map']]
        pos = self._formula(self.mname(mr.id, 'position'))
        if pos is None:
            self._map_status(mr, st, None, None, 'the player’s position isn’t there')
            return 'running' if st.get('link') else self._ended(nid, 'failure')
        level = None
        if (mr.doc.get('level') or '').strip():
            raw = self._formula(self.mname(mr.id, 'level'))
            level = level_key(list(raw) if isinstance(raw, tuple) else raw) if raw is not None else None
        x, y = float(pos[0]), float(pos[1])
        if st.get('link'):
            r = self._link(st, mr, level, x, y)
            if r == 'running':
                return r
            return 'running'  # the link ended: plan again on the next frame
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
            dest = p['place']
        else:
            target = self._check(nid, 'target')
            dest = mr.nearest(level, float(target[0]), float(target[1]))[0] if target is not None else None
            if dest is None:
                self._map_status(mr, st, None, None, 'its target isn’t there, or no place on this level')
                return self._ended(nid, 'failure')
        at = mr.at(level, x, y)
        if at == dest:
            self._map_status(mr, st, at, dest, f'at {mr.name(dest)}')
            return self._ended(nid, 'success')
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
        way = mr.route(at, dest, self.clips)
        if not way:
            out = [lid for lid, n in mr.fails.items() if n >= mr.give_up]
            self._map_status(mr, st, at, dest, f'no way from {mr.name(at)} to {mr.name(dest)}' + (f' ({len(out)} link{"s" if len(out) != 1 else ""} given up on)' if out else ''))
            return self._ended(nid, 'failure')
        lid = way[0]
        link = mr.links[lid]
        st.update(link=lid, way=way, phase='act', start=self.now, playing=False, at=at, dest=dest)
        if link.get('kind') == 'tree':
            child = self.link_trees[(mr.id, lid)]
            args = self._link_args(mr, lid, child, {'from': (mr.places[link['from']]['x'], mr.places[link['from']]['y']),
                                                    'to': (mr.places[link['to']]['x'], mr.places[link['to']]['y'])})
            if args is None:
                self._fail_link(st, mr, 'an input of its tree isn’t there')
                return 'running'
            self._start_child(child, args)
            st['child'] = child
        r = self._link(st, mr, level, x, y)
        return 'running'

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
        if t > mr.link_ms:
            return self._fail_link(st, mr, f'it took over {mr.link_ms / 1000:g} s')
        to = mr.name(link['to'])
        if st['phase'] == 'act':
            if link.get('kind') == 'tree':
                r = self._step_child(st['child'])
                if r == 'failure':
                    st.pop('child', None)
                    return self._fail_link(st, mr, 'its tree failed')
                if r == 'success':
                    st.pop('child', None)
            else:
                r = self._play_clip(st, self.clips[f'link:{lid}'], f'its clip to {to}')
            if r == 'running':
                self._map_status(mr, st, st['at'], st['dest'], f'to {to}')
                return r
            st.update(phase='arrive', acted=self.now)
        here = mr.at(level, x, y)
        if here == link['to']:
            mr.learn(lid, True, t)
            for k in ('link', 'phase', 'child', 'playing', 'length'):
                st.pop(k, None)
            st['start'] = self.now
            self._map_status(mr, st, here, st['dest'], f'at {to}')
            return 'success'
        if self.now - st['acted'] > mr.arrive_ms:
            d = math.hypot(mr.places[link['to']]['x'] - x, mr.places[link['to']]['y'] - y)
            return self._fail_link(st, mr, f'it ended {d:.0f} px from {to}')
        self._map_status(mr, st, here, st['dest'], f'arriving at {to}')
        return 'running'

    def _fail_link(self, st, mr, why):
        lid = st['link']
        link = mr.links[lid]
        mr.learn(lid, False, self.now - st['start'])
        if st.get('child') is not None:
            self._stop_child(st['child'])
        if st.get('playing') and self.now - st.get('start', self.now) < st.get('length', 0):
            self.cancel = True
        for k in ('link', 'phase', 'child', 'playing', 'length'):
            st.pop(k, None)
        st['last'] = f'the link from {mr.name(link["from"])} to {mr.name(link["to"])} failed: {why}'
        self._map_status(mr, st, None, st.get('dest'), st['last'])
        return 'failure'

    def _map_status(self, mr, st, at, dest, text):
        self.map_statuses[mr.id] = {'at': at, 'dest': dest, 'way': st.get('way') if st.get('link') else None, 'link': st.get('link'),
                                    'fails': dict(mr.fails), 'text': text, **({'last': st['last']} if st.get('last') else {})}
        self.texts.append(text)
