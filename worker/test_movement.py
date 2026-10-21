import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from behavior import Behavior
from keys import Keys, clip
from movement import learn, deviation
from worker import Worker


def demonstration(recorded=True, level=None):
    # Two jump presses separated by a 403 ms release, inside one uninterrupted
    # movement. Visiting the destination early must not end or replan the clip.
    events = [(120, 'left', True), (120, 'space', True), (311, 'space', False),
              (320, 'left', False), (320, 'right', True), (714, 'space', True),
              (899, 'space', False), (900, 'right', False)]
    keys = Keys(events)
    keys.recorded = recorded
    track = [(0, 0, 0), (100, 0, 0), (200, 20, -10), (400, 100, 0),
             (600, 50, -30), (800, 80, -10), (1000, 100, 0), (1100, 100, 0)]
    return ('run', track, None, [level] * len(track), keys)


def graph_behavior(graph, replay=None):
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 6, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {
        'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
        'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    keys = demonstration()[-1]
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}], clips=clips,
                    maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 300, 'linkMs': 100,
                                'places': places, 'links': graph['links'], **({'grid': {'replay': replay}} if replay else {})}})


def tick(b, t, x=0, y=0, state='idle', aid=0):
    return b.tick(t, {'player': {'valid': True, 'value': [x, y]}},
                  execution={'id': aid, 'state': state, 'startedAt': 80, 'elapsedMs': max(0, t - 80)})


class MovementTests(unittest.TestCase):
    def test_keeps_both_jumps_in_one_clip_and_never_splices_at_a_repeated_position(self):
        g = learn([demonstration()])
        self.assertEqual(len(g['links']), 1)
        b = graph_behavior(g)
        self.assertIsNone(tick(b, 0)['action'])  # settle before starting
        out = tick(b, 80)
        self.assertEqual(out['action'], {'id': 1, 'durationMs': 880, 'supervised': True})
        jumps = [(t, down) for t, key, down in out['sequence'] if key == 'space']
        self.assertEqual(jumps, [(0, True), (191, False), (594, True), (779, False)])
        self.assertEqual(jumps[2][0] - jumps[1][0], 403)
        out = tick(b, 400, 100, 0, 'running', 1)
        self.assertIsNone(out['action'])
        self.assertIsNone(out['done'])
        self.assertIsNotNone(out['maps']['m']['link'])
        # Even beyond the estimated end, require native completion.
        out = tick(b, 1000, 100, 0, 'running', 1)
        self.assertIsNone(out['done'])
        tick(b, 1050, 100, 0, 'completed', 1)
        self.assertIsNone(tick(b, 1100, 100, 0, 'completed', 1)['done'])
        tick(b, 1130, 100, 0, 'completed', 1)
        self.assertEqual(tick(b, 1140, 100, 0, 'completed', 1)['done'], 'success')

    LINE_UP = {'startPx': 3, 'lineUp': {'x': {'less': ['left'], 'more': ['right']}, 'tapMs': 40, 'tries': 3}}

    def test_off_its_start_it_taps_toward_it_and_learns_how_far_a_tap_goes(self):
        b = graph_behavior(learn([demonstration()]), self.LINE_UP)
        self.assertIn('waiting to stand still', tick(b, 0, 10, 0)['text'])
        out = tick(b, 100, 10, 0)                       # still: a tap toward the start (left), as the guard plays it
        self.assertEqual((out['sequence'], out['action']['id']), ([[0.0, 'left', True], [40.0, 'left', False]], 1))
        self.assertNotIn('supervised', out['action'])
        self.assertIsNone(tick(b, 130, 8, 0, 'running', 1)['sequence'])
        tick(b, 200, 6, 0, 'completed', 1)              # it moved 4 px: 0.1 px a ms
        out = tick(b, 300, 6, 0, 'completed', 1)        # 6 px left: the next tap 60 ms
        self.assertEqual((out['sequence'], out['action']['id']), ([[0.0, 'left', True], [60.0, 'left', False]], 2))
        tick(b, 380, 1, 0, 'completed', 2)
        out = tick(b, 480, 1, 0, 'completed', 2)        # within 3 px: lined up, then still at the start
        self.assertEqual([e['kind'] for e in out['events']], ['line-up'])
        lined = out['events'][0]
        self.assertEqual((lined['worked'], lined['from'], lined['to'], [t['movedPx'] for t in lined['taps']]), (True, [10.0, 0.0], [1.0, 0.0], [-4.0, -5.0]))
        self.assertIsNone(out['action'])
        out = tick(b, 580, 1, 0, 'completed', 2)        # the recorded movement itself
        self.assertEqual((out['action']['id'], out['action']['supervised'], out['events'][0]['kind']), (3, True, 'link'))

    def test_lining_up_gives_up_saying_how_close_it_got_and_the_least_a_tap_moved(self):
        b = graph_behavior(learn([demonstration()]), self.LINE_UP)
        tick(b, 0, 10, 0)
        x, aid, out = 10, 0, None
        for t in range(100, 2000, 100):                 # each tap moves it 1 px
            out = tick(b, t, x, 0, 'completed', aid)
            if out['action']:
                aid = out['action']['id']
                x -= 1
            if out['done']:
                break
        self.assertEqual(out['done'], 'failure')
        self.assertIn('couldn’t line up with the recorded start (0, 0) within 3 px: 7.0 px off after 3 taps; the least a tap moved it was 1 px', out['text'])
        self.assertEqual([e['worked'] for e in out['events'] if e['kind'] == 'line-up'], [False])

    def test_without_line_up_keys_it_says_how_to_start_within_reach(self):
        b = graph_behavior(learn([demonstration()]), {'startPx': 3})
        out = tick(b, 0, 5, 0)
        self.assertEqual(out['done'], 'failure')
        self.assertIn('5 px from the recorded start (0, 0); a replay starts within 3 px (set its keys under Line up with taps', out['text'])

    def test_cancelled_or_missed_movement_does_not_count_as_arrival(self):
        for state in ('cancelled', 'failed', 'completed'):
            with self.subTest(state=state):
                b = graph_behavior(learn([demonstration()]))
                tick(b, 0)
                tick(b, 80)
                out = tick(b, 1000, state=state, aid=1)
                if state == 'completed':
                    out = tick(b, 1350, state=state, aid=1)
                    self.assertIn('ended 100 px', out['text'])
                else:
                    self.assertIn('cancelled or failed', out['text'])
                self.assertEqual(out['keys'], set())
                # nothing held until the player is still, then the map plans again: its one link given up on (Give
                # up 1), there's no way left
                settling = tick(b, 1400, state=state, aid=1)
                self.assertEqual((settling['done'], settling['keys'], settling['sequence']), (None, set(), None))
                self.assertIn('waiting for the player to land and stop', settling['text'])
                out = tick(b, 1500, state=state, aid=1)
                self.assertEqual(out['done'], 'failure')
                self.assertIn('no way from', out['text'])

    def test_cannot_start_from_a_nearby_airborne_grid_cell(self):
        b = graph_behavior(learn([demonstration()]))
        out = tick(b, 0, 20, 0)
        self.assertEqual(out['done'], 'failure')
        self.assertIsNone(out['action'])
        self.assertIn('20 px away', out['text'])

    def test_confirmed_missed_jump_cancels_inputs_and_replans_once_still(self):
        b = graph_behavior(learn([demonstration()]))
        tick(b, 0); tick(b, 80)
        out = tick(b, 300, 40, 200, 'running', 1)
        self.assertIsNone(out['sequence'])
        self.assertEqual(out['maps']['m']['monitor']['state'], 'suspect')
        self.assertIsNone(tick(b, 400, 40, 200, 'running', 1)['done'])
        out = tick(b, 450, 40, 200, 'running', 1)
        self.assertEqual(out['sequence'], [])
        self.assertEqual(out['keys'], set())
        self.assertIsNone(out['done'], 'a deviation no longer ends the tree')
        self.assertIn('remaining inputs cancelled', out['text'])
        self.assertEqual(out['maps']['m']['monitor']['state'], 'failed')
        # the player still falling: nothing held, nothing planned
        for t, y in ((500, 230), (550, 260)):
            o = tick(b, t, 40, y, 'cancelled', 1)
            self.assertEqual((o['action'], o['keys'], o['done']), (None, set(), None))
        tick(b, 600, 40, 260, 'cancelled', 1)
        end = tick(b, 700, 40, 260, 'cancelled', 1)  # still: planned again, its only link given up on
        self.assertEqual(end['done'], 'failure')
        # the trace's account of it: the attempt with what it replays, and its end with the cause
        self.assertEqual(out['events'][-1]['kind'], 'link-end')
        self.assertEqual((out['events'][-1]['worked'], out['events'][-1]['cause'], out['events'][-1]['actionId']), (False, 'deviation', 1))
        self.assertEqual(out['maps']['m']['lastCause'], 'deviation')

    def test_a_recorded_attempt_carries_what_it_replays_into_the_trace(self):
        b = graph_behavior(learn([demonstration()]))
        tick(b, 0)
        out = tick(b, 80)
        begun = [e for e in out['events'] if e['kind'] == 'link']
        self.assertEqual(len(begun), 1)
        recorded = begun[0]['recorded']
        self.assertTrue(recorded['trajectory'] and recorded['clip'] and recorded['start'] and recorded['end'])
        self.assertEqual(out['action']['id'], 1, 'the attempt and its action are in one frame of the trace')
        self.assertEqual(tick(b, 120, 0, 0, 'running', 1)['events'], [], 'an attempt was said again')

    def test_a_movement_is_drawn_along_its_path_thinned_with_its_ends_kept(self):
        from movement import drawn_path
        link = {'trajectory': [[t, t, -t * t / 100, 'L'] for t in range(200)]}
        path = drawn_path(link, most=10)
        self.assertEqual(len(path), 10)
        self.assertEqual((path[0], path[-1]), ([0, 0], [199, -199 * 199 / 100]))
        self.assertEqual(drawn_path({'trajectory': [[0, 1, 2, None]]}), [[1, 2]])
        graph = learn([demonstration()])
        self.assertTrue(all(len(drawn_path(l)) >= 2 for l in graph['links']))

    def test_single_bad_frame_recovers_and_duplicate_frames_do_not_confirm_failure(self):
        b = graph_behavior(learn([demonstration()]))
        tick(b, 0); tick(b, 80)
        tick(b, 300, 40, 200, 'running', 1)
        out = b.tick(700, {'player': {'valid': True, 'value': [40, 200]}},
                     execution={'id': 1, 'state': 'running', 'startedAt': 80}, observation_time=300)
        self.assertIsNone(out['done'])
        out = tick(b, 400, 100, 0, 'running', 1)
        self.assertEqual(out['maps']['m']['monitor']['state'], 'tracking')
        self.assertIsNone(out['sequence'])
        out = tick(b, 450, 40, 200, 'running', 1)
        self.assertIsNone(out['done'])  # confirmation starts over

    def test_monitor_uses_capture_time_and_native_start_not_worker_or_heartbeat_time(self):
        b = graph_behavior(learn([demonstration()]))
        tick(b, 0); tick(b, 80)
        out = b.tick(1200, {'player': {'valid': True, 'value': [20, -10]}},
                     execution={'id': 1, 'state': 'running', 'startedAt': 80, 'elapsedMs': 1100}, observation_time=160)
        monitor = out['maps']['m']['monitor']
        self.assertEqual(monitor['elapsedMs'], 80)
        self.assertEqual(monitor['errorPx'], 0)
        self.assertEqual(monitor['observedAt'], 160)

    def test_phase_local_corridor_does_not_match_a_much_later_visit(self):
        path = [[0, 0, 0, 'a'], [1000, 100, 0, 'a'], [2000, 100, 100, 'a'], [3000, 0, 0, 'a']]
        self.assertGreater(deviation(path, 1500, 'a', 0, 0)[0], 24)
        self.assertEqual(deviation(path, 1000, 'a', 90, 0)[0], 0)  # 100 ms variation is allowed
        self.assertIsNone(deviation(path, 1000, 'other', 100, 0)[1])

    def test_missing_position_cancels_instead_of_continuing_blindly(self):
        b = graph_behavior(learn([demonstration()]))
        tick(b, 0); tick(b, 80)
        execution = {'id': 1, 'state': 'running', 'startedAt': 80}
        b.tick(200, {}, execution=execution)
        out = b.tick(450, {}, execution=execution)
        self.assertEqual(out['sequence'], [])
        self.assertEqual(out['done'], 'failure')
        self.assertIn('position feedback missing', out['text'])
        self.assertEqual(out['events'][-1]['cause'], 'feedback')

    def test_missing_events_gaps_and_oversized_movements_are_not_silently_approximated(self):
        g = learn([demonstration(False)])
        self.assertEqual(g['links'], [])
        self.assertIn('timestamped', g['notes'][0])
        rid, track, grounded, levels, keys = demonstration()
        gap = (rid, track[:3] + track[-2:], grounded, levels[:5], keys)
        self.assertEqual(learn([gap])['links'], [])
        long_keys = Keys([(120, 'right', True), (32000, 'right', False)]); long_keys.recorded = True
        # Dense observations so it is duration, not a capture gap, that rejects it.
        long_track = [(0, 0, 0), (100, 0, 0)] + [(t, t / 320, 0) for t in range(500, 32000, 250)] + [(32000, 100, 0), (32100, 100, 0)]
        result = learn([(rid, long_track, None, None, long_keys)])
        self.assertEqual(result['links'], [])
        self.assertTrue(any('30 seconds' in n for n in result['notes']))

    def test_levels_and_different_recordings_keep_individual_sequence_timing(self):
        g = learn([demonstration(level='one'), demonstration(level='two')])
        self.assertEqual(len(g['places']), 4)
        self.assertEqual(len(g['links']), 2)
        self.assertNotEqual(g['links'][0]['from'], g['links'][1]['from'])


class MovementWorkerTests(unittest.TestCase):
    def test_loading_expands_learned_clips_before_loading_their_events(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            schema = {'identity': 'obs', 'fields': [{'name': 'player', 'type': 'vector'}]}
            actions = {'identity': 'act', 'buttons': [{'id': k, 'vk': vk} for k, vk in [('left', 37), ('right', 39), ('space', 32)]]}
            _, track, _, _, keys = demonstration()
            with closing(sqlite3.connect(root / 'catalog.sqlite')) as db, db:
                db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
                db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
                db.execute('CREATE TABLE inputs(recording TEXT,seq INTEGER,data TEXT)')
                db.execute('INSERT INTO recordings VALUES(?,?,?)', ('run', 'complete', json.dumps({'observationSchema': schema, 'actionSchema': actions})))
                for i, (t, x, y) in enumerate(track):
                    db.execute('INSERT INTO samples VALUES(?,?,?)', ('run', i, json.dumps({'timestamp': t,
                        'observationSchema': 'obs', 'actionSchema': 'act', 'observations': [{'name': 'player', 'valid': True, 'value': [x, y]}]})))
                for i, (t, key, down) in enumerate(keys.events):
                    db.execute('INSERT INTO inputs VALUES(?,?,?)', ('run', i, json.dumps({'timestamp': t, 'kind': 'button', 'id': key, 'down': down})))
            w = Worker(root)
            m = {'position': 'player', 'grounded': 'missingOldState', 'grid': {'cell': 40, 'recordings': ['run']},
                 'places': [{'id': 'destination', 'name': 'Destination', 'x': 100, 'y': -20, 'level': None}], 'links': []}
            preview = w.map_grid({'map': m})
            self.assertEqual(preview['execution'], 'sequences')
            self.assertEqual(len(preview['moves']), 1)
            request = {'tree': {'root': 'root', 'nodes': {
                'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'destination'}, 'children': []}}},
                'fields': schema['fields'], 'maps': {'m': m}, 'buttons': actions['buttons']}
            b = w._behavior(request, learned=True)
            self.assertEqual(b.buttons, ['left', 'right', 'space'])
            tick(b, 0)
            out = tick(b, 80)
            self.assertIsNotNone(out['action'])
            self.assertEqual(out['action']['durationMs'], 880)
            self.assertEqual(w.map_grid({'map': m}), preview)  # cached preview agrees with execution
            # what's cached is by the code that analysed it: changed code never reuses it (a version bumped by hand
            # was forgotten once, and runs went on with movements analysed before the change)
            import worker as worker_
            cached = sorted(p.name for p in (root / 'plans').glob('sequences-*.json'))
            was = worker_.ANALYSIS
            try:
                worker_.ANALYSIS = 'changed'
                w.map_grid({'map': m})
            finally:
                worker_.ANALYSIS = was
            self.assertEqual(len(list((root / 'plans').glob('sequences-*.json'))), len(cached) + 1, 'the cache was reused')


if __name__ == '__main__':
    unittest.main()
