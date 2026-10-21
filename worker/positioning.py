"""The bounded tap positioner: the player put within a tolerance of a target state with keys each way, one tap at a
time, standing still in between (docs/movement-architecture.md: a controller's positioning). Lining up with a recorded
start (behavior.Behavior._line_up) and a recorded movement's terminal correction (platformer's finish) use it.

Nothing in it is about how a game moves: how far a tap goes is read from what taps did (tap_response.TapResponse,
through the map's controller), and what limits a tap (the end of a line, a downhill), how a tap's ground is told apart
(its context) and how far off the target is, are the controller's (movement_control.Controller: bound, context,
crossing, distance, along, safe_stop, margin). The executor's services it uses are the Behavior's: play, playing,
settled, hold, now and the frame's observation time."""
from tap_response import TAP_GROWTH, TAP_MIN_MS, _stood_held

# Lining up with a recorded start by tapping (`replay.lineUp`): the first tap, how many, from how far, and the
# shortest and longest a tap may be as it adapts
LINE_UP_TAP_MS, LINE_UP_TRIES, LINE_UP_RANGE, TAP_MAX_MS = 40, 8, 48, 400
# A correction's tap is one that, at the most it could move the player, leaves it at most OVERSHOOT_SHARE as far off
# as it is now, the other side (or within the tolerance), so each tap at worst halves the error: "no further off than
# now" let a tap that mirrored it through, and the second quest's line-up swung 14, 13, 14, 13 px with four 200 ms taps
# of 27 px. A tap that overshot without halving the error caps the next at what covers what's left at its own rate,
# and two such in a row end the line-up rather than repeat it (a floor on how far a tap is expected to go refused
# good first taps: an untried length is expected to do what the nearest tried one did)
OVERSHOOT_SHARE, SWING_STOP = 0.5, 2


class TapPositioner:
    """Taps for a map (`mr`) through the executor `ex`. Its state is the caller's (`begin`), kept between frames."""

    def __init__(self, ex, mr):
        self.ex, self.mr = ex, mr

    def begin(self, x, y):
        """A tap controller's state (step), begun with the player at (x, y)."""
        ex, mr = self.ex, self.mr
        return {'tries': 0, 'tap': {a: mr.replay['lineUp']['tapMs'] for a in mr.replay['lineUp']['axes']}, 'moved': [], 'since': ex.now,
                'from': [x, y], 'taps': []}

    def step(self, s, level, x, y, tx, ty, tol):
        """One frame of the bounded tap controller putting the player within `tol` px of (tx, ty) with Line up with
        taps' keys each way, one tap at a time, standing still in between (state `s`, begin): lining up with a
        recorded start (_line_up), and a recorded movement's terminal correction. Each tap's length is
        chosen from what taps did (TapResponse: never one that, worst case, could carry the player past the target and
        `tol` beyond it, nor off the end of the ground line it stands on), else scaled from the last one's move per ms.
        {state: 'running' (text), 'done' (within tol and still), or 'failed' (why, kind: 'tap' a tap cancelled,
        'still' it didn't stand still, 'reach' it couldn't get there), off}."""
        ex, mr = self.ex, self.mr
        lu = mr.replay['lineUp']
        off = mr.control.distance(level, x, y, tx, ty)
        s['at'] = (x, y)
        tap = s.get('tapping')
        if tap is not None:
            phase = ex.play(tap, tap['line'], tap['ms'])
            if phase in ('cancelled', 'failed'):
                s.pop('tapping')
                return {'state': 'failed', 'kind': 'tap', 'why': f'a tap was {phase}', 'off': off}
            tap.setdefault('reads', []).append((ex.shared.get('observation_time', ex.now), x if s['last'][0] == 'x' else y))
            if ex.playing(tap):
                if phase is None:  # without the guard's feedback (offline), held a frame at a time
                    ex.hold({k for _, k, down in tap['line'] if down})
                return {'state': 'running', 'text': f'tap {s["tries"]}, {off:.1f} px off', 'off': off}
            s['played'] = s.pop('tapping')
        if not ex.settled(s, 'still', x, y, mr.replay['stillMs']):
            if ex.now - s.get('still', (ex.now,))[0] > mr.arrive_ms and ex.now - s['since'] > mr.arrive_ms:
                return {'state': 'failed', 'kind': 'still', 'why': 'the player didn’t stand still', 'off': off}
            return {'state': 'running', 'text': f'waiting to stand still, {off:.1f} px off', 'off': off}
        last = s.get('last')
        errors = {'x': x - tx, 'y': y - ty}
        if last is not None:  # what the last tap did, along its axis: by where the player was, not by its error (the
            # target can change between, as line-up goes on to the next start, which measured a 31 px tap as 1 px)
            axis, before, at = last
            moved = ((x if axis == 'x' else y) - at)
            s['moved'].append(abs(moved))
            t = s['taps'][-1]
            t['movedPx'] = round(moved, 1)
            blocked = _stood_held(s.pop('played', None) or {})
            if blocked:
                t['blocked'] = True  # kept as what stopped it (BLOCKED_MS), not what a tap that long does
            mr.control.note_tap(axis, t['ms'], moved, t.get('context'), blocked)
            s['last'] = None
            if s.get('target') == (tx, ty):
                after = errors[axis]
                if before * after < 0 and abs(after) > tol and abs(after) > abs(before) / 2:
                    # past the target and not half as far off: the next tap no longer than covers what's left at this
                    # one's rate; twice running, it's swinging round the target, and it stops rather than go on
                    s['swings'] = s.get('swings', 0) + 1
                    s['cap'] = (axis, t['ms'] * min(1.0, abs(after) / max(abs(moved), 0.5)) * 0.9)
                    if s['swings'] >= SWING_STOP:
                        return {'state': 'failed', 'kind': 'reach', 'off': off,
                                'why': f'its taps swing either side of the target without getting closer ({abs(before):.0f} px, then {abs(after):.0f} px the other side)'}
                else:
                    s['swings'], s['cap'] = 0, None
        if s.get('target') != (tx, ty):
            s['target'], s['swings'], s['cap'] = (tx, ty), 0, None
        if off <= tol and not mr.control.safe_stop(level, x, y, tx, ty):
            s['unsafeStop'] = True  # within the tolerance, but past the margin before a downhill: not somewhere to stop
        elif off <= tol:
            return {'state': 'done', 'off': off}
        axis = max(errors, key=lambda a: abs(errors[a]))
        if axis != 'x' and 'x' in lu['axes'] and mr.control.along(level, x, y, tx, ty, tol):
            axis = 'x'  # on a slope: moving along x is what moves it in y too
            s['along'] = True
        if axis not in lu['axes'] or s['tries'] >= lu['tries']:
            least = min((m for m in s['moved'] if m >= 0.5), default=None)
            why = (f'it’s {abs(errors[axis]):.0f} px off in {axis}, and Line up with taps has no keys for {axis}' if axis not in lu['axes']
                   else f'{off:.1f} px off after {s["tries"]} taps' + (f'; the least a tap moved it was {least:.0f} px' if least is not None else '; no tap moved it'))
            return {'state': 'failed', 'kind': 'reach', 'why': why, 'off': off}
        error = errors[axis]
        prev = ms = s['tap'][axis]
        allowed = None
        context = mr.control.context(level, x, y, -1 if error > 0 else 1) if axis == 'x' else None
        if axis == 'x' and mr.control.tap_response('x').walk:
            # with the platformer model: the tap from what taps did, no further than the target and `tol` past it, nor
            # off the end of the line the player stands on
            way = -1 if error > 0 else 1
            room, bound = mr.control.bound(level, x, y, way, beyond=tx)
            if room is not None and bound == 'end' and room < abs(error) - tol:  # the target is past the end of the line it stands on
                return {'state': 'failed', 'kind': 'reach', 'off': off,
                        'why': f'it’s {abs(error):.0f} px off, and the line it stands on ends {max(0.0, room):.0f} px that way'}
            # worst case at most OVERSHOOT_SHARE as far past the target as it is from it (or `tol`), never off the line;
            # where even the shortest tap that moves it could carry it further than that (near the game's smallest
            # step), that tap if at worst it leaves it no further off than now, as before: the swing stop catches a
            # tap that then just goes back and forth
            response = mr.control.tap_response('x', context)
            reach = abs(error) + max(tol, OVERSHOOT_SHARE * abs(error))
            least = response.shortest_moving()
            finest = response.upper(least) if least is not None else None
            if finest is not None and finest > reach:
                reach = min(finest, abs(error) + max(tol, abs(error)))
            # the line's end may be a wall (the user's quest starts against one, 0 px from its line's end), so its
            # margin never keeps it from the target, a place the player stood; past it, the line's end itself. A
            # downhill keeps its margin: a correction that went 2 px past the second quest's crest slid on down
            if room is not None and bound == 'end':
                room = max(room + mr.control.margin, abs(error))
            elif room is not None:
                room = max(room, abs(error))
            allowed = reach if room is None else min(reach, room)
            # from taps in the same context (up, down, flat), and with none yet all of them; never twice the last
            # tap in that context, so a tap up a slope isn't held back by a short one that went down it; and at the
            # most it could, what taps on every other ground it may cross say (one from up a slope onto its flat top
            # went 23 px, its slope's taps saying 21 at most), their moves measured once still, so after the slide
            # (only where a hazard, a downhill or a line's end, is what limits it: past its target on safe ground a
            # tap is only a correction to come back from, and a slope's own taps take it up the slope)
            hazard = room is not None and room <= reach
            also = [mr.control.tap_response('x', c) for c in mr.control.crossing(level, x, y, way, allowed)[1:] if c != context] if hazard else []
            cap = s['cap'][1] if s.get('cap') and s['cap'][0] == axis else None
            ms, why = response.choose(abs(error), allowed, lu['tapMs'],
                                      next((t['ms'] for t in reversed(s['taps']) if t['axis'] == axis and t.get('context') == context), None), cap, also)
            if ms is None:
                where = ' past the margin before the downhill beyond its target' if s.get('unsafeStop') else ''
                return {'state': 'failed', 'kind': 'reach', 'why': f'{off:.1f} px off{where}, and {why}', 'off': off}
        elif last is not None and last[0] == axis and not s['taps'][-1].get('context'):  # without the model: scaled from the last tap, at most twice it
            moved = s['moved'][-1]
            if moved >= 0.5:  # px per ms of the last tap, for what's left now
                ms = abs(error) / (moved / ms)
            else:
                ms *= 1.5
            ms = min(ms, TAP_GROWTH * prev)
        ms = min(TAP_MAX_MS, max(TAP_MIN_MS, ms))
        s['tap'][axis] = ms
        keys = lu['axes'][axis]['less' if error > 0 else 'more']
        self.send(s, axis, keys, ms, error, allowed, **({'context': context} if context else {}))
        return {'state': 'running', 'text': f'tap {s["tries"]} ({"+".join(keys)} {ms:.0f} ms), {off:.1f} px off', 'off': off}

    def send(self, s, axis, keys, ms, error, allowed=None, **more):
        ex = self.ex
        """A tap of the controller in `s` sent: `keys` held `ms`, measured once the player stands still again."""
        line = [[0.0, k, True] for k in keys] + [[round(ms, 1), k, False] for k in keys]
        s['tries'] += 1
        s['last'] = (axis, error, s['at'][0] if axis == 'x' else s['at'][1])
        s['taps'].append({'axis': axis, 'keys': keys, 'ms': round(ms, 1), 'errorPx': round(error, 1),
                          **({'allowedPx': round(allowed, 1)} if allowed is not None else {}), **more})
        s.pop('still', None)
        s['tapping'] = {'line': line, 'ms': round(ms, 1), 'start': ex.now}
        ex.play(s['tapping'], line, s['tapping']['ms'])
        if ex.shared.get('execution') is None:
            ex.hold(keys)
