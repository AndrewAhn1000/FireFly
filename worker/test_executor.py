import math
import unittest

import planner as P
from executor import Executor

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


def record(takeoff, start=20, end=480):
    """A player walking right from `start`, jumping at `takeoff` while walking, on up the ledge to `end`: samples every
    45 ms [(t, x, y, lines, keys)] and the exact key events [(t, id, down)]."""
    g, t, samples, events = Game(start), 0.0, [], [(0.0, 'right', True)]
    g.keys = {'right'}
    jumped = released = False
    while t < 12000 and not (g.ground and g.x >= end):
        if not jumped and g.x >= takeoff:
            g.keys.add('space'); events.append((t, 'space', True)); jumped = t
        if jumped and not released and t - jumped >= 150:
            g.keys.discard('space'); events.append((t, 'space', False)); released = True
        if round(t) % 45 == 0:
            samples.append((t, g.x, g.y, LINES, tuple(sorted(g.keys))))
        g.tick(); t += 5
    events.append((t, 'right', False))
    samples.append((t, g.x, g.y, LINES, ()))
    return samples, events


def record_standing(stop, start=20, end=480):
    """A player walking right to `stop`, standing a moment, then jumping with space and right pressed together."""
    g, t, samples, events = Game(start), 0.0, [], [(0.0, 'right', True)]
    g.keys = {'right'}
    stood = jumped = None
    while t < 12000 and not (g.ground and g.x >= end and jumped is not None):
        if stood is None and g.x >= stop:
            g.keys = set(); events.append((t, 'right', False)); stood = t
        if stood is not None and jumped is None and t - stood >= 300:
            g.keys = {'space', 'right'}; events += [(t, 'space', True), (t + 1, 'right', True)]; jumped = t
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


def drive(planner, game, destination, latency=70.0, frame=45.0, limit=20000):
    """The executor driving the game: it sees each frame `latency` ms after it was captured, and what it presses
    takes effect then."""
    ex, t, pending, seen = Executor(), 0.0, [], []
    while t < limit:
        if round(t) % round(frame) == 0:
            keys, status = ex.step(t, t + latency, game.x, game.y, planner, destination)
            pending.append((t + latency, set(keys)))
            seen.append(status)
            if status['phase'] == 'arrived':
                return ex, seen
        while pending and pending[0][0] <= t:
            game.keys = pending.pop(0)[1]
        game.tick(); t += 5
    return ex, seen


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        runs = [record(270), record(280), record(275), walk_back()]
        self.moves = P.learn_moves([s for s, _ in runs], 40, 12, 25, events=[e for _, e in runs])
        self.planner = P.level_planner(LINES, self.moves, 40, 12, 25)

    def test_the_hop_keeps_how_it_was_done(self):
        hop = next(h for h in self.moves['hops'] if h['dy'] < -20)
        e = hop['examples'][0]
        self.assertEqual(e['keys'], ['right'])                       # walking into it
        self.assertEqual(e['timeline'][0][1:], ['space', True])     # space pressed at its anchor
        self.assertAlmostEqual(e['timeline'][1][0], 150, delta=6)   # and let go 150 ms on
        self.assertAlmostEqual(e['vx'], 0.1, delta=0.01)
        self.assertGreater(e['end'], 300)

    def test_it_drives_from_the_floor_up_onto_the_ledge(self):
        game = Game(20)
        ex, seen = drive(self.planner, game, (480, 145))
        self.assertEqual(seen[-1]['phase'], 'arrived', seen[-1])
        self.assertEqual((ex.done >= 1, ex.missed), (True, 0))
        self.assertAlmostEqual(game.y, 145, delta=1)
        self.assertIn('jump', {s['phase'] for s in seen})

    def test_from_past_the_takeoff_it_backs_up_for_a_run_up(self):
        game = Game(330)                                              # under the ledge, beyond where the jump starts
        ex, seen = drive(self.planner, game, (480, 145))
        self.assertEqual(seen[-1]['phase'], 'arrived', seen[-1])
        self.assertTrue(any('backing up' in s['text'] for s in seen))

    def test_a_missed_hop_costs_more_and_is_tried_again(self):
        game = Game(20, jump=0.3)                                     # too weak a jump: it lands back on the floor
        ex, seen = drive(self.planner, game, (480, 145), limit=6000)
        self.assertGreaterEqual(ex.missed, 1)
        self.assertTrue(self.planner.penalty)
        self.assertRegex(ex.misses[0]['why'], r'it landed at \(\d+, 195\), \d+ px from where it should, taking off at \(\d+, 195\)')
        game.jump = 0.45                                              # now it can: tried again, it makes it
        ex2, seen = drive(self.planner, game, (480, 145))
        self.assertEqual(seen[-1]['phase'], 'arrived')

    def test_a_hop_taken_standing_is_done_standing(self):
        runs = [record_standing(280), record_standing(285), walk_back()]
        moves = P.learn_moves([r for r, _ in runs], 40, 12, 25, events=[e for _, e in runs])
        e = next(h for h in moves['hops'] if h['dy'] < -20)['examples'][0]
        self.assertEqual((e['keys'], abs(e['vx']) < 0.03), ([], True))   # stood still, nothing held
        planner = P.level_planner(LINES, moves, 40, 12, 25)
        for start in (20, 360):
            game = Game(start)
            ex, seen = drive(planner, game, (480, 145))
            self.assertEqual(seen[-1]['phase'], 'arrived', (start, seen[-1]))
            self.assertTrue(any(s['text'].startswith('stopping') or 'coasting' in s['text'] for s in seen))

    def test_along_a_shape_it_walks_rather_than_jumping(self):
        # a jump along the floor, where walking right was learned too: not planned
        hop_along = {'from': 'platforms', 'to': 'platforms', 'dx': 80, 'dy': 0, 'edge': 200, 'ms': 100, 'keys': ['right', 'space'], 'n': 5}
        planner = P.level_planner(LINES, {**self.moves, 'hops': self.moves['hops'] + [hop_along]}, 40, 12, 25)
        floor = set(planner.map.of_line[0])
        self.assertFalse([ab for ab in planner.hop_of if ab[0] in floor and ab[1] in floor])

    def test_a_hop_starts_on_its_shape_and_falling_off_getting_there_is_a_miss(self):
        # an example whose jump was pressed 30 px past the floor's end: its start is kept on the floor
        hop = next(h for h in self.moves['hops'] if h['dy'] < -20)
        e = {**hop['examples'][0], 'ax': 500.0}
        planner = P.level_planner(LINES, {**self.moves, 'hops': [{**hop, 'examples': [e]}]}, 40, 12, 25)
        (a, b), = [ab for ab in planner.hop_of]
        ex = Executor()
        chosen = ex._choose(planner, a, b, 0)
        self.assertLessEqual(chosen['anchor'][0], 400 - 3)
        # getting into position, it falls off: that hop costs more, and the next frame plans again
        ex.step(0, 70, 20, 195, planner, (480, 145))
        self.assertEqual(ex.hop['phase'], 'position')
        keys, status = ex.step(45, 115, 410, 230, planner, (480, 145))
        self.assertEqual((status['phase'], ex.missed), ('air', 1))
        self.assertIn('fell off at (410, 230)', ex.misses[0]['why'])
        self.assertTrue(planner.penalty)

    def test_it_keeps_to_the_hop_it_is_getting_into_position_for(self):
        planner = P.level_planner(LINES, self.moves, 40, 12, 25)
        ex = Executor()
        ex.step(0, 70, 330, 195, planner, (480, 145))                 # past the takeoff: backs up for a run-up
        first = (ex.hop['a'], ex.hop['b'])
        for k, x in enumerate((320, 305, 290, 275, 262)):
            ex.step(45 * (k + 1), 45 * (k + 1) + 70, x, 195, planner, (480, 145))
            self.assertEqual((ex.hop['a'], ex.hop['b']), first, 'it changed to the same jump from further back')

    def test_falling_past_a_platforms_end_isnt_standing_on_it(self):
        m = P.ShapeMap(LINES, 40, 12)
        self.assertIsNotNone(m.lands(400, 195, False))       # on the floor at its end
        self.assertIsNone(m.lands(410, 195, False))          # 10 px past its end: falling beside it
        self.assertIsNone(m.lands(200, 206, False))          # 6 px below it: under it, not on it

    def test_after_five_misses_of_the_only_way_it_gives_up_and_says_so(self):
        game = Game(20, jump=0.3)                                     # never makes the ledge
        ex, seen = drive(P.level_planner(LINES, self.moves, 40, 12, 25), game, (480, 145), limit=30000)
        self.assertEqual(ex.missed, 5)
        self.assertEqual(seen[-1]['phase'], 'stuck')
        self.assertIn('no other way there: it gave up on the jump', seen[-1]['text'])
        self.assertIn('after 5 tries', seen[-1]['text'])

    def test_without_a_way_it_says_so(self):
        ex = Executor()
        keys, status = ex.step(0, 70, 480, 145, self.planner, (20, 195))   # never went back down
        self.assertEqual((keys, status['phase']), (set(), 'noway'))

    def test_in_the_air_it_waits(self):
        keys, status = Executor().step(0, 70, 200, 100, self.planner, (480, 145))
        self.assertEqual((keys, status['phase']), (set(), 'air'))


def bunny(start=20, end=230, every=700, straight=False):
    """A player hopping along the floor, a jump every `every` ms (straight up, or holding right), for the physics."""
    g, t, samples, events = Game(start), 0.0, [], []
    g.keys = set() if straight else {'right'}
    if not straight:
        events.append((0.0, 'right', True))
    last, up = -every, None
    while t < 8000 and g.x < end:
        if g.ground and t - last >= every:
            g.keys.add('space'); events.append((t, 'space', True)); last, up = t, t + 150
        if up is not None and t >= up:
            g.keys.discard('space'); events.append((t, 'space', False)); up = None
        if round(t) % 45 == 0:
            samples.append((t, g.x, g.y, LINES, tuple(sorted(g.keys))))
        g.tick(); t += 5
    return samples, events


def walk_stop(start=20, stops=(80, 160, 230), pause=400):
    """A player walking right and stopping (letting go of right) at each of `stops`, a moment each, for the slide."""
    g, t, samples, events = Game(start), 0.0, [], [(0.0, 'right', True)]
    g.keys = {'right'}
    todo, resume = list(stops), None
    while t < 8000 and (todo or resume is not None):
        if todo and resume is None and g.x >= todo[0]:
            g.keys = set(); events.append((t, 'right', False)); resume = t + pause; todo.pop(0)
        elif resume is not None and t >= resume:
            resume = None
            if todo:
                g.keys = {'right'}; events.append((t, 'right', True))
        if round(t) % 45 == 0:
            samples.append((t, g.x, g.y, LINES, tuple(sorted(g.keys))))
        g.tick(); t += 5
    return samples, events


class PhysicsTests(unittest.TestCase):
    """The movement measured from recordings, and jumps planned and driven from it alone."""

    def setUp(self):
        runs = [bunny(), bunny(30, every=650), bunny(40, straight=True), walk_back(), walk_stop(), walk_stop(30, (100, 190))]
        self.moves = P.learn_moves([s for s, _ in runs], 40, 12, 25, events=[e for _, e in runs])

    def test_it_measures_how_far_the_player_slides_and_so_how_precisely_it_stops(self):
        ph = self.moves['physics']
        self.assertGreaterEqual(ph['fits']['stops'], 3)
        self.assertLess(ph['slide'], 1.5)                             # this game stops dead
        self.assertAlmostEqual(ph['precision'], ph['walk'] * 45 / 2, delta=1.5)  # half a frame's walk, and the slides' spread

    def test_a_jump_needing_more_precision_than_there_is_has_a_chance_and_costs_its_tries(self):
        planner = P.level_planner(LINES, self.moves, 40, 12, 25, physics={'precision': 30.0})
        up = [planner.hops[h] for (a, b), h in planner.hop_of.items() if planner.hops[h].get('physics') and planner.places[b][2] < 160]
        self.assertTrue(up)
        self.assertTrue(any(h['chance'] < 1 for h in up), [h['chance'] for h in up])
        sure = P.level_planner(LINES, self.moves, 40, 12, 25, physics={'precision': 0.0})
        self.assertTrue(all(h['chance'] == 1 for h in sure.hops if h.get('physics')))

    def test_it_measures_the_games_movement(self):
        ph = self.moves['physics']
        self.assertAlmostEqual(ph['walk'], 0.1, delta=0.005)
        self.assertAlmostEqual(ph['jump'], 0.45, delta=0.03)
        self.assertAlmostEqual(ph['gravity'], 0.0015, delta=0.0001)
        self.assertEqual((ph['jumpKey'], ph['rightKey']), ('space', 'right'))
        self.assertGreaterEqual(ph['fits']['jumps'], 5)

    def test_it_plans_and_drives_the_ledge_by_physics_though_never_recorded_there(self):
        # no recording ever went up onto the ledge: only hops along the floor
        self.assertFalse([h for h in self.moves['hops'] if h['dy'] < -20])
        planner = P.level_planner(LINES, self.moves, 40, 12, 25)
        self.assertTrue(planner.physics)
        up = [(a, b) for (a, b), h in planner.hop_of.items() if planner.hops[h].get('physics') and planner.places[b][2] < 160]
        self.assertTrue(up, 'jumps up onto the ledge, from the physics')
        for start, latency in ((20, 70), (200, 120), (330, 40)):
            game = Game(start)
            ex, seen = drive(planner, game, (480, 145), latency=latency)
            self.assertEqual(seen[-1]['phase'], 'arrived', (start, latency, seen[-1], ex.misses))
            self.assertAlmostEqual(game.y, 145, delta=1)

    def test_what_is_set_goes_in_place_of_what_is_measured_and_false_is_recorded_jumps_only(self):
        weak = P.level_planner(LINES, self.moves, 40, 12, 25, physics={'jump': 0.2})   # too weak to reach the ledge
        self.assertFalse([1 for (a, b), h in weak.hop_of.items() if weak.hops[h].get('physics') and weak.places[b][2] < 160])
        none = P.level_planner(LINES, self.moves, 40, 12, 25, physics=False)
        self.assertIsNone(none.physics)
        self.assertFalse([h for h in none.hops if h.get('physics')])

    def test_a_standing_jump_waits_until_the_player_has_landed(self):
        planner = P.level_planner(LINES, self.moves, 40, 12, 25)
        ex = Executor()
        ex.step(0, 70, 240, 195, planner, (480, 150))                 # on the floor: it picks the way's first jump
        texts = []
        for k, dy in enumerate((-7, -5, -3, -1)):                    # coming down onto the floor at its start, within snap
            ax, ay = ex.hop['anchor']
            keys, status = ex.step(1000 + 45 * k, 1070 + 45 * k, ax, ay + dy, planner, (480, 150))
            texts.append(status['text'])
            self.assertNotEqual(status['phase'], 'jump')
        self.assertTrue(any('landing' in t for t in texts), texts)
        for k in range(4, 12):                                        # down and still: now it goes
            ax, ay = ex.hop['anchor']
            keys, status = ex.step(1000 + 45 * k, 1070 + 45 * k, ax, ay, planner, (480, 150))
            if status['phase'] == 'jump':
                break
        self.assertEqual(status['phase'], 'jump')

    def test_standing_on_a_floor_beside_the_end_of_a_slope_is_standing(self):
        lines = [('platforms', [[0, 274], [400, 274]]), ('platforms', [[206, 267], [261, 200], [284, 200]])]
        m = P.ShapeMap(lines, 40, 20)
        self.assertEqual(m.on(200, 266)[0], 1)                       # the slope's end is nearer than the floor
        self.assertEqual(m.lands(200, 266, False)[0], 0)             # but it's the floor that's stood on

    def test_a_miss_costs_the_same_jump_from_every_place(self):
        planner = P.level_planner(LINES, self.moves, 40, 12, 25)
        lines_of = lambda ab: (planner.map.places[ab[0]][2], planner.map.places[ab[1]][2])  # noqa: E731
        groups = {}
        for ab, h in planner.hop_of.items():
            groups.setdefault((lines_of(ab), tuple(sorted(planner.hops[h]['keys']))), []).append(ab)
        siblings = max(groups.values(), key=len)  # a jump between two shapes, made the same way, from the most places
        self.assertGreater(len(siblings), 1)
        ex = Executor()
        ex._miss(planner, ex._choose(planner, *siblings[0], 0), 'test')
        self.assertTrue(all(planner.penalty.get(ab, 1) > 1 for ab in siblings))

    def test_solid_platforms_block_a_jump_from_below(self):
        roof = LINES + [('platforms', [[250, 175], [295, 175]])]
        open_, solid = P.level_planner(roof, self.moves, 40, 12, 25, solid=False), P.level_planner(roof, self.moves, 40, 12, 25, solid=True)
        def ups(p):  # from the floor up onto the ledge
            return {(round(p.places[a][1]), round(p.places[b][1])) for (a, b), h in p.hop_of.items()
                    if p.hops[h].get('physics') and p.places[b][2] < 160 and p.map.places[a][1] == 200}
        under = {pair for pair in ups(open_) if 250 <= pair[0] <= 295}
        self.assertTrue(under, 'from under the roof up onto the ledge, passing through it')
        self.assertFalse(under & ups(solid))


class ScaleAndSolidTests(unittest.TestCase):
    def test_a_game_drawn_twice_as_big_has_twice_the_px_and_still_arrives(self):
        global FLOOR, LEDGE, FEET, LINES
        saved = FLOOR, LEDGE, FEET, LINES, Game.WALK, Game.GRAVITY, Game.JUMP
        small = P.learn_moves([s for s, _ in [record(270), record(280), record(275)]], 40, 12, 25)
        try:
            FLOOR, LEDGE, FEET = ((0, 400), (800, 400)), ((600, 300), (1000, 300)), 10
            LINES = [('platforms', [list(p) for p in FLOOR]), ('platforms', [list(p) for p in LEDGE])]
            Game.WALK, Game.GRAVITY, Game.JUMP = 0.2, 0.003, 0.9       # twice as fast, jumps twice as high and far
            runs = [record(540, start=40, end=960), record(560, start=40, end=960), record(550, start=40, end=960), walk_back(780, 40)]
            moves = P.learn_moves([s for s, _ in runs], 40, 24, 50, events=[e for _, e in runs])
            self.assertAlmostEqual(moves['scale']['jump'] / small['scale']['jump'], 2, delta=0.15)
            scale = P.Scale(moves)
            self.assertAlmostEqual(scale.px(P.UP_SLACK), 2 * P.Scale(small).px(P.UP_SLACK), delta=1.5)
            planner = P.level_planner(LINES, moves, 40, 24, 50)
            game = Game(40)
            ex, seen = drive(planner, game, (960, 290))
            self.assertEqual(seen[-1]['phase'], 'arrived', seen[-1])
            self.assertEqual(ex.missed, 0)
        finally:
            FLOOR, LEDGE, FEET, LINES, Game.WALK, Game.GRAVITY, Game.JUMP = saved

    def test_snap_and_tolerance_left_to_it_are_worked_out_at_the_games_scale(self):
        from worker import Worker
        big = [(a, [[2 * px, 2 * py] for px, py in pts]) for a, pts in LINES]   # one level's shapes, as recordings share them
        series = [[(t, 2 * x, 2 * y, big, keys) for t, x, y, _, keys in s] for s, _ in [record(270), record(280), record(275)]]
        w = Worker.__new__(Worker)
        w._plan_events = [[]] * len(series)
        plan = {'cell': 40.0, 'snap': float(P.SNAP), 'tolerance': float(P.TOLERANCE), 'auto': ['snap', 'tolerance']}
        moves = w._learn_moves(plan, series)
        self.assertAlmostEqual(plan['snap'], 2 * P.SNAP * 50 / P.REF_JUMP, delta=4)   # jumps here rise about 50 px, doubled
        self.assertEqual(moves['settings'], {'snap': plan['snap'], 'tolerance': plan['tolerance']})
        given = {'cell': 40.0, 'snap': 20.0, 'tolerance': 25.0}
        w._learn_moves(given, series)
        self.assertEqual((given['snap'], given['tolerance']), (20.0, 25.0))  # set by hand: kept

    def test_with_solid_platforms_a_jump_through_one_isnt_planned(self):
        runs = [record(270), record(280), record(275), walk_back()]
        moves = P.learn_moves([s for s, _ in runs], 40, 12, 25, events=[e for _, e in runs])
        hop = next(h for h in moves['hops'] if h['dy'] < -20)
        self.assertLess(hop['rise'], -5)                               # its arc went above the ledge it landed on
        roof = LINES + [('platforms', [[250, 175], [295, 175]])]       # a platform over the floor, below the jump's arc
        open_, solid = P.level_planner(roof, moves, 40, 12, 25), P.level_planner(roof, moves, 40, 12, 25, solid=True)
        up = lambda p: {(round(p.places[a][1]), round(p.places[b][1])) for a, b in p.hop_of if p.places[b][2] < 160}  # noqa: E731
        self.assertTrue(up(open_) - up(solid), 'the jumps through the roof are left out')
        self.assertTrue(all(_clear_of_roof(solid, a, b) for a, b in solid.hop_of if solid.places[b][2] < 160))


def _clear_of_roof(p, a, b):
    return P._clear(p.map, a, b, p.hops[p.hop_of[(a, b)]]['rise'])


class DriveTests(unittest.TestCase):
    """drive.load and drive.step: the worker learning from recordings with their key events, and driving the game."""
    def setUp(self):
        import json, sqlite3, tempfile
        from contextlib import closing
        from pathlib import Path
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        schema = {'identity': 'obs', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'platforms', 'type': 'shapes'}]}
        actions = {'identity': 'act', 'buttons': [{'id': 'right', 'vk': 39}, {'id': 'left', 'vk': 37}, {'id': 'space', 'vk': 32}, {'id': 'z', 'vk': 90}]}
        shapes = [{'points': pts} for _, pts in LINES]
        with closing(sqlite3.connect(self.root / 'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            db.execute('CREATE TABLE inputs(recording TEXT,seq INTEGER,data TEXT)')
            for rid, (samples, events) in zip('abcd', [record(270), record(280), record(275), walk_back()]):
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps({'observationSchema': schema, 'actionSchema': actions})))
                for i, (t, x, y, _, keys) in enumerate(samples):
                    sample = {'valid': True, 'timestamp': 1000 + t, 'observationSchema': 'obs', 'actionSchema': 'act',
                              'observations': [{'name': 'player', 'valid': True, 'value': [x, y]}, {'name': 'platforms', 'valid': True, 'value': shapes}],
                              'actions': {'valid': True, 'buttons': {b['id']: b['id'] in keys for b in actions['buttons']}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps(sample)))
                for i, (t, key, down) in enumerate(events):
                    db.execute('INSERT INTO inputs VALUES(?,?,?)', (rid, i, json.dumps({'kind': 'button', 'id': key, 'down': down, 'injected': False, 'timestamp': 1000 + t})))
                db.execute('INSERT INTO inputs VALUES(?,?,?)', (rid, len(events), json.dumps({'kind': 'button', 'id': 'z', 'down': True, 'injected': True, 'timestamp': 1001})))
        self.request = {'goal': {'name': 'goal', 'position': 'player', 'lookAhead': [0.5, 1.5], 'targets': 2, 'minMove': 20,
                                 'plan': {'places': 'shapes', 'inputs': [{'alias': 'platforms', 'shapes': ['platforms']}], 'snap': 12, 'tolerance': 25,
                                          'cell': 40, 'aheadS': 1, 'destination': {'kind': 'point', 'x': 480, 'y': 145}, 'recordings': list('abcd')}},
                        'recordingIds': list('abcd'), 'fields': [], 'formulas': []}
        self.shapes = shapes

    def tearDown(self):
        self.temp.cleanup()

    def test_it_learns_with_the_key_events_and_drives_the_game(self):
        from worker import Worker
        w = Worker(self.root)
        loaded = w.drive_load(self.request)
        self.assertEqual([b['id'] for b in loaded['buttons']], ['right', 'left', 'space'])  # not z, which a program sent
        self.assertGreaterEqual(loaded['examples'], 1)
        game, t, pending, status = Game(20), 0.0, [], None
        while t < 20000:
            if round(t) % 45 == 0:
                obs = [{'name': 'player', 'valid': True, 'value': [game.x, game.y]}, {'name': 'platforms', 'valid': True, 'value': self.shapes}]
                out = w.drive_step({'observations': obs, 'timestamp': t, 'ageMs': 70})
                status = out['status']
                pending.append((t + 70, {b['id'] for b, on in zip(loaded['buttons'], out['buttons']) if on}))
                if status['phase'] == 'arrived':
                    break
            while pending and pending[0][0] <= t:
                game.keys = pending.pop(0)[1]
            game.tick(); t += 5
        self.assertEqual(status['phase'], 'arrived', status)
        self.assertEqual(status['missed'], 0)

    def test_what_it_does_each_frame_is_kept(self):
        import json
        from worker import Worker
        w = Worker(self.root)
        path = w.drive_load(self.request)['trace']
        obs = [{'name': 'player', 'valid': True, 'value': [20, 195]}, {'name': 'platforms', 'valid': True, 'value': self.shapes}]
        w.drive_step({'observations': obs, 'timestamp': 0, 'ageMs': 70})
        w.close_trace()
        lines = [json.loads(line) for line in open(path, encoding='utf8')]
        self.assertTrue(lines[0]['drive'])
        self.assertEqual((lines[1]['x'], lines[1]['phase'], lines[1]['keys']), (20, 'position', ['right']))
        self.assertTrue(lines[1]['next'] and lines[1]['here'])

    def test_without_the_player_it_lets_go_and_says_why(self):
        from worker import Worker
        w = Worker(self.root)
        w.drive_load(self.request)
        out = w.drive_step({'observations': [{'name': 'player', 'valid': False, 'value': None}], 'timestamp': 0, 'ageMs': 50})
        self.assertEqual((out['buttons'], out['status']['phase']), ([False, False, False], 'missing'))

    def test_it_needs_places_along_shapes_and_a_destination(self):
        from worker import Worker
        w = Worker(self.root)
        grid = {**self.request, 'goal': {**self.request['goal'], 'plan': {**self.request['goal']['plan'], 'places': 'grid'}}}
        with self.assertRaisesRegex(ValueError, 'Along shapes'):
            w.drive_load(grid)
        none = {**self.request, 'goal': {**self.request['goal'], 'plan': {**self.request['goal']['plan'], 'destination': None}}}
        with self.assertRaisesRegex(ValueError, 'where to go'):
            w.drive_load(none)


if __name__ == '__main__':
    unittest.main()
