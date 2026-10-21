"""Recorded movement edges: stop-to-stop clips, never averaged cell commands.

Only join demonstrations at nearby resting positions on the same level. A whole
clip keeps one recording's chronology, including repeated visits to a position.
"""
import hashlib
import math

import keys as keys_
from observations import level_key

MAX_MS = 30000
MAX_EVENTS = 512
JOIN_PX = 4
START_PX = 6
MAX_SAMPLE_GAP = 500
MONITOR_WINDOW_MS = 150
MONITOR_DISTANCE_PX = 24
MONITOR_CONFIRM_MS = 150


def sync_points(track, sync, keys, t0, t1, window, levels=None):
    """Where a recorded movement waits for a State: each press (a key going down, after its first moment) that came
    within `window` ms after the State turned true (false at one sample, true at the next; a press between the two is
    taken as after it, since the samples can't tell). [{at, transition: [lo, hi], after?, afterKey?}], ms from t0: `at`
    is the first true sample, or the press itself when it came between the two, and the movement's inputs from `at` on
    are played from when the State turns true in play. One per turning true, in time order.

    Each wait belongs to its own turning true: `after` is when the last key went down (`afterKey`) before the State
    turned false on the way to it (the jump whose landing it is), so in play only a turning false and then true after
    that key is sent counts for it. A movement can turn false and true more than once before a wait (a jump, a landing,
    another jump), and an earlier landing taken for the one waited for started the next presses early. Without a press
    in the movement before it, any turning true since the part began counts."""
    if not sync or window <= 0:
        return []
    rises = []
    for i in range(1, len(track)):
        if sync[i] is True and sync[i - 1] is False and t0 < track[i][0] <= t1 + window:
            k = i - 1  # the first sample of the stretch that was false before it
            while k > 0 and sync[k - 1] is False:
                k -= 1
            rises.append((track[i - 1][0], track[i][0], track[k][0], i))
    out, used = [], set()
    for t, key, down in keys.between(t0, t1):
        if not down or t - t0 < 1:
            continue
        rise = next((r for r in rises if r[0] < t <= r[1] + window), None)
        if rise is None or rise in used:
            continue
        used.add(rise)
        cause = [p for p in keys.between(t0, rise[2]) if p[2]]
        out.append({'at': round(min(rise[1], t) - t0, 1), 'transition': [round(rise[0] - t0, 1), round(rise[1] - t0, 1)],
                    'expected': {'position': list(track[rise[3]][1:3]), 'level': levels[rise[3]] if levels else None},
                    **({'after': round(cause[-1][0] - t0, 1), 'afterKey': cause[-1][1]} if cause else {})})
    return out


def learn(tracks, namespace='', sync_window=0):
    """Recorded movements from tracks [(id, track, grounded, levels, keys[, sync])]: `sync`, per sample, the map's
    Wait for State (True/False/None), from which each movement's sync points come (sync_points)."""
    places, links, moves, notes = [], [], [], []

    def place(level, x, y):
        nearby = [(math.hypot(p[1] - x, p[2] - y), i) for i, p in enumerate(places) if p[0] == level]
        distance, i = min(nearby, default=(math.inf, -1))
        if distance <= JOIN_PX:
            places[i][3] += 1
            return i  # retain a recorded position, not an averaged takeoff
        places.append([level, x, y, 1])
        return len(places) - 1

    for rid, track, grounded, levels, keys, *more in tracks:
        sync = more[0] if more else None
        if sync_window > 0 and sync is None:
            notes.append(f'{rid}: doesn’t hold what presses wait for (Wait for); its movements are timed by the clock.')
        if not getattr(keys, 'recorded', False):
            notes.append(f'{rid}: no timestamped input events; record a new demonstration for sequence replay.')
            continue
        lv = [level_key(list(v) if isinstance(v, tuple) else v) if v is not None else None for v in levels] if levels is not None else [None] * len(track)
        checkpoints = keys_.stands(track, keys, grounded)
        if len(checkpoints) < 2:
            notes.append(f'{rid}: pause with keys released at the start and end of each movement.')
        for c in keys_.clips_between_stands(track, keys, grounded):
            a, b = c['a'], c['b']
            # Do not bridge capture interruptions or input resynchronization.
            if any(track[j + 1][0] - track[j][0] > MAX_SAMPLE_GAP for j in range(a, b)) or any(
                    key is None and c['from'] < t <= c['to'] for t, key, _ in keys.events):
                notes.append(f'{rid}: skipped an interrupted movement at {c["from"]:.0f} ms.')
                continue
            clip = keys_.clip(keys, c['from'], c['to'])
            if clip['end'] > MAX_MS or len(clip['keys']) + len(clip['timeline']) > MAX_EVENTS:
                notes.append(f'{rid}: a movement exceeds 30 seconds or 512 events; pause more often while recording.')
                continue
            start, end = place(lv[a], *c['start']), place(lv[b], *c['end'])
            if start == end:
                continue
            identity = hashlib.sha256(f'{namespace}:{rid}:{c["from"]}:{c["to"]}'.encode()).hexdigest()[:24]
            links.append({'id': f'recorded:{identity}', 'from': f'g{start}', 'to': f'g{end}', 'kind': 'clip',
                          'clip': {'recording': rid, 'from': c['from'], 'to': c['to']}, 'ms': clip['end'],
                          'recorded': True, 'start': list(c['start']), 'end': list(c['end']),
                          'trajectory': [[round(track[j][0] - c['from'], 1), track[j][1], track[j][2], lv[j]]
                                         for j in range(a, b + 1)],
                          **({'syncs': syncs} if (syncs := sync_points(track, sync, keys, c['from'], c['to'], sync_window, lv)) else {})})
            used = sorted(set(clip['keys']) | {key for _, key, _ in clip['timeline']})
            moves.append([start, end, clip['end'], 1, used])
    return {'cell': None, 'places': places, 'moves': moves, 'links': links, 'notes': list(dict.fromkeys(notes))}


def drawn_path(link, most=48):
    """A recorded movement's path for the map editor to draw: [x, y] along its trajectory, at most `most` points
    (its first and last always kept), so a long movement is drawn as it went, not as a straight line across the map."""
    path = [[p[1], p[2]] for p in link.get('trajectory') or []]
    if len(path) <= most:
        return path
    step = (len(path) - 1) / (most - 1)
    return [path[round(k * step)] for k in range(most)]


def deviation(trajectory, elapsed, level, x, y):
    """Nearest expected position in a bounded time window, not anywhere on the
    route. Interpolate only inside one level and clip segments to that window."""
    lo, hi = elapsed - MONITOR_WINDOW_MS, elapsed + MONITOR_WINDOW_MS
    best, expected = math.inf, None

    def consider(px, py):
        nonlocal best, expected
        d = math.hypot(x - px, y - py)
        if d < best:
            best, expected = d, [px, py]

    for t, px, py, lv in trajectory:
        if lo <= t <= hi and lv == level:
            consider(px, py)
    for a, b in zip(trajectory, trajectory[1:]):
        if a[3] != level or b[3] != level or b[0] <= a[0] or a[0] > hi or b[0] < lo:
            continue
        u0, u1 = max(0, (lo - a[0]) / (b[0] - a[0])), min(1, (hi - a[0]) / (b[0] - a[0]))
        ax, ay = a[1] + (b[1] - a[1]) * u0, a[2] + (b[2] - a[2]) * u0
        bx, by = a[1] + (b[1] - a[1]) * u1, a[2] + (b[2] - a[2]) * u1
        length2 = (bx - ax) ** 2 + (by - ay) ** 2
        u = max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length2)) if length2 else 0
        consider(ax + u * (bx - ax), ay + u * (by - ay))
    return best, expected
