"""How far the platformer model's landings are from where jumps pressed by position came down in play, and whether a
correction from the state a jump was pressed in would have predicted them better. Measurement only: nothing here
moves a takeoff.

An outcome is a jump the executor pressed by where the player was (adapt, narrow or unsafe: one the model predicts the
flight of; not a position jump, whose keys change in the air), from a map's runs (traces/behavior): where it was
pressed (the player's place at the press, between readings), how fast it was going along its way just before (from its
readings on the ground), the grade under it (Ground.graded), how long after the landing its part began on; and where
its flight came down through the height of the platform it was going to (between readings, or its first reading on
it), against where the model has it coming down from that same press, at the median delay. Its error is how much
further it went than the model, the way it jumped.

Left out, and counted: flights stopped across in the air (something the lines don't show), ones never coming down
through the platform's height, and ones the model has landing back where they left.

A correction is reusable, from the state a jump is pressed in, not one jump's own: error = b0 + b1 (speed / walking - 1)
+ b2 [pressed within FRESH_MS of a landing] + b3 [downhill] + b4 [uphill], fitted by least squares. It's scored by
leaving each run out in turn (fitted on the others, predicting it), beside no correction and a per-jump offset (each
jump's mean error in the other runs), so a correction that only memorises jumps doesn't look better than it is."""
import math

import numpy as np

import platformer as platformer_

MODELLED = ('adapt', 'narrow', 'unsafe')
FRESH_MS = 60.0       # pressed within this long of a landing (the traces' 20-60 ms presses flew about 13% slower)
SPEED_MS = 150.0      # its speed from its readings on the ground over this long before the press
STOPPED_MS = 60.0     # its place across unchanged for this long in the air: stopped by something
FEATURES = ('speed', 'fresh', 'downhill', 'uphill')


def _at(reads, t):
    """x and y at time t between readings [(t, x, y, grounded)], or None outside them."""
    for a, b in zip(reads, reads[1:]):
        if a[0] <= t <= b[0]:
            f = (t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
            return a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f
    return None


def outcomes(frames, model, sync_name, run=''):
    """A run's jumps pressed by position, as outcomes ({run, link, index, status, dir, pressX, speed, sinceLanding,
    grade, crossX, modelX, errorPx}), and what was left out ({reason: count})."""
    reads, links, out, left = [], {}, [], {}
    for f in frames:
        m = next(iter((f.get('maps') or {}).values()), {})
        p = m.get('position')
        g = (f.get('values') or {}).get(sync_name)
        if p and isinstance(g, bool):
            reads.append((f['t'], p[0], p[1], g))
    pending, landed, link = [], None, None
    for f in frames:
        for e in f.get('events') or []:
            if e.get('kind') == 'link':
                link = e
                landed = None
            elif e.get('kind') == 'sync' and e.get('worked'):
                landed = e.get('transitionAt')
            elif e.get('kind') == 'takeoff' and e.get('worked') and e.get('status') in MODELLED and link and e.get('pressAt'):
                rows = (link.get('recorded') or {}).get('takeoffs') or []
                if e['index'] < len(rows):
                    pending.append((e, rows[e['index']], link.get('link'), landed))
    walk, mid = model['walk'], model['delays'][1]
    for e, row, lid, landed in pending:
        why = None
        lines = row.get('lines')
        if not lines or len(lines) < 2:
            why = 'no lines kept with it'
        d = row.get('dir') or 0
        press = e['pressAt']
        at = _at(reads, press)
        if why is None and (at is None or not d):
            why = 'no reading round its press'
        if why:
            left[why] = left.get(why, 0) + 1
            continue
        target = lines[1]
        xs = [q[0] for q in target]
        lo_t, hi_t = min(xs), max(xs)
        # the platform's height carried on flat beyond its ends, so a flight falling short or long still crosses it
        ends = sorted(target, key=lambda q: q[0])
        extended = [[lo_t - 1000, ends[0][1]], *ends, [hi_t + 1000, ends[-1][1]]]
        ground = platformer_.Ground([lines[0], extended])
        before = [r for r in reads if press - SPEED_MS <= r[0] <= press and r[3]]
        speed = ((before[-1][1] - before[0][1]) / (before[-1][0] - before[0][0]) * d) if len(before) >= 2 and before[-1][0] > before[0][0] else None
        graded = ground.graded(0, at[0], d)
        flight = [r for r in reads if r[0] > press and r[0] <= press + 1500]
        k = next((n for n, r in enumerate(flight) if not r[3]), None)
        if k is None or speed is None:
            left['no flight read' if k is None else 'no speed read before it'] = left.get('no flight read' if k is None else 'no speed read before it', 0) + 1
            continue
        air = []
        for r in flight[k:]:
            air.append(r)
            if r[3]:
                break
        # stopped across in the air: its x unchanged STOPPED_MS or longer before it came down
        stopped, a = False, 0
        for b in range(len(air)):
            while abs(air[b][1] - air[a][1]) > 0.5:
                a += 1
            if air[b][0] - air[a][0] >= STOPPED_MS and not air[b][3]:
                stopped = True
                break
        if stopped:
            left['stopped across in the air'] = left.get('stopped across in the air', 0) + 1
            continue
        cross = None
        for p0, p1 in zip([flight[k - 1] if k else air[0], *air], air):
            y0, y1 = ground.y_on(1, p0[1]), ground.y_on(1, p1[1])
            if y0 is None or y1 is None or p1[2] <= p0[2]:
                continue
            if p0[2] < y0 and p1[2] >= y1:
                f = (y0 - p0[2]) / ((p1[2] - p0[2]) - (y1 - y0)) if (p1[2] - p0[2]) != (y1 - y0) else 0.0
                cross = p0[1] + (p1[1] - p0[1]) * max(0.0, min(1.0, f))
                break
        if cross is None and air and air[-1][3]:  # its first reading on the ground again, on the platform (within ON_PX)
            yl = ground.y_on(1, air[-1][1])
            if yl is not None and abs(air[-1][2] - yl) <= platformer_.ON_PX:
                cross = air[-1][1]
        if cross is None:
            left['never came down through its platform’s height'] = left.get('never came down through its platform’s height', 0) + 1
            continue
        vx = d * walk
        gvx = vx if row.get('moving') else 0.0
        hit = platformer_.press_landing(model, ground, 0, at[0], vx, gvx, mid)
        if hit is None or hit[0] != 1:
            left['the model has it landing where it left'] = left.get('the model has it landing where it left', 0) + 1
            continue
        out.append({'run': run, 'link': lid, 'index': e['index'], 'status': e.get('status'), 'dir': d, 'pressX': round(at[0], 1),
                    'speed': round(speed, 4), 'sinceLanding': None if landed is None else round(press - landed, 1),
                    'grade': graded[0] if graded else None, 'crossX': round(cross, 1), 'modelX': round(hit[1], 1),
                    'errorPx': round((cross - hit[1]) * d, 1), 'atFarEnd': abs(cross - (hi_t if d > 0 else lo_t)) <= platformer_.COLLIDE_PX})
    return out, left


CAL_MIN = 20  # outcomes in a condition before its error is taken as the model's there (summary)


def condition(o):
    """An outcome's conditions: whether pressed within FRESH_MS of a landing, and the grade it was pressed on."""
    return f"{'fresh' if o['sinceLanding'] is not None and o['sinceLanding'] <= FRESH_MS else 'later'}·{o['grade'] or 'flat'}"


def summary(found, least=CAL_MIN):
    """How far the model was from where jumps came down, per condition with at least `least` outcomes, leaving out
    those that came down at their platform's far end (where something may have stopped them): {condition: {n,
    p90AbsPx, biasPx}}, p90 to a tenth of a px so the analyses built on it don't change with every run."""
    groups = {}
    for o in found:
        if not o.get('atFarEnd'):
            groups.setdefault(condition(o), []).append(o['errorPx'])
    out = {}
    for key, errors in sorted(groups.items()):
        if len(errors) >= least:
            a = sorted(abs(e) for e in errors)
            out[key] = {'n': len(errors), 'p90AbsPx': round(a[min(len(a) - 1, int(0.9 * len(a)))], 1),
                        'biasPx': round(sum(errors) / len(errors), 1)}
    return out


def features(o, walk):
    fresh = o['sinceLanding'] is not None and o['sinceLanding'] <= FRESH_MS
    return [1.0, o['speed'] / walk - 1.0, 1.0 if fresh else 0.0, 1.0 if o['grade'] == 'down' else 0.0, 1.0 if o['grade'] == 'up' else 0.0]


def _summary(errors):
    if not errors:
        return None
    a = sorted(abs(e) for e in errors)
    return {'n': len(errors), 'meanAbsPx': round(sum(a) / len(a), 2), 'p90AbsPx': round(a[min(len(a) - 1, int(0.9 * len(a)))], 2),
            'biasPx': round(sum(errors) / len(errors), 2)}


def _fit(rows, walk):
    X = np.array([features(o, walk) for o in rows])
    y = np.array([o['errorPx'] for o in rows])
    used = [0] + [c for c in range(1, X.shape[1]) if np.any(X[:, c] != X[0, c])]  # a feature that never varies can't be told apart
    coef = np.zeros(X.shape[1])
    if len(rows) >= len(used):
        sol, *_ = np.linalg.lstsq(X[:, used], y, rcond=None)
        coef[used] = sol
    return coef


def evaluate(found, walk):
    """The report: how many outcomes and from how many runs, the model's error as it is, with a reusable correction
    and with per-jump offsets (each scored by leaving a run out), and the correction fitted on them all."""
    runs = sorted({o['run'] for o in found})
    plain = [o['errorPx'] for o in found]
    calibrated, per_jump = [], []
    for r in runs:
        rest = [o for o in found if o['run'] != r]
        mine = [o for o in found if o['run'] == r]
        coef = _fit(rest, walk) if len(rest) >= 3 else np.zeros(len(FEATURES) + 1)
        for o in mine:
            calibrated.append(o['errorPx'] - float(np.dot(coef, features(o, walk))))
            same = [p['errorPx'] for p in rest if (p['link'], p['index']) == (o['link'], o['index'])]
            per_jump.append(o['errorPx'] - (sum(same) / len(same) if same else 0.0))
    coef = _fit(found, walk) if len(found) >= 3 else np.zeros(len(FEATURES) + 1)
    by_state = {}
    for o in found:
        key = ('fresh' if o['sinceLanding'] is not None and o['sinceLanding'] <= FRESH_MS else 'later') + ' · ' + (o['grade'] or '?')
        by_state.setdefault(key, []).append(o['errorPx'])
    return {'outcomes': len(found), 'runs': len(runs), 'jumps': len({(o['link'], o['index']) for o in found}),
            'asModelled': _summary(plain), 'reusable': _summary(calibrated), 'perJump': _summary(per_jump),
            'correction': {'interceptPx': round(float(coef[0]), 2), **{f'{name}Px': round(float(c), 2) for name, c in zip(FEATURES, coef[1:])}},
            'byState': {k: _summary(v) for k, v in sorted(by_state.items())}}
