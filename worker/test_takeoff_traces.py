"""The user's jump quests on 2026-10-20 at 14:52-14:54, each failure's jump as its recording and its trace had it (the
recorded samples around it, the play readings up to where the trace's own press changed what followed): the analysis
(platformer.jumps) and the executor's decision (Behavior._takeoff) as they are now, and as they were."""
import unittest

import platformer as P
from behavior import Behavior
from keys import Keys, clip

# The second jump quest's movement 6, jump 3 (14:54:34): from the platform at -498 up onto the one at -558, whose right
# end is 303, landing (its first reading on the ground) at 295. Its last reading On Ground was already 16 px up
SAMPLES_A = [(0.0, 401.0, -633.0, False), (56.7, 397.0, -629.0, False), (74.1, 393.0, -623.0, False), (130.8, 386.0, -607.0, False),
             (189.0, 378.0, -582.0, False), (240.5, 371.0, -551.0, False), (277.5, 367.0, -532.0, False), (333.6, 360.0, -498.0, True),
             (391.7, 354.0, -498.0, True), (432.8, 346.0, -514.0, True), (487.8, 343.0, -527.0, False), (541.7, 335.0, -550.0, False),
             (583.9, 331.0, -560.0, False), (647.1, 324.0, -572.0, False), (693.9, 316.0, -576.0, False), (730.1, 312.0, -576.0, False),
             (783.0, 305.0, -570.0, False), (824.8, 301.0, -564.0, False), (877.7, 295.0, -558.0, True), (939.2, 288.0, -558.0, True),
             (974.3, 280.0, -558.0, True), (1034.1, 273.0, -574.0, False), (1098.8, 266.0, -600.0, False), (1147.8, 262.0, -611.0, False),
             (1182.6, 258.0, -619.0, False)]
EVENTS_A = [(-1.0, 'left', True), (399.6, 'space', True), (577.5, 'space', False), (999.5, 'space', True), (1183.5, 'space', False)]
LINES_A = [[[327.0, -498.0], [393.0, -498.0]], [[237.0, -558.0], [303.0, -558.0]], [[147.0, -498.0], [213.0, -498.0]],
           [[417.0, -558.0], [483.0, -558.0]]]
MODEL_2 = {'walk': 0.1205, 'jump': 0.5633, 'gravity': 0.002035, 'fall': 0.5609, 'jumpKey': 'space', 'leftKey': 'left', 'rightKey': 'right',
           'delays': [-10.0, 3.0, 29.0], 'leaveMs': 76.1}

# The first jump quest's movement g2 -> g3, jump 5 (14:52:27): a running jump with Right let go of in the air, from the
# platform at -219 (its right end -2102) onto the one at -204 (-2045..-1997), landing at -2037: 8 px inside it
SAMPLES_B = [(0.0, -2157.0, -235.0, False), (55.0, -2149.0, -247.0, False), (108.2, -2142.0, -252.0, False), (143.3, -2139.0, -252.0, False),
             (202.1, -2131.0, -245.0, False), (257.8, -2123.0, -232.0, False), (296.6, -2120.0, -224.0, False), (349.1, -2114.0, -219.0, True),
             (407.1, -2107.0, -235.0, False), (442.9, -2104.0, -248.0, False), (496.1, -2096.0, -272.0, False), (548.4, -2092.0, -280.0, False),
             (607.1, -2085.0, -292.0, False), (642.3, -2081.0, -296.0, False), (704.1, -2074.0, -297.0, False), (742.4, -2066.0, -291.0, False),
             (796.7, -2059.0, -277.0, False), (857.3, -2055.0, -269.0, False), (904.0, -2048.0, -244.0, False), (940.7, -2044.0, -230.0, False),
             (999.5, -2037.0, -204.0, True), (1047.2, -2035.0, -204.0, True), (1113.3, -2034.0, -204.0, True), (1155.2, -2034.0, -221.0, False)]
EVENTS_B = [(-1.0, 'right', True), (-1.0, 'space', True), (46.0, 'space', False), (377.9, 'space', True), (576.3, 'space', False),
            (827.2, 'right', False), (1119.0, 'space', True)]
LINES_B = [[[-2195.0, -174.0], [-2150.0, -174.0]], [[-2150.0, -219.0], [-2102.0, -219.0]], [[-2045.0, -204.0], [-1997.0, -204.0]],
           [[-2045.0, -259.0], [-1997.0, -259.0]],
           [[-2243.0, -124.0], [-2167.0, -124.0], [-2115.0, -124.0], [-2025.0, -124.0], [-1973.0, -124.0], [-1897.0, -124.0]]]
MODEL_1 = {'walk': 0.1223, 'jump': 0.5621, 'gravity': 0.002026, 'fall': 0.5713, 'jumpKey': 'space', 'leftKey': 'left', 'rightKey': 'right',
           'delays': [-11.0, -1.0, 23.0], 'leaveMs': 76.2}


def analysed(samples, events, lines, model, calibration=None):
    s = [(t, x, y, g, None) for t, x, y, g in samples]
    return P.jumps(s, Keys(list(events)), model, {None: P.Ground(lines)}, s[0][0], s[-1][0], calibration=calibration)


def executor(model, lines, trajectory=None):
    """A map of one recorded movement on these lines and this model, to ask Behavior._takeoff about."""
    link = {'id': 'L', 'from': 'a', 'to': 'b', 'kind': 'clip', 'recorded': True, 'clip': {'recording': 'r', 'from': 0.0, 'to': 2000.0},
            'ms': 2000.0, 'trajectory': trajectory or [[0.0, 0.0, 0.0], [2000.0, 0.0, 0.0]], 'takeoffs': []}
    places = [{'id': 'a', 'x': 0, 'y': 0, 'level': None, 'reach': 24}, {'id': 'b', 'x': 500, 'y': 0, 'level': None, 'reach': 24}]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'b'}, 'children': []}}}
    b = Behavior(tree, [{'name': 'player', 'type': 'vector'}], clips={'link:L': clip(Keys([]), 0.0, 2000.0)},
                 maps={'m': {'position': 'player', 'places': places, 'links': [link],
                             'grid': {'replay': {'arrivePx': 8, 'takeoff': 'adaptive', 'ground': 'platforms'}},
                             'platformer': {'model': model, 'grounds': [[None, lines]]}}})
    return b, b.shared['maps']['m']


def decide(b, mr, row, readings, keep, landed=None, rec0=0.0, from_landing=True, gap=21.0):
    """The executor asked about `row` at each reading [(observed, now, x, y)] in turn, its part begun on a landing
    observed at `landed` (the recording's at rec0), as play asks it: (its answer, the reading it came at, st)."""
    st = {'link': 'L', 'frameGap': gap, 'anchor': (landed, rec0) if from_landing else (None, 0.0), 'segStart': readings[0][1], 'seg': 0,
          'segs': [{'trigger': {'kind': 'sync' if from_landing else 'takeoff'}, 'keep': keep, 'line': [], 'held': 0}], 'readings': []}
    trigger = {'jump': row, 'index': 0, 'at': row['at'], 'kind': 'takeoff'}
    said = st['said'] = []
    for t, now, x, y in readings:
        b.now, b.shared['observation_time'], b.frames, b.shared['events'] = now, t, [{}], []
        st['readings'] = [r for r in st['readings'] if r[0] >= t - 150] + [(t, x)]
        go = mr.control._takeoff(b, st, trigger, None, x, y)
        said += b.shared['events']
        if go is not None:
            return go, (t, now, x, y), st
    return None, None, st


class StaleTakeoffTests(unittest.TestCase):
    """A: the second jump quest's movement 6 jump 3 was played as recorded ('not from and to a ground line'): On Ground
    was still true at a reading 16 px above the platform. Pressed 2-3 px later than recorded it came down at about 304,
    past the end of the platform at 303, and fell."""

    def test_its_takeoff_is_the_last_reading_on_the_ground(self):
        j = analysed(SAMPLES_A, EVENTS_A, LINES_A, MODEL_2)[0]
        self.assertEqual((j['y'], j['start'], j['target']), (-498.0, 0, 1), j)
        self.assertNotEqual(j['status'], 'timed', j)

    def test_as_before_it_read_as_not_from_a_line(self):
        was = P._on_ground_at
        P._on_ground_at = lambda samples, i, ground: i
        try:
            j = analysed(SAMPLES_A, EVENTS_A, LINES_A, MODEL_2)[0]
        finally:
            P._on_ground_at = was
        self.assertEqual((j['status'], j['why']), ('timed', 'not from and to a ground line'))

    def test_a_reading_not_above_its_line_isn_t_moved_back(self):
        # walked off the end of a line (the next reading beside it, not above it): not a stale takeoff
        g = P.Ground([[[0.0, 100.0], [50.0, 100.0]]])
        s = [(0.0, 40.0, 100.0, True, None), (40.0, 46.0, 100.0, True, None), (80.0, 53.0, 100.0, True, None), (120.0, 58.0, 104.0, False, None)]
        self.assertEqual(P._on_ground_at(s, 2, g), 2)
        s[2] = (80.0, 49.0, 84.0, True, None)  # risen 16 px: in the air already
        self.assertEqual(P._on_ground_at(s, 2, g), 1)
        s[2] = (200.0, 49.0, 84.0, True, None)  # but not after a gap longer than TAKE_STALE_MS
        self.assertEqual(P._on_ground_at(s, 2, g), 2)


class NearMissTests(unittest.TestCase):
    """A, then: the model at its recorded press lands it at 303.2, just past the platform's end (303): 'lands it
    elsewhere', so it stayed played as recorded. It's the model's error, 8.5 px off the landing, so the margin grows by
    it, and the jump is pressed from the narrow stretch where the model lands it 10.5 px inside at every delay."""

    def test_a_small_miss_is_the_model_s_error(self):
        j = analysed(SAMPLES_A, EVENTS_A, LINES_A, MODEL_2)[0]
        self.assertEqual(j['status'], 'narrow', j)
        self.assertAlmostEqual(j['modelErr'], 8.5, delta=0.6)
        self.assertLess(abs(j['nearMiss']), 2.0)
        self.assertAlmostEqual(j['margin'], abs(j['modelErr']) + 2, delta=0.01)
        lo, hi = j['interval']
        self.assertTrue(lo <= j['aim'] <= hi, j)
        self.assertLess(hi, j['demoX'] - 10, 'well short of where the recording pressed it (its landing had 3-8 px)')
        ground = P.Ground(LINES_A)
        for d in MODEL_2['delays']:
            line, x = P.press_landing(MODEL_2, ground, 0, j['aim'], -MODEL_2['walk'], -MODEL_2['walk'], d)
            self.assertEqual(line, 1)
            self.assertLessEqual(x, 303 - 10, f'at a delay of {d} ms')

    def test_a_miss_further_than_the_model_s_error_is_still_one_it_doesn_t_know(self):
        # a model walking two thirds as fast: it lands the jump 17 px past the platform's end, more than MODEL_MAX_PX
        j = analysed(SAMPLES_A, EVENTS_A, LINES_A, {**MODEL_2, 'walk': 0.08})[0]
        self.assertEqual((j['status'], j['why']), ('timed', 'the model lands it elsewhere'))

    def test_played_from_the_trace_it_presses_in_the_stretch(self):
        j = analysed(SAMPLES_A, EVENTS_A, LINES_A, MODEL_2)[0]
        b, mr = executor(MODEL_2, LINES_A)
        # the trace's readings after landing (its own press came at 355), then walking on left
        reads = [(0.0, 17.0, 361.0, -499.0), (21.0, 38.0, 358.0, -498.0), (42.0, 59.0, 358.0, -498.0), (62.0, 79.0, 355.0, -498.0)]
        reads += [(62.0 + 21 * n, 79.0 + 21 * n, 355.0 - MODEL_2['walk'] * 21 * n, -498.0) for n in range(1, 12)]
        go, at, _ = decide(b, mr, j, reads, ['left'], landed=0.0, rec0=j['at'] - 67.5)
        self.assertIsNotNone(go, 'it presses')
        self.assertNotIn('fail', go)
        lo, hi = j['interval']
        self.assertTrue(lo - 0.5 <= go['estX'] <= hi + 0.5, go)


class LandingWindowTests(unittest.TestCase):
    """B: the first jump quest's g2 -> g3 jump 5 (keys changing in the air, pressed by position) was pressed 6 px before
    where the recording pressed it (its 4 px takeoff region and 2 px of estimate) and came down 1 px short of the
    platform its recording landed 8 px inside. Its window now also keeps the landing, the arc moved with the press,
    LAND_MARGIN + UNCHECKED_PX inside the platform."""

    def test_its_window_keeps_its_landing_inside(self):
        j = analysed(SAMPLES_B, EVENTS_B, LINES_B, MODEL_1)[0]
        self.assertEqual(j['status'], 'position', j)
        self.assertEqual(j['window'], [-2109.2, -2106.8])
        self.assertEqual(j['landingWindow'][0], -2109.2, '2 px after where it was recorded: 8 px of room, 10 needed')
        self.assertEqual(j['aim'], -2109.2)

    def test_with_no_room_it_s_the_latest_safe_press(self):
        lines = [LINES_B[0], LINES_B[1], [[-2040.0, -204.0], [-1997.0, -204.0]], *LINES_B[3:]]  # landed 3 px inside: no room
        j = analysed(SAMPLES_B, EVENTS_B, lines, MODEL_1)[0]
        self.assertEqual(j['window'][0], j['window'][1])
        self.assertEqual(j['window'][1], -2106.8, 'the latest press safe to leave from')

    def run_trace(self, landing_window=True):
        j = analysed(SAMPLES_B, EVENTS_B, LINES_B, MODEL_1)[0]
        if not landing_window:  # as it was
            j.update(P.position_jump(MODEL_1, P.Ground(LINES_B), j['start'], j['dir'], j['demoX']))
        b, mr = executor(MODEL_1, LINES_B, trajectory=[[t, x, y] for t, x, y, _ in SAMPLES_B])
        # the trace: landed at -2125 (11 px behind the recording's -2114), walking right
        reads = [(0.0, 21.0, -2125.0, -219.0), (20.0, 41.0, -2122.0, -219.0), (42.0, 63.0, -2119.0, -219.0), (62.0, 83.0, -2119.0, -219.0)]
        reads += [(62.0 + 21 * n, 83.0 + 21 * n, -2119.0 + MODEL_1['walk'] * 21 * n, -219.0) for n in range(1, 12)]
        return decide(b, mr, j, reads, ['right'], landed=0.0, rec0=349.1)[0], j

    def test_played_from_the_trace_it_presses_inside_its_window(self):
        go, j = self.run_trace()
        self.assertNotIn('fail', go)
        self.assertGreaterEqual(go['estX'], j['window'][0] - 0.01, go)

    def test_as_before_it_was_pressed_short(self):
        go, j = self.run_trace(landing_window=False)
        self.assertLess(go['estX'], j['demoX'] - 3.5, go)


# The first jump quest's last movement, jump 6 (14:53:07): a running jump pressed by position from the end of a 48 px
# platform (-1871..-1823), its recording pressing it 0.6 px past the latest safe press
ROW_C = {'at': 2906.8, 'moving': True, 'dir': 1, 'demoX': -1827.2, 'y': -1387.0, 'level': None, 'recordedLanding': [-1773.0, -1455.0],
         'status': 'position', 'aim': -1829.9, 'window': [-1869.0, -1827.8], 'edgeMargin': 6.9, 'lateMargin': 4.8, 'interval': None,
         'start': 0, 'target': None}
LINES_C = [[[-1871.0, -1387.0], [-1823.0, -1387.0]]]
MODEL_C = {'walk': 0.1287, 'jump': 0.5667, 'gravity': 0.002053, 'fall': 0.5267, 'jumpKey': 'space', 'leftKey': 'left', 'rightKey': 'right',
           'delays': [-16.0, -2.0, 22.0], 'leaveMs': 58.9}
# the trace after jump 5 landed 4 px further on than recorded, nothing held: it slid 2 px and stood
READS_C = [(0.0, 17.0, -1827.0, -1387.0), (21.0, 38.0, -1827.0, -1387.0), (42.0, 59.0, -1826.0, -1387.0)] + \
          [(42.0 + 21 * n, 59.0 + 21 * n, -1825.0, -1387.0) for n in range(1, 8)]


class StopWatchTests(unittest.TestCase):
    """C: past its safe stretch 1 px from where it would walk off, the jump was refused at once: too near to stop, by a
    stopping distance (the most a tap slid on after walking) of 7 px. With nothing held it slid 2 px and stood. It's
    now watched for STOP_WATCH_MS, and walked back from where it stops while that's on its line."""

    def test_with_nothing_held_it_watches_it_stop_and_walks_back(self):
        b, mr = executor(MODEL_C, LINES_C)
        go, at, st = decide(b, mr, ROW_C, READS_C, [], landed=0.0, rec0=2850.0)
        self.assertIsNone(go, go)
        self.assertEqual(st['repo']['phase'], 'back')
        self.assertLess(st['repo']['to'], ROW_C['aim'] - 20)
        watched = [e for e in st['said'] if e['kind'] == 'stop-watch']
        self.assertEqual(watched and watched[0]['stoppedX'], -1825.0)

    def test_with_its_way_forward_held_it_still_refuses(self):
        b, mr = executor(MODEL_C, LINES_C)
        go, _, st = decide(b, mr, ROW_C, READS_C[:1], ['right'], landed=0.0, rec0=2850.0)
        self.assertIn('too near to stop', go['fail'])
        self.assertFalse(st.get('stopWatch'))

    def test_stopping_past_the_edge_margin_fails(self):
        b, mr = executor(MODEL_C, LINES_C)
        reads = READS_C[:3] + [(42.0 + 21 * n, 59.0 + 21 * n, -1824.0, -1387.0) for n in range(1, 8)]  # 1 px from its end
        go, _, _ = decide(b, mr, ROW_C, reads, [], landed=0.0, rec0=2850.0)
        self.assertIn('past where it would walk off', go['fail'])


# The second jump quest's movement 1, jump 6 (14:54:19): a narrow jump (a 3.5 px stretch, -210..-206.5) from the
# platform -230..-195 onto the one at -163 (-157..-122), pressed 70.6 ms after landing in the recording
ROW_D = {'at': 7799.1, 'moving': True, 'dir': 1, 'demoX': -207.0, 'y': -136.0, 'level': None, 'recordedLanding': [-143.0, -163.0],
         'start': 0, 'target': 1, 'modelErr': -3.3, 'margin': 6.0, 'status': 'narrow', 'why': 'its safe stretch is 3.5 px wide, under 8',
         'interval': [-210.0, -206.5], 'aim': -208.0, 'window': [-217.5, -195.5], 'room': 1.8, 'predicted': [1, -147.3]}
LINES_D = [[[-230.0, -136.0], [-195.0, -136.0]], [[-157.0, -163.0], [-122.0, -163.0]]]
LANDED_D = 7728.5  # the recording's landing (its Wait for turning true)
# the trace: landed 2 px further on than recorded, Right held; its readings came each 21 ms, 17.5 ms old
READS_D = [(0.0, 17.5, -213.0, -136.0), (21.0, 38.5, -213.0, -136.0), (40.0, 57.5, -211.0, -136.0)] + \
          [(40.0 + 21 * n, 57.5 + 21 * n, -211.0 + 0.1 * 21 * n, -136.0) for n in range(1, 8)]


class LandingPrepTests(unittest.TestCase):
    """D: pressed by where the player was, a jump went about 50 ms after its landing against the recording's 70, and a
    jump pressed 20-60 ms after landing flies about 13% slower across than one pressed later (the traces' 74 against
    102 adaptive jumps): it came down 15 px short. Only position jumps kept their recorded time from the landing; now
    every jump pressed by position does where its safe stretch allows."""

    def test_it_waits_for_its_recorded_time_from_the_landing(self):
        b, mr = executor(MODEL_2, LINES_D)
        go, at, _ = decide(b, mr, ROW_D, READS_D, ['right'], landed=0.0, rec0=LANDED_D)
        self.assertGreater(at[0], 0.0, 'not decided on the landing frame')
        press = at[1] + go['lead']
        self.assertAlmostEqual(press, ROW_D['at'] - LANDED_D, delta=5.0)
        self.assertLessEqual(go['estX'], ROW_D['interval'][1] + 0.01)
        self.assertEqual(go['prepMs'], 70.6)

    def test_as_before_it_was_pressed_at_the_aim_soon_after_landing(self):
        b, mr = executor(MODEL_2, LINES_D)
        go, at, _ = decide(b, mr, ROW_D, READS_D, ['right'], landed=0.0, rec0=LANDED_D, from_landing=False)
        self.assertEqual(at[0], 0.0)
        self.assertLess(at[1] + go['lead'], 55.0)
        self.assertAlmostEqual(go['estX'], ROW_D['aim'], delta=0.01)

    def test_never_past_its_safe_stretch_for_it(self):
        b, mr = executor(MODEL_2, LINES_D)
        go, at, _ = decide(b, mr, {**ROW_D, 'at': LANDED_D + 300.0}, READS_D, ['right'], landed=0.0, rec0=LANDED_D)
        self.assertLess(at[1] + go['lead'], 300.0 - 100, 'pressed before its recorded time')
        self.assertLessEqual(go['estX'], ROW_D['interval'][1] + 0.01)
        self.assertGreater(go['estX'], ROW_D['aim'])


# The second quest's movement 1, jump 3 (20:39:21): walking right along the flat at y 1 (-610..-538), pressed at
# -538.8, just before the line drops 56 px in 32 down to -506, onto the platform at -18 (-483..-417)
SAMPLES_G = [(4436.7, -623.0, 0.0, False), (4480.3, -616.0, -12.0, False), (4533.8, -612.0, -15.0, False), (4605.4, -601.0, -14.0, False),
             (4651.5, -597.0, -10.0, False), (4688.7, -593.0, -4.0, False), (4731.1, -587.0, 1.0, True), (4783.4, -580.0, 1.0, True),
             (4839.4, -572.0, 1.0, True), (4892.5, -569.0, 1.0, True), (4951.7, -561.0, 1.0, True), (4986.3, -554.0, 1.0, True),
             (5032.9, -550.0, 1.0, True), (5087.4, -543.0, 1.0, True), (5150.5, -535.0, -14.0, False), (5196.8, -528.0, -41.0, False),
             (5235.9, -524.0, -51.0, False), (5280.6, -520.0, -60.0, False), (5338.9, -513.0, -72.0, False), (5394.3, -505.0, -77.0, False),
             (5432.7, -501.0, -76.0, False), (5484.9, -494.0, -70.0, False), (5542.6, -486.0, -57.0, False), (5588.4, -478.0, -35.0, False),
             (5635.3, -475.0, -24.0, False), (5686.7, -469.0, -18.0, True), (5742.9, -466.0, -18.0, True), (5796.3, -458.0, -18.0, True)]
EVENTS_G = [(4419.1, 'right', True), (5120.1, 'space', True), (5302.1, 'space', False)]
LINES_G = [[[-687.0, 61.0], [-640.0, 61.0], [-610.0, 1.0], [-538.0, 1.0], [-506.0, 57.0], [-490.0, 57.0], [-471.0, 89.0]],
           [[-483.0, -18.0], [-417.0, -18.0]]]
MODEL_2R = {**MODEL_2, 'runUp': {'px': 13.0, 'ms': 139.2, 'n': 5}}


class TerrainTests(unittest.TestCase):
    """1: the second quest's movement 1 jump 3 was recorded pressed on the flat 0.8 px before a steep drop. For 6 px
    more landing room the model aimed it 9.5 px later, on the drop, where the player gathers speed the model doesn't
    know: every run it came down about 48 px further than recorded (the traces' downhill takeoffs, 50 px further than
    the model, 14 of 14), leaving jump 4 0-3 px of its stretch. A model's stretch now keeps to ground graded as where
    the recording pressed; none there, it's played as recorded."""

    def test_its_press_isn_t_moved_off_the_flat_it_was_recorded_on(self):
        j = analysed(SAMPLES_G, EVENTS_G, LINES_G, MODEL_2)[0]
        self.assertEqual(j['status'], 'timed', j)
        self.assertEqual(j['terrain'], {'grade': 'flat', 'from': -610.0, 'to': -538.0})
        self.assertIn('off the flat ground', j['why'])
        self.assertGreater(j['model']['interval'][0], -538.0, 'the stretch the model had is on the drop')

    def test_as_before_it_was_aimed_on_the_drop(self):
        was = P.Ground.graded
        P.Ground.graded = lambda self, *a, **k: None
        try:
            j = analysed(SAMPLES_G, EVENTS_G, LINES_G, MODEL_2)[0]
        finally:
            P.Ground.graded = was
        self.assertEqual(j['status'], 'adapt')
        self.assertGreater(j['aim'], -538.0)

    def test_how_ground_is_graded(self):
        g = P.Ground(LINES_G)
        self.assertEqual(g.graded(0, -538.8, 1), ('flat', -610.0, -538.0))
        self.assertEqual(g.graded(0, -530.0, 1), ('down', -538.0, -506.0))
        self.assertEqual(g.graded(0, -530.0, -1)[0], 'up', 'the same slope the other way')
        # a 1 px step in how a line was drawn goes with the ground round it (the second quest's g15 -> g16 jump 2)
        step = P.Ground([[[-969.0, -674.0], [-951.0, -674.0], [-950.0, -676.0], [-926.0, -676.0]]])
        self.assertEqual(step.graded(0, -950.4, -1), ('flat', -969.0, -926.0))


# The second quest's crest walk, (404, -329) to (438, -342): along the flat, up a gentle slope, onto a flat top whose
# end at 439 drops away
SAMPLES_W = [(-295.1, 404.0, -329.0, True), (-224.3, 404.0, -329.0, True), (-184.7, 404.0, -329.0, True), (-137.7, 404.0, -329.0, True),
             (-99.0, 404.0, -329.0, True), (-41.2, 404.0, -329.0, True), (-3.6, 404.0, -329.0, True), (69.1, 409.0, -329.0, True),
             (109.4, 411.0, -332.0, True), (148.2, 413.0, -335.0, True), (210.7, 417.0, -339.0, True), (249.4, 418.0, -339.0, True),
             (306.9, 420.0, -340.0, True), (369.2, 422.0, -342.0, True), (418.1, 428.0, -342.0, True), (455.5, 431.0, -342.0, True),
             (493.3, 436.0, -342.0, True), (552.8, 438.0, -342.0, True), (617.9, 438.0, -342.0, True), (672.7, 438.0, -342.0, True),
             (708.1, 438.0, -342.0, True), (748.6, 438.0, -342.0, True)]
EVENTS_W = [(0.0, 'right', True), (84.9, 'right', False), (315.0, 'right', True), (413.0, 'right', False)]
CREST_LINE = [[321.0, -267.0], [325.0, -275.0], [340.0, -290.0], [360.0, -296.0], [372.0, -301.0], [382.0, -313.0], [385.0, -329.0],
              [410.0, -329.0], [413.0, -335.0], [419.0, -340.0], [423.0, -342.0], [439.0, -342.0], [445.0, -339.0], [450.0, -333.0],
              [454.0, -333.0], [458.0, -330.0], [460.0, -327.0]]


def crest_walk():
    s = [(t, x, y, g, None) for t, x, y, g in SAMPLES_W]
    keys, grounds = Keys(list(EVENTS_W)), {None: P.Ground([CREST_LINE])}
    fin = P.finish(s, keys, MODEL_2R, grounds, 0.0, 550.5)
    return P.start_region((404.0, -329.0), s, keys, MODEL_2R, grounds, 0.0, 550.5, [], fin), fin


# the same walk on level ground (404 to 438 along a line from 380 to 470): what the main route's level walks are
LEVEL_LINE = [[380.0, -329.0], [470.0, -329.0]]
SAMPLES_L = [(t, x, -329.0, g) for t, x, _, g in SAMPLES_W]


def level_walk():
    s = [(t, x, y, g, None) for t, x, y, g in SAMPLES_L]
    keys, grounds = Keys(list(EVENTS_W)), {None: P.Ground([LEVEL_LINE])}
    fin = P.finish(s, keys, MODEL_2R, grounds, 0.0, 550.5)
    return P.start_region((404.0, -329.0), s, keys, MODEL_2R, grounds, 0.0, 550.5, [], fin), fin


def walk_map(region, fin, line, samples, end, takeoff='adaptive'):
    """A walk as a map's one recorded movement, with its start region, end correction and line-up."""
    from keys import clip as clip_
    link = {'id': 'W', 'from': 'a', 'to': 'b', 'kind': 'clip', 'recorded': True, 'start': [404.0, -329.0], 'end': end, 'ms': 550.5,
            'clip': {'recording': 'r', 'from': 0.0, 'to': 550.5}, 'trajectory': [[t, x, y, None] for t, x, y, _ in samples if 0 <= t <= 551],
            'finish': fin, 'takeoffs': [], **({'startRegion': region} if region else {})}
    places = [{'id': 'a', 'x': 404.0, 'y': -329.0, 'level': None, 'reach': 24, 'recorded': True},
              {'id': 'b', 'x': end[0], 'y': end[1], 'level': None, 'reach': 2, 'recorded': True}]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'b'}, 'children': []}}}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}], clips={'link:W': clip_(Keys(list(EVENTS_W)), 0.0, 550.5)},
                    maps={'m': {'position': 'player', 'places': places, 'links': [link],
                                'grid': {'replay': {'startPx': 2, 'arrivePx': 8, 'takeoff': takeoff, 'ground': 'platforms',
                                                    'lineUp': {'x': {'less': ['left'], 'more': ['right']}}}},
                                'platformer': {'model': MODEL_2R, 'grounds': [[None, [line]]]}}})


def level_map(takeoff='adaptive'):
    r, fin = level_walk()
    return walk_map(r, fin, LEVEL_LINE, SAMPLES_L, [438.0, -329.0], takeoff)


def begins(b, x, y=-329.0):
    """Ticks with the player standing at (x, y) until the movement starts, it taps, or it ends: (events, sequences)."""
    events, sent = [], []
    for k in range(10):
        out = b.tick(50.0 * k, {'player': {'valid': True, 'value': [x, y]}})
        events += out['events']
        if out['sequence']:
            sent.append(out['sequence'])
        if out['done'] or any(e['kind'] == 'link' for e in events) or sent:
            break
    return events, sent


class StartRegionTests(unittest.TestCase):
    """2: on the second quest the line-up for the crest walk refused 3 px off its start (40 ms taps move the player 2 or
    7 px). A walk the end correction finishes can begin further back, ending short, which the correction takes up; on,
    only as far as there's ground past its end to stop on. But only a walk on one grade all along: begun 5 px back
    (21:14:49) the crest walk met its steep rise without the momentum it had, stalled at its foot, and came 26 px short."""

    def test_a_walk_crossing_a_change_of_grade_has_no_region(self):
        r, fin = crest_walk()
        self.assertEqual(fin['status'], 'correct')
        self.assertIsNone(r, 'up a steep rise, onto a flat top: not one grade')

    def test_a_level_walk_may_start_further_back_and_on_as_its_end_allows(self):
        r, _ = level_walk()
        self.assertEqual((r['kind'], r['lo'], r['hi']), ('walk', 404.0 - P.START_REGION_PX, 404.0 + P.START_REGION_PX), r)
        # its end 438 on a line to 470: 30 px to stop on past it, more than START_REGION_PX

    def test_from_4_px_back_it_begins_without_lining_up_and_says_so_once(self):
        events, sent = begins(level_map(), 400.0)
        self.assertEqual(len([e for e in events if e['kind'] == 'start-region']), 1, events)
        self.assertTrue(any(e['kind'] == 'link' for e in events), 'the walk began')
        self.assertFalse([e for e in events if e['kind'] == 'line-up'])

    def test_outside_its_region_it_still_lines_up(self):
        events, sent = begins(level_map(), 404.0 - P.START_REGION_PX - 3)
        self.assertFalse(any(e['kind'] == 'start-region' for e in events))
        self.assertTrue(sent and sent[0][0][1] == 'right', 'a tap toward its start')

    def test_without_the_end_correction_it_lines_up(self):
        events, sent = begins(level_map(takeoff='timed'), 400.0)
        self.assertFalse(any(e['kind'] == 'start-region' for e in events))
        self.assertTrue(sent and sent[0][0][1] == 'right')

    def test_a_jump_needs_its_run_up_at_walking_speed(self):
        # the movement from (438, -342): a position jump 3.9 px on, from standing, under the measured 13 px run-up
        grounds = {None: P.Ground([[[400.0, -342.0], [470.0, -342.0]]])}
        s = [(t, 438.0 + max(0.0, t) * 0.05, -342.0, True, None) for t in range(-100, 200, 40)]
        keys = Keys([(0.0, 'right', True)])
        row = {'status': 'position', 'moving': True, 'dir': 1, 'start': 0, 'demoX': 441.9, 'at': 83.9}
        self.assertIsNone(P.start_region((438.0, -342.0), s, keys, MODEL_2R, grounds, 0.0, 700.0, [row], None))
        # a 25 px run-up: on by up to 12 px (still 13 at walking speed), back by START_REGION_PX
        r = P.start_region((438.0, -342.0), s, keys, MODEL_2R, grounds, 0.0, 700.0, [{**row, 'demoX': 463.0}], None)
        self.assertEqual((r['kind'], r['lo'], r['hi']), ('jump', 438.0 - P.START_REGION_PX, 450.0))
        self.assertIsNone(P.start_region((438.0, -342.0), s, keys, {**MODEL_2R, 'runUp': None}, grounds, 0.0, 700.0, [{**row, 'demoX': 463.0}], None),
                          'without a measured run-up, none')


# The first quest's walk g10 -> g11: (-1343, -672) to (-1337, -672), Right held 63 ms, coming to rest at -1336 on a
# line that ends at -1334, where the floor drops 22 px
DROP_LINE = [[-1421.0, -672.0], [-1334.0, -672.0]]
BELOW_LINE = [[-1334.0, -650.0], [-1308.0, -650.0]]
SAMPLES_D = [(-120.0, -1343.0, -672.0, True), (-60.0, -1343.0, -672.0, True), (-40.0, -1343.0, -672.0, True), (22.0, -1343.0, -672.0, True),
             (64.0, -1340.0, -672.0, True), (127.0, -1337.0, -672.0, True), (190.0, -1336.0, -672.0, True), (250.0, -1336.0, -672.0, True),
             (320.0, -1336.0, -672.0, True)]
EVENTS_D = [(0.0, 'right', True), (63.1, 'right', False)]


def drop_walk():
    s = [(t, x, y, g, None) for t, x, y, g in SAMPLES_D]
    keys, grounds = Keys(list(EVENTS_D)), {None: P.Ground([DROP_LINE, BELOW_LINE])}
    fin = P.finish(s, keys, MODEL_2R, grounds, 0.0, 127.0)
    return P.start_region((-1343.0, -672.0), s, keys, MODEL_2R, grounds, 0.0, 127.0, [], fin), fin


def drop_map(start_px=2.0):
    from keys import clip as clip_
    r, fin = drop_walk()
    link = {'id': 'W', 'from': 'a', 'to': 'b', 'kind': 'clip', 'recorded': True, 'start': [-1343.0, -672.0], 'end': [-1337.0, -672.0], 'ms': 127.0,
            'clip': {'recording': 'r', 'from': 0.0, 'to': 127.0}, 'trajectory': [[t, x, y, None] for t, x, y, _ in SAMPLES_D if 0 <= t <= 127],
            'finish': fin, 'takeoffs': [], 'startRegion': r}
    places = [{'id': 'a', 'x': -1343.0, 'y': -672.0, 'level': None, 'reach': 2, 'recorded': True},
              {'id': 'b', 'x': -1337.0, 'y': -672.0, 'level': None, 'reach': 2, 'recorded': True}]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'b'}, 'children': []}}}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}], clips={'link:W': clip_(Keys(list(EVENTS_D)), 0.0, 127.0)},
                    maps={'m': {'position': 'player', 'places': places, 'links': [link],
                                'grid': {'replay': {'startPx': start_px, 'arrivePx': 6, 'takeoff': 'adaptive', 'ground': 'platforms',
                                                    'lineUp': {'x': {'less': ['left'], 'more': ['right']}}}},
                                'platformer': {'model': MODEL_2R, 'grounds': [[None, [DROP_LINE, BELOW_LINE]]]}}})


class RestingStartTests(unittest.TestCase):
    """1: the first quest's walk to (-1337, -672) rests 2 px from its line's end. Begun 2 px on, inside the map's Start
    within (2), it walked off its end 7 times in 9; from its start or behind it 26 of 27 stayed on. How far on a walk may
    begin is now the ground past where its recording came to rest (to a line's end or a downhill, less EDGE_PX), and
    that narrows Start within as well as bounding its start region."""

    def test_it_may_begin_no_further_on_than_where_it_comes_to_rest_allows(self):
        r, _ = drop_walk()
        self.assertEqual((r['kind'], r['rest'], r['aheadPx']), ('walk', -1336.0, 0.0), r)
        self.assertEqual((r['lo'], r['hi']), (-1343.0 - P.START_REGION_PX, -1343.0), 'back, but not on')

    def test_2_px_on_inside_start_within_it_lines_up_first(self):
        from test_takeoff import TAPS_0304
        b = drop_map()
        b.shared['maps']['m'].taps = {'x': [list(t) for t in TAPS_0304]}  # the first quest's taps: 25 ms moves it 2 px
        events, sent = begins(b, -1341.0, -672.0)
        self.assertFalse(any(e['kind'] == 'link' for e in events), 'the walk didn’t begin from 2 px on')
        self.assertTrue(sent and sent[0][0][1] == 'left', 'a tap back toward its start')

    def test_at_its_start_or_behind_it_begins(self):
        for x in (-1343.0, -1346.0):
            events, sent = begins(drop_map(), x, -672.0)
            self.assertTrue(any(e['kind'] == 'link' for e in events), (x, events))

    def test_its_start_tolerance_is_the_map_s_where_there_s_room(self):
        # the level walk ends 30 px from its line's end: Start within as it is
        r, _ = level_walk()
        self.assertGreaterEqual(r['aheadPx'], 2.0)
        b = level_map()
        self.assertEqual(b.shared['maps']['m'].control._start_tol(b.shared['maps']['m'].links['W'], None), 2.0)


# the second quest's taps before 21:14:49's last two, the first of them (150 ms up its rise, 5 px) included
CREST_TAPS = [[40, 2.0, 'flat'], [80.0, 7.0, 'flat'], [70, 6.0, 'flat'], [70, 7.0, 'flat'], [60, 7.0, 'flat'], [150, 11.0, 'flat'], [50, 7.0, 'flat'],
              [40, 7.0, 'flat'], [300, 20.0, 'flat'], [40, 2.0, 'flat'], [40, 7.0, 'flat'], [120, 17.0, 'up gentle'], [250, 16.0, 'flat'],
              [40, 6.0, 'flat'], [200, 4.0, 'up steep'], [150, 21.0, 'up gentle'], [200, 27.0, 'flat'], [200, 27.0, 'flat'], [200, 27.0, 'flat'],
              [200, 1.0, 'flat'], [40, 2.0, 'flat'], [40, 2.0, 'flat'], [200, 6.0, 'up steep'], [120, 19.0, 'up gentle'], [40, 7.0, 'flat'],
              [100, 19.0, 'flat'], [40, 2.0, 'up gentle'], [60, 7.0, 'up gentle'], [40, 7.0, 'flat'], [150, 5.0, 'up gentle', 'free']]


class CrestCorrectionTests(unittest.TestCase):
    """2: 21:14:49, the crest walk's end correction from 418, on its gentle rise, 20 px short of 438 (Arrive within 8):
    a 150 ms tap, its rise's taps putting it at 21 px at most, ran onto the flat top and went 23, 2 px past the crest at
    439; the player slid on to 441, and that, within 8 px, was taken as there. A tap's most is now also what taps on
    every ground it may cross say, where a hazard limits it, and a correction stops only short of the 2 px before a
    downhill beyond its target (never short of the target itself)."""

    def stepped(self, x, y, crossing=True):
        from test_takeoff import lining_up
        b = lining_up((438.0, -342.0), [CREST_LINE], start_px=8.0)
        mr = b.shared['maps']['m']
        mr.dynamics['model'] = MODEL_2R
        mr.taps = {'x': [list(t) for t in CREST_TAPS]}
        if not crossing:
            mr.control.crossing = lambda *a, **k: []
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        s = mr.control.positioner(b).begin(x, y)
        s['still'] = (0.0, x, y)
        out = mr.control.positioner(b).step(s, None, x, y, 438.0, -342.0, 8.0)
        return out, s, b, mr

    def test_the_tap_onto_the_flat_top_is_bounded_by_the_flat_s_taps(self):
        out, s, b, mr = self.stepped(418.0, -339.0)
        tap = s['taps'][-1]
        self.assertLess(tap['ms'], 150, tap)
        most = mr.control.tap_response('x', 'up gentle').most(tap['ms'], [mr.control.tap_response('x', 'flat')])
        self.assertLessEqual(most, tap['allowedPx'] + 0.01)
        self.assertLessEqual(418.0 + most, 439.0, 'short of the crest even at its most')

    def test_as_before_it_was_150_ms(self):
        out, s, b, mr = self.stepped(418.0, -339.0, crossing=False)
        self.assertEqual(s['taps'][-1]['ms'], 150)

    def test_past_the_crest_within_arrive_within_isn_t_there(self):
        out, s, b, mr = self.stepped(441.0, -341.0)
        self.assertNotEqual(out['state'], 'done', out)
        if out['state'] == 'running':
            self.assertEqual(s['taps'][-1]['keys'], ['left'], 'back toward the target')
        # and short of the crest's margin, or at the target, it is
        out, s, b, mr = self.stepped(436.0, -342.0)
        self.assertEqual(out['state'], 'done', out)
        out, s, b, mr = self.stepped(438.0, -342.0)
        self.assertEqual(out['state'], 'done', out)


class ThinLandingTests(unittest.TestCase):
    """4: the alternate route's jump 12 is played as recorded, and its recording landed at its platform's very end:
    it went past it in both runs since. A jump played as recorded with under THIN_LANDING_PX of room marks its movement
    unsafe."""

    def test_jump_12_has_no_room_and_says_so(self):
        j = analysed(SAMPLES_E, EVENTS_E, LINES_E, MODEL_1)[1]
        self.assertEqual((j['status'], j['landingRoom']), ('timed', 0.0))
        self.assertIn('no room to spare', j['unsafeWhy'])

    def test_one_with_room_isn_t_marked(self):
        j = analysed(SAMPLES_F, EVENTS_F, LINES_F, MODEL_1)[0]  # timed, landed 6 px inside its platform
        self.assertEqual(j['status'], 'timed')
        self.assertNotIn('unsafeWhy', j)


def flight_frames(press_x, speed_scale=1.0, stop_at=None, model=MODEL_2, start=((0.0, 0.0), (300.0, 0.0)), target=((260.0, -40.0), (400.0, -40.0))):
    """A run's frames: walking right on the line at y 0 to press_x, jumping (pressed at t 1000 there), the flight going
    across speed_scale times walking, up onto the platform at -40; stopped across at stop_at if given."""
    walk, frames = model['walk'], []
    link = {'kind': 'link', 'link': 'L', 'recorded': {'takeoffs': [{'dir': 1, 'moving': True, 'lines': [list(map(list, start)), list(map(list, target))]}]}}
    t, x, y, air, pressed = 600.0, press_x - walk * 400.0, 0.0, False, False
    while t < 2200:
        events = [link] if t == 600.0 else []
        if not pressed and t >= 1000:
            events.append({'kind': 'takeoff', 'index': 0, 'worked': True, 'status': 'adapt', 'pressAt': 1000.0})
            pressed = True
        dt = t - 1000.0
        if dt > 0:
            vy = model['jump'] - model['gravity'] * dt
            y = -(model['jump'] * dt - 0.5 * model['gravity'] * dt * dt)
            x = press_x + walk * speed_scale * dt
            if stop_at is not None:
                x = min(x, stop_at)
            air = True
            if vy < 0 and y >= -40 and 260 <= x <= 400:
                y, air = -40.0, False
        else:
            x = press_x + walk * dt
        frames.append({'t': t, 'now': t, 'maps': {'m': {'position': [round(x, 1), round(y, 1)]}}, 'values': {'On Ground': not air}, 'events': events})
        if dt > 0 and not air:
            break
        t += 20.0
    return frames


class CalibrationTests(unittest.TestCase):
    """3: where jumps pressed by position came down in play, against the model from the same press and state, and a
    correction from that state scored by leaving each run out (calibration.py; nothing moves a takeoff)."""

    def test_an_outcome_against_the_model(self):
        import calibration as C
        found, left = C.outcomes(flight_frames(150.0), MODEL_2, 'On Ground', 'a')
        o, = found
        self.assertEqual((o['dir'], o['grade']), (1, 'flat'))
        self.assertLess(abs(o['errorPx']), 4.0, o)
        found, _ = C.outcomes(flight_frames(150.0, speed_scale=1.2), MODEL_2, 'On Ground', 'a')
        self.assertGreater(found[0]['errorPx'], 8.0, 'flew further across than the model')

    def test_a_flight_stopped_across_is_left_out(self):
        import calibration as C
        found, left = C.outcomes(flight_frames(150.0, stop_at=230.0), MODEL_2, 'On Ground', 'a')
        self.assertEqual(found, [])
        self.assertEqual(left, {'stopped across in the air': 1})

    def test_a_correction_from_the_state_beats_per_jump_offsets(self):
        import calibration as C
        found = []
        for run in range(6):
            for n, grade in enumerate(('flat', 'flat', 'down')):
                found.append({'run': f'r{run}', 'link': f'L{n}', 'index': n if run % 2 else n + 10, 'speed': 0.12, 'sinceLanding': 200.0,
                              'grade': grade, 'errorPx': (50.0 if grade == 'down' else 1.0) + (run % 3) * 0.5})
        r = C.evaluate(found, 0.12)
        self.assertLess(r['reusable']['meanAbsPx'], r['asModelled']['meanAbsPx'])
        self.assertLess(r['reusable']['meanAbsPx'], r['perJump']['meanAbsPx'], 'jumps seen in half the runs only')
        self.assertAlmostEqual(r['correction']['downhillPx'], 49.0, delta=1.0)


# The first jump quest's alternate route, g2 -> g3, jumps 11 and 12 (18:05 and 18:06): jump 11 lands on the platform
# -1499..-1452 at -1473 and jump 12 is pressed at once, onto the platform -1452..-1421, its recording landing against
# that platform's far end (-1421) and standing there
SAMPLES_E = [(0.0, -1542.0, -585.0, True), (45.2, -1542.0, -586.0, True), (109.2, -1535.0, -603.0, True), (148.7, -1531.0, -618.0, False),
             (229.8, -1520.0, -649.0, False), (306.1, -1512.0, -661.0, False), (341.3, -1508.0, -664.0, False), (403.0, -1501.0, -666.0, False),
             (437.4, -1497.0, -663.0, False), (500.1, -1486.0, -646.0, False), (544.6, -1482.0, -636.0, False), (586.8, -1478.0, -625.0, False),
             (641.7, -1473.0, -623.0, True), (713.5, -1463.0, -667.0, False), (747.9, -1460.0, -677.0, False), (787.9, -1456.0, -685.0, False),
             (837.9, -1450.0, -697.0, False), (892.9, -1443.0, -702.0, False), (948.1, -1440.0, -702.0, False), (1005.5, -1434.0, -695.0, False),
             (1053.1, -1427.0, -683.0, False), (1095.6, -1424.0, -673.0, False), (1144.9, -1421.0, -651.0, True), (1204.4, -1421.0, -650.0, True)]
EVENTS_E = [(-1.0, 'right', True), (106.1, 'space', True), (280.3, 'space', False), (637.3, 'space', True), (810.4, 'space', False)]
LINES_E = [[[-1595.0, -521.0], [-1540.0, -588.0], [-1523.0, -588.0]], [[-1499.0, -624.0], [-1452.0, -623.0]],
           [[-1452.0, -650.0], [-1421.0, -650.0]], [[-1421.0, -672.0], [-1334.0, -672.0]],
           [[-1658.0, -514.0], [-1582.0, -514.0], [-1568.0, -514.0], [-1492.0, -514.0]]]
# its g3 -> g4 jump 2: a running jump from the long platform at -642 onto the one at -662 (-1031..-986), landing 6 px in
SAMPLES_F = [(0.0, -1155.0, -642.0, True), (30.5, -1151.0, -642.0, True), (77.9, -1144.0, -642.0, True), (134.2, -1136.0, -642.0, True),
             (174.6, -1132.0, -642.0, True), (235.3, -1125.0, -642.0, True), (282.3, -1118.0, -642.0, True), (322.5, -1114.0, -642.0, True),
             (380.4, -1106.0, -642.0, True), (431.6, -1098.0, -642.0, True), (471.4, -1095.0, -642.0, True), (533.1, -1087.0, -672.0, False),
             (575.6, -1079.0, -695.0, False), (643.9, -1072.0, -710.0, False), (678.3, -1068.0, -715.0, False), (719.9, -1065.0, -718.0, False),
             (792.4, -1053.0, -718.0, False), (831.3, -1049.0, -713.0, False), (886.8, -1042.0, -700.0, False), (928.4, -1038.0, -690.0, False),
             (976.7, -1031.0, -667.0, False), (1033.9, -1025.0, -662.0, True), (1091.9, -1019.0, -662.0, True), (1130.2, -1015.0, -677.0, False),
             (1184.3, -1007.0, -704.0, False), (1223.1, -1003.0, -715.0, False), (1284.9, -996.0, -730.0, False), (1332.4, -988.0, -739.0, False)]
EVENTS_F = [(-1.0, 'right', True), (450.2, 'space', True), (668.5, 'space', False), (1104.7, 'space', True), (1262.5, 'space', False), (1268.3, 'right', False)]
LINES_F = [[[-1253.0, -641.0], [-1083.0, -642.0]], [[-1031.0, -662.0], [-986.0, -662.0]], [[-984.0, -701.0], [-936.0, -701.0]],
           [[-985.0, -770.0], [-937.0, -770.0]], [[-1028.0, -634.0], [-952.0, -634.0], [-900.0, -634.0], [-848.0, -634.0], [-772.0, -634.0]]]


class TrustedNearMissTests(unittest.TestCase):
    """Fix A's near miss moved jump 12 of the first quest's alternate route off timed playback, to a 0.5 px stretch
    25 px behind where the jump before lands; it was refused for that 2 runs of 3, where played as recorded it never
    failed. A model's stretch is now checked against the recording: reachable along its approach and, for a near miss,
    not a landing a wall may have stopped, not unsafe once its error is allowed for, and with room to press it.
    Otherwise it's played as recorded."""

    def test_a_stretch_behind_the_approach_is_played_as_recorded(self):
        rows = analysed(SAMPLES_E, EVENTS_E, LINES_E, MODEL_1)
        j = rows[1]
        self.assertEqual(j['status'], 'timed', j)
        self.assertIn('behind where its recording came onto the line', j['why'])
        self.assertEqual(j['arrival'], -1473.0, 'landed on from the jump before')
        self.assertEqual(j['model']['status'], 'narrow', 'what the model would have done is kept')
        self.assertNotIn('window', j)
        self.assertEqual(rows[0]['status'], 'adapt', 'the jump before it, on its own approach, the model’s to press')

    def test_a_landing_against_its_target_s_far_end_isn_t_taken_as_the_model_s_error(self):
        # with the approach out of the question (as if standing), its landing at -1421, the far end, still keeps it
        s = [(t, x, y, g, None) for t, x, y, g in SAMPLES_E]
        j = analysed(SAMPLES_E, EVENTS_E, LINES_E, MODEL_1)[1]
        row = {**j, **j.pop('model'), 'moving': False}
        P._distrusted(row, s, 12, P.Ground(LINES_E), 1, 2, s[22], j['demoX'])
        self.assertEqual(row['status'], 'timed')
        self.assertIn('against the far end of its target', row['why'])

    def test_unsafe_with_its_error_allowed_for_is_played_as_recorded(self):
        j = analysed(SAMPLES_F, EVENTS_F, LINES_F, MODEL_1)[0]
        self.assertEqual((j['status'], j['model']['status']), ('timed', 'unsafe'), j)
        self.assertIn('nearMiss', j)

    def test_too_little_room_around_its_aim_is_played_as_recorded(self):
        j = analysed(SAMPLES_A, EVENTS_A, LINES_A, MODEL_2)[0]
        self.assertEqual(j['status'], 'narrow', 'the second quest’s jump 3 still pressed by position')
        row = {**j, 'window': [j['aim'] - 2.0, j['aim'] + 10.0]}
        s = [(t, x, y, g, None) for t, x, y, g in SAMPLES_A]
        P._distrusted(row, s, 8, P.Ground(LINES_A), 0, 1, s[18], j['demoX'])
        self.assertEqual(row['status'], 'timed')
        self.assertIn('too little room', row['why'])


# Line-up on the second quest (18:02:49): the readings of its taps from when each was sent (read time, x)
WALL_250 = [(-35.9, -1157.0), (-15.1, -1157.0), (5.7, -1157.0), (26.6, -1158.0), (47.4, -1159.0), (67.9, -1159.0), (89.1, -1166.0),
            (109.9, -1166.0), (130.7, -1170.0), (151.6, -1170.0), (172.4, -1173.0), (193.2, -1173.0), (214.1, -1173.0), (234.9, -1173.0),
            (255.7, -1173.0), (273.1, -1173.0), (297.4, -1173.0)]
STEEP_200 = [(-8.5, 411.0), (15.9, 411.0), (36.8, 411.0), (57.6, 411.0), (78.4, 412.0), (99.3, 412.0), (120.1, 412.0), (140.1, 413.0),
             (158.6, 413.0), (180.1, 414.0), (201.3, 414.0), (222.7, 415.0), (241.3, 415.0)]
FREE_200 = [(-22.6, -258.0), (-1.8, -258.0), (19.0, -257.0), (39.9, -257.0), (60.7, -255.0), (81.5, -252.0), (100.8, -252.0),
            (121.4, -249.0), (144.0, -245.0), (164.9, -241.0), (185.7, -241.0), (206.5, -237.0), (227.4, -235.0), (248.2, -235.0)]
# the map's taps then: the short flat ones, the wall's three, a 31 px tap measured as 1 px when line-up went on to the
# next start mid-tap, and two up a steep slope
FLAT_TAPS = [[40, 2.0, 'flat'], [40, 2.0, 'flat'], [40, 2.0, 'flat'], [40, 2.0, 'flat'], [40, 6.0, 'flat'], [40, 7.0, 'flat'], [40, 7.0, 'flat'],
             [50, 7.0, 'flat'], [60, 7.0, 'flat'], [70, 6.0, 'flat'], [70, 7.0, 'flat'], [80.0, 7.0, 'flat'], [150, 11.0, 'flat'],
             [300, 20.0, 'flat'], [250, 16.0, 'flat'], [200, 1.0, 'flat'], [200, 4.0, 'up steep'], [200, 6.0, 'up steep']]


def flat_game_2(ms):
    """A tap on the second quest's flat ground, by its taps: 40 ms 2 px, up to 80 ms 7, then about 0.135 px/ms."""
    return 0.0 if ms < 25 else 2.0 if ms < 45 else 7.0 if ms < 85 else round(0.135 * ms)


class BlockedTapTests(unittest.TestCase):
    """2: taps held against the second quest's starting wall moved 11-20 px in 150-300 ms, and with a 31 px tap
    measured as 1 px, a 200 ms tap was expected to move 14 px on the flat. It moved 27, and four such taps swung the
    player 14 and 13 px either side of its start."""

    def test_a_tap_against_the_wall_is_blocked_and_free_or_steep_ones_aren_t(self):
        from tap_response import _stood_held
        self.assertTrue(_stood_held({'start': 0.0, 'ms': 250, 'reads': WALL_250}))
        self.assertFalse(_stood_held({'start': 0.0, 'ms': 200, 'reads': STEEP_200}), 'slow up a steep slope, not stopped')
        self.assertFalse(_stood_held({'start': 0.0, 'ms': 200, 'reads': FREE_200}))

    def test_blocked_and_out_of_line_taps_aren_t_free_movement(self):
        from tap_response import TapResponse
        r = TapResponse(FLAT_TAPS + [[200, 27.0, 'flat']], MODEL_2['walk'], 'flat')
        self.assertNotIn((200.0, 1.0), r.own)
        self.assertNotIn((250.0, 16.0), r.own, 'a longer tap that moved 11 px less than a 200 ms one')
        self.assertEqual(r.typical(200), 27.0)
        steep = TapResponse(FLAT_TAPS, MODEL_2['walk'], 'up steep')
        self.assertIn((200.0, 4.0), steep.own, 'not held to the flat taps: another context')
        marked = TapResponse([[40, 2.0, 'flat'], [200, 1.0, 'flat', 'blocked']], MODEL_2['walk'], 'flat')
        self.assertEqual(marked.own, [(40.0, 2.0)])

    def line_up(self, taps):
        from test_takeoff import lining_up
        b = lining_up((-244.0, -504.0), [[[-303.0, -504.0], [-200.0, -504.0]]], start_px=2.0)
        mr = b.shared['maps']['m']
        mr.dynamics['model'] = MODEL_2
        mr.taps = {'x': [list(t) for t in taps]}
        x, t, sent, out = -258.0, 0.0, [], None
        for _ in range(300):
            out = b.tick(t, {'player': {'valid': True, 'value': [x, -504.0]}})
            if out['done'] or any(e['kind'] == 'link' for e in out['events']):
                break
            if out['sequence']:
                (_, key, _), (ms, _, _) = out['sequence'][0], out['sequence'][-1]
                x += flat_game_2(ms) * (1 if key == 'right' else -1)
                sent.append((key, ms, x))
            t += 25
        return out, sent, x

    def test_lining_up_where_it_swung_it_gets_there(self):
        out, sent, x = self.line_up(FLAT_TAPS)
        self.assertLessEqual(abs(x + 244), 2.0, (out['text'], sent))
        errors = [-258.0 + 244] + [p + 244 for _, _, p in sent]
        for a, b in zip(errors, errors[1:]):
            if a * b < 0:
                self.assertLessEqual(abs(b), max(2.0, abs(a) / 2) + 0.01, f'past the start without halving its error: {sent}')

    def test_as_it_was_it_swung(self):
        # every tap taken as moving freely, at worst as far past as it was short, no cap after an overshoot, no stop
        import positioning, tap_response
        share, free, choose, stop, init = (positioning.OVERSHOOT_SHARE, tap_response._free_taps, tap_response.TapResponse.choose, positioning.SWING_STOP,
                                           tap_response.TapResponse.__init__)

        def unchecked(self, seen, walk, context=None):
            init(self, seen, walk, context)
            self.checked, self.checked_own = self.seen, self.own
        positioning.OVERSHOOT_SHARE, tap_response._free_taps, positioning.SWING_STOP, tap_response.TapResponse.__init__ = 1.0, lambda taps: taps, 1000, unchecked
        tap_response.TapResponse.choose = lambda self, need, allowed, first_ms, last_ms=None, cap_ms=None, also=(): choose(self, need, allowed, first_ms, last_ms)
        try:
            out, sent, x = self.line_up(FLAT_TAPS)
        finally:
            (positioning.OVERSHOOT_SHARE, tap_response._free_taps, tap_response.TapResponse.choose, positioning.SWING_STOP,
             tap_response.TapResponse.__init__) = share, free, choose, stop, init
        self.assertGreaterEqual(len(sent), 4, sent)
        self.assertEqual([k for k, _, _ in sent[:4]], ['right', 'left', 'right', 'left'], f'back and forth: {sent}')

    def stepped(self, at, last, still_at):
        from test_takeoff import lining_up
        b = lining_up((-244.0, -504.0), [[[-303.0, -504.0], [-200.0, -504.0]]], start_px=2.0)
        mr = b.shared['maps']['m']
        mr.dynamics['model'] = MODEL_2
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        s = mr.control.positioner(b).begin(at, -504.0)
        s.update(target=(-244.0, -504.0), last=last, taps=[{'axis': 'x', 'ms': 200, 'keys': ['left']}])
        b.now, b.shared['observation_time'], b.frames = 1000.0, 1000.0, [{}]
        s['still'] = (0.0, still_at, -504.0)  # standing still there
        return b, mr, s

    def test_swinging_without_closing_in_stops_rather_than_repeating(self):
        # it had swung once (14 px left of it to 13 right); this tap took it from 13 right back to 13 left
        b, mr, s = self.stepped(-231.0, ('x', 13.0, -231.0), -257.0)
        s.update(swings=1, moved=[27.0])
        out = mr.control.positioner(b).step(s, None, -257.0, -504.0, -244.0, -504.0, 2.0)
        self.assertEqual(out['state'], 'failed', out)
        self.assertIn('swing either side', out['why'])

    def test_a_tap_s_move_is_measured_by_where_the_player_went(self):
        b, mr, s = self.stepped(-231.0, ('x', 13.0, -231.0), -262.0)
        mr.control.positioner(b).step(s, None, -262.0, -504.0, -274.0, -498.0, 2.0)  # line-up gone on to the next start meanwhile
        self.assertEqual(s['taps'][0]['movedPx'], -31.0, 'not 1 px, the change in its error to another target')


# the first quest's calibration from its runs (calibration.summary over 62 runs): flat ground, pressed later than
# CAL_FRESH_MS after a landing
CAL_1 = {'fresh·flat': {'n': 81, 'p90AbsPx': 11.0, 'biasPx': -5.6}, 'later·flat': {'n': 1344, 'p90AbsPx': 3.7, 'biasPx': 1.3}}


class CalibratedNearMissTests(unittest.TestCase):
    """3: a near miss's margin from how far the model was from where the map's jumps came down in play, in comparable
    conditions, not from its one recording's difference. The alternate route's g3 -> g4 jump 2, played as recorded
    since (TrustedNearMissTests), came down 2-3 px short of its platform twice, where the model had it; pressed by
    position at about -1088 it landed 8 px inside."""

    def test_calibrated_it_s_pressed_by_position_where_it_lands_at_every_delay(self):
        j = analysed(SAMPLES_F, EVENTS_F, LINES_F, MODEL_1, CAL_1)[0]
        self.assertEqual(j['status'], 'unsafe', j)
        self.assertEqual(j['calibrated']['key'], 'later·flat')
        self.assertEqual(j['margin'], 6.0, 'LAND_MARGIN: the calibrated p90 3.7 + 2 under it')
        self.assertAlmostEqual(j['aim'], -1090.6, delta=1.0)
        self.assertGreater(j['roomBare'], 2.0, 'inside its platform at every delay')
        self.assertGreaterEqual(j['edgeAtLaunchPx'], P.EDGE_PX, 'and off its line before its end at the latest launch')
        self.assertIn('keptBy', j)
        ground = P.Ground(LINES_F)
        lo_t = ground.ends(1)[0]
        hit = P.press_landing(MODEL_1, ground, 0, j['demoX'], MODEL_1['walk'], MODEL_1['walk'], MODEL_1['delays'][1])
        self.assertTrue(hit is None or hit[0] != 1 or hit[1] < lo_t, f'pressed as recorded, the model has it short of its platform: {hit}')

    def test_calibration_in_other_conditions_doesn_t_apply(self):
        j = analysed(SAMPLES_F, EVENTS_F, LINES_F, MODEL_1, {'fresh·flat': CAL_1['fresh·flat']})[0]
        self.assertEqual(j['status'], 'timed', j)
        self.assertNotIn('calibrated', j)

    def test_a_summary_needs_enough_outcomes_and_leaves_out_far_end_landings(self):
        import calibration as C
        o = lambda e, far=False, since=200.0: {'errorPx': e, 'atFarEnd': far, 'sinceLanding': since, 'grade': 'flat'}
        found = [o(1.0)] * 19 + [o(30.0, far=True)] * 5 + [o(-8.0, since=30.0)] * 25
        r = C.summary(found)
        self.assertNotIn('later·flat', r, '19 outcomes: under CAL_MIN, the far-end ones left out')
        self.assertEqual(r['fresh·flat']['n'], 25)
        self.assertEqual(r['fresh·flat']['p90AbsPx'], 8.0)


if __name__ == '__main__':
    unittest.main()
