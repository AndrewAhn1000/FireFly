"""The Planner node's Drive: the planner moves the player itself, along its way to the destination, with nothing known
about any game.

Each frame it plans from where the player is (planner.Planner, a level's places along shapes) and does the first move
of the way:
  along a shape (walking a platform, climbing a rope): holds the keys the player held going that way along that
    input's shapes until the next hop's start, or the destination, is reached;
  a hop: does it as the player once did (one of the hop's examples, planner._example: the keys held going into it,
    then every press and let-go from its anchor, to the millisecond). Getting into position first: for a hop taken
    standing, to where its anchor was, stopped; for one taken on the move, from far enough back to be going as fast
    as it was there, starting its presses as the anchor is crossed. Then, committed: the presses are played as they
    were, and it lands where the example did (a move done) or not (a miss: the move costs more from then on, so the
    way round it is planned if there is one, Planner.penalize).

Frames reach it some time after they were captured, so where the player is now is reckoned from where they were and
how fast they were going (the frame's age is given). Keys are pressed once a frame, so a press shorter than the time
between frames is still pressed for one, and each press goes in the frame nearest its time.

Its px (and px/ms) are at MapleStory's scale, where they were tuned, and are the game's own through its planner's
`scale` (planner.Scale, from its recordings' hops)."""
import math
from collections import Counter

import planner as planner_

STILL = 0.03          # px/ms: slower than this is standing
ARRIVE_PX = 8         # px from a standing hop's anchor it starts from
RUNUP_MS = 250        # a hop taken on the move starts at least this long's walk before its anchor
RUNUP_MIN_PX = 20     # the shortest run-up
MOVING_SHARE = 0.5    # a hop counts as taken on the move when going at least this share of the walking speed (a slower
                      # speed is a stop or turn under way: taken as on the move, it ran at full speed and overshot)
EDGE_IN_PX = 3        # px inside a shape's end a hop's start is kept (an example pressing jump just past the edge had
                      # it run off it); and a run-up never backs off the end
LAND_AFTER = 0.4      # of a hop's time, before a landing near where it should counts
LAND_GRACE_MS = 250   # after its time, landed somewhere else is a miss
AIR_MS = 1500         # after its time, not landed at all is a miss
POSITION_MS = 5000    # getting into position for a hop longer than this: a miss
SPEED_MS = 100        # the player's speed, over this long
TIMELINE_AFTER_MS = 100  # after a hop's time, its keys are let go of
EXAMPLE_MISS_PX = 40  # an example that missed counts as this much further off
MAX_MISSES = 8        # a hop's misses noted (the latest)
GIVE_UP = 5           # misses of one jump (between the same two shapes, the same keys) before it's given up on: with no
                      # other way, it was tried again and again for as long as it drove


class Executor:
    def __init__(self):
        self.hop = None          # the hop being done: its move, example, phase ('position' | 'go'), and when
        self.track = []          # [(capture t, x, y)], the last SPEED_MS and more
        self.frame_ms = 45.0     # the time between frames, a running mean
        self.last_now = None
        self.done = self.missed = 0
        self.example_misses = Counter()  # (hop index, example index): times missed
        self.jump_misses = Counter()     # (from shape, to shape, keys): times tried and missed, a jump however it was made
        self.given_up = []               # the jumps given up on, [(from, to)] as points
        self.misses = []         # the latest misses, for the banner: {from, to, why}
        self.air_since = None
        self.here = None         # the place it planned from in the latest frame, and the first few of its way (for a trace)
        self.route_head = None

    # ── the frame ───────────────────────────────────────────────────────────────────────────────────────────────
    def step(self, t, now, x, y, planner, destination, away=None):
        """The keys to hold now (a set of button ids) and what it's doing ({phase, text, ...}), for the player at
        (x, y) at capture time t; `now` is when the keys will be pressed (t plus the frame's age)."""
        self._remember(t, x, y)
        if self.last_now is not None:
            self.frame_ms = 0.8 * self.frame_ms + 0.2 * min(200.0, max(5.0, now - self.last_now))
        self.last_now = now
        if self.hop and self.hop['planner'] is not planner:
            self.hop = None  # another level
        if self.hop and self.hop['phase'] == 'go':
            keys, status = self._fly(now, x, y, planner)
            if status is not None:
                return keys, status
        return self._plan(t, now, x, y, planner, destination, away)

    def _plan(self, t, now, x, y, planner, destination, away):
        m = planner.map
        vx, vy = self._speed()
        lead = max(0.0, now - t)
        px, py = x + vx * lead, y + vy * lead
        # standing on a shape only once come down onto it (falling past a platform's end read as on it: it began its
        # next run-up in the air and fell)
        on = m.lands(x, y, vy < -planner.scale.px(STILL))
        if on is None:
            if self.hop is not None and self.hop['phase'] == 'position':
                # fell off getting into position for it (walked off an edge): that hop failed, so it costs more
                self._miss(planner, self.hop, f'it fell off at ({x:.0f}, {y:.0f}) getting into position for it', attempted=False)
            self.hop = None
            self.air_since = self.air_since or now
            return set(), self._status('air', 'in the air, waiting to land' if now - self.air_since < 3000
                                       else f'off every shape it plans along for {(now - self.air_since) / 1000:.0f} s')
        self.air_since = None
        li, s = on
        here = min(m.of_line[li], key=lambda i: abs(m.places[i][3] - s))
        goal = planner.place_at(None, *destination)
        if goal is None:
            return set(), self._status('noway', 'no places along shapes here')
        reach = max(m.snap, m.cell / 2)
        if here == goal or math.hypot(x - destination[0], y - destination[1]) <= reach:
            self.hop = None
            return set(), self._status('arrived', 'at the destination')
        route = planner.path(here, goal, None, away)
        self.here = [round(planner.places[here][1]), round(planner.places[here][2])]
        self.route_head = [[round(planner.places[i][1]), round(planner.places[i][2]), (a, i) in planner.hop_of]
                           for a, i in zip((route or [])[:6], (route or [])[1:7])]
        if not route or route[-1] != goal:
            self.hop = None
            if self.given_up:  # a jump it gave up on was the only way
                (fr, to), n = self.given_up[-1], len(self.given_up)
                return set(), self._status('stuck', f'no other way there: it gave up on the jump from ({fr[0]}, {fr[1]}) to ({to[0]}, {to[1]}) '
                                                    f'after {GIVE_UP} tries' + (f' (and {n - 1} more)' if n > 1 else ''))
            return set(), self._status('noway', 'no move you’ve made leads from here to the destination')
        pairs = list(zip(route, route[1:]))
        first = next((k for k, ab in enumerate(pairs) if ab in planner.hop_of), None)
        axis = self._axis(m, li)
        c, v = (px, py)[axis], (vx, vy)[axis]
        if first is None:
            # along this shape to the destination
            end = planner.places[route[-1]]
            return self._walk_to(planner, li, here, axis, c, v, (end[1], end[2])[axis], 'walking to the destination', end)
        a, b = pairs[first]
        hop = self.hop if self.hop and (self.hop['a'], self.hop['b']) == (a, b) else None
        if hop is None and self._keeps(planner, li, here, goal, away):
            # committed: getting into position moves the player, and planning from each new place picked the same jump
            # from there, with its run-up further back again (it backed off for seconds)
            hop = self.hop
        if hop is None:
            hop = self._choose(planner, a, b, now)
        self.hop = hop
        if hop is None:
            return set(), self._status('noway', 'a hop on the way has no example to do it by')
        # no nearer its start for this long (blocked, or never quite placed): a miss
        gap = abs(hop['anchor'][axis] - c)
        if gap < hop['nearest'] - 4:
            hop['nearest'], hop['since'] = gap, now
        if now - hop['since'] > POSITION_MS:
            self._miss(planner, hop, f'it couldn’t get into position for it: {gap:.0f} px from its start ({hop["anchor"][0]:.0f}, '
                                     f'{hop["anchor"][1]:.0f}) for {POSITION_MS / 1000:.0f} s, at ({x:.0f}, {y:.0f})', attempted=False)
            return set(), self._status('position', 'trying another way: it couldn’t get into position')
        return self._position(planner, li, here, axis, c, v, hop, now)

    def _keeps(self, planner, li, here, goal, away):
        """Whether the hop it's getting into position for is still a way there from here: it starts on this shape, and
        lands where the destination is nearer than from here."""
        hop = self.hop
        if hop is None or hop['phase'] != 'position' or hop['planner'] is not planner or planner.map.places[hop['a']][2] != li:
            return False
        times = planner.times_to(goal)
        return hop['b'] in times and times[hop['b']] < times.get(here, math.inf)

    # ── getting into position, and going ──────────────────────────────────────────────────────────────────────
    def _position(self, planner, li, here, axis, c, v, hop, now):
        px = planner.scale.px  # the game's own px, from its recordings' scale
        e, target = hop['example'], hop['anchor'][axis]
        ve = e['vx'] if axis == 0 else e['vy']
        to = planner.places[hop['b']]
        where = f"({to[1]:.0f}, {to[2]:.0f})"
        if abs(ve) < self._moving(planner, li):
            # taken standing: to its anchor, then still, then go
            off = target - c
            if abs(off) > px(ARRIVE_PX):
                if abs(off) <= self._stopping(planner, v) and v * off > 0:
                    return set(), self._status('position', f'getting into position for a hop to {where}: {abs(off):.0f} px, coasting', hop)
                return self._walk_dir(planner, li, here, axis, 1 if off > 0 else -1,
                                      f'getting into position for a hop to {where}: {abs(off):.0f} px', hop)
            if abs(v) > px(STILL):
                return set(), self._status('position', f'stopping for a hop to {where}', hop)
            if not self._settled(planner, axis):
                return set(), self._status('position', f'landing before a hop to {where}', hop)
            return self._go(now, hop, planner)
        # taken on the move: from far enough back to be going as fast (its run-up), its presses starting as the anchor
        # is crossed. Once running toward it, it keeps on (turning round reads as standing still for a moment); past
        # the anchor without the speed, it backs up for a longer run-up
        d = 1 if ve > 0 else -1
        ahead = (target - c) * d
        fast = v * d >= 0.5 * abs(ve)
        lo, hi = self._extent(planner, li, axis)
        room = (target - lo if d > 0 else hi - target) - px(EDGE_IN_PX)  # how far back there is to run up from
        if hop['run'] is None:
            hop['need'] = min(max(px(RUNUP_MIN_PX), abs(ve) * RUNUP_MS), max(0.0, room))
            hop['run'] = 'toward' if ahead >= hop['need'] or (ahead > 0 and fast) else 'back'
        if hop['run'] == 'back':
            if ahead < hop['need']:
                return self._walk_dir(planner, li, here, axis, -d, f'backing up for a run-up to a hop to {where}', hop)
            hop['run'] = 'toward'
        if ahead < -px(ARRIVE_PX):
            hop['run'], hop['need'] = 'back', min(hop['need'] * 1.5 + 5, max(0.0, room))
            return self._walk_dir(planner, li, here, axis, -d, f'backing up for a run-up to a hop to {where}', hop)
        if ahead <= abs(v) * self.frame_ms / 2 + 1 and fast and self._settled(planner, axis):
            return self._go(now, hop, planner)
        keys = set(e['keys']) | (self._walk_keys(planner, li, here, axis, d) or set())
        return keys, self._status('position', f'running up to a hop to {where}: {max(0.0, ahead):.0f} px', hop)

    def _go(self, now, hop, planner):
        hop.update(phase='go', start=now, held=set(hop['example']['keys']), next=0)
        keys, status = self._fly(now, None, None, planner)
        return keys, status or self._status('jump', 'jumping', hop)

    def _fly(self, now, x, y, planner):
        """A hop under way: its presses up to now, and whether it has landed (then None for the status: plan on)."""
        hop, e = self.hop, self.hop['example']
        t = now - hop['start']
        line = e['timeline']
        pressed = set()
        # each press in the frame nearest its time (keys go once a frame: two pressed together, a millisecond apart, go
        # together, as they were)
        while hop['next'] < len(line) and line[hop['next']][0] <= t + self.frame_ms / 2:
            _, key, down = line[hop['next']]
            hop['next'] += 1
            if down:
                hop['held'].add(key)
                pressed.add(key)
            else:
                hop['held'].discard(key)
        if t > e['end'] + TIMELINE_AFTER_MS:
            hop['held'] = set()
        keys = hop['held'] | pressed
        if x is not None and 'left_at' not in hop:
            hop['left_at'] = (x, y)  # where it really took off from, for a miss's reason
        if x is not None:
            m = planner.map
            to = planner.places[hop['b']]
            on = m.lands(x, y, self._speed()[1] < -planner.scale.px(STILL))
            near = math.hypot(x - to[1], y - to[2]) <= m.snap + hop['tolerance']
            if on is not None and near and t >= LAND_AFTER * e['end']:
                self.done += 1
                self.hop = None
                return set(), None
            if (on is not None and t >= e['end'] + LAND_GRACE_MS) or t >= e['end'] + AIR_MS:
                went = hop.get('left_at', (x, y))
                start = f"taking off at ({went[0]:.0f}, {went[1]:.0f}), {math.hypot(went[0] - hop['anchor'][0], went[1] - hop['anchor'][1]):.0f} px from its start"
                self._miss(planner, hop, (f'it landed at ({x:.0f}, {y:.0f}), {math.hypot(x - to[1], y - to[2]):.0f} px from where it should, {start}' if on is not None
                                          else f'it was still in the air at ({x:.0f}, {y:.0f}) {t - e["end"]:.0f} ms after it should have landed, {start}'))
                return set(), None
        return keys, self._status('jump', f"jumping {max(0.0, t):.0f}/{e['end']:.0f} ms", hop)

    def _choose(self, planner, a, b, now):
        """The hop from a to b, by the example most likely to land at b from here (misses counting against one)."""
        h = planner.hop_of[(a, b)]
        hop = planner.hops[h]
        examples = hop.get('examples') or []
        best = None
        for k, e in enumerate(examples):
            take = self._takeoff(planner, a, b, e)
            to = planner.places[b]
            off = math.hypot(take[0] + e['dx'] - to[1], take[1] + e['dy'] - to[2]) + planner.scale.px(EXAMPLE_MISS_PX) * self.example_misses[(h, k)]
            if best is None or off < best[0]:
                best = (off, k, e, take)
        if best is None:
            return None
        _, k, e, take = best
        # its start on the shape: an example that pressed jump just past the edge would have it run off the edge first
        li = planner.map.places[a][2]
        axis = self._axis(planner.map, li)
        lo, hi = self._extent(planner, li, axis)
        anchor = [take[0] + e['ax'], take[1] + e['ay']]
        inside = planner.scale.px(EDGE_IN_PX)
        anchor[axis] = min(hi - inside, max(lo + inside, anchor[axis]))
        return {'a': a, 'b': b, 'h': h, 'k': k, 'example': e, 'planner': planner, 'phase': 'position', 'since': now,
                'run': None, 'need': 0.0, 'nearest': math.inf, 'takeoff': take[:2], 'anchor': tuple(anchor),
                'tolerance': planner_.TOLERANCE}

    @staticmethod
    def _extent(planner, li, axis):
        """Where a shape starts and ends along the axis it's walked on, as the player stands on it (its places)."""
        ends = [planner.places[i][axis + 1] for i in planner.map.of_line[li]]
        return min(ends), max(ends)

    @staticmethod
    def _moving(planner, li):
        """The least speed a hop's example is taken on the move at: a share of the walking speed along that input's
        shapes (else STILL)."""
        ways = getattr(planner, 'along', {}).get(planner.map.lines[li][0]) or {}
        return max([planner.scale.px(STILL)] + [MOVING_SHARE * w['speed'] for w in ways.values()])

    @staticmethod
    def _takeoff(planner, a, b, e):
        """Where on a's shape the player takes off for this example: as far from its nearer end as the example was,
        near an end; else where the example's jump would land at b."""
        m = planner.map
        _, _, li, sa = m.places[a]
        alias, pts, length = m.lines[li]
        off = planner.offset.get(alias, (0, 0))
        if e['edge'] < planner_.EDGE_FAR - 1:
            s = e['edge'] if sa <= length - sa else length - e['edge']
        else:
            to = planner.places[b]
            s = _project(pts, to[1] - e['dx'] - off[0], to[2] - e['dy'] - off[1])
            s = min(sa + m.cell, max(sa - m.cell, s))
        s = min(length, max(0.0, s))
        px, py = planner_._at(pts, s) if len(pts) > 1 else pts[0]
        return px + off[0], py + off[1], s

    def _stopping(self, planner, v):
        """How far short of a spot to let go of the key walked with, going at v: the slide measured (physics.fit's
        `slide`, as far as the player goes on after letting go), and half the walk till the next frame, the keys
        being pressed once a frame (without the slide, it overshot spots near an edge and fell off)."""
        slide = (getattr(planner, 'physics', None) or {}).get('slide') or 0.0
        walk = (getattr(planner, 'physics', None) or {}).get('walk') or abs(v)
        return max(0.0, slide) * (abs(v) / walk if walk else 1.0) + abs(v) * self.frame_ms / 2

    def _settled(self, planner, axis):
        """Whether the player is still across the shape they're on (not still coming down onto it): a jump pressed
        while landing did nothing, and holding the key didn't jump once down, so it walked off the edge instead."""
        if len(self.track) < 2 or self.track[-1][0] - self.track[0][0] < 30:
            return False  # too soon to tell
        vx, vy = self._speed()
        return abs(vy if axis == 0 else vx) <= planner.scale.px(STILL)

    @staticmethod
    def _jump(planner, a, b):
        """A jump however it's made: the shapes it joins and its keys."""
        h = planner.hop_of.get((a, b))
        return planner.map.places[a][2], planner.map.places[b][2], tuple(sorted(planner.hops[h]['keys'])) if h is not None else ()

    def _miss(self, planner, hop, why, attempted=True):
        """A hop that didn't happen: it costs more, as does every jump alike; tried (not just failed to get into
        position for, which said nothing of the jump) GIVE_UP times, it and every jump alike are ruled out, so the way
        round is planned, or none."""
        self.missed += 1
        self.example_misses[(hop['h'], hop['k'])] += 1
        jump = self._jump(planner, hop['a'], hop['b'])
        if attempted:
            self.jump_misses[jump] += 1
        # the same jump between the same two shapes from any place, done the same way (its keys), costs more: only its
        # own two places did, and it tried the same jump again from the place beside them, over and over (and the
        # physics makes a jump of its own from every place)
        la, lb = planner.map.places[hop['a']][2], planner.map.places[hop['b']][2]
        keys = set(planner.hops[hop['h']]['keys'])
        out = self.jump_misses[jump] >= GIVE_UP
        for (a, b), h in planner.hop_of.items():
            if planner.map.places[a][2] == la and planner.map.places[b][2] == lb and set(planner.hops[h]['keys']) == keys:
                if out:
                    planner.penalty[(a, b)] = math.inf
                else:
                    planner.penalize(a, b)
        planner._fields = {}
        fr, to = planner.places[hop['a']], planner.places[hop['b']]
        if out:
            self.given_up.append(([round(fr[1]), round(fr[2])], [round(to[1]), round(to[2])]))
        self.misses = (self.misses + [{'from': [round(fr[1]), round(fr[2])], 'to': [round(to[1]), round(to[2])], 'why': why}])[-MAX_MISSES:]
        self.hop = None

    # ── walking ─────────────────────────────────────────────────────────────────────────────────────────────────
    def _walk_to(self, planner, li, here, axis, c, v, target, text, end):
        off = target - c
        if abs(off) <= planner.scale.px(ARRIVE_PX) or (abs(off) <= self._stopping(planner, v) and v * off > 0):
            return set(), self._status('walk', f'{text}: {abs(off):.0f} px')
        return self._walk_dir(planner, li, here, axis, 1 if off > 0 else -1, f'{text}: {abs(off):.0f} px')

    def _walk_dir(self, planner, li, here, axis, d, text, hop=None):
        keys = self._walk_keys(planner, li, here, axis, d)
        if keys is None:
            return set(), self._status('stuck', f'{text}, but you never went that way along this shape', hop)
        return keys, self._status('position' if hop else 'walk', text, hop)

    @staticmethod
    def _walk_keys(planner, li, here, axis, d):
        """The keys for going way d (+1: x or y growing) along line li from place `here`: those of the move to the
        neighbouring place that way (None if there's no such move)."""
        line = planner.map.of_line[li]
        k = line.index(here)
        near = [line[i] for i in (k - 1, k + 1) if 0 <= i < len(line)]
        way = lambda a, b: (planner.places[b][axis + 1] - planner.places[a][axis + 1]) * d > 0  # noqa: E731
        for nb in near:  # the move from here to the neighbour that way
            if way(here, nb) and (here, nb) in planner.edges:
                return set(planner.edges[(here, nb)][1])
        for nb in near:  # at the line's end that way: the move into here going that way
            if way(nb, here) and (nb, here) in planner.edges:
                return set(planner.edges[(nb, here)][1])
        return None

    # ── where the player is going ──────────────────────────────────────────────────────────────────────────────
    def _remember(self, t, x, y):
        if self.track and t <= self.track[-1][0]:
            return
        self.track.append((t, x, y))
        while len(self.track) > 2 and self.track[-1][0] - self.track[1][0] > SPEED_MS:
            self.track.pop(0)
        if len(self.track) == 2 and self.track[1][0] - self.track[0][0] > 3 * SPEED_MS:
            self.track.pop(0)  # after a gap: what came before says nothing of how it's moving now

    def _speed(self):
        if len(self.track) < 2:
            return 0.0, 0.0
        (t0, x0, y0), (t1, x1, y1) = self.track[0], self.track[-1]
        if t1 - t0 < 20 or t1 - t0 > 3 * SPEED_MS:
            return 0.0, 0.0
        return (x1 - x0) / (t1 - t0), (y1 - y0) / (t1 - t0)

    @staticmethod
    def _axis(m, li):
        pts = m.lines[li][1]
        return 0 if abs(pts[-1][0] - pts[0][0]) >= abs(pts[-1][1] - pts[0][1]) else 1

    def _status(self, phase, text, hop=None):
        out = {'phase': phase, 'text': text, 'done': self.done, 'missed': self.missed, 'misses': self.misses}
        if hop is not None:
            fr, to = hop['planner'].places[hop['a']], hop['planner'].places[hop['b']]
            out['hop'] = {'from': [round(fr[1]), round(fr[2])], 'to': [round(to[1]), round(to[2])], 'example': hop['k'],
                          'anchor': [round(hop['anchor'][0], 1), round(hop['anchor'][1], 1)]}
        return out


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
