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


GRID_MAP = {'id': 'm', 'name': 'Floor and rope', 'position': 'player', 'level': '', 'places': [], 'links': [], 'grid': {'cell': 40, 'recordings': ['run'], 'execution': 'keys'}}
# the same, as places and links of your own: along the floor, up the rope, and a jump straight there no one made
OWN_MAP = {'id': 'm', 'name': 'Floor and rope', 'position': 'player', 'level': '', 'grid': None,
           'places': [{'id': 'a', 'name': 'Start', 'level': None, 'x': 0, 'y': 0}, {'id': 'b', 'name': 'Rope', 'level': None, 'x': 600, 'y': 0},
                      {'id': 'c', 'name': 'Top', 'level': None, 'x': 600, 'y': -500}],
           'links': [{'id': 'ab', 'from': 'a', 'to': 'b', 'kind': 'keys', 'keys': ['right'], 'ms': 3000},
                     {'id': 'bc', 'from': 'b', 'to': 'c', 'kind': 'keys', 'keys': ['up'], 'ms': 2500},
                     {'id': 'ac', 'from': 'a', 'to': 'c', 'kind': 'keys', 'keys': ['up'], 'ms': 4000}]}


class PlanTests(TwoRuns):
    """Play planned over a map (planner.py): places and moves it learns on a grid from the recordings, and places and
    links of its own."""
    def plan(self, map_=None, **dest):
        return {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                'plan': {'map': map_ or GRID_MAP, 'aheadS': 1, 'destination': dest or {'kind': 'end', 'recording': 'run'}}}

    def train(self, goal):
        return Worker(self.root).train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': goal,
                                         'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})

    def test_it_learns_the_grid_and_heads_for_where_the_recording_ended(self):
        goal = self.train(self.plan())['features']['goal']
        self.assertGreater(len(goal['plan']['graph']['places']), 20)
        self.assertEqual((goal['plan']['destination']['x'], goal['plan']['destination']['y']), (600, -490))
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        dx, dy, _ = f(sample_of(100, 0))
        self.assertGreater(dx, 100); self.assertEqual(dy, 0)          # along the floor first, the way it was done
        self.assertEqual(f.heading['map'], 'm')
        self.assertGreater(len(f.heading['way']), 2)                 # the way, for the map's editor
        dx, dy, _ = f(sample_of(600, -100))
        self.assertEqual(dx, 0); self.assertLess(dy, -100)            # then up the rope

    def test_its_own_places_and_links_by_what_they_did(self):
        w = Worker(self.root)
        goal = self.plan(OWN_MAP, kind='place', place='c')
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        w._learn_plan(f, goal, [])
        dx, dy, _ = f(sample_of(20, 0))
        self.assertLess(dy, -400); self.assertAlmostEqual(dx, 580)     # 4 s straight there is quicker than 3 + 2.5
        # it failed 3 times in 4 (a tree going over the map, or play): along the floor and up the rope instead
        w._map_keep({'m': {'ac': {'runs': 4, 'fails': 3, 'ms': 4000}}})
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        w._learn_plan(f, goal, [])
        dx, dy, _ = f(sample_of(20, 0))
        self.assertEqual((dx, dy), (580, 0))

    def test_how_its_links_went_in_play_is_kept(self):
        import time
        w = Worker(self.root)
        own = {**OWN_MAP, 'links': OWN_MAP['links'][:2]}
        goal = self.plan(own, kind='place', place='c')
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        w._learn_plan(f, goal, [])
        f(sample_of(0, 0))
        time.sleep(0.02)
        f(sample_of(600, 0))                                           # at the rope: the floor's link worked
        self.assertEqual([(m, l, ok) for m, l, ok, _ in f.map_outcomes], [('m', 'ab', True)])
        w._map_outcomes(f.map_outcomes)
        self.assertEqual(w._map_stats(['m'])['m']['ab']['runs'], 1)

    def test_nowhere_its_moves_lead_says_so(self):
        goal = self.train(self.plan(kind='point', x=0, y=0))['features']['goal']
        f = Featurizer(SCHEMA, columns=['goal.dx', 'goal.dy', 'goal.dist'], goal=goal)
        with self.assertRaisesRegex(Missing, 'no move'):              # only ever went up the rope, never down it
            f(sample_of(600, -400))

    def test_play_heads_where_the_graph_says_now_not_where_it_trained_to(self):
        # Trained following the route; played over the graph's map (chosen since), learned as it loads
        w = Worker(self.root)
        made = w.train({'recordingIds': ['again'], 'columns': ['goal.dx', 'goal.dy', 'goal.dist'], 'goal': self.goal_route(),
                        'buttons': ['right', 'up'], 'stepMs': 50, 'history': 0, 'epochs': 1})
        w.load({'modelId': made['id'], 'observationSchema': 'obs', 'actionSchema': 'act',
                'goal': {'plan': {'map': GRID_MAP, 'aheadS': 1, 'destination': {'kind': 'point', 'x': 600, 'y': -300}}}})
        f = w.loaded[4]
        self.assertNotIn('route', f.goal); self.assertIn('graph', f.goal['plan'])
        dx, dy, _ = f(sample_of(600, -100))
        self.assertEqual(dx, 0); self.assertLess(dy, -100)                 # up the rope, toward the plan's point
        w.load({'modelId': made['id'], 'observationSchema': 'obs', 'actionSchema': 'act'})
        self.assertIn('route', w.loaded[4].goal)                           # without one, what it trained with

    def goal_route(self):
        return {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                'route': {'recording': 'run', 'aheadS': 1}}

    def test_what_a_map_plan_needs(self):
        with self.assertRaisesRegex(ValueError, 'Destination'):
            Featurizer(SCHEMA, goal=self.plan(kind='input', name='hp'))
        with self.assertRaisesRegex(ValueError, 'taken off the map'):
            Featurizer(SCHEMA, goal=self.plan(OWN_MAP, kind='place', place='gone'))
        with self.assertRaisesRegex(ValueError, 'no places'):
            Featurizer(SCHEMA, goal=self.plan({**OWN_MAP, 'places': []}, kind='point', x=0, y=0))

    def test_the_grid_drawn_and_a_tree_going_over_it(self):
        w = Worker(self.root)
        drawn = w.map_grid({'map': GRID_MAP})
        self.assertEqual(drawn['count']['places'], len(drawn['places']))
        self.assertEqual(drawn['recordings'], 1)
        tree = w._behavior({'tree': {'root': 'r', 'nodes': {'r': {'kind': 'root', 'params': {}, 'children': ['g']},
                                                              'g': {'kind': 'go', 'params': {'map': 'm', 'target': 'vec(600, -480)'}, 'children': []}}},
                            'fields': SCHEMA['fields'], 'maps': {'m': {**GRID_MAP, 'reach': 30}}}, learned=True)
        self.assertEqual(tree.buttons, ['right', 'up'])               # the keys held for each move learned
        out = tree.tick(0, {o['name']: o for o in sample_of(0, 0)})
        self.assertEqual(out['keys'], {'right'})

    def test_migrated_destination_routes_through_its_learned_cell(self):
        w = Worker(self.root)
        point = {'id': 'destination', 'name': 'Destination', 'level': None, 'x': 600, 'y': -490}
        map_ = {**GRID_MAP, 'places': [point], 'reach': 30}
        expanded = w._with_grid(map_)
        self.assertIn('destination', expanded['aliases'])
        behavior = w._behavior({'tree': {'root': 'r', 'nodes': {
            'r': {'kind': 'root', 'params': {'loop': False}, 'children': ['g']},
            'g': {'kind': 'go', 'params': {'map': 'm', 'place': 'destination'}, 'children': []}}},
            'fields': SCHEMA['fields'], 'maps': {'m': map_}}, learned=True)
        out = behavior.tick(0, {o['name']: o for o in sample_of(0, 0)})
        self.assertEqual(out['keys'], {'right'})
        self.assertNotEqual(out['done'], 'failure')
        # Existing linked places and markers on a different level are not snapped.
        linked = {**map_, 'links': [{'id': 'out', 'from': 'destination', 'to': 'other', 'kind': 'keys', 'keys': ['right']}]}
        self.assertNotIn('destination', w._with_grid(linked)['aliases'])
        other_level = {**map_, 'places': [{**point, 'level': 'elsewhere'}]}
        self.assertNotIn('destination', w._with_grid(other_level)['aliases'])

    def test_destination_above_recorded_route_uses_the_planners_recorded_point(self):
        from unittest.mock import patch
        from behavior import Behavior
        grid = {'cell': 40, 'places': [[None, -698, 266, 5], [None, -1689, -1594, 78]],
                'moves': [[0, 1, 1000, 3, ['left']]]}
        point = {'id': 'destination', 'name': 'Destination', 'level': None, 'x': -1693, 'y': -1652}
        w = Worker(self.root)
        with patch.object(w, '_map_grid', return_value=(grid, {})):
            expanded = w._with_grid({**GRID_MAP, 'places': [point]})
        self.assertEqual(expanded['aliases'], {'destination': 'g1'})
        self.assertEqual(expanded['places'][0], point)  # the saved marker is not moved
        tree = {'root': 'r', 'nodes': {
            'r': {'kind': 'root', 'params': {'loop': False}, 'children': ['g']},
            'g': {'kind': 'go', 'params': {'map': 'm', 'place': 'destination'}, 'children': []}}}
        behavior = Behavior(tree, SCHEMA['fields'], maps={'m': expanded})
        tick = lambda t, x, y: behavior.tick(t, {o['name']: o for o in sample_of(x, y)})
        out = tick(0, -698, 266)
        self.assertEqual(out['keys'], {'left'})
        self.assertNotEqual(out['done'], 'failure')
        tick(1000, -1689, -1594)
        out = tick(1050, -1689, -1594)
        self.assertEqual(out['done'], 'success')
        self.assertIn('Destination (recorded point (-1689, -1594))', out['text'])
        # Resolving a marker does not invent reverse links or an off-route approach.
        behavior = Behavior(tree, SCHEMA['fields'], maps={'m': expanded})
        out = behavior.tick(0, {o['name']: o for o in sample_of(0, 0)})
        self.assertEqual(out['done'], 'failure')
        self.assertIn('not at a place', out['text'])
        reverse = {**expanded, 'aliases': {'destination': 'g0'}}
        behavior = Behavior(tree, SCHEMA['fields'], maps={'m': reverse})
        out = behavior.tick(0, {o['name']: o for o in sample_of(-1689, -1594)})
        self.assertEqual(out['done'], 'failure')
        self.assertIn('no way', out['text'])

    def test_learned_moves_without_keys_release_and_wait_with_a_timeout(self):
        from unittest.mock import patch
        from behavior import Behavior
        grid = {'cell': 40, 'places': [[None, 0, 0, 1], [None, 50, 0, 1], [None, 100, 0, 1]],
                'moves': [[0, 1, 100, 1, ['right']], [1, 2, 100, 1, []]]}
        w = Worker(self.root)
        with patch.object(w, '_map_grid', return_value=(grid, {})):
            expanded = w._with_grid({**GRID_MAP, 'giveUp': 1})
        self.assertEqual(len(expanded['links']), 2)
        tree = {'root': 'r', 'nodes': {
            'r': {'kind': 'root', 'params': {'loop': False}, 'children': ['g']},
            'g': {'kind': 'go', 'params': {'map': 'm', 'place': 'g2'}, 'children': []}}}
        for arrives in (True, False):
            with self.subTest(arrives=arrives):
                behavior = Behavior(tree, SCHEMA['fields'], maps={'m': expanded})
                tick = lambda t, x: behavior.tick(t, {o['name']: o for o in sample_of(x, 0)})
                self.assertEqual(tick(0, 0)['keys'], {'right'})
                tick(100, 50)
                out = tick(150, 50)
                self.assertEqual(out['keys'], set())
                self.assertEqual(out['maps']['m']['link'], 'g1>2')
                self.assertIn('waiting with keys released', out['text'])
                if arrives:
                    tick(250, 100)
                    self.assertEqual(tick(300, 100)['done'], 'success')
                else:
                    out = tick(1000, 50)
                    self.assertIn('not there after', out['text'])
                    out = tick(1050, 50)
                    self.assertEqual(out['done'], 'failure')
                    self.assertEqual(out['keys'], set())


def sample_of(x, y):
    return [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'left', 'valid': True, 'value': False},
            {'name': 'spot', 'valid': True, 'value': [0, 0]}, {'name': 'hp', 'valid': True, 'value': 1.0}]


if __name__ == '__main__':
    unittest.main()
