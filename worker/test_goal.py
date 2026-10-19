import tempfile
import unittest

from formulas import Missing
from observations import Featurizer, goal_names, goal_numbers
from worker import Worker

SCHEMA = {'identity': 'x', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'left', 'type': 'boolean'},
                                      {'name': 'spot', 'type': 'vector'}, {'name': 'hp', 'type': 'number'}]}
GOAL = {'name': 'goal', 'position': 'player', 'facing': 'left', 'target': 'spot', 'lookAhead': [0.1, 0.2], 'targets': 2, 'minMove': 20}


def sample(x, y=100, left=False, spot=(500, 100)):
    return [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'left', 'valid': True, 'value': left},
            {'name': 'spot', 'valid': True, 'value': list(spot)}, {'name': 'hp', 'valid': True, 'value': 1.0}]


class GoalTests(unittest.TestCase):
    def test_in_play_it_aims_at_the_target_forward_and_no_further_than_training_went(self):
        f = Featurizer(SCHEMA, goal={**GOAL, 'cap': 300})
        names = f.names()
        self.assertEqual(names[-3:], goal_names(f.goal))
        self.assertEqual(names[-3:], ['goal.forward', 'goal.dy', 'goal.dist'])
        x = f(sample(100, spot=(200, 100)))
        self.assertEqual(x[-3:], [100, 0, 100])
        x = f(sample(100, left=True, spot=(200, 100)))
        self.assertEqual(x[-3:], [-100, 0, 100])          # facing left, the target is behind
        x = f(sample(100, spot=(100 + 3000, 100)))
        self.assertEqual(x[-3:], [300, 0, 300])           # far: as far as training went, the same way
        self.assertNotIn('goal.dist', f.history_names())  # a moment's goal isn't shown for earlier steps

    def test_without_a_target_play_has_nothing_to_go_on(self):
        f = Featurizer(SCHEMA, goal={k: v for k, v in GOAL.items() if k != 'target'})
        with self.assertRaisesRegex(Missing, 'no target'):
            f(sample(100))

    def test_the_numbers(self):
        self.assertEqual(goal_numbers({'name': 'g'}, (0, 0), (30, -40)), [30, -40, 50])
        self.assertEqual(goal_numbers({'name': 'g', 'cap': 25}, (0, 0), (30, -40)), [15, -20, 25])

    def test_bad_goals_say_what_is_wrong(self):
        for bad, message in [({**GOAL, 'position': 'hp'}, 'Position'), ({**GOAL, 'lookAhead': [4, 1]}, 'shortest first'),
                             ({**GOAL, 'targets': 0}, 'targets'), ({**GOAL, 'facing': 'spot'}, 'Facing')]:
            with self.assertRaisesRegex(ValueError, message):
                Featurizer(SCHEMA, goal=bad)


    def test_the_editor_is_told_each_goals_columns_or_what_is_wrong(self):
        with tempfile.TemporaryDirectory() as root:
            res = Worker(root).columns({'recordingIds': [], 'fields': SCHEMA['fields'],
                                        'goals': [GOAL, {**GOAL, 'name': 'bad', 'position': 'hp'}]})
            self.assertEqual(res['goals'][0]['columns'], ['goal.forward', 'goal.dy', 'goal.dist'])
            self.assertIsNone(res['goals'][0]['error'])
            self.assertIn('Position', res['goals'][1]['error'])


class HindsightTests(unittest.TestCase):
    def test_training_aims_each_moment_where_the_player_got_to(self):
        with tempfile.TemporaryDirectory() as root:
            w = Worker(root)
            # A recording walking right 10 px a step (50 ms), then standing still: its rows aim 100 and 200 ms ahead
            steps = [(100 + 10 * k) for k in range(30)] + [390] * 20
            samples = []
            for k, x in enumerate(steps):
                samples.append({'timestamp': 1000.0 + 50 * k, 'observations': {o['name']: o for o in sample(x)},
                                'actions': {'valid': True, 'buttons': {'right': k < 30}}})
            f = Featurizer(SCHEMA, columns=['hp', 'goal.forward', 'goal.dy', 'goal.dist'], goal=GOAL)
            f.goal_reach = 0.0
            from collections import Counter
            from observations import on_grid
            reasons = Counter()
            grid = on_grid([s['timestamp'] for s in samples], 50)
            rows = Worker._rows(samples, grid, samples[0]['timestamp'], 50, f, 0, 0, 0, [{'id': 'right'}], reasons, set())
            first = [r for r in rows if r[0] == 1000.0]
            self.assertEqual(sorted(r[1][1] for r in first), [20, 40])  # 2 and 4 steps ahead: 20 and 40 px forward
            self.assertTrue(all(r[2] == [1.0] for r in first))          # the same buttons for each target
            # Standing still: nowhere it got to was 20 px away, so no rows
            self.assertTrue(all(r[0] < 1000 + 50 * 30 for r in rows))
            self.assertIn('goal: no target in its look-ahead 20 px or more away', reasons)
            self.assertEqual(f.goal_reach, 40)


class TwoRuns(unittest.TestCase):
    """Recordings of walking right along a floor, then up a rope."""
    def setUp(self):
        import json, sqlite3
        from contextlib import closing
        from pathlib import Path
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        schema = {'identity': 'obs', 'fields': SCHEMA['fields']}
        actions = {'identity': 'act', 'buttons': [{'id': 'right', 'vk': 39}, {'id': 'up', 'vk': 38}]}
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            for rid in ('run', 'again'):
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps({'observationSchema': schema, 'actionSchema': actions})))
                # Right along the floor 10 px a step (50 ms) to x 600, then up a rope at x 600 to y -500
                for i in range(110):
                    x, y = (10 * i, 0) if i <= 60 else (600, -10 * (i - 60))
                    sample = {'valid': True, 'timestamp': 1000 + 50 * i, 'observationSchema': 'obs', 'actionSchema': 'act',
                              'observations': sample_of(x, y), 'actions': {'valid': True, 'buttons': {'right': i <= 60, 'up': i > 60}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps(sample)))
        self.goal = {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                     'route': {'recording': 'run', 'aheadS': 1}}

    def tearDown(self):
        self.temp.cleanup()


class RouteTests(TwoRuns):
    """Play following a route: the target is where the player went in a recording, aheadS seconds on from where
    the player is on it."""

    def test_it_trains_and_plays_toward_the_route_ahead(self):
        w = Worker(self.root)
        made = w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                        'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        goal = made['features']['goal']
        self.assertEqual(goal['route'], {'recording': 'run', 'aheadS': 1.0})
        self.assertEqual(goal['path'][0], [0, 0, 0])
        self.assertEqual(goal['path'][-1], [5450, 600, -490])
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        self.assertEqual(f(sample_of(100, 0))[:2], [200, 0])      # on the floor: 1 s on, 200 px further right
        self.assertEqual(f(sample_of(600, -100))[:2], [0, -200])  # on the rope: 200 px up it
        self.assertEqual(f(sample_of(600, -480))[:2], [0, -10])   # near the end: the end
        self.assertEqual(f(sample_of(-400, 0))[:2], [300, 0])     # off the route: from its nearest point, as far as training went

    def test_a_route_passing_a_place_twice_keeps_to_the_pass_the_player_is_on(self):
        from observations import route_point
        # Right along y 0, then back left along y 10 (near enough to be the same place)
        path = [[50 * i, 10 * i, 0] for i in range(50)] + [[2500 + 50 * i, 490 - 10 * i, 10] for i in range(50)]
        times = [p[0] for p in path]
        self.assertEqual(route_point(path, times, (100, 4), None), 10)    # starting out: the first pass, nearest
        self.assertEqual(route_point(path, times, (100, 6), 89), 89)      # coming back along the second pass, near where it was
        self.assertEqual(route_point(path, times, (300, 0), 10), 30)

    def test_off_the_route_it_rejoins_on_the_players_own_level_not_overhead(self):
        from observations import route_point
        # Left along the floor from x 1000 to 800, up a rope there to y -300, then left along a ledge to x 0
        path = ([[50 * i, 1000 - 10 * i, 0] for i in range(21)] + [[1050 + 50 * i, 800, -10 * i] for i in range(1, 31)]
                + [[2550 + 50 * i, 800 - 10 * i, -300] for i in range(1, 81)])
        times = [p[0] for p in path]
        i = route_point(path, times, (0, 0), None)        # on the floor, under the end of the ledge
        self.assertEqual(path[i][1:], [800, 0])           # the route on the floor, not the ledge 300 px overhead
        i = route_point(path, times, (100, -300), None)   # on the ledge: there
        self.assertEqual(path[i][1:], [100, -300])

    def test_trained_again_after_its_recording_was_deleted_it_follows_the_path_it_kept(self):
        import sqlite3
        from contextlib import closing
        w = Worker(self.root)
        made = w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                        'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute("DELETE FROM recordings WHERE id='run'")
        again = w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': made['features']['goal'],
                         'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        self.assertEqual(again['features']['goal']['path'], made['features']['goal']['path'])
        with self.assertRaisesRegex(ValueError, 'gone'):
            w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                     'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})

    def test_a_goal_measured_from_facing_needs_the_facing_as_a_value(self):
        w = Worker(self.root)
        goal = {**self.goal, 'facing': 'left'}
        with self.assertRaisesRegex(ValueError, 'measured from left'):
            w.train({'recordingIds': ['again'], 'columns': ['goal.forward', 'goal.dy', 'goal.dist'], 'goal': goal,
                     'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        made = w.train({'recordingIds': ['again'], 'columns': ['left', 'goal.forward', 'goal.dy', 'goal.dist'], 'goal': goal,
                        'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        self.assertEqual(made['features']['goal']['facing'], 'left')

    def test_a_route_or_a_target_not_both(self):
        with self.assertRaisesRegex(ValueError, 'not both'):
            Featurizer(SCHEMA, goal={**self.goal, 'target': 'spot'})


class PlanTests(TwoRuns):
    """Play planned from what the player has done (planner.py), here from the same recordings as the route's."""
    def plan(self, **dest):
        return {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                'plan': {'cell': 40, 'aheadS': 1, 'destination': dest or {'kind': 'end', 'recording': 'run'}, 'recordings': ['run']}}

    def train(self, goal):
        return Worker(self.root).train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': goal,
                                         'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})

    def test_it_learns_the_places_and_moves_and_heads_for_where_the_recording_ended(self):
        goal = self.train(self.plan())['features']['goal']
        self.assertGreater(len(goal['plan']['graph']['places']), 20)
        self.assertEqual((goal['plan']['destination']['x'], goal['plan']['destination']['y']), (600, -490))
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        dx, dy, _ = f(sample_of(100, 0))
        self.assertGreater(dx, 100); self.assertEqual(dy, 0)          # along the floor first, the way it was done
        dx, dy, _ = f(sample_of(600, -100))
        self.assertEqual(dx, 0); self.assertLess(dy, -100)            # then up the rope

    def test_a_clicked_point_and_the_preview(self):
        goal = self.plan(kind='point', x=600, y=-300)
        w = Worker(self.root)
        pic = w.planner_preview({'goal': goal, 'recordingIds': ['again'], 'fields': SCHEMA['fields'], 'formulas': [],
                                 'observations': sample_of(200, 0)})
        self.assertIsNone(pic['error'])
        self.assertEqual(pic['path'][0][1], 0); self.assertEqual(pic['path'][-1][0], 600)
        self.assertEqual(pic['next']['keys'], ['right'])
        self.assertGreater(pic['target'][0], 200)
        self.assertEqual(pic['count']['places'], len(pic['places']))

    def test_nowhere_its_moves_lead_says_so(self):
        w = Worker(self.root)
        pic = w.planner_preview({'goal': self.plan(kind='point', x=0, y=0), 'recordingIds': ['again'], 'fields': SCHEMA['fields'],
                                 'formulas': [], 'observations': sample_of(600, -400)})
        self.assertIn('No move', pic['error'])                         # only ever went up the rope, never down it
        self.assertRegex(pic['error'], r"you're at \(600, -400\).*its moves reach \d+ place.*px short")
        self.assertEqual(pic['stuck']['at'][0], 600)

    def test_play_heads_where_the_graph_says_now_not_where_it_trained_to(self):
        # Trained following the route; played with the graph's plan (changed since), learned as it loads
        w = Worker(self.root)
        made = w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal_route(),
                        'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        w.load({'modelId': made['id'], 'observationSchema': 'obs', 'actionSchema': 'act',
                'goal': {'plan': {'cell': 40, 'aheadS': 1, 'destination': {'kind': 'point', 'x': 600, 'y': -300}, 'recordings': ['run']}}})
        f = w.loaded[4]
        self.assertNotIn('route', f.goal); self.assertIn('graph', f.goal['plan'])
        dx, dy, _ = f(sample_of(600, -100))
        self.assertEqual(dx, 0); self.assertLess(dy, -100)                 # up the rope, toward the plan's point
        w.load({'modelId': made['id'], 'observationSchema': 'obs', 'actionSchema': 'act'})
        self.assertIn('route', w.loaded[4].goal)                           # without one, what it trained with

    def goal_route(self):
        return {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                'route': {'recording': 'run', 'aheadS': 1}}

    def test_a_destination_wired_in_must_be_a_position(self):
        with self.assertRaisesRegex(ValueError, 'Destination'):
            Featurizer(SCHEMA, goal=self.plan(kind='input', name='hp'))


SHAPES_SCHEMA = {'identity': 'obs2', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'platforms', 'type': 'shapes'},
                                                {'name': 'map', 'type': 'number'}, {'name': 'left', 'type': 'boolean'},
                                                {'name': 'monsters', 'type': 'shapes'}]}


def level_shapes(dx=0, dy=0):
    # A floor, and a ledge 80 px up overlapping its right end
    return [{'points': [[0 + dx, 200 + dy], [400 + dx, 200 + dy]]}, {'points': [[300 + dx, 120 + dy], [500 + dx, 120 + dy]]}]


def shapes_sample(x, y, dx=0, dy=0, level=1):
    return [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'platforms', 'valid': True, 'value': level_shapes(dx, dy)},
            {'name': 'map', 'valid': True, 'value': level}, {'name': 'left', 'valid': True, 'value': False},
            {'name': 'monsters', 'valid': True, 'value': [{'points': [[x + 60, 180], [x + 90, 180]]}]}]  # a monster that keeps moving


class ShapesPlanTests(unittest.TestCase):
    """Places along shapes, learned from two runs of walking a floor and hopping up onto a ledge."""
    def setUp(self):
        import json, sqlite3
        from contextlib import closing
        from pathlib import Path
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        actions = {'identity': 'act', 'buttons': [{'id': 'right', 'vk': 39}, {'id': 'space', 'vk': 32}]}
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            for rid in ('a', 'b'):
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps({'observationSchema': SHAPES_SCHEMA, 'actionSchema': actions})))
                path = [(10 * i, 195, ('right',)) for i in range(26)]                                   # along the floor to x 250
                path += [(250 + 20 * k, 195 - 20 * k - (30 if 0 < k < 4 else 0), ('right', 'space')) for k in range(1, 5)]  # the hop
                path += [(330 + 10 * i, 115, ('right',)) for i in range(16)]                              # along the ledge
                for i, (x, y, keys) in enumerate(path):
                    sample = {'valid': True, 'timestamp': 1000 + 50 * i, 'observationSchema': 'obs2', 'actionSchema': 'act',
                              'observations': shapes_sample(x, y), 'actions': {'valid': True, 'buttons': {'right': 'right' in keys, 'space': 'space' in keys}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps(sample)))
        self.goal = {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                     'plan': {'places': 'shapes', 'inputs': [{'alias': 'platforms', 'shapes': ['platforms']}], 'snap': 12, 'tolerance': 25,
                              'cell': 40, 'aheadS': 1, 'destination': {'kind': 'point', 'x': 480, 'y': 115}, 'recordings': ['a', 'b']}}

    def tearDown(self):
        self.temp.cleanup()

    def test_the_plans_next_move_is_a_value_in_training_and_play(self):
        import observations
        goal = {**self.goal, 'hint': True}
        cols = ['goal.dx', 'goal.dy', 'goal.dist']
        w = Worker(self.root)
        rows = w.dataset({'recordingIds': ['a'], 'columns': cols, 'goal': goal, 'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0})
        names = ['goal.next.right', 'goal.next.space', 'goal.soon.right', 'goal.soon.space']
        self.assertEqual(rows['featurize'].names()[-4:], names)         # one per button the policy presses
        x = [r for _, sequence in rows['recordings'] for _, r, _ in sequence]
        nxt = [r[-4] for r in x]
        self.assertGreater(sum(nxt) / len(nxt), .5)                     # mostly walking right toward where they got to
        self.assertTrue(any(r[-1] <= 40 for r in x))                    # the hop's space, soon before it
        made = w.train({'recordingIds': ['a'], 'columns': cols, 'goal': goal, 'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        f = Featurizer(SHAPES_SCHEMA, columns=cols + names, goal=made['features']['goal'])
        dx, dy, dist, nr, ns, sr, ss = f(shapes_sample(20, 195))
        self.assertEqual((nr, ns, sr), (1.0, 0.0, 0))                   # right now; space when it reaches the hop
        self.assertGreater(ss, 100); self.assertLessEqual(ss, observations.planner_.HINT_CAP)

    def test_a_planned_move_that_doesnt_happen_costs_more(self):
        import observations
        made = Worker(self.root).train({'recordingIds': ['a'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                                        'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        f = Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=made['features']['goal'])
        now = [1000.0]
        real, observations.time.monotonic = observations.time.monotonic, lambda: now[0]
        try:
            f(shapes_sample(20, 195))
            self.assertEqual(f._planner.penalty, {})
            now[0] += 5                                                 # stuck where it was for 5 s
            f(shapes_sample(20, 195))
            self.assertEqual(len(f._planner.penalty), 1)
        finally:
            observations.time.monotonic = real
        g = {**made['features']['goal'], 'plan': {**made['features']['goal']['plan'], 'learn': False}}
        f = Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=g)
        f(shapes_sample(20, 195)); f._attempt = None
        self.assertEqual(f._planner.penalty, {})

    def test_keep_away_from_is_weighed_from_the_shapes_in_each_sample(self):
        goal = {**self.goal, 'plan': {**self.goal['plan'], 'avoid': [{'alias': 'monsters', 'shapes': ['monsters']}]}}
        made = Worker(self.root).train({'recordingIds': ['a'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': goal,
                                        'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        self.assertEqual(made['features']['goal']['plan']['avoid'][0]['alias'], 'monsters')
        f = Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=made['features']['goal'])
        f(shapes_sample(20, 195))
        from observations import _frame
        away = f.plan_away(_frame(shapes_sample(20, 195)), f._planner)
        near = [i for i, p in enumerate(f._planner.places) if abs(p[1] - 95) < 30]
        far = [i for i, p in enumerate(f._planner.places) if p[1] > 300]
        self.assertTrue(near and far)
        self.assertGreater(away(near[0]), 0); self.assertEqual(away(far[0]), 0)
        with self.assertRaisesRegex(ValueError, 'keep away'):
            Featurizer(SHAPES_SCHEMA, goal={**goal, 'plan': {**goal['plan'], 'avoid': [{'alias': 'x', 'shapes': ['nothing']}]}})

    def test_it_learns_moves_along_shapes_and_heads_up_onto_the_ledge(self):
        made = Worker(self.root).train({'recordingIds': ['a'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                                        'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        graph = made['features']['goal']['plan']['graph']
        self.assertIn('+', graph['moves']['along']['platforms'])
        self.assertEqual(len(graph['moves']['hops']), 1)
        f = Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=made['features']['goal'])
        dx, dy, _ = f(shapes_sample(20, 195))
        self.assertGreater(dx, 100); self.assertEqual(dy, 0)              # along the floor toward the hop
        self.assertEqual((f.heading['kind'], f.heading['y']), ('plan', 195))  # what play is heading for, for the banner
        self.assertGreater(f.heading['distance'], 100)
        # The same arrangement elsewhere, never recorded: the hop is planned there too
        from planner import Planner, ShapeMap, level_graph
        lines = [('platforms', s['points']) for s in level_shapes(1000, 100)]
        p = Planner(level_graph(ShapeMap(lines, 40, 12), graph['moves'], 25))
        self.assertIsNotNone(p.path(p.place_at(None, 1020, 295), p.place_at(None, 1480, 215)))

    def test_the_preview_counts_the_library_and_what_it_replays(self):
        pic = Worker(self.root).planner_preview({'goal': self.goal, 'recordingIds': ['a'], 'fields': SHAPES_SCHEMA['fields'], 'formulas': [],
                                                 'observations': shapes_sample(20, 195)})
        self.assertIsNone(pic['error'])
        self.assertEqual(pic['library']['hops'], 1)
        self.assertEqual(pic['library']['coverage'], {'hops': 2, 'replayed': 2})  # each run's hop, from the other's moves
        self.assertEqual(pic['path'][-1][1], 115)                                 # up on the ledge, where the player stands on it
        self.assertEqual(pic['count']['places'], len(pic['places']))
        self.assertEqual(len(pic['shapes']), 2)                                   # the lines it planned over, to draw

    def test_shapes_that_move_arent_places_and_say_so(self):
        goal = {**self.goal, 'plan': {**self.goal['plan'], 'inputs': [{'alias': 'platforms', 'shapes': ['platforms']}, {'alias': 'monsters', 'shapes': ['monsters']}]}}
        pic = Worker(self.root).planner_preview({'goal': goal, 'recordingIds': ['a'], 'fields': SHAPES_SCHEMA['fields'], 'formulas': [],
                                                 'observations': shapes_sample(20, 195)})
        self.assertEqual(pic['moving'], ['monsters'])
        self.assertEqual(len(pic['shapes']), 2)                                   # the platforms' two lines only
        self.assertIsNone(pic['error'])

    def test_a_slow_level_goes_without_rather_than_holding_the_frame_up(self):
        import time
        import observations
        import planner as P
        made = Worker(self.root).train({'recordingIds': ['a'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                                        'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        f = Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=made['features']['goal'])
        quick = P.level_graph
        def slow(*a, **k):
            time.sleep(0.3)
            return quick(*a, **k)
        P.level_graph = slow
        try:
            start = time.perf_counter()
            with self.assertRaisesRegex(Missing, 'planning this level'):
                f(shapes_sample(20, 195))
            self.assertLess(time.perf_counter() - start, 0.2)                   # the frame wasn't held up
            time.sleep(0.4)
            dx, _, _ = f(shapes_sample(20, 195))                                # ready: planned
            self.assertGreater(dx, 100)
        finally:
            P.level_graph = quick

    def trained_featurizer(self):
        made = Worker(self.root).train({'recordingIds': ['a'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal,
                                        'buttons': ['right', 'space'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        return made, Featurizer(SHAPES_SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=made['features']['goal'])

    def test_a_frame_without_the_shapes_keeps_the_level(self):
        import planner as P
        _, f = self.trained_featurizer()
        f(shapes_sample(20, 195))
        quick, made = P.level_graph, []
        P.level_graph = lambda *a, **k: made.append(1) or quick(*a, **k)
        try:
            unread = [o if o['name'] != 'platforms' else {**o, 'valid': False, 'value': None} for o in shapes_sample(40, 195)]
            for _ in range(5):
                dx, _, _ = f(unread)                                            # the platforms not read: planned as before
                self.assertGreater(dx, 100)
            self.assertEqual(made, [])                                          # and not made again
        finally:
            P.level_graph = quick

    def test_levels_changing_quickly_make_one_planner_at_a_time(self):
        import threading, time
        import planner as P
        _, f = self.trained_featurizer()
        quick, running, most = P.level_graph, [0], [0]
        def slow(*a, **k):
            running[0] += 1; most[0] = max(most[0], running[0])
            time.sleep(0.1)
            running[0] -= 1
            return quick(*a, **k)
        P.level_graph = slow
        try:
            for i in range(10):                                                 # two levels, every other frame
                try:
                    f(shapes_sample(20 + 1000 * (i % 2), 195, dx=1000 * (i % 2)))
                except Missing:
                    pass
                time.sleep(0.02)
            self.assertEqual(most[0], 1)
        finally:
            P.level_graph = quick

    def test_play_reuses_what_the_plan_learned(self):
        made, _ = self.trained_featurizer()
        w = Worker(self.root)
        original = Worker._plan_samples
        def refuse(*a, **k):
            raise AssertionError('read the recordings again')
        Worker._plan_samples = refuse
        try:
            w.load({'modelId': made['id'], 'observationSchema': 'obs2', 'actionSchema': 'act', 'goal': {'plan': self.goal['plan']}})
            self.assertIn('moves', w.loaded[4].goal['plan']['graph'])
        finally:
            Worker._plan_samples = original

    def test_live_from_one_sample_with_a_facing_that_looks_a_step_back(self):
        goal = {**self.goal, 'facing': 'face_before'}
        pic = Worker(self.root).planner_preview({'goal': goal, 'recordingIds': ['a'], 'fields': SHAPES_SCHEMA['fields'],
                                                 'formulas': [{'name': 'face_before', 'source': 'left[-1]'}], 'observations': shapes_sample(20, 195)})
        self.assertIsNone(pic['error'])
        self.assertEqual(pic['position'], [20, 195])

    def test_a_destination_clicked_on_another_level_isnt_planned_to_here(self):
        goal = {**self.goal, 'plan': {**self.goal['plan'], 'level': 'map', 'destination': {'kind': 'point', 'x': 480, 'y': 115, 'level': repr(2.0)}}}
        pic = Worker(self.root).planner_preview({'goal': goal, 'recordingIds': ['a'], 'fields': SHAPES_SCHEMA['fields'], 'formulas': [],
                                                 'observations': shapes_sample(20, 195, level=1)})
        self.assertIn('another level', pic['error'])
        self.assertIsNone(pic.get('path'))
        pic = Worker(self.root).planner_preview({'goal': goal, 'recordingIds': ['a'], 'fields': SHAPES_SCHEMA['fields'], 'formulas': [],
                                                 'observations': shapes_sample(20, 195, level=2)})
        self.assertIsNone(pic['error']); self.assertIsNotNone(pic['path'])


def sample_of(x, y):
    return [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'left', 'valid': True, 'value': False},
            {'name': 'spot', 'valid': True, 'value': [0, 0]}, {'name': 'hp', 'valid': True, 'value': 1.0}]


if __name__ == '__main__':
    unittest.main()
