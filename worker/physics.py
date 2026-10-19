"""A side-view game's movement, measured from recordings and editable: how fast the player walks, how hard a jump
launches them, gravity, and the fastest they fall. Nothing in it is about one game; the numbers are each game's own.

Measured from flights (leaving a line until landing on one; planner.learn_moves gathers them): a jump's height in time is
a parabola from the press of the key that starts it, y = y0 - jump*t + gravity*t^2/2, its speed down never past `fall`,
and the player crosses the air at about the walking speed in the direction held. On the user's MapleStory recordings it
came to 0.53 px/ms up, 0.00195 px/ms^2 and 0.124 px/ms across, against the game's own 555 px/s, 2000 px/s^2 and 125 px/s.

`arc` simulates a jump (or a walk off an edge) over a level's lines and finds where it lands: on a platform (a line
more across than up) only coming down onto it, on a rope (more up than across) anywhere it passes, never through a
platform on the way up when platforms are solid from below."""
import math
import statistics

FIT_RMS = 3.0        # px: a flight's parabola fits within this, or it isn't measured (it hit something, or caught a rope)
MIN_FITS = 5         # flights a jump and gravity are measured from at least
LONG_FALL = 150      # px: falls at least this deep give the fastest fall (their last FALL_TAIL_MS)
FALL_TAIL_MS = 250
JUMP_NEAR = (150, 60)  # ms before and after leaving a line the key that started a jump is looked for
GIVE_UP_MS = 4000    # a simulated flight longer than this lands nowhere


MIN_STOPS = 3        # stops the slide is measured from at least
PRECISE_SHARE = 0.8  # the precision covers this share of the slides measured


def fit(flights, along=None, stops=None, frame_ms=None):
    """The movement measured from flights: [{path: [(t, x, y, keys)], press: (t, key) or None}], path from the last
    sample on the line left to the first on the line landed on, and from stops ([(px slid on after letting go of the
    key walked with, ms)]). Returns {walk, jump, gravity, fall, slide, precision, jumpKey, jumpHoldMs, fits: {jumps,
    of, falls, stops}}, px and ms, None for what there wasn't enough of. `precision` is how near a spot the player
    can be stopped: the spread of the slides (PRECISE_SHARE of them within it of their median) and half a frame's
    walk (keys are pressed once a frame: `frame_ms`, the recordings' time between samples)."""
    gs, vs, airs, holds = [], [], [], []
    across = {1: {}, -1: {}}  # keys held going each way across in the air (+x, -x)
    # the jump key: the one pressed at the start of most flights that rose
    presses = [fl['press'][1] for fl in flights if fl.get('press') and min(q[2] for q in fl['path']) < fl['path'][0][2] - 10]
    jump_key = max(set(presses), key=presses.count) if presses else None
    for fl in flights:
        p = fl['path']
        air = p[1:-1]
        for a, b in zip(air, air[1:]):  # across the air: the walking speed, and the key held each way
            if b[0] <= a[0]:
                continue
            v = (b[1] - a[1]) / (b[0] - a[0])
            if abs(v) > 0.02:
                for key in a[3]:
                    across[1 if v > 0 else -1][key] = across[1 if v > 0 else -1].get(key, 0) + 1
            if len(a[3]) == 1 or (len(a[3]) == 2 and jump_key in a[3]):
                airs.append(abs(v))
        if fl.get('press') is None or fl['press'][1] != jump_key or len(air) < 4:
            continue
        t0, key = fl['press']
        if fl.get('hold'):
            holds.append(fl['hold'])
        ts = [q[0] - t0 for q in air]
        ys = [q[2] for q in air]
        quad = _parabola(ts, ys)
        if quad is None:
            continue
        a, b, c, rms = quad
        if rms <= FIT_RMS and a > 0 and b < 0:
            gs.append(2 * a)
            vs.append(-b)
    falls = []
    for fl in flights:
        p = fl['path']
        if len(p) > 2 and p[-1][2] - min(q[2] for q in p) >= LONG_FALL:
            tail = [q for q in p if q[0] >= p[-1][0] - FALL_TAIL_MS]
            if len(tail) >= 2 and tail[-1][0] > tail[0][0]:
                falls.append((tail[-1][2] - tail[0][2]) / (tail[-1][0] - tail[0][0]))
    def way(sign):  # the key held going that way most, but not the other way as often
        counts = {k: n for k, n in across[sign].items() if k != jump_key and n > 2 * across[-sign].get(k, 0)}
        return max(counts, key=counts.get) if counts else None
    walk = statistics.median([v for v in airs if v > 0.02]) if len([v for v in airs if v > 0.02]) >= MIN_FITS else None
    if walk is None and along:
        speeds = [w['speed'] for ways in along.values() for w in ways.values()]
        walk = statistics.median(speeds) if speeds else None
    enough = len(gs) >= MIN_FITS
    slides = sorted(s for s, _ in (stops or []))
    slide = statistics.median(slides) if len(slides) >= MIN_STOPS else None
    precision = None
    if slide is not None:
        off = sorted(abs(s - slide) for s in slides)
        precision = off[min(len(off) - 1, int(PRECISE_SHARE * len(off)))] + (walk or 0) * (frame_ms or 0) / 2
    return {'walk': _round(walk), 'jump': _round(statistics.median(vs)) if enough else None,
            'slide': _round(slide, 1), 'precision': _round(precision, 1),
            'gravity': _round(statistics.median(gs), 6) if enough else None,
            'fall': _round(statistics.median(falls)) if falls else None,
            'jumpKey': jump_key, 'rightKey': way(1), 'leftKey': way(-1),
            'jumpHoldMs': round(statistics.median(holds)) if holds else None,
            'fits': {'jumps': len(gs), 'of': sum(1 for f in flights if f.get('press') and f['press'][1] == jump_key), 'falls': len(falls),
                     'stops': len(slides)}}


def merged(measured, chosen):
    """The movement as used: what was measured, with what the user set in its place (each in px and ms)."""
    out = dict(measured or {})
    for k, v in (chosen or {}).items():
        if v is not None:
            out[k] = v
    return out


def usable(phys):
    return bool(phys) and all(isinstance(phys.get(k), (int, float)) and phys[k] > 0 for k in ('walk', 'jump', 'gravity'))


def _parabola(ts, ys):
    n = len(ts)
    if n < 3:
        return None
    sx = [sum(t ** k for t in ts) for k in range(5)]
    sy = [sum(y * t ** k for t, y in zip(ts, ys)) for k in range(3)]
    m = [[sx[4], sx[3], sx[2]], [sx[3], sx[2], sx[1]], [sx[2], sx[1], sx[0]]]
    sol = _solve3(m, [sy[2], sy[1], sy[0]])
    if sol is None:
        return None
    a, b, c = sol
    rms = math.sqrt(sum((y - (a * t * t + b * t + c)) ** 2 for t, y in zip(ts, ys)) / n)
    return a, b, c, rms


def _solve3(m, v):
    det = lambda q: (q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])  # noqa: E731
                     + q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]))
    d = det(m)
    if abs(d) < 1e-18:
        return None
    out = []
    for col in range(3):
        q = [row[:] for row in m]
        for r in range(3):
            q[r][col] = v[r]
        out.append(det(q) / d)
    return out


def _round(v, digits=4):
    return None if v is None else round(v, digits)


# ── simulating ─────────────────────────────────────────────────────────────────────────────────────────────────
def height(phys, t, launch):
    """How far above the start (negative y is up) the player is t ms into a flight launched at `launch` px/ms up."""
    g, cap = phys['gravity'], phys.get('fall') or math.inf
    tc = (launch + cap) / g  # when falling reaches its fastest
    if t <= tc:
        return -launch * t + g * t * t / 2
    yc = -launch * tc + g * tc * tc / 2
    return yc + cap * (t - tc)


class Lines:
    """A level's lines indexed by `bucket`-px column, for arcs: which segments a stretch of flight might meet, each
    (line, a, b, x0, x1, y0, y1) with its bounding box, so most are passed over without working out a crossing."""

    def __init__(self, lines, upright, bucket=64):
        self.lines, self.bucket = lines, bucket
        self.upright = [bool(upright(k)) for k in range(len(lines))]
        self.cols = {}
        for k, (_, pts) in enumerate(lines):
            for a, b in zip(pts, pts[1:]):
                seg = (k, a, b, min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]))
                for c in range(math.floor(seg[3] / bucket) - 1, math.floor(seg[4] / bucket) + 2):
                    self.cols.setdefault(c, []).append(seg)

    def near(self, x1, x2):
        c1, c2 = math.floor(min(x1, x2) / self.bucket), math.floor(max(x1, x2) / self.bucket)
        if c1 == c2:
            return self.cols.get(c1, ())
        seen, out = set(), []
        for c in range(c1, c2 + 1):
            for seg in self.cols.get(c, ()):
                if id(seg) not in seen:
                    seen.add(id(seg))
                    out.append(seg)
        return out


def arc(phys, index, x0, y0, vx, launch, start, solid=False, step=16.0, catch=6.0):
    """Where a flight from (x0, y0), across at vx px/ms and launched `launch` px/ms up (0: walking off an edge), first
    lands, over a level's indexed lines (Lines): (line index, x, y, ms, rise) or None, rise how far above the start it
    went (negative). `start` is the line left (not landed on rising off it); a rope or ladder is caught anywhere it's
    passed, within `catch` px across; a platform only coming down onto it, and with `solid`, a platform crossed going up
    (other than the one left) blocks the flight."""
    t, x, y = 0.0, x0, y0
    top = 0.0
    while t < GIVE_UP_MS:
        t2 = t + step
        x2, y2 = x0 + vx * t2, y0 + height(phys, t2, launch)
        rising = y2 < y
        best = None
        lo_x, hi_x, lo_y, hi_y = min(x, x2) - catch, max(x, x2) + catch, min(y, y2), max(y, y2)
        for k, a, b, sx0, sx1, sy0, sy1 in index.near(lo_x, hi_x):
            if sx1 < lo_x or sx0 > hi_x or sy1 < lo_y or sy0 > hi_y:
                continue
            if index.upright[k]:
                if k == start:
                    continue
                rx, lo, hi = a[0], min(a[1], b[1]), max(a[1], b[1])
                if (min(x, x2) - catch <= rx <= max(x, x2) + catch) and lo <= max(y, y2) and min(y, y2) <= hi:
                    f = 0.0 if x2 == x else max(0.0, min(1.0, (rx - x) / (x2 - x)))
                    hit = (rx, min(hi, max(lo, y + f * (y2 - y))), f)
                else:
                    continue
            else:
                hit = _cross((x, y), (x2, y2), a, b)
                if hit is None:
                    continue
                if rising:
                    if solid and k != start:
                        return None  # a platform overhead, solid from below
                    continue
                if k == start and t2 < 60:
                    continue
            if best is None or hit[2] < best[1][2]:
                best = (k, hit)
        if best is not None:
            k, (hx, hy, f) = best
            return k, hx, hy, t + f * step, min(top, hy - y0)
        t, x, y = t2, x2, y2
        top = min(top, y - y0)
        if y - y0 > 5000:
            return None
    return None


def _cross(p, q, a, b):
    """Where segment pq crosses segment ab (touching counts), and how far along pq, or None."""
    d = (q[0] - p[0]) * (b[1] - a[1]) - (q[1] - p[1]) * (b[0] - a[0])
    if abs(d) < 1e-12:
        return None
    s = ((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])) / d
    u = ((a[0] - p[0]) * (q[1] - p[1]) - (a[1] - p[1]) * (q[0] - p[0])) / d
    if 0 <= s <= 1 and 0 <= u <= 1:
        return p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1]), s
    return None
