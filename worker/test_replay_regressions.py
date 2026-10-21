"""Timing, destination synchronization, and retry accounting, independent of any particular game."""
import unittest

from behavior import Behavior
from test_takeoff import MODEL, walks


class ComplexTimingTests(unittest.TestCase):
    def make(self):
        b, graph = walks({'takeoff': 'adaptive'})
        mr = b.shared['maps']['m']
        link = graph['links'][0]
        # A landing followed by 280 ms of run-up, then a jump with a midair reversal.
        link['trajectory'] = [[0, 100, 195, None], [280, 128, 195, None], [500, 150, 160, None]]
        j = {'at': 280, 'status': 'position', 'moving': True, 'dir': 1, 'start': 0,
             'demoX': 128, 'aim': 110, 'window': [100, 140]}
        st = {'link': link['id'], 'anchor': (1000, 0), 'segStart': 1000, 'frameGap': 40, 'keep': ['right']}
        return b, mr, st, {'at': 280, 'jump': j, 'index': 0, 'kind': 'takeoff'}

    def ask(self, b, mr, st, trigger, now, read, x):
        b.now = now
        b.shared['observation_time'] = read
        st['readings'] = [(read - 40, x - 4), (read, x)]
        return mr.control._takeoff(b, st, trigger, None, x, 195)

    def test_reaching_aim_early_preserves_landing_delay_and_runup(self):
        b, mr, st, trigger = self.make()
        self.assertIsNone(self.ask(b, mr, st, trigger, 1100, 1100, 110))
        self.assertIn('recorded run-up', st['takeoffWait'])
        # The reading is 20 ms old: only 40 ms remain until the recorded press.
        go = self.ask(b, mr, st, trigger, 1240, 1220, 122)
        self.assertAlmostEqual(go['lead'], 40)
        self.assertAlmostEqual(go['estX'], 128)
        self.assertNotIn('repo', st)

    def test_where_the_recorded_timing_passes_the_safe_limit_it_presses_at_the_limit_no_earlier(self):
        # refusing it instead failed the user's first movement every run: its own recording pressed past the limit
        b, mr, st, trigger = self.make()
        trigger['jump']['window'] = [100, 120]
        self.assertIsNone(self.ask(b, mr, st, trigger, 1100, 1100, 110), 'pressed 10 px before the limit')
        self.assertIn('pressing there', st['takeoffWait'])
        go = self.ask(b, mr, st, trigger, 1160, 1160, 116)
        self.assertAlmostEqual(go['estX'], 120)
        self.assertLess(go['lead'], 1280 - 1160, 'no earlier than the recorded time needs')
        self.assertNotIn('repo', st)

    def test_inputs_after_the_jump_keep_their_relative_delays(self):
        b, mr, st, trigger = self.make()
        st.update(seg=0, segs=[
            {'from': 0, 'until': 280, 'line': [[0, 'right', True]], 'ms': 0, 'keep': ['right'], 'held': 0, 'recorded': [0], 'trigger': None},
            {'from': 280, 'until': 600, 'line': [[0, 'right', True], [0, 'space', True], [80, 'space', False],
                                               [130, 'right', False], [130, 'left', True], [300, 'left', False]],
             'ms': 320, 'keep': [], 'held': 1, 'recorded': [280, 280, 360, 410, 410, 580], 'trigger': trigger}],
                  sawFalse=False, rose=None, waiting=1100, readings=[(1200, 120), (1240, 124)])
        b.tick(1240, {'player': {'valid': True, 'value': [124, 195]}, 'grounded': {'valid': True, 'value': True}})
        b.keys, b.sequence, b.action = set(), None, None
        b._play_parts(st, mr, mr.links[st['link']], [], {}, 'test', None, 124, 195)
        self.assertEqual(b.sequence, [[0, 'right', True], [40, 'space', True], [120, 'space', False],
                                     [170, 'right', False], [170, 'left', True], [340, 'left', False]])


class DestinationSyncTests(unittest.TestCase):
    def make(self):
        fields = [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'},
                  {'name': 'climbing', 'type': 'boolean'}]
        tree = {'root': 'r', 'nodes': {'r': {'kind': 'root', 'params': {'loop': False}, 'children': ['seq']},
                                    'seq': {'kind': 'sequence', 'params': {}, 'children': ['w', 'g']},
                                    'w': {'kind': 'wait', 'params': {'ms': 10000}, 'children': []},
                                    'g': {'kind': 'go', 'params': {'map': 'm', 'place': 'p'}, 'children': []}}}
        b = Behavior(tree, fields, maps={'m': {'position': 'player', 'places': [{'id': 'p', 'x': 100, 'y': -100}], 'links': [],
            'grid': {'replay': {'sync': 'grounded and not climbing', 'arrivePx': 6}},
            'platformer': {'model': MODEL, 'grounds': [[None, [[[0, 0], [200, 0]], [[0, -100], [200, -100]]]]]}}})
        trigger = {'at': 300, 'kind': 'sync', 'expected': {'position': [100, -100], 'level': None}}
        clip = {'keys': [], 'timeline': [[0, 'up', True], [200, 'up', False], [320, 'space', True], [400, 'space', False]], 'end': 500}
        return b, b.shared['maps']['m'], trigger, clip

    def step(self, b, mr, st, trigger, clip, t, y, grounded, climbing):
        b.tick(t, {n: {'valid': True, 'value': v} for n, v in
                   [('player', [100, y]), ('grounded', grounded), ('climbing', climbing)]})
        b.sequence, b.action, b.keys = None, None, set()
        result = b._play_parts(st, mr, {}, [trigger], clip, 'rope', None, 100, y)
        return result, b.action if b.action is not None else b.sequence  # offline (no guard feedback) no action is made, only its presses

    def test_lower_platform_cannot_satisfy_rope_top_and_does_not_start_next_inputs(self):
        b, mr, trigger, clip = self.make()
        st = {'start': 0}
        self.step(b, mr, st, trigger, clip, 0, 0, True, False)
        self.step(b, mr, st, trigger, clip, 100, -40, False, True)
        result, action = self.step(b, mr, st, trigger, clip, 250, 0, True, False)
        self.assertEqual(result, 'running')
        self.assertIsNone(action)
        self.assertIsNone(st['rose'])
        # Even reaching the top with the condition still true is not a new transition.
        self.assertIsNone(self.step(b, mr, st, trigger, clip, 300, -100, True, False)[1])
        self.step(b, mr, st, trigger, clip, 320, -100, True, True)
        result, action = self.step(b, mr, st, trigger, clip, 350, -100, True, False)
        self.assertIsNotNone(action)
        self.assertEqual(st['anchor'], (350, 300))

    def test_wrong_destination_times_out_and_missing_geometry_uses_arrival_region(self):
        b, mr, trigger, clip = self.make()
        st = {'start': 0}
        self.step(b, mr, st, trigger, clip, 0, 0, True, False)
        self.step(b, mr, st, trigger, clip, 100, -40, False, True)
        self.step(b, mr, st, trigger, clip, 250, 0, True, False)
        result, action = self.step(b, mr, st, trigger, clip, 650, 0, True, False)
        self.assertEqual(result, 'sync-failed')
        self.assertIsNone(action)
        self.assertIn('expected destination', st['syncWhy'])
        mr.dynamics = None
        self.assertTrue(b._sync_destination(mr, trigger, None, 103, -100)[0])
        self.assertFalse(b._sync_destination(mr, trigger, None, 103, 0)[0])
        self.assertFalse(b._sync_destination(mr, trigger, 'other', 100, -100)[0])


class RetryAccountingTests(unittest.TestCase):
    def test_return_to_start_counts_as_failure_and_only_endpoint_counts_as_recovered(self):
        b, graph = walks({'startPx': 6, 'arrivePx': 6})
        mr, link = b.shared['maps']['m'], graph['links'][0]
        b.now = 1000
        for attempt, position, success in [(1, link['start'], False), (2, link['end'], True)]:
            st = {'seenAt': (*position, None), 'pendingArrival': {
                'lid': link['id'], 'ms': 800, 'attempt': attempt, 'off': 15, 'since': 900, 'endpoint': link['end']}}
            b._resolve_arrival(st, mr, True, 'lined up')
            event = b.shared['events'][-1]
            self.assertEqual(event['worked'], success)
            if not success:
                self.assertIn('retry', event['how'])
            # No duplicate statistics when the next movement begins.
            b._resolve_arrival(st, mr, True, 'next movement began')
        self.assertEqual(mr.stats[link['id']]['runs'], 2)
        self.assertEqual(mr.stats[link['id']]['fails'], 1)
        self.assertEqual(mr.fails[link['id']], 1)

    def test_matching_coordinates_on_another_level_are_not_recovery(self):
        b, graph = walks({'arrivePx': 6})
        mr, link = b.shared['maps']['m'], graph['links'][0]
        b.now = 1000
        st = {'seenAt': (*link['end'], 'other'), 'pendingArrival': {
            'lid': link['id'], 'ms': 800, 'attempt': 1, 'off': 15, 'since': 900}}
        b._resolve_arrival(st, mr, True, 'lined up')
        self.assertFalse(b.shared['events'][-1]['worked'])


class PendingLandingTests(DestinationSyncTests):
    """2026-10-20 14:33 (the first map's last movement): the frame On Ground turned true still carried the position from
    before the landing, 8 px above the line, and the right landing was taken for a wrong one; the wait timed out. A
    turning true is now a landing pending until a reading says where it was."""

    def airborne(self, b, mr, st, trigger, clip):
        self.step(b, mr, st, trigger, clip, 0, 0, True, False)
        self.step(b, mr, st, trigger, clip, 100, -60, False, True)

    def test_a_stale_reading_at_the_landing_is_confirmed_by_the_next(self):
        b, mr, trigger, clip = self.make()
        st = {'start': 0}
        self.airborne(b, mr, st, trigger, clip)
        result, action = self.step(b, mr, st, trigger, clip, 250, -92, True, False)  # 8 px above the line: on no line yet
        self.assertIsNone(action, 'nothing played before it is confirmed')
        self.assertEqual(st['pendingTransition'], 250)
        result, action = self.step(b, mr, st, trigger, clip, 270, -100, True, False)
        self.assertIsNotNone(action, 'confirmed: the next part plays')
        self.assertEqual(st['anchor'], (250, 300), 'timed from the landing itself, not from when it was confirmed')

    def test_a_landing_on_the_wrong_platform_is_rejected_at_once(self):
        b, mr, trigger, clip = self.make()
        st = {'start': 0}
        self.airborne(b, mr, st, trigger, clip)
        result, action = self.step(b, mr, st, trigger, clip, 250, 0, True, False)  # on the lower platform
        self.assertIsNone(action)
        self.assertFalse(st['sawFalse'], 'a new landing is needed')
        self.assertNotIn('pendingTransition', st)
        result, action = self.step(b, mr, st, trigger, clip, 300, -100, True, False)
        self.assertIsNone(action, 'reaching the right one still on the ground is no landing')

    def test_one_never_confirmed_is_rejected_after_its_timeout(self):
        from behavior import TRANSITION_CONFIRM_MS
        b, mr, trigger, clip = self.make()
        st = {'start': 0}
        self.airborne(b, mr, st, trigger, clip)
        self.step(b, mr, st, trigger, clip, 250, -92, True, False)
        self.step(b, mr, st, trigger, clip, 250 + TRANSITION_CONFIRM_MS - 10, -92, True, False)
        self.assertTrue(st['sawFalse'], 'still pending within its timeout')
        result, action = self.step(b, mr, st, trigger, clip, 250 + TRANSITION_CONFIRM_MS + 10, -92, True, False)
        self.assertIsNone(action)
        self.assertFalse(st['sawFalse'])
        self.assertIn('within', st['syncDestination'])
        result, action = self.step(b, mr, st, trigger, clip, 400, -100, True, False)
        self.assertIsNone(action, 'too late to count')
