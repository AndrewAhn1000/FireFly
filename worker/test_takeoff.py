"""Adaptive takeoff (platformer.py, Behavior._takeoff): the platformer model fitted from recordings, the safe places to
press a recorded jump, and the executor pressing it by where the player is. On the little platformer, a recorded jump
pressed near the edge of where it reaches the ledge misses when the replay starts a few px behind; timed by where the
player is, it doesn't."""
import math
import unittest

import platformer as P
from behavior import Behavior
from platformer_control import REPOSITIONS, RUNUP_PX, SHIFT_MAX, STOP_WATCH_MS
from tap_response import SLIDE_MS, TapResponse
from keys import Keys, clip
from movement import learn
from test_behavior import FEET, FLOOR, LEDGE, Game

GROUND = [[[x, y - FEET] for x, y in FLOOR], [[x, y - FEET] for x, y in LEDGE]]
# the little platformer as the model sees it (its jump integrated in 5 ms steps rises as if launched a little slower)
MODEL = {'walk': 0.1, 'jump': Game.JUMP - Game.GRAVITY * 5 / 2, 'gravity': Game.GRAVITY, 'fall': None, 'jumpKey': 'space',
         'leftKey': 'left', 'rightKey': 'right', 'delays': [-3.0, 2.0, 8.0], 'leaveMs': 10.0}


def play(g, plan, until, sample=45):
    """The platformer played by `plan` ([(t, key, down)]) until `until` ms: samples [(t, x, y, grounded, level)], the
    key events."""
    t, samples, events, plan = 0.0, [], [], sorted(plan)
    while t <= until:
        while plan and plan[0][0] <= t:
            e = plan.pop(0)
            events.append(e)
            g.keys = (g.keys | {e[1]}) if e[2] else (g.keys - {e[1]})
        if round(t) % sample == 0:
            samples.append((t, g.x, g.y, g.ground, None))
        g.tick()
        t += 5
    keys = Keys(events)
    keys.recorded = True
    return samples, keys


def demonstration(takeoff=258.0):
    """Standing at 150, walking right and jumping at `takeoff` (pressed as the player gets there), onto the ledge and
    along it, standing again."""
    g = Game(150)
    t, plan = 0.0, [(400.0, 'right', True)]
    # when the player walking from 150 at 0.1 px/ms (from the tick after the press) gets to the takeoff
    press = 400 + 5 + (takeoff - 150) / Game.WALK
    plan += [(press, 'space', True), (press + 150, 'space', False), (press + 1600, 'right', False)]
    return play(g, plan, press + 2200)


def edge_run(takeoff):
    """Standing at 300, walking right and jumping at `takeoff` near the floor's end (400) onto the ledge beyond it,
    letting go of the arrow in the air and standing again."""
    g = Game(300)
    press = 400 + 5 + (takeoff - 300) / Game.WALK
    return play(g, [(400.0, 'right', True), (press, 'space', True), (press + 150, 'space', False), (press + 200, 'right', False)], press + 1600)


def behavior(graph, keys, replay, model=MODEL, reach=6):
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': reach, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                    maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 800, 'linkMs': 100, 'places': places, 'links': graph['links'],
                                'grid': {'replay': {'arrivePx': 8, **replay}}, 'platformer': {'model': model, 'grounds': [[None, GROUND]]}}})


def learned(takeoff=258.0):
    samples, keys = demonstration(takeoff)
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('demo', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    link, = graph['links']
    link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, link['clip']['from'], link['clip']['to'])
    if any(j['status'] in ('unsafe', 'narrow') for j in link['takeoffs']):
        link['unsafe'] = 'a jump it can’t press safely'
    return graph, keys


def run(b, game, limit=8000, latency=60.0, frame=45.0):
    """The tree playing the platformer, each frame seen `latency` ms after it was captured (its observation time), the
    guard's sequences played as sent: (its last output, every event it said, every sequence sent with when)."""
    t, pending, timed, playing, out, events, sent = 0.0, [], [], -1.0, None, [], []
    while t < limit:
        if round(t) % round(frame) == 0:
            out = b.tick(t + latency, {'player': {'valid': True, 'value': [game.x, game.y]}, 'grounded': {'valid': True, 'value': game.ground}},
                         observation_time=t)
            events += out['events']
            pending.append((t + latency, set(out['keys']), out['sequence']))
            if out['sequence']:
                sent.append((t + latency, out['sequence']))
            if out['done']:
                break
        while pending and pending[0][0] <= t:
            at, keys, sequence = pending.pop(0)
            if sequence:
                game.keys = keys
                timed = sorted([(at + ms, k, d) for ms, k, d in sequence], key=lambda e: e[0])
                playing = timed[-1][0]
            elif sequence == []:
                timed, playing, game.keys = [], -1.0, keys
            elif at > playing:
                game.keys = keys
        while timed and timed[0][0] <= t:
            _, k, d = timed.pop(0)
            game.keys = (game.keys | {k}) if d else (game.keys - {k})
        game.tick()
        t += 5
    return out, events, sent


class ModelTests(unittest.TestCase):
    def test_it_is_fitted_from_recordings(self):
        recordings = []
        for takeoff in (60, 110, 160, 210, 270, 290):  # moving jumps, onto the floor or the ledge
            g = Game(20)
            press = 100 + 5 + (takeoff - 20) / Game.WALK
            samples, keys = play(g, [(100, 'right', True), (press, 'space', True), (press + 150, 'space', False), (press + 900, 'right', False)], press + 1200)
            recordings.append({'samples': samples, 'keys': keys})
        for x in (80, 200):  # standing jumps
            samples, keys = play(Game(x), [(100, 'space', True), (250, 'space', False)], 1200)
            recordings.append({'samples': samples, 'keys': keys})
        m = P.fit(recordings)
        self.assertNotIn('error', m, m)
        self.assertEqual((m['jumpKey'], m['leftKey'], m['rightKey']), ('space', None, 'right'), 'nothing moved it left')
        self.assertAlmostEqual(m['walk'], Game.WALK, delta=0.003)
        self.assertAlmostEqual(m['jump'], MODEL['jump'], delta=0.015)
        self.assertAlmostEqual(m['gravity'], Game.GRAVITY, delta=0.00008)
        self.assertLessEqual(m['delays'][0], m['delays'][1])
        self.assertEqual(m['delays'][2], m['recordedDelays']['p90'] + P.INJECTED_MS, 'presses FireFly sends launch later')

    def test_too_few_jumps_says_so(self):
        samples, keys = demonstration()
        self.assertIn('error', P.fit([{'samples': samples, 'keys': keys}]))

    def test_its_landing_is_the_platformers(self):
        ground = P.Ground(GROUND)
        for takeoff in (250, 258, 270, 300, 350):
            g = Game(takeoff - 30)
            samples, _ = play(g, [(0, 'right', True), (300 - 5, 'space', True), (450, 'space', False)], 1600, sample=5)
            lands = next(s for s in samples if s[0] > 400 and s[3])
            launch = next(s for s in samples if not s[3])
            hit = P.land(MODEL, ground, 0, launch[1] - Game.WALK * 5, FLOOR[0][1] - FEET, Game.WALK)
            self.assertEqual(hit[0], 1 if lands[2] < 190 else 0, takeoff)
            self.assertAlmostEqual(hit[1], lands[1], delta=2.0)


class JumpTests(unittest.TestCase):
    def test_a_jump_near_the_edge_of_reaching_the_ledge_is_aimed_further_in(self):
        graph, _ = learned(258)
        j, = graph['links'][0]['takeoffs']
        self.assertEqual(j['status'], 'adapt', j)
        lo, hi = j['interval']
        self.assertGreater(lo, 258, 'pressed at 258, it lands under the landing margin')
        self.assertTrue(lo + P.INSET_PX <= j['aim'] <= hi - P.INSET_PX)
        self.assertEqual(j['aim'], lo + P.INSET_PX, 'the aim is as near the recording as it can be')
        self.assertEqual(j['predicted'][0], j['target'])

    def test_keys_changing_in_the_air_press_by_position_away_from_the_edge(self):
        # a run off the floor's end (400) onto the ledge, pressed 4 px from the end, its arrow let go in the air: the
        # model can't say where it lands, but its press is timed by where the player is, kept in from the edge
        samples, keys = edge_run(396)
        row, = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 1e9)
        margin = P.EDGE_PX + MODEL['walk'] * (MODEL['delays'][-1] - MODEL['delays'][0])
        self.assertEqual((row['status'], row['edgeMargin']), ('position', round(margin, 1)))
        self.assertEqual(row['aim'], round(row['demoX'], 1), 'pressed further in than the margin: aimed where it was')
        self.assertEqual(row['window'][1], round(400 - row['lateMargin'], 1), 'the latest a press is safe, by the model')
        self.assertEqual(row['lateMargin'], round(P.EDGE_PX + MODEL['walk'] * MODEL['delays'][-1], 1))
        self.assertLess(row['aim'], row['window'][1], 'the aim, where it prefers, is short of it')
        # pressed nearer the end than the margin: aimed that far in, not where the recording was
        samples, keys = edge_run(398.5)
        row, = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 1e9)
        self.assertEqual(row['aim'], round(400 - margin, 1))
        self.assertLess(row['aim'], row['demoX'])
        # standing, or nothing changing in the air, isn't one
        g = Game(150)
        samples, keys = play(g, [(0, 'right', True), (1100, 'space', True), (1250, 'space', False), (1300, 'right', False), (1300, 'left', True),
                                 (1500, 'left', False)], 2500)
        self.assertEqual(P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 3000)[0]['status'], 'position')

    def test_a_target_too_small_for_its_spread_is_unsafe_with_its_most_robust_place(self):
        graph, _ = learned(258)
        # a ledge 16 px long, and the launch so uncertain no press lands on it safely every time
        narrow = P.Ground([GROUND[0], [[300, LEDGE[0][1] - FEET], [316, LEDGE[0][1] - FEET]]])
        wide = {**MODEL, 'delays': [-60.0, 0.0, 90.0]}
        samples, keys = demonstration(258)
        row, = P.jumps(samples, keys, wide, {None: narrow}, 0, 1e9)
        self.assertIn(row['status'], ('unsafe', 'narrow'))
        self.assertIsNotNone(row['aim'])
        lo, hi = row['window']
        self.assertTrue(lo <= row['aim'] <= hi)


    def test_a_press_recorded_past_the_edge_is_planned_from_the_line(self):
        # the floor's line ends at 290.2 (as the ground State has it): the last reading on it is at 290, and carried on
        # at walking speed to the press, 290.5, past its end
        samples, keys = demonstration(290)
        floor = [[0, FLOOR[0][1] - FEET], [290.2, FLOOR[0][1] - FEET]]
        row, = P.jumps(samples, keys, MODEL, {None: P.Ground([floor, GROUND[1]])}, 0, 1e9)
        self.assertTrue(row['pressedPastEdge'])
        self.assertNotIn('modelErr', row, 'the press past the edge was taken as one on the ground')
        self.assertEqual(row['status'], 'adapt', row)
        lo, hi = row['interval']
        self.assertLess(hi, 290.2 - P.EDGE_PX, 'a takeoff past where it leaves the line')
        self.assertLess(row['aim'], row['demoX'], 'an earlier takeoff')
        self.assertEqual(row['margin'], P.LAND_MARGIN + P.UNCHECKED_PX)
        self.assertEqual(row['predicted'][0], row['target'], 'it still reaches the line the recording landed on')
        # where no earlier press reaches it, it's unsafe, saying why
        short = [[336, LEDGE[0][1] - FEET], [342, LEDGE[0][1] - FEET]]  # 6 px long, round where it landed
        row, = P.jumps(samples, keys, MODEL, {None: P.Ground([floor, short])}, 0, 1e9)
        self.assertEqual(row['status'], 'unsafe')
        self.assertIn('pressed past the edge', row['why'])


class ExecutorTests(unittest.TestCase):
    def test_timed_misses_from_a_few_px_behind_and_adaptive_doesn_t(self):
        graph, keys = learned(258)
        start = graph['places'][0][1]
        timed = Game(start - 5)
        out, events, _ = run(behavior(graph, keys, {'takeoff': 'timed', 'ground': 'platforms'}), timed)
        self.assertEqual(out['done'], 'failure', 'pressed 5 px early, the recorded jump still made the ledge')
        self.assertGreater(timed.y, 190, 'it reached the ledge')
        self.assertFalse(any(e['kind'] == 'takeoff' for e in events))
        adaptive = Game(start - 5)
        out, events, sent = run(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'}), adaptive)
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        self.assertLess(adaptive.y, 150)
        took, = [e for e in events if e['kind'] == 'takeoff']
        j = graph['links'][0]['takeoffs'][0]
        self.assertTrue(took['worked'])
        self.assertEqual((took['aim'], took['window'], took['status'], took['forced']), (j['aim'], j['window'], 'adapt', False))
        self.assertAlmostEqual(took['estX'], j['aim'], delta=0.01)
        self.assertLessEqual(took['leadMs'], max(40, 1.5 * 45) + 1)
        self.assertEqual(took['predicted'][0], j['target'])
        # the jump's part: its press `lead` ms on, everything after it as long after it as recorded
        when, line = next((at, s) for at, s in sent if any(k == 'space' and d for _, k, d in s))
        self.assertAlmostEqual(when + took['leadMs'], took['pressAt'], delta=0.01)
        c = clip(keys, graph['links'][0]['clip']['from'], graph['links'][0]['clip']['to'])
        recorded = [(ms - j['at'], k, d) for ms, k, d in c['timeline'] if ms >= j['at'] - 0.01]
        played = [(ms - took['leadMs'], k, d) for ms, k, d in line if ms > 0 or k == 'space']
        self.assertEqual([(round(a, 1), k, d) for a, k, d in played], [(round(a, 1), k, d) for a, k, d in recorded])
        self.assertTrue(any(ms == 0 and k == 'right' and d for ms, k, d in line), 'the arrow held through the wait let go')
        # Runs: the link event says how its jumps are pressed and carries them
        began, = [e for e in events if e['kind'] == 'link']
        self.assertEqual(began['takeoff']['mode'], 'adaptive')
        self.assertEqual(began['recorded']['takeoffs'][0]['aim'], j['aim'])

    def test_as_recorded_both_work(self):
        graph, keys = learned(270)
        start = graph['places'][0][1]
        for mode in ('timed', 'adaptive'):
            g = Game(start)
            out, events, _ = run(behavior(graph, keys, {'takeoff': mode, 'ground': 'platforms'}), g)
            self.assertEqual(out['done'], 'success', mode)
            self.assertEqual(len([e for e in events if e['kind'] == 'takeoff']), 1 if mode == 'adaptive' else 0, 'decided more than once')

    def test_where_it_presses(self):
        graph, keys = learned(258)
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
        mr = b.shared['maps']['m']
        j = graph['links'][0]['takeoffs'][0]
        trigger = {'jump': j, 'index': 0, 'at': j['at'], 'kind': 'takeoff'}
        y = FLOOR[0][1] - FEET

        def ask(x, readings, now=1000.0, gap=45.0, row=j, anchor=None, **more):
            b.now, b.shared['observation_time'], b.frames = now, now, [{}]
            st = {'readings': readings, 'frameGap': gap, **({'anchor': anchor} if anchor else {}), **more}
            return mr.control._takeoff(b, st, {**trigger, 'jump': row}, None, x, y), st
        aim = j['aim']
        go, st = ask(aim - 30, [(900, aim - 40), (1000, aim - 30)])
        self.assertIsNone(go, 'pressed 300 ms early')
        self.assertIn('px from where it jumps', st['takeoffWait'])
        go, _ = ask(aim - 5, [(900, aim - 15), (1000, aim - 5)])
        self.assertAlmostEqual(go['lead'], 50.0, delta=0.01)
        go, _ = ask(aim - 5, [(950, aim - 5), (980, aim - 5)])
        self.assertIsNone(go, 'standing: not yet walking toward it')
        go, _ = ask(aim + 2, [(900, aim - 8), (1000, aim + 2)])
        self.assertEqual(go['lead'], 0.0, 'past the aim but in the window: at once')
        # past the stretch it can't be reached going this way: it walks back behind the aim and comes at it again
        past = j['window'][1] + 1
        go, st = ask(past, [(900, past - 10), (1000, past)])
        self.assertIsNone(go)
        self.assertEqual({k: st['repo'][k] for k in ('n', 'phase', 'to', 'forward', 'back')},
                         {'n': 1, 'phase': 'back', 'to': aim - RUNUP_PX, 'forward': 'right', 'back': 'left'})
        self.assertIn('walking back', st['takeoffWait'])
        go, st = ask(aim - 10, [(900, aim - 5), (1000, aim - 10)], repo=dict(st['repo']))
        self.assertIsNone(go, 'pressed walking back')
        self.assertEqual(st['repo']['phase'], 'back')
        go, st = ask(aim - RUNUP_PX - 1, [(900, aim - RUNUP_PX + 9), (1000, aim - RUNUP_PX - 1)], repo=dict(st['repo']))
        self.assertIsNone(go)
        self.assertEqual(st['repo']['phase'], 'forward', 'back far enough to run at it again')
        go, _ = ask(aim - 5, [(900, aim - 15), (1000, aim - 5)], repo=dict(st['repo']))
        self.assertAlmostEqual(go['lead'], 50.0, delta=0.01)
        go, _ = ask(past, [(900, past - 10), (1000, past)], repo={**st['repo'], 'n': REPOSITIONS})
        self.assertIn(f'again after walking back {REPOSITIONS} times', go['fail'])
        go, st = ask(aim, [(1000, aim)], row={**j, 'start': 1})
        self.assertIn('it’s on a line below it', go['fail'], 'it fell below the line it jumps from: waiting won’t bring it back')
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        st = {'readings': [(1000, aim)], 'frameGap': 45.0}
        self.assertIsNone(mr.control._takeoff(b, st, {**trigger, 'jump': {**j, 'start': 1}}, None, aim, 120), 'in the air, it waits')
        self.assertIn('waiting', st['takeoffWait'])
        standing = {**j, 'moving': False}
        # standing, it's pressed as long after its part began as recorded (its part began at 900 live, at its recorded
        # time 100 ms before the jump: due at 1000), not as soon as it could be (that turned a jump pressed 98 ms after a
        # landing, the player turning, into one pressed on landing, 13 px short)
        self.assertEqual(ask(aim, [(1000, aim)], row=standing, anchor=(900.0, j['at'] - 100))[0]['lead'], 0.0)
        self.assertAlmostEqual(ask(aim, [(1000, aim)], row=standing, anchor=(940.0, j['at'] - 100))[0]['lead'], 40.0)
        go, st = ask(aim, [(1000, aim)], row=standing, anchor=(1000.0, j['at'] - 100))
        self.assertIsNone(go, 'pressed 100 ms early')
        self.assertIn('jumping 100 ms on as recorded', st['takeoffWait'])
        # standing outside it: tapped in, not failed (StandingTests)
        go, st = ask(j['window'][0] - 3, [(1000, j['window'][0] - 3)], row=standing)
        self.assertIsNone(go)
        self.assertIn('outside its safe stretch', st['takeoffWait'])

    def test_past_its_stretch_it_walks_back_and_comes_at_it_again(self):
        # starting 180 px on from the recorded start, the player is past the jump's safe stretch (262..318) before it
        # could press: as recorded, it would press there and miss; timed by where it is, it walks back and runs at it
        graph, keys = learned(258)
        start = graph['places'][0][1]
        graph['places'][0][1] = start + 180  # its starting place there, so the map takes it to be at it
        game = Game(start + 180)
        out, events, _ = run(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'startPx': 250}, reach=250), game)
        back, = [e for e in events if e['kind'] == 'reposition']
        j = graph['links'][0]['takeoffs'][0]
        self.assertGreater(back['fromX'], j['window'][1])
        self.assertEqual(back['to'], j['aim'] - RUNUP_PX)
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertEqual((took['worked'], took['repositions']), (True, 1))
        self.assertAlmostEqual(took['estX'], j['aim'], delta=0.01)
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        self.assertLess(game.y, 150, 'it isn’t on the ledge')
        # Runs says it walked back, from where to where, before pressing
        import replay_report
        out, frames = run_guarded(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'startPx': 250}, reach=250), Game(start + 180))
        self.assertEqual(out['done'], 'success')
        row = [a for a in replay_report.report({'buttons': []}, frames)['attempts'] if a.get('recorded')][0]['jumps'][0]
        self.assertEqual([w['to'] for w in row['walkedBack']], [j['aim'] - RUNUP_PX])
        self.assertEqual((row['plan']['repositions'], row['landed']['on'], row['inInterval']), (1, 'target', True))
        # as recorded, from there, it misses
        timed = Game(start + 180)
        out, _, _ = run(behavior(graph, keys, {'takeoff': 'timed', 'ground': 'platforms', 'startPx': 250}, reach=250), timed)
        self.assertEqual(out['done'], 'failure')

    def test_a_complex_edge_jump_keeps_its_timing_and_is_pressed_earlier_only_to_stay_safe(self):
        # recorded 4 px from the floor's end; replayed from 5 px further on, the press timed by the clock comes past the
        # end, after the player walked off (the game takes no press in the air). It keeps its recorded timing (its run-up),
        # pressed earlier only as far as the latest press the model rates safe: refusing it there instead failed every
        # run of the user's first movement, whose own recording pressed past that point
        samples, keys = edge_run(396)
        track = [(t, x, y) for t, x, y, _, _ in samples]
        graph = learn([('edge', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
        link, = graph['links']
        link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, link['clip']['from'], link['clip']['to'])
        self.assertEqual(link['takeoffs'][0]['status'], 'position')
        start = graph['places'][0][1]
        timed = Game(start + 5)
        out, events, _ = run(behavior(graph, keys, {'takeoff': 'timed', 'ground': 'platforms', 'arrivePx': 12}), timed)
        self.assertEqual(out['done'], 'failure')
        self.assertGreater(timed.y, 200, 'it didn’t walk off the edge')
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 12})
        game = Game(start + 5)
        out, events, _ = run(b, game)
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertLessEqual(took['estX'], link['takeoffs'][0]['window'][1] + 0.01, 'pressed past the latest safe press')
        self.assertFalse([e for e in events if e['kind'] == 'reposition'])
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 12})
        out, events, _ = run(b, Game(start))
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'takeoff-outcome', 'link-end')])
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertEqual((took['status'], took['predicted']), ('position', None))
        outcome, = [e for e in events if e['kind'] == 'takeoff-outcome']
        self.assertTrue(outcome['tookOff'])
        mr = b.shared['maps']['m']
        self.assertEqual(mr.stats[link['id']]['jumps']['0'], {'tries': 1, 'noJump': 0, 'shift': 0.0})
        # Runs: pressed by position, where it took off, that it did, and no landing predicted for an arc the model can't
        import replay_report
        out, frames = run_guarded(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 12}), Game(start))
        row = [a for a in replay_report.report({'buttons': []}, frames)['attempts'] if a.get('recorded')][0]['jumps'][0]
        self.assertEqual((row['status'], row['predicted'], row['outcome']['tookOff']), ('position', None, True))
        self.assertAlmostEqual(row['takeoffX'], row['aim'], delta=1.5)
        # one that didn't take off is aimed further from the edge from then on, up to SHIFT_MAX
        for n in range(8):
            mr.control.learn_jump(link['id'], 0, False, True)
        self.assertEqual(mr.control.jump_shift(link['id'], 0), SHIFT_MAX)
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        j = link['takeoffs'][0]
        go = mr.control._takeoff(b, {'link': link['id'], 'readings': [(900, j['aim'] - 12), (1000, j['aim'] - 2)], 'frameGap': 45.0},
                        {'jump': j, 'index': 0, 'at': j['at'], 'kind': 'takeoff'}, None, j['aim'] - 2, FLOOR[0][1] - FEET)
        self.assertTrue(go is None or 'fail' in go or go['shift'] == 0.0, 'a learned shift advanced the complex jump')
        if go and 'estX' in go:
            self.assertLessEqual(go['estX'], j['window'][1] + 0.01, 'pressed past the latest safe press')
        self.assertTrue(mr.changed)

    def test_unsafe_movements_only_when_there_s_no_other_way(self):
        graph, keys = learned(258)
        graph['links'][0]['unsafe'] = 'jump 1: nowhere to press it is safe at every delay'
        graph['links'][0]['takeoffs'][0]['status'] = 'unsafe'
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
        mr = b.shared['maps']['m']
        lid = graph['links'][0]['id']
        self.assertEqual(mr.control.unsafe(), {lid: graph['links'][0]['unsafe']})
        self.assertIsNone(mr.route('g0', 'g1', b.clips, avoid=mr.control.unsafe()))
        self.assertEqual(mr.route('g0', 'g1', b.clips), [lid])
        start = graph['places'][0][1]
        out, events, _ = run(b, Game(start - 5))
        began, = [e for e in events if e['kind'] == 'link']
        self.assertTrue(began['takeoff']['forced'], 'taken though unsafe, and said so')
        self.assertTrue([e for e in events if e['kind'] == 'takeoff'][0]['forced'])
        # timed (the baseline), unsafe ones aren't avoided
        self.assertEqual(behavior(graph, keys, {'takeoff': 'timed', 'ground': 'platforms'}).shared['maps']['m'].control.unsafe(), {})


def run_guarded(b, game, limit=8000, latency=60.0, frame=45.0):
    """As run, with the guard's feedback: each action played on its own clock, its kept keys held when it completes,
    and its dispatch records; the frames kept as a trace is."""
    t, pending, cur, frames, dispatch, out = 0.0, [], None, [], {}, None
    while t < limit:
        if round(t) % round(frame) == 0:
            ex = {'id': 0, 'state': 'idle'} if cur is None else {'id': cur['id'], 'state': 'completed' if cur['done'] else 'running', 'startedAt': cur['start']}
            out = b.tick(t + latency, {'player': {'valid': True, 'value': [game.x, game.y]}, 'grounded': {'valid': True, 'value': game.ground}},
                         execution=ex, observation_time=t)
            frames.append({'t': t, 'maps': out['maps'], 'events': out['events'], 'reads': {'player': [t, False]}, 'execution': ex,
                           **({'action': out['action'], 'sequence': out['sequence']} if out['action'] else {})})
            pending.append((t + latency, out))
            if out['done']:
                break
        while pending and pending[0][0] <= t:
            at, o = pending.pop(0)
            if o['action'] and o['sequence']:
                downs = {k for ms, k, d in o['sequence'] if ms == 0 and d}
                game.keys = set(downs)
                cur = {'id': o['action']['id'], 'start': at, 'end': at + o['action']['durationMs'], 'keep': set(o['action'].get('keep') or []), 'done': False,
                       'timed': sorted([(at + ms, i, k, d) for i, (ms, k, d) in enumerate(o['sequence'])])}
                dispatch[cur['id']] = {'id': cur['id'], 'state': 'running', 'startedAt': at, 'events': []}
            elif o['sequence'] == []:
                cur, game.keys = None, set()
            elif cur is None or cur['done']:
                game.keys = set(o['keys'])
        if cur and not cur['done']:
            while cur['timed'] and cur['timed'][0][0] <= t:
                due, i, k, d = cur['timed'].pop(0)
                game.keys = (game.keys | {k}) if d else (game.keys - {k})
                dispatch[cur['id']]['events'].append([i, due - cur['start'], t - cur['start'], t - cur['start'], 'emitted'])
            if t >= cur['end'] and not cur['timed']:
                cur['done'] = True
                game.keys &= cur['keep']
        game.tick()
        t += 5
    frames[-1]['dispatch'] = list(dispatch.values())
    return out, frames


class RunsTests(unittest.TestCase):
    def test_runs_say_where_each_jump_took_off_and_landed_against_the_model(self):
        import replay_report
        graph, keys = learned(258)
        start = graph['places'][0][1]
        j = graph['links'][0]['takeoffs'][0]
        rows = {}
        for mode in ('timed', 'adaptive'):
            out, frames = run_guarded(behavior(graph, keys, {'takeoff': mode, 'ground': 'platforms'}), Game(start - 5))
            self.assertEqual(out['done'], 'failure' if mode == 'timed' else 'success', mode)
            a, = [a for a in replay_report.report({'buttons': []}, frames)['attempts'] if a.get('recorded')][:1]
            rows[mode] = a['jumps'][0]
            self.assertEqual(a['takeoffMode'], mode)
        timed, adaptive = rows['timed'], rows['adaptive']
        self.assertEqual((timed['status'], timed['mode'], timed['sent']), ('adapt', 'timed', True))
        self.assertAlmostEqual(timed['takeoffX'], j['demoX'] - 5, delta=1.5)
        self.assertFalse(timed['inInterval'])
        self.assertEqual(timed['landed']['on'], 'start')
        self.assertFalse(timed['worked'])
        self.assertNotIn('plan', timed)
        self.assertEqual(adaptive['plan']['worked'], True)
        self.assertAlmostEqual(adaptive['takeoffX'], j['aim'], delta=1.5)
        self.assertTrue(adaptive['inInterval'])
        self.assertEqual((adaptive['predicted']['on'], adaptive['landed']['on'], adaptive['worked']), ('target', 'target', True))
        self.assertLess(abs(adaptive['landingErrorPx']), 3)


SLOPE = [[-1595.0, -521.0], [-1540.0, -588.0], [-1523.0, -588.0]]  # the user's jump quest, where line-up stopped


def lining_up(start, lines, start_px=2.0):
    """A map whose one recorded movement starts at `start`, Line up with taps on x only, and a platformer model over
    `lines`."""
    sx, sy = start
    link = {'id': 'L', 'from': 'a', 'to': 'b', 'kind': 'clip', 'recorded': True, 'start': [sx, sy], 'end': [sx + 40, sy], 'ms': 500,
            'trajectory': [[0, sx, sy, None], [500, sx + 40, sy, None]]}
    places = [{'id': 'a', 'x': sx, 'y': sy, 'level': None, 'reach': start_px, 'recorded': True},
              {'id': 'b', 'x': sx + 40, 'y': sy, 'level': None, 'reach': start_px, 'recorded': True}]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'b'}, 'children': []}}}
    replay = {'startPx': start_px, 'lineUp': {'x': {'less': ['left'], 'more': ['right']}}}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}], clips={'link:L': {'keys': [], 'timeline': [[0, 'right', True], [400, 'right', False]], 'end': 500}},
                    maps={'m': {'position': 'player', 'places': places, 'links': [link], 'grid': {'replay': replay},
                                'platformer': {'model': MODEL, 'grounds': [[None, lines]]}}})


class LineUpTests(unittest.TestCase):
    def tap(self, b, x, y, t):
        """Ticks with the player standing at (x, y) until it taps, starts the movement or ends: what it pressed, said
        and how it ended."""
        out, events = None, []
        for k in range(8):
            out = b.tick(t + 50 * k, {'player': {'valid': True, 'value': [x, y]}})
            events += out['events']
            if out['sequence'] or out['done'] or any(e['kind'] == 'link' for e in events):
                break
        return {**out, 'events': events, 'text': out['text'] or ''}

    def test_on_a_slope_a_tap_along_x_lines_it_up_in_y_too(self):
        # 3 px left of the start on a slope of 67 px in 55: 4 px off in y, the larger error, with no keys for y
        b = lining_up((-1542, -586), [SLOPE])
        out = self.tap(b, -1545, -582, 0)
        self.assertIsNone(out['done'], out['text'])
        self.assertEqual({k for _, k, d in out['sequence'] or [] if d} | out['keys'], {'right'}, 'a tap right, along the slope')
        # the tap carried it up the slope to (-1542, -585.6): within 2 px of the start, the movement begins
        out = self.tap(b, -1542, -585.6, 400)
        lined = [e for e in out['events'] if e['kind'] == 'line-up']
        self.assertTrue(lined and lined[0]['worked'] and lined[0]['alongLine'], out['events'])
        self.assertTrue(any(e['kind'] == 'link' for e in out['events']), 'the movement didn’t start')

    def test_on_flat_ground_it_lines_up_along_x_as_before(self):
        b = lining_up((-1530, -588), [SLOPE])
        out = self.tap(b, -1534, -588, 0)
        self.assertEqual({k for _, k, d in out['sequence'] or [] if d} | out['keys'], {'right'})
        out = self.tap(b, -1530.5, -588, 400)
        lined = [e for e in out['events'] if e['kind'] == 'line-up']
        self.assertTrue(lined[0]['worked'])
        self.assertNotIn('alongLine', lined[0], 'x was the larger error anyway')

    def taps(self, b, path):
        """The taps it sends with the player standing at each of `path` in turn: [(ms, key)]."""
        out, t = [], 0
        for x, y in path:
            o = self.tap(b, x, y, t)
            t += 400
            out += [(ms, k) for ms, k, d in o['sequence'] or [] if not d]
            if o['done']:
                break
        return out

    def test_a_tap_that_barely_moved_isn_t_scaled_up_into_a_run(self):
        # where the user's best run ended: 15 px right of a start on a flat platform, a 40 ms tap moved it 1 px, and
        # scaling its move per ms made the next tap 260 ms, which walked and slid 37 px past, off the platform's end
        flat = [[-1000.0, -701.0], [-930.0, -701.0]]
        b = lining_up((-958, -701), [flat])
        taps = self.taps(b, [(-943, -701), (-944, -701)])
        self.assertEqual(taps[0], (40, 'left'))
        ms, key = taps[1]
        walk, slide = MODEL['walk'], max(MODEL['walk'] * SLIDE_MS, 1 - MODEL['walk'] * 40)
        self.assertLessEqual(ms, 2 * 40, 'more than double the tap before')
        self.assertLessEqual(walk * ms + slide, 14 + 2 + 0.01, 'worst case, it carries the player past the start and Start within')
        # without the model's lines and speed, still never more than double the last
        bare = lining_up((-958, -701), [])
        bare.shared['maps']['m'].dynamics = None
        taps = self.taps(bare, [(-943, -701), (-944, -701)])
        self.assertEqual(taps[1][0], 80.0)

    def test_a_tap_doesn_t_carry_the_player_off_the_end_of_its_line(self):
        # the start 9 px left, the line's end 12 px left: no tap longer than what keeps it 2 px (EDGE_PX) short of the end
        b = lining_up((-958, -701), [[[-961.0, -701.0], [-930.0, -701.0]]])
        ms, key = self.taps(b, [(-949, -701)])[0]
        self.assertEqual(key, 'left')
        self.assertLessEqual(MODEL['walk'] * ms + MODEL['walk'] * SLIDE_MS, 12 - P.EDGE_PX + 0.01)
        # a start past the line's end it stands on: it can't get there without leaving the line, and says so
        b = lining_up((-965, -701), [[[-961.0, -701.0], [-930.0, -701.0]]], start_px=1)
        out = self.tap(b, -949, -701, 0)
        self.assertEqual(out['done'], 'failure')
        self.assertIn('the line it stands on ends', out['text'])

    def test_off_in_y_on_another_platform_still_isnt_lined_up(self):
        # 4 px below the start on a flat line under it: no tap along x gets it there, and Start within isn't relaxed
        b = lining_up((-1530, -588), [SLOPE, [[-1560.0, -584.0], [-1500.0, -584.0]]])
        out = self.tap(b, -1530, -584, 0)
        self.assertEqual(out['done'], 'failure')
        self.assertIn('no keys for y', out['text'])
        # nor without the model's lines
        b = lining_up((-1542, -586), [])
        out = self.tap(b, -1545, -582, 0)
        self.assertEqual(out['done'], 'failure')
        self.assertIn('no keys for y', out['text'])


class TapTests(unittest.TestCase):
    """What taps of each length did (TapResponse) choosing the next: the user's line-ups sent 5–17 ms taps that never
    moved the player (21 of 24), and before that scaled a 1 px move into a 260 ms tap that ran it off a ledge."""

    def test_after_taps_too_short_to_register_a_longer_one_still_safe(self):
        r = TapResponse([(5, 0), (15, 0)], 0.1287)
        ms, why = r.choose(4, 8, 40)
        self.assertEqual((ms, why), (40, None))
        self.assertLessEqual(r.upper(40), 8, 'a 15 ms tap moved nothing, so a 40 ms one moves at most 25 ms of walking')

    def test_it_won_t_try_the_shortest_tap_that_moves_it_if_that_could_overshoot(self):
        r = TapResponse([(30, 0), (40, 8)], 0.1287)
        ms, why = r.choose(1, 2, 40)
        self.assertIsNone(ms)
        self.assertIn('the shortest tap that has moved it, 40 ms, could move it 8.0 px', why)
        # nothing has moved it yet, and even the shortest tap could carry it past what it may move
        ms, why = TapResponse([], 0.1287).choose(1, 2, 40)
        self.assertIsNone(ms)

    def test_the_tap_that_typically_covers_it_no_more_than_twice_the_last(self):
        r = TapResponse([(40, 2), (40, 1), (80, 15)], 0.1287)
        self.assertEqual(r.choose(14, 28, 40, 40), (70, None), 'an 80 ms tap moved 15 px: 70 is typically enough')
        self.assertEqual(r.choose(14, 28, 40, 30), (60, None), 'more than twice the last tap')
        self.assertEqual(r.choose(14, 12, 40)[0], 70, 'a tap that could move it 15 px where it may move 12')

    def test_what_taps_did_is_kept_with_the_map(self):
        graph, keys = learned(258)
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
        mr = b.shared['maps']['m']
        self.assertNotIn('_taps', mr.stats)
        mr.control.note_tap('x', 40, -3)
        self.assertEqual(b.stats()['m']['_taps'], {'x': [[40, 3]]})
        again = Behavior(b.nodes and {'root': b.root, 'nodes': b.nodes}, b.fields, clips=b.clips, maps=b.maps, stats={'m': b.stats() or mr.stats})
        self.assertEqual(again.shared['maps']['m'].control.tap_response('x').seen, [(40.0, 3.0)])


class SlopeStartTests(unittest.TestCase):
    def test_on_a_slope_start_within_counts_along_the_line(self):
        # 2 px left of the start along the slope: 2.6 px away in a straight line, but within Start within along it
        ground = P.Ground([SLOPE])
        x = -1544
        b = lining_up((-1542, ground.y_on(0, -1542)), [SLOPE])
        out = LineUpTests().tap(b, x, ground.y_on(0, x), 0)
        self.assertTrue(any(e['kind'] == 'link' for e in out['events']), 'it lined up instead of starting')
        self.assertFalse(any(e['kind'] == 'line-up' for e in out['events']))
        # 3 px left along it isn't
        b = lining_up((-1542, ground.y_on(0, -1542)), [SLOPE])
        out = LineUpTests().tap(b, -1545, ground.y_on(0, -1545), 0)
        self.assertFalse(any(e['kind'] == 'link' for e in out['events']))
        # on flat ground, the straight distance as before: 2 px left and 2 px up is 2.8 px
        b = lining_up((-1530, -588), [SLOPE])
        out = LineUpTests().tap(b, -1532, -590, 0)
        self.assertFalse(any(e['kind'] == 'link' for e in out['events']))


def stand_and_jump(stand=335):
    """Walking right from 150, stopping at `stand` a moment (less than a stand), and jumping straight up onto the
    ledge, then standing there."""
    g = Game(150)
    stop = 400 + 5 + (stand - 150) / Game.WALK
    return play(g, [(400.0, 'right', True), (stop, 'right', False), (stop + 75, 'space', True), (stop + 225, 'space', False)], stop + 1500, sample=15)


class StandingTests(unittest.TestCase):
    def test_a_standing_jump_outside_its_stretch_is_tapped_into_it(self):
        # the ledge as the model knows it, 30 px: a standing jump up onto it is safe from about 326 to 344. Replayed
        # from 12 px on, the player stops at 347: it taps back into the stretch, stands still, and jumps
        ground = [GROUND[0], [[320.0, LEDGE[0][1] - FEET], [350.0, LEDGE[0][1] - FEET]]]
        samples, keys = stand_and_jump(335)
        track = [(t, x, y) for t, x, y, _, _ in samples]
        graph = learn([('stand', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
        link, = graph['links']
        link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: P.Ground(ground)}, link['clip']['from'], link['clip']['to'])
        j, = link['takeoffs']
        self.assertEqual((j['status'], j['moving']), ('adapt', False), j)
        start = graph['places'][0][1]
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'startPx': 15, 'arrivePx': 20}, reach=15)
        b.maps['m']['platformer']['grounds'] = [[None, ground]]
        b = Behavior({'root': b.root, 'nodes': b.nodes}, b.fields, clips=b.clips, maps=b.maps)
        game = Game(start + 12)
        out, events, _ = run(b, game)
        moved, = [e for e in events if e['kind'] == 'stand-reposition']
        self.assertGreater(moved['fromX'], j['window'][1])
        self.assertTrue(j['window'][0] <= moved['toX'] <= j['window'][1])
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(j['window'][0] <= took['estX'] <= j['window'][1])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        self.assertLess(game.y, 150)


def b_takeoff_again(case, j, st, x, y=FLOOR[0][1] - FEET):
    """PositionJumpRegressionTests.ask's question asked again a frame on, with the state it left."""
    graph, keys = learned(258)
    b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
    b.now, b.shared['observation_time'], b.frames = 1045.0, 1045.0, [{}]
    st['readings'] = st['readings'] + [(1045.0, x)]
    return b.shared['maps']['m'].control._takeoff(b, st, {'jump': j, 'index': 0, 'at': j['at'], 'kind': 'takeoff'}, None, x, y)


def turn_and_jump(turn=388.0, takeoff=396.0):
    """Standing at 398, walking left to `turn`, turning right there and jumping at `takeoff`, 4 px from the floor's end
    (400), onto the ledge, letting go of the arrow in the air: the user's first movement's second jump, whose aim is 8 px
    past the turn."""
    g = Game(398)
    back = 400 + 5 + (398 - turn) / Game.WALK
    press = back + 5 + (takeoff - turn) / Game.WALK
    return play(g, [(400.0, 'left', True), (back, 'left', False), (back, 'right', True), (press, 'space', True), (press + 150, 'space', False),
                    (press + 200, 'right', False)], press + 1600)


def learned_from(samples, keys, ground=GROUND):
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('demo', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    link, = graph['links']
    link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: P.Ground(ground)}, link['clip']['from'], link['clip']['to'])
    return graph, link


class PositionJumpRegressionTests(unittest.TestCase):
    """The three ways the user's first movement failed with position-timed jumps (23:28:32, :45, :57): the aim passed
    in a turn, a walk-back with the player sliding at the edge, and holding the way back on the floor it fell to."""

    def test_the_aim_isn_t_missed_in_a_turn(self):
        # after turning right 8 px before the aim, its readings still show it going left: waiting for its speed to
        # show walking let it pass the aim between frames; with the way forward held, it's timed from walking speed
        samples, keys = turn_and_jump()
        graph, link = learned_from(samples, keys)
        j = link['takeoffs'][0]
        self.assertEqual(j['status'], 'position', j)
        start = graph['places'][0][1]
        game = Game(start)
        out, events, _ = run(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 12}), game)
        self.assertFalse([e for e in events if e['kind'] == 'reposition'], 'it passed the aim and walked back')
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(took['worked'])
        self.assertLessEqual(took['estX'], j['window'][1])
        self.assertTrue([e for e in events if e['kind'] == 'takeoff-outcome'][0]['tookOff'])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])

    def ask(self, j, x, readings, y=FLOOR[0][1] - FEET, **more):
        graph, keys = learned(258)
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        st = {'readings': readings, 'frameGap': 45.0, 'link': graph['links'][0]['id'], **more}
        return b.shared['maps']['m'].control._takeoff(b, st, {'jump': j, 'index': 0, 'at': j['at'], 'kind': 'takeoff'}, None, x, y), st

    def test_it_doesn_t_walk_back_where_it_can_t_stop_before_the_edge(self):
        # past the latest safe press, walking toward the floor's end 2.5 px on with the way forward held: walking back
        # would carry it off
        samples, keys = edge_run(396)
        j, = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 1e9)
        go, st = self.ask(j, 397.5, [(900, 387.5), (1000, 397.5)], keep=['right'])
        self.assertIn('too near to stop', go['fail'])
        self.assertNotIn('repo', st)
        # with nothing held its slide is watched (StopWatchTests), and still sliding STOP_WATCH_MS on, it has failed
        go, st = self.ask(j, 397.5, [(900, 387.5), (1000, 397.5)])
        self.assertIsNone(go)
        self.assertIn('stopWatch', st)
        st['stopWatch']['since'] -= STOP_WATCH_MS + 1
        go = b_takeoff_again(self, j, st, 398.5)
        self.assertIn('hadn’t stopped', go['fail'])
        self.assertNotIn('repo', st)
        # with room to stop (the ledge jump's stretch ends 80 px from the floor's end), it walks back
        graph, _ = learned(258)
        k = graph['links'][0]['takeoffs'][0]
        go, st = self.ask(k, k['window'][1] + 2, [(900, k['window'][1] - 8), (1000, k['window'][1] + 2)])
        self.assertIsNone(go)
        self.assertEqual(st['repo']['phase'], 'back')

    def test_sliding_off_the_line_while_its_stop_is_watched_fails_at_once(self):
        samples, keys = edge_run(396)
        j, = P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 1e9)
        go, st = self.ask(j, 397.5, [(900, 387.5), (1000, 397.5)])
        self.assertIsNone(go)
        go = b_takeoff_again(self, j, st, 402.0, y=205.0)  # off the floor's end, falling
        self.assertIn('went off the line before it stopped', go['fail'])

    def test_leaving_the_line_while_walking_back_fails_at_once(self):
        graph, _ = learned(258)
        k = graph['links'][0]['takeoffs'][0]
        repo = {'n': 1, 'phase': 'back', 'to': k['aim'] - RUNUP_PX, 'forward': 'right', 'back': 'left', 'extraMs': 2500}
        go, _ = self.ask(k, 401, [(1000, 401)], y=210, repo=repo)  # off the floor's end, falling
        self.assertIn('it left it walking back', go['fail'])
        # and standing on a line below the one it jumps from (fallen), it fails rather than waiting it out
        go, _ = self.ask({**k, 'start': 1}, 290, [(1000, 290)])
        self.assertIn('on a line below it', go['fail'])


def run_up_jump(start=150.0, runup=37.0):
    """Standing at `start`, pressing right and jumping `runup` ms later (a standing jump with a run-up, as the user's
    movement 12 opens), landing on the floor further right."""
    g = Game(start)
    return play(g, [(400.0, 'right', True), (400 + runup, 'space', True), (400 + runup + 150, 'space', False), (1100, 'right', False)], 2000, sample=15)


class RunUpTests(unittest.TestCase):
    def test_a_run_up_isn_t_let_go_of_the_start_is_set_up_before_the_movement(self):
        # as the model knows the ground, the floor it lands on starts at 210, 3.5 px short of where it landed: from the
        # recorded start the jump would take off outside its stretch. Tapping into it (letting go of the right held
        # into the jump) made the user's movement 12 jump from a standstill and fall short; now the movement starts
        # further along instead
        floor = FLOOR[0][1] - FEET
        ground = [[[0.0, floor], [180.0, floor]], [[210.0, floor], [240.0, floor]]]
        samples, keys = run_up_jump()
        graph, link = learned_from(samples, keys, ground)
        j = link['takeoffs'][0]
        self.assertEqual((j['status'], j['moving']), ('adapt', False), j)
        self.assertFalse(j['window'][0] <= j['demoX'] <= j['window'][1], 'the recorded takeoff is inside its stretch')
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 20,
                                   'lineUp': {'x': {'less': ['left'], 'more': ['right']}}})
        b.maps['m']['platformer']['grounds'] = [[None, ground]]
        b = Behavior({'root': b.root, 'nodes': b.nodes}, b.fields, clips=b.clips, maps=b.maps)
        start = graph['places'][0][1]
        game = Game(start)
        out, events, sent = run(b, game)
        lined = [e for e in events if e['kind'] == 'line-up']
        self.assertTrue(lined, 'it didn’t line up with the start moved along')
        self.assertAlmostEqual(lined[-1]['target'][0], start + (j['aim'] - j['demoX']), delta=0.01)
        self.assertTrue(lined[-1]['worked'])
        self.assertFalse([e for e in events if e['kind'] == 'stand-reposition'], 'it let go of the run-up to tap')
        took, = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(j['window'][0] <= took['estX'] <= j['window'][1], took)
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end', 'line-up')])


class RunUpPastTests(unittest.TestCase):
    """2026-10-20 04:26: the new map's jump 9, a standing jump with Right held into it, came after a landing 7-8 px
    further on than recorded, and its run-up as recorded would have taken off 1-2 px past its stretch: refused, 3 runs
    of 4. Now it's pressed earlier, before the far side, the key still held; never later than recorded."""

    def ask(self, x, runup=45.0, recorded_px=None):
        samples, keys = run_up_jump(runup=runup)
        graph, link = learned_from(samples, keys)
        j = link['takeoffs'][0]
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms'})
        if recorded_px is not None:  # a longer run-up than the little platformer's standing jumps have (jump 9's: 6-9 px)
            b.shared['maps']['m'].control._recorded_dx = lambda *a: recorded_px
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        st = {'segs': [{'line': [[0.0, 'right', True]], 'held': 0, 'keep': ['right'], 'from': 0.0, 'until': j['at']}], 'seg': 0,
              'segStart': 1000.0, 'anchor': (None, 0.0), 'readings': [(1000.0, x)], 'frameGap': 20.0, 'link': link['id']}
        trigger = {'jump': j, 'index': 0, 'at': j['at'], 'kind': 'takeoff'}
        return b.shared['maps']['m'].control._takeoff(b, st, trigger, None, x, FLOOR[0][1] - FEET), j

    def test_it_is_a_standing_jump_with_a_run_up(self):
        _, link = learned_from(*run_up_jump(runup=45.0))
        j = link['takeoffs'][0]
        self.assertEqual((j['status'], j['moving']), ('adapt', False), j)

    def test_short_of_its_aim_it_is_pressed_as_it_gets_there_earlier_than_recorded(self):
        _, j = self.ask(0)
        far = j['window'][1]
        go, j = self.ask(far - 6.0, recorded_px=8.0)  # its recorded 8 px run-up would take it 2 px past the far side
        self.assertNotIn('fail', go or {}, go)
        self.assertAlmostEqual(go['estX'], far - P.INSET_PX, delta=0.05)
        self.assertAlmostEqual(go['lead'], 2.0 / MODEL['walk'], delta=0.5)
        self.assertLess(go['lead'], j['at'], 'earlier than its recorded run-up')

    def test_between_its_aim_and_far_side_it_is_pressed_at_once(self):
        _, j = self.ask(0)
        go, j = self.ask(j['window'][1] - 1.0)
        self.assertEqual(go['lead'], 0.0)
        self.assertLessEqual(go['estX'], j['window'][1])

    def test_already_past_its_far_side_it_still_fails(self):
        _, j = self.ask(0)
        go, j = self.ask(j['window'][1] + 1.0)
        self.assertIn('too near its far side', go['fail'])


def walk_off(press_past=4.0):
    """On the ledge at 340, walking left off its end (300), pressing jump `press_past` px past the end (in the air, where
    the game takes no jump), falling to the floor, letting go and standing: the user's movement from (-1907, -1054),
    whose recorded space press came 61 ms after the player left the edge."""
    g = Game(340, y=LEDGE[0][1] - FEET)
    press = 400 + 5 + (340 - 300 + press_past) / Game.WALK
    return play(g, [(400.0, 'left', True), (press, 'space', True), (press + 100, 'space', False), (press + 700, 'left', False)], press + 1500)


class WalkOffTests(unittest.TestCase):
    def test_a_walk_off_with_a_press_in_the_air_isn_t_a_jump(self):
        # moved onto the line as a jump, its press made the player jump where the recording fell (three runs stopped
        # there); it didn't rise, so it's a walk off its edge, played as recorded
        samples, keys = walk_off()
        graph, link = learned_from(samples, keys)
        j, = link['takeoffs']
        self.assertEqual(j['status'], 'walkoff', j)
        self.assertLess(j['rise'], P.RISE_PX)
        self.assertNotIn('aim', j)
        b = behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 20})
        self.assertEqual(b._bounds(b.shared['maps']['m'], link, True), [], 'its press is timed by where the player is')
        start = graph['places'][0][1]
        game = Game(start, y=LEDGE[0][1] - FEET)
        out, events, _ = run(b, game)
        self.assertFalse([e for e in events if e['kind'] == 'takeoff'])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('link-end',)])
        self.assertAlmostEqual(game.y, FLOOR[0][1] - FEET, delta=1, msg='it jumped instead of falling to the floor')
        # reaching the edge a little later than recorded (from 5 px further back), its press played at its recorded
        # time reached the game with the player still on the ledge, 1 px short of the end, and it jumped (the user's
        # run at 01:53:57): with adaptive takeoff the press that did nothing is left out, and the player walks off
        late = Game(start + 5, y=LEDGE[0][1] - FEET)
        out, events, sent = run(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 20}), late)
        self.assertFalse(any(k == 'space' for _, line in sent for _, k, _ in line), 'the walk-off’s press was played')
        self.assertEqual([e['takeoff'].get('dropped') for e in events if e['kind'] == 'link'], [[j['at']]])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] == 'link-end'])
        self.assertAlmostEqual(late.y, FLOOR[0][1] - FEET, delta=1)
        # timed as recorded (the baseline) plays every key, and from there jumps
        jumped = Game(start + 5, y=LEDGE[0][1] - FEET)
        out, events, sent = run(behavior(graph, keys, {'takeoff': 'timed', 'ground': 'platforms', 'arrivePx': 20}), jumped)
        self.assertTrue(any(k == 'space' for _, line in sent for _, k, _ in line))
        # a real jump from the same place is still a jump
        samples, keys = edge_run(396)
        self.assertNotEqual(P.jumps(samples, keys, MODEL, {None: P.Ground(GROUND)}, 0, 1e9)[0]['status'], 'walkoff')


class Quick(Game):
    """The platformer walking 10% faster than it was recorded at: a recorded walk ends further on than recorded."""
    WALK = 0.11


def two_walks():
    """Walking right from 100 to about 200, standing, then on to about 300, standing: two recorded movements."""
    g = Game(100)
    return play(g, [(400.0, 'right', True), (1400.0, 'right', False), (1900.0, 'right', True), (2900.0, 'right', False)], 3500)


def walks(replay):
    samples, keys = two_walks()
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('walks', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': replay.get('startPx', 6), 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g2'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': 3, 'arriveMs': 400, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': replay}, 'platformer': {'model': MODEL, 'grounds': [[None, GROUND]]}}})
    return b, graph


class ArrivalTests(unittest.TestCase):
    """19 arrival misses in three runs, each put right by the next line-up, were each counted as a failed movement: a
    movement that reaches its platform is learned once lining up says whether it could be put right."""

    def test_a_movement_that_reached_its_platform_and_was_lined_up_counts_as_worked(self):
        b, graph = walks({'startPx': 6, 'arrivePx': 6, 'lineUp': {'x': {'less': ['left'], 'more': ['right']}}})
        first = graph['links'][0]['id']
        out, events, _ = run(b, Quick(100))
        ended = next(e for e in events if e['kind'] == 'link-end' and e['link'] == first)
        self.assertEqual((ended['worked'], ended['cause'], ended.get('pending')), (False, 'arrival', True))
        recovered, = [e for e in events if e['kind'] == 'link-recovered' and e['attempt'] == ended['attempt']]
        self.assertTrue(recovered['worked'])
        self.assertIn('lined up', recovered['how'])
        mr = b.shared['maps']['m']
        self.assertEqual((mr.stats[first]['runs'], mr.stats[first]['fails']), (1, 0))
        self.assertNotIn(first, mr.fails, 'it counted toward giving up on the movement')
        self.assertGreater(mr.stats[first]['ms'], ended['ms'], 'its time without the correction’s')

    def test_one_that_couldn_t_be_put_right_counts_as_failed(self):
        b, graph = walks({'startPx': 0.5, 'arrivePx': 0.5, 'lineUp': {'x': {'less': ['left'], 'more': ['right']}, 'tries': 1}})
        first = graph['links'][0]['id']
        out, events, _ = run(b, Quick(100))
        recovered = [e for e in events if e['kind'] == 'link-recovered' and e['link'] == first]
        self.assertEqual([e['worked'] for e in recovered], [False])
        mr = b.shared['maps']['m']
        self.assertEqual((mr.stats[first]['runs'], mr.stats[first]['fails']), (1, 1))

    def test_one_that_missed_its_platform_fails_at_once(self):
        b, graph = walks({'startPx': 6, 'arrivePx': 6, 'lineUp': {'x': {'less': ['left'], 'more': ['right']}}})
        mr = b.shared['maps']['m']
        link = graph['links'][0]
        self.assertTrue(mr.control.recoverable(link, None, link['end'][0] + 10, link['end'][1], 0.0, 10))
        self.assertFalse(mr.control.recoverable(link, None, link['end'][0] + 10, LEDGE[0][1] - FEET, 0.0, 10), 'on another line')
        self.assertFalse(mr.control.recoverable(link, None, link['end'][0] + 60, link['end'][1], 0.0, 60), 'further than lining up goes')
        bare, _ = walks({'startPx': 6, 'arrivePx': 6})
        self.assertFalse(bare.shared['maps']['m'].control.recoverable(link, None, link['end'][0] + 10, link['end'][1], 0.0, 10), 'without Line up with taps')


class TodayRegressionTests(unittest.TestCase):
    """2026-10-20: refusing a position jump whose recorded press is past the latest press the model rates safe failed
    the user's first movement every run; and lining up with a start at a line's end (against a wall) was refused."""

    def test_a_recorded_press_past_the_safe_limit_is_pressed_at_the_limit_not_refused(self):
        samples, keys = edge_run(398.5)  # pressed 1.5 px from the floor's end, past the latest safe press (397.2)
        graph, link = learned_from(samples, keys)
        j = link['takeoffs'][0]
        self.assertEqual(j['status'], 'position')
        self.assertGreater(j['demoX'], j['window'][1], 'the recorded press is inside the window')
        out, events, _ = run(behavior(graph, keys, {'takeoff': 'adaptive', 'ground': 'platforms', 'arrivePx': 12}), Game(graph['places'][0][1]))
        took = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(took and took[0]['worked'], took)
        self.assertLessEqual(took[0]['estX'], j['window'][1] + 0.01)
        self.assertGreater(took[0]['estX'], j['window'][1] - 3, 'pressed earlier than safety needs')
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])

    def test_lining_up_with_a_start_at_the_end_of_its_line(self):
        # the user's quest starts at (-668, 266), the very end of its floor line (a wall): from 3 px off, line-up kept
        # 2 px from the end and refused every tap
        b = lining_up((-958, -701), [[[-1000.0, -701.0], [-958.0, -701.0]]])
        b.shared['maps']['m'].taps['x'] = [[5, 0.0], [20, 2.0], [40, 2.0]]  # what the user's taps did (its trace: 20 ms, up to 2 px)
        out = LineUpTests().tap(b, -961, -701, 0)
        self.assertNotEqual(out['done'], 'failure', out['text'])
        self.assertEqual({k for _, k, d in out['sequence'] or [] if d}, {'right'})
        # still never past the end itself: worst case no further than the line's end
        mr = b.shared['maps']['m']
        self.assertLessEqual(mr.control.tap_response('x').upper([ms for ms, k, d in out['sequence'] if not d][0]), 3 + 0.01)


# ── terminal correction (platformer.finish, Behavior._finish) ─────────────────────────────────────────────────────
SHORT = ((300, 150), (330, 150))  # a short ledge, its right end 30 px along, over the floor


class Short(Game):
    """The little platformer with a short ledge (SHORT) in place of LEDGE."""

    def under(self, x, y):
        return any(x0 <= x <= x1 and abs(y - (py - FEET)) < 0.5 for (x0, py), (x1, _) in (FLOOR, SHORT))

    def tick(self, dt=5.0):
        k = self.keys
        if self.ground:
            self.vx = self.WALK * (('right' in k) - ('left' in k))
            if 'space' in k and not self.held_space:
                self.vy, self.ground = -self.jump, False
            elif not self.under(self.x + self.vx * dt, self.y):
                self.ground = False
        if not self.ground:
            self.vy += self.GRAVITY * dt
        self.held_space = 'space' in k
        nx, ny = self.x + self.vx * dt, self.y + self.vy * dt
        if not self.ground and self.vy > 0:
            for (x0, py), (x1, _) in (FLOOR, SHORT):
                top = py - FEET
                if x0 <= nx <= x1 and self.y <= top <= ny:
                    ny, self.vy, self.ground = top, 0.0, True
        self.x, self.y = nx, ny


class Laggy(Short):
    """As it was recorded: after a landing the player doesn't walk for LAG ms (the game's landing lag), so a key each
    way pressed in the air and let go of soon after landing barely moves it."""
    LAG = 110.0

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.t, self.landed = 0.0, -math.inf

    def tick(self, dt=5.0):
        keys, was = self.keys, self.ground
        if self.ground and self.t - self.landed < self.LAG:
            self.keys = keys - {'left', 'right'}
        super().tick(dt)
        self.keys = keys
        if self.ground and not was:
            self.landed = self.t
        self.t += dt


SHORT_GROUND = [[[x, y - FEET] for x, y in FLOOR], [[x, y - FEET] for x, y in SHORT]]


def hop_up(x=318.0):
    """The user's movement 21 (-1813, -1002) → (-1900, -1127), on the little platformer: standing at `x` under the short
    ledge, a jump straight up onto it, and Right pressed in the air 113 ms before it lands and let go of 125 ms after (in
    the recording, 2 px of walking during the landing lag), standing again near the ledge's right end."""
    probe = Short(x)
    space = 400.0
    samples, _ = play(probe, [(space, 'space', True), (space + 150, 'space', False)], 1400, sample=5)
    landed = next(s[0] for s in samples if s[0] > space + 100 and s[3])
    plan = [(space, 'space', True), (space + 150, 'space', False), (landed - 113, 'right', True), (landed + 125, 'right', False)]
    return play(Laggy(x), plan, landed + 900)


def finish_map(samples, keys, replay, reach=6, ground=SHORT_GROUND):
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('hop', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    link, = graph['links']
    grounds = {None: P.Ground(ground)}
    link['takeoffs'] = P.jumps(samples, keys, MODEL, grounds, link['clip']['from'], link['clip']['to'])
    link['finish'] = P.finish(samples, keys, MODEL, grounds, link['clip']['from'], link['clip']['to'])
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': reach, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 800, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': {'arrivePx': 8, 'sync': 'grounded', **replay}}, 'platformer': {'model': MODEL, 'grounds': [[None, ground]]}}})
    return b, link


ADAPTIVE = {'takeoff': 'adaptive', 'ground': 'platforms', 'lineUp': {'x': {'less': ['left'], 'more': ['right']}}}


def pressed(sent, key):
    """Every press of `key` sent: [(when sent, ms held)]."""
    out = []
    for at, seq in sent:
        downs = [ms for ms, k, d in seq if k == key and d]
        ups = [ms for ms, k, d in seq if k == key and not d]
        out += [(at, (ups[0] if ups else math.inf) - downs[0])] if downs else []
    return out


class FinishAnalysisTests(unittest.TestCase):
    """What a recorded movement's ending is after its last landing (platformer.finish)."""

    def test_movement_21_its_right_pressed_in_the_air_is_a_nudge(self):
        samples, keys = hop_up()
        _, link = finish_map(samples, keys, ADAPTIVE)
        f = link['finish']
        self.assertEqual(f['status'], 'correct', f)
        right, = [t for t, k, d in keys.events if k == 'right' and d]
        self.assertEqual(f['drop'], [[round(right - link['clip']['from'], 1), 'right']])
        self.assertLess(f['at'] - f['drop'][0][0], 120, 'pressed in the air, before the landing')
        self.assertLessEqual(f['movedPx'], 2.0, 'in the recording it barely moved the player')
        self.assertEqual((f['facing'], f['restore']), ('right', 'right'), 'it ended facing right, and faced no way before')
        self.assertEqual(link['takeoffs'][0]['status'], 'timed', 'its jump is played as recorded')

    def synthetic(self, air_x, after, presses):
        """Standing at 0, a jump up 40 px landing at 300 ms; `air_x(t)` its x in the air, `after` [(t, x)] on the ground after
        landing; `presses` more key events."""
        samples = [(t, 0.0, 100.0, True, None) for t in (0, 20, 40)]
        samples += [(t, air_x(t), 100.0 - 40 * math.sin(math.pi * (t - 40) / 260), False, None) for t in range(60, 300, 20)]
        samples += [(t, x, 100.0, True, None) for t, x in after]
        keys = Keys(sorted([(40.0, 'space', True), (120.0, 'space', False), *presses]))
        keys.recorded = True
        return P.finish(samples, keys, MODEL, {None: P.Ground([[[-200, 100], [200, 100]]])}, 40.0, after[-1][0])

    def test_a_key_that_steered_in_the_air_is_part_of_the_jump(self):
        f = self.synthetic(lambda t: 0.0 if t < 160 else 0.08 * (t - 160), [(300, 11.2), (320, 11.2), (400, 11.2)],
                           [(160.0, 'right', True), (310.0, 'right', False)])
        self.assertEqual(f['status'], 'kept')
        self.assertIn('steered', f['why'])

    def test_presses_that_walk_it_on_after_landing_are_a_walk_played_as_recorded(self):
        f = self.synthetic(lambda t: 0.0, [(300, 0.0), (400, 10.0), (500, 20.0), (520, 20.0), (600, 20.0)],
                           [(300.0, 'right', True), (500.0, 'right', False)])
        self.assertEqual((f['status'], f['drop']), ('correct', []))
        self.assertIn('walk it 20 px', f['why'])

    def test_another_key_after_its_last_takeoff_keeps_the_ending(self):
        f = self.synthetic(lambda t: 0.0, [(300, 0.0), (400, 0.0)], [(320.0, 'up', True), (360.0, 'up', False)])
        self.assertEqual(f['status'], 'kept')
        self.assertIn('up pressed', f['why'])


class FinishTests(unittest.TestCase):
    """2026-10-20, the user's movement (-1813, -1002) → (-1900, -1127) failed three times in a row: its first jump landed
    at -1894 rather than -1903, the second went straight up onto the flat end of the line above, and the Right pressed
    in the air as recorded (2 px of walking in the recording, during the landing lag) walked the player 20 px, off the
    line's end at -1875. Its trailing positioning press isn't sent; once it has landed on its end's line, feedback puts
    it on its end."""

    def test_timed_replay_still_sends_the_recorded_right_and_walks_off(self):
        samples, keys = hop_up(318)
        b, link = finish_map(samples, keys, {'takeoff': 'timed', 'lineUp': ADAPTIVE['lineUp']})
        game = Short(322)  # 4 px nearer the ledge's end than recorded, and no landing lag: as the live landing at -1894
        out, events, sent = run(b, game)
        self.assertTrue(pressed(sent, 'right'), 'the baseline plays the recording')
        self.assertGreater(game.y, 180, 'it walked off the short ledge')
        self.assertFalse([e for e in events if e['kind'] == 'finish'])
        self.assertEqual(out['done'], 'failure')

    def test_adaptive_leaves_the_right_out_and_puts_it_on_its_end(self):
        samples, keys = hop_up(318)
        b, link = finish_map(samples, keys, ADAPTIVE)
        game = Short(322)
        out, events, sent = run(b, game)
        began = next(e for e in events if e['kind'] == 'link')
        self.assertEqual(began['finish']['drop'], link['finish']['drop'])
        fin, = [e for e in events if e['kind'] == 'finish']
        self.assertTrue(fin['worked'], fin)
        ended = next(e for e in events if e['kind'] == 'link-end')
        self.assertTrue(ended['worked'])
        self.assertEqual(ended['arrival'], fin['arrival'])
        self.assertEqual(out['done'], 'success', fin)
        self.assertLess(game.y, 150, 'still on the ledge')
        self.assertLessEqual(abs(game.x - link['end'][0]), 8)
        # only the correction's taps went right: none as long as the recorded 238 ms press, and none could pass the edge
        self.assertTrue(all(ms <= 40 for _, ms in pressed(sent, 'right')), pressed(sent, 'right'))
        self.assertLessEqual(game.x, SHORT[1][0] - 2)
        # it was faced right again, as the recording ended, by a tap that kept it within Arrive within
        self.assertEqual(fin['facing'], {'recorded': 'right', 'kept': True})
        self.assertEqual(fin['arrival'], 'direct', 'only the facing tap: no correction was needed')

    def test_a_landing_further_off_is_corrected_and_says_when_it_can_t_be_faced_as_recorded(self):
        samples, keys = hop_up(318)
        b, link = finish_map(samples, keys, {**ADAPTIVE, 'startPx': 10, 'arrivePx': 4}, reach=10)
        game = Short(326)  # 8 px off: lands 6.5 px from its end, 4 px from the ledge's end
        out, events, sent = run(b, game)
        fin, = [e for e in events if e['kind'] == 'finish']
        self.assertEqual(out['done'], 'success', fin)
        self.assertEqual(fin['arrival'], 'corrected')
        self.assertTrue(fin['corrections'] >= 1 and all(tp['keys'] == ['left'] for tp in fin['taps'] if not tp.get('facing')), fin['taps'])
        self.assertLessEqual(abs(game.x - link['end'][0]), 4)
        self.assertLess(game.y, 150)
        self.assertFalse(fin['facing']['kept'])
        self.assertIn('short enough', fin['facing']['why'])
        self.assertFalse(pressed(sent, 'right'), 'facing it right could have carried it out of Arrive within')

    def test_it_never_begins_on_another_platform(self):
        samples, keys = hop_up(318)
        b, link = finish_map(samples, keys, ADAPTIVE)
        game = Short(322, jump=0.3)  # too weak to reach the ledge: back on the floor
        out, events, sent = run(b, game)
        self.assertFalse([e for e in events if e['kind'] == 'finish'])
        self.assertFalse(pressed(sent, 'right') + pressed(sent, 'left'), 'no correction off its line')
        ended = next(e for e in events if e['kind'] == 'link-end')
        self.assertFalse(ended['worked'])
        self.assertIn(ended['cause'], ('deviation', 'arrival'), 'its failure is the movement’s, not a correction’s')

    def test_its_presses_are_kept_without_line_up_keys(self):
        samples, keys = hop_up(318)
        b, link = finish_map(samples, keys, {k: v for k, v in ADAPTIVE.items() if k != 'lineUp'})
        out, events, sent = run(b, Short(318))
        self.assertTrue(pressed(sent, 'right'), 'nothing could correct it, so its recorded presses are played')


# ── the executor as the guard runs it ────────────────────────────────────────────────────────────────────────────
def run_as_played(b, game, limit=8000, latency=20.0, frame=20.0):
    """As run_guarded(), but closer to play: the guard as it is (input_guard.cpp, timed_sequence.hpp): an action starts when it arrives,
    stopping one still running (which lets go of everything), with exactly its presses at 0 down (keys already down
    stay down) and the rest played on its own clock; one that completes leaves its `keep` held; and the tree hears how
    its actions are going from the guard's reply to the update before, so a 0 ms action is still 'running' to it a
    frame after it was sent, as in play. (its last output, every event it said, every sequence the guard got)"""
    t, pending, act, reported, out, events, sent = 0.0, [], None, {'id': 0, 'state': 'idle'}, None, [], []
    while t < limit:
        while pending and pending[0][0] <= t:
            at, o = pending.pop(0)
            seq = o['sequence']
            if seq is not None:
                if act and act['state'] == 'running':
                    act['state'], game.keys = 'cancelled', set()
                if seq:
                    a = o.get('action') or {}
                    game.keys = {k for ms, k, d in seq if ms == 0 and d}
                    act = {'id': a.get('id', 0), 'start': at, 'events': [(at + ms, k, d) for ms, k, d in seq if not (ms == 0 and d)],
                           'end': at + a.get('durationMs', seq[-1][0]), 'keep': set(a.get('keep') or []), 'state': 'running'}
                    sent.append((at, seq))
                else:
                    game.keys = set(o['keys'])
            elif not (act and act['state'] == 'running'):
                game.keys = set(o['keys'])
            if act:
                reported = {'id': act['id'], 'state': act['state'], 'startedAt': act['start'], 'elapsedMs': at - act['start']}
        if act and act['state'] == 'running':
            while act['events'] and act['events'][0][0] <= t:
                _, k, d = act['events'].pop(0)
                game.keys = (game.keys | {k}) if d else (game.keys - {k})
            if not act['events'] and t >= act['end']:
                act['state'], game.keys = 'completed', game.keys & act['keep']
        if round(t) % round(frame) == 0:
            out = b.tick(t + latency, {'player': {'valid': True, 'value': [game.x, game.y]}, 'grounded': {'valid': True, 'value': game.ground}},
                         execution=dict(reported), observation_time=t)
            events += out['events']
            pending.append((t + latency, out))
            if out['done']:
                break
        game.tick()
        t += 5
    return out, events, sent


class Stage(Game):
    """The little platformer with its own platforms (PLATFORMS) in place of the floor and ledge."""
    PLATFORMS = (FLOOR, LEDGE)

    def under(self, x, y):
        return any(x0 <= x <= x1 and abs(y - (py - FEET)) < 0.5 for (x0, py), (x1, _) in self.PLATFORMS)

    def tick(self, dt=5.0):
        k = self.keys
        if self.ground:
            self.vx = self.WALK * (('right' in k) - ('left' in k))
            if 'space' in k and not self.held_space:
                self.vy, self.ground = -self.jump, False
            elif not self.under(self.x + self.vx * dt, self.y):
                self.ground = False
        if not self.ground:
            self.vy += self.GRAVITY * dt
        self.held_space = 'space' in k
        nx, ny = self.x + self.vx * dt, self.y + self.vy * dt
        if not self.ground and self.vy > 0:
            for (x0, py), (x1, _) in self.PLATFORMS:
                top = py - FEET
                if x0 <= nx <= x1 and self.y <= top <= ny:
                    ny, self.vy, self.ground = top, 0.0, True
        self.x, self.y = nx, ny


LEDGE6 = ((300, 150), (360, 150))  # a small ledge, its right end at 360, over a wide floor
FLOOR6 = ((0, 200), (600, 200))


class Ledge6(Stage):
    PLATFORMS = (FLOOR6, LEDGE6)


LEDGE6_GROUND = [[[x, y - FEET] for x, y in FLOOR6], [[x, y - FEET] for x, y in LEDGE6]]


def jump6(stand=354.0, delay=40.0):
    """The user's last movement's jump 6 on the little platformer: standing on the small ledge `stand` (6 px from its
    end), a hop straight up landing where it left; Right pressed as it lands (held into the jump) and the jump pressed
    `delay` ms later, from 0.3 px past the latest press the model rates safe (the user's was 0.6 px past it); Right let
    go of in the air, down onto the floor."""
    probe = Ledge6(stand, LEDGE6[0][1] - FEET)
    samples, _ = play(probe, [(400.0, 'space', True), (550.0, 'space', False)], 1400, sample=5)
    landed = next(s[0] for s in samples if s[0] > 500 and s[3])
    plan = [(400.0, 'space', True), (550.0, 'space', False), (landed, 'right', True), (landed + delay, 'space', True),
            (landed + delay + 100, 'right', False), (landed + delay + 150, 'space', False)]
    return play(Ledge6(stand, LEDGE6[0][1] - FEET), plan, landed + 1400, sample=20)  # a landing 35 ms before a jump, seen


def jump6_map(samples, keys, replay):
    track = [(t, x, y) for t, x, y, _, _ in samples]
    grounded = [s[3] for s in samples]
    graph = learn([('jq', track, grounded, [None] * len(track), keys, grounded)], 'n', 300)
    link, = graph['links']
    ground = P.Ground(LEDGE6_GROUND)
    link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: ground}, link['clip']['from'], link['clip']['to'])
    # its run-up is too short for the analysis to see it moving (the user's ran on from before the landing), so its
    # row is the one a running jump gets, by the same position_jump
    j = link['takeoffs'][-1]
    press = link['clip']['from'] + j['at']
    a, b = max((s for s in samples if s[0] <= press), key=lambda s: s[0]), min((s for s in samples if s[0] >= press), key=lambda s: s[0])
    x = a[1] + (b[1] - a[1]) * ((press - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0)  # where it was when pressed
    j.update(P.position_jump(MODEL, ground, 1, 1, x), demoX=round(x, 1), moving=True, dir=1, start=1, target=0)
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 6, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 800, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': {'arrivePx': 8, 'sync': 'grounded', 'ground': 'platforms', **replay}},
                             'platformer': {'model': MODEL, 'grounds': [[None, LEDGE6_GROUND]]}}})
    return b, link


class ZeroLengthPartTests(unittest.TestCase):
    """2026-10-20 02:35 and 02:38: the user's last movement's 6th jump, a running jump pressed by position from the end
    of a small ledge, was looked at only once the guard said the 0 ms part before it (Right, pressed on the landing)
    had completed, a frame later: by then the player was past its safe stretch, too near the edge to walk back, and it
    walked off. A part whose presses all go at its start is done once it's sent, so the jump is decided in the update
    it's sent in."""

    def test_the_analysis_is_the_user_s(self):
        samples, keys = jump6()
        _, link = jump6_map(samples, keys, {'takeoff': 'adaptive'})
        sync, = link['syncs']
        j = next(j for j in link['takeoffs'] if j['status'] == 'position')
        right = next(t for t, k, d in keys.events if k == 'right' and d) - link['clip']['from']
        self.assertAlmostEqual(sync['at'], right, delta=0.2, msg='Right is pressed on the landing it waits for')
        self.assertGreater(j['demoX'], j['window'][1], 'recorded past the latest safe press')
        b, _ = jump6_map(samples, keys, {'takeoff': 'adaptive'})
        mr = b.shared['maps']['m']
        segs = b._segments(mr.control.played(link, b.clips[f'link:{link["id"]}']), b._bounds(mr, link))
        self.assertEqual([(s['ms'], s['line'], s['trigger']['kind']) for s in segs if s['trigger'] and s['trigger']['kind'] == 'sync'],
                         [(0.0, [[0.0, 'right', True]], 'sync')], 'the part between the landing and the jump is Right alone, 0 ms')

    def test_its_jump_is_decided_in_the_update_its_part_is_sent(self):
        samples, keys = jump6()
        b, link = jump6_map(samples, keys, {'takeoff': 'adaptive'})
        game = Ledge6(354.0, LEDGE6[0][1] - FEET)
        out, events, sent = run_as_played(b, game)
        took = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(took and took[-1]['worked'], took)
        j = next(j for j in link['takeoffs'] if j['status'] == 'position')
        self.assertLessEqual(took[-1]['estX'], j['window'][1] + 0.01, 'pressed past the latest safe press')
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        # the 0 ms part and the jump went to the guard as one action, its presses in order and Right never let go
        merged = [e for e in events if e['kind'] == 'segment-merged']
        self.assertEqual(len(merged), 1, merged)
        jump, = [seq for _, seq in sent if any(k == 'space' for _, k, d in seq) and any(k == 'right' for _, k, d in seq)]
        self.assertEqual(jump[0], [0.0, 'right', True], 'Right down at its start, as the part before pressed it')
        self.assertLess(jump[0][0], next(ms for ms, k, d in jump if k == 'space' and d))
        self.assertNotIn([0.0, 'right', False], jump)

    def test_waiting_for_the_guard_s_word_instead_misses_it(self):
        # the same replay with the part treated as before: done only once the guard says so
        samples, keys = jump6()
        b, link = jump6_map(samples, keys, {'takeoff': 'adaptive'})
        b._segments = lambda clip, bounds, f=b._segments: [{**s, 'ms': max(s['ms'], 0.001)} for s in f(clip, bounds)]
        out, events, sent = run_as_played(b, Ledge6(354.0, LEDGE6[0][1] - FEET))
        took = [e for e in events if e['kind'] == 'takeoff']
        self.assertTrue(took and not took[-1]['worked'], took)
        self.assertIn('past its safe stretch', took[-1]['why'])

    def test_a_part_whose_trigger_waits_is_sent_alone(self):
        # the jump not due yet (standing, a run-up long enough): the 0 ms part goes out by itself, and the keys it
        # presses are held while the jump waits
        samples, keys = jump6(337.0, 200.0)
        b, link = jump6_map(samples, keys, {'takeoff': 'adaptive'})
        out, events, sent = run_as_played(b, Ledge6(337.0, LEDGE6[0][1] - FEET))
        self.assertIn([[0.0, 'right', True]], [seq for _, seq in sent], 'the part alone')
        self.assertFalse([e for e in events if e['kind'] == 'segment-merged'])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'link-end')])


# the user's ground line under the walk to the last movement (line 48): up a slope of 67 px in 55, then flat to its end
LINE48 = [[-1953.0, -1062.0], [-1898.0, -1129.0], [-1875.0, -1129.0]]
# what the user's taps had done before 02:37 (their map's `_taps`, none with a context yet): on flat ground, and down the slope
TAPS_BEFORE = [[50.0, 2.0], [25, 0.0], [25, 2.0], [25, 2.0], [50, 7.0], [60, 7.0], [50, 8.0], [25, 2.0], [25, 0.0], [25, 2.0], [25, 0.0],
               [25, 0.0], [25, 0.0], [25, 0.0], [25, 1.0], [80, 7.0], [25, 2.0], [25, 0.0], [25, 2.0], [100, 15.0], [100, 16.0], [25, 2.0],
               [25, 1.0], [25, 1.0], [100, 17.0]]


def slope_game(ms, way, x):
    """How far a tap `ms` long moves the player from x `way` on LINE48: up the slope it gets going about 40 ms later
    than on the flat (02:37: 25–50 ms taps up it moved 0–1 px, the same 50 ms on the flat 7)."""
    up = way > 0 and x < -1898
    return way * max(0.0, 0.12 * (ms - 40) if up else 0.17 * ms - 2)


class SlopeTapTests(unittest.TestCase):
    """2026-10-20 02:37: the correction of the user's movement to (-1900, -1127) went 17 px down the slope with one
    100 ms tap, to (-1904, -1122), and lining up with the next start (-1897, -1129), back up it, ran out of its 8 taps
    2.0 px off (Start within is 2 px): taps up the slope moved 0–1 px, and each was chosen from taps on the flat and down
    it. A tap's context, the ground's grade the way it taps by the model's lines, is kept with what it did, and taps are
    chosen from those in the same context."""

    def line_up(self, contexts=True):
        b = lining_up((-1897, -1129), [LINE48])
        mr = b.shared['maps']['m']
        mr.taps = {'x': [list(t) for t in TAPS_BEFORE]}
        if not contexts:
            mr.control.context = lambda *a: None
        ground = P.Ground([LINE48])
        x, t, taps, out = -1904.0, 0.0, [], None
        for _ in range(400):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, ground.y_on(0, x)]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):  # lined up (or not): the movement's own keys aren't a tap
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                way = 1 if key == 'right' else -1
                x += slope_game(ms, way, x)
                taps.append((key, ms))
            t += 50
        return b, out, taps, x

    def test_its_context_is_the_ground_the_way_it_taps(self):
        b = lining_up((-1897, -1129), [LINE48])
        mr = b.shared['maps']['m']
        y = P.Ground([LINE48]).y_on(0, -1904)
        self.assertEqual((mr.control.context(None, -1904, y, 1), mr.control.context(None, -1904, y, -1)), ('up steep', 'down steep'))
        self.assertEqual(mr.control.context(None, -1890, -1129, 1), 'flat')
        self.assertEqual(mr.control.context(None, -1898, -1129, 1), 'flat', 'at the corner, the segment it taps onto')
        self.assertIsNone(mr.control.context(None, -1904, y - 40, 1), 'off every line')

    def test_up_the_slope_it_lines_up_within_its_taps(self):
        b, out, taps, x = self.line_up()
        self.assertIsNone(out['done'], out['text'])
        self.assertLessEqual(len(taps), 8)
        self.assertLessEqual(abs(x + 1897), 2.0 + 0.01, 'Start within, as it was')
        mr = b.shared['maps']['m']
        new = mr.taps['x'][len(TAPS_BEFORE):]
        self.assertEqual(len(new), len(taps))
        self.assertTrue(all(len(t) == 3 for t in new), 'kept with their context')
        self.assertEqual([t[2] for t in new[:3]], ['up steep'] * 3, 'the taps up the slope')
        self.assertGreater(max(ms for k, ms in taps if k == 'right'), taps[0][1], 'longer once taps up the slope had moved it less')

    def test_without_contexts_it_runs_out_of_taps_as_it_did(self):
        b, out, taps, x = self.line_up(contexts=False)
        self.assertEqual(out['done'], 'failure')
        self.assertIn('after 8 taps', out['text'])

    def test_one_context_s_few_taps_don_t_hide_that_short_taps_move_it(self):
        # 02:59 and 03:00: the first line-up kept one 60 ms tap on the flat (8 px) as `flat`; chosen from the flat ones
        # alone, the shortest tap known to move the player was 60 ms, which could move it more than the 6 px a 3 px
        # correction may, and every later small line-up refused, though 25 ms taps (no context) move it 2 px
        flat = [[-1000.0, 176.0], [-800.0, 176.0]]
        b = lining_up((-871, 176), [flat])
        b.shared['maps']['m'].taps = {'x': [list(t) for t in TAPS_BEFORE] + [[60, 8.0, 'flat'], [60, 7.0, 'flat'], [60, 7.0, 'flat'], [60, 7.0, 'flat']]}
        out = LineUpTests().tap(b, -874, 176, 0)
        self.assertNotEqual(out['done'], 'failure', out['text'])
        (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
        self.assertEqual(key, 'right')
        self.assertLessEqual(b.shared['maps']['m'].control.tap_response('x', 'flat').upper(ms), 6.0, 'never more than it may move')

    def test_a_tap_is_chosen_from_its_own_context_and_all_of_them_without_one(self):
        r = TapResponse([[50, 7.0], [50, 1.0, 'up'], [100, 17.0, 'down']], 0.1, 'up')
        self.assertEqual((r.context, r.typical(50)), ('up', 1.0))
        r = TapResponse([[50, 7.0], [100, 17.0, 'down']], 0.1, 'up')
        self.assertIsNone(r.context, 'none up yet: every tap')
        self.assertEqual(r.typical(50), 7.0)
        # whether the game takes a tap that short is every tap's to say
        r = TapResponse([[25, 2.0], [60, 8.0, 'flat']], 0.1, 'flat')
        self.assertEqual((r.context, r.shortest_moving(), r.upper(25)), ('flat', 25.0, 2.0))


# the user's map's taps when the 03:04 correction swung: those kept before contexts, then the flat ones of 02:59–03:04
TAPS_0304 = [[50.0, 2.0], [25, 0.0], [25, 2.0], [25, 2.0], [50, 7.0], [60, 7.0], [50, 8.0], [25, 2.0], [25, 0.0], [25, 2.0], [25, 0.0], [25, 0.0],
             [25, 0.0], [25, 0.0], [25, 1.0], [80, 7.0], [25, 2.0], [25, 0.0], [25, 2.0], [100, 15.0], [100, 16.0], [25, 2.0], [25, 1.0], [25, 1.0],
             [100, 17.0], [25.0, 0.0], [50, 1.0], [50, 1.0], [50, 0.0], [50, 1.0], [30, 1.0], [25, 0.0], [25, 0.0], [25, 1.0], [30, 2.0], [80, 7.0],
             [30, 2.0], [50, 2.0], [25, 2.0], [50, 2.0], [25, 0.0], [25, 2.0], [70, 7.0], [30, 2.0], [50, 2.0], [25, 2.0], [25, 2.0], [25, 0.0],
             [25, 0.0], [25, 2.0], [200, 30.0], [100, 19.0], [25.0, 2.0], [40, 7.0], [40, 2.0], [80, 6.0], [70, 7.0], [80, 7.0], [25.0, 0.0],
             [40, 7.0], [60, 8.0, 'flat'], [60, 7.0, 'flat'], [60, 7.0, 'flat'], [60, 7.0, 'flat'], [50, 7.0, 'flat'], [30, 7.0, 'flat'],
             [25, 2.0, 'flat'], [25, 2.0, 'flat'], [25, 0.0, 'flat'], [25, 2.0, 'flat'], [25, 2.0, 'flat'], [25, 2.0, 'flat'], [25, 2.0, 'flat']]


def flat_game(ms):
    """How far a tap moves the player on the user's flat ground, by what their taps did: the game moves it in steps."""
    return 0.0 if ms < 25 else 2.0 if ms < 45 else 7.0 if ms < 80 else 15.0 if ms < 100 else 19.0 if ms < 140 else 22.0 if ms < 180 else 30.0


class ExpectedTapTests(unittest.TestCase):
    """2026-10-20 03:04: correcting a movement's end 12 px off on the flat (Arrive within 8), the taps went 150, 120, 100
    and 100 ms, each moving the player 15-22 px past, and it ended 4 px off after four. Untried lengths in the flat
    context had been estimated as half the most they could move; what a tap is expected to move now comes from what
    taps of about that length did, and the most it could still limits it."""

    def correct(self):
        b = lining_up((-1376, -672), [[[-1500.0, -672.0], [-1300.0, -672.0]]], start_px=8.0)
        b.shared['maps']['m'].taps = {'x': [list(t) for t in TAPS_0304]}
        x, t, taps = -1364.0, 0.0, []
        for _ in range(200):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, -672.0]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                x += flat_game(ms) * (1 if key == 'right' else -1)
                taps.append((key, ms))
            t += 50
        return out, taps, x

    def test_a_12_px_correction_on_the_flat_takes_one_tap(self):
        out, taps, x = self.correct()
        self.assertIsNone(out['done'], out['text'])
        self.assertEqual(len(taps), 1, taps)
        self.assertLessEqual(abs(x + 1376), 8.0)

    def old_estimate(self, overshoot=None, cap=True):
        import positioning, tap_response
        was, share, choose, stop = tap_response.TapResponse.typical, positioning.OVERSHOOT_SHARE, tap_response.TapResponse.choose, positioning.SWING_STOP

        def half(self, ms):  # the estimate before: untried lengths in a context as half the most they could move
            own = sorted(px for m, px in self.own if abs(m - ms) <= tap_response.TAP_NEAR * ms)
            return own[len(own) // 2] if own else (self.upper(ms) or 0.0) / 2 if self.own else was(self, ms)
        tap_response.TapResponse.typical = half
        if overshoot is not None:
            positioning.OVERSHOOT_SHARE = overshoot
        if not cap:  # nor stopping it swinging
            tap_response.TapResponse.choose = lambda self, need, allowed, first_ms, last_ms=None, cap_ms=None, also=(): choose(self, need, allowed, first_ms, last_ms)
            positioning.SWING_STOP = 1000
        try:
            return self.correct()
        finally:
            tap_response.TapResponse.typical, positioning.OVERSHOOT_SHARE, tap_response.TapResponse.choose, positioning.SWING_STOP = was, share, choose, stop

    def test_half_the_most_for_untried_lengths_swung_as_it_did(self):
        # with the estimate, the overshoot bound and the swing cap all as before: back and forth
        out, taps, x = self.old_estimate(overshoot=1.0, cap=False)
        self.assertGreaterEqual(len(taps), 3, taps)
        self.assertEqual([k for k, _ in taps[:3]], ['left', 'right', 'left'], 'back and forth')

    def test_either_newer_guard_alone_stops_that_swing(self):
        # the worst case at most half as far past (OVERSHOOT_SHARE): one shorter tap does it
        out, taps, x = self.old_estimate()
        self.assertLessEqual(len(taps), 2, taps)
        self.assertLessEqual(abs(x + 1376), 8.0)
        # "no further off than now" as before, but the tap after one that overshot capped at its own rate
        out, taps, x = self.old_estimate(overshoot=1.0)
        self.assertLessEqual(len(taps), 2, taps)
        self.assertLess(taps[1][1], taps[0][1], 'the second tap shorter than the one that overshot')
        self.assertLessEqual(abs(x + 1376), 8.0)

    def test_expected_and_most_are_apart(self):
        r = TapResponse(TAPS_0304, 0.1, 'flat')
        self.assertGreaterEqual(r.typical(120), 12, 'what taps about that long did')
        self.assertLess(r.typical(120), r.upper(120) + 0.01, 'never more than the most it could')
        # up a slope, taps elsewhere don't make it expected to move more than its own taps say it could
        up = TapResponse([*TAPS_0304, [50, 1.0, 'up'], [80, 2.0, 'up']], 0.1, 'up')
        self.assertLessEqual(up.typical(100), up.upper(100))
        self.assertLess(up.typical(100), 5)


SHELF_A, SHELF_B = ((100, 150), (420, 150)), ((298, 100), (420, 100))  # a long platform, and a ledge 50 px above its far end
FLOOR4 = ((0, 200), (600, 200))


class Shelves(Stage):
    PLATFORMS = (FLOOR4, SHELF_A, SHELF_B)


SHELVES_GROUND = [[[x, y - FEET] for x, y in p] for p in (FLOOR4, SHELF_A, SHELF_B)]


def jump4(start=160.0, delay=200.0):
    """The user's last movement's jumps 3 and 4 on the little platformer: walking right on the long platform, a hop
    played as recorded (Up held with it, so the model doesn't take it), and `delay` ms after it lands a running jump
    with Right let go of in the air (pressed by position), up onto the ledge, which it reaches only pressed at about
    255 or later."""
    g = Shelves(start, SHELF_A[0][1] - FEET)
    plan = [(400.0, 'right', True), (580.0, 'up', True), (600.0, 'space', True), (700.0, 'space', False), (760.0, 'up', False)]
    probe = Shelves(start, SHELF_A[0][1] - FEET)
    samples, _ = play(probe, plan, 1600, sample=5)
    landed = next(s[0] for s in samples if s[0] > 700 and s[3])
    plan += [(landed + delay, 'space', True), (landed + delay + 100, 'right', False), (landed + delay + 150, 'space', False)]
    return play(g, plan, landed + delay + 1400, sample=20)


def jump4_map(samples, keys, replay, landing_window=True):
    track = [(t, x, y) for t, x, y, _, _ in samples]
    grounded = [s[3] for s in samples]
    graph = learn([('jq4', track, grounded, [None] * len(track), keys, grounded)], 'n', 300)
    link, = graph['links']
    link['takeoffs'] = P.jumps(samples, keys, MODEL, {None: P.Ground(SHELVES_GROUND)}, link['clip']['from'], link['clip']['to'])
    if not landing_window:  # as before LandingWindowTests: the window only where it's safe to leave from
        for j in link['takeoffs']:
            if j['status'] == 'position':
                j.update(P.position_jump(MODEL, P.Ground(SHELVES_GROUND), j['start'], j['dir'], j['demoX']))
                j.pop('landingWindow', None)
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 10, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 800, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': {'startPx': 10, 'arrivePx': 8, 'sync': 'grounded', 'ground': 'platforms', **replay}},
                             'platformer': {'model': MODEL, 'grounds': [[None, SHELVES_GROUND]]}}})
    return b, link


class TakeoffRegionTests(unittest.TestCase):
    """2026-10-20 03:05: the user's last movement's jump 4, a running jump with keys changing in the air, is kept at its
    recorded delay after jump 3's landing, and jump 3 (played as recorded: the model is 35 px off on it) landed 4 px
    further back than usual: jump 4 was pressed 11.9 px short of where it was recorded and came down short of its
    ledge. It's now pressed within TAKEOFF_REGION_PX of there: no sooner than recorded, later if it has to be, never past
    its latest safe press."""

    def test_the_analysis_is_the_user_s(self):
        samples, keys = jump4()
        _, link = jump4_map(samples, keys, {'takeoff': 'adaptive'})
        hop, j = link['takeoffs']
        self.assertEqual(hop['status'], 'timed', hop)
        self.assertEqual(j['status'], 'position', j)
        self.assertTrue(link['syncs'], 'the jump waits for the hop to land')

    def run_it(self, behind, replay, landing_window=True):
        samples, keys = jump4()
        b, link = jump4_map(samples, keys, replay, landing_window)
        game = Shelves(160.0 - behind, SHELF_A[0][1] - FEET)
        out, events, sent = run_as_played(b, game)
        return out, events, game, link['takeoffs'][1]

    def test_landing_further_back_it_waits_to_be_where_the_jump_was_pressed(self):
        out, events, game, j = self.run_it(9.0, {'takeoff': 'adaptive'})
        took = [e for e in events if e['kind'] == 'takeoff' and e['index'] == 1]
        self.assertTrue(took and took[-1]['worked'], took)
        self.assertGreaterEqual(took[-1]['estX'], j['demoX'] - 4.0 - 0.01, 'within its takeoff region')
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'sync', 'link-end')])
        self.assertAlmostEqual(game.y, SHELF_B[0][1] - FEET, delta=1, msg='on the ledge')

    def test_timed_replay_presses_it_short_and_misses_the_ledge(self):
        out, events, game, j = self.run_it(9.0, {'takeoff': 'timed'})
        self.assertNotEqual(out['done'], 'success')
        self.assertGreater(game.y, SHELF_B[0][1], 'it never got up onto the ledge')

    def test_kept_at_its_recorded_delay_alone_it_missed_as_jump_4_did(self):
        import platformer_control
        was = platformer_control.TAKEOFF_REGION_PX
        platformer_control.TAKEOFF_REGION_PX = 1e9  # no takeoff region: its recorded delay after the landing, as before
        try:  # and no bound from its landing's room on the ledge (LandingWindowTests), which keeps it from this too
            out, events, game, j = self.run_it(9.0, {'takeoff': 'adaptive'}, landing_window=False)
        finally:
            platformer_control.TAKEOFF_REGION_PX = was
        took = [e for e in events if e['kind'] == 'takeoff' and e['index'] == 1]
        self.assertLess(took[-1]['estX'], j['demoX'] - 8, 'pressed short')
        self.assertNotEqual(out['done'], 'success')

    def test_where_the_jump_was_recorded_it_keeps_its_recorded_delay(self):
        out, events, game, j = self.run_it(0.0, {'takeoff': 'adaptive'})
        took = [e for e in events if e['kind'] == 'takeoff' and e['index'] == 1]
        self.assertTrue(took and took[-1]['worked'])
        self.assertLessEqual(abs(took[-1]['estX'] - j['demoX']), 4.0 + 0.5, 'pressed about where it was recorded, at its time')
        self.assertEqual(out['done'], 'success')


class Half(Game):
    """The platformer walking at half the speed it was recorded at: a walk ends halfway (the user's 14 px walk moved the
    player 7 px about half the time, the game moving it in steps)."""
    WALK = 0.05


def short_walk():
    """Standing at 100, Right for 140 ms (14 px), standing; then Right for a second, standing at about 214."""
    return play(Game(100), [(400.0, 'right', True), (540.0, 'right', False), (1400.0, 'right', True), (2400.0, 'right', False)], 3000)


def walk_map(replay):
    samples, keys = short_walk()
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('walk', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    grounds = {None: P.Ground(GROUND)}
    for l in graph['links']:
        l['takeoffs'] = P.jumps(samples, keys, MODEL, grounds, l['clip']['from'], l['clip']['to'])
        l['finish'] = P.finish(samples, keys, MODEL, grounds, l['clip']['from'], l['clip']['to'])
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 2, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g2'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': 3, 'arriveMs': 400, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': {'startPx': 2, 'sync': 'grounded', 'ground': 'platforms',
                                                 'lineUp': {'x': {'less': ['left'], 'more': ['right']}}, **replay}},
                             'platformer': {'model': MODEL, 'grounds': [[None, GROUND]]}}})
    return b, graph


class WalkEndTests(unittest.TestCase):
    """2026-10-20 03:21-03:29: the user's 14 px walk (-1753, -520) to (-1739, -520) moved the player 7 px in 6 of 12
    attempts. It was judged by its place's reach (Start within, 2 px), not Arrive within (8), and walks had no end
    correction; and recovering, the map took its start (as near as its end) as where the player was, lined up back to
    it and replayed the walk, three times, and gave up on it."""

    def test_a_walk_s_ending_is_correctable(self):
        b, graph = walk_map({'takeoff': 'adaptive', 'arrivePx': 8})
        f = graph['links'][0]['finish']
        self.assertEqual((f['status'], f['walk'], f['drop']), ('correct', True, []), 'its presses are the movement')

    def test_ending_7_px_short_it_counts_within_arrive_within_and_goes_on_from_its_end(self):
        b, graph = walk_map({'takeoff': 'adaptive', 'arrivePx': 8})
        walk, on = graph['links'][0]['id'], graph['links'][1]['id']
        out, events, sent = run(b, Half(100), limit=3000)
        ended = next(e for e in events if e['kind'] == 'link-end' and e['link'] == walk)
        self.assertEqual((ended['worked'], ended.get('arrival')), (True, 'direct'), ended)
        began = [e['link'] for e in events if e['kind'] == 'link']
        self.assertEqual(began[:2], [walk, on], 'on from its end, not the walk again')
        lined = [e for e in events if e['kind'] == 'line-up']
        self.assertTrue(lined and lined[0]['target'][0] > 110, ('it lined up with the next movement', lined[:1]))

    def test_with_a_tighter_arrive_within_it_is_tapped_onto_its_end(self):
        b, graph = walk_map({'takeoff': 'adaptive', 'arrivePx': 4})
        walk = graph['links'][0]['id']
        out, events, sent = run(b, Half(100), limit=3000)
        ended = next(e for e in events if e['kind'] == 'link-end' and e['link'] == walk)
        fin = next(e for e in events if e['kind'] == 'finish' and e['link'] == walk)
        self.assertEqual((ended['worked'], ended.get('arrival'), fin['corrections'] >= 1), (True, 'corrected', True), fin)
        self.assertTrue(all(t['keys'] == ['right'] for t in fin['taps']), 'toward its end')


class MidpointRecoveryTests(unittest.TestCase):
    """A movement that ended on its destination's platform, short of its place, goes on from its destination: with the
    player midway, its start and end are equally near, and taking the start sent it back and replayed the movement."""

    def test_midway_it_goes_on_toward_its_end(self):
        b, graph = walk_map({'takeoff': 'timed', 'arrivePx': 4})  # timed: no end correction, the recovery as it was
        walk, on = graph['links'][0]['id'], graph['links'][1]['id']
        out, events, sent = run(b, Half(100), limit=3000)
        ended = next(e for e in events if e['kind'] == 'link-end' and e['link'] == walk)
        self.assertEqual((ended['worked'], ended.get('pending')), (False, True), 'on its platform, short of its place')
        began = [e['link'] for e in events if e['kind'] == 'link']
        self.assertEqual(began[:2], [walk, on], 'not the walk again from its start')
        recovered = next(e for e in events if e['kind'] == 'link-recovered' and e['link'] == walk)
        self.assertTrue(recovered['worked'], recovered)

    def test_off_its_platform_it_still_goes_back_to_the_nearest_place(self):
        b, graph = walk_map({'takeoff': 'timed', 'arrivePx': 4})
        mr = b.shared['maps']['m']
        link = graph['links'][0]
        self.assertFalse(mr.control.recoverable(link, None, link['end'][0] - 7, LEDGE[0][1] - FEET, 0.0, 7), 'another line: no pending, no going on')


BUMP = [[-1840.0, -980.0], [-1825.0, -994.0], [-1814.0, -1002.0], [-1802.0, -1005.0], [-1700.0, -1005.0]]  # by (-1813, -1002)
# what taps up the map's long slopes had done by then (their line-ups: 50 ms 1 px, 80 ms 1-3, 100 ms 2-4, 120 ms 4)
UP_STEEP = [[50, 1.0, 'up steep'], [50, 1.0, 'up steep'], [80, 1.0, 'up steep'], [80, 3.0, 'up steep'], [70, 3.0, 'up steep'],
            [100, 4.0, 'up steep'], [100, 2.0, 'up steep'], [120, 4.0, 'up steep'], [120, 4.0, 'up steep']]


class SteepnessTapTests(unittest.TestCase):
    """2026-10-20 03:28: lining up 4 px from (-1813, -1002), up an 11 px bump of 0.73, a 120 ms tap chosen from taps up
    the map's long slopes (1.22: 80-120 ms moved the player 1-4 px) moved it 18 px, and it took 7 taps. Taps are kept by
    how steep the ground is too, and a gentle incline with no taps of its own goes by every tap."""

    def line_up(self, steep_everywhere=False):
        b = lining_up((-1813, -1002), [BUMP])
        mr = b.shared['maps']['m']
        mr.taps = {'x': [list(t) for t in TAPS_BEFORE] + [list(t) for t in UP_STEEP]}
        if steep_everywhere:  # as before steepness was told apart: every incline one context
            context = mr.control.context

            def steep(*a):
                c = context(*a)
                return c.replace('gentle', 'steep') if c else c
            mr.control.context = steep
        ground = P.Ground([BUMP])
        x, t, taps = -1817.0, 0.0, []
        for _ in range(300):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, ground.on(x, -1000, within=20)[1]]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                x += flat_game(ms) * (1 if key == 'right' else -1)
                taps.append((key, ms))
            t += 50
        return out, taps, x

    def test_its_steepness_is_the_ground_s(self):
        b = lining_up((-1813, -1002), [BUMP])
        mr = b.shared['maps']['m']
        g = P.Ground([BUMP])
        self.assertEqual(mr.control.context(None, -1817, g.y_on(0, -1817), 1), 'up gentle')
        self.assertEqual(mr.control.context(None, -1817, g.y_on(0, -1817), -1), 'down gentle')
        self.assertEqual(mr.control.context(None, -1750, -1005, 1), 'flat')

    def test_up_a_gentle_incline_steep_slope_taps_don_t_count(self):
        out, taps, x = self.line_up()
        self.assertIsNone(out['done'], out['text'])
        self.assertLessEqual(len(taps), 2, taps)
        self.assertLessEqual(taps[0][1], 50, 'a short tap, by every tap')
        self.assertLessEqual(abs(x + 1813), 2.0)

    def test_taken_for_the_steep_slope_it_overshot(self):
        out, taps, x = self.line_up(steep_everywhere=True)
        self.assertGreaterEqual(taps[0][1], 80, taps)
        self.assertEqual([k for k, _ in taps[:2]], ['right', 'left'], ('it overshot and had to come back', taps))

    def test_a_context_with_no_taps_falls_back_to_every_tap_and_its_most(self):
        r = TapResponse([*TAPS_BEFORE, *UP_STEEP], 0.1, 'up gentle')
        self.assertIsNone(r.context)
        self.assertLess(r.typical(40), 8)
        self.assertLessEqual(r.typical(120), r.upper(120))


UPPER = ((200, 150), (300, 150))  # a platform 50 px up, reached by a standing jump from under it


class Upper(Stage):
    PLATFORMS = (FLOOR4, UPPER)


class HalfUpper(Upper):
    WALK = 0.05


class SlowUpper(Upper):
    WALK = 0.02  # a fifth as far: jumping 32 px from where it was recorded, past what the trajectory monitor allows


UPPER_GROUND = [[[x, y - FEET] for x, y in p] for p in (FLOOR4, UPPER)]


def walk_and_hop():
    """The user's movement to (-1900, -1127) on the little platformer: from 330 on the floor, Left for 400 ms (to 290,
    under the platform), a moment still, a jump straight up onto the platform, and Right pressed in the air 100 ms
    before it lands and let go of 70 ms after (7 px: a nudge the end correction leaves out)."""
    probe = Upper(330)
    plan = [(400.0, 'left', True), (800.0, 'left', False), (870.0, 'space', True), (1020.0, 'space', False)]
    samples, _ = play(probe, plan, 2000, sample=5)
    landed = next(s[0] for s in samples if s[0] > 1000 and s[3])
    plan += [(landed - 100, 'right', True), (landed + 70, 'right', False)]
    return play(Upper(330), plan, landed + 900, sample=10)


def hop_map(replay, give_up=1):
    samples, keys = walk_and_hop()
    track = [(t, x, y) for t, x, y, _, _ in samples]
    grounded = [s[3] for s in samples]
    graph = learn([('hop2', track, grounded, [None] * len(track), keys, grounded)], 'n', 300)
    link, = graph['links']
    grounds = {None: P.Ground(UPPER_GROUND)}
    link['finish'] = P.finish(samples, keys, MODEL, grounds, link['clip']['from'], link['clip']['to'])
    dropped = [(link['clip']['from'] + at, k) for at, k in link['finish']['drop']] if link['finish']['status'] == 'correct' else []
    link['takeoffs'] = P.jumps(samples, keys, MODEL, grounds, link['clip']['from'], link['clip']['to'], dropped)
    plain = P.jumps(samples, keys, MODEL, grounds, link['clip']['from'], link['clip']['to'])
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 2, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                 maps={'m': {'position': 'player', 'giveUp': give_up, 'arriveMs': 400, 'linkMs': 100, 'places': places, 'links': graph['links'],
                             'grid': {'replay': {'startPx': 2, 'arrivePx': 8, 'sync': 'grounded', 'ground': 'platforms',
                                                 'lineUp': {'x': {'less': ['left'], 'more': ['right']}, 'range': 60}, **replay}},
                             'platformer': {'model': MODEL, 'grounds': [[None, UPPER_GROUND]]}}})
    return b, link, plain


class AsPlayedJumpTests(unittest.TestCase):
    """2026-10-20 03:42-03:49: the user's movement to (-1900, -1127) failed 3 of 7 times, each after a slow first jump
    (its 49 ms run-up given one game step instead of two) left the player at -1871 to -1874: its second jump, straight
    up, wasn't under the platform above, and played as recorded it went up and came down where it was. Its only key
    changing in the air was the Right the end correction leaves out: judged without it, it's a standing jump the model
    knows, and the player is tapped into its stretch first."""

    def test_without_the_left_out_right_it_is_a_standing_jump_the_model_knows(self):
        b, link, plain = hop_map({'takeoff': 'adaptive'})
        self.assertEqual(plain[0]['status'], 'timed', 'with its Right, as before')
        self.assertIn('keys change in the air', plain[0]['why'])
        j, = link['takeoffs']
        self.assertEqual((j['status'], j['asPlayed'], j['moving']), ('adapt', True, False), j)
        self.assertTrue(j['window'][0] <= j['demoX'] <= j['window'][1] < UPPER[1][0])

    def test_short_of_it_the_player_is_tapped_under_the_platform_and_gets_up(self):
        b, link, _ = hop_map({'takeoff': 'adaptive'})
        game = HalfUpper(330)  # walking half as far: 310, past the platform's end
        out, events, sent = run(b, game, limit=6000)
        moved = [e for e in events if e['kind'] == 'stand-reposition']
        self.assertTrue(moved and moved[0]['worked'], [e for e in events if e['kind'] in ('takeoff', 'link-end')])
        self.assertLessEqual(moved[0]['toX'], link['takeoffs'][0]['window'][1])
        self.assertEqual(out['done'], 'success', [e for e in events if e['kind'] in ('takeoff', 'stand-reposition', 'link-end')])
        self.assertAlmostEqual(game.y, UPPER[0][1] - FEET, delta=1)
        self.assertFalse(any(k == 'right' and d and ms > 0 for _, seq in sent for ms, k, d in seq if ms > 300), 'its Right left out')

    def test_where_its_right_is_played_it_stays_timed(self):
        # without Line up with taps there's no end correction, so its Right is played: the jump is as recorded
        b, link, _ = hop_map({'takeoff': 'adaptive', 'lineUp': None})
        mr = b.shared['maps']['m']
        self.assertFalse([x for x in b._bounds(mr, link) if x['kind'] == 'takeoff'])


class SettleTests(unittest.TestCase):
    """After a recorded movement fails (here a deviation, which used to end the tree), every key is let go of, nothing
    is planned while the player is in the air or moving, and once it's on the ground and still the map plans from where
    it is, the failure counted against its link (Give up)."""

    def test_a_deviation_lets_go_waits_for_the_landing_and_plans_again(self):
        b, link, _ = hop_map({'takeoff': 'timed'}, give_up=2)  # timed: played as recorded, it jumps where it is
        game = SlowUpper(330)
        frames, tick = [], b.tick

        def watched(now, values, **kw):
            out = tick(now, values, **kw)
            frames.append((game.ground, set(out['keys']), out['sequence'], out['events']))
            return out
        b.tick = watched
        out, events, sent = run(b, game, limit=12000)
        ends = [e for e in events if e['kind'] == 'link-end']
        self.assertGreaterEqual(len(ends), 2, ('it planned again after the first failure', ends))
        self.assertEqual(ends[0]['cause'], 'deviation')
        first = next(n for n, f in enumerate(frames) if any(e['kind'] == 'link-end' for e in f[3]))
        self.assertEqual((frames[first][1], frames[first][2]), (set(), []), 'everything let go of as it failed')
        second = next(n for n, f in enumerate(frames) if n > first and any(e['kind'] in ('link', 'line-up') for e in f[3]) or (n > first and f[2]))
        self.assertTrue(all(not k and not seq for _, k, seq, _ in frames[first + 1:second]), 'nothing held or sent until it planned again')
        self.assertTrue(frames[second][0], 'planned again only on the ground')
        mr = b.shared['maps']['m']
        self.assertEqual(mr.stats[link['id']]['fails'], len([e for e in ends if not e['worked']]), 'each counted against its link')
        self.assertEqual(out['done'], 'failure')
        self.assertIn('no way', out['text'], 'given up on after Give up failures')

# the user's second jump quest's walk to (438, -342) (line 38): up a gentle slope, a flat top to 439, then down to its end
LINE38 = [[385.0, -329.0], [410.0, -329.0], [413.0, -335.0], [419.0, -340.0], [423.0, -342.0], [439.0, -342.0], [445.0, -339.0],
          [450.0, -333.0], [454.0, -333.0], [458.0, -330.0], [460.0, -327.0]]


class CrestTests(unittest.TestCase):
    """2026-10-20 14:23 and 14:35: the walk to (438, -342) stopped 15-16 px short, and its end correction sent one 250 ms
    tap, allowed because its worst case stayed short of the line's end, 37 px on. It carried the player 2 px past the
    crest at 439, and with nothing held it slid down the slope beyond and off the line's end, both runs. The movement
    model's safe ground stops at a downhill past the target (Ground.safe_room)."""

    def test_safe_ground_stops_at_a_downhill_past_the_target(self):
        g = P.Ground([LINE38])
        self.assertAlmostEqual(g.safe_room(0, 423, 1, beyond=438), 16.0, 'to the crest, not the line’s end')
        self.assertAlmostEqual(g.safe_room(0, 423, -1, beyond=405), 423 - 385, msg='down to its target and on: the way there is fine')
        self.assertAlmostEqual(g.safe_room(0, 423, 1, beyond=452), 454 - 423, msg='a target on the flat bit below: to its end')
        self.assertAlmostEqual(g.safe_room(0, 423, 1, beyond=447), 447 - 423, msg='a target on the slope: no further than it')
        flat = P.Ground([[[0.0, 0.0], [200.0, 0.0]]])
        self.assertAlmostEqual(flat.safe_room(0, 50, 1, beyond=100), 150.0, msg='flat ground: its end')

    def correct(self, crest_rule=True):
        b = lining_up((438, -342), [LINE38], start_px=8.0)
        b.shared['maps']['m'].taps = {'x': [list(t) for t in TAPS_0304]}
        if not crest_rule:  # as before: only the line's end bounds a tap
            b.shared['maps']['m'].dynamics['grounds'][None].safe_bound = lambda k, x, way, beyond=None, grade=None: ((460 - x) if way > 0 else (x - 385), 'end')
        ground = P.Ground([LINE38])
        x, t, taps, crossed = 423.0, 0.0, [], False
        for _ in range(200):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, ground.on(x, -340, within=20)[1]]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                x += flat_game(ms) * (1 if key == 'right' else -1)
                taps.append((key, ms))
                if x > 439:  # past the crest: it slides on down to the line's end, and off
                    crossed = True
                    break
            t += 50
        return out, taps, x, crossed

    def test_the_correction_stays_short_of_the_crest(self):
        out, taps, x, crossed = self.correct()
        self.assertFalse(crossed, taps)
        self.assertIsNone(out['done'], out['text'])
        self.assertLessEqual(abs(x - 438), 8.0, taps)

    def test_bounded_by_the_line_s_end_alone_it_went_over(self):
        out, taps, x, crossed = self.correct(crest_rule=False)
        self.assertTrue(crossed, taps)

    def test_a_downhill_on_the_way_to_the_target_is_walked_down(self):
        # a flat top, a slope down, and the target on the flat ground below it: the slope is the way there
        line = [[0.0, 0.0], [50.0, 0.0], [80.0, 30.0], [200.0, 30.0]]
        b = lining_up((85, 30), [line], start_px=4.0)
        b.shared['maps']['m'].taps = {'x': [list(t) for t in TAPS_0304]}
        ground = P.Ground([line])
        x, t, taps = 49.0, 0.0, []  # 47 px from it, within lining up’s range
        for _ in range(300):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, ground.on(x, ground.y_on(0, x), within=1)[1]]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                x += flat_game(ms) * (1 if key == 'right' else -1)
                if 50 < x < 80:
                    x = 80.0  # on the slope it slides to its foot
                taps.append((key, ms))
            t += 50
        self.assertNotEqual(out['done'], 'failure', (out['text'], taps))
        self.assertLessEqual(abs(x - 85), 4.0, taps)


if __name__ == '__main__':
    unittest.main()
