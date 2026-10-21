"""Where play heads over a map (src/mapModel.ts): its places and links, and the places and moves learned on a grid from
the player's own recordings (a map's Learn a grid), with nothing known about any game.

Places are cells of the world, `cell` px a side (per level, when a Level observation tells levels apart), each at
where the player actually was in it (the mean of their positions there). A move is the player going from one cell to
the next in a recording: its time (the median of the times spent crossing the cell it left) and the keys held as the
player left it (what took them on, not standing about first). To head for a destination, the time to get there is worked out once from every place (Dijkstra, over the
moves backwards); each frame, play follows the quickest moves from where the player is for `aheadS` seconds, and
that place is its target, so play's targets are like training's: where to get to next, not somewhere far off.

Off every known place (a fall, a start somewhere new), the player is at the nearest place not above them (a player
walks or drops to one but can't rise to it), else the nearest. Moves are only those made: a place reached by a move
no recording made can't be planned to.

A map's own places and links (`merge`) join the grid's: a link costs what it took when it last worked (else its own
time, else its clip's length, else LINK_MS) over how often it has worked, as a behaviour tree's Go to weighs it."""
import heapq
import math
from collections import Counter, defaultdict

CELL = 40           # px, a place's side unless the node says otherwise
GAP_MS = 500        # samples further apart than this aren't one move
STEP = 40           # px above the player a place can be and still count as on their level (as the route's)
MAX_DRAWN = 6000    # places and moves in a preview
FIELDS_KEPT = 256   # destinations whose times are kept (training asks for one per place it reached)
HINT_CAP = 400      # px: how far along the way the plan's next keys are looked for (further reads as this)
FAILED_COST = 4     # a move that didn't happen in play costs this many times as much from then on
KEEP_AWAY_PX = 60   # a move ending this near something to keep away from costs AWAY_MS more
AWAY_MS = 1500
LINK_MS = 1000      # ms a link of a map costs before anything is known of it


def learn(recordings, cell=CELL):
    """Places and moves from recordings: [[(t, x, y, level, keys)]] per recording, in time order (level None without
    a Level observation; keys a tuple of the buttons held). Returns {cell, places: [[level, x, y, n]], moves: [[from,
    to, ms, n, keys]]}, places by index."""
    sums, index = {}, {}
    crossings, keys_of = defaultdict(list), defaultdict(Counter)

    def place(level, x, y):
        key = (level, math.floor(x / cell), math.floor(y / cell))
        if key not in index:
            index[key] = len(index)
            sums[key] = [0.0, 0.0, 0]
        s = sums[key]
        s[0] += x; s[1] += y; s[2] += 1
        return index[key]

    for samples in recordings:
        current, entered, last_t, leaving = None, None, None, ()
        for t, x, y, level, keys in samples:
            here = place(level, x, y)
            if last_t is not None and (t - last_t > GAP_MS or current is None):
                current, entered = None, None
            if current is not None and here != current:
                crossings[(current, here)].append(t - entered)
                keys_of[(current, here)][leaving] += 1
            if here != current:
                current, entered = here, t
            leaving = tuple(keys)
            last_t = t
    places = [None] * len(index)
    for key, i in index.items():
        sx, sy, n = sums[key]
        places[i] = [key[0], round(sx / n, 1), round(sy / n, 1), n]
    moves = [[a, b, round(sorted(ts)[len(ts) // 2], 1), len(ts), list(keys_of[(a, b)].most_common(1)[0][0])]
             for (a, b), ts in crossings.items()]
    return {'cell': cell, 'places': places, 'moves': moves}


class Planner:
    """Paths over what `learn` found. One per graph: it keeps the times to the last destination asked for."""

    def __init__(self, graph):
        self.cell = graph.get('cell')
        self.places = graph['places']   # [level, x, y, n] learned, [level, x, y, n, place id] a map's own
        self.moves = graph['moves']     # [from, to, ms, n, keys] learned, [..., link id] a map's own
        self.out, self.into = defaultdict(list), defaultdict(list)
        for a, b, ms, n, keys, *_ in self.moves:
            self.out[a].append((b, ms))
            self.into[b].append((a, ms))
        self.by_cell = {(p[0], math.floor(p[1] / self.cell), math.floor(p[2] / self.cell)): i
                        for i, p in enumerate(self.places) if self.cell and len(p) < 5}
        self.on_level = defaultdict(list)
        for i, p in enumerate(self.places):
            self.on_level[p[0]].append(i)
        self.edges = {}
        self.link_of = {}  # (from, to): the map's link id, for a map's own links
        for a, b, ms, n, keys, *rest in self.moves:
            if (a, b) not in self.edges or ms < self.edges[(a, b)][0]:
                self.edges[(a, b)] = (ms, keys)
                if rest:
                    self.link_of[(a, b)] = rest[0]
                else:
                    self.link_of.pop((a, b), None)
        self.ids = {p[4]: i for i, p in enumerate(self.places) if len(p) >= 5}  # a map place's id: its index
        self.penalty = {}  # (a, b): how many times as much a move costs, after it didn't happen in play
        self._fields = {}

    def place_at(self, level, x, y):
        """The place the player is at: their own cell's, else the nearest not above them, else the nearest (None on a
        level with no places)."""
        exact = self.by_cell.get((level, math.floor(x / self.cell), math.floor(y / self.cell))) if self.cell else None
        if exact is not None:
            return exact
        candidates = self.on_level.get(level) or []
        if not candidates:
            return None
        level_ones = [i for i in candidates if self.places[i][2] >= y - STEP]
        return min(level_ones or candidates, key=lambda i: math.hypot(self.places[i][1] - x, self.places[i][2] - y))

    def stuck(self, level, position, destination):
        """Where the moves from a place do get, when none reaches the destination: the place it's at, how many it can
        reach, and the one of those nearest the destination ({at, reach, nearest, short}, px)."""
        start, goal = self.place_at(level, *position), self.place_at(level, *destination)
        if start is None or goal is None:
            return None
        seen, todo = {start}, [start]
        while todo:
            for b, _ in self.out[todo.pop()]:
                if b not in seen:
                    seen.add(b)
                    todo.append(b)
        gx, gy = self.places[goal][1], self.places[goal][2]
        best = min(seen, key=lambda i: math.hypot(self.places[i][1] - gx, self.places[i][2] - gy))
        return {'at': [round(self.places[start][1]), round(self.places[start][2])], 'reach': len(seen),
                'nearest': [round(self.places[best][1]), round(self.places[best][2])],
                'short': round(math.hypot(self.places[best][1] - gx, self.places[best][2] - gy))}

    def cost(self, a, b, ms):
        return ms * self.penalty.get((a, b), 1)

    def times_to(self, goal):
        """The quickest time from every place to `goal` (ms), over the moves; kept for later asks (up to FIELDS_KEPT
        destinations)."""
        if goal in self._fields:
            return self._fields[goal]
        times = {goal: 0.0}
        queue = [(0.0, goal)]
        while queue:
            t, here = heapq.heappop(queue)
            if t > times.get(here, math.inf):
                continue
            for before, ms in self.into[here]:
                spent = t + self.cost(before, here, ms)
                if spent < times.get(before, math.inf):
                    times[before] = spent
                    heapq.heappush(queue, (spent, before))
        if len(self._fields) >= FIELDS_KEPT:
            self._fields.pop(next(iter(self._fields)))
        self._fields[goal] = times
        return times

    def penalize(self, a, b):
        """A move that didn't happen in play: it costs FAILED_COST times as much from then on, so the way round it is
        planned if there's one."""
        self.penalty[(a, b)] = self.penalty.get((a, b), 1) * FAILED_COST
        self._fields = {}

    def hint(self, route, buttons, cap=HINT_CAP):
        """The plan's next move for a policy: per button, whether the first move of `route` (place indices) uses it,
        then how many px along the way until a move that does (`cap` if none that near)."""
        nxt = set(self.edges.get((route[0], route[1]), (0, ()))[1]) if route and len(route) > 1 else set()
        soon, gone = {}, 0.0
        for a, b in zip(route or [], (route or [])[1:]):
            if gone > cap:
                break
            for key in self.edges.get((a, b), (0, ()))[1]:
                soon.setdefault(key, gone)
            gone += math.hypot(self.places[b][1] - self.places[a][1], self.places[b][2] - self.places[a][2])
        return [1.0 if b in nxt else 0.0 for b in buttons] + [round(min(cap, soon.get(b, cap)), 1) for b in buttons]

    def path(self, start, goal, ahead_ms=None, away=None):
        """The places from `start` toward `goal`, quickest first, as far as ahead_ms of moves (to the goal without
        it); None if no moves lead there. `away(place)` is extra ms for moves ending there (near something to keep away
        from), weighed at each step; a place isn't gone back to, which keeping away could otherwise bounce between."""
        times = self.times_to(goal)
        if start not in times:
            return None
        route, here, spent, seen = [start], start, 0.0, {start}
        while here != goal and (ahead_ms is None or spent < ahead_ms) and len(route) < 10000:
            options = [(b, ms) for b, ms in self.out[here] if b in times and b not in seen]
            if not options:
                break
            nxt, ms = min(options, key=lambda bm: self.cost(here, bm[0], bm[1]) + times[bm[0]] + (away(bm[0]) if away else 0))
            seen.add(nxt)
            spent += ms
            here = nxt
            route.append(here)
        return route

    def target(self, level, position, destination, ahead_ms, away=None):
        """Where play aims: the place `ahead_ms` of moves along the quickest way from the player to the destination,
        and that way (place indices), or (None, None) when no move leads there."""
        start = self.place_at(level, *position)
        goal = self.place_at(level, *destination)
        if start is None or goal is None:
            return None, None
        ahead = self.path(start, goal, ahead_ms, away)
        if ahead is None:
            return None, None
        end = self.places[ahead[-1]]
        return (end[1], end[2]), ahead

    def picture(self, level, position=None, destination=None, ahead_ms=None):
        """What the node draws for a level: its places and moves (up to MAX_DRAWN), and with a position and
        destination the way there and the target; plus counts."""
        mine = self.on_level.get(level) or []
        keep = set(mine[:MAX_DRAWN])
        places = [[self.places[i][1], self.places[i][2]] for i in mine[:MAX_DRAWN]]
        at = {i: k for k, i in enumerate(mine[:MAX_DRAWN])}
        moves = [[at[a], at[b]] for a, b, *_ in self.moves if a in keep and b in keep][:MAX_DRAWN]
        out = {'places': places, 'moves': moves, 'count': {'places': len(mine), 'moves': sum(1 for a, *_ in self.moves if self.places[a][0] == level)}}
        if position is not None and destination is not None:
            start, goal = self.place_at(level, *position), self.place_at(level, *destination)
            whole = self.path(start, goal) if start is not None and goal is not None else None
            target, _ = self.target(level, position, destination, ahead_ms) if whole else (None, None)
            out.update({'path': [[self.places[i][1], self.places[i][2]] for i in whole] if whole else None,
                        'target': list(target) if target else None,
                        'next': self._next_move(whole), 'seconds': self._seconds(whole)})
        return out

    def _next_move(self, route):
        if not route or len(route) < 2:
            return None
        for a, b, ms, n, keys, *_ in self.moves:
            if a == route[0] and b == route[1]:
                return {'keys': keys, 'ms': ms, 'seen': n}
        return None

    def _seconds(self, route):
        if not route:
            return None
        ms = {(a, b): t for a, b, t, *_ in self.moves}
        return round(sum(ms[(a, b)] for a, b in zip(route, route[1:])) / 1000, 1)


def merge(grid, doc, stats=None, clips=None):
    """A planner's graph for a map (`doc`, as src/mapModel.ts compiles it): its own places and links, beside the places
    and moves of `grid` (learn's, or None). A link's time is what it took when it last worked (`stats`, {link id:
    {runs, fails, ms}}), else its own `ms`, else its clip's length (`clips`, {link:<id>: {keys, timeline, end}}), else
    LINK_MS, over its chance of working ((worked + 1) / (runs + 2)); its keys are those it holds (a keys link), or its
    clip presses."""
    grid = grid or {'cell': None, 'places': [], 'moves': []}
    places = [list(p) for p in grid['places']]
    moves = [list(m) for m in grid['moves']]
    index = {}
    for p in doc.get('places') or []:
        if isinstance(p, dict) and all(isinstance(p.get(k), (int, float)) for k in ('x', 'y')):
            index[p['id']] = len(places)
            places.append([p.get('level'), float(p['x']), float(p['y']), 0, p['id']])
    for link in doc.get('links') or []:
        if not isinstance(link, dict) or link.get('from') not in index or link.get('to') not in index:
            continue
        s, clip = (stats or {}).get(link.get('id')) or {}, (clips or {}).get(f'link:{link.get("id")}')
        ms = s.get('ms') or link.get('ms') or (clip or {}).get('end') or LINK_MS
        chance = (s.get('runs', 0) - s.get('fails', 0) + 1) / (s.get('runs', 0) + 2)
        if link.get('kind') == 'keys':
            keys = sorted(link.get('keys') or [])
        elif clip:
            keys = sorted(set(clip['keys']) | {k for _, k, down in clip['timeline'] if down})
        else:
            keys = []
        moves.append([index[link['from']], index[link['to']], round(float(ms) / max(0.05, chance), 1), s.get('runs', 0), keys, link['id']])
    return {'cell': grid.get('cell'), 'places': places, 'moves': moves}


def learn_stat(s, worked, ms):
    """A link's stats ({runs, fails, ms}) once it ran: worked (taking `ms`, averaged in) or not."""
    s['runs'] = s.get('runs', 0) + 1
    if worked:
        s['ms'] = round(ms if not s.get('ms') else 0.7 * s['ms'] + 0.3 * ms, 1)
    else:
        s['fails'] = s.get('fails', 0) + 1
    return s
