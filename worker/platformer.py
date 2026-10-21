"""An optional movement model for side-view platformers: where a jump pressed at some place lands, so a recorded jump's
press can be timed by where the player is rather than by the clock (adaptive takeoff, docs/action-execution.md).

Nothing in a map's planning depends on it. A map turns it on (its replay's `takeoff`) and names the State whose lines
are the ground; everything else is measured from the map's own recordings: the jump key and the keys each way, walking
speed, launch speed and gravity, how long after a press the player leaves the ground, and how far the model is from
each recorded jump. A jump it can't predict (keys changing in the air, other keys held, landing on a rope or on no line
it knows) stays timed as recorded. One it predicts but can't execute safely is unsafe, so the map can go another way.

Timing. A press's launch is fitted as the origin of its arc (the launch speed and gravity fitted to read-time
positions): it can come before the press, since the game moves the player a whole update (about 30 ms on the user's
jump quest) at once and positions are read up to an update late, so the curve through them starts up to an update
early. Landings are predicted in that convention, from the spread of fitted launches (`delays`), late end widened by
INJECTED_MS for presses FireFly sends. When the player actually leaves the ground (for walking off the end first) is
bounded from the readings instead: the first rising reading after the press (`leaveMs`, p90)."""
import bisect
import math
import statistics
from collections import Counter

import numpy as np

ON_PX = 3.0            # on a platform: within this of its line
RISE_PX = 10.0         # a jump rises at least this
PRESS_BEFORE, PRESS_AFTER = 150.0, 60.0  # a jump's press: this long before it left the ground to this long after
MIN_JUMPS = 5
FIT_RMS = 6.0          # a jump whose arc fits within this (px rms) counts toward launch speed and gravity
FIT_MS = 500.0         # fitting an arc, its readings up to this long after the press (before falling at its fastest)
# Presses FireFly sends reach the game later than the player's own: in the controlled experiment (guard send times)
# the fitted launches came 6 ms later at the median and at p90 than the recordings' (hook times)
INJECTED_MS = 10.0
EDGE_PX = 2.0          # leaving the ground at the latest it leaves, at least this before the starting platform's end
LAND_MARGIN = 6.0      # landing at least this inside the target (the model's p90 landing error, about 4 px, and a step)
EXEC_PX = 8.0          # a safe stretch at least this wide is executable (a press lands within about a game step either way)
INSET_PX = 4.0         # aiming at least this inside the safe stretch
SEARCH_PX, SEARCH_STEP = 60.0, 0.5
MODEL_MAX_PX = 15.0    # predicting its own recorded landing further off than this, the model doesn't know the jump
UNCHECKED_PX = 4.0     # more landing margin for a jump the model couldn't be checked against (pressed past the edge)
# A jump's last reading on the ground can already be in the air: the State saying so can lag the position by a reading.
# One this much above the line the reading before stood on, within this long of it, is taken as off the ground already
# (the user's second jump quest's movement 6 jump 3: On Ground still true 16 px up, so the jump read as not from a line)
TAKE_STALE_MS = 100.0
# A recorded landing this near the far end of its target (the way it flew) may have been stopped there, by a wall the
# lines don't show: the model carrying it on past is no measure of its error (_distrusted)
COLLIDE_PX = ON_PX
# A segment of a ground line shorter than this is a step in how it was drawn, not a slope (Ground.graded)
GRADE_MIN_PX = 3.0
# A jump played as recorded whose recording landed under this far from an end of the platform it landed on has no room
# to spare: its movement is marked unsafe (taken only with no other way). The alternate route's jump 12 landed at its
# platform's very end; played as recorded it went past it twice in two runs, the jump before landing 4-8 px either way
THIN_LANDING_PX = LAND_MARGIN / 2
# A near miss's landing margin from how far the model's landings were from where the map's jumps came down in play, in
# the same conditions (calibration.summary: the grade it's pressed on, and whether within CAL_FRESH_MS of a landing),
# rather than from how far its one recording was from the model, which is that recording's own spread too
CAL_FRESH_MS = 60.0
# A movement's valid starting region (start_region): how far from its recorded start it may begin when what follows
# absorbs it, at most this either way, on the start's line and ground graded as there
START_REGION_PX = 16.0
# Where a recorded walk came to rest: the furthest it got along its way, on the ground, up to this long after its clip
# ends (it slides on after its last key) or the next key going down, whichever is first
REST_MS = 400.0
GIVE_UP_MS = 4000.0
MOVING = 0.5           # moving: at least this share of walking speed
STEER = 0.2            # a key pressed in the air that changed the player's speed across by this share of walking steered
NUDGE_PX = 12.0        # presses after a last takeoff that moved the player at most this from where it landed: a nudge
# Recovery checkpoints (checkpoints()): a landing slower than STABLE of walking with no key held each way is stable (the
# player can stop there and go on as recorded); else dynamic, reproducible only by running up into it. Resuming one, the
# player is within CHECK_REGION_PX of where it landed and its speed within CHECK_SPEED of walking of the recording's
STABLE, CHECK_REGION_PX, CHECK_SPEED = 0.3, 4.0, 0.25
# Ground the player may not stop on after a key is let go of: a line sloping down the way it goes by more than this many
# px per px (Ground.safe_room). On the user's second jump quest a correction tap carried the player 2 px past a crest
# (a flat top, then 0.5-1.5 downhill to the line's end) and it slid on down and off, 300 ms with no key held. A first
# safeguard: how far the player goes on after letting go isn't modelled yet
CREST_GRADE = 0.2
BY_POSITION = ('adapt', 'position', 'narrow', 'unsafe')  # jumps the executor presses by where the player is


def _q(values, p):
    v = sorted(values)
    return v[min(len(v) - 1, max(0, int(p * (len(v) - 1))))]


def _point(p):
    if isinstance(p, dict):
        return float(p.get('x')), float(p.get('y'))
    return float(p[0]), float(p[1])


class Ground:
    """A level's platforms: lines [[x, y], ...] (upright segments, ropes and walls, are left out). Indexed by line `k`."""

    def __init__(self, lines):
        self.lines = []
        self.segs = []  # (k, ax, ay, bx, by, slope), ax < bx
        for line in lines or []:
            try:
                pts = [_point(p) for p in line]
            except (TypeError, ValueError, KeyError, IndexError):
                continue
            if len(pts) < 2 or not all(math.isfinite(c) for p in pts for c in p):
                continue
            k = len(self.lines)
            self.lines.append(pts)
            for a, b in zip(pts, pts[1:]):
                if a[0] == b[0]:
                    continue
                (ax, ay), (bx, by) = (a, b) if a[0] < b[0] else (b, a)
                self.segs.append((k, ax, ay, bx, by, (by - ay) / (bx - ax)))

    @staticmethod
    def of(value, feet=0.0):
        """The ground from a shapes State's value: each shape's `points` (or a [x, y] list), as lines, raised `feet`
        px (to where the position stands on them)."""
        lines = []
        for s in value if isinstance(value, list) else []:
            pts = s.get('points') if isinstance(s, dict) else s
            if isinstance(pts, list) and len(pts) >= 2:
                try:
                    lines.append([[x, y - feet] for x, y in (_point(p) for p in pts)])
                except (TypeError, ValueError, KeyError, IndexError):
                    continue
        return Ground(lines)

    def y_on(self, k, x):
        """Line k's height at x, or None past its ends."""
        for kk, ax, ay, bx, by, m in self.segs:
            if kk == k and ax <= x <= bx:
                return ay + m * (x - ax)
        return None

    def ends(self, k):
        xs = [p[0] for p in self.lines[k]]
        return min(xs), max(xs)

    def graded(self, k, x, way, grade=CREST_GRADE, least=GRADE_MIN_PX):
        """The ground of line k graded as it is at x, the way `way` (-1 or 1) the player goes: 'flat', 'down' (sloping
        down that way by more than `grade` px per px, screen y growing downward) or 'up'; and the stretch of the line
        around x graded so, (grade, lo, hi), or None off it. A segment under `least` px long is a step in how the line
        was drawn, not a slope: it goes with the ground around it (on one, the ground the player came from)."""
        segs = sorted((s for s in self.segs if s[0] == k), key=lambda s: s[1])

        def kind(s):
            if s[3] - s[1] < least:
                return None
            m = s[5] * way
            return 'down' if m > grade else 'up' if m < -grade else 'flat'
        at = next((n for n, s in enumerate(segs) if s[1] <= x < s[3]), None)
        if at is None:
            at = next((n for n, s in enumerate(segs) if s[1] <= x <= s[3]), None)
        if at is None:
            return None
        kinds = [kind(s) for s in segs]
        g = kinds[at]
        if g is None:
            back = range(at - 1, -1, -1) if way > 0 else range(at + 1, len(segs))
            ahead = range(at + 1, len(segs)) if way > 0 else range(at - 1, -1, -1)
            g = next((kinds[n] for n in [*back, *ahead] if kinds[n] is not None), 'flat')
        a = b = at
        while a > 0 and kinds[a - 1] in (g, None):
            a -= 1
        while b < len(segs) - 1 and kinds[b + 1] in (g, None):
            b += 1
        return g, segs[a][1], segs[b][3]

    def on(self, x, y, within=ON_PX):
        """(line, its height at x) the player at (x, y) stands on, or None."""
        best = None
        for k, ax, ay, bx, by, m in self.segs:
            if ax <= x <= bx:
                ly = ay + m * (x - ax)
                if abs(ly - y) <= within and (best is None or abs(ly - y) < abs(best[1] - y)):
                    best = (k, ly)
        return best

    def safe_room(self, k, x, way, beyond=None, grade=CREST_GRADE):
        """How far from x along line k the player can go `way` (-1 or 1) and still be on ground it can stop on: to the
        line's end, or to where it next slopes down that way by more than `grade` (CREST_GRADE), from which a game may
        carry the player on with nothing held. With `beyond` (a target), only such ground past the target counts: a
        downhill before it is the way there; one starting at or before it and going on past it begins at the target."""
        return self.safe_bound(k, x, way, beyond, grade)[0]

    def safe_bound(self, k, x, way, beyond=None, grade=CREST_GRADE):
        """safe_room, and what ends it: (px, 'end' (the line's end, which may be a wall) or 'downhill')."""
        lo, hi = self.ends(k)
        stop, kind = (hi if way > 0 else lo), 'end'
        ahead = sorted((s for s in self.segs if s[0] == k), key=lambda s: s[1] if way > 0 else -s[3])
        for _, ax, ay, bx, by, m in ahead:
            enter, leave = (ax, bx) if way > 0 else (bx, ax)
            if (leave - x) * way <= 0 or m * way <= grade:
                continue  # behind the player, or not downhill that way (screen y grows downward)
            if beyond is not None and (leave - beyond) * way <= 0:
                continue  # all of it before the target: the way there
            start = enter if (enter - x) * way > 0 else x
            if beyond is not None and (start - beyond) * way < 0:
                start = beyond
            if (start - stop) * way < 0:
                stop, kind = start, 'downhill'
            break
        return abs(stop - x), kind

    def raw(self):
        return [[[round(x, 2), round(y, 2)] for x, y in pts] for pts in self.lines]


def feet(samples, grounds, reach=40.0):
    """How far above the lines it stands on the position is on the ground (px, the median over samples on the ground
    with a line within `reach` below or above), 0 without any."""
    offs = []
    for s in samples[::3]:
        g = grounds.get(s[4] if len(s) > 4 else None)
        if s[3] is not True or g is None:
            continue
        near = g.on(s[1], s[2], within=reach)
        if near:
            offs.append(near[1] - s[2])
    return round(statistics.median(offs), 2) if len(offs) >= 10 else 0.0


def land(model, ground, start, x0, y0, vx):
    """Where a jump launched from (x0, y0) on line `start`, across at vx px/ms, first comes down onto a line: (line, x,
    ms) or None. Exact for the model: rising at its launch speed, gravity, falling at most `fall` px/ms."""
    L, g = model['jump'], model['gravity']
    cap = model.get('fall') or math.inf
    tc = (L + cap) / g if math.isfinite(cap) else math.inf
    yc = -L * tc + g * tc * tc / 2 if math.isfinite(tc) else 0.0
    best = None
    for k, ax, ay, bx, by, m in ground.segs:
        # y0 + h(t) = ay + m (x0 + vx t - ax), coming down onto the line (h'(t) > m vx)
        c = ay + m * (x0 - ax) - y0
        ts = []
        b = L + m * vx
        disc = b * b + 2 * g * c
        if disc >= 0:
            t = (b + math.sqrt(disc)) / g  # the larger root: coming down
            if 1.0 < t <= tc:
                ts.append(t)
        if math.isfinite(tc) and cap - m * vx > 1e-9:
            t = (c - yc + cap * tc) / (cap - m * vx)
            if t > tc and t > 1.0:
                ts.append(t)
        for t in ts:
            x = x0 + vx * t
            if ax <= x <= bx and t < GIVE_UP_MS and (best is None or t < best[2]):
                best = (k, x, t)
    return best


def flights(samples):
    """Where the player left the ground and came down on it again: (i, j), samples[i] the last on the ground and
    samples[j] the first on it again. samples: [(t, x, y, grounded, ...)]."""
    out, i, n = [], 0, len(samples)
    while i < n - 1:
        if not (samples[i][3] is True and samples[i + 1][3] is False):
            i += 1
            continue
        j = i + 1
        while j < n and samples[j][3] is False:
            j += 1
        if j < n and samples[j][3] is True:
            out.append((i, j))
        i = j
    return out


def _press(keys, samples, i, key):
    """A flight's press of `key`: the one nearest when it left the ground, or None."""
    t0, t1 = samples[i][0], samples[i + 1][0]
    presses = [t for t, k, down in keys.between(t0 - PRESS_BEFORE, t1 + PRESS_AFTER) if down and k == key]
    return min(presses, key=lambda t: abs(t - t0)) if presses else None


def _arc_points(samples, i, j, press):
    return [(s[0], s[2]) for s in samples[i + 1:j] if s[0] - press <= FIT_MS]


def _best_launch(points, y0, press, v, g, step=2):
    """For launch speed v and gravity g: the launch (ms from the press) that fits best, and its rms; None without."""
    t = np.array([p[0] for p in points]) - press
    y = np.array([p[1] for p in points])
    cs = np.arange(-60, 101, step, dtype=float)
    tau = t[None, :] - cs[:, None]
    ok = (tau > 0).all(axis=1)
    if not ok.any():
        return None
    e = y[None, :] - (y0 - v * tau + g / 2 * tau * tau)
    rms = np.sqrt((e * e).mean(axis=1))
    rms[~ok] = np.inf
    k = int(np.argmin(rms))
    return float(cs[k]), float(rms[k])


def fit(recordings):
    """The model from recordings [{samples: [(t, x, y, grounded, ...)], keys: Keys}], t the position's read time:
    {walk, jump, gravity, fall, jumpKey, leftKey, rightKey, delays: [early, median, late], recordedDelays, leaveMs,
    jumps, rms}, px and ms; or {error} saying what's missing."""
    candidates, rising = Counter(), []
    for r in recordings:
        S, K = r['samples'], r['keys']
        for i, j in flights(S):
            if min(s[2] for s in S[i + 1:j]) > S[i][2] - RISE_PX:
                continue
            downs = {k for t, k, d in K.between(S[i][0] - PRESS_BEFORE, S[i + 1][0] + PRESS_AFTER) if d}
            candidates.update(downs)
            rising.append((r, i, j))
    if not candidates:
        return {'error': 'no jumps in its recordings: a key pressed as the player left the ground and rose'}
    jump = candidates.most_common(1)[0][0]
    # the keys each way: held while moving that way, not the other way as often
    across = {1: Counter(), -1: Counter()}
    for r in recordings:
        S, K = r['samples'], r['keys']
        for a, b in zip(S, S[1:]):
            dt = b[0] - a[0]
            if 0 < dt <= 100 and abs(b[1] - a[1]) / dt > 0.02:
                across[1 if b[1] > a[1] else -1].update(k for k in K.held(a[0]) if k != jump)

    def way(sign):
        counts = {k: n for k, n in across[sign].items() if n > 2 * across[-sign].get(k, 0)}
        return max(counts, key=counts.get) if counts else None
    right, left = way(1), way(-1)
    if right is None and left is None:
        return {'error': 'its recordings don’t show which keys move the player'}
    # walking speed: across the air with one way's key held
    speeds = []
    for r, i, j in rising:
        S, K = r['samples'], r['keys']
        for a, b in zip(S[i + 1:j], S[i + 2:j]):
            dt = b[0] - a[0]
            held = set(K.held(a[0])) - {jump}
            if 0 < dt <= 100 and len(held) == 1 and held <= {left, right} - {None} and abs(b[1] - a[1]) / dt > 0.02:
                speeds.append(abs(b[1] - a[1]) / dt)
    if len(speeds) < MIN_JUMPS:
        return {'error': 'its recordings have too few jumps moving one way to measure walking speed'}
    walk = statistics.median(speeds)
    # launch speed and gravity: each jump's own fit, then the pair that fits them best with each its own launch time
    arcs, own = [], []
    for r, i, j in rising:
        S, K = r['samples'], r['keys']
        press = _press(K, S, i, jump)
        pts = _arc_points(S, i, j, press) if press is not None else []
        if len(pts) < 4:
            continue
        y0 = S[i][2]
        arcs.append((pts, y0, press, (r, i, j)))
        t = np.array([p[0] for p in pts]) - press
        dy = np.array([p[1] for p in pts]) - y0
        best = None
        for c in range(-60, 101, 2):
            tau = t - c
            if (tau <= 0).any():
                continue
            A = np.stack([tau, tau * tau], axis=1)
            sol, *_ = np.linalg.lstsq(A, dy, rcond=None)
            rms = float(np.sqrt(((A @ sol - dy) ** 2).mean()))
            if best is None or rms < best[0]:
                best = (rms, -sol[0], 2 * sol[1])
        if best and best[0] <= FIT_RMS and best[1] > 0 and best[2] > 0:
            own.append(best[1:])
    if len(own) < MIN_JUMPS:
        return {'error': f'its recordings have {len(own)} jumps whose arc could be measured; at least {MIN_JUMPS} are needed'}
    v0, g0 = statistics.median(v for v, _ in own), statistics.median(g for _, g in own)
    best = None
    for fv in np.linspace(0.94, 1.06, 13):
        for fg in np.linspace(0.94, 1.06, 13):
            v, g = v0 * fv, g0 * fg
            fits = [f for pts, y0, press, _ in arcs if (f := _best_launch(pts, y0, press, v, g)) is not None]
            score = statistics.median(rms for _, rms in fits)
            if best is None or score < best[0]:
                best = (score, v, g)
    _, v, g = best
    fits = [(f, a) for a in arcs if (f := _best_launch(a[0], a[1], a[2], v, g, step=1)) is not None]
    delays = sorted(c for (c, _), _ in fits)
    rms = sorted(e for (_, e), _ in fits)
    # when it left the ground: the first rising reading after the press (an upper bound)
    leave = []
    for pts, y0, press, (r, i, j) in arcs:
        first = next((t for t, y in pts if y < y0 - 1), None)
        if first is not None:
            leave.append(first - press)
    # falling at its fastest: long falls' last 150 ms
    falls = []
    for r in recordings:
        S = r['samples']
        for i, j in flights(S):
            air = S[i + 1:j]
            if air and S[j][2] - min(s[2] for s in air) >= 100:
                tail = [s for s in air if s[0] >= air[-1][0] - 150]
                if len(tail) >= 2 and tail[-1][0] > tail[0][0]:
                    falls.append((tail[-1][2] - tail[0][2]) / (tail[-1][0] - tail[0][0]))
    recorded = {'p10': _q(delays, .1), 'p50': _q(delays, .5), 'p90': _q(delays, .9)}
    run_up = _run_ups(recordings, walk, left, right, jump)
    return {'walk': round(walk, 4), **({'runUp': run_up} if run_up else {}), 'jump': round(v, 4), 'gravity': round(g, 6), 'fall': round(statistics.median(falls), 4) if len(falls) >= 3 else None,
            'jumpKey': jump, 'leftKey': left, 'rightKey': right,
            'delays': [recorded['p10'], recorded['p50'], recorded['p90'] + INJECTED_MS], 'recordedDelays': recorded,
            'leaveMs': round(_q(leave, .9), 1) if leave else 50.0, 'jumps': len(fits),
            'rms': {'p50': round(_q(rms, .5), 2), 'p90': round(_q(rms, .9), 2)}}


def _run_ups(recordings, walk, left, right, jump):
    """How far and how long the player takes, from standing, to walk at 90% of walking speed with one key held each way
    (the recordings' own starts from a standstill): {px, ms} at their 90th percentile, n; None under MIN_JUMPS of them.
    What a dynamic checkpoint needs behind it to be run up into (checkpoints())."""
    px, ms = [], []
    for r in recordings:
        S, K = r['samples'], r['keys']
        times = [s[0] for s in S]
        for t, k, down in K.events:
            if not down or k is None or k not in (left, right) or K.held(t - 0.001):
                continue
            i = bisect.bisect_right(times, t) - 1
            if i < 1 or S[i][3] is not True or S[i][0] - S[i - 1][0] > 100 or abs(S[i][1] - S[i - 1][1]) >= 0.5:
                continue  # not standing on the ground just before the key went down
            way = 1 if k == right else -1
            for a, b in zip(S[i:], S[i + 1:]):
                if b[3] is not True or b[0] - t > 400 or k not in K.held(b[0]) or jump in K.held(b[0]) or b[0] <= a[0]:
                    break
                if (b[1] - a[1]) * way / (b[0] - a[0]) >= 0.9 * walk:
                    px.append(abs(b[1] - S[i][1]))
                    ms.append(b[0] - t)
                    break
    if len(px) < MIN_JUMPS:
        return None
    return {'px': round(_q(px, .9), 1), 'ms': round(_q(ms, .9), 1), 'n': len(px)}


def checkpoints(samples, keys, model, grounds, t0, t1, takeoffs=()):
    """Where a recorded movement from t0 to t1 could be resumed after a failure: each landing in it on a ground line the
    model knows (the first reading on the ground again), as the state the rest of the movement starts from, not only a
    place. [{n, at (ms from t0), position, region, level, line, kind, direction, vx, velocity, held, next, runUpPx,
    roomPx, resumable, why}]:

    - `region` [x lo, x hi], `velocity` [lo, hi] px/ms (signed), `held` the keys down then, `direction` -1, 0 or 1: the
      state resuming has to reproduce; `at` where the rest of the movement starts (its partial link, partial()).
    - `kind`: 'stable', landing under STABLE of walking with no key each way held (stop there, go on); else 'dynamic',
      running on into the rest of the movement, reproducible only by running up into it: from a standstill the
      recordings take `runUpPx` (the model's runUp) to reach walking speed, and `roomPx` is the ground line behind it.
    - `next` the next jump ({index, status, leadMs}): resuming changes how the player arrives at it, so a dynamic
      checkpoint is resumable only when that jump is pressed by where the player is (BY_POSITION), not on recorded time.
    - `resumable`, and `why` when not. Nothing in it is a game's: landings, keys, speeds and lines are the recordings'
      and the model's. On the user's second jump quest 29 of 30 landings were dynamic (a key held, running on)."""
    walk = model['walk']
    across = {model.get('leftKey'), model.get('rightKey')} - {None}
    run_up = (model.get('runUp') or {}).get('px')
    out = []
    for i, j in flights(samples):
        land = samples[j]
        if not t0 < land[0] < t1:
            continue
        level = land[4] if len(land) > 4 else None
        ground = grounds.get(level)
        on = ground.on(land[1], land[2]) if ground else None
        if on is None:
            continue  # landed on no line it knows (a rope, a ladder)
        # its speed across after landing: over up to 150 ms on the ground (the game moves the player in steps, so the
        # next reading alone often hadn't moved yet) until a key next goes down (walking off after it is a new action,
        # from a standstill), else the speed it came down at
        pressed = next((t for t, k, d in keys.between(land[0] + 0.001, land[0] + 150) if d), land[0] + 150)
        after = [s for s in samples[j + 1:] if s[0] <= pressed]
        ground_after = []
        for s in after:
            if s[3] is not True:
                break
            ground_after.append(s)
        far_s = ground_after[-1] if ground_after and ground_after[-1][0] - land[0] >= 40 else None
        prev = samples[j - 1] if j > 0 else None
        if far_s is not None:
            vx = (far_s[1] - land[1]) / (far_s[0] - land[0])
        elif prev is not None and land[0] > prev[0]:
            vx = (land[1] - prev[1]) / (land[0] - prev[0])
        else:
            vx = 0.0
        held = sorted(keys.held(land[0]))
        ways = set(held) & across
        stable = abs(vx) < STABLE * walk and not ways
        if abs(vx) >= STABLE * walk:
            direction = 1 if vx > 0 else -1
        else:
            direction = 1 if model.get('rightKey') in ways else -1 if model.get('leftKey') in ways else 0
        at = round(land[0] - t0, 1)
        jump = next(((n, row) for n, row in enumerate(takeoffs or []) if row['at'] > at), None)
        lo, hi = ground.ends(on[0])
        room = (land[1] - lo) if direction > 0 else (hi - land[1]) if direction < 0 else None
        cp = {'n': len(out), 'at': at, 'position': [land[1], land[2]], 'region': [land[1] - CHECK_REGION_PX, land[1] + CHECK_REGION_PX],
              'level': level, 'line': on[0], 'kind': 'stable' if stable else 'dynamic', 'direction': direction, 'vx': round(vx, 3),
              'velocity': [round(vx - CHECK_SPEED * walk, 3), round(vx + CHECK_SPEED * walk, 3)], 'held': held,
              'next': {'index': jump[0], 'status': jump[1]['status'], 'leadMs': round(jump[1]['at'] - at, 1)} if jump else None,
              'runUpPx': run_up, 'roomPx': round(room, 1) if room is not None else None}
        why = None
        if not stable:
            if run_up is None:
                why = 'dynamic, and the recordings don\u2019t show how far a run-up from standing takes'
            elif room is None or room < run_up + EDGE_PX:
                why = f'dynamic: {room or 0:.0f} px of ground behind it, and a run-up takes {run_up:.0f}'
            elif jump and jump[1]['status'] not in BY_POSITION:
                why = f'dynamic, and its next jump is played as recorded ({jump[1]["status"]}), so arriving differently changes it'
        cp['resumable'] = why is None
        if why:
            cp['why'] = why
        out.append(cp)
    return out


def partial(link, cp):
    """The rest of a recorded movement from its checkpoint `cp` (checkpoints()), as a link of its own: everything in it
    timed from the checkpoint, its first moment the checkpoint's, and its parent's identity kept (`parent`, `recording`,
    `checkpoint`), so what it does is learned apart from the whole movement's. `from` is None: the map gives it a place
    of its own (internal) when it uses one."""
    cut = cp['at']
    out = {k: v for k, v in link.items() if k not in ('checkpoints', 'syncs', 'takeoffs', 'finish', 'trajectory', 'unsafe')}
    out.update(id=f'{link["id"]}@{cp["n"]}', parent=link['id'], recording=link['clip']['recording'], checkpoint=cp['n'],
               start=list(cp['position']), ms=round(link['ms'] - cut, 1), clip={**link['clip'], 'from': link['clip']['from'] + cut},
               trajectory=[[round(p[0] - cut, 1), *p[1:]] for p in link.get('trajectory') or [] if p[0] >= cut])
    out['from'] = None
    syncs = [{**s, 'at': round(s['at'] - cut, 1), 'transition': [round(v - cut, 1) for v in s['transition']],
              **({'after': round(s['after'] - cut, 1)} if s.get('after') is not None else {})}
             for s in link.get('syncs') or [] if s['at'] > cut + 1]
    if syncs:
        out['syncs'] = syncs
    takeoffs = [{**r, 'at': round(r['at'] - cut, 1)} for r in link.get('takeoffs') or [] if r['at'] > cut]
    if takeoffs:
        out['takeoffs'] = takeoffs
        if any(r['status'] in ('unsafe', 'narrow') and not r.get('asPlayed') for r in takeoffs):
            out['unsafe'] = link.get('unsafe') or 'a jump it can\u2019t press safely'
    f = link.get('finish')
    if f and f.get('walk'):
        out['finish'] = f
    elif f and f.get('takeoff') is not None and f['takeoff'] >= cut:
        out['finish'] = {**f, 'takeoff': round(f['takeoff'] - cut, 1), 'at': round(f['at'] - cut, 1), 'drop': [[round(a - cut, 1), k] for a, k in f['drop']]}
    return out


def press_landing(model, ground, start, x, vx_air, gvx, delay):
    """Where a press at x on line `start` lands, launching `delay` ms after it (the player walking at gvx meanwhile):
    (line, x) or None; None too when the launch is past the line's end."""
    lx = x + gvx * delay
    ly = ground.y_on(start, lx)
    if ly is None:
        return None
    hit = land(model, ground, start, lx, ly, vx_air)
    return None if hit is None else (hit[0], hit[1])


def safe(model, ground, start, target, x, vx_air, gvx, margin):
    """Whether a press at x is safe however long the game takes to launch it: the player still on the starting line
    EDGE_PX before its end when it leaves at the latest (`leaveMs`), and landing `margin` inside the target at every
    delay."""
    lo_s, hi_s = ground.ends(start)
    if gvx:
        last = x + gvx * model['leaveMs']
        if (last > hi_s - EDGE_PX) if gvx > 0 else (last < lo_s + EDGE_PX):
            return False
    lo, hi = ground.ends(target)
    for delay in model['delays']:
        p = press_landing(model, ground, start, x, vx_air, gvx, delay)
        if p is None or p[0] != target or not (lo + margin <= p[1] <= hi - margin):
            return False
    return True


def _runs(xs):
    """Runs of positions SEARCH_STEP apart."""
    runs = []
    for x in xs:
        if runs and x - runs[-1][-1] <= SEARCH_STEP + 1e-6:
            runs[-1].append(x)
        else:
            runs.append([x])
    return runs


def _nearest(runs, x):
    """The run holding x, else the nearest to it; None without."""
    return min(runs, key=lambda r: 0 if r[0] <= x <= r[-1] else min(abs(r[0] - x), abs(r[-1] - x)), default=None)


def room(model, ground, start, target, x, vx_air, gvx, margin):
    """How safe a press at x is: the least of how far it leaves before EDGE_PX from the starting line's end and how
    far inside `margin` it lands at each delay (negative: short by that much); -inf if some delay lands elsewhere."""
    lo_s, hi_s = ground.ends(start)
    least = math.inf
    if gvx:
        last = x + gvx * model['leaveMs']
        least = (hi_s - EDGE_PX - last) if gvx > 0 else (last - lo_s - EDGE_PX)
    lo, hi = ground.ends(target)
    for delay in model['delays']:
        p = press_landing(model, ground, start, x, vx_air, gvx, delay)
        if p is None or p[0] != target:
            return -math.inf
        least = min(least, p[1] - lo - margin, hi - margin - p[1])
    return least


def position_jump(model, ground, start, d, x_press, landing=None, target=None):
    """A running jump whose keys change in the air (a turn, a let-go): the model can't say where it lands, so it isn't
    given a safe stretch, but where it's pressed from can still be kept from the edge. Its aim is where it was pressed
    in the recording, or, if that's nearer the end of the line it runs off than `edge` (EDGE_PX, and how far it walks
    over the spread of when the game takes a press), that far in: an experimental place, not a checked one, since an
    earlier press can land elsewhere; the executor checks it took off and moves it further in when it didn't
    (MapRun.learn_jump). Its window runs from the line's other end to the latest a press is still safe by the model
    (`lateMargin` from the end): the aim is where it prefers to press, not the end of where it may.

    With the line it landed on (`target`, at x `landing`), the window is also kept to presses whose landing stays
    LAND_MARGIN + UNCHECKED_PX inside that line, taking its arc to move with where it's pressed: only roughly so for keys
    changing in the air, hence the wider margin (`landingWindow`). The user's first jump quest's jump 4 landed 5-8 px
    inside its ledge; pressed 6 px before where it was recorded (a 4 px takeoff region and 2 px of estimate) it came
    down 1 px short. Where that leaves no room before the latest safe press, the window is that one place."""
    lo_s, hi_s = ground.ends(start)
    edge = EDGE_PX + model['walk'] * max(0.0, model['delays'][-1] - model['delays'][0])
    latest = hi_s - edge if d > 0 else lo_s + edge
    aim = min(x_press, latest) if d > 0 else max(x_press, latest)
    # the latest a press can be sent from and the player, walking on while the game takes it (up to the late end of
    # `delays`), still leave the line EDGE_PX short of its end: by the model, not a margin checked by outcomes (those
    # move the aim and it in, MapRun.learn_jump). Between the aim and it, it's pressed at once; past it, not
    late = EDGE_PX + model['walk'] * max(0.0, model['delays'][-1])
    window = [round(lo_s + EDGE_PX, 1), round(hi_s - late, 1)] if d > 0 else [round(lo_s + late, 1), round(hi_s - EDGE_PX, 1)]
    out = {'status': 'position', 'why': 'keys change in the air: pressed by where the player is, the rest as recorded',
           'aim': round(aim, 1), 'window': window, 'edgeMargin': round(edge, 1), 'lateMargin': round(late, 1), 'interval': None}
    if target is not None and landing is not None:
        lo_t, hi_t = ground.ends(target)
        m = LAND_MARGIN + UNCHECKED_PX
        a, b = x_press + (lo_t + m - landing), x_press + (hi_t - m - landing)
        if a > b:  # a target too narrow for the margin either side: its middle
            a = b = x_press + (lo_t + hi_t) / 2 - landing
        safe_lo, safe_hi = window
        lo_w, hi_w = max(safe_lo, a), min(safe_hi, b)
        if lo_w > hi_w:  # no press both lands with room and is safe to leave from: the safe press nearest to landing with room
            lo_w = hi_w = safe_hi if a > safe_hi else safe_lo
        out['landingWindow'] = [round(a, 1), round(b, 1)]
        out['window'] = [round(lo_w, 1), round(hi_w, 1)]
        out['aim'] = round(min(hi_w, max(lo_w, aim)), 1)
    return out


def _on_ground_at(samples, i, ground):
    """The last reading of a flight's takeoff actually on the ground: samples[i] is the last the State says is, but a
    State can lag the position by a reading, so one already above the line the reading before it stood on (within
    TAKE_STALE_MS) is in the air."""
    if ground is None:
        return i
    while i > 0:
        s, b = samples[i], samples[i - 1]
        under = ground.on(b[1], b[2]) if b[3] is True else None
        if ground.on(s[1], s[2]) is not None or under is None or s[0] - b[0] > TAKE_STALE_MS:
            break
        ly = ground.y_on(under[0], s[1])
        if ly is None or s[2] >= ly - ON_PX:  # not above its line: not risen off it (walked off, say)
            break
        i -= 1
    return i


def _near_miss(model, ground, start, target, x, vx_air, gvx, delay):
    """Where pressed nearest x (within MODEL_MAX_PX, along the line it's pressed from) the model lands it on `target`:
    (x', landing x) or None."""
    n = int(MODEL_MAX_PX / SEARCH_STEP)
    for s in range(1, n + 1):
        for xp in (x - s * SEARCH_STEP, x + s * SEARCH_STEP):
            if ground.y_on(start, xp) is None:
                continue
            p = press_landing(model, ground, start, xp, vx_air, gvx, delay)
            if p is not None and p[0] == target:
                return xp, p[1]
    return None


def _left_out(keys, dropped):
    """The key events a movement's played keys leave out: each dropped press [(t, key)] going down, and its let-go."""
    out = set()
    for t, k in dropped or ():
        out.add((round(t, 1), k, True))
        up = next((u for u, kk, d in keys.between(t + 0.001, math.inf) if kk == k and not d), None)
        if up is not None:
            out.add((round(up, 1), k, False))
    return out


def _since_landing(samples, i, press):
    """How long before `press` the player last landed (the State turning true after false), or None."""
    for q in range(i, 0, -1):
        if samples[q][3] is True and samples[q - 1][3] is False:
            return press - samples[q][0]
    return None


def jumps(samples, keys, model, grounds, t0, t1, dropped=(), calibration=None):
    """The recorded jumps pressed from t0 to t1 (a movement's clip, ms in its recording), from its samples [(t, x, y,
    grounded, level)] (t read times) and keys, the ground per level (`grounds`, {level: Ground}). Each:
    {at (ms from t0), status, why, moving, dir, demoX, y, level, start, target, interval, aim, predicted,
    recordedLanding, modelErr, margin, window, lines}. status: 'adapt' (its press can be timed by where the player
    is: `aim` within `interval`), 'unsafe' (no safe place to press), 'narrow' (one too narrow to hit), 'position' (a
    running jump whose keys change in the air: only its press is timed by where the player is, position_jump),
    'walkoff' (it didn't rise: the player walked off an edge and the jump key, pressed in the air, did nothing; played as
    recorded), 'timed' (not a jump the model knows: played as recorded). What a jump is here is this model's: one
    rises; another game's jumps need their own model. For unsafe and narrow ones, `aim` is the most robust place to press it
    (the most `room`) and `window` where it lands on its target at all, for a map with no other way; for adapt,
    `window` is its interval. `lines`: its start and target lines' points, so a trace can tell where it landed.

    `dropped` [(t, key)]: presses the movement's played keys leave out (its finish's trailing nudge, finish()). A jump
    whose only keys changing in the air are those is judged as played, without them, and marked `asPlayed`: the
    executor takes it so only where they're left out, else plays it as recorded. The user's movement to (-1900, -1127)
    jumped straight up with a Right pressed in the air that moved the player 2 px: as played, a standing jump the model
    knows, and one it can tap the player into the stretch of."""
    out = []
    left_out = _left_out(keys, dropped)
    jump, left, right, walk = model['jumpKey'], model['leftKey'], model['rightKey'], model['walk']
    mid = model['delays'][1]
    for i, j in flights(samples):
        press = _press(keys, samples, i, jump)
        if press is None or not (t0 <= press <= t1):
            continue
        S = samples
        ground = grounds.get(S[i][4] if len(S[i]) > 4 else None)
        i = _on_ground_at(S, i, ground)
        take, landing = S[i], S[j]
        before = [s for s in S[:i] if s[0] >= take[0] - 100]
        vxg = (take[1] - before[0][1]) / (take[0] - before[0][0]) if before and take[0] > before[0][0] else 0.0
        moving = abs(vxg) >= MOVING * walk
        x_press = take[1] + vxg * (press - take[0])
        held = set(keys.held(press))
        d = (right in held) - (left in held)
        row = {'at': round(press - t0, 1), 'moving': moving, 'dir': d, 'demoX': round(x_press, 1), 'y': take[2], 'level': take[4] if len(take) > 4 else None,
               'recordedLanding': [landing[1], landing[2]]}
        out.append(row)
        # the press didn't cause this flight: a jump in this model rises; one that left the ground without rising
        # walked off its edge, the key going down in the air, where it did nothing. Played as recorded, never moved
        # (moved onto the line, it jumped where the recording fell)
        rise = take[2] - min(s[2] for s in S[i + 1:j])
        if rise < RISE_PX:
            row.update(status='walkoff', why=f'it left the ground without rising ({rise:.0f} px): a walk off its edge, its jump key going down in the air, where it did nothing',
                       rise=round(rise, 1))
            continue
        ground = grounds.get(row['level'])
        others = held - {jump, left, right, None}
        in_air = [(t, k, dn) for t, k, dn in keys.between(press + 0.001, landing[0]) if k != jump]
        changed = any((round(t, 1), k, dn) not in left_out for t, k, dn in in_air)
        if in_air and not changed:
            row['asPlayed'] = True
        start = ground.on(take[1], take[2]) if ground else None
        target = ground.on(landing[1], landing[2]) if ground else None
        why = None
        if ground is None or not ground.segs:
            why = 'no ground lines on its level'
        elif others:
            why = f'{"+".join(sorted(others))} held as well'
        elif changed:
            why = 'keys change in the air'
        elif start is None or target is None:
            why = 'not from and to a ground line'
        elif moving and d == 0:
            why = 'moving with no key held either way'
        vx = d * walk
        gvx = vx if moving else 0.0
        past = False
        if why is None:
            row.update(start=start[0], target=target[0], lines=[ground.raw()[start[0]], ground.raw()[target[0]]])
            # the key went down after the player, at its last reading on the line carried on at its speed, had walked
            # off the line's end: that press wasn't one made on the ground, so the model can't be checked against it.
            # It plans from the line instead: the stretch of earlier presses, on it, that still reach the line it landed
            # on, with more margin for not having been checked
            past = moving and ground.y_on(start[0], x_press) is None
            p = None if past else press_landing(model, ground, start[0], x_press, vx, gvx, mid)
            if past:
                row['pressedPastEdge'] = True
            else:
                err = None
                if p is not None and p[0] == target[0]:
                    err = p[1] - landing[1]
                else:
                    near = _near_miss(model, ground, start[0], target[0], x_press, vx, gvx, mid)
                    if near is not None:
                        # pressed a little further back or on it lands there: where the model, carried on that far, has
                        # it landing (a jump arc moves with where it's pressed), and how far that is from the landing.
                        # Its error, not proof the recorded press was safe: the margin grows with it as with any other
                        row['nearMiss'] = round(near[0] - x_press, 1)
                        err = near[1] + (x_press - near[0]) - landing[1]
                        if calibration:
                            graded = ground.graded(start[0], x_press, d) if moving and d else None
                            since = _since_landing(S, i, press)
                            key = f"{'fresh' if since is not None and since <= CAL_FRESH_MS else 'later'}·{graded[0] if graded else 'flat'}"
                            if key in calibration:
                                row['calibrated'] = {'key': key, **calibration[key]}
                if err is None:
                    why = 'the model lands it elsewhere'
                else:
                    row['modelErr'] = round(err, 1)
                    if abs(err) > MODEL_MAX_PX:
                        why = f'the model lands it {err:+.0f} px from where it landed'
        if why == 'keys change in the air' and moving and d and start is not None:
            # its arc isn't the model's to predict, but where it leaves from is: pressed by where the player is, the
            # rest of its keys as recorded from the press (position_jump)
            row.update(position_jump(model, ground, start[0], d, x_press, landing[1], target[0] if target else None), start=start[0], target=target[0] if target else None,
                       lines=[ground.raw()[start[0]], *([ground.raw()[target[0]]] if target else [])])
            terrain = ground.graded(start[0], x_press, d)
            if terrain:
                lo_w, hi_w = max(row['window'][0], terrain[1]), min(row['window'][1], terrain[2])
                row['terrain'] = {'grade': terrain[0], 'from': round(terrain[1], 1), 'to': round(terrain[2], 1)}
                if lo_w > hi_w:
                    model_row = {k: row.pop(k) for k in ('status', 'why', 'window', 'aim', 'interval') if k in row}
                    row.update(status='timed', model=model_row,
                               why=f'where it may be pressed is off the {terrain[0]} ground it was pressed on ({terrain[1]:.0f}..{terrain[2]:.0f}): played as recorded')
                elif [lo_w, hi_w] != row['window']:
                    row['window'] = [round(lo_w, 1), round(hi_w, 1)]
                    row['aim'] = round(min(hi_w, max(lo_w, row['aim'])), 1)
            continue
        if why is not None:
            row.update(status='timed', why=why)
            continue
        margin = (LAND_MARGIN + UNCHECKED_PX if past else max(LAND_MARGIN, row['calibrated']['p90AbsPx'] + 2) if row.get('calibrated')
                  else max(LAND_MARGIN, abs(row['modelErr']) + 2))
        row['margin'] = round(margin, 1)
        n = int(SEARCH_PX / SEARCH_STEP)
        # the model's walking speed and launch are from ground about level: it doesn't know what a slope does to a
        # running jump's speed, so a press stays on ground graded as where the recording pressed it (`terrain`)
        terrain = ground.graded(start[0], x_press, d) if moving and d else None
        alike = (lambda x: terrain[1] <= x <= terrain[2]) if terrain else (lambda x: True)
        every = [x for x in (x_press + s * SEARCH_STEP for s in range(-n, n + 1))
                 if ground.y_on(start[0], x) is not None and safe(model, ground, start[0], target[0], x, vx, gvx, margin)]
        ok = [x for x in every if alike(x)]
        run = _nearest(_runs(ok), x_press)
        anywhere = _nearest(_runs(every), x_press)
        if terrain and (run is None or run[-1] - run[0] < EXEC_PX) and anywhere is not None and anywhere[-1] - anywhere[0] >= EXEC_PX:
            row.update(status='timed', terrain={'grade': terrain[0], 'from': round(terrain[1], 1), 'to': round(terrain[2], 1)},
                       model={'status': 'adapt', 'interval': [round(anywhere[0], 1), round(anywhere[-1], 1)]},
                       why=f'the model would press it at {anywhere[0]:.0f}..{anywhere[-1]:.0f}, off the {terrain[0]} ground it was pressed '
                           f'on ({terrain[1]:.0f}..{terrain[2]:.0f}), and it doesn’t know what a slope does to its speed: played as recorded')
            continue
        if run is not None and run[-1] - run[0] >= EXEC_PX:
            lo, hi = run[0], run[-1]
            aim = min(hi - INSET_PX, max(lo + INSET_PX, x_press))
            p = press_landing(model, ground, start[0], aim, vx, gvx, mid)
            row.update(status='adapt', interval=[round(lo, 1), round(hi, 1)], window=[round(lo, 1), round(hi, 1)], aim=round(aim, 1),
                       predicted=[p[0], round(p[1], 1)] if p else None)
            _distrusted(row, S, i, ground, start[0], target[0], landing, x_press)
            continue
        if run is not None:
            row.update(status='narrow', why=f'its safe stretch is {run[-1] - run[0]:.1f} px wide, under {EXEC_PX:g}', interval=[round(run[0], 1), round(run[-1], 1)])
        else:
            row.update(status='unsafe', why='nowhere to press it is safe at every delay' + (' (pressed past the edge in the recording)' if past else ''), interval=None)
        # for a map with no other way: the most robust place to press it, and where it lands on its target at all (at
        # the median delay) around it
        xs = [x for x in (x_press + s * SEARCH_STEP for s in range(-n, n + 1)) if ground.y_on(start[0], x) is not None and alike(x)]
        score, best = max(((room(model, ground, start[0], target[0], x, vx, gvx, margin), x) for x in xs), default=(-math.inf, None))
        if best is None or score == -math.inf:
            continue
        lands = _nearest(_runs([x for x in xs if (p := press_landing(model, ground, start[0], x, vx, gvx, mid)) and p[0] == target[0]]), best)
        if lands is not None and lands[0] <= best <= lands[-1]:
            p = press_landing(model, ground, start[0], best, vx, gvx, mid)
            row.update(aim=round(best, 1), window=[round(lands[0], 1), round(lands[-1], 1)], room=round(score, 1), predicted=[p[0], round(p[1], 1)] if p else None)
            if row.get('calibrated'):
                # how far inside its target it lands at every delay with no margin at all, and how far short of its
                # line's end it leaves at the latest fitted launch (`delays`; `leaveMs`, the first rising reading after
                # the press, is an upper bound by up to a reading, 40 ms or so)
                lo_s, hi_s = ground.ends(start[0])
                lo_t, hi_t = ground.ends(target[0])
                lands = [press_landing(model, ground, start[0], best, vx, gvx, dl) for dl in model['delays']]
                row['roomBare'] = -math.inf
                if all(p2 and p2[0] == target[0] for p2 in lands):
                    row['roomBare'] = round(min(min(p2[1] - lo_t, hi_t - p2[1]) for p2 in lands), 1)
                last = best + gvx * model['delays'][-1]
                row['edgeAtLaunchPx'] = round(((hi_s - last) if gvx > 0 else (last - lo_s)) if gvx else math.inf, 1)
        _distrusted(row, S, i, ground, start[0], target[0], landing, x_press)
    for row in out:
        if row['status'] == 'timed':
            _thin_landing(row, grounds)
    return out


def _thin_landing(row, grounds):
    """A jump played as recorded whose recording landed under THIN_LANDING_PX from an end of the platform it landed on
    (`landingRoom`, and `unsafeWhy` for its movement's `unsafe`)."""
    ground, landing = grounds.get(row.get('level')), row.get('recordedLanding')
    on = ground.on(landing[0], landing[1]) if ground and landing else None
    if on is None:
        return
    lo, hi = ground.ends(on[0])
    room = min(landing[0] - lo, hi - landing[0])
    if room < THIN_LANDING_PX:
        row['landingRoom'] = round(room, 1)
        row['unsafeWhy'] = (f'its recording landed {room:.0f} px from an end of the platform it landed on, with no room to spare, '
                            f'and it’s played as recorded ({row.get("why")})')


def _distrusted(row, samples, i, ground, start, target, landing, x_press):
    """A jump the model would press by where the player is, checked against its recording; one the model's stretch
    doesn't fit is played as recorded (status 'timed', the model's verdict kept as `model`):
    - its stretch (`interval`, else `window`) behind where the recording came onto the line it jumps from, the way it
      ran (`arrival`): the movement as recorded can't get there (the user's alternate route's jump 12, landed on from
      the jump before 25 px past its stretch, was refused 2 runs of 3; played as recorded it never failed);
    - and for a near miss (`nearMiss`: pressed as recorded the model lands it off its target, a little):
      - its recording landing against the far end of its target: stopped there, by a wall the lines don't show, as
        that jump's was, so the model carrying it on past says nothing of its error;
      - no press safe with its error allowed for ('unsafe');
      - pressed at its aim, less than TAKEOFF_REGION_PX (half the executable stretch) of where it lands on its target
        at all either side, too little for where a press lands in play (about 2 px of estimate and a game step)."""
    d = row['dir']
    why = None
    if row['moving'] and d:
        k = i
        while k > 0 and samples[k - 1][3] is True and (o := ground.on(samples[k - 1][1], samples[k - 1][2])) is not None and o[0] == start:
            k -= 1
        arrival = samples[k][1]
        row['arrival'] = round(arrival, 1)
        lo, hi = row.get('interval') or row.get('window') or (None, None)
        if lo is not None and ((hi < arrival - SEARCH_STEP) if d > 0 else (lo > arrival + SEARCH_STEP)):
            why = (f'the model would press it at {lo:.0f}..{hi:.0f}, behind where its recording came onto the line it jumps '
                   f'from ({arrival:.0f}): played as recorded')
    if why is None and 'nearMiss' in row:
        lo_t, hi_t = ground.ends(target)
        far = hi_t if d > 0 else lo_t
        model_x = landing[1] + row['modelErr']
        lo_w, hi_w = row.get('window') or (None, None)
        if d and abs(landing[1] - far) <= COLLIDE_PX and (model_x - far) * d > 0:
            why = (f'its recording landed against the far end of its target ({far:.0f}), where something may have stopped '
                   f'it, and the model carries it on {abs(model_x - far):.0f} px past: played as recorded')
        elif (row.get('calibrated') and (row.get('roomBare') or -1) > 0 and (row.get('edgeAtLaunchPx') or -1) >= EDGE_PX
              and row['status'] in ('unsafe', 'narrow')):
            # calibrated (the model's error measured in play, in these conditions), a near miss's recorded press is
            # one the model has missing its target, and its most robust press, landing on it at every delay and leaving
            # before the edge, is the better of the two: kept pressed by position, its movement marked unsafe (taken
            # only with no other way), what it has to spare said with it. The alternate route's g3 -> g4 jump 2 played
            # as recorded came down 2-3 px short of its platform twice, where the model had it; pressed by position
            # 10 px on it landed 8 px inside
            row['keptBy'] = (f"calibration ({row['calibrated']['key']}, {row['calibrated']['n']} outcomes, p90 {row['calibrated']['p90AbsPx']} px): "
                             f"pressed as recorded the model has it missing its target; at {row['aim']:.0f} it lands {row['roomBare']} px inside at every "
                             f"delay and leaves {row['edgeAtLaunchPx']} px short of its line's end")
        elif row['status'] == 'unsafe':
            why = 'no press is safe with the model’s error on it allowed for: played as recorded'
        elif lo_w is None or min(row['aim'] - lo_w, hi_w - row['aim']) < EXEC_PX / 2:
            why = f'too little room around where the model would press it to press it reliably: played as recorded'
    if why is None:
        return
    model = {k: row.pop(k) for k in ('status', 'why', 'interval', 'window', 'aim', 'room', 'predicted') if k in row}
    row.update(status='timed', why=why, model=model)


def finish(samples, keys, model, grounds, t0, t1):
    """How a recorded movement from t0 to t1 ends after its last landing, for a terminal correction (the executor's
    `_finish`): for a walk, staying on one ground line, `walk` (_walk_finish; None when it leaves the ground), else {status, why?, takeoff, at, land, end, level,
    movedPx, drop, facing, restore}, ms from t0. `at` is its last landing (the first reading on the ground again),
    after which it stays on the ground on the line it ends on; `movedPx` how far it went from where it landed.

    `drop` [[at, key]]: its trailing positioning presses, keys each way (the model's) going down after it left the
    ground for the last time: ones that, pressed in the air, didn't change its speed across (by STEER of walking; a key
    that steered is part of the jump) and that after the landing moved it only `movedPx`. What they did depends on when
    the game takes them about the landing (in the user's quest a Right pressed in the air moved the player 2 px in the
    recording and, landing a little sooner, walked it 20 px off the platform in play), so with the correction they aren't
    sent and the player is put on its recorded end by feedback instead; presses that walked it further than NUDGE_PX
    are a walk, played as recorded (`why` says so). status 'kept' (why) when the ending isn't
    one: another key pressed after the takeoff (up, an attack: played as recorded), landing on another line than it
    ends on, leaving the ground again, or a press that steered. `facing` is the key each way pressed last in it, the
    way the player ends up facing; `restore` that key when the last press setting it is dropped and the player faced
    another way (or no way known) before, so the correction can face it that way again."""
    left, right, jump = model['leftKey'], model['rightKey'], model['jumpKey']
    across = {left, right} - {None}
    flown = [(i, j) for i, j in flights(samples) if t0 < samples[j][0] <= t1]
    if not across:
        return None
    if not flown:
        return _walk_finish(samples, keys, across, grounds, t0, t1)
    i, j = flown[-1]
    S = samples
    takeoff, landing = S[i], S[j]
    after = [s for s in S[j:] if s[0] <= t1]
    end = after[-1]
    level = landing[4] if len(landing) > 4 else None
    out = {'status': 'kept', 'takeoff': round(takeoff[0] - t0, 1), 'at': round(landing[0] - t0, 1), 'land': [landing[1], landing[2]],
           'end': [end[1], end[2]], 'level': level, 'movedPx': round(max(abs(s[1] - landing[1]) for s in after), 1), 'drop': [], 'facing': None, 'restore': None}
    # the way it faces: the last key each way down in it (or held as it began)
    ways = [(t, k) for t, k, d in keys.between(t0 - 0.001, t1) if d and k in across]
    held = [k for k in keys.held(t0 - 0.001) if k in across]
    out['facing'] = ways[-1][1] if ways else (held[0] if len(held) == 1 else None)
    ground = grounds.get(level)
    if any(s[3] is not True for s in after):
        out['why'] = 'it leaves the ground again after its last landing'
        return out
    if ground is None or (on := ground.on(landing[1], landing[2])) is None or (to := ground.on(end[1], end[2])) is None or on[0] != to[0]:
        out['why'] = 'it doesn’t land on the ground line it ends on'
        return out
    out['line'] = on[0]
    jump_press = _press(keys, S, i, jump) if jump else None
    later = [(t, k) for t, k, d in keys.between(takeoff[0], t1) if d and not (k == jump and t == jump_press)]
    others = sorted({k for _, k in later} - across)
    if others:
        out['why'] = f'{"+".join(others)} pressed after its last takeoff'
        return out
    air = S[i:j + 1]

    def speed(pts):
        return (pts[-1][1] - pts[0][1]) / (pts[-1][0] - pts[0][0]) if len(pts) >= 2 and pts[-1][0] > pts[0][0] else None
    for t, k in later:
        if t < landing[0]:  # pressed in the air: did it change how fast the player went across?
            before = speed([s for s in air if s[0] <= t])
            since = speed([s for s in air if s[0] >= t][:-1] or [])
            if before is not None and since is not None and abs(since - before) > STEER * model['walk']:
                out['why'] = f'{k} pressed in the air {t - t0:.0f} ms in steered it'
                return out
    out['status'] = 'correct'
    if out['movedPx'] > NUDGE_PX:
        if later:  # a walk to its end, not a nudge: played as recorded, corrected only once it's over
            out['why'] = f'its presses after its last takeoff walk it {out["movedPx"]:.0f} px: played as recorded'
        return out
    out['drop'] = [[round(t - t0, 1), k] for t, k in later]
    if later and out['facing'] == later[-1][1]:
        first = later[0][0]
        before = [k for t, k in ways if t < first]
        was = before[-1] if before else (held[0] if len(held) == 1 else None)
        if was != out['facing']:
            out['restore'] = out['facing']
    return out


def _walk_finish(samples, keys, across, grounds, t0, t1):
    """finish() for a movement that never leaves the ground (a walk): correctable when it starts and ends on one ground
    line, staying on the ground, so its end is reached along that line; its presses are the movement, none left out.
    None when it leaves the ground (a walk off an edge: there's no landing to correct after)."""
    inside = [s for s in samples if t0 <= s[0] <= t1]
    if len(inside) < 2 or any(s[3] is False for s in inside):
        return None
    first, end = inside[0], inside[-1]
    level = end[4] if len(end) > 4 else None
    ways = [(t, k) for t, k, d in keys.between(t0 - 0.001, t1) if d and k in across]
    out = {'status': 'kept', 'walk': True, 'takeoff': None, 'at': 0.0, 'land': [first[1], first[2]], 'end': [end[1], end[2]], 'level': level,
           'movedPx': round(max(abs(s[1] - first[1]) for s in inside), 1), 'drop': [], 'facing': ways[-1][1] if ways else None, 'restore': None}
    ground = grounds.get(level)
    a = ground.on(first[1], first[2]) if ground else None
    b = ground.on(end[1], end[2]) if ground else None
    if a is None or b is None or a[0] != b[0]:
        out['why'] = 'it doesn’t start and end on one ground line'
        return out
    out.update(status='correct', line=b[0])
    return out


def start_region(start, samples, keys, model, grounds, t0, t1, rows, finish):
    """Where a recorded movement from t0 to t1, starting at `start` (x, y), may begin besides there, because what follows takes the
    difference up: {kind, level, line, lo, hi, why} (x along the start's ground line), or None (its start is its
    start, within the map's Start within). Only on the line it starts on, on ground graded as there (Ground.graded),
    at most START_REGION_PX either way:
    - 'jump': it opens with a run-up, only its forward key held, into a jump pressed by where the player is (adapt or
      position, rows[0]). A start further back or on keeps the takeoff reachable, but the jump must leave as fast as
      recorded: the recorded run-up has to be at least the model's measured run-up to walking speed (`runUp`), and a
      shorter one no shorter than that (a start further back only runs longer at walking speed). Without a measured
      run-up, none.
    - 'walk': it never leaves the ground and ends on its start's line with the end correction (finish 'walk',
      'correct'), only keys each way pressed. A start further back ends short, which the correction takes up from where
      the player stops; one further on ends further on, allowed only as far as there's ground past its end the player
      can stop on (Ground.safe_room: a line's end, or a downhill past its end, the second quest's crest walk to
      (438, -342) having 1 px), less EDGE_PX."""
    s0 = next((s for s in reversed(samples) if s[0] <= t0), None) or next((s for s in samples if s[0] >= t0), None)
    if s0 is None or s0[3] is not True:
        return None
    level = s0[4] if len(s0) > 4 else None
    ground = grounds.get(level)
    on = ground.on(start[0], start[1]) if ground else None
    if on is None:
        return None
    k, x0 = on[0], start[0]
    left, right, jump = model.get('leftKey'), model.get('rightKey'), model.get('jumpKey')
    across = {left, right} - {None}
    lo_l, hi_l = ground.ends(k)

    def region(kind, way, back, ahead, why):
        terrain = ground.graded(k, x0, way)
        lo_t, hi_t = (terrain[1], terrain[2]) if terrain else (lo_l, hi_l)
        back, ahead = min(back, START_REGION_PX), min(ahead, START_REGION_PX)
        a, b = (x0 - back, x0 + ahead) if way > 0 else (x0 - ahead, x0 + back)
        a, b = max(a, lo_t, lo_l + EDGE_PX), min(b, hi_t, hi_l - EDGE_PX)
        if b - a < 0.5:
            return None
        return {'kind': kind, 'level': level, 'line': k, 'lo': round(a, 1), 'hi': round(b, 1), 'why': why, 'way': way}
    first = rows[0] if rows else None
    if first and first.get('status') in ('adapt', 'position') and first.get('moving') and first.get('dir') and first.get('start') == k:
        d = first['dir']
        fwd = right if d > 0 else left
        press = t0 + first['at']
        events = [(t, kk, dn) for t, kk, dn in keys.between(t0 - 0.001, press - 0.001)]
        held = set(keys.held(t0 - 0.001))
        runs_up = all(kk == fwd for _, kk, _ in events) and held <= {fwd} and (fwd in held or any(dn and kk == fwd for _, kk, dn in events))
        run_up = (model.get('runUp') or {}).get('px')
        recorded = (first['demoX'] - x0) * d
        if runs_up and run_up and recorded >= run_up:
            return region('jump', d, START_REGION_PX, recorded - run_up,
                          f'a {recorded:.0f} px run-up at walking speed into a jump pressed by where the player is')
        return None
    if finish and finish.get('walk') and finish.get('status') == 'correct' and finish.get('line') == k:
        end = finish['end']
        way = 1 if end[0] > x0 else -1 if end[0] < x0 else 0
        pressed = {kk for _, kk, dn in keys.between(t0 - 0.001, t1) if dn} | set(keys.held(t0 - 0.001))
        if not way or not pressed <= across:
            return None
        # a walk started elsewhere goes as recorded only where the ground under it is graded the same all along: the
        # second quest's crest walk, begun 5 px back, met its steep rise without the momentum it had in the recording,
        # stalled at its foot, and came 26 px short
        terrain = ground.graded(k, x0, way)
        if terrain is None or not (terrain[1] <= min(x0, end[0]) and max(x0, end[0]) <= terrain[2]):
            return None
        # on one grade a start further on comes to rest that much further on: how far it may begin further on is the
        # ground past where the recorded walk came to rest (not where its clip ended: it slides on), to a line's end or
        # a downhill, less EDGE_PX. This bounds Start within too (`aheadPx`): the first quest's walk to (-1337, -672)
        # rests 3 px from its line's end, and begun 2 px on, within Start within, it walked off it 7 times in 9; from
        # its start or behind it, 26 of 27 stayed on
        until = next((t for t, kk, dn in keys.between(t1 + 0.001, t1 + REST_MS) if dn), t1 + REST_MS)
        went = [s[1] for s in samples if t0 <= s[0] <= until and s[3] is True]
        rest = (max(went) if way > 0 else min(went)) if went else end[0]
        room = max(0.0, ground.safe_room(k, rest, way, beyond=rest) - EDGE_PX)
        out = region('walk', way, START_REGION_PX, room, f'a walk the end correction finishes, coming to rest {room:.0f} px short of ground it can’t stop on')
        if out:
            out.update(aheadPx=round(room, 1), rest=round(rest, 1))
        return out
    return None


def tracks_by_time(samples):
    """Sample times, for finding the samples of a stretch of a recording."""
    return [s[0] for s in samples]


def between(samples, times, t0, t1, pad=600.0):
    """The samples from `pad` before t0 to `pad` after t1."""
    return samples[bisect.bisect_left(times, t0 - pad):bisect.bisect_right(times, t1 + pad)]


def annotate(graph, recordings, grounds, calibration=None):
    """A map's recorded movements (`graph`, movement.learn's) measured by the platformer model: the model fitted from
    its recordings ({recording id: {samples [(t, x, y, on ground, level)], keys, times}}) on its ground lines
    (`grounds`, {level: the Ground lines State's value}), and each movement annotated for its controller
    (platformer_control): how it ends after its last landing (`finish`), its jumps (`takeoffs`), where else it may
    begin (`startRegion`), where it could be resumed (`checkpoints`) and, for one with a jump it can't press safely,
    `unsafe` (why); with the runs' `calibration` (calibration.summary) where it has one. {model, grounds: [[level,
    lines]], counts, finishes, checkpoints, unsafe} or {error}."""
    # the lines in the position's own terms: a position formula can stand the player off the lines (a sprite's
    # middle, or `+ vec(0, -8)`), by how far it stands off them on the ground
    stand = feet([s for r in recordings.values() for s in r['samples']], {lv: Ground.of(v) for lv, v in grounds.items()})
    model = fit(list(recordings.values()))
    if model.get('error'):
        return {'error': model['error']}
    lines = {lv: Ground.of(v, stand) for lv, v in grounds.items()}
    model['feet'] = stand
    counts, finishes, checks = Counter(), Counter(), Counter()
    for link in graph['links']:
        r = recordings.get(link['clip']['recording'])
        if r is None:
            continue
        c = link['clip']
        near = between(r['samples'], r['times'], c['from'], c['to'])
        # how it ends after its last landing: its trailing positioning presses, for the terminal correction
        end = finish(near, r['keys'], model, lines, c['from'], c['to'])
        if end:
            link['finish'] = end
            finishes[end['status']] += 1
        # judged as played: without the trailing nudge the correction leaves out
        dropped = [(c['from'] + at, k) for at, k in end['drop']] if end and end['status'] == 'correct' else []
        rows = jumps(near, r['keys'], model, lines, c['from'], c['to'], dropped, calibration)
        # where else it may begin, what follows taking the difference up (a movement's own Start within)
        begins = start_region(link['start'], near, r['keys'], model, lines, c['from'], c['to'], rows, end)
        if begins:
            link['startRegion'] = begins
        # where it could be resumed after a failure and what that needs (internal to the map; not resumed from yet)
        points = checkpoints(near, r['keys'], model, lines, c['from'], c['to'], rows)
        if points:
            link['checkpoints'] = points
            checks.update(p['kind'] + ('' if p['resumable'] else ' (not resumable)') for p in points)
        if rows:
            link['takeoffs'] = rows
            counts.update(j['status'] for j in rows)
            bad = [j for j in rows if (j['status'] in ('unsafe', 'narrow') and not j.get('asPlayed')) or j.get('unsafeWhy')]
            if bad:
                link['unsafe'] = '; '.join(f'jump {rows.index(j) + 1}: {j.get("unsafeWhy") or j["why"]}' for j in bad)
    return {'model': model, 'grounds': [[lv, g.raw()] for lv, g in lines.items()], 'counts': dict(counts), 'finishes': dict(finishes),
            'checkpoints': dict(checks),
            'unsafe': sum(1 for l in graph['links'] if l.get('unsafe'))}
