import unittest

import torch
from observations import Featurizer, on_grid, phases, relative, relative_size, suggested_step
from formulas import Missing

RELATIVE_SIZE = relative_size()
from worker import button_stats


class RelativeTests(unittest.TestCase):
    def test_platform_below_and_its_edges(self):
        # Standing at (100, 50) on a platform from x 40 to 260 at y 80; another one higher up
        platforms = [{'x1': 40, 'y1': 80, 'x2': 260, 'y2': 80}, {'x1': 0, 'y1': 10, 'x2': 60, 'y2': 10}]
        out = relative(platforms, (100, 50))
        self.assertEqual(len(out), RELATIVE_SIZE)
        near, below, count = out[0:3], out[9:13], out[13]
        self.assertEqual(near, [0.0, 30.0, 1.0])           # straight down to the platform stood on
        self.assertEqual(below, [1.0, 30.0, -60.0, 160.0])  # 30 px down, its edges 60 px left and 160 px right
        self.assertEqual(count, 2.0)

    def test_nearest_to_each_side(self):
        ladders = [{'x1': 60, 'y1': 0, 'x2': 60, 'y2': 200}, {'x1': 310, 'y1': 0, 'x2': 310, 'y2': 200}]
        out = relative(ladders, (100, 100))
        self.assertEqual(out[0:3], [-40.0, 0.0, 1.0])  # nearest: 40 px left
        self.assertEqual(out[3:6], [-40.0, 0.0, 1.0])  # nearest on the left
        self.assertEqual(out[6:9], [210.0, 0.0, 1.0])  # nearest on the right
        self.assertEqual(out[9], 0.0)                  # no segment spans x=100 below
        self.assertEqual(out[13], 1.0)                 # only one within 200 px

    def test_surface_and_radius_are_chosen_not_assumed(self):
        # A ceiling 40 px above and a floor 30 px below; which one is measured is up to the training
        shapes = [{'x1': 0, 'y1': 60, 'x2': 200, 'y2': 60}, {'x1': 50, 'y1': 130, 'x2': 150, 'y2': 130}]
        self.assertEqual(relative(shapes, (100, 100), 'below')[9:13], [1.0, 30.0, -50.0, 50.0])
        self.assertEqual(relative(shapes, (100, 100), 'above')[9:13], [1.0, -40.0, -100.0, 100.0])
        off = relative(shapes, (100, 100), 'off')
        self.assertEqual(len(off), relative_size('off'))
        self.assertEqual(off[9], 2.0)                                       # the count follows straight on
        self.assertEqual(relative(shapes, (100, 100), 'off', near_px=35)[9], 1.0)
        with self.assertRaisesRegex(ValueError, 'below or above'):
            Featurizer({'fields': [{'name': 'p', 'type': 'vector'}, {'name': 's', 'type': 'shapes'}]},
                       derived=[{'name': 'near', 'kind': 'shapes', 'a': 'p', 'b': 's', 'surface': 'sideways'}])

    def test_points_paths_and_nothing(self):
        self.assertEqual(relative([{'x': 110, 'y': 100}], (100, 100))[0:3], [10.0, 0.0, 1.0])
        path = [{'points': [[0, 120], [100, 110], [200, 120]]}]
        self.assertAlmostEqual(relative(path, (100, 100))[10], 10.0)
        self.assertEqual(relative([], (0, 0)), [0.0] * RELATIVE_SIZE)
        self.assertEqual(relative([{'nonsense': 1}, 'x'], (0, 0)), [0.0] * RELATIVE_SIZE)


class FeaturizerTests(unittest.TestCase):
    schema = {'fields': [{'name': 'annotated', 'type': 'image'}, {'name': 'ladders', 'type': 'shapes'},
                         {'name': 'hp', 'type': 'number'}, {'name': 'player', 'type': 'vector', 'size': 2},
                         {'name': 'label', 'type': 'text'}]}

    def observations(self, player=(100, 100), valid=True):
        return [{'name': 'annotated', 'type': 'image', 'valid': True, 'value': {}},
                {'name': 'ladders', 'type': 'shapes', 'valid': True, 'value': [{'x1': 60, 'y1': 0, 'x2': 60, 'y2': 200}]},
                {'name': 'hp', 'type': 'number', 'valid': True, 'value': .5},
                {'name': 'player', 'type': 'vector', 'valid': valid, 'value': list(player) if valid else None},
                {'name': 'label', 'type': 'text', 'valid': True, 'value': 'x'}]

    def test_images_and_text_left_out_shapes_need_an_anchor(self):
        plain = Featurizer(self.schema)
        self.assertEqual(plain.size, 3)
        self.assertEqual(plain(self.observations()), [.5, 100.0, 100.0])
        # An anchor, from before derived values, is shapes near it for every shapes observation, named after it
        anchored = Featurizer(self.schema, 'player')
        self.assertEqual(anchored.size, 3 + RELATIVE_SIZE)
        self.assertEqual(anchored(self.observations())[3:6], [-40.0, 0.0, 1.0])
        with self.assertRaisesRegex(ValueError, 'player isn\u2019t found'):
            anchored(self.observations(valid=False))
        self.assertEqual(anchored.names()[:6], ['hp', 'player.x', 'player.y', 'ladders.nearest.dx', 'ladders.nearest.dy', 'ladders.nearest.found'])
        self.assertEqual(len(anchored.names()), anchored.size)
        self.assertEqual(Featurizer(self.schema, 'player', 'off').names()[-1], 'ladders.nearCount')
        with self.assertRaisesRegex(ValueError, 'anchor must be a vector'):
            Featurizer(self.schema, 'hp')
        with self.assertRaisesRegex(ValueError, 'Nothing here'):
            Featurizer({'fields': [{'name': 'annotated', 'type': 'image'}]})

    def test_values_derived_from_two_observations(self):
        schema = {'fields': [{'name': 'player', 'type': 'vector', 'size': 2}, {'name': 'enemy', 'type': 'vector', 'size': 2},
                             {'name': 'hp', 'type': 'number'}, {'name': 'mp', 'type': 'number'}, {'name': 'ladders', 'type': 'shapes'}]}
        observations = [{'name': 'player', 'type': 'vector', 'valid': True, 'value': [100, 100]},
                        {'name': 'enemy', 'type': 'vector', 'valid': True, 'value': [130, 60]},
                        {'name': 'hp', 'type': 'number', 'valid': True, 'value': 70},
                        {'name': 'mp', 'type': 'number', 'valid': True, 'value': 20},
                        {'name': 'ladders', 'type': 'shapes', 'valid': True, 'value': [{'x1': 60, 'y1': 0, 'x2': 60, 'y2': 200}]}]
        derived = [{'name': 'to enemy', 'kind': 'offset', 'a': 'player', 'b': 'enemy'},
                   {'name': 'enemy distance', 'kind': 'distance', 'a': 'player', 'b': 'enemy'},
                   {'name': 'hp over mp', 'kind': 'difference', 'a': 'mp', 'b': 'hp'},
                   {'name': 'ladders near me', 'kind': 'shapes', 'a': 'player', 'b': 'ladders', 'surface': 'off', 'nearPx': 50}]
        f = Featurizer(schema, derived=derived)
        values = dict(zip(f.names(), f(observations)))
        self.assertEqual((values['to enemy.dx'], values['to enemy.dy']), (30.0, -40.0))
        self.assertEqual(values['enemy distance'], 50.0)
        self.assertEqual(values['hp over mp'], 50.0)
        self.assertEqual((values['ladders near me.nearest.dx'], values['ladders near me.nearCount']), (-40.0, 1.0))
        self.assertEqual([g['observation'] for g in f.groups() if g['derived']], ['to enemy', 'enemy distance', 'hp over mp', 'ladders near me'])
        # Only the chosen values are made, and an observation none of them needs isn't read
        chosen = Featurizer(schema, columns=['enemy distance', 'hp'], derived=derived)
        broken = [dict(o, valid=False, value=None) if o['name'] == 'mp' else o for o in observations]
        self.assertEqual(chosen(broken), [70.0, 50.0])
        self.assertEqual(chosen.names(), ['hp', 'enemy distance'])
        with self.assertRaisesRegex(ValueError, 'B must be a vector'):
            Featurizer(schema, derived=[{'name': 'x', 'kind': 'distance', 'a': 'player', 'b': 'hp'}])
        with self.assertRaisesRegex(ValueError, 'Two values are called hp'):
            Featurizer(schema, derived=[{'name': 'hp', 'kind': 'difference', 'a': 'mp', 'b': 'hp'}])
        with self.assertRaisesRegex(ValueError, 'Not among'):
            Featurizer(schema, columns=['nope'])


class GridTests(unittest.TestCase):
    def test_shapes_as_a_grid_over_the_screen(self):
        from shapes import grid_values, lines_of
        # A 400 x 200 screen in 4 x 2 cells of 100 px: a platform across the bottom half's first two cells,
        # a ladder down the right-hand column, and a point in the top-left cell
        lines = lines_of([{'x1': 0, 'y1': 150, 'x2': 200, 'y2': 150}, {'x1': 350, 'y1': 0, 'x2': 350, 'y2': 200}, {'x': 10, 'y': 10}])
        cover = grid_values(lines, 400, 200, 4, 2, 'coverage')
        self.assertEqual(len(cover), 8)
        self.assertEqual(cover[4:6], [1.0, 1.0])                  # the platform fills its two cells
        self.assertEqual((cover[3], cover[7]), (1.0, 1.0))        # the ladder its column's
        self.assertEqual(cover[0], 1.0)                           # the point, a cell's worth
        self.assertEqual((cover[1], cover[2], cover[6]), (0.0, 0.0, 0.0))
        half = grid_values(lines_of([{'x1': 0, 'y1': 150, 'x2': 50, 'y2': 150}]), 400, 200, 4, 2)
        self.assertAlmostEqual(half[4], 0.5)                      # half a cell's width
        self.assertEqual(grid_values(lines_of([{'x1': 0, 'y1': 150, 'x2': 50, 'y2': 150}]), 400, 200, 4, 2, 'present')[4], 1.0)
        self.assertEqual(grid_values([], 400, 200, 4, 2), [0.0] * 8)

    def test_a_grid_is_columns_over_the_frame_and_left_out_of_earlier_steps(self):
        schema = {'fields': [{'name': 'hp', 'type': 'number'}, {'name': 'platforms', 'type': 'shapes'}]}
        grid = {'name': 'layout', 'shapes': 'platforms', 'cols': 4, 'rows': 2, 'width': 400, 'height': 200}
        f = Featurizer(schema, grids=[grid])
        self.assertEqual(f.names()[:3], ['hp', 'layout.r0c0', 'layout.r0c1'])
        self.assertEqual(len(f.names()), 9)
        self.assertEqual(f.history_names(), ['hp'])
        self.assertTrue([g for g in f.groups() if g['grid']])
        obs = [{'name': 'hp', 'type': 'number', 'valid': True, 'value': 5},
               {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': [{'x1': 0, 'y1': 150, 'x2': 200, 'y2': 150}]}]
        self.assertEqual(f(obs), [5.0, 0, 0, 0, 0, 1.0, 1.0, 0, 0])
        # The sample's own frame size wins over the one the grid was set up for: here twice as big, so its
        # cells are 200 px, and the same platform (y 150, x 0..200) fills the top row's first cell
        frame = {o['name']: o for o in obs}
        frame['@frame'] = {'name': '@frame', 'valid': True, 'value': [800, 400]}
        self.assertEqual(f(frame)[1:], [1.0, 0, 0, 0, 0, 0, 0, 0])
        for bad in ({**grid, 'shapes': 'hp'}, {**grid, 'cols': 0}, {**grid, 'mode': 'fuzzy'}, {**grid, 'name': ''}):
            with self.assertRaises(ValueError):
                Featurizer(schema, grids=[bad])

    def test_a_grid_centred_on_the_player_moves_with_them(self):
        schema = {'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'platforms', 'type': 'shapes'}, {'name': 'hp', 'type': 'number'}]}
        # 3 x 3 cells of 40 px around the player: 120 x 120 px, the player in the middle cell
        near = {'name': 'near', 'shapes': 'platforms', 'cols': 3, 'rows': 3, 'center': 'player', 'cell': 40}
        f = Featurizer(schema, columns=['near.r0c0'] + [f'near.r{r}c{c}' for r in range(3) for c in range(3)][1:], grids=[near])

        def cells(player, platform_y=350):
            return f([{'name': 'player', 'type': 'vector', 'valid': True, 'value': player},
                      {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': [{'x1': 0, 'y1': platform_y, 'x2': 2000, 'y2': platform_y}]}])
        # A floor 50 px below the player fills the bottom row, wherever on the screen they stand
        self.assertEqual(cells([400, 300]), [0, 0, 0, 0, 0, 0, 1.0, 1.0, 1.0])
        self.assertEqual(cells([1500, 300]), cells([400, 300]))
        # Standing on it (the floor 10 px below): the middle row
        self.assertEqual(cells([400, 340]), [0, 0, 0, 1.0, 1.0, 1.0, 0, 0, 0])
        # Nothing within reach: an empty grid, not a missing one
        self.assertEqual(cells([400, 300], platform_y=900), [0.0] * 9)
        # The player not found: the row is skipped
        with self.assertRaises(Missing):
            f([{'name': 'player', 'type': 'vector', 'valid': False, 'value': None},
               {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': []}])
        # Centred on a formula, such as a point ahead of the player
        ahead = Featurizer(schema, columns=[f'ahead.r{r}c{c}' for r in range(3) for c in range(3)],
                           formulas=[{'name': 'front', 'source': 'player + vec(0, 40)'}],
                           grids=[{**near, 'name': 'ahead', 'center': 'front'}])
        self.assertEqual(ahead([{'name': 'player', 'type': 'vector', 'valid': True, 'value': [400, 300]},
                                {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': [{'x1': 0, 'y1': 350, 'x2': 2000, 'y2': 350}]}]),
                         [0, 0, 0, 1.0, 1.0, 1.0, 0, 0, 0])
        for bad in ({**near, 'center': 'hp'}, {**near, 'center': 'nope'}, {**near, 'cell': 1}):
            with self.assertRaises(ValueError):
                Featurizer(schema, grids=[bad])


class SequenceTests(unittest.TestCase):
    def test_samples_go_on_an_even_grid_with_gaps_where_there_are_none(self):
        # Samples near every 100 ms, a few ms early or late, then nothing for a while, then two close together
        times = [0, 98, 205, 300, 390, 800, 830, 900]
        #          0    100   200   300   400  500   600   700   800  900
        self.assertEqual(on_grid(times, 100), [0, 1, 2, 3, 4, None, None, None, 5, 7])
        self.assertEqual(on_grid([], 100), [])
        # From 84.7 (the typical interval, the 410 ms pause and the 30 ms pair left out), a little longer so
        # that 9 grid points in 10 have a sample
        self.assertEqual(suggested_step([times, [0, 66, 133]]), 88.9)
        self.assertEqual(suggested_step([[5]]), 66.7)
        # Samples every 33 ms stay at 33: the step matches them
        self.assertEqual(suggested_step([[i * 33.3 + i % 3 for i in range(300)]]), 33.3)

    def test_samples_taken_more_often_than_the_step_fill_more_grids(self):
        # Every 45 ms on a 90 ms step: the grid from the first sample takes every other one, and a second
        # grid half a step later takes the ones between
        times = [i * 45.0 for i in range(20)]
        self.assertEqual(phases(times, 90), 2)
        self.assertEqual(on_grid(times, 90), list(range(0, 20, 2)))
        self.assertEqual(on_grid(times, 90, 45), list(range(1, 20, 2)))
        self.assertEqual(phases(times, 45), 1)
        self.assertEqual(phases([i * 10.0 for i in range(50)], 100), 4)  # at most 4

    def test_the_suggested_step_is_one_most_grid_points_have_a_sample_for(self):
        # Detection keeps up half the time (40 ms apart) and falls behind the rest (100-140 ms): a 40 ms step
        # would leave most points gaps, and every row with earlier steps would be lost with them
        times, t = [], 0.0
        for i in range(400):
            times.append(t)
            t += 40 if i % 4 < 2 else 100 + (i % 5) * 10
        step = suggested_step([times])
        grid = on_grid(times, step)
        self.assertGreater(step, 60)
        self.assertGreaterEqual(sum(i is not None for i in grid) / len(grid), 0.9)

    def test_button_stats_see_through_a_rarely_pressed_button(self):
        labels = torch.tensor([[1.0], [0.0], [0.0], [0.0]])
        never = button_stats(torch.full((4, 1), -1.0), labels, [{'id': 'jump'}])[0]
        self.assertEqual((never['recall'], never['f1'], never['pressed']), (0.0, 0.0, .25))
        right = button_stats(torch.tensor([[1.0], [-1.0], [-1.0], [-1.0]]), labels, [{'id': 'jump'}])[0]
        self.assertEqual((right['precision'], right['recall'], right['f1']), (1.0, 1.0, 1.0))


if __name__ == '__main__':
    unittest.main()
