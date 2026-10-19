"""The Planner node's "Plan from what I've done": where play heads, from the places and moves of the player's own
recordings, with nothing known about any game.

Places are cells of the world, `cell` px a side (per level, when a Level observation tells levels apart), each at
where the player actually was in it (the mean of their positions there). A move is the player going from one cell to
the next in a recording: its time (the median of the times spent crossing the cell it left) and the keys held as the
player left it (what took them on, not standing about first). To head for a destination, the time to get there is worked out once from every place (Dijkstra, over the
moves backwards); each frame, play follows the quickest moves from where the player is for `aheadS` seconds, and
that place is its target, so play's targets are like training's: where to get to next, not somewhere far off.

Off every known place (a fall, a start somewhere new), the player is at the nearest place not above them (a player
walks or drops to one but can't rise to it), else the nearest. Moves are only those made: a place reached by a move
no recording made can't be planned to."""
import bisect
import heapq
import math
import statistics
from collections import Counter, defaultdict

import physics as physics_

CELL = 40           # px, a place's side unless the node says otherwise
GAP_MS = 500        # samples further apart than this aren't one move
STEP = 40           # px above the player a place can be and still count as on their level (as the route's)
MAX_DRAWN = 6000    # places and moves in a preview
FIELDS_KEPT = 256   # destinations whose times are kept (training asks for one per place it reached)
HINT_CAP = 400      # px: how far along the way the plan's next keys are looked for (further reads as this)
FAILED_COST = 4     # a move that didn't happen in play costs this many times as much from then on
KEEP_AWAY_PX = 60   # a move ending this near something to keep away from costs AWAY_MS more
AWAY_MS = 1500


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
        self.cell = graph['cell']
        self.places = graph['places']
        self.moves = graph['moves']
        self.out, self.into = defaultdict(list), defaultdict(list)
        for a, b, ms, n, keys in self.moves:
            self.out[a].append((b, ms))
            self.into[b].append((a, ms))
        self.by_cell = {(p[0], math.floor(p[1] / self.cell), math.floor(p[2] / self.cell)): i for i, p in enumerate(self.places)}
        self.on_level = defaultdict(list)
        for i, p in enumerate(self.places):
            self.on_level[p[0]].append(i)
        self.edges = {(a, b): (ms, keys) for a, b, ms, n, keys in self.moves}
        self.penalty = {}  # (a, b): how many times as much a move costs, after it didn't happen in play
        self._fields = {}

    def place_at(self, level, x, y):
        """The place the player is at: their own cell's, else the nearest not above them, else the nearest (None on a
        level with no places). Along shapes, the place on the shape the player is on, nearest them (by cell, on a rope
        beside a platform they were taken to be on the platform)."""
        shapes = getattr(self, 'map', None)
        on = shapes.on(x, y) if shapes is not None else None
        if on is not None:
            return shapes.nearest_on(*on)
        exact = self.by_cell.get((level, math.floor(x / self.cell), math.floor(y / self.cell)))
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
        for a, b, ms, n, keys in self.moves:
            if a == route[0] and b == route[1]:
                return {'keys': keys, 'ms': ms, 'seen': n}
        return None

    def _seconds(self, route):
        if not route:
            return None
        ms = {(a, b): t for a, b, t, *_ in self.moves}
        return round(sum(ms[(a, b)] for a, b in zip(route, route[1:])) / 1000, 1)


# ── Places along shapes ───────────────────────────────────────────────────────────────────────────────────────────
# Places are points every `cell` px along the shapes of the inputs the player can be on (such as platforms and ropes),
# so a level's places come from its shapes, recorded or not. The player is on a shape when within `snap` px of it;
# off every one (in the air) they're between places. Moves are learned as two kinds, both relative to the shapes, so
# they're reused on every shape of a level, and on levels never recorded:
#   along a shape: the player's speed and keys going each way along the shapes of one input (s up or down its line)
#   hops: leaving one shape and landing on another (or far along the same one) within HOP_MS, or going straight from
#     one onto another (a rope's top onto its platform, never off both), as how far it started
#     from the nearer end of its shape (`edge`, capped at EDGE_FAR: further is all "the middle"), dx, dy, the time and
#     the keys held across the takeoff (on the last sample on the line and the first off it); a hop is used from every place whose edge is alike to every place about
#     dx, dy away (within `tolerance` px) on a shape of the input it landed on
EDGE_FAR = 200       # px from a shape's end: further is the middle
EDGE_TOLERANCE = 30  # px: edges this alike count as the same
HOP_MS = 3000        # off every shape longer than this isn't a hop (a fall off the level, a loading screen)
REST_MS = 80         # off every shape, still this long (not a px between samples): standing on something that isn't one
                     # of the shapes, so the flight isn't a hop (two jumps with a rest between, learned as one jump of
                     # 140 px in a second, were reused across the level)
REST_PX = 1
SOLID_FLIGHTS = 20   # with this many flights recorded and none going up through a platform, platforms are taken as solid
                     # from below (left to work out, `solid` None): the user's 193 never did, and the planner sent them up
                     # through one
SNAP = 20            # px from a shape the player counts as on it, unless the node says otherwise
TOLERANCE = 25       # px a reused hop may land from where it would: lower or shorter, by up to this
UP_SLACK = 3         # px higher than it was made a reused hop may land: a jump's height is as high as it goes
OUT_SLACK = 3        # px further across. Both within one jump made (`made`): at least as high and as far as it, in the
                     # same jump (the highest of one and the furthest of another, with 6 and 12 px over, had a jump made
                     # 83 px across and 59 up planned 90 across and 60 up, out of the player's reach)


class Scale:
    """A game's scale, from its recordings' hops (learn_moves' `scale`): px and ms tuned at MapleStory's, as its own."""

    def __init__(self, moves=None):
        s = (moves or {}).get('scale') or {}
        self.jump = s.get('jump') or REF_JUMP
        self.hop_ms = s.get('hopMs') or REF_HOP_MS

    def px(self, v):
        return v * self.jump / REF_JUMP

    def ms(self, v):
        return v * self.hop_ms / REF_HOP_MS
# A hop's examples, for the executor (executor.py) to do it again: the player's own presses, from the raw key events a
# recording keeps (to the millisecond, not the samples' 40-50 ms), from the press that started it (its anchor: the
# first key pressed near the takeoff, else the takeoff, as walking off an edge) until it landed, with where the player was and how
# fast they went then, measured from where they took off
EXAMPLES_KEPT = 3    # per hop, those nearest the hop's median
HOP_COST_MS = 300    # a hop's time as planned is its flight and this: getting into position and landing (without it,
                     # dropping off a platform and jumping back up read as quicker than walking along it)
# The px and ms above, and the executor's, are at the scale they were tuned at: MapleStory's, where the player's upward
# hops rise 45 px and last 270 ms (their medians). A game's own recordings give its scale (learn_moves' `scale`), and
# Scale turns them into its own: a game drawn twice as big has twice the px
REF_JUMP = 45.0
REF_HOP_MS = 270.0
UP_HOP = 10          # px up a hop rises at least to count toward the scale (at REF_JUMP: smaller is a step)
ANCHOR_NEAR = (120, 100)    # ms before and after the takeoff a press is looked for first
ANCHOR_WIDE = (300, 150)    # then this far
SPEED_MS = 100       # ms over which the speed going into the anchor is measured


def _length(points):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def _at(points, s):
    """The point s px along a line."""
    for n, (a, b) in enumerate(zip(points, points[1:])):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        if s <= d or n == len(points) - 2:
            k = 0 if d == 0 else min(1.0, max(0.0, s / d))
            return a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])
        s -= d
    return points[-1][0], points[-1][1]


class ShapeMap:
    """A level's shapes the player can be on, as lines with places along them. lines: [(input, points)]."""

    def __init__(self, lines, cell=CELL, snap=SNAP):
        self.cell, self.snap = cell, snap
        self.lines = [(alias, [(float(p[0]), float(p[1])) for p in pts], _length(pts)) for alias, pts in lines if len(pts) >= 1]
        self.places = []    # [x, y, line, s]
        self.of_line = []   # place indices along each line, in order
        for li, (_, pts, length) in enumerate(self.lines):
            n = max(1, math.ceil(length / cell))
            mine = []
            for k in range(n + 1 if length > 0 else 1):
                s = length * k / n if length > 0 else 0.0
                x, y = _at(pts, s) if len(pts) > 1 else pts[0]
                mine.append(len(self.places))
                self.places.append([x, y, li, s])
            self.of_line.append(mine)
        self._grid = defaultdict(list)
        for i, (x, y, *_) in enumerate(self.places):
            self._grid[(math.floor(x / cell), math.floor(y / cell))].append(i)
        self._boxes = [(min(p[0] for p in pts) - snap, min(p[1] for p in pts) - snap, max(p[0] for p in pts) + snap, max(p[1] for p in pts) + snap)
                       for _, pts, _ in self.lines]

    def on(self, x, y):
        """The line the point is on (within snap) and how far along it, or None."""
        near = self.within(x, y)
        return near[0][1:] if near else None

    def within(self, x, y):
        """Every line within snap of the point, nearest first: [(distance, line, how far along it)]."""
        out = []
        for li, (_, pts, _l) in enumerate(self.lines):
            x0, y0, x1, y1 = self._boxes[li]
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                continue
            best, run = None, 0.0
            for a, b in (zip(pts, pts[1:]) if len(pts) > 1 else [(pts[0], pts[0])]):
                dx, dy = b[0] - a[0], b[1] - a[1]
                d2 = dx * dx + dy * dy
                k = 0.0 if d2 == 0 else max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / d2))
                d = math.hypot(a[0] + k * dx - x, a[1] + k * dy - y)
                if d <= self.snap and (best is None or d < best[0]):
                    best = (d, li, run + k * math.sqrt(d2))
                run += math.sqrt(d2)
            if best:
                out.append(best)
        return sorted(out)

    def edge(self, li, s):
        return min(EDGE_FAR, s, self.lines[li][2] - s)

    def upright(self, li):
        """Whether a line goes more up than across (a rope or ladder), from its ends."""
        pts = self.lines[li][1]
        return abs(pts[-1][1] - pts[0][1]) > abs(pts[-1][0] - pts[0][0])

    def lands(self, x, y, rising):
        """The line a player in the air comes down on: as `on`, but a platform (a line more across than up) only coming
        down onto it, from above it (no more than a quarter of `snap` below it: a jump that fell back 15 px short of a
        platform above was learned as one 95 px up onto it); a rope is caught either way. The nearest line within snap
        that can be landed on (the end of a slope a few px nearer than the floor stood on had the floor not count)."""
        for _, li, s in self.within(x, y):
            if self.upright(li):
                return li, s
            line = self.lines[li][1]
            below = y - (_at(line, s)[1] if len(line) > 1 else line[0][1])
            # nor past its end: falling beside a platform's end isn't standing on it
            past = max(min(p[0] for p in line) - x, x - max(p[0] for p in line), 0)
            if not rising and below <= self.snap / 4 and past <= self.snap / 4:
                return li, s
        return None

    def around(self, x, y, within, alias=None):
        """Every place within `within` px (on a line of `alias`, if given), nearest first."""
        r = max(1, math.ceil(within / self.cell))
        cx, cy = math.floor(x / self.cell), math.floor(y / self.cell)
        found = []
        for gx in range(cx - r, cx + r + 1):
            for gy in range(cy - r, cy + r + 1):
                for i in self._grid.get((gx, gy), ()):
                    p = self.places[i]
                    d = math.hypot(p[0] - x, p[1] - y)
                    if d <= within and (alias is None or self.lines[p[2]][0] == alias):
                        found.append((d, i))
        return [i for _, i in sorted(found)]

    def landings(self, x, y, within, alias=None):
        """Where on the lines (of `alias`, if given) a point within `within` px of (x, y) is: [(distance, line, s, px,
        py)] per line, its nearest point, nearest first."""
        out = []
        for li, (name, pts, _) in enumerate(self.lines):
            if alias is not None and name != alias:
                continue
            x0, y0, x1, y1 = self._boxes[li]
            if not (x0 - within <= x <= x1 + within and y0 - within <= y <= y1 + within):
                continue
            best, run = None, 0.0
            for a, b in (zip(pts, pts[1:]) if len(pts) > 1 else [(pts[0], pts[0])]):
                dx, dy = b[0] - a[0], b[1] - a[1]
                d2 = dx * dx + dy * dy
                k = 0.0 if d2 == 0 else max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / d2))
                px, py = a[0] + k * dx, a[1] + k * dy
                d = math.hypot(px - x, py - y)
                if d <= within and (best is None or d < best[0]):
                    best = (d, li, run + k * math.sqrt(d2), px, py)
                run += math.sqrt(d2)
            if best:
                out.append(best)
        return sorted(out)

    def nearest_on(self, li, s):
        """The place along line li nearest s px along it."""
        return min(self.of_line[li], key=lambda i: abs(self.places[i][3] - s))

    def near(self, x, y, within, alias=None):
        """The nearest place within `within` px (on a line of `alias`, if given), or None."""
        r = max(1, math.ceil(within / self.cell))
        cx, cy = math.floor(x / self.cell), math.floor(y / self.cell)
        best = None
        for gx in range(cx - r, cx + r + 1):
            for gy in range(cy - r, cy + r + 1):
                for i in self._grid.get((gx, gy), ()):
                    p = self.places[i]
                    if alias is not None and self.lines[p[2]][0] != alias:
                        continue
                    d = math.hypot(p[0] - x, p[1] - y)
                    if d <= within and (best is None or d < best[1]):
                        best = (i, d)
        return None if best is None else best[0]


class _Keys:
    """A recording's raw key events: [(t, id, down)] for a press or let-go, [(t, None, [ids held])] for what was held
    then (the recorder notes it when the game comes to the front). What was held at any moment, and the presses
    between two moments."""

    def __init__(self, events):
        self.times, self.states, self.presses = [], [], []
        held = set()
        for t, key, down in sorted(events, key=lambda e: e[0]):
            if key is None:
                held = set(down)
            else:
                (held.add if down else held.discard)(key)
                self.presses.append((t, key, bool(down)))
            self.times.append(t)
            self.states.append(frozenset(held))
        self.press_times = [p[0] for p in self.presses]

    def held(self, t):
        i = bisect.bisect_right(self.times, t) - 1
        return self.states[i] if i >= 0 else frozenset()

    def between(self, t0, t1):
        return self.presses[bisect.bisect_left(self.press_times, t0):bisect.bisect_right(self.press_times, t1)]


def _position(track, t):
    """Where the player was at time t, between the samples around it."""
    i = bisect.bisect_left(track[0], t)
    if i <= 0:
        return track[1][0], track[2][0]
    if i >= len(track[0]):
        return track[1][-1], track[2][-1]
    t0, t1 = track[0][i - 1], track[0][i]
    k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
    return track[1][i - 1] + k * (track[1][i] - track[1][i - 1]), track[2][i - 1] + k * (track[2][i] - track[2][i - 1])


def _example(keys, track, t0, x0, y0, t1, x1, y1):
    """A hop as it was done: taking off from (x0, y0) after t0 (the last sample on the line) and landing at (x1, y1)
    by t1. None without the key events."""
    # a key pressed starts a hop (letting one go doesn't: a release near the takeoff is the end of a jump before it)
    near = [p for p in keys.between(t0 - ANCHOR_NEAR[0], t0 + ANCHOR_NEAR[1]) if p[2]]
    anchor = near[0] if near else None
    if anchor is None:
        wide = [p for p in keys.between(t0 - ANCHOR_WIDE[0], t0 + ANCHOR_WIDE[1]) if p[2]]
        anchor = min(wide, key=lambda p: abs(p[0] - t0)) if wide else None
    ta = anchor[0] if anchor else t0
    ax, ay = _position(track, ta)
    bx, by = _position(track, ta - SPEED_MS)
    return {'ax': round(ax - x0, 1), 'ay': round(ay - y0, 1), 'dx': round(x1 - x0, 1), 'dy': round(y1 - y0, 1),
            'vx': round((ax - bx) / SPEED_MS, 4), 'vy': round((ay - by) / SPEED_MS, 4),
            'keys': sorted(keys.held(ta - 0.001)), 'end': round(t1 - ta, 1),
            'timeline': [[round(t - ta, 1), key, down] for t, key, down in keys.between(ta, t1 + 100)]}


def learn_moves(recordings, cell=CELL, snap=SNAP, tolerance=TOLERANCE, raw=None, events=None):
    """The moves of recordings along shapes: [[(t, x, y, lines, keys)]] per recording, lines [(input, points)] those
    the player can be on in that sample (the same object for samples alike). Returns {along: {input: {'+'|'-': {speed,
    keys, n}}}, hops: [{from, to, edge, dx, dy, ms, keys, n}]}: speeds px/ms, hops grouped by their inputs and dx, dy
    and edge to the nearest `tolerance` px, each the median of its group; and `offset`, by input, where the player
    usually is from the line they're on (the median), which places are moved by. `raw`, a list, gets each hop as it was:
    (lines, from x, from y, to x, to y). `events`, per recording, its raw key events (_Keys), give each hop `examples`
    to do it again by (_example)."""
    maps = {}
    through = {'flights': 0, 'up': 0}  # flights landed, and those that went up through a platform on the way
    flights = []     # every flight landed, for the movement measured from them (physics.fit)
    stops = []       # and every stop from walking (_stops), from each recording with its key events
    stop_runs = []
    speeds, along_keys = defaultdict(list), defaultdict(Counter)
    groups = defaultdict(list)
    offsets = defaultdict(list)   # where the player is from the line they're on, per input (feet a few px above it)
    for r, samples in enumerate(recordings):
        keys_of = _Keys(events[r]) if events and r < len(events) and events[r] else None
        track = ([s[0] for s in samples], [s[1] for s in samples], [s[2] for s in samples]) if keys_of else None
        last_on, left = None, None   # (t, line, s, x, y, map); where the player left a line: (t, line, s, x, y, keys, map)
        last_t, last_keys, last_y = None, (), None
        air_top = None   # the highest the player went since leaving a line (least y)
        last_x = None
        flight = []      # where the player went since leaving a line
        fpath = []       # and when, with the keys held (from the last sample on the line), for the movement's fit
        for t, x, y, lines, keys in samples:
            if left is not None:
                air_top = y if air_top is None else min(air_top, y)
                flight.append((x, y))
                fpath.append((t, x, y, keys))
                if (last_t is not None and t - last_t >= REST_MS and abs(x - last_x) <= REST_PX and abs(y - last_y) <= REST_PX
                        and maps[id(lines)][0].on(x, y) is None if id(lines) in maps else False):
                    left, last_on, air_top, flight = None, None, None, []  # resting on something it can't see: no hop from here
            if id(lines) not in maps:
                maps[id(lines)] = (ShapeMap(lines, cell, snap), lines)  # the lines kept, so their id isn't reused
            m = maps[id(lines)][0]
            if last_t is not None and t - last_t > GAP_MS and left is None:
                last_on = None
            # in the air, a jump rising past a platform doesn't land on it
            where = m.lands(x, y, last_y is not None and y < last_y - 1) if left is not None else m.on(x, y)
            if where is not None:
                li, s = where
                alias = m.lines[li][0]
                px, py = _at(m.lines[li][1], s) if len(m.lines[li][1]) > 1 else m.lines[li][1][0]
                offsets[alias].append((x - px, y - py))
                if last_on is not None and last_on[5] is m and last_on[1] == li and t - last_on[0] <= GAP_MS:
                    ds = s - last_on[2]
                    if abs(ds) >= 1:
                        way = '+' if ds > 0 else '-'
                        speeds[(alias, way)].append(abs(ds) / max(1.0, t - last_on[0]))
                        along_keys[(alias, way)][tuple(last_keys)] += 1
                if left is None and last_on is not None and last_on[5] is m and last_on[1] != li and t - last_on[0] <= GAP_MS:
                    # straight from one line onto another, never off both (a rope's top onto its platform): a hop too
                    left = (last_on[0], last_on[1], last_on[2], last_on[3], last_on[4], tuple(sorted(set(last_keys) | set(keys))), last_on[5])
                    flight = []
                    fpath = [(last_on[0], last_on[3], last_on[4], last_keys), (t, x, y, keys)]

                if left is not None and left[6] is m and t - left[0] <= HOP_MS and _snapped([tuple(left[3:5])] + flight, m.snap):
                    pass  # going up again while falling, with nothing to push it: the game moved the player, not a jump
                elif left is not None and left[6] is m and t - left[0] <= HOP_MS:
                    _, lli, ls, lx, ly, lkeys, _ = left
                    press = _press(keys_of, left[0]) if keys_of else None
                    flights.append({'path': fpath, 'press': press[:2] if press else None, 'hold': press[2] if press else None})
                    through['flights'] += 1
                    through['up'] += _up_through(m, [(lx, ly)] + flight, lli, li)
                    if lli != li or abs(s - ls) > 2 * cell:
                        # from the point on the line it left to the point on the line it landed on: the samples either
                        # side are anywhere within `snap` of their lines (rising at takeoff, the last one on the floor
                        # was 17 px above it, and a jump of 77 px up was learned as 60, and no longer reached a platform
                        # 68 up), and where the player stands from a line is the input's `offset`, added to places
                        fx_, fy_ = _at(m.lines[lli][1], ls) if len(m.lines[lli][1]) > 1 else m.lines[lli][1][0]
                        tx_, ty_ = _at(m.lines[li][1], s) if len(m.lines[li][1]) > 1 else m.lines[li][1][0]
                        dx, dy = tx_ - fx_, ty_ - fy_
                        edge = m.edge(lli, ls)
                        q = max(1.0, tolerance)
                        groups[(m.lines[lli][0], alias, round(dx / q), round(dy / q), round(edge / EDGE_TOLERANCE))].append(
                            (dx, dy, edge, t - left[0], tuple(lkeys),
                             _example(keys_of, track, left[0], lx, ly, t, x, y) if keys_of else None,
                             min(0.0, (air_top if air_top is not None else y) - min(ly, y))))
                        if raw is not None:
                            raw.append((maps[id(lines)][1], lx, ly, x, y))
                left, air_top, flight = None, None, []
                last_on = (t, li, s, x, y, m)
            elif last_on is not None and left is None:
                # the keys across the takeoff: held on the last sample on the line and the first off it
                left = (last_on[0], last_on[1], last_on[2], last_on[3], last_on[4], tuple(sorted(set(last_keys) | set(keys))), last_on[5])
                flight = []
                fpath = [(last_on[0], last_on[3], last_on[4], last_keys), (t, x, y, keys)]

            last_t, last_keys, last_y, last_x = t, keys, y, x
        if keys_of:
            stop_runs.append((samples, keys_of))
    along = defaultdict(dict)
    for (alias, way), vs in speeds.items():
        if len(vs) >= 3:
            along[alias][way] = {'speed': round(sorted(vs)[len(vs) // 2], 4), 'keys': list(along_keys[(alias, way)].most_common(1)[0][0]), 'n': len(vs)}
    hops = []
    for (a, b, *_), items in groups.items():
        def mid(k, items=items):
            return sorted(i[k] for i in items)[len(items) // 2]
        hop = {'from': a, 'to': b, 'dx': round(mid(0), 1), 'dy': round(mid(1), 1), 'edge': round(mid(2), 1), 'ms': round(mid(3), 1),
               'keys': list(Counter(i[4] for i in items).most_common(1)[0][0]), 'n': len(items),
               # the highest and furthest across it was made: reused, it lands no higher or further than these
               'top': round(min(i[1] for i in items), 1), 'far': round(max(abs(i[0]) for i in items), 1),
               # every time it was made, (dx, dy): a reused hop lands within one of them (level_graph)
               'made': [[round(i[0], 1), round(i[1], 1)] for i in items][:64],
               # how far above the higher of its two ends it went (its arc, for whether it passes through a platform)
               'rise': round(mid(6), 1)}
        done = [i for i in items if i[5] is not None]
        if done:
            done.sort(key=lambda i: math.hypot(i[0] - hop['dx'], i[1] - hop['dy']))
            hop['examples'] = [{**i[5], 'edge': round(i[2], 1)} for i in done[:EXAMPLES_KEPT]]
        hops.append(hop)
    offset = {alias: [round(sorted(o[0] for o in vs)[len(vs) // 2], 1), round(sorted(o[1] for o in vs)[len(vs) // 2], 1)]
              for alias, vs in offsets.items()}
    # the game's scale: how high its upward hops rise and how long a hop lasts (medians over every one made)
    every = [i for items in groups.values() for i in items]
    ups = sorted(-i[1] for i in every if i[1] <= -UP_HOP)
    times = sorted(i[3] for i in every if i[1] <= -UP_HOP)  # theirs too: a level's many steps between joined footholds took 40 ms
    scale = {'jump': round(ups[len(ups) // 2], 1) if len(ups) >= 3 else None, 'hopMs': round(times[len(times) // 2], 1) if len(times) >= 3 else None}
    gaps = sorted(b[0] - a[0] for samples in recordings for a, b in zip(samples, samples[1:]) if 0 < b[0] - a[0] < 500)
    speeds_ = [w['speed'] for ways in along.values() for w in ways.values()]
    walking = statistics.median(speeds_) if speeds_ else 0.05
    for samples, keys_of in stop_runs:
        stops += _stops(samples, keys_of, maps, walking)
    return {'along': dict(along), 'hops': hops, 'offset': offset, 'scale': scale, 'through': through,
            'physics': physics_.fit(flights, dict(along), stops, gaps[len(gaps) // 2] if gaps else None)}


def _stops(samples, keys, maps, walking):
    """A recording's stops: each key let go of while walking along a line (more across than up) with only it held, at
    walking pace (half the input's walking speed or more), nothing pressed until the player stops on it: how far they
    slid on after it (px, past where they were when it was let go of) and how long that took. (Any key let go of gave
    stops of 0, already stopped, 25-67 px, another still held, and backwards.)"""
    out = []
    ts = [s[0] for s in samples]
    for t, key, down in keys.presses:
        if down:
            continue
        i = bisect.bisect_left(ts, t)
        if i < 3 or i + 2 >= len(samples):
            continue
        before = samples[i - 3:i]
        m = maps.get(id(before[-1][3]), (None,))[0]
        if m is None or any(m.on(s[1], s[2]) is None for s in before):
            continue
        where = m.on(before[-1][1], before[-1][2])
        if m.upright(where[0]) or tuple(before[-1][4]) != (key,) or tuple(before[0][4]) != (key,):
            continue
        v = (before[-1][1] - before[0][1]) / max(1.0, before[-1][0] - before[0][0])
        if abs(v) < 0.5 * walking:
            continue
        a, b = samples[i - 1], samples[i]
        x0 = a[1] + (t - a[0]) / max(1e-6, b[0] - a[0]) * (b[1] - a[1])
        stop = None
        for j in range(i, min(len(samples) - 1, i + 15)):
            if m.on(samples[j][1], samples[j][2]) is None or samples[j][0] - t > 600:
                break
            if abs(samples[j + 1][1] - samples[j][1]) < 1:
                stop = j
                break
        if stop is None or any(p[2] and t < p[0] <= samples[stop][0] for p in keys.presses):
            continue
        slid = (samples[stop][1] - x0) * (1 if v > 0 else -1)
        if slid >= 0:
            out.append((slid, samples[stop][0] - t))
    return out


def _press(keys, t0):
    """The key pressed nearest a takeoff (within physics.JUMP_NEAR), when, and how long it was held: (t, key, ms)."""
    downs = [p for p in keys.between(t0 - physics_.JUMP_NEAR[0], t0 + physics_.JUMP_NEAR[1]) if p[2]]
    if not downs:
        return None
    t, key, _ = min(downs, key=lambda p: abs(p[0] - t0))
    up = next((p[0] for p in keys.presses[bisect.bisect_right(keys.press_times, t):] if p[1] == key and not p[2]), None)
    return t, key, (round(up - t) if up is not None else None)


def _snapped(path, snap):
    """Whether a flight goes up by more than `snap` px from one sample to the next after it was falling: a falling
    player can't (the user's flight that fell to 189 px up and was at 227 the next sample, 42 ms later, was learned as a
    jump of 103 px up, and reused from the floor for one of 90 that couldn't be made)."""
    return any(b[1] > a[1] and c[1] < b[1] - snap for a, b, c in zip(path, path[1:], path[2:]))


def _up_through(m, path, start, end):
    """Whether a flight's path went up through a platform (a line more across than up) but the one it left, the one
    it landed on included."""
    for a, b in zip(path, path[1:]):
        if b[1] >= a[1]:
            continue
        for k, (_, pts, _) in enumerate(m.lines):
            if k == start or len(pts) < 2 or m.upright(k):
                continue
            x0, y0, x1, y1 = m._boxes[k]
            if max(a[0], b[0]) < x0 or min(a[0], b[0]) > x1 or max(a[1], b[1]) < y0 or min(a[1], b[1]) > y1:
                continue
            if any(_crosses(a, b, c, d) for c, d in zip(pts, pts[1:])):
                return True
    return False


def solid_of(moves, solid=None):
    """Whether platforms are solid from below: as chosen, else (None) as the recordings say: none of SOLID_FLIGHTS or
    more flights going up through one."""
    if solid is not None:
        return bool(solid)
    t = moves.get('through') or {}
    return t.get('flights', 0) >= SOLID_FLIGHTS and t.get('up', 0) == 0


def replays(moves, hops, cell=CELL, snap=SNAP, tolerance=TOLERANCE, solid=None):
    """How many of these hops (as learn_moves' raw gives them) the moves would plan: a hop from a place near where
    each took off (within a place's spacing) to one near where it landed (within `tolerance`), on its own level's
    shapes."""
    graphs, done = {}, 0
    for lines, x0, y0, x1, y1 in hops:
        if id(lines) not in graphs:
            m = ShapeMap(lines, cell, snap)
            graphs[id(lines)] = (m, level_graph(m, moves, tolerance, solid_of(moves, solid))['hop_of'], lines)
        m, hop_of, _ = graphs[id(lines)]
        reach = tolerance + snap
        done += any(math.hypot(m.places[a][0] - x0, m.places[a][1] - y0) <= cell + snap
                    and math.hypot(m.places[b][0] - x1, m.places[b][1] - y1) <= reach for a, b in hop_of)
    return done


def level_planner(lines, moves, cell=CELL, snap=SNAP, tolerance=TOLERANCE, solid=None, physics=None):
    """A Planner for a level's lines, knowing its shapes (`map`) and which hop each of its hops is (`hop_of`: (from,
    to) places to the index in `hops`: the learned ones, then those the physics made), its moves and the game's scale,
    for the executor. `physics` is the movement as chosen over what was measured (physics.merged); False: jumps only
    as recorded."""
    m = ShapeMap(lines, cell, snap)
    graph = level_graph(m, moves, tolerance, solid_of(moves, solid), physics)
    p = Planner(graph)
    p.map, p.hop_of, p.hops, p.offset, p.along = m, graph['hop_of'], graph['hops'], moves.get('offset', {}), moves.get('along', {})
    p.physics = graph.get('physics')
    p.scale = Scale(moves)
    return p


def _crosses(a, b, c, d):
    """Whether segments ab and cd cross (touching at an end doesn't count)."""
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    return d1 * d2 < 0 and d3 * d4 < 0


def _clear(m, i, j, rise):
    """Whether a hop from place i to place j passes no platform but the one it leaves: its arc, from i up to `rise`
    above the higher end, halfway across, and down to j. Platforms (lines more across than up) block it, the one it lands
    on too unless it comes down onto it from above (a jump from under a platform up onto it went up through it); ropes
    and ladders don't."""
    (x0, y0, li, _), (x1, y1, lj, _) = m.places[i][:4], m.places[j][:4]
    top = (x0 + (x1 - x0) / 2, min(y0, y1) + rise)
    arc = [((x0, y0), top), (top, (x1, y1))]
    bx0, bx1 = min(x0, x1, top[0]), max(x0, x1, top[0])
    by0, by1 = min(y0, y1, top[1]), max(y0, y1, top[1])
    for k, (_, pts, _) in enumerate(m.lines):
        if k == li or m.upright(k) or len(pts) < 2:
            continue  # (landing on line lj, the arc only touches it at its end, which doesn't count as crossing)
        lx0, ly0, lx1, ly1 = m._boxes[k]
        if lx1 < bx0 or lx0 > bx1 or ly1 < by0 or ly0 > by1:
            continue
        for c, d in zip(pts, pts[1:]):
            if any(_crosses(a, b, c, d) for a, b in arc):
                return False
    return True


def level_graph(shape_map, moves, tolerance=TOLERANCE, solid=False, physics=None):
    """A level's places and moves, as `learn` gives them (for Planner): along every line whose input has a learned
    speed that way, and every hop from each place with an edge alike to where it landed on that level's shapes; and
    `hop_of`, which hop each of those is (the quickest, where two join the same places). With `solid` (a game whose
    platforms can't be jumped up through), a hop is only planned where its arc passes no other platform.

    With the movement measured (moves' `physics`, with `physics` over it as chosen; False for none), jumps off
    platforms are the physics' own (`_physics_hops`: simulated from every place, straight up and either way, and walking
    off each end, landing where the arc comes down onto a shape) in place of reused recorded jumps; recorded moves stay
    onto and off ropes and ladders (inputs whose lines go up more than across) and for drops without the jump key."""
    m = shape_map
    phys = None if physics is False else physics_.merged(moves.get('physics'), physics or {})
    use = physics_.usable(phys)
    jump_key = phys.get('jumpKey') if use else None
    climbing = {}  # per input: whether most of its lines here go up more than across
    for k, (alias, _, _) in enumerate(m.lines):
        climbing.setdefault(alias, []).append(m.upright(k))
    climbing = {a: sum(v) > len(v) / 2 for a, v in climbing.items()}
    scale = Scale(moves)
    up, out_, cost = scale.px(UP_SLACK), scale.px(OUT_SLACK), scale.ms(HOP_COST_MS)
    # places where the player is when on each line, not on the line itself (their feet a few px above a platform)
    shift = moves.get('offset', {})
    places = [[None, p[0] + shift.get(m.lines[p[2]][0], (0, 0))[0], p[1] + shift.get(m.lines[p[2]][0], (0, 0))[1], 1] for p in m.places]
    out = []
    for li, idx in enumerate(m.of_line):
        ways = moves['along'].get(m.lines[li][0], {})
        for a, b in zip(idx, idx[1:]):
            ds = m.places[b][3] - m.places[a][3]
            if '+' in ways:
                out.append([a, b, round(ds / ways['+']['speed'], 1), ways['+']['n'], ways['+']['keys']])
            if '-' in ways:
                out.append([b, a, round(ds / ways['-']['speed'], 1), ways['-']['n'], ways['-']['keys']])
    hop_of = {}
    hops = list(moves['hops'])
    for h, hop in enumerate(moves['hops']):
        if use and not climbing.get(hop['from']) and not climbing.get(hop['to']) and (jump_key in hop['keys'] or hop['dy'] < -m.snap / 2):
            continue  # a jump off a platform, or a rise without the jump key (pressed between samples): the physics' own instead
        for i, (x, y, li, s) in enumerate(m.places):
            if m.lines[li][0] != hop['from'] or abs(m.edge(li, s) - hop['edge']) > EDGE_TOLERANCE:
                continue
            # where it lands: on a line about dx, dy away, but never higher or further across than it was made (from line
            # to line, whatever the player's position is offset by), at the line's own nearest point (places are every `cell` px:
            # measured to the nearest place, getting off a rope 4 px across read as 17, and was the level's only way up),
            # its place the one along that line nearest it
            j = None
            for _, lj, sj, qx, qy in m.landings(x + hop['dx'], y + hop['dy'], tolerance, hop['to']):
                ldx, ldy = qx - x, qy - y  # on the lines, as hops are learned
                # within one jump made: as high and as far as it at most (and on its side), or, from before `made`
                # was kept, the highest and furthest
                if not any(ldy >= mdy - up and abs(ldx) <= abs(mdx) + out_ and (ldx * mdx >= 0 or abs(ldx) <= out_)
                           for mdx, mdy in hop.get('made') or [(hop.get('far', abs(hop['dx'])) * (1 if hop['dx'] >= 0 else -1), hop.get('top', hop['dy']))]):
                    continue
                k = m.nearest_on(lj, sj)
                if k != i and (not solid or _clear(m, i, k, hop.get('rise', 0.0))):
                    j = k
                    break
            # a jump along the shape it's on, where walking that way was learned, isn't planned: walking there is
            # as quick and sure, and done as a hop it backed up for a run-up before every one
            if j is not None and m.places[j][2] == li and ('+' if m.places[j][3] > s else '-') in moves['along'].get(m.lines[li][0], {}):
                continue
            if j is not None and j != i:
                out.append([i, j, hop['ms'] + cost, hop['n'], hop['keys']])
                if (i, j) not in hop_of or hop['ms'] < hops[hop_of[(i, j)]]['ms']:
                    hop_of[(i, j)] = h
    if use:
        _physics_hops(m, phys, moves, climbing, solid, cost, hops, out, hop_of)
    return {'cell': m.cell, 'places': places, 'moves': out, 'hop_of': hop_of, 'hops': hops, 'physics': phys if use else None}


def _physics_hops(m, phys, moves, climbing, solid, cost, hops, out, hop_of):
    """Jumps off a level's platforms by its physics: from every place straight up, and either way at the walking
    speed, and walking off each end of each platform, each to where its arc first comes down onto a shape (a rope
    caught anywhere it passes); none back onto the platform it left (walked instead). Each is a hop with one example
    the executor does it by: from standing at its place, the direction key and the jump key pressed together."""
    index = physics_.Lines([(a, pts) for a, pts, _ in m.lines], m.upright)
    walk, launch = phys['walk'], phys['jump']
    jump_key, keys_of = phys.get('jumpKey'), {1: phys.get('rightKey'), -1: phys.get('leftKey')}
    hold = phys.get('jumpHoldMs') or 150
    climb = _climb_key(m, moves, climbing)
    # how near a spot the player can be stopped (physics.fit's `precision`): a jump's chance is the share of takeoffs
    # within it either side that land on the same shape (off the platform's end is a miss), and it's planned as its time
    # over its chance (with the tries it takes); none is kept back for being hard, the only way being often a hard one
    err = max(0.0, phys.get('precision') or 0.0)
    offsets = [err * f for f in (-1, -0.5, 0, 0.5, 1)] if err else [0.0]
    for li, idx in enumerate(m.of_line):
        alias, pts, length = m.lines[li]
        if climbing.get(alias) or m.upright(li) or len(pts) < 2:
            continue
        for i in idx:
            x, y, _, s = m.places[i]
            trials = [(0, launch)] + [(d, launch) for d in (1, -1) if keys_of[d]]
            if i in (idx[0], idx[-1]) and len(idx) > 1:  # walking off this end
                end = pts[0] if i == idx[0] else pts[-1]
                nxt = pts[1] if i == idx[0] else pts[-2]
                d = 1 if end[0] > nxt[0] else -1
                if keys_of[d]:
                    trials.append((d, 0.0))
            for d, up in trials:
                st, chance = s, 1.0
                if up and err:
                    # where each takeoff within the precision lands; the jump is to where most land, taken off from the
                    # middle of the takeoffs that do
                    lands = [(e, physics_.arc(phys, index, *_at(pts, s + e), d * walk, up, li, solid) if 0 <= s + e <= length else None)
                             for e in offsets]
                    to = Counter(h[0] for _, h in lands if h is not None and h[0] != li)
                    if not to:
                        continue
                    k_best = to.most_common(1)[0][0]
                    good = [e for e, h in lands if h is not None and h[0] == k_best]
                    chance = len(good) / len(offsets)
                    st = s + sum(good) / len(good)
                x, y = _at(pts, st)
                hit = physics_.arc(phys, index, x, y, d * walk, up, li, solid)
                if hit is None:
                    continue
                k, hx, hy, ms, rise = hit
                if k == li:
                    continue
                j = m.nearest_on(k, _project(m.lines[k][1], hx, hy))
                if j == i:
                    continue
                keys = [kk for kk in ([keys_of[d]] if d else []) + ([jump_key] if up else []) if kk]
                if m.upright(k) and climb:
                    keys.append(climb)  # catching a rope: holding the climbing key
                line = [[0.0, kk, True] for kk in keys] + ([[float(hold), jump_key, False]] if up and jump_key else [])
                example = {'ax': 0.0, 'ay': 0.0, 'dx': round(hx - x, 1), 'dy': round(hy - y, 1), 'vx': 0.0, 'vy': 0.0, 'keys': [],
                           'end': round(ms, 1), 'timeline': sorted(line, key=lambda e: e[0]), 'edge': round(m.edge(li, st), 1)}
                hop = {'from': alias, 'to': m.lines[k][0], 'dx': example['dx'], 'dy': example['dy'], 'edge': example['edge'],
                       'ms': round(ms, 1), 'keys': sorted(keys), 'n': 0, 'rise': round(rise, 1), 'physics': True, 'examples': [example]}
                hops.append(hop)
                hop['chance'] = round(chance, 2)
                out.append([i, j, round((ms + cost) / chance, 1), 1, hop['keys']])
                if (i, j) not in hop_of or hop['ms'] < hops[hop_of[(i, j)]]['ms']:
                    hop_of[(i, j)] = len(hops) - 1


def _climb_key(m, moves, climbing):
    """The key held climbing up a rope or ladder: along an input of mostly upright lines, the way that goes up."""
    for k, (alias, pts, _) in enumerate(m.lines):
        if climbing.get(alias) and m.upright(k) and len(pts) > 1:
            ways = moves.get('along', {}).get(alias, {})
            up = '+' if pts[-1][1] < pts[0][1] else '-'  # s grows toward the line's last point
            keys = (ways.get(up) or {}).get('keys') or []
            if keys:
                return keys[0] if len(keys) == 1 else next((key for key in keys if key not in ('left', 'right')), keys[0])
    return None


def _project(points, x, y):
    """How far along a line its nearest point to (x, y) is."""
    if len(points) < 2:
        return 0.0
    best, run = None, 0.0
    for a, b in zip(points, points[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        d2 = dx * dx + dy * dy
        k = 0.0 if d2 == 0 else max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / d2))
        d = math.hypot(a[0] + k * dx - x, a[1] + k * dy - y)
        if best is None or d < best[0]:
            best = (d, run + k * math.sqrt(d2))
        run += math.sqrt(d2)
    return best[1]
