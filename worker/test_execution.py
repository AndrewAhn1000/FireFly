import unittest

from behavior import Behavior
from test_behavior import FIELDS, obs, tree


class ExecutionTests(unittest.TestCase):
    def test_elapsed_time_cannot_complete_or_restart_an_unacknowledged_action(self):
        b = Behavior(tree(('p', 'press', {'keys': ['space'], 'ms': 16}, [])), FIELDS)
        out = b.tick(1000, obs(), execution={'id': 0, 'state': 'idle'})
        self.assertEqual(out['action'], {'id': 1, 'durationMs': 16})
        out = b.tick(1500, obs(), execution={'id': 0, 'state': 'idle'})
        self.assertIsNone(out['done'])
        self.assertIsNone(out['sequence'])
        out = b.tick(1600, obs(), execution={'id': 1, 'state': 'running'})
        self.assertIsNone(out['done'])
        out = b.tick(1601, obs(), execution={'id': 1, 'state': 'completed'})
        self.assertEqual(out['done'], 'success')

    def test_cancelled_clip_is_failure_not_elapsed_success(self):
        b = Behavior(tree(('c', 'clip', {}, [])), FIELDS,
                     clips={'c': {'keys': ['right'], 'timeline': [[40, 'right', False]], 'end': 40}})
        b.tick(0, obs(), execution={'id': 0, 'state': 'idle'})
        out = b.tick(1000, obs(), execution={'id': 1, 'state': 'cancelled'})
        self.assertEqual(out['done'], 'failure')

    def test_condition_cancels_even_after_the_original_expected_end(self):
        b = Behavior(tree(('w', 'while', {'formula': 'grounded'}, ['p']),
                          ('p', 'press', {'keys': ['space'], 'ms': 16}, [])), FIELDS)
        b.tick(0, obs(), execution={'id': 0, 'state': 'idle'})
        out = b.tick(1000, obs(grounded=False), execution={'id': 1, 'state': 'running'})
        self.assertEqual(out['sequence'], [])
        self.assertEqual(out['done'], 'failure')

    def test_consecutive_actions_get_distinct_ids_and_old_ack_cannot_finish_next(self):
        b = Behavior(tree(('s', 'sequence', {}, ['a', 'b']),
                          ('a', 'press', {'keys': ['down'], 'ms': 16}, []),
                          ('b', 'press', {'keys': ['space'], 'ms': 16}, [])), FIELDS)
        first = b.tick(0, obs(), execution={'id': 0, 'state': 'idle'})
        second = b.tick(20, obs(), execution={'id': first['action']['id'], 'state': 'completed'})
        self.assertEqual(second['action']['id'], 2)
        out = b.tick(100, obs(), execution={'id': 1, 'state': 'completed'})
        self.assertIsNone(out['done'])
        out = b.tick(101, obs(), execution={'id': 2, 'state': 'completed'})
        self.assertEqual(out['done'], 'success')

    def test_nested_tree_shares_action_ids_and_executor_status(self):
        child = tree(('p', 'press', {'keys': ['space'], 'ms': 16}, []))
        parent = tree(('s', 'sequence', {}, ['r', 'p']),
                      ('r', 'run', {'tree': 'child'}, []),
                      ('p', 'press', {'keys': ['right'], 'ms': 20}, []))
        b = Behavior(parent, FIELDS, trees={'child': child})
        out = b.tick(0, obs(), execution={'id': 0, 'state': 'idle'})
        self.assertEqual(out['action']['id'], 1)
        out = b.tick(100, obs(), execution={'id': 1, 'state': 'completed'})
        self.assertEqual(out['action']['id'], 2)


if __name__ == '__main__':
    unittest.main()
