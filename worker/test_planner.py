import unittest

from planner import Planner, ShapeMap, learn, learn_moves, level_graph, level_planner


def walk(x0, x1, y, t0=0.0, speed=0.2, keys=('right',), level=None, step_ms=50):
    """Samples walking from x0 to x1 along y at speed px/ms."""
    out, t, x = [], t0, x0
    sign = 1 if x1 >= x0 else -1
    while (x - x1) * sign <= 0:
        out.append((t, x, y, level, keys))
        x += sign * speed * step_ms
        t += step_ms
    return out


class LearnTests(unittest.TestCase):
    def test_places_are_where_the_player_was_and_moves_what_they_did(self):
        g = learn([walk(0, 200, 100)], cell=40)
        self.assertEqual(len(g['places']), 6)                      # x 0..200 over cells of 40
        self.assertEqual(g['places'][0][1:3], [15.0, 100.0])        # where the player was in it, not its middle
        self.assertTrue(all(m[4] == ['right'] for m in g['moves']))
        self.assertEqual({(m[0], m[1]) for m in g['moves']}, {(i, i + 1) for i in range(5)})
        self.assertAlmostEqual(g['moves'][0][2], 200, delta=1)      # 40 px at 0.2 px/ms

    def test_a_gap_in_a_recording_is_no_move(self):
        a, b = walk(0, 40, 0), walk(400, 440, 0, t0=10_000)
        g = learn([a + b], cell=40)
        far = [i for i, p in enumerate(g['places']) if p[1] >= 400]
        self.assertFalse(any(m[1] in far and m[0] not in far for m in g['moves']))

    def test_levels_are_kept_apart(self):
        g = learn([walk(0, 80, 0, level='1'), walk(0, 80, 0, level='2', t0=5000)], cell=40)
        self.assertEqual(sorted({p[0] for p in g['places']}), ['1', '2'])


class PlanTests(unittest.TestCase):
    def level(self):
        # A floor from x 0 to 600 at y 200; a ledge at y 100 from x 300 to 500, reached by one recorded jump from
        # x 250 on the floor; and walking back left along the floor
        floor = walk(0, 600, 200)
        jump = [(4000 + 50 * k, 250 + 10 * k, 200 - 25 * k, None, ('right', 'space')) for k in range(5)]
        ledge = walk(300, 500, 100, t0=4300)
        back = walk(600, 0, 200, t0=9000, keys=('left',))
        return Planner(learn([floor, jump + ledge, back], cell=40))

    def test_it_plans_the_recorded_jump_to_the_ledge_and_aims_a_little_way_along(self):
        p = self.level()
        target, way = p.target(None, (20, 200), (480, 100), ahead_ms=600)
        self.assertIsNotNone(target)
        self.assertEqual(target[1], 200)                              # 0.6 s on: still on the floor
        whole = p.path(p.place_at(None, 20, 200), p.place_at(None, 480, 100))
        ys = [p.places[i][2] for i in whole]
        self.assertEqual(ys[0], 200); self.assertEqual(ys[-1], 100)
        self.assertLess(min(p.places[i][1] for i in whole if p.places[i][2] < 200), 300)  # up by the jump at x 250

    def test_from_the_far_end_it_walks_back_to_the_jump(self):
        p = self.level()
        target, _ = p.target(None, (580, 200), (480, 100), ahead_ms=600)
        self.assertLess(target[0], 580)                               # left along the floor, the way back recorded

    def test_off_every_place_it_starts_on_its_own_level_not_overhead(self):
        p = self.level()
        start = p.place_at(None, 420, 230)                            # just under the floor, below the ledge
        self.assertEqual(p.places[start][2], 200)

    def test_nowhere_the_moves_lead_is_no_target(self):
        p = Planner(learn([walk(0, 200, 0)], cell=40))
        self.assertEqual(p.target(None, (190, 0), (10, 0), 500), (None, None))  # walked right only: no way back

    def test_the_picture_has_the_way_the_next_move_and_how_long(self):
        p = self.level()
        pic = p.picture(None, (20, 200), (480, 100), 600)
        self.assertGreater(len(pic['places']), 10)
        self.assertEqual(pic['path'][0][1], 200)
        self.assertEqual(pic['next']['keys'], ['right'])
        self.assertGreater(pic['seconds'], 1)

    def test_the_hint_is_the_next_moves_keys_and_how_far_until_each(self):
        p = self.level()
        way = p.path(p.place_at(None, 20, 200), p.place_at(None, 480, 100))
        nxt, soon = p.hint(way, ['right', 'space', 'left'])[:3], p.hint(way, ['right', 'space', 'left'])[3:]
        self.assertEqual(nxt, [1.0, 0.0, 0.0])                       # walking right first
        self.assertEqual(soon[0], 0)
        self.assertGreater(soon[1], 150); self.assertLess(soon[1], 300)  # the jump at x 250
        self.assertEqual(soon[2], 400)                                # never left: as far as it looks
        self.assertEqual(p.hint(None, ['right']), [0.0, 400])

    def two_jumps(self):
        # The ledge reached by a jump at x 250 and another at x 450 (landing back on it going left)
        floor = walk(0, 600, 200)
        jump = [(4000 + 50 * k, 250 + 10 * k, 200 - 25 * k, None, ('right', 'space')) for k in range(5)]
        ledge = walk(300, 500, 100, t0=4300)
        jump2 = [(12000 + 50 * k, 450 + 5 * k, 200 - 25 * k, None, ('space',)) for k in range(5)]
        ledge2 = walk(480, 300, 100, t0=12300, keys=('left',))
        return Planner(learn([floor, jump + ledge, jump2 + ledge2], cell=40))

    def test_a_move_that_fails_costs_more_and_the_way_round_it_is_planned(self):
        p = self.two_jumps()
        start, goal = p.place_at(None, 20, 200), p.place_at(None, 380, 100)
        way = p.path(start, goal)
        first = next(i for i in range(len(way) - 1) if p.places[way[i + 1]][2] < 200)  # where it leaves the floor
        before = p.times_to(goal)[start]
        for _ in range(3):
            p.penalize(way[first], way[first + 1])
        self.assertGreater(p.times_to(goal)[start], before)
        again = p.path(start, goal)
        leaves = next(p.places[again[i]][1] for i in range(len(again) - 1) if p.places[again[i + 1]][2] < 200)
        self.assertGreater(leaves, p.places[way[first]][1] + 100)     # up by the other jump instead

    def test_keeping_away_takes_the_other_way(self):
        p = self.two_jumps()
        start, goal = p.place_at(None, 20, 200), p.place_at(None, 380, 100)
        near = lambda i: 10000 if abs(p.places[i][1] - 270) < 50 and p.places[i][2] < 200 else 0  # something by the first jump
        way = p.path(start, goal, away=near)
        leaves = next(p.places[way[i]][1] for i in range(len(way) - 1) if p.places[way[i + 1]][2] < 200)
        self.assertGreater(leaves, 400)


class ShapeTests(unittest.TestCase):
    """Places along shapes, and moves reused wherever shapes are arranged alike."""
    @staticmethod
    def level(dx=0, dy=0, rise=80):
        # A floor, and a ledge `rise` px up overlapping its right end
        return [('platforms', [(0 + dx, 200 + dy), (400 + dx, 200 + dy)]), ('platforms', [(300 + dx, 200 - rise + dy), (500 + dx, 200 - rise + dy)])]

    def recorded(self):
        lines = self.level()
        on_floor = [(t, x, y - 5, lines, k) for t, x, y, _, k in walk(0, 250, 200)]
        t0 = on_floor[-1][0]
        # Up onto the ledge: 4 samples in the air, landing 80 px on and 80 up
        jump = [(t0 + 50 * k, 250 + 20 * k, 195 - 20 * k - (30 if 0 < k < 4 else 0), lines, ('right', 'space')) for k in range(1, 5)]
        ledge = [(t, x, y - 5, lines, k) for t, x, y, _, k in walk(330, 480, 120, t0=t0 + 250)]
        back = [(t, x, y - 5, lines, k) for t, x, y, _, k in walk(250, 0, 200, t0=t0 + 5000, keys=('left',))]
        return learn_moves([on_floor + jump + ledge, back], cell=40, snap=12)

    def test_it_learns_walking_each_way_and_the_hop(self):
        moves = self.recorded()
        self.assertEqual(moves['along']['platforms']['+']['keys'], ['right'])
        self.assertEqual(moves['along']['platforms']['-']['keys'], ['left'])
        self.assertAlmostEqual(moves['along']['platforms']['+']['speed'], 0.2, places=2)
        (hop,) = moves['hops']
        self.assertEqual((hop['from'], hop['to'], hop['keys']), ('platforms', 'platforms', ['right', 'space']))
        self.assertAlmostEqual(hop['dy'], -75, delta=8); self.assertGreater(hop['dx'], 30)  # it lands once within snap of the ledge

    def plan(self, lines, moves, start, end):
        p = Planner(level_graph(ShapeMap(lines, 40, 12), moves))
        return p.path(p.place_at(None, *start), p.place_at(None, *end))

    def test_the_hop_is_used_on_a_level_never_recorded_with_shapes_alike(self):
        moves = self.recorded()
        way = self.plan(self.level(dx=1000, dy=100), moves, (1020, 295), (1480, 215))
        self.assertIsNotNone(way)

    def test_not_where_the_ledge_is_higher_than_any_hop_made(self):
        moves = self.recorded()
        self.assertIsNone(self.plan(self.level(rise=200), moves, (20, 195), (480, -5)))

    def test_a_flight_with_a_rest_on_something_unseen_is_no_hop(self):
        lines = [('platforms', [[0, 200], [100, 200]]), ('platforms', [[300, 100], [400, 100]])]
        def flight(rest):
            pts = [(0, 50, 195), (50, 60, 195), (100, 90, 160), (150, 120, 150)]
            pts += [(200, 120, 150), (300, 120, 150)] if rest else [(200, 160, 140)]   # still for 150 ms, off every shape
            pts += [(350, 200, 120), (400, 260, 100), (450, 310, 95), (500, 320, 95)]
            return [(t, x, y, lines, ('right', 'space')) for t, x, y in pts]
        self.assertEqual(len(learn_moves([flight(False)], 40, 12, 25)['hops']), 1)
        self.assertEqual(learn_moves([flight(True)], 40, 12, 25)['hops'], [])  # two jumps, with a rest between

    def test_getting_off_a_rope_onto_a_platform_between_its_places(self):
        # a rope up to a platform whose places (every 40 px from x 66) are 20 px either side of it
        lines = [('ropes', [[86, 300], [86, 100]]), ('platforms', [[66, 95], [306, 95]])]
        climb = [(25 * k, 86, 300 - 10 * k, lines, ('up',)) for k in range(21)]           # up the rope to its top
        off = [(525 + 25 * k, 86 + 4 * k, 90, lines, ('right',)) for k in range(1, 20)]   # straight onto the platform
        moves = learn_moves([climb + off, climb + off], 40, 12, 25)
        hop = next(h for h in moves['hops'] if h['from'] == 'ropes')
        self.assertLessEqual(hop['far'], 8)
        p = level_planner(lines, moves, 40, 12, 25)
        top = min(p.map.of_line[0], key=lambda i: p.map.places[i][1])  # the rope's top place
        self.assertTrue(any(a == top for a, _ in p.hop_of), 'the way off the rope, though no place is within its 8 px')

    def test_a_flight_that_goes_up_again_while_falling_is_no_hop(self):
        lines = [('platforms', [[0, 200], [100, 200]]), ('platforms', [[120, 60], [220, 60]])]
        def flight(snap_up):
            if snap_up:  # up, falling again below the ledge, then 80 px higher in 50 ms with nothing pressed
                pts = [(0, 50, 195), (50, 60, 195), (100, 80, 140), (150, 100, 125), (200, 110, 135), (250, 130, 55)]
            else:        # up past the ledge, and down onto it
                pts = [(0, 50, 195), (50, 60, 195), (100, 80, 140), (150, 100, 90), (200, 115, 45), (250, 130, 40), (300, 135, 55)]
            pts += [(400, 150, 55), (450, 160, 55)]
            return [(t, x, y, lines, ()) for t, x, y in pts]
        self.assertEqual(learn_moves([flight(True)], 40, 12, 25)['hops'], [])
        self.assertEqual(len(learn_moves([flight(False)], 40, 12, 25)['hops']), 1)   # a jump onto the ledge

    def test_on_a_shape_is_within_snap(self):
        m = ShapeMap(self.level(), 40, 12)
        self.assertEqual(m.on(100, 192)[0], 0)
        self.assertIsNone(m.on(100, 150))
        self.assertEqual(m.edge(0, 100), 100); self.assertEqual(m.edge(0, 390), 10)


if __name__ == '__main__':
    unittest.main()
