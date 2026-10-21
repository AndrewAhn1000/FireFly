"""A replayed movement against its recording, from a behaviour trace (worker.behavior_replay, Tree Replay's report).

Measurement only: nothing here changes how a tree runs. For each recorded link attempt in a trace it lines up three
clocks, all monotonic ms (QueryPerformanceCounter):

  recorded   ms from the clip's first key press in the recording (its trajectory, and its key events' due times)
  executor   ms from the guard's start of the action (each press's sent time, from its `dispatch` record)
  live       the frames' capture times minus the action's start, so live and recorded share one elapsed axis

Per key event it reports the press's due and sent time, the recorded and live positions at its due time (each marked
observed or interpolated, with how far the nearest real reading is), the raw error between them, and the time lag
that best lines the live path up with the recorded one near it, with the error left after that, so neither hides the
other. A position read again from the runtime's cache (`reused`) isn't a reading: it's left out of the live path.
Traces from before reads carried `readAt` say so, and a reading equal to the one before within PROBE_GAP_MS is taken
as reused.
"""
import bisect
import math

import platformer as platformer_

THRESHOLD_PX = 8      # raw error at which an attempt counts as diverged (the request's thresholdPx)
LAG_RANGE_MS = 300    # lags tried, either way
LAG_STEP_MS = 5
LAG_WINDOW_MS = 150   # live readings either side of an event that the lag is fitted to
FLAT_PX = 1.0         # a lag whose fit varies less than this over the range can't be told (the player not moving)
NEAR_MS = 100         # a position more than this from any real reading isn't given
RELIABLE_MS = 25      # a recorded position counts toward divergence only this close to a real recorded reading
PROBE_GAP_MS = 30     # the runtime's probe gap before it was a setting, for inferring reuse in old traces
SERIES_MAX = 600      # points of the error series kept per attempt, for drawing
STILL_MS = 100        # a jump came down where it stayed this long


def _ended(attempt):
    """How an attempt ended ({worked, cause, why, arrival?, recovered?, finish?}), or None if the run stopped before it
    did. `arrival`: how a recorded movement that worked got onto its end, 'direct' or 'corrected' by its terminal
    correction (whose taps and facing are `finish`)."""
    end = attempt.get('end') or {}
    if not end:
        return None
    rec, fin = attempt.get('recovered'), attempt.get('finish')
    # it reached its platform, not its place: whether lining up put it right (None: not known in this run)
    return {'worked': end.get('worked'), 'cause': end.get('cause'), 'why': end.get('why'),
            **({'arrival': end['arrival']} if end.get('arrival') else {}),
            **({'finish': {k: fin.get(k) for k in ('worked', 'arrival', 'taps', 'corrections', 'offPx', 'facing', 'dropped', 'why', 'ms')}} if fin else {}),
            **({'recovered': rec.get('worked') if rec else None, 'recoveredHow': rec.get('how') if rec else None} if end.get('pending') else {})}


def outcome(ended):
    """An attempt's outcome, counted apart: 'direct' (onto its end as played), 'corrected' (by its terminal correction),
    'recovered' (missed its end on its platform, put right by lining up after), 'failed', or None (not ended)."""
    if not ended:
        return None
    if ended.get('worked'):
        return 'corrected' if ended.get('arrival') == 'corrected' else 'direct'
    return 'recovered' if ended.get('recovered') else 'failed'


def summary(attempts):
    """Link attempts counted by outcome (outcome()), with `retries` (attempts of a link that had already been tried in
    the run) and `attempts`, the denominator."""
    out, seen = {'attempts': 0, 'direct': 0, 'corrected': 0, 'recovered': 0, 'failed': 0, 'unended': 0, 'retries': 0}, set()
    for a in attempts:
        if a.get('kind') == 'line-up':
            continue
        out['attempts'] += 1
        out[outcome(a.get('ended')) or 'unended'] += 1
        key = (a.get('map'), a.get('link'))
        if key in seen:
            out['retries'] += 1
        seen.add(key)
    return out


def _thin(points, most=SERIES_MAX):
    """At most `most` of a list's points, evenly, its last kept."""
    if len(points) <= most:
        return points
    step = len(points) / most
    return [points[int(k * step)] for k in range(most - 1)] + [points[-1]]


def _interp(points, t):
    """A path's position at t ([(t, x, y, level)] in time order): (x, y, level, nearest ms to a real point,
    interpolated) or None outside it, or across a change of level."""
    if not points:
        return None
    times = [p[0] for p in points]
    i = bisect.bisect_left(times, t)
    if i < len(points) and points[i][0] == t:
        p = points[i]
        return p[1], p[2], p[3], 0.0, False
    if i == 0 or i == len(points):
        return None
    a, b = points[i - 1], points[i]
    if a[3] != b[3]:
        return None
    u = (t - a[0]) / (b[0] - a[0])
    return a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3], min(t - a[0], b[0] - t), True


def _distance(a, b):
    if a is None or b is None or a[2] != b[2]:
        return None
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _lag(live, recorded, at):
    """The lag (ms) that best lines the live readings within LAG_WINDOW_MS of `at` up with the recorded path: live at
    time t is where the recording was at t - lag, so a positive lag is the replay behind. (lag, error left) or
    (None, None) when there's nothing to fit or the fit can't tell lags apart."""
    near = [p for p in live if abs(p[0] - at) <= LAG_WINDOW_MS]
    if not near:
        return None, None
    costs = []
    for lag in range(-LAG_RANGE_MS, LAG_RANGE_MS + 1, LAG_STEP_MS):
        ds = [_distance((p[1], p[2], p[3]), (r[0], r[1], r[2]) if (r := _interp(recorded, p[0] - lag)) else None) for p in near]
        ds = [d for d in ds if d is not None]
        if len(ds) == len(near):
            costs.append((sum(ds) / len(ds), lag))
    if not costs:
        return None, None
    best = min(costs, key=lambda c: (c[0], abs(c[1])))
    if max(c[0] for c in costs) - best[0] < FLAT_PX:
        return None, round(best[0], 1)
    return best[1], round(best[0], 1)


def _point(found):
    if found is None:
        return None
    x, y, level, nearest, interpolated = found
    return {'x': round(x, 1), 'y': round(y, 1), 'level': level, 'nearestMs': round(nearest, 1), 'interpolated': interpolated}


def _live_series(frames, mid):
    """Where the player was on map `mid`, frame by frame: [(t, x, y, level, read, read lag)], read 'fresh', 'reused'
    or 'inferred-reused', read lag how long after the frame's capture its States were read (readAt - t, None
    unknown), and whether the trace marks reuse. New traces have the map's position on every frame and the
    reads' `readAt`; older ones only the trajectory monitor's (while a recorded link played)."""
    out, marked, last = [], False, None
    for f in frames:
        m = (f.get('maps') or {}).get(mid) or {}
        reads = f.get('reads') or {}
        if 'position' in m:
            t, (x, y), level = f['t'], m['position'], m.get('level')
        elif (mon := m.get('monitor')) and mon.get('actual') and isinstance(mon.get('observedAt'), (int, float)):
            t, (x, y), level = mon['observedAt'], mon['actual'], None
            if out and out[-1][0] >= t:
                continue  # the monitor's last check, shown again
        else:
            continue
        lag = None
        if reads:
            marked = True
            read = 'reused' if any(r[1] for r in reads.values()) else 'fresh'
            lag = min(r[0] for r in reads.values()) - f['t']
        elif last is not None and (x, y, level) == last[1:4] and t - last[0] < PROBE_GAP_MS:
            read = 'inferred-reused'
        else:
            read = 'fresh'
        out.append((t, float(x), float(y), level, read, lag))
        if read == 'fresh':
            last = (t, float(x), float(y), level)
    return out, marked


def _attempts(frames):
    """Link attempts in a trace: from its link events, else (older traces) from each map status's running link."""
    attempts, by_id, lined = [], {}, {}
    for n, f in enumerate(frames):
        for e in f.get('events') or []:
            if e.get('kind') == 'line-up':  # lining up with a recorded start: the attempt it led to, or one of its own
                if e.get('worked'):
                    lined[e.get('map')] = e
                else:
                    attempts.append({'kind': 'line-up', 'attempt': f'line-up {len(attempts) + 1}', 'map': e.get('map'), 'lineUp': e, 'begun': n, 'ended': n})
            elif e.get('kind') == 'link':
                a = {**e, 'begun': n, 'ended': None, **({'lineUp': lined.pop(e.get('map'))} if e.get('map') in lined else {})}
                attempts.append(a)
                by_id[e['attempt']] = a
            elif e.get('kind') == 'link-end' and e.get('attempt') in by_id:
                by_id[e['attempt']].update(end=e, ended=n)
            elif e.get('kind') == 'link-recovered' and e.get('attempt') in by_id:
                by_id[e['attempt']]['recovered'] = e
            elif e.get('kind') == 'finish' and e.get('attempt') in by_id:
                by_id[e['attempt']]['finish'] = e
    if attempts:
        return attempts, True
    running = {}
    for n, f in enumerate(frames):
        for mid, m in (f.get('maps') or {}).items():
            lid = (m or {}).get('link')
            if lid and running.get(mid) != lid:
                attempts.append({'kind': 'link', 'attempt': len(attempts) + 1, 'map': mid, 'link': lid, 'begun': n, 'ended': None})
            elif not lid and running.get(mid):
                a = next(a for a in reversed(attempts) if a['map'] == mid)
                last = m.get('last') or ''
                a.update(ended=n, end={'worked': not last or 'failed' not in last, **({'why': last} if last else {})})
            running[mid] = lid
    return attempts, False


def _action_of(frames, attempt):
    """The action (guard sequence) an attempt played: the first begun from its start up to its end."""
    stop = attempt['ended'] if attempt['ended'] is not None else len(frames) - 1
    for f in frames[attempt['begun']:stop + 1]:
        if f.get('action') and f.get('sequence') is not None:
            return f['action'], f['sequence']
    return None, None


def _parts(frames, attempt, dispatches):
    """The actions an attempt played: one, or one per part of a movement that waited for a State (its 'segment'
    events): [{action, sequence, recorded (each press's time in the recording), anchor (live time or None for its
    action's start, recorded time it maps to), dispatch, started, execution}]."""
    stop = attempt['ended'] if attempt['ended'] is not None else len(frames) - 1
    sequences = {}
    for f in frames:
        if f.get('action') and f.get('sequence') is not None:
            sequences.setdefault(f['action']['id'], (f['action'], f['sequence']))
    said = {}
    for f in frames[attempt['begun']:stop + 1]:
        for e in f.get('events') or []:
            if e.get('kind') == 'segment' and e.get('attempt') == attempt['attempt'] and e.get('actionId') in sequences:
                said[e['index']] = e
    out = []
    for k in sorted(said):
        action, sequence = sequences[said[k]['actionId']]
        out.append({'action': action, 'sequence': sequence, 'recorded': said[k]['recorded'], 'anchor': tuple(said[k]['anchor'])})
    if not out:
        action, sequence = _action_of(frames, attempt)
        if action is None:
            return []
        out.append({'action': action, 'sequence': sequence, 'recorded': [ms for ms, _, _ in sequence], 'anchor': (None, 0.0)})
    for part in out:
        d = dispatches.get(part['action']['id'])
        started, execution = _execution(frames, part['action']['id'])
        if d and d.get('startedAt'):
            started = d['startedAt']
        part.update(dispatch=d, started=started, execution=execution)
    return out


def _syncs(frames, attempt):
    """How each of an attempt's waits for a State went: [{index, worked, waitedMs, lateMs, why}]."""
    stop = attempt['ended'] if attempt['ended'] is not None else len(frames) - 1
    return [{k: e.get(k) for k in ('index', 'worked', 'waitedMs', 'lateMs', 'why', 'transitionAt', 'recordedAt')}
            for f in frames[attempt['begun']:stop + 1] for e in f.get('events') or []
            if e.get('kind') == 'sync' and e.get('attempt') == attempt['attempt']]


def _speed(readings, t, ms=80):
    """The player's speed along x (px/ms) from its readings [(read time, x, y)] in the `ms` before t, else 0."""
    near = [r for r in readings if t - ms <= r[0] <= t]
    return (near[-1][1] - near[0][1]) / (near[-1][0] - near[0][0]) if len(near) >= 2 and near[-1][0] > near[0][0] else 0.0


def _jumps(frames, attempt, recorded, parts, readings, buttons, elapsed):
    """Each of a movement's recorded jumps as it went (adaptive takeoff, platformer.py): how it was to be pressed
    (`status`, its safe stretch and aim, and with adaptive takeoff the executor's plan), where the player was when the
    guard sent the press (its readings carried on at their own speed), where the model said that lands, and where it
    landed: on its target line, back on the line it left, elsewhere, or no jump. [{...}] (None without the model)."""
    rows = recorded.get('takeoffs') or []
    how = attempt.get('takeoff') or {}
    model = how.get('model')
    if not rows or not model:
        return None
    stop = attempt['ended'] if attempt['ended'] is not None else len(frames) - 1
    plans = {e.get('index'): e for f in frames[attempt['begun']:stop + 1] for e in f.get('events') or []
             if e.get('kind') == 'takeoff' and e.get('attempt') == attempt['attempt']}
    out = []
    for n, j in enumerate(rows):
        row = {'index': n, 'at': j['at'], 'status': j['status'], 'why': j.get('why'), 'mode': how.get('mode'), 'forced': bool(how.get('forced')),
               'demoX': j.get('demoX'), 'interval': j.get('interval'), 'window': j.get('window'), 'aim': j.get('aim'),
               'recordedLanding': j.get('recordedLanding')}
        out.append(row)
        plan = plans.get(n)
        outcome = next((e for f in frames[attempt['begun']:stop + 1] for e in f.get('events') or []
                        if e.get('kind') == 'takeoff-outcome' and e.get('attempt') == attempt['attempt'] and e.get('index') == n), None)
        if outcome:  # whether it took off, as the executor saw it, and where a position jump is aimed next
            row['outcome'] = {k: outcome.get(k) for k in ('tookOff', 'ms', 'aimShift', 'nextShift')}
        if plan:
            row['plan'] = {k: plan.get(k) for k in ('worked', 'why', 'leadMs', 'estX', 'observedX', 'waitedMs', 'readAgeMs', 'predicted', 'repositions', 'aimShift', 'prepMs')}
        # walking back to a jump whose safe stretch it had passed, each time from where to where
        back = [{'fromX': e.get('fromX'), 'to': e.get('to')} for f in frames[attempt['begun']:stop + 1] for e in f.get('events') or []
                if e.get('kind') == 'reposition' and e.get('attempt') == attempt['attempt'] and e.get('index') == n]
        if back:
            row['walkedBack'] = back
        # past its stretch with nothing held, where it was seen to stop before walking back
        stopped = next((e for f in frames[attempt['begun']:stop + 1] for e in f.get('events') or []
                        if e.get('kind') == 'stop-watch' and e.get('attempt') == attempt['attempt'] and e.get('index') == n), None)
        if stopped:
            row['stopWatched'] = {k: stopped.get(k) for k in ('fromX', 'stoppedX', 'ms', 'stopPx')}
        if not j.get('lines'):
            continue
        # the guard's send of its press
        sent = None
        for part in parts:
            got = {e[0]: e for e in (part['dispatch'] or {}).get('events') or []}
            for i, ((_, button, down), at) in enumerate(zip(part['sequence'], part['recorded'])):
                name = buttons[button] if isinstance(button, int) and button < len(buttons) else button
                if down and name == model.get('jumpKey') and abs(at - j['at']) < 0.6 and part['started'] is not None:
                    d = got.get(i)
                    if d and d[4] != 'failed':
                        sent = part['started'] + d[2]
                    break
        if sent is None:
            row['sent'] = False
            continue
        row['sent'] = True
        row['sentMs'] = round(elapsed(sent), 1)
        before = [r for r in readings if r[0] <= sent]
        if not before or sent - before[-1][0] > 80:
            continue
        b = before[-1]
        x = b[1] + _speed(readings, b[0]) * (sent - b[0])
        row['takeoffX'] = round(x, 1)
        if j.get('interval'):
            row['inInterval'] = j['interval'][0] <= x <= j['interval'][1]
        ground = platformer_.Ground(j['lines'])
        vx = j['dir'] * model['walk']
        # a position jump's arc isn't the model's (its keys change in the air): no landing is predicted for it
        p = None if j['status'] == 'position' else platformer_.press_landing(model, ground, 0, x, vx, vx if j['moving'] else 0.0, model['delays'][1])
        row['predicted'] = None if p is None else {'x': round(p[1], 1), 'on': 'target' if p[0] == 1 else 'start'}
        # where it came down: onto a line it was coming down to (lower than the reading before that differed)
        after = [r for r in readings if sent < r[0] <= sent + 2000]
        rose = next((r for r in after if r[0] <= sent + 300 and r[2] < b[2] - 2), None)
        if rose is None:
            row.update(landed={'on': 'no jump'}, worked=False)
            continue
        # elsewhere: at one place for STILL_MS, on neither line (the game moves the player in steps, so a reading
        # repeated in the air isn't a landing), or below them both
        landed, prev, still = None, rose[2], None
        for r in (r for r in after if r[0] > rose[0]):
            on = ground.on(r[1], r[2])
            if on and r[2] > prev:
                landed = {'x': round(r[1], 1), 'y': round(r[2], 1), 'on': 'target' if on[0] == 1 else 'start', 'ms': round(r[0] - sent, 1)}
                break
            if still is None or (r[1], r[2]) != (still[1], still[2]):
                still = r
            elif r[0] - still[0] >= STILL_MS and r[2] > rose[2]:
                landed = {'x': round(r[1], 1), 'y': round(r[2], 1), 'on': 'elsewhere', 'ms': round(still[0] - sent, 1)}
                break
            if r[2] > max(p[1] for line in j['lines'] for p in line) + 40:  # below every line it has (a rope landing has one)
                landed = {'x': round(r[1], 1), 'y': round(r[2], 1), 'on': 'fell', 'ms': round(r[0] - sent, 1)}
                break
            if r[2] != prev:
                prev = r[2]
        row['landed'] = landed
        row['worked'] = bool(landed and landed['on'] == 'target')
        if landed and row['predicted'] and landed['on'] == row['predicted']['on'] == 'target':
            row['landingErrorPx'] = round(landed['x'] - row['predicted']['x'], 1)
            # further off than the margin the safe stretch allows: the model's own quality, shown however it landed
            row['modelOff'] = abs(row['landingErrorPx']) > platformer_.LAND_MARGIN
    return out


def _execution(frames, action_id):
    """What the frames said of an action: its start, and how it ended (state, cause, error, lateness)."""
    started, last = None, None
    for f in frames:
        e = f.get('execution') or {}
        if e.get('id') == action_id:
            if started is None and isinstance(e.get('startedAt'), (int, float)) and e['startedAt'] > 0:
                started = e['startedAt']
            last = e
    return started, last


def report(head, frames, threshold_px=THRESHOLD_PX, links=None):
    """Every recorded link attempt of a trace, compared with its recording: {attempts, notes}. `links` finds a link's
    recorded details (clip, start, end, ms, trajectory) by (map id, link id) for traces that didn't keep them."""
    notes = []
    attempts, kept = _attempts(frames)
    if not kept and attempts:
        notes.append('This trace predates link events: attempts are read from the map status, and recorded links from the map as it is now.')
    dispatches = {d['id']: d for f in frames for d in f.get('dispatch') or [] if isinstance(d, dict) and 'id' in d}
    if attempts and not dispatches:
        notes.append('This trace has no per-press dispatch records (they began with this report): sent times are unknown.')
    buttons = head.get('buttons') or []
    series_cache, out = {}, []
    for a in attempts:
        if a.get('kind') == 'line-up':  # one that failed: nothing was replayed
            lu = a['lineUp']
            out.append({'attempt': a['attempt'], 'link': None, 'map': a['map'], 'kind': 'line-up', 'recorded': False, 'lineUp': lu,
                        'ended': {'worked': False, 'cause': 'line-up', 'why': lu.get('why')}})
            continue
        recorded = a.get('recorded') or (links(a['map'], a['link']) if links else None)
        if not recorded or not recorded.get('trajectory'):
            # not a recorded movement (a tree, keys or a hand-made clip), or its recording isn't known: listed with how
            # it went, nothing to compare
            out.append({'attempt': a['attempt'], 'link': a['link'], 'map': a['map'], 'kind': a.get('linkKind'), 'recorded': False, 'lineUp': a.get('lineUp'),
                        'from': a.get('from'), 'to': a.get('to'), 'position': a.get('position'), 'ended': _ended(a),
                        'ms': (a.get('end') or {}).get('ms')})
            continue
        if a['map'] not in series_cache:
            series_cache[a['map']] = _live_series(frames, a['map'])
        series, marked = series_cache[a['map']]
        parts = _parts(frames, a, dispatches)
        if not parts:
            out.append({'attempt': a['attempt'], 'link': a['link'], 'map': a['map'], 'recorded': True, 'ended': _ended(a), 'problem': 'No action was sent for it.'})
            continue
        started = parts[0]['started']
        if started is None:
            out.append({'attempt': a['attempt'], 'link': a['link'], 'map': a['map'], 'recorded': True, 'ended': _ended(a), 'problem': 'The executor never said it started.'})
            continue
        # the live clock mapped onto the recording's: from its first action's start, and from each wait's end (the
        # moment its State turned true) at the recorded time the next part starts from
        anchors = sorted((p['started'] if p['anchor'][0] is None else p['anchor'][0], p['anchor'][1]) for p in parts
                         if (p['started'] if p['anchor'][0] is None else p['anchor'][0]) is not None)

        def elapsed(t, anchors=anchors):
            """The recording's time at live time t: held at a part's end while the replay waits for the next part's
            moment, as the recording was there when its State turned true."""
            k = max([i for i, (a0, _) in enumerate(anchors) if a0 <= t], default=0)
            live0, rec0 = anchors[k]
            value = rec0 + (t - live0)
            return min(value, anchors[k + 1][1]) if k + 1 < len(anchors) else value

        execution = parts[-1]['execution']
        traj = [(float(p[0]), float(p[1]), float(p[2]), p[3] if len(p) > 3 else None) for p in recorded['trajectory']]
        # Levels: an older trace's monitor positions carry none, so the recording's are dropped to compare
        has_level = any(p[3] is not None for p in series)
        if not has_level:
            traj = [(t, x, y, None) for t, x, y, _ in traj]
        end_index = a['ended'] if a['ended'] is not None else len(frames) - 1
        end_t = frames[end_index]['t']
        if execution and isinstance(execution.get('finishedAt'), (int, float)) and execution['finishedAt'] > 0:
            end_t = max(end_t, execution['finishedAt'])
        live_all = [(elapsed(t), x, y, level, read, lag) for t, x, y, level, read, lag in series if started - 200 <= t <= end_t]
        live = [(t, x, y, level) for t, x, y, level, read, _ in live_all if read == 'fresh']
        lags = sorted(lag for *_, read, lag in live_all if read == 'fresh' and lag is not None)
        events, sent_all = [], []
        for k, part in enumerate(parts):
            sent = {e[0]: e for e in (part['dispatch'] or {}).get('events') or []}
            sent_all += sent.values()
            for i, ((_, button, down), at) in enumerate(zip(part['sequence'], part['recorded'])):
                d = sent.get(i)
                live_at = part['started'] + d[2] if d and part['started'] is not None else None
                rec = _interp(traj, at)
                got = _interp(live, at)
                if got is not None and got[3] > NEAR_MS:
                    got = None
                raw = _distance(rec[:3] if rec else None, got[:3] if got else None)
                lag, aligned = _lag(live, traj, at)
                events.append({'index': len(events), 'part': k, 'at': at, 'button': buttons[button] if isinstance(button, int) and button < len(buttons) else button,
                               'down': bool(down), 'sentMs': round(elapsed(live_at), 2) if live_at is not None else None,
                               'lateMs': round(d[2] - d[1], 2) if d else None, 'liveAt': round(live_at, 2) if live_at is not None else None,
                               'returnedMs': round(d[3], 2) if d else None, 'outcome': d[4] if d else None,
                               'recorded': _point(rec), 'live': _point(got), 'errorPx': round(raw, 1) if raw is not None else None,
                               'lagMs': lag, 'alignedErrorPx': aligned})
        last = parts[-1]['dispatch'] or execution or {}
        # The raw error at every live reading, with how far the recorded position there is from a real recorded
        # reading ([elapsed, error, recorded nearest ms]); where it first passed the threshold, and where the stretch
        # over it that the attempt ended in began (None if it ended under it), counting only readings whose recorded
        # position is within RELIABLE_MS of a real one, since a sparse recording interpolated through a jump is no path
        errors = []
        for t, x, y, level in live:
            if t < 0:
                continue
            rec = _interp(traj, t)
            d = _distance((x, y, level), rec[:3] if rec else None)
            errors.append([round(t, 1), round(d, 1) if d is not None else None, round(rec[3], 1) if rec else None])
        reliable = [(t, d) for t, d, near in errors if d is not None and near is not None and near <= RELIABLE_MS]
        diverged = next((t for t, d in reliable if d > threshold_px), None)
        onset = None
        for t, d in reliable:
            onset = (onset if onset is not None else t) if d > threshold_px else None
        finished = execution.get('finishedAt') if execution else None
        done_ms = elapsed(finished) if isinstance(finished, (int, float)) and finished > 0 else elapsed(end_t)
        first = next((e for e in events if e['errorPx'] is not None and e['errorPx'] > threshold_px
                      and e['recorded']['nearestMs'] <= RELIABLE_MS and e['live']['nearestMs'] <= RELIABLE_MS), None)
        start = _interp(live, 0.0) or (live and (live[0][1], live[0][2], live[0][3], abs(live[0][0]), True)) or None
        reads = [p[4] for p in live_all]
        fresh_times = [p[0] for p in live]
        gaps = sorted(b - a2 for a2, b in zip(fresh_times, fresh_times[1:]))
        out.append({
            'attempt': a['attempt'], 'link': a['link'], 'map': a['map'], 'clip': recorded.get('clip'), 'lineUp': a.get('lineUp'),
            'recordedStart': recorded.get('start'), 'recordedEnd': recorded.get('end'), 'recordedMs': recorded.get('ms'),
            'startOffsetPx': round(math.hypot(start[0] - recorded['start'][0], start[1] - recorded['start'][1]), 1) if start and recorded.get('start') else None,
            'actionId': parts[0]['action']['id'], 'durationMs': recorded.get('ms') or parts[0]['action'].get('durationMs'), 'startedAt': started,
            'parts': len(parts), 'syncs': _syncs(frames, a),
            'jumps': _jumps(frames, a, recorded, parts, [(t + (lag or 0.0), x, y) for t, x, y, _, read, lag in series if read == 'fresh'], buttons, elapsed),
            'unsafe': recorded.get('unsafe'), 'takeoffMode': (a.get('takeoff') or {}).get('mode'),
            'executor': {'state': last.get('state'), 'cause': last.get('cause') or None,
                         'error': last.get('error') or None, 'ranMs': round(done_ms, 1),
                         'maxLateMs': round(max((e['lateMs'] for e in events if e['lateMs'] is not None), default=execution.get('lateMs', 0) if execution else 0), 2),
                         'sent': len(sent_all), 'emitted': sum(1 for e in sent_all if e[4] == 'emitted')},
            'ended': _ended(a),
            'readings': {'fresh': reads.count('fresh'), 'reused': reads.count('reused') + reads.count('inferred-reused'),
                         'inferred': not marked, 'medianGapMs': round(gaps[len(gaps) // 2], 1) if gaps else None,
                         # how long after each frame's capture its States were read: positions are stamped with the
                         # capture time, so this is how much later than its stamp a position really is
                         'readLagMs': {'median': round(lags[len(lags) // 2], 1), 'max': round(lags[-1], 1)} if lags else None},
            'thresholdPx': threshold_px, 'reliableMs': RELIABLE_MS, 'firstOverMs': diverged, 'lastOnsetMs': onset,
            'maxErrorPx': max((d for _, d in reliable), default=None),
            'firstOverEvent': first['index'] if first else None,
            # how long inputs kept going from the onset of the divergence it ended in to the action's end
            'continuedMs': round(done_ms - onset, 1) if onset is not None else None,
            'events': events,
            'series': _thin(errors),
            # both paths, to draw: [elapsed, x, y], the recorded one from its trajectory, the live one its new readings
            'recordedPath': _thin([[round(t, 1), x, y] for t, x, y, _ in traj]),
            'livePath': _thin([[round(t, 1), x, y] for t, x, y, _ in live]),
            'recorded': True,
        })
    for a in out:
        a['outcome'] = outcome(a.get('ended'))
    return {'attempts': out, 'notes': notes, 'summary': summary(out)}
