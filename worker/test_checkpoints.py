"""Recovery checkpoints (platformer.checkpoints, partial): where a failed recorded movement could be resumed, as a
movement state (where, how fast, which keys held, what comes next) rather than a place, and the rest of the movement
as a link of its own. Inferred and drawn only: nothing resumes from them yet."""
import unittest

import platformer as P
from movement import learn
from test_behavior import FEET, FLOOR, Game
from test_takeoff import GROUND, MODEL, demonstration, play

RUN_UP = {**MODEL, 'runUp': {'px': 1.0, 'ms': 10.0, 'n': 6}}  # the little platformer walks at once


def learned(samples, keys, model=RUN_UP, ground=GROUND):
    track = [(t, x, y) for t, x, y, _, _ in samples]
    graph = learn([('cp', track, [s[3] for s in samples], [None] * len(track), keys)], 'n')
    link = graph['links'][0]
    grounds = {None: P.Ground(ground)}
    link['takeoffs'] = P.jumps(samples, keys, model, grounds, link['clip']['from'], link['clip']['to'])
    link['checkpoints'] = P.checkpoints(samples, keys, model, grounds, link['clip']['from'], link['clip']['to'], link['takeoffs'])
    return graph, link


def two_jumps():
    """Walking right from 150 and jumping onto the ledge (landing with Right held, running on), then on along it and a
    hop, landing on it again, standing."""
    g = Game(150)
    plan = [(400.0, 'right', True), (1485.0, 'space', True), (1635.0, 'space', False), (2700.0, 'space', True),
            (2850.0, 'space', False), (3300.0, 'right', False)]
    return play(g, plan, 4000, sample=20)


class RunUpTests(unittest.TestCase):
    def test_how_far_a_run_up_from_standing_takes_is_measured(self):
        recordings = []
        for takeoff in (60, 110, 160, 210, 270, 290):
            g = Game(20)
            press = 100 + 5 + (takeoff - 20) / Game.WALK
            samples, keys = play(g, [(100, 'right', True), (press, 'space', True), (press + 150, 'space', False), (press + 900, 'right', False)], press + 1200)
            recordings.append({'samples': samples, 'keys': keys})
        for x in (80, 200):
            samples, keys = play(Game(x), [(100, 'space', True), (250, 'space', False)], 1200)
            recordings.append({'samples': samples, 'keys': keys})
        m = P.fit(recordings)
        self.assertIn('runUp', m)
        self.assertEqual(m['runUp']['n'], 6, 'one per start from standing with a key each way')
        self.assertLessEqual(m['runUp']['px'], 10, 'the little platformer walks at once')


class CheckpointTests(unittest.TestCase):
    def test_a_running_landing_is_a_dynamic_checkpoint_with_what_it_needs(self):
        samples, keys = demonstration()
        graph, link = learned(samples, keys)
        c, = [c for c in link['checkpoints'] if c['position'][1] < 150]  # on the ledge
        self.assertEqual((c['kind'], c['direction'], c['held'], c['line']), ('dynamic', 1, ['right'], 1), c)
        self.assertGreater(c['vx'], 0.3 * MODEL['walk'])
        self.assertLessEqual(c['velocity'][0], c['vx'] <= c['velocity'][1])
        self.assertEqual(c['region'], [c['position'][0] - P.CHECK_REGION_PX, c['position'][0] + P.CHECK_REGION_PX])
        self.assertAlmostEqual(c['roomPx'], c['position'][0] - 300, delta=0.01, msg='the ledge behind it, the way it runs')
        self.assertTrue(c['resumable'], c)

    def test_a_dynamic_one_needs_evidence_it_can_be_run_up_into(self):
        samples, keys = demonstration()
        _, link = learned(samples, keys, model=MODEL)  # no runUp measured
        c = next(c for c in link['checkpoints'] if c['kind'] == 'dynamic')
        self.assertFalse(c['resumable'])
        self.assertIn('don’t show how far a run-up', c['why'])
        _, link = learned(samples, keys, model={**MODEL, 'runUp': {'px': 6.0, 'ms': 60.0, 'n': 6}})  # it landed 3.5 px in
        c = next(c for c in link['checkpoints'] if c['kind'] == 'dynamic')
        self.assertFalse(c['resumable'])
        self.assertIn('of ground behind it', c['why'])

    def test_one_whose_next_jump_is_played_as_recorded_isn_t_resumable(self):
        samples, keys = two_jumps()
        _, link = learned(samples, keys)
        c = next(c for c in link['checkpoints'] if c['position'][1] < 150)
        self.assertIsNotNone(c['next'])
        link2 = dict(link)
        rows = [dict(r) for r in link['takeoffs']]
        rows[c['next']['index']]['status'] = 'timed'
        again = P.checkpoints(samples, keys, RUN_UP, {None: P.Ground(GROUND)}, link['clip']['from'], link['clip']['to'], rows)
        d = next(d for d in again if d['at'] == c['at'])
        self.assertFalse(d['resumable'])
        self.assertIn('played as recorded', d['why'])

    def test_landing_in_place_with_nothing_held_is_stable(self):
        # a jump straight up, walking off 45 ms after landing (before it stands: one movement)
        probe, _ = play(Game(100), [(400.0, 'space', True), (550.0, 'space', False)], 1400, sample=5)
        landed = next(s[0] for s in probe if s[0] > 500 and s[3])
        samples, keys = play(Game(100), [(400.0, 'space', True), (550.0, 'space', False), (landed + 45, 'right', True), (landed + 245, 'right', False)], 2200, sample=20)
        _, link = learned(samples, keys)
        c, = link['checkpoints']
        self.assertEqual((c['kind'], c['direction'], c['held'], c['resumable']), ('stable', 0, [], True), c)


class PartialLinkTests(unittest.TestCase):
    def test_the_rest_of_a_movement_keeps_its_parent_and_is_timed_from_its_checkpoint(self):
        samples, keys = two_jumps()
        _, link = learned(samples, keys)
        c = next(c for c in link['checkpoints'] if c['position'][1] < 150)
        p = P.partial(link, c)
        self.assertEqual((p['id'], p['parent'], p['recording'], p['checkpoint']), (f"{link['id']}@{c['n']}", link['id'], 'cp', c['n']))
        self.assertIsNone(p['from'])
        self.assertEqual((p['to'], p['end']), (link['to'], link['end']))
        self.assertEqual(p['start'], c['position'])
        self.assertAlmostEqual(p['ms'], link['ms'] - c['at'], delta=0.1)
        self.assertAlmostEqual(p['clip']['from'], link['clip']['from'] + c['at'], delta=0.1)
        self.assertGreaterEqual(p['trajectory'][0][0], 0.0)
        self.assertTrue(all(r['at'] > 0 for r in p.get('takeoffs') or []))
        self.assertEqual(len(p.get('takeoffs') or []), len([r for r in link['takeoffs'] if r['at'] > c['at']]), 'only the jumps after it')
        self.assertNotIn('checkpoints', p)
        self.assertEqual(link['id'] in p['id'], True)


if __name__ == '__main__':
    unittest.main()
