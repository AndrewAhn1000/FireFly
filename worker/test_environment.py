import unittest
from environment import Transition

class TransitionTests(unittest.TestCase):
    def test_continuing_transition_and_invalid_boundary(self):
        value = Transition(100, 200, 'obs', 'act', (1.,), (True,), 0., (2.,))
        self.assertFalse(value.terminal)
        for end, reward in [(100, 0.), (200, float('nan'))]:
            with self.assertRaises(ValueError):
                Transition(100, end, 'obs', 'act', (1.,), (True,), reward, (2.,))
