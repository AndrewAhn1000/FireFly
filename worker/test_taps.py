import unittest

from worker import taps_from_samples, taps_of

BUTTONS = [{'id': 'a'}, {'id': 'left'}, {'id': 'space'}]


def recording(pattern, step=50):
    """Rows on a grid of `step` ms from a pattern of (a, left, space) held per step."""
    return [(i * step, [], [float(v) for v in held]) for i, held in enumerate(pattern)]


class TapTests(unittest.TestCase):
    def test_a_rhythm_of_short_presses_is_tapped_held_and_occasional_ones_are_not(self):
        pattern = []
        for _ in range(12):
            pattern += [(1, 1, 0), (1, 1, 0), (0, 1, 0), (0, 1, 0)] * 3   # attack: 100 ms down, 100 up; left held throughout
            pattern += [(0, 0, 1), (0, 0, 0)] + [(0, 0, 0)] * 10         # a jump now and then
            pattern += [(0, 0, 0)] * 2
        taps = taps_of([('r', recording(pattern))], BUTTONS, 50)
        self.assertEqual(taps, {'a': {'downMs': 100, 'upMs': 100}})

    def test_short_presses_far_apart_are_not_tapped(self):
        pattern = ([(0, 1, 0)] * 5 + [(0, 0, 0)] * 8) * 12  # left: 250 ms, then 400 let go, as when turning
        self.assertEqual(taps_of([('r', recording(pattern))], BUTTONS, 50), {})

    def test_a_gap_in_the_grid_ends_a_press_unmeasured(self):
        rows = recording([(1, 0, 0)] * 2 + [(0, 0, 0)] * 2) * 1
        rows += [(t + 10_000, x, y) for t, x, y in recording([(1, 0, 0)] * 2 + [(0, 0, 0)] * 2)]
        self.assertEqual(taps_of([('r', rows)], BUTTONS, 50), {})  # too few presses to tell


def samples(pattern, step=45, invalid=()):
    """Recorded samples every `step` ms from a pattern of (a, left, space) held; those numbered in `invalid` are
    samples whose buttons don't count (the game not in front)."""
    return [{'timestamp': 1000.0 + i * step, 'actions': {'valid': i not in invalid,
             'buttons': {b['id']: bool(v) for b, v in zip(BUTTONS, held)}}} for i, held in enumerate(pattern)]


class SampleTapTests(unittest.TestCase):
    def test_a_key_held_for_seconds_and_nudged_now_and_then_is_held(self):
        # Left: walked on for 2-3 s at a time, between nudges of 135 ms to line up a jump (more nudges than walks)
        pattern = []
        for _ in range(6):
            pattern += [(0, 1, 0)] * 60 + [(0, 0, 0)] * 4
            pattern += ([(0, 1, 0)] * 3 + [(0, 0, 0)] * 4) * 3
        self.assertEqual(taps_from_samples([('r', samples(pattern))], BUTTONS), {})

    def test_an_attack_tapped_in_a_rhythm_is_tapped(self):
        pattern = ([(1, 0, 0)] * 2 + [(0, 0, 0)] * 2) * 20
        self.assertEqual(taps_from_samples([('r', samples(pattern))], BUTTONS), {'a': {'downMs': 90, 'upMs': 90}})

    def test_holes_in_the_rows_dont_cut_a_hold_into_taps(self):
        # The rows a dataset makes can skip moments; the samples have every one, so a hold is measured whole
        pattern = ([(0, 1, 0)] * 40 + [(0, 0, 0)] * 3) * 10
        self.assertEqual(taps_from_samples([('r', samples(pattern))], BUTTONS), {})  # from the samples: held


if __name__ == '__main__':
    unittest.main()
