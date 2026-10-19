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


def sample_of(x, y):
    return [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'left', 'valid': True, 'value': False},
            {'name': 'spot', 'valid': True, 'value': [0, 0]}, {'name': 'hp', 'valid': True, 'value': 1.0}]


if __name__ == '__main__':
    unittest.main()
