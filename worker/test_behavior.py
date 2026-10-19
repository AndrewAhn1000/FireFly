import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from behavior import Behavior

FLOOR, LEDGE = ((0, 200), (400, 200)), ((300, 150), (500, 150))
LINES = [('platforms', [list(p) for p in FLOOR]), ('platforms', [list(p) for p in LEDGE])]
FEET = 5  # px the player stands above a platform


class Game:
    """A small platformer: walking at 0.1 px/ms, a jump of 0.45 px/ms up with gravity, no steering in the air, landing
    on a platform only coming down onto it. The ledge, 50 px up, is reached only taking off on the move from about
    x 255 to 300 on the floor, so a takeoff a few frames late or early misses."""

    WALK, GRAVITY, JUMP = 0.1, 0.0015, 0.45

    def __init__(self, x, y=None, jump=None):
        y = FLOOR[0][1] - FEET if y is None else y
        jump = self.JUMP if jump is None else jump
        self.x, self.y, self.vx, self.vy, self.ground, self.keys, self.jump, self.held_space = x, y, 0.0, 0.0, True, set(), jump, False

    def under(self, x, y):
        for (x0, py), (x1, _) in (FLOOR, LEDGE):
            if x0 <= x <= x1 and abs(y - (py - FEET)) < 0.5:
                return True
        return False

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
            for (x0, py), (x1, _) in (FLOOR, LEDGE):
                top = py - FEET
                if x0 <= nx <= x1 and self.y <= top <= ny:
                    ny, self.vy, self.ground = top, 0.0, True
        self.x, self.y = nx, ny


def record_from_rest(stand=150, takeoff=270, start=20, end=480, pause=400):
    """A player walking right to `stand`, standing still a moment, then walking on and jumping at `takeoff` while
    walking, up the ledge to `end`."""
    g, t, samples, events = Game(start), 0.0, [], [(0.0, 'right', True)]
    g.keys = {'right'}
    stood = walked = jumped = None
    while t < 12000 and not (g.ground and g.x >= end):
        if stood is None and g.x >= stand:
            g.keys = set(); events.append((t, 'right', False)); stood = t
        if stood is not None and walked is None and t - stood >= pause:
            g.keys = {'right'}; events.append((t, 'right', True)); walked = t
        if walked is not None and jumped is None and g.x >= takeoff:
            g.keys.add('space'); events.append((t, 'space', True)); jumped = t
        if jumped is not None and 'space' in g.keys and t - jumped >= 150:
            g.keys.discard('space'); events.append((t, 'space', False))
        if round(t) % 45 == 0:
            samples.append((t, g.x, g.y, LINES, tuple(sorted(g.keys))))
        g.tick(); t += 5
    events.append((t, 'right', False))
    samples.append((t, g.x, g.y, LINES, ()))
    return samples, events


def walk_back(start=390, end=20):
    """A player walking left along the floor."""
    g, t, samples = Game(start), 0.0, []
    g.keys = {'left'}
    while g.x > end:
        if round(t) % 45 == 0:
            samples.append((t, g.x, g.y, LINES, ('left',)))
        g.tick(); t += 5
    return samples, [(0.0, 'left', True), (t, 'left', False)]

FIELDS = [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}, {'name': 'hp', 'type': 'number'}]


def tree(*nodes, root_loop=False):
    """A tree from (id, kind, params, children) tuples, the first under the root."""
    out = {'root': {'kind': 'root', 'params': {'loop': root_loop}, 'children': [nodes[0][0]]}}
    for nid, kind, params, children in nodes:
        out[nid] = {'kind': kind, 'params': params, 'children': children}
    return {'root': 'root', 'nodes': out}


def obs(player=(0, 0), grounded=True, hp=100):
    return {'player': {'valid': player is not None, 'value': list(player) if player else None},
            'grounded': {'valid': True, 'value': grounded}, 'hp': {'valid': True, 'value': hp}}


class CheckTests(unittest.TestCase):
    def test_what_isnt_right_is_said_by_node(self):
        t = tree(('s', 'sequence', {}, ['c', 'p', 'w']), ('c', 'condition', {'formula': 'hp +'}, []),
                 ('p', 'press', {'keys': [], 'ms': 100}, []), ('w', 'walk', {'position': 'hp', 'target': 'player', 'axis': 'x', 'more': ['right'], 'within': 5, 'ms': 1000}, []))
        with self.assertRaises(ValueError) as e:
            Behavior(t, FIELDS)
        errors = e.exception.errors
        self.assertIn('Its formula', errors['c'])
        self.assertIn('choose the keys', errors['p'])
        self.assertIn('Position has to give a position', errors['w'])

    def test_a_composite_needs_children_and_a_decorator_one(self):
        t = tree(('s', 'sequence', {}, []))
        with self.assertRaises(ValueError) as e:
            Behavior(t, FIELDS)
        self.assertIn('give it children', e.exception.errors['s'])


class TickTests(unittest.TestCase):
    def test_a_sequence_goes_on_while_its_children_succeed_and_a_fallback_tries_the_next(self):
        t = tree(('f', 'fallback', {}, ['low', 'walk']),
                 ('low', 'sequence', {}, ['c', 'drink']), ('c', 'condition', {'formula': 'hp < 30'}, []),
                 ('drink', 'press', {'keys': ['potion'], 'ms': 100}, []),
                 ('walk', 'hold', {'keys': ['right'], 'ms': 500}, []))
        b = Behavior(t, FIELDS)
        out = b.tick(0, obs(hp=100))
        self.assertEqual(out['keys'], {'right'})                    # hp isn't low: the fallback's next, holding right
        self.assertEqual((out['nodes']['c'], out['nodes']['low'], out['nodes']['walk']), ('failure', 'failure', 'running'))
        b = Behavior(t, FIELDS)
        out = b.tick(0, obs(hp=10))
        self.assertEqual(out['keys'], {'potion'})
        self.assertEqual(out['sequence'], [[0.0, 'potion', True], [100.0, 'potion', False]])  # for the guard, to the ms
        self.assertIsNone(b.tick(50, obs(hp=10))['sequence'])     # sent once
        self.assertEqual(b.tick(120, obs(hp=10))['done'], 'success')

    def test_hold_until_and_variables(self):
        t = tree(('s', 'sequence', {}, ['start', 'go']), ('start', 'set', {'name': 'from', 'formula': 'player.x'}, []),
                 ('go', 'hold', {'keys': ['right'], 'until': 'player.x > from + 50', 'ms': 2000}, []))
        b = Behavior(t, FIELDS)
        self.assertEqual(b.tick(0, obs((100, 0)))['keys'], {'right'})
        self.assertEqual(b.tick(100, obs((140, 0)))['keys'], {'right'})  # `from` stays 100: set once, when it was reached
        self.assertEqual(b.tick(200, obs((160, 0)))['done'], 'success')
        b = Behavior(t, FIELDS)
        b.tick(0, obs((100, 0)))
        self.assertEqual(b.tick(2100, obs((110, 0)))['done'], 'failure')   # not there in its time

    def test_while_stops_its_child_and_a_press_still_playing_is_stopped(self):
        t = tree(('w', 'while', {'formula': 'grounded'}, ['p']), ('p', 'press', {'keys': ['space'], 'ms': 500}, []))
        b = Behavior(t, FIELDS)
        b.tick(0, obs(grounded=True))
        out = b.tick(100, obs(grounded=False))
        self.assertEqual((out['nodes']['w'], out['done'], out['sequence']), ('failure', 'failure', []))  # [] stops what plays

    def test_retry_repeat_limit_invert(self):
        t = tree(('r', 'retry', {'times': 3}, ['c']), ('c', 'condition', {'formula': 'hp > 50'}, []))
        b = Behavior(t, FIELDS)
        self.assertEqual([b.tick(k, obs(hp=10))['done'] for k in range(3)], [None, None, 'failure'])
        t = tree(('r', 'repeat', {'times': 2}, ['p']), ('p', 'press', {'keys': ['a'], 'ms': 10}, []))
        b = Behavior(t, FIELDS)
        self.assertEqual([b.tick(k * 20, obs())['done'] for k in range(4)], [None, None, None, 'success'])
        t = tree(('l', 'limit', {'ms': 100}, ['h']), ('h', 'hold', {'keys': ['a'], 'ms': 1000}, []))
        b = Behavior(t, FIELDS)
        self.assertEqual((b.tick(0, obs())['done'], b.tick(150, obs())['done']), (None, 'failure'))
        t = tree(('i', 'invert', {}, ['c']), ('c', 'condition', {'formula': 'hp > 50'}, []))
        self.assertEqual(Behavior(t, FIELDS).tick(0, obs(hp=10))['done'], 'success')

    def test_a_looping_root_starts_again(self):
        t = tree(('p', 'press', {'keys': ['a'], 'ms': 10}, []), root_loop=True)
        b = Behavior(t, FIELDS)
        b.tick(0, obs())
        self.assertIsNone(b.tick(20, obs())['done'])
        self.assertEqual(b.tick(30, obs())['sequence'], [[0.0, 'a', True], [10.0, 'a', False]])  # pressed again


def run(b, game, limit=20000, latency=70.0, frame=45.0):
    """The tree playing the little platformer: each frame seen `latency` ms after it was captured, the guard's
    sequences played as the guard plays them."""
    t, pending, timed, playing, out = 0.0, [], [], -1.0, None
    while t < limit:
        if round(t) % round(frame) == 0:
            out = b.tick(t + latency, {'player': {'valid': True, 'value': [game.x, game.y]}, 'grounded': {'valid': True, 'value': game.ground},
                                       'hp': {'valid': True, 'value': 100}})
            pending.append((t + latency, set(out['keys']), out['sequence']))
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
        game.tick(); t += 5
    return out


class GameTests(unittest.TestCase):
    """A tree you'd build for the little platformer: walk to the jump, jump, and if it landed on the ledge walk along
    it; else try again (retry)."""

    def tree(self):
        return tree(('s', 'sequence', {}, ['again', 'along']),
                    ('again', 'retry', {'times': 3}, ['up']),
                    ('up', 'sequence', {}, ['to', 'still', 'jump', 'air', 'land', 'onledge']),
                    ('to', 'walk', {'position': 'player', 'target': 'vec(262, 195)', 'axis': 'x', 'less': ['left'], 'more': ['right'], 'within': 8, 'ms': 8000}, []),
                    ('still', 'wait', {'until': 'grounded', 'ms': 1000}, []),
                    ('jump', 'press', {'keys': ['right', 'space'], 'ms': 150}, []),
                    ('air', 'wait', {'until': 'not grounded', 'ms': 500}, []),
                    ('land', 'wait', {'until': 'grounded', 'ms': 2000}, []),
                    ('onledge', 'condition', {'formula': 'player.y < 170'}, []),
                    ('along', 'walk', {'position': 'player', 'target': 'vec(480, 145)', 'axis': 'x', 'less': ['left'], 'more': ['right'], 'within': 8, 'ms': 8000}, []))

    def test_it_gets_up_onto_the_ledge(self):
        for start, latency in ((20, 70), (380, 120), (150, 40)):
            game = Game(start)
            out = run(Behavior(self.tree(), FIELDS), game, latency=latency)
            self.assertEqual(out['done'], 'success', (start, latency, out))
            self.assertAlmostEqual(game.y, 145, delta=1)
            self.assertAlmostEqual(game.x, 480, delta=15)

    def test_a_jump_too_weak_is_retried_and_then_fails(self):
        out = run(Behavior(self.tree(), FIELDS), Game(20, jump=0.3))
        self.assertEqual(out['done'], 'failure')


def walk_tree(within=6):
    """A tree taking `to`, walking there along x."""
    t = tree(('w', 'walk', {'position': 'player', 'target': 'to', 'axis': 'x', 'less': ['left'], 'more': ['right'], 'within': within, 'ms': 8000}, []))
    t['nodes']['root']['params']['inputs'] = [{'name': 'to', 'type': 'vector'}]
    return t


JUMP_UP = tree(('s', 'sequence', {}, ['j', 'air', 'land']), ('j', 'press', {'keys': ['right', 'space'], 'ms': 150}, []),
               ('air', 'wait', {'until': 'not grounded', 'ms': 500}, []), ('land', 'wait', {'until': 'grounded', 'ms': 2000}, []))

# the little platformer as a map: the floor's left end, under the ledge's edge, and on the ledge
MAP = {'position': 'player', 'reach': 30, 'giveUp': 2,
       'places': [{'id': 'a', 'name': 'Start', 'x': 20, 'y': 195}, {'id': 'b', 'name': 'Takeoff', 'x': 270, 'y': 195},
                  {'id': 'c', 'name': 'Ledge', 'x': 315, 'y': 145}],
       'links': [{'id': 'ab', 'from': 'a', 'to': 'b', 'kind': 'tree', 'tree': 'walk'}, {'id': 'ba', 'from': 'b', 'to': 'a', 'kind': 'tree', 'tree': 'walk'},
                 {'id': 'bc', 'from': 'b', 'to': 'c', 'kind': 'tree', 'tree': 'up'}]}
TREES = {'walk': walk_tree(), 'up': JUMP_UP}


class SubTreeTests(unittest.TestCase):
    def test_a_tree_runs_another_with_its_inputs(self):
        t = tree(('r', 'run', {'tree': 'walk', 'args': {'to': 'vec(player.x + 100, player.y)'}}, []))
        b = Behavior(t, FIELDS, trees={'walk': walk_tree()}, tree_id='main')
        out = b.tick(0, obs((100, 195)))
        self.assertEqual((out['keys'], out['nodes']['r'], out['trees']['walk']['w']), ({'right'}, 'running', 'running'))
        self.assertEqual(b.tick(100, obs((150, 195)))['keys'], {'right'})   # its input stays 200: given when it started
        self.assertEqual(b.tick(200, obs((198, 195)))['done'], 'success')

    def test_what_a_run_tree_node_needs(self):
        with self.assertRaises(ValueError) as e:
            Behavior(tree(('r', 'run', {'tree': 'walk', 'args': {}}, [])), FIELDS, trees={'walk': walk_tree()}, tree_id='main')
        self.assertIn('give its input to a value', e.exception.errors['r'])
        loop = {'a': tree(('r', 'run', {'tree': 'b'}, [])), 'b': tree(('r', 'run', {'tree': 'a'}, []))}
        with self.assertRaises(ValueError) as e:
            Behavior(loop['a'], FIELDS, trees=loop, tree_id='a')
        self.assertIn('loop', e.exception.errors['r'])
        with self.assertRaises(ValueError) as e:
            Behavior(tree(('r', 'run', {'tree': 'gone'}, [])), FIELDS, trees={}, tree_id='main')
        self.assertIn('is gone', e.exception.errors['r'])


class MapTests(unittest.TestCase):
    def go(self, place='c', stats=None, maps=None):
        return Behavior(tree(('g', 'go', {'map': 'm', 'place': place}, [])), FIELDS, trees=TREES, maps={'m': maps or MAP}, stats=stats, tree_id='main')

    def test_it_goes_over_the_map_and_learns_how_long_each_link_takes(self):
        game = Game(20)
        b = self.go()
        out = run(b, game)
        self.assertEqual(out['done'], 'success', out)
        self.assertAlmostEqual(game.y, 145, delta=1)
        stats = b.stats()['m']
        self.assertEqual({k: (s['runs'], s['fails']) for k, s in stats.items()}, {'ab': (1, 0), 'bc': (1, 0)})
        self.assertGreater(stats['ab']['ms'], 2000)              # 250 px at 0.1 px/ms
        self.assertIsNone(b.stats())                              # said once, until it changes

    def test_a_link_that_keeps_failing_is_given_up_on(self):
        out = run(self.go(maps={**MAP, 'approach': {'tree': 'walk'}}), Game(20, jump=0.3))   # back to Takeoff after each
        self.assertEqual(out['done'], 'failure')
        self.assertIn('no way from Takeoff to Ledge (1 link given up on)', out['text'])

    def test_the_quickest_way_and_how_often_a_link_worked(self):
        doc = {**MAP, 'links': [*MAP['links'], {'id': 'ac', 'from': 'a', 'to': 'c', 'kind': 'tree', 'tree': 'up'}]}
        from behavior import MapRun
        stats = lambda bc_fails: {'ab': {'runs': 4, 'fails': 0, 'ms': 2500}, 'bc': {'runs': 4, 'fails': bc_fails, 'ms': 1000},
                                  'ac': {'runs': 4, 'fails': 0, 'ms': 4000}}
        m = MapRun('m', doc, stats(0))
        self.assertEqual(m.route('a', 'c', {}), ['ab', 'bc'])
        m.learn('bc', False, 1000)
        m.learn('bc', False, 1000)
        self.assertEqual(m.route('a', 'c', {}), ['ac'])            # failed twice this run: given up on (giveUp 2)
        self.assertEqual(MapRun('m', doc, stats(3)).route('a', 'c', {}), ['ac'])  # worked 1 time in 4 before: slower


    def test_off_the_map_its_approach_tree_takes_it_to_the_nearest_place(self):
        doc = {**MAP, 'approach': {'tree': 'walk'}}
        game = Game(150)
        out = run(self.go(maps=doc), game)
        self.assertEqual(out['done'], 'success', out)
        out = run(self.go(), Game(150))
        self.assertEqual(out['done'], 'failure')
        self.assertIn('not at a place of the map', out['text'])


class WorkerTests(unittest.TestCase):
    """behavior.load and behavior.step, a clip's keys from its recording, and the clips a recording offers."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        schema = {'identity': 'obs', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}]}
        actions = {'identity': 'act', 'buttons': [{'id': 'right', 'vk': 39}, {'id': 'space', 'vk': 32}]}
        samples, events = record_from_rest(150, 270)
        t, x, y = samples[-1][0], samples[-1][1], samples[-1][2]
        samples += [(t + 45 * k, x, y, LINES, ()) for k in range(1, 8)]   # standing at the end
        with closing(sqlite3.connect(self.root / 'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            db.execute('CREATE TABLE inputs(recording TEXT,seq INTEGER,data TEXT)')
            for rid, (ss, es) in (('e', (samples, events)), ('w', walk_back())):
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps({'observationSchema': schema, 'actionSchema': actions})))
                for i, (t, x, y, _, keys) in enumerate(ss):
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps({
                        'valid': True, 'timestamp': 1000 + t, 'observationSchema': 'obs', 'actionSchema': 'act',
                        'observations': [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'grounded', 'valid': True, 'value': y in (145.0, 195.0)}],
                        'actions': {'valid': True, 'buttons': {b['id']: b['id'] in keys for b in actions['buttons']}}})))
                for i, (t, key, down) in enumerate(es):
                    db.execute('INSERT INTO inputs VALUES(?,?,?)', (rid, i, json.dumps({'kind': 'button', 'id': key, 'down': down, 'injected': False, 'timestamp': 1000 + t})))

    def tearDown(self):
        self.temp.cleanup()

    def test_a_recordings_clips_and_a_tree_playing_one(self):
        from worker import Worker
        w = Worker(self.root)
        clips = w.clips_list({'recording': 'e', 'position': 'player', 'grounded': 'grounded', 'fields': [], 'formulas': []})['clips']
        c = max(clips, key=lambda c: abs(c['dy']))
        self.assertAlmostEqual(c['dy'], -50, delta=1)
        t = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['c']},
                                       'c': {'kind': 'clip', 'params': {'recording': 'e', 'from': c['from'], 'to': c['to']}, 'children': []}}}
        fields = [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}]
        self.assertEqual(w.behavior_check({'tree': t, 'fields': fields}), {'errors': {}, 'buttons': ['right', 'space']})
        loaded = w.behavior_load({'tree': t, 'fields': fields, 'buttons': [{'id': 'right', 'vk': 39}, {'id': 'space', 'vk': 32}, {'id': 'z', 'vk': 90}]})
        self.assertEqual([b['id'] for b in loaded['buttons']], ['right', 'space'])
        out = w.behavior_step({'observations': [{'name': 'player', 'valid': True, 'value': [150, 195]}], 'timestamp': 0, 'ageMs': 50})
        self.assertEqual(out['sequence'][0], [0.0, 0, True])                      # right, by its index, at once
        self.assertTrue(any(s[1] == 1 and s[2] for s in out['sequence']))         # space, later, as pressed
        self.assertEqual(out['status']['nodes'], {'c': 'running', 'root': 'running'})
        w.close_trace()

    def test_a_tree_that_isnt_right_says_where(self):
        from worker import Worker
        t = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {}, 'children': ['c']},
                                       'c': {'kind': 'clip', 'params': {}, 'children': []}}}
        out = Worker(self.root).behavior_check({'tree': t, 'fields': []})
        self.assertIn('choose its clip', out['errors']['c'])
        with self.assertRaisesRegex(ValueError, 'choose its clip'):
            Worker(self.root).behavior_load({'tree': t, 'fields': [], 'buttons': []})


    def test_maps_learn_across_runs_and_traces_step_through(self):
        from worker import Worker
        w = Worker(self.root)
        fields = [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}]
        buttons = [{'id': 'right', 'vk': 39}, {'id': 'left', 'vk': 37}, {'id': 'space', 'vk': 32}]
        request = {'tree': tree(('g', 'go', {'map': 'm', 'place': 'b'}, [])), 'fields': fields, 'trees': TREES, 'maps': {'m': MAP},
                   'buttons': buttons, 'treeId': 'main', 'name': 'Up'}
        w.behavior_load(request)

        def step(t, x):
            return w.behavior_step({'observations': [{'name': 'player', 'valid': True, 'value': [x, 195]},
                                                     {'name': 'grounded', 'valid': True, 'value': True}], 'timestamp': t})
        self.assertEqual(step(0, 20)['status']['maps']['m']['link'], 'ab')
        self.assertIsNone(step(2500, 268)['status']['done'])
        self.assertEqual(step(2600, 268)['status']['done'], 'success')
        w.close_trace()
        self.assertEqual(w.map_stats({'map': 'm'})['stats']['ab']['runs'], 1)      # kept, for the next run
        self.assertEqual(Worker(self.root)._map_stats(['m'])['m']['ab']['runs'], 1)
        self.assertEqual(w.map_stats({'map': 'm', 'forget': True})['stats'], {})
        self.assertEqual(w.map_stats({'map': 'm'})['stats'], {})
        runs = w.behavior_traces({'treeId': 'main'})['runs']
        self.assertEqual(len(runs), 1)
        trace = w.behavior_trace({'file': runs[0]['file']})
        self.assertEqual((trace['head']['treeId'], trace['head']['reads']), ('main', ['grounded', 'player']))
        self.assertEqual(trace['frames'][0]['values']['player'], [20, 195])
        self.assertEqual(trace['frames'][0]['trees']['walk']['w'], 'running')
        self.assertEqual(w.behavior_traces({'treeId': 'other'})['runs'], [])
        with self.assertRaises(ValueError):
            w.behavior_trace({'file': '../catalog.sqlite'})

    def test_a_tree_with_inputs_runs_only_from_another(self):
        from worker import Worker
        with self.assertRaisesRegex(ValueError, 'takes inputs'):
            Worker(self.root).behavior_load({'tree': walk_tree(), 'fields': [{'name': 'player', 'type': 'vector'}], 'buttons': []})

    def test_a_map_suggested_from_recordings(self):
        from worker import Worker
        w = Worker(self.root)
        base = {'recordings': ['e', 'w'], 'position': 'player', 'grounded': 'grounded', 'fields': [], 'formulas': []}
        spots = w.map_suggest({**base, 'places': []})['places']
        self.assertTrue(any(abs(s['x'] - 150) < 2 and abs(s['y'] - 195) < 1 for s in spots), spots)   # where you stood
        places = [{'id': 'p', 'x': 150, 'y': 195}, {'id': 'q', 'x': 480, 'y': 145}]
        out = w.map_suggest({**base, 'places': places, 'reach': 30})
        self.assertEqual([(l['from'], l['to'], l['count']) for l in out['links']], [('p', 'q', 1)])
        self.assertEqual(out['links'][0]['clip']['recording'], 'e')
        self.assertFalse(any(abs(s['x'] - 150) < 30 and abs(s['y'] - 195) < 30 for s in out['places']))  # a place already
        frame = w.map_frame({'recording': 'e', 'position': 'player', 'level': ''})
        self.assertAlmostEqual(frame['position'][0], 480, delta=15)
        with self.assertRaisesRegex(ValueError, 'Position'):
            w.map_suggest({**base, 'position': 'player +', 'places': places})


if __name__ == '__main__':
    unittest.main()
