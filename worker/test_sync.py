"""Recorded movements waiting for a State (the map's replay `sync`, such as On Ground): learning where a movement waits
(movement.sync_points), playing it in parts that wait (Behavior._play_synced), and why: on the little platformer, a jump
pressed just after a landing is lost when the replay lands a little later than the recording, unless it waits."""
import unittest

from behavior import Behavior
from keys import Keys, clip
from movement import learn, sync_points
from test_behavior import Game, run

LATE_JUMP = 0.47  # a jump a little stronger than the recording's: it lands about 27 ms later


class Counting(Game):
    """The platformer counting its jumps (leaving the ground going up)."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.jumps = 0

    def tick(self, dt=5.0):
        was = self.ground
        super().tick(dt)
        if was and not self.ground and self.vy < 0:
            self.jumps += 1


def demonstration(delay=15, sample=45):
    """A player standing, then jumping right twice: the second jump pressed `delay` ms after the first landing, as a
    player chaining jumps does, then standing again. (id, track, grounded, levels, keys, sync) as Worker._track gives
    it, the sync State being on the ground."""
    g = Counting(100)
    t, events, track, ground = 0.0, [], [], []
    plan = [(300, 'right', True), (300, 'space', True), (400, 'space', False)]
    landed = 0
    while t < 4000:
        for e in [e for e in plan if e[0] <= t]:
            plan.remove(e)
            events.append(e)
            g.keys = (g.keys | {e[1]}) if e[2] else (g.keys - {e[1]})
        was = g.ground
        g.tick()
        t += 5
        if not was and g.ground:
            landed += 1
            if landed == 1:
                plan += [(t + delay, 'space', True), (t + delay + 100, 'space', False)]
            elif landed == 2:
                plan.append((t + 10, 'right', False))
        if round(t) % sample == 0:
            track.append((t, g.x, g.y))
            ground.append(g.ground)
    keys = Keys(events)
    keys.recorded = True
    return ('demo', track, ground, [None] * len(track), keys, list(ground)), g.jumps


def behavior(graph, keys, replay):
    places = [{'id': f'g{i}', 'x': x, 'y': y, 'level': lv, 'reach': 6, 'recorded': True} for i, (lv, x, y, _) in enumerate(graph['places'])]
    tree = {'root': 'root', 'nodes': {'root': {'kind': 'root', 'params': {'loop': False}, 'children': ['go']},
                                      'go': {'kind': 'go', 'params': {'map': 'm', 'place': 'g1'}, 'children': []}}}
    clips = {f'link:{l["id"]}': clip(keys, l['clip']['from'], l['clip']['to']) for l in graph['links']}
    return Behavior(tree, [{'name': 'player', 'type': 'vector'}, {'name': 'grounded', 'type': 'boolean'}], clips=clips,
                    maps={'m': {'position': 'player', 'giveUp': 1, 'arriveMs': 600, 'linkMs': 100, 'places': places,
                                'links': graph['links'], 'grid': {'replay': replay}}})


class SyncTests(unittest.TestCase):
    def test_a_press_just_after_a_landing_waits_for_it(self):
        demo, jumps = demonstration()
        self.assertEqual(jumps, 2)
        graph = learn([demo], 'n', 150)
        link, = graph['links']
        sync, = link['syncs']
        lo, hi = sync['transition']
        self.assertTrue(lo < sync['at'] <= hi, sync)                 # at the first sample on the ground (or the press, if sooner)
        self.assertEqual(learn([demo], 'n', 0)['links'][0].get('syncs'), None, 'waits learned with Wait for off')
        # a press more than the window after the landing isn't one that waited for it
        late, _ = demonstration(delay=400)
        self.assertEqual(learn([late], 'n', 150)['links'][0].get('syncs'), None)
        # a recording without the State: its movements timed by the clock, and said so
        without = learn([demo[:5]], 'n', 150)
        self.assertEqual(without['links'][0].get('syncs'), None)
        self.assertIn('timed by the clock', without['notes'][0])
        # sync_points on its own: the press in the same sample gap as the turning true counts, at the press
        self.assertEqual(sync_points([(0, 0, 0), (40, 0, 0)], [False, True], Keys([(30, 'space', True)]), 0, 100, 150),
                         [{'at': 30, 'transition': [0, 40], 'expected': {'position': [0, 0], 'level': None}}])

    def test_parts_keep_the_held_keys_and_start_from_the_moment_it_turned_true(self):
        demo, _ = demonstration()
        graph = learn([demo], 'n', 150)
        b = behavior(graph, demo[4], {'sync': 'grounded', 'arrivePx': 30})
        x0, y0 = graph['places'][0][1:3]
        values = lambda x, y, ground: {'player': {'valid': True, 'value': [x, y]}, 'grounded': {'valid': True, 'value': ground}}  # noqa: E731
        ex = lambda aid, state: {'id': aid, 'state': state, 'startedAt': 100.0, 'elapsedMs': 0}  # noqa: E731
        b.tick(0, values(x0, y0, True), execution=ex(0, 'idle'))
        out = b.tick(100, values(x0, y0, True), execution=ex(0, 'idle'))
        first = out['action']
        self.assertEqual(first['keep'], ['right'], 'the arrow held through the landing is kept held')
        self.assertFalse(any(k == 'space' and d and at > 0 for at, k, d in out['sequence']), 'the second jump was timed by the clock')
        part = [e for e in out['events'] if e['kind'] == 'segment']
        self.assertEqual((part[0]['index'], part[0]['actionId']), (0, first['id']))
        b.tick(300, values(x0 + 20, y0 - 40, False), execution=ex(first['id'], 'running'))    # in the air
        out = b.tick(700, values(x0 + 60, y0 - 5, False), execution=ex(first['id'], 'completed'))
        self.assertIn('right', out['keys'], 'the kept key let go during the wait')
        self.assertIsNone(out['action'])
        out = b.tick(760, values(x0 + 64, y0, True), execution=ex(first['id'], 'completed'), observation_time=740)   # landed
        second = out['action']
        self.assertEqual(second['id'], first['id'] + 1)
        press = next(at for at, k, d in out['sequence'] if k == 'space' and d)
        delay = graph['links'][0]['syncs'][0]
        self.assertLessEqual(press, 15, 'the jump came later after the landing than in the recording')
        self.assertTrue(any(at == 0 and k == 'right' and d for at, k, d in out['sequence']), 'the held arrow is pressed again')
        said = {e['kind']: e for e in out['events']}
        self.assertTrue(said['sync']['worked'])
        self.assertEqual(said['segment']['anchor'], [740.0, delay['at']])
        self.assertEqual(said['segment']['actionId'], second['id'])

    def test_a_wait_that_never_comes_fails_the_link(self):
        demo, _ = demonstration()
        graph = learn([demo], 'n', 150)
        b = behavior(graph, demo[4], {'sync': 'grounded'})
        x0, y0 = graph['places'][0][1:3]
        v = {'player': {'valid': True, 'value': [x0, y0]}, 'grounded': {'valid': True, 'value': True}}
        ex = lambda aid, state: {'id': aid, 'state': state, 'startedAt': 100.0}  # noqa: E731
        b.tick(0, v, execution=ex(0, 'idle'))
        aid = b.tick(100, v, execution=ex(0, 'idle'))['action']['id']
        out, events = None, []
        for t in range(150, 3000, 50):  # the jump never left the ground: on it all along
            out = b.tick(t, v, execution=ex(aid, 'completed'))
            events += out['events']
            if out['done']:
                break
        ended = [e for e in events if e['kind'] == 'link-end']
        self.assertEqual([e['worked'] for e in events if e['kind'] == 'sync'], [False])
        self.assertEqual(out['done'], 'failure')
        self.assertEqual(ended[-1]['cause'], 'sync')
        self.assertIn('to turn false and then true', ended[-1]['why'])

    def test_a_late_landing_loses_a_clock_timed_jump_but_not_one_that_waits(self):
        demo, _ = demonstration()
        graph = learn([demo], 'n', 150)
        start = graph['places'][0][1]
        timed = Counting(start, jump=LATE_JUMP)
        run(behavior(learn([demo], 'n', 0), demo[4], {'arrivePx': 40}), timed, latency=70)
        waited = Counting(start, jump=LATE_JUMP)
        run(behavior(graph, demo[4], {'sync': 'grounded', 'arrivePx': 40}), waited, latency=70)
        self.assertEqual(timed.jumps, 1, 'the clock-timed second jump reached the game in the air and was ignored')
        self.assertEqual(waited.jumps, 2, 'the second jump, waiting for the landing, was lost')
        # as recorded, both jump twice
        same = Counting(start)
        run(behavior(learn([demo], 'n', 0), demo[4], {'arrivePx': 40}), same, latency=70)
        self.assertEqual(same.jumps, 2)


if __name__ == '__main__':
    unittest.main()


def three_jumps(sample=45):
    """Jumping right three times: the second pressed 500 ms after the first landing (too long after it to wait for it),
    the third 15 ms after the second landing. One part holds the first landing and the second jump; its wait is for the
    second landing, not the first."""
    g = Counting(10)
    t, events, track, ground = 0.0, [], [], []
    plan = [(300, 'right', True), (500, 'space', True), (600, 'space', False)]
    landed, presses = 0, {}
    while t < 4500:
        for e in [e for e in plan if e[0] <= t]:
            plan.remove(e)
            events.append(e)
            if e[1] == 'space' and e[2]:
                presses[len(presses)] = e[0]
            g.keys = (g.keys | {e[1]}) if e[2] else (g.keys - {e[1]})
        was = g.ground
        g.tick()
        t += 5
        if not was and g.ground:
            landed += 1
            if landed == 1:
                plan += [(t + 500, 'space', True), (t + 600, 'space', False)]
            elif landed == 2:
                plan += [(t + 15, 'space', True), (t + 115, 'space', False)]
            elif landed == 3:
                plan.append((t + 10, 'right', False))
        if round(t) % sample == 0:
            track.append((t, g.x, g.y))
            ground.append(g.ground)
    keys = Keys(events)
    keys.recorded = True
    return ('three', track, ground, [None] * len(track), keys, list(ground)), g.jumps, presses


class OwnLandingTests(unittest.TestCase):
    def test_a_wait_is_for_its_own_landing_not_an_earlier_one_in_the_same_part(self):
        demo, jumps, presses = three_jumps()
        self.assertEqual(jumps, 3)
        graph = learn([demo], 'n', 150)
        link, = graph['links']
        sync, = link['syncs']
        self.assertEqual((sync['afterKey'], sync['after']), ('space', round(presses[1] - link['clip']['from'], 1)),
                         'the wait belongs to the second jump, whose landing it is')
        start = graph['places'][0][1]
        own = Counting(start)
        run(behavior(graph, demo[4], {'sync': 'grounded', 'arrivePx': 40}), own, latency=70)
        self.assertEqual(own.jumps, 3, 'the third jump went before the second landing')
        # Destination matching also rejects the first landing, even if legacy causal metadata is absent.
        for s in link['syncs']:
            s.pop('after'), s.pop('afterKey')
        early = Counting(start)
        run(behavior(graph, demo[4], {'sync': 'grounded', 'arrivePx': 40}), early, latency=70)
        self.assertEqual(early.jumps, 3)
