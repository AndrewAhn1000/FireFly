"""The side-view platformer's movement controller (movement_control.Controller): the executor's questions answered by
the map's platformer model (platformer.py: its ground lines, fitted from the recordings and the map's Ground lines
State). Nothing in it is about one game: the lines are the user's State, and what moves the player is measured.

Distances are along a ground line where the target is on the one the player stands on (on a slope y follows x, and a
straight distance counts the slope's rise against it); a correction is limited by the end of the line it stands on and
by a downhill past its target; a tap's context is the grade of the ground the way it taps; a State turning true counts
on the ground line its recorded destination is on."""
import math

import platformer as platformer_
from movement_control import Controller
from positioning import LINE_UP_TAP_MS, LINE_UP_TRIES
from tap_response import SLIDE_MS, TAP_GRID, TAP_MIN_MS

# A tap's context (context()): the ground under the player the way it taps, by the platformer model's lines: 'flat'
# under TAP_GRADE px per px along, else 'up' or 'down' and 'gentle' or, from TAP_STEEP (45°), 'steep'. On the user's
# slope (67 px in 55) the same tap length moved the player 17 px down it and 1 px up it, and a 120 ms tap chosen from
# taps up that slope moved it 18 px up an 11 px bump of 0.73 beside it: so what a tap does is kept by context and a tap
# chosen from taps in the same one. Nothing in it says how a game moves on a slope: that's read off the taps
TAP_GRADE, TAP_STEEP = 0.2, 1.0
# Adaptive takeoff (`replay.takeoff`, platformer.py): a jump's press is sent once it's due within this long, or within
# one and a half frames (whichever is longer), so it's decided once, from the frame before it, and never moved again
TAKEOFF_HORIZON_MS = 40
VELOCITY_MS = 150  # the player's speed from its readings over this long
# A moving jump the player has already passed the safe stretch of: it walks back this far behind where it aims (on the
# line it jumps from), and comes at it again, up to REPOSITIONS times, each giving its wait REPOSITION_MS more
RUNUP_PX, RUNUP_MIN_PX, REPOSITIONS, REPOSITION_MS = 32, 12, 2, 2500
# Past a moving jump's safe stretch, too near the edge by the stopping distance to walk back, with nothing held that
# moves the player: how far it slides on isn't known (the stopping distance is the most a tap ever slid on, after
# walking), so it's watched for up to this long, and walked back from where it stops, if that's still on its line. The
# user's first jump quest's last movement landed 1 px from its late limit with nothing held, was refused for a 7 px
# stopping distance, and stopped within 1 px
STOP_WATCH_MS = 400
# A position jump (keys changing in the air) is pressed within this of where the recording pressed it (its takeoff
# region: half the platformer model's executable stretch, a game step either way), never past the latest safe press:
# kept at its recorded delay after what its part began on, it was pressed wherever the jump before had landed, and the
# user's last movement's jump 4 missed its ledge pressed 11.9 px short (4.6–7.6 px short made it)
TAKEOFF_REGION_PX = platformer_.EXEC_PX / 2
# Whether a jump pressed by position took off: risen RISE_PX within NO_JUMP_MS of the press, or not. A position jump
# that didn't is aimed SHIFT_STEP px further from the edge each time, up to SHIFT_MAX (kept with the map's stats)
RISE_PX, NO_JUMP_MS, SHIFT_STEP, SHIFT_MAX = 3, 300, 2.0, 10.0
# The least a movement's own start tolerance is narrowed to (_start_tol): its start itself, to the reading
START_TOL_MIN_PX = 0.5


def settings(r):
    """Its settings in a map's `replay`: jumps timed as recorded (the baseline), or each simple jump's press timed by
    where the player is ('adaptive'), with the State whose lines are the ground (also what Runs measure jumps by)."""
    return {'takeoff': 'adaptive' if r.get('takeoff') == 'adaptive' else 'timed',
            'ground': r['ground'].strip() if isinstance(r.get('ground'), str) and r['ground'].strip() else None}


def load(doc):
    """A map's platformer model as its analysis wrote it (`platformer`: {model, grounds: [[level, lines]]}), its lines
    made Grounds: {model, grounds: {level: Ground}}, or None when it has none (or its fit failed)."""
    pf = doc.get('platformer') or {}
    model = pf.get('model') if isinstance(pf.get('model'), dict) and not pf['model'].get('error') else None
    return {'model': model, 'grounds': {lv: platformer_.Ground(lines) for lv, lines in pf.get('grounds') or []}} if model else None


class PlatformerController(Controller):
    """A map's movement decisions by its platformer model's ground lines (MapRun.dynamics)."""

    margin = platformer_.EDGE_PX
    ANNOTATIONS = ('takeoffs', 'unsafe')

    def walk(self):
        return (((self.mr.dynamics or {}).get('model')) or {}).get('walk')

    @property
    def adaptive(self):
        """Press jumps set to adaptive: its triggers and terminal correction are in use (else the movements' jumps are
        timed as recorded, the baseline)."""
        return self.mr.replay['takeoff'] == 'adaptive' and self.mr.dynamics is not None

    def keys(self):
        """Adaptive takeoff walks back to a jump it has passed with the keys each way its model measured."""
        if not self.adaptive:
            return set()
        model = self.mr.dynamics['model']
        return {k for k in (model.get('leftKey'), model.get('rightKey')) if k}

    def unsafe(self):
        """With adaptive takeoff, the recorded movements with a jump it can't press safely: {link id: why}."""
        return {lid: l['unsafe'] for lid, l in self.mr.links.items() if l.get('unsafe')} if self.adaptive else {}

    def triggers(self, link, forced=False):
        """With adaptive takeoff, a jump's press, sent once the player is where it's safe to press it ('takeoff':
        `jump`, its platformer.jumps row; `index`, which of the movement's jumps): jumps the model knows and can press
        safely ('adapt', 'position'), and with `forced` those it can't ('unsafe', 'narrow'), at the most robust place it
        found. One at a wait's moment replaces the wait: it waits for its place, on the line it jumps from."""
        out = []
        if self.adaptive:
            as_played = self.completion(link) is not None  # its trailing nudge left out (played)
            for n, j in enumerate(link.get('takeoffs') or []):
                if j.get('asPlayed') and not as_played:
                    continue  # judged without presses that are played here: as recorded
                if j.get('aim') is not None and j.get('window') and 0 < j['at'] < link.get('ms', math.inf) and (
                        j['status'] in ('adapt', 'position') or (forced and j['status'] in ('unsafe', 'narrow'))):
                    out.append({'at': j['at'], 'kind': 'takeoff', 'jump': j, 'index': n})
        return out

    def played(self, link, clip):
        """A recorded movement's keys as played. With adaptive takeoff, a jump key the analysis found did nothing (a
        `walkoff`: pressed in the air after the player walked off the edge) is left out, with its let-go: played at its
        recorded time it could reach the game while the player, a little later to the edge than recorded, is still on
        the ground, and jump where the recording fell (it did at the user's (-1907, -1054)). So are the trailing
        positioning presses of one with a terminal correction (`finish.drop`, completion): what they did depended on
        when the game took them about the landing, so the correction puts the player on its end instead. The recording
        keeps them."""
        mr = self.mr
        jump = ((mr.dynamics or {}).get('model') or {}).get('jumpKey') if self.adaptive else None
        drops = [(j['at'], jump) for j in link.get('takeoffs') or [] if j.get('status') == 'walkoff'] if jump else []
        fin = self.completion(link)
        drops += [(at, key) for at, key in fin['drop']] if fin else []
        if not drops:
            return clip
        line, skip = clip['timeline'], set()
        for n, (at, k, down) in enumerate(line):
            if down and any(k == key and abs(at - t) < 0.6 for t, key in drops):
                skip.add(n)
                up = next((m for m in range(n + 1, len(line)) if line[m][1] == k and not line[m][2]), None)
                if up is not None:
                    skip.add(up)
        return {**clip, 'timeline': [e for n, e in enumerate(line) if n not in skip]} if skip else clip

    def completion(self, link):
        """A recorded movement's terminal correction (its `finish`, platformer.finish), when the map does them: adaptive
        takeoff (so timed replay stays the baseline, without one) with Line up with taps along x, and an ending the
        analysis found correctable. None otherwise."""
        f = link.get('finish') if link.get('recorded') and self.adaptive else None
        lu = self.mr.replay['lineUp']
        return f if f and f.get('status') == 'correct' and lu and 'x' in lu['axes'] else None

    def complete(self, ex, st, link, fin, level, x, y, t):
        """A recorded movement's terminal correction (`fin`, completion), once it has played: a feedback phase that puts
        the player on its recorded end (Arrive within), in place of the trailing positioning presses the analysis left
        out (_played). It begins only once the player has landed for the last time where the end is safely reachable:
        on the ground (the map's Wait for, if it has one), on the ground line its recorded end is on (so getting there
        crosses no edge), within Line up with taps' range of it, and standing still. Then the bounded tap controller
        (positioning.TapPositioner) taps it there, as lining up with a start is, never past the end of its line; and if the presses left
        out had faced it the way the recording ended, and its last tap didn't, a tap that way that can't carry it out of
        Arrive within faces it so (else it's said not to be). None while it hasn't landed there (the usual arrival
        applies; it never begins on another platform); else {running: text}, {fail: why} or {done: arrival}. How it arrived ('direct':
        no tap needed; 'corrected') goes with the attempt's end, and the correction in a `finish` event."""
        mr = self.mr
        lu, tol = mr.replay['lineUp'], mr.replay['arrivePx']
        tx, ty = link['end'][0] + (st.get('shiftX') or 0.0), link['end'][1]
        ground = self._ground(level)
        here = ground.on(x, y) if ground else None
        there = ground.on(tx, ty) if ground else None
        on_line = here is not None and there is not None and here[0] == there[0] and level == mr.places[link['to']].get('level')
        s = st.get('finish')
        to = mr.name(link['to'])
        off = self.distance(level, x, y, tx, ty)
        if s is None:
            grounded = ex.sync(mr) if mr.replay['sync'] else True
            if not on_line or grounded is not True or off > lu['range']:
                return None
            s = st['finish'] = {**self.positioner(ex).begin(x, y), 'begun': round(t, 1)}

        def said(worked, arrival=None, why=None, faced=None):
            pos = [tp for tp in s['taps'] if not tp.get('facing')]
            ex.say('finish', st, **{
                'map': mr.id, 'link': st['link'], 'target': [tx, ty], 'from': s['from'], 'to': [x, y],
                'offPx': round(off, 1), 'taps': s['taps'], 'corrections': len(pos), 'worked': worked, 'beganMs': s['begun'],
                'ms': round(ex.now - s['since'], 1), 'dropped': fin['drop'], **({'arrival': arrival} if arrival else {}), **({'why': why} if why else {}),
                **({'facing': faced} if faced else {}), **({'alongLine': True} if s.get('along') else {})})
        if not on_line and not s.get('tapping'):
            why = 'it left the line its end is on'
            said(False, why=why)
            return {'fail': f'correcting its end: {why}'}
        if ex.now - s['since'] > mr.arrive_ms + lu['tries'] * 500:
            why = f'not within {tol:g} px of its end after {(ex.now - s["since"]) / 1000:.1f} s'
            said(False, why=why)
            return {'fail': f'correcting its end: {why}'}
        r = self.positioner(ex).step(s, level, x, y, tx, ty, tol)
        if r['state'] == 'running':
            return {'running': f'putting the player on its end at {to}: {r["text"]}'}
        if r['state'] == 'failed':
            said(False, why=r['why'])
            return {'fail': f'it landed on its platform {off:.0f} px from its end and couldn’t be put there: {r["why"]}'}
        faced = None
        if fin.get('restore'):
            more, less = lu['axes']['x']['more'], lu['axes']['x']['less']
            way = 1 if fin['restore'] in more else -1 if fin['restore'] in less else 0
            xs = [tp for tp in s['taps'] if tp['axis'] == 'x']
            last = (1 if xs[-1]['keys'][0] in more else -1) if xs else None
            if way and last != way and not s.get('faced'):
                # how far it may go that way and still be within Arrive within (and short of its line's end)
                allowed = tol - (x - tx) * way
                room, bound = self.bound(level, x, y, way, beyond=tx)
                if room is not None:
                    allowed = min(allowed, room + (platformer_.EDGE_PX if bound == 'end' else 0.0))
                context = self.context(level, x, y, way)
                ms = self._facing_tap(allowed, context)
                if ms is not None:
                    s['faced'] = True
                    keys = more if way > 0 else less
                    self.positioner(ex).send(s, 'x', keys, ms, x - tx, allowed, facing=True, **({'context': context} if context else {}))
                    return {'running': f'putting the player on its end at {to}: facing {fin["restore"]} as recorded ({ms:.0f} ms)'}
                s['faced'] = f'no tap that way is short enough to keep it within {tol:g} px of its end'
            # kept only on evidence the game took a press that way last: the tap moved the player that way (a tap
            # that didn't move it may not have reached the game at all; None: not known)
            took = bool(xs) and last == way and (xs[-1].get('movedPx') or 0.0) * way >= 0.5
            faced = {'recorded': fin['restore'], 'kept': True if took else None if bool(way) and last == way else False}
            if faced['kept'] is None:
                faced['why'] = f'a {xs[-1]["ms"]:.0f} ms tap that way was sent but didn’t move the player, so whether the game took it isn’t known'
            elif faced['kept'] is False:
                faced['why'] = (s['faced'] if isinstance(s.get('faced'), str) else 'putting it back within Arrive within after facing it turned it'
                                if s.get('faced') else 'Line up with taps has no keys for it')
        arrival = 'corrected' if any(not tp.get('facing') for tp in s['taps']) else 'direct'
        said(True, arrival, faced=faced)
        return {'done': arrival}

    def _facing_tap(self, allowed, context=None):
        """A tap along x to face the player a way, moving it at most `allowed` px: the shortest that has moved it (it
        took it), else the longest that can't move it further and is longer than any that didn't move it; None. By
        taps in its `context` when there are any."""
        r = self.tap_response('x', context)
        moving = r.shortest_moving()
        if moving is not None and (u := r.upper(moving)) is not None and u <= allowed:
            return max(moving, TAP_MIN_MS)
        safe = [ms for ms in TAP_GRID if (u := r.upper(ms)) is not None and u <= allowed]
        return max(safe) if safe and max(safe) > r.longest_still() else None

    def start(self, link, level, bounds):
        """From its recorded start, or with adaptive takeoff further along for an opening standing jump (_start_for);
        within the map's Start within, narrowed by where a walk comes to rest (_start_tol); and from its start region
        (platformer.start_region) where what absorbs the difference is in use (_in_start_region)."""
        sx, sy = self._start_for(link, level, bounds)
        own = (sx, sy) == tuple(link['start'])
        r = link.get('startRegion') if own else None
        return {'at': (sx, sy), 'tol': self._start_tol(link, level) if own else self.mr.replay['startPx'],
                'region': {'region': [r['lo'], r['hi']], 'why': r['why']} if r else None, 'link': link}

    def admits(self, start, level, x, y):
        return self._in_start_region(start['link'], level, x, y)

    def attempt_info(self, link, forced=False):
        """How its jumps are pressed, and the model they're measured by (`takeoff`: mode, model, forced, and jump keys
        left out as played, ones that did nothing in the recording, `dropped`), and its terminal correction (`finish`:
        the trailing presses left out for it, and the way it faced)."""
        mr = self.mr
        out = {'takeoff': {'mode': mr.replay['takeoff'], 'model': mr.dynamics['model'], 'forced': bool(forced)}}
        dropped = [j['at'] for j in link.get('takeoffs') or [] if j.get('status') == 'walkoff'] if self.adaptive else []
        if dropped:
            out['takeoff']['dropped'] = dropped
        fin = self.completion(link)
        if fin:
            out['finish'] = {k: fin.get(k) for k in ('at', 'drop', 'facing', 'restore', 'movedPx')}
        return out

    def _start_for(self, link, level, bounds):
        """Where a recorded movement starts from. With adaptive takeoff, a movement that opens with a standing jump
        whose run-up (keys held from the start into the jump) would, from the recorded start, take off outside its
        safe stretch starts that much further along instead, toward its aim: lined up before the movement begins, so
        nothing held into the jump is ever let go of to move the player (on the user's movement 12, letting go of
        the right held 37 ms before the jump to tap into its stretch made the jump start from a standstill, short)."""
        mr = self.mr
        sx, sy = link['start']
        bounds = bounds if self.adaptive else []
        j = bounds[0]['jump'] if bounds and bounds[0]['kind'] == 'takeoff' else None
        if j is None or j['moving'] or not j.get('window') or j['window'][0] <= j['demoX'] <= j['window'][1]:
            return sx, sy
        nx = sx + (j['aim'] - j['demoX'])
        ground = mr.dynamics['grounds'].get(level)
        ny = ground.y_on(j['start'], nx) if ground and j.get('start') is not None and j['start'] < len(ground.lines) else None
        return nx, (sy if ny is None else ny + (sy - (ground.y_on(j['start'], sx) or sy)))

    def _start_tol(self, link, level):
        """How close to a recorded movement's start it must begin: the map's Start within, or less where the movement
        model says a start that far on carries it onto ground it can't stop on (its start region's `aheadPx`, at least
        START_TOL_MIN_PX)."""
        mr = self.mr
        tol = mr.replay['startPx']
        r = link.get('startRegion')
        if r and r.get('aheadPx') is not None and r.get('level') == level and r['aheadPx'] < tol:
            return max(START_TOL_MIN_PX, r['aheadPx'])
        return tol

    def _in_start_region(self, link, level, x, y):
        """Whether the player may begin a recorded movement where it is, off its recorded start, by the movement's own
        start region (platformer.start_region): on its line within it, and only where what absorbs the difference is in
        use (a jump pressed by position needs adaptive takeoff; a walk, its end correction)."""
        mr = self.mr
        r = link.get('startRegion')
        if not r or level != r.get('level') or not mr.dynamics:
            return False
        if r['kind'] == 'jump' and not self.adaptive or r['kind'] == 'walk' and self.completion(link) is None:
            return False
        ground = mr.dynamics['grounds'].get(level)
        on = ground.on(x, y) if ground else None
        return on is not None and on[0] == r['line'] and r['lo'] <= x <= r['hi']

    # ── adaptive takeoff: a jump's part sent once the player is where it's safe to press it ──
    STATE = ('readings', 'lastSeen', 'frameGap', 'watch', 'stopWatch')

    def frame(self, ex, st, level, x, y):
        """Every frame of a movement in parts: its readings (for its speed, _seen) and whether the jump last pressed by
        position took off (_watch_takeoff)."""
        self._seen(ex, st, x)
        self._watch_takeoff(ex, st, y)

    def ending(self, ex, st, seen):
        """The movement is ending: a jump pressed long enough ago that hasn't risen didn't take off."""
        self._watch_takeoff(ex, st, seen[1], ending=True)

    def extra_ms(self, st):
        """How much longer its wait for a takeoff may run: walking back to it, tapping into its stretch, watching it
        stop."""
        return ((st.get('repo') or {}).get('extraMs', 0), (st.get('standRepo') or {}).get('extraMs', 0), STOP_WATCH_MS if st.get('stopWatch') else 0)

    def next_part(self, st):
        st.update(takeoffWait=None, repo=None, standRepo=None, stopWatch=None)

    def trigger(self, ex, st, seg, trigger, level, x, y, overdue, span):
        """A takeoff (triggers): {wait} while the player isn't where it's pressed yet (walking back to it, the way
        forward let go of and the way back held; tapping into a standing jump's stretch, nothing else held), {fail}
        once it can't be (or `overdue`), else {lead, offset}: its press `lead` ms on, the path from there `offset` px
        aside along x from where it was recorded. Said in the trace (`takeoff`)."""
        j = trigger['jump']
        go = self._takeoff(ex, st, trigger, level, x, y)
        repo = st.get('repo')
        if go is None and repo and repo['phase'] == 'back':  # walking back: the way forward let go of, the way back held
            ex.release({repo['forward']})
            ex.hold({repo['back']})
        if go is None and st.get('standRepo'):  # tapping into a standing jump's stretch: nothing else held
            tapping = st['standRepo'].get('tapping')
            ex.release(set(seg['keep']) - ({k for _, k, d in tapping['line'] if d} if tapping else set()))
        if go is None and overdue:
            go = {'fail': f'it didn’t get to where jump {trigger["index"] + 1} is pressed from in {ex.now - st["segStart"]:.0f} ms (it did in {span:.0f} ms in the recording)'
                  + (f': {st["takeoffWait"]}' if st.get('takeoffWait') else '')}
        if go is None:
            return {'wait': st.get("takeoffWait") or "going to where it jumps"}
        if 'fail' in go:
            ex.say('takeoff', st, index=trigger['index'], at=trigger['at'], worked=False, why=go['fail'], status=j['status'],
                   window=j['window'], aim=j['aim'], demoX=j['demoX'], observedX=round(x, 1))
            return {'fail': go['fail']}
        lead = go['lead']
        offset = go['estX'] - j['demoX']
        st['watch'] = {'index': trigger['index'], 'pressAt': ex.now + lead, 'y0': y, 'position': j['status'] == 'position', 'shift': go.get('shift', 0.0)}
        ex.say('takeoff', st, index=trigger['index'], at=trigger['at'], worked=True, status=j['status'], forced=j['status'] != 'adapt',
               repositions=(st.get('repo') or {}).get('n', 0),
               window=j['window'], aim=j['aim'], demoX=j['demoX'], estX=round(go['estX'], 1), observedX=round(x, 1),
               leadMs=round(lead, 1), pressAt=round(ex.now + lead, 1), readAgeMs=round(go['readAge'], 1), aimShift=go.get('shift', 0.0),
               speed=round(go['speed'], 4), predicted=go['predicted'], waitedMs=round(ex.now - st['waiting'], 1),
               **({'prepMs': go['prepMs']} if go.get('prepMs') is not None else {}))
        return {'lead': lead, 'offset': offset}

    def jump_shift(self, lid, index):
        """How far further from its edge a position jump of a link is aimed, from how often it didn't take off."""
        return float((((self.mr.stats.get(lid) or {}).get('jumps') or {}).get(str(index)) or {}).get('shift', 0.0))

    def learn_jump(self, lid, index, took_off, position):
        """A jump of a link pressed by where the player was: whether it took off. A position jump that didn't is aimed
        SHIFT_STEP further in from then on (up to SHIFT_MAX); its tries and how many didn't are kept either way."""
        js = self.mr.stats.setdefault(lid, {'runs': 0, 'fails': 0}).setdefault('jumps', {}).setdefault(str(index), {'tries': 0, 'noJump': 0, 'shift': 0.0})
        js['tries'] += 1
        if not took_off:
            js['noJump'] += 1
            if position:
                js['shift'] = min(SHIFT_MAX, js.get('shift', 0.0) + SHIFT_STEP)
        self.mr.changed = True

    def _takeoff(self, ex, st, trigger, level, x, y):
        """Whether to send a jump's part now (adaptive takeoff): None to wait (why in st['takeoffWait']), {fail} when
        it can't be pressed safely any more, else {lead, estX, readAge, speed, predicted}: send it now, its press `lead`
        ms on, when the player will be at estX. Standing, it's pressed if the player is within its safe
        stretch (`window`), as long after its part began as it was in the recording, else fails. Moving, it's pressed where it's aimed (`aim`): once the player, at walking speed
        from its last reading, gets there within TAKEOFF_HORIZON_MS or 1.5 frames, decided once; past the aim but still
        in the window, at once; past the window, it fails. Only on the line it jumps from, and with the map's Wait for
        not false (a press in the air does nothing)."""
        mr = self.mr
        j = trigger['jump']
        model = mr.dynamics['model']
        ground = mr.dynamics['grounds'].get(level)
        shift = 0.0  # complex maneuvers keep their recorded timing; prior misses must not advance their press
        if shift:  # it didn't take off from where it was aimed before: further in from the edge
            back = -j['dir'] * shift
            lo_w, hi_w = j['window']
            j = {**j, 'aim': j['aim'] + back, 'window': [lo_w, hi_w + back] if j['dir'] > 0 else [lo_w + back, hi_w]}
        if ground is None or j.get('start') is None or j['start'] >= len(ground.lines):
            return {'fail': 'no ground lines on this level to place its jump on'}
        on = ground.on(x, y)
        repo = st.get('repo')
        if on is None or on[0] != j['start']:
            lo_s, hi_s = ground.ends(j['start'])
            ly = ground.y_on(j['start'], min(hi_s, max(lo_s, x)))
            text = f'the player, at ({x:.0f}, {y:.0f}), isn’t on the line it jumps from ({lo_s:.0f}..{hi_s:.0f} at {ly:.0f})'
            if repo and repo['phase'] == 'back':  # it left the line walking back: stopped at once, nothing held
                return {'fail': f'{text}: it left it walking back to come at the jump again'}
            if st.get('stopWatch'):  # past its stretch with nothing held, it slid off the line rather than stopping
                return {'fail': f'{text}: past its safe stretch with nothing held, it went off the line before it stopped'}
            if on is not None and ly is not None and y > ly + platformer_.ON_PX:
                return {'fail': f'{text}: it’s on a line below it'}  # it fell: waiting won't bring it back up
            st['takeoffWait'] = f'waiting: {text}'
            return None
        if mr.replay['sync'] and ex.sync(mr) is False:
            st['takeoffWait'] = f'waiting for {mr.replay["sync"]}'
            return None
        lo, hi = j['window']
        d, walk = j['dir'], model['walk']
        vx = d * walk
        gvx = vx if j['moving'] else 0.0
        mid = model['delays'][1]
        seen = st.get('readings') or [(ex.shared['observation_time'], x)]
        t_read = seen[-1][0]
        span = seen[-1][0] - seen[0][0]
        speed = (seen[-1][1] - seen[0][1]) / span if span >= 20 else 0.0
        where = f'its safe stretch {lo:.0f}..{hi:.0f}'

        def go(lead, est, prep=None):
            p = platformer_.press_landing(model, ground, j['start'], est, vx, gvx, mid)
            return {'lead': lead, 'estX': est, 'readAge': ex.now - t_read, 'speed': speed, 'shift': shift, 'prepMs': prep,
                    'predicted': [p[0], round(p[1], 1)] if p and j['status'] != 'position' else None}
        keep = st['segs'][st['seg']]['keep'] if st.get('segs') else st.get('keep') or []  # the keys held through the wait
        held = set(keep) & {model.get('leftKey'), model.get('rightKey')} - {None}
        if not j['moving'] and held:
            # standing, but with a key held into the jump that moves the player (a run-up): never let go of to move
            # it; it takes off where the run-up as recorded carries it, which must be within the stretch
            live0, rec0 = st.get('anchor') or (None, 0.0)
            start0 = st.get('segStart', ex.now) if live0 is None else live0
            due = start0 + (trigger['at'] - rec0)
            x_due = x + self._recorded_dx(mr.links[st['link']], min(trigger['at'], rec0 + (ex.now - start0)), trigger['at'])
            way = 1 if model.get('rightKey') in held else -1
            far = hi if way > 0 else lo
            if (x_due - far) * way > 0:
                # its run-up as recorded would carry it past the stretch: pressed earlier, as the player gets near the
                # far side, the key still held (never later than recorded, which a "standing" jump is judged nearest
                # to): INSET_PX inside it, and no nearer the end of the line it runs along than the latest a press is
                # safe from (the run-up's walking while the game takes the press). The new map's jump 9, landing 7 px
                # further on than recorded, would have taken off 1-2 px past its stretch and was refused, 3 runs of 4
                lo_s, hi_s = ground.ends(j['start'])
                late = platformer_.EDGE_PX + model['walk'] * max(0.0, model['delays'][-1])
                edge = (hi_s - late) if way > 0 else (lo_s + late)
                aim = far - way * platformer_.INSET_PX
                aim = min(aim, edge) if way > 0 else max(aim, edge)
                pressed = [e[0] for n, e in enumerate(st['segs'][st['seg']]['line']) if n >= st['segs'][st['seg']]['held'] and e[2] and e[1] in held] if st.get('segs') else []
                since = max(t_read, st.get('segStart', ex.now) + pressed[-1]) if pressed else t_read
                now_x = x + way * model['walk'] * max(0.0, ex.now - since)  # walking at full speed: at worst ahead of it
                if (now_x - far) * way > 0 or (aim - (lo if way > 0 else hi)) * way < 0:
                    return {'fail': f'with its run-up as recorded it would take off at about {x_due:.0f}, outside {where}, and it’s too near its far side to press it earlier ({now_x:.0f}); a key held into a jump isn’t let go of to move the player'}
                lead = max(0.0, min((aim - now_x) * way / model['walk'], due - ex.now))
                if lead <= max(TAKEOFF_HORIZON_MS, 1.5 * (st.get('frameGap') or 0.0)):
                    return go(lead, now_x + way * model['walk'] * lead)
                st['takeoffWait'] = f'its run-up as recorded would carry it past {where}: pressing at {aim:.0f}, {(aim - now_x) * way:.0f} px on'
                return None
            if not lo <= x_due <= hi:
                return {'fail': f'with its run-up as recorded it would take off at about {x_due:.0f}, outside {where}; a key held into a jump isn’t let go of to move the player'}
            lead = max(0.0, due - ex.now)
            if lead <= max(TAKEOFF_HORIZON_MS, 1.5 * (st.get('frameGap') or 0.0)):
                return go(lead, x_due)
            st['takeoffWait'] = f'running up into its stretch, jumping {lead:.0f} ms on as recorded'
            return None
        if not j['moving']:
            # standing, when it's pressed doesn't move where it's pressed from: as long after its part began (the
            # moment a Wait for turned true, say) as in the recording, if the player is within the stretch; else,
            # with nothing held, tapped into it first
            if not lo <= x <= hi:
                into = self._stand_into(ex, st, j, level, x, y, where)
                if into is not None:
                    return into
                st['takeoffWait'] = st['standRepo']['text']
                return None
            if st.get('standRepo'):
                r = st['standRepo']
                tap = r.get('tapping')
                if tap is not None:  # the tap that carried it in: over once it's played (it used to be waited on for ever)
                    phase = ex.play(tap, tap['line'], tap['ms'])
                    if phase in ('cancelled', 'failed'):
                        return {'fail': f'a tap into {where} was {phase}'}
                    if ex.playing(tap):
                        st['takeoffWait'] = 'tapped into its stretch: waiting for the tap to end'
                        return None
                    r.pop('tapping')
                if not ex.settled(r, 'still', x, y, mr.replay['stillMs']):
                    st['takeoffWait'] = 'tapped into its stretch: waiting to stand still'
                    return None
                if r.get('before') is not None:
                    r['taps'][-1]['movedPx'] = round(x - r['before'], 1)
                    self.note_tap('x', r['taps'][-1]['ms'], x - r['before'], r['taps'][-1].get('context'))
                    r['before'] = None
                ex.say('stand-reposition', st, index=trigger['index'], worked=True, fromX=st['standRepo']['from'], toX=round(x, 1), taps=st['standRepo']['taps'])
                st['standRepo'] = None
            live0, rec0 = st.get('anchor') or (None, 0.0)
            due = (st.get('segStart', ex.now) if live0 is None else live0) + (trigger['at'] - rec0)
            lead = max(0.0, due - ex.now)
            if lead <= max(TAKEOFF_HORIZON_MS, 1.5 * (st.get('frameGap') or 0.0)):
                return go(lead, x)
            st['takeoffWait'] = f'standing within {where}, jumping {lead:.0f} ms on as recorded'
            return None
        moving = speed * d >= platformer_.MOVING * walk
        # the key forward held (through the wait): it walks at walking speed (a turn's readings lag that), from when
        # it went down if the part before the jump pressed it (it may be going down in this very update, _play_parts)
        fwd = model.get('rightKey') if d > 0 else model.get('leftKey')
        forward = fwd in held
        seg = st['segs'][st['seg']] if st.get('segs') else None
        pressed = [e[0] for n, e in enumerate(seg['line']) if n >= seg['held'] and e[1] == fwd and e[2]] if seg and forward else []
        since = max(t_read, st.get('segStart', ex.now) + pressed[-1]) if pressed and not moving else t_read
        now_x = x + (vx if moving or forward else 0.0) * max(0.0, ex.now - since)  # turning, at worst ahead of where it is
        if repo and repo['phase'] == 'back':
            if (x - repo['to']) * d > 0:
                st['takeoffWait'] = f'walking back to {repo["to"]:.0f} to come at where it jumps again ({x:.0f} now)'
                return None
            repo['phase'] = 'forward'  # back far enough: walk at it again
        horizon = max(TAKEOFF_HORIZON_MS, 1.5 * (st.get('frameGap') or 0.0))
        if j['status'] == 'position' and not ((now_x > hi) if d > 0 else (now_x < lo)):
            # Its keys in the air aren't the model's to predict, so it keeps its recorded run-up and its delay from
            # what its part began on (a landing): pressed when the recording pressed it. Only where that would carry
            # the player past the latest press the model rates safe is it pressed earlier, when the player gets there:
            # no earlier than safety needs (the user's first movement recorded its press 2.7 px past that, and refusing
            # it there failed every run). Short of the window at its recorded time, it waits for the player to be in
            # it, pressing later, never sooner.
            live0, rec0 = st.get('anchor') or (None, 0.0)
            start0 = st.get('segStart', ex.now) if live0 is None else live0
            due = start0 + trigger['at'] - rec0
            x_due = x + self._recorded_dx(mr.links[st['link']], min(trigger['at'], rec0 + t_read - start0), trigger['at'])
            late, early = (hi, lo) if d > 0 else (lo, hi)
            if (x_due - late) * d > 0:
                ahead = (late - now_x) * d
                if ahead <= 0:
                    return go(0.0, now_x)
                if not (moving or forward):
                    st['takeoffWait'] = f'waiting to walk toward {late:.0f}, the latest a press is safe from'
                    return None
                lead = min(ahead / walk, max(0.0, due - ex.now))
                if lead <= horizon:
                    return go(lead, now_x + vx * lead)
                st['takeoffWait'] = f'as recorded it would jump past {late:.0f}: pressing there, {ahead:.0f} px on'
                return None
            if (x_due - early) * d < 0:
                ahead = (early - now_x) * d
                if ahead <= 0:
                    return go(0.0, now_x)
                if not (moving or forward) or ahead / walk > horizon:
                    st['takeoffWait'] = f'short of {where} at its recorded time: waiting to be in it, {ahead:.0f} px on'
                    return None
                return go(ahead / walk, early)
            # its takeoff region: within TAKEOFF_REGION_PX of where it was pressed, never past the latest safe press.
            # Short of it at its recorded time, it waits to get there (pressing later, never sooner than recorded),
            # the key forward held; the latest safe press still stops it short of the edge (past it, above)
            near = j['demoX'] - d * TAKEOFF_REGION_PX
            if (late - near) * d < 0:
                near = late
            if (x_due - near) * d < 0:
                ahead = (near - now_x) * d
                if not (moving or forward):
                    st['takeoffWait'] = f'short of where it was pressed ({j["demoX"]:.0f}) at its recorded time, and not walking toward it'
                    return None
                lead = max(0.0, due - ex.now, ahead / walk)
                if lead <= horizon:
                    return go(lead, now_x + vx * lead)
                st['takeoffWait'] = f'short of where it was pressed ({j["demoX"]:.0f}) at its recorded time: pressing within {TAKEOFF_REGION_PX:g} px of it, {max(0.0, ahead):.0f} px on'
                return None
            lead = max(0.0, due - ex.now)
            if lead <= horizon:
                return go(lead, x_due)
            st['takeoffWait'] = f'keeping its recorded run-up, jumping {lead:.0f} ms on'
            return None
        if (now_x > hi) if d > 0 else (now_x < lo):
            # past the latest a press is safe from: walk back behind the aim and come at it again, if it can stop
            # before the edge (its stopping distance, and how far it went since its reading); else it has failed
            lo_s, hi_s = ground.ends(j['start'])
            room = ((hi_s - platformer_.EDGE_PX) - now_x) if d > 0 else (now_x - (lo_s + platformer_.EDGE_PX))
            stop = self._stopping() + (abs(speed) * (ex.now - t_read) if moving else 0.0)
            if room <= stop and not held and not repo:
                # nothing held moves it, and the stopping distance (what a tap slid at most, after walking) isn't
                # what it slides after a landing: where it stops is watched (STOP_WATCH_MS), on its line and on the
                # ground (above), and it's walked back from there if that leaves it short of the edge
                w = st.get('stopWatch')
                if w is None:
                    w = st['stopWatch'] = {'since': ex.now, 'fromX': round(x, 1), 'stopPx': round(stop, 1)}
                if not ex.settled(w, 'still', x, y, mr.replay['stillMs']):
                    if ex.now - w['since'] > STOP_WATCH_MS:
                        return {'fail': f'past {where} at about {x:.0f} with nothing held, and it hadn’t stopped {STOP_WATCH_MS} ms on'}
                    st['takeoffWait'] = f'past {where} with nothing held, {max(0.0, room):.1f} px from the edge: watching where it stops ({x:.0f} now)'
                    return None
                room = ((hi_s - platformer_.EDGE_PX) - x) if d > 0 else (x - (lo_s + platformer_.EDGE_PX))
                ex.say('stop-watch', st, index=trigger['index'], fromX=w['fromX'], stoppedX=round(x, 1), ms=round(ex.now - w['since'], 1),
                           stopPx=w['stopPx'], roomPx=round(room, 1))
                if room < 0:
                    return {'fail': f'past {where}: it stopped at {x:.0f}, past where it would walk off'}
                return self._reposition(ex, st, j, trigger['index'], ground, x, where)
            if room <= stop:
                return {'fail': f'past {where} at about {now_x:.0f}, {max(0.0, room):.1f} px from where it would walk off, '
                                f'too near to stop ({stop:.1f} px) and walk back'}
            return self._reposition(ex, st, j, trigger['index'], ground, now_x, where)
        ahead = (j['aim'] - now_x) * d
        if ahead > 0 and not (moving or forward):
            st['takeoffWait'] = f'waiting to walk toward {j["aim"]:.0f}'
            return None
        prep = self._landed_due(st, trigger) if moving or forward else None
        lead = max(0.0, ahead / walk)
        if prep is not None and prep - ex.now > lead:
            # its part began on a landing, and the recording pressed it longer after that than the aim comes: a game
            # can take that long to bring the player back up to walking speed, and a jump pressed sooner flies short
            # (the user's second jump quest's movement 1 jump 6, pressed 21 ms after landing against the recording's
            # 70, came down 15 px short). Pressed no sooner after the landing than recorded, unless that carries it
            # past the end of its safe stretch (where it's safe to press at every delay), where it's pressed instead;
            # never sooner than the aim. That end with no inset: where the player is is reckoned at walking speed
            # from its last reading, and just after a landing it's slower, so it's further back than that, from the edge
            lo_i, hi_i = j.get('interval') or (j['aim'], j['aim'])
            far = hi_i if d > 0 else lo_i
            if (far - j['aim']) * d < 0:
                far = j['aim']
            to_far = max(lead, (far - now_x) * d / walk)
            lead = min(prep - ex.now, to_far)
            # held back by the end of the stretch rather than by the recorded time, it's decided from the frame that
            # can't wait for the next (a frame and a half on), not TAKEOFF_HORIZON_MS ahead: each frame's reading
            # says how far the player has really got since landing, short of the walking speed it's reckoned at
            gap = st.get('frameGap') or 0.0
            if lead <= (min(horizon, 1.5 * gap) if to_far < prep - ex.now and gap else horizon):
                return go(lead, now_x + vx * lead, prep=round(prep - st['anchor'][0], 1))
            st['takeoffWait'] = f'pressing it as long after landing as recorded: {lead:.0f} ms on'
            return None
        if ahead <= 0:
            return go(0.0, now_x)  # past where it prefers, still where a press is safe: at once
        if lead <= horizon:
            return go(lead, j['aim'])
        st['takeoffWait'] = f'{ahead:.0f} px from where it jumps'
        return None

    def _landed_due(self, st, trigger):
        """When a jump's press is due as long after the landing its part began on as in the recording (its part began
        on the map's Wait for turning true), else None."""
        segs = st.get('segs')
        live0, rec0 = st.get('anchor') or (None, 0.0)
        began = (segs[st['seg']].get('trigger') or {}) if segs else {}
        if live0 is None or began.get('kind') != 'sync':
            return None
        return live0 + (trigger['at'] - rec0)

    def _stand_into(self, ex, st, j, level, x, y, where):
        """A standing jump with the player outside its safe stretch: tapped toward its aim, standing still between taps,
        each tap chosen from what taps did (TapResponse) so it can't carry the player past the stretch's far side or
        off the line. None while it taps or waits to stand still (st['standRepo']: from, taps, text, extraMs), or
        {fail} when it can't: no keys each way, no tap safe enough to try, or still outside after LINE_UP_TRIES taps."""
        mr = self.mr
        model = mr.dynamics['model']
        lo, hi = j['window']
        r = st.get('standRepo')
        if r is None:
            r = st['standRepo'] = {'from': round(x, 1), 'taps': [], 'tries': 0, 'extraMs': REPOSITION_MS, 'text': ''}
        tap = r.get('tapping')
        if tap is not None:
            phase = ex.play(tap, tap['line'], tap['ms'])
            if phase in ('cancelled', 'failed'):
                return {'fail': f'a tap into {where} was {phase}'}
            if ex.playing(tap):
                if phase is None:
                    ex.hold({k for _, k, down in tap['line'] if down})
                r['text'] = f'tapping into {where} from {x:.0f}'
                return None
            r.pop('tapping')
        if not ex.settled(r, 'still', x, y, mr.replay['stillMs']):
            r['text'] = f'waiting to stand still at {x:.0f}, outside {where}'
            return None
        if r.get('before') is not None:
            r['taps'][-1]['movedPx'] = round(x - r['before'], 1)
            self.note_tap('x', r['taps'][-1]['ms'], x - r['before'], r['taps'][-1].get('context'))
            r['before'] = None
        way = 1 if x < lo else -1
        aim = min(hi, max(lo, j['aim']))
        forward, back = model.get('rightKey'), model.get('leftKey')
        key = forward if way > 0 else back
        if not key:
            return {'fail': f'standing at {x:.0f}, outside {where}, and its model has no key that way to tap with'}
        if r['tries'] >= LINE_UP_TRIES:
            return {'fail': f'standing at {x:.0f}, still outside {where} after {r["tries"]} taps'}
        room = self.room(level, x, y, way, beyond=aim)
        far = (hi - x) if way > 0 else (x - lo)
        allowed = far if room is None else min(far, room)
        context = self.context(level, x, y, way)
        ms, why = self.tap_response('x', context).choose(abs(aim - x), allowed, LINE_UP_TAP_MS,
                                                       next((t['ms'] for t in reversed(r['taps']) if t.get('context') == context), None))
        if ms is None:
            return {'fail': f'standing at {x:.0f}, outside {where}: {why}'}
        r['tries'] += 1
        r['before'] = x
        r['taps'].append({'keys': [key], 'ms': round(ms, 1), 'errorPx': round(aim - x, 1), 'allowedPx': round(allowed, 1), **({'context': context} if context else {})})
        r.pop('still', None)
        r['tapping'] = {'line': [[0.0, key, True], [round(ms, 1), key, False]], 'ms': round(ms, 1), 'start': ex.now}
        ex.play(r['tapping'], r['tapping']['line'], r['tapping']['ms'])
        if ex.shared.get('execution') is None:
            ex.hold({key})
        r['text'] = f'tapping {key} {ms:.0f} ms into {where} from {x:.0f}'
        return None

    def _reposition(self, ex, st, j, index, ground, now_x, where):
        """A moving jump whose safe stretch the player has passed: walk back RUNUP_PX behind where it aims, on the
        line it jumps from, and come at it again (st['repo']: the keys each way, where to, how many times). None to go
        on waiting, or {fail} when it can't: no keys each way measured, no room on the line to run up, or passed again
        REPOSITIONS times."""
        mr = self.mr
        d = j['dir']
        model = mr.dynamics['model']
        forward, back = (model.get('rightKey'), model.get('leftKey')) if d > 0 else (model.get('leftKey'), model.get('rightKey'))
        n = (st.get('repo') or {}).get('n', 0)
        if not forward or not back:
            return {'fail': f'past {where}: at about {now_x:.0f} by now, and its model has no keys each way to walk back with'}
        if n >= REPOSITIONS:
            return {'fail': f'past {where} again after walking back {n} time{"s" if n != 1 else ""}: at about {now_x:.0f} by now'}
        lo_s, hi_s = ground.ends(j['start'])
        to = min(hi_s - platformer_.EDGE_PX, max(lo_s + platformer_.EDGE_PX, j['aim'] - d * RUNUP_PX))
        if abs(j['aim'] - to) < RUNUP_MIN_PX:
            return {'fail': f'past {where}: at about {now_x:.0f} by now, and the line it jumps from leaves no room to walk back and run at it'}
        st['repo'] = {'n': n + 1, 'phase': 'back', 'to': to, 'forward': forward, 'back': back,
                      'extraMs': (st.get('repo') or {}).get('extraMs', 0) + REPOSITION_MS}
        ex.say('reposition', st, index=index, at=j['at'], fromX=round(now_x, 1), to=round(to, 1), n=n + 1, window=j['window'], aim=j['aim'])
        st['takeoffWait'] = f'past {where}: walking back to {to:.0f} to come at it again'
        return None

    def _watch_takeoff(self, ex, st, y, ending=False):
        """Whether the jump last pressed by where the player was took off: risen RISE_PX by NO_JUMP_MS after its
        press, or not (the player walked off its edge first, say). Said in the trace (`takeoff-outcome`) and kept with
        the map's stats (learn_jump). `ending`: the link is ending; a press long enough ago counts as not."""
        mr = self.mr
        w = st.get('watch')
        if not w:
            return
        observed = ex.shared['observation_time']
        rose = observed >= w['pressAt'] and y < w['y0'] - RISE_PX
        if not rose and observed < w['pressAt'] + (NO_JUMP_MS / 3 if ending else NO_JUMP_MS):
            return
        st.pop('watch')
        self.learn_jump(st['link'], w['index'], rose, w['position'])
        ex.say('takeoff-outcome', st, index=w['index'], tookOff=rose, ms=round(observed - w['pressAt'], 1),
                   position=w['position'], aimShift=w['shift'], nextShift=self.jump_shift(st['link'], w['index']))

    def _seen(self, ex, st, x):
        """For timing a takeoff: the player's new readings ([(read time, x)] over VELOCITY_MS: a position State's
        `readAt`, else the frame's time; a reading the runtime reused isn't new) and how often frames come
        (`frameGap`, an average)."""
        mr = self.mr
        observed = ex.shared['observation_time']
        last = st.get('lastSeen')
        if last is not None and observed > last:
            st['frameGap'] = (observed - last) if st.get('frameGap') is None else 0.8 * st['frameGap'] + 0.2 * (observed - last)
        st['lastSeen'] = observed
        # the States its position formula reads: their newest read time, and not new if every one was reused
        read = ex.position_reads(mr)
        if read and all(o.get('reused') for o in read):
            return
        t = max(o['readAt'] for o in read) if read else observed
        seen = st.setdefault('readings', [])
        if not seen or t > seen[-1][0]:
            seen.append((t, x))
            st['readings'] = [r for r in seen if r[0] >= t - VELOCITY_MS]

    def _recorded_dx(self, link, t0, t1):
        """How far along x the player went in a recorded movement from t0 to t1 ms into it (its trajectory)."""
        path = link.get('trajectory') or []

        def at(t):
            for a, b in zip(path, path[1:]):
                if a[0] <= t <= b[0]:
                    return a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0)
            return path[-1][1] if path and t > path[-1][0] else (path[0][1] if path else 0.0)
        return at(t1) - at(t0)

    def _stopping(self):
        """How far the player may go on after its key is let go of: the most it has slid on after a tap (what a tap
        moved past walking for it), at least SLIDE_MS of walking."""
        mr = self.mr
        r = self.tap_response('x')
        walk = r.walk or 0.0
        return max([walk * SLIDE_MS] + [px - walk * ms for ms, px in r.seen])

    def _ground(self, level):
        return self.mr.dynamics['grounds'].get(level) if self.mr.dynamics else None

    def distance(self, level, x, y, tx, ty):
        """On a ground line that also runs under the target, in the line's own terms: along it (x, what walking
        changes) and off it (how much further above or below its line the player is than the target was). Elsewhere
        the straight distance."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        if on is not None:
            ly = ground.y_on(on[0], tx)
            if ly is not None and abs(ly - ty) <= platformer_.ON_PX:
                return math.hypot(x - tx, (y - on[1]) - (ty - ly))
        return super().distance(level, x, y, tx, ty)

    def along(self, level, x, y, tx, ty, within):
        """The player stands on a ground line that, at tx, is within `within` px of the target, so a tap along x
        carries it up or down the line (a slope) to there. False off every line, or with the target off that line (a
        different platform: x can't get it there)."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        if on is None:
            return False
        ly = ground.y_on(on[0], tx)
        return ly is not None and abs(ly - ty) <= within

    def bound(self, level, x, y, way, beyond=None):
        """How far the player can walk `way` and stay EDGE_PX short of ground it can't stop on (Ground.safe_bound: the
        end of the line it stands on, which may be a wall, 'end'; or a downhill past `beyond`, the target,
        'downhill'); (None, None) off every line."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        if on is None:
            return None, None
        px, kind = ground.safe_bound(on[0], x, way, beyond)
        return px - platformer_.EDGE_PX, kind

    def room(self, level, x, y, way, beyond=None):
        """Ground.safe_room less EDGE_PX; None off every line."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        if on is None:
            return None
        return ground.safe_room(on[0], x, way, beyond) - platformer_.EDGE_PX

    def safe_stop(self, level, x, y, tx, ty):
        """Not past the EDGE_PX before a downhill beyond the target, either way (a crest), nor ever kept from the
        target itself."""
        ground = self._ground(level)
        on = ground.on(tx, ty) if ground else None
        if on is None:
            return True
        for way in (-1, 1):
            px, kind = ground.safe_bound(on[0], tx, way, tx)
            # never short of the target itself, a place the player stood (as a wall's margin never keeps it from one)
            limit = tx + way * max(0.0, px - platformer_.EDGE_PX)
            if kind == 'downhill' and (x - limit) * way > 0:
                return False
        return True

    def context(self, level, x, y, way):
        """'flat', or 'up'/'down' 'gentle'/'steep', by the grade of the ground line under the player that way
        (TAP_GRADE, TAP_STEEP); None off every line. Taps kept as 'up' or 'down' before steepness was told apart are
        asked for by no context, so they count only among every tap."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        if on is None:
            return None
        ahead = x + way  # at a corner, the segment it taps onto
        slope = next((m for k, ax, ay, bx, by, m in ground.segs if k == on[0] and ax <= ahead <= bx), None)
        if slope is None:
            slope = next((m for k, ax, ay, bx, by, m in ground.segs if k == on[0] and ax <= x <= bx), 0.0)
        grade = -slope * way  # screen y grows downward: rising the way it taps is up
        if abs(grade) < TAP_GRADE:
            return 'flat'
        return f'{"up" if grade > 0 else "down"} {"steep" if abs(grade) >= TAP_STEEP else "gentle"}'

    def crossing(self, level, x, y, way, reach):
        """context() of each stretch of the line under the player within `reach` px `way`, every 2 px."""
        ground = self._ground(level)
        on = ground.on(x, y) if ground else None
        out = []
        if on is None:
            return out
        for n in range(0, int(max(0.0, reach)) + 1, 2):
            px = x + way * n
            py = ground.y_on(on[0], px)
            if py is None:
                break
            c = self.context(level, px, py, way)
            if c and c not in out:
                out.append(c)
        return out

    def confirms(self, level, x, y, ex, ey):
        """On the ground line its destination is on (a reading on no line, as the position can lag the State by a
        frame, says nothing yet); a destination on no line, within Arrive within of it."""
        ground = self._ground(level)
        there = ground.on(ex, ey) if ground else None
        if there is None:
            return super().confirms(level, x, y, ex, ey)
        here = ground.on(x, y)
        return here is not None and here[0] == there[0], here is not None

    def recoverable(self, link, level, x, y, shift, off):
        """On the ground line under its (shifted) recorded end, within the map's line-up range of it, so lining up can
        put it right. False with no line there or without Line up with taps."""
        ground = self._ground(level) if link.get('recorded') else None
        lu = self.mr.replay['lineUp']
        if ground is None or lu is None or off > lu['range']:
            return False
        here, there = ground.on(x, y), ground.on(link['end'][0] + shift, link['end'][1])
        return 'on its platform' if here is not None and there is not None and here[0] == there[0] else False
