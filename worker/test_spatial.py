import unittest

from formulas import Missing
from observations import Featurizer
from spatial import box_of, columns, default_fields, relations


def box(x, y, w, h):
    return {'points': [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], 'x': x, 'y': y, 'w': w, 'h': h}


def line(*points):
    return {'points': [list(p) for p in points]}


class RelationTests(unittest.TestCase):
    def test_a_floor_below_and_a_wall_to_the_right(self):
        floor, wall = line((0, 100), (400, 100)), line((300, 0), (300, 100))
        dx, dy, dist, found, left, right, above, below, w100, w250, w500, inside = relations([floor, wall], (200, 90))
        self.assertEqual((dx, dy, dist, found), (0, 10, 10, 1))
        self.assertEqual((left, right, above, below), (10, 10, 100, 10))  # the floor runs both ways under it; the wall's top half
        self.assertEqual((w100, w250, w500, inside), (2, 2, 2, 0))

    def test_directions_are_half_planes(self):
        monster = box(300, 50, 40, 40)  # to the right, level with it
        values = relations([monster], (200, 70), radii=(50, 150))
        self.assertEqual(values[:4], [100, 0, 100, 1])
        self.assertEqual(values[4:8], [1000, 100, 100, 100])  # left: nothing; above and below: its corners' halves
        self.assertEqual(values[8:], [0, 1, 0])

    def test_inside_a_box_is_no_distance_every_way(self):
        values = relations([box(0, 0, 100, 100)], (50, 50), radii=(10,))
        self.assertEqual(values, [0, 0, 0, 1, 0, 0, 0, 0, 1, 1])

    def test_an_open_path_is_never_inside(self):
        u = line((0, 0), (0, 100), (100, 100), (100, 0))  # three sides of a square, not closed
        self.assertEqual(relations([u], (50, 50), radii=())[-1], 0)

    def test_facing_turns_left_and_right_into_ahead_and_behind(self):
        monster = box(100, 50, 20, 20)  # to the left
        right_way = relations([monster], (200, 60), facing_left=False, radii=())
        left_way = relations([monster], (200, 60), facing_left=True, radii=())
        self.assertEqual(right_way[0], -80)  # behind: dx negative
        self.assertEqual(left_way[0], 80)    # ahead
        self.assertEqual(right_way[4:6], [1000, 80])  # ahead, behind
        self.assertEqual(left_way[4:6], [80, 1000])

    def test_nothing_near_reads_as_the_reach_away(self):
        far = box(5000, 5000, 10, 10)
        self.assertEqual(relations([far], (0, 0), radii=(100,), max_distance=500), [0, 0, 500, 0, 500, 500, 500, 500, 0, 0])
        self.assertEqual(relations([], (0, 0), radii=(100,), max_distance=500), [0, 0, 500, 0, 500, 500, 500, 500, 0, 0])

    def test_column_names(self):
        self.assertEqual(columns('near', ['mobs'], [100], False),
                         ['near.mobs.nearest.dx', 'near.mobs.nearest.dy', 'near.mobs.nearest.dist', 'near.mobs.nearest.found',
                          'near.mobs.left', 'near.mobs.right', 'near.mobs.above', 'near.mobs.below', 'near.mobs.within.100', 'near.mobs.inside'])
        self.assertIn('near.mobs.ahead', columns('near', ['mobs'], [100], True))


SCHEMA = {'identity': 'x', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'left', 'type': 'boolean'},
                                      {'name': 'monsters', 'type': 'shapes'}, {'name': 'platforms', 'type': 'shapes'}]}


def sample(player=(200, 90), mobs=(), platforms=(), valid=True):
    return [{'name': 'player', 'valid': player is not None, 'value': list(player) if player else None},
            {'name': 'left', 'valid': True, 'value': False},
            {'name': 'monsters', 'valid': valid, 'value': [box(*m) for m in mobs] if valid else None},
            {'name': 'platforms', 'valid': True, 'value': list(platforms)}]


class FeaturizerTests(unittest.TestCase):
    spec = {'name': 'near', 'point': 'player', 'sets': [{'alias': 'mobs', 'shapes': 'monsters'}, {'alias': 'floor', 'shapes': 'platforms'}],
            'radii': [100]}

    def test_a_spatial_node_makes_its_columns_for_every_set(self):
        f = Featurizer(SCHEMA, columns=None, spatial=[self.spec])
        names = f.names()
        self.assertIn('near.mobs.nearest.dist', names)
        self.assertIn('near.floor.below', names)
        x = f(sample(mobs=[(250, 80, 20, 20)], platforms=[line((0, 100), (400, 100))]))
        self.assertEqual(x[names.index('near.mobs.nearest.dx')], 50)
        self.assertEqual(x[names.index('near.floor.below')], 10)
        self.assertEqual(f.describe()['spatial'][0]['name'], 'near')

    def test_a_set_not_read_is_nothing_near_but_a_missing_point_skips_the_row(self):
        f = Featurizer(SCHEMA, spatial=[self.spec])
        names = f.names()
        x = f(sample(valid=False))
        self.assertEqual(x[names.index('near.mobs.nearest.found')], 0)
        with self.assertRaises(Missing):
            f(sample(player=None))

    def test_the_point_and_facing_can_be_formulas(self):
        spec = {**self.spec, 'point': 'feet', 'facing': 'left'}
        f = Featurizer(SCHEMA, formulas=[{'name': 'feet', 'source': 'player + vec(0, -30)'}], spatial=[spec])
        x = f(sample(mobs=[(250, 80, 20, 20)]))
        names = f.names()
        self.assertEqual(x[names.index('near.mobs.nearest.dy')], 20)  # from (200, 60) to the box's top-left corner
        self.assertEqual(x[names.index('near.mobs.nearest.dx')], 50)  # facing right: ahead
        self.assertIn('near.mobs.ahead', names)

    def test_an_input_can_measure_several_observations_as_one_set(self):
        schema = {**SCHEMA, 'fields': SCHEMA['fields'] + [{'name': 'players', 'type': 'shapes'}]}
        spec = {'name': 'near', 'point': 'player', 'sets': [{'alias': 'beings', 'shapes': ['monsters', 'players']}], 'radii': [100]}
        f = Featurizer(schema, spatial=[spec])
        names = f.names()
        x = f(sample(mobs=[(250, 80, 20, 20)]) + [{'name': 'players', 'valid': True, 'value': [box(150, 80, 20, 20)]}])
        self.assertEqual(x[names.index('near.beings.within.100')], 2)
        self.assertEqual(x[names.index('near.beings.nearest.dist')], 30)  # the player box, 30 px to the left

    def test_the_picture_is_framed_by_the_bounds_or_by_everything(self):
        f = Featurizer(SCHEMA, spatial=[{**self.spec, 'bounds': 'platforms'}])
        values = {o['name']: o for o in sample(mobs=[(250, 80, 20, 20)], platforms=[line((0, 100), (400, 100)), {'x': -100, 'y': -50, 'w': 600, 'h': 300}])}
        drawn = f.spatial_picture(f.spatial[0], values, [values])
        self.assertEqual(drawn['bounds'], [-100, -50, 500, 250])
        self.assertFalse(drawn['fitted'])
        self.assertEqual(drawn['point'], [200, 90])
        self.assertEqual(drawn['sets'][0]['alias'], 'mobs')
        self.assertEqual(drawn['sets'][0]['shapes'][0], {'points': [[250, 80], [270, 80], [270, 100], [250, 100], [250, 80]], 'closed': True})
        fitted = Featurizer(SCHEMA, spatial=[self.spec])
        drawn = fitted.spatial_picture(fitted.spatial[0], values, [values])
        self.assertTrue(drawn['fitted'])
        self.assertLess(drawn['bounds'][0], 0)  # round the floor from 0 to 400, and a margin
        self.assertGreater(drawn['bounds'][2], 400)

    def test_the_picture_says_what_every_field_is_about(self):
        f = Featurizer(SCHEMA, spatial=[{**self.spec, 'radii': [60, 300], 'maxDistance': 500}])
        values = {o['name']: o for o in sample(mobs=[(250, 80, 20, 20), (190, 80, 20, 20), (900, 80, 20, 20)])}
        drawn = f.spatial_picture(f.spatial[0], values, [values])['sets'][0]
        self.assertEqual(drawn['fields']['inside'], {'shapes': [1]})  # the second box holds the point (200, 90)
        self.assertEqual(drawn['fields']['nearest.dist'], {'end': [200, 90, 0], 'shape': 1})
        self.assertEqual(drawn['distances'], [50, 0, None])  # the far one is past the reach (500): not measured
        values = {o['name']: o for o in sample(mobs=[(250, 80, 20, 20), (900, 80, 20, 20)])}
        drawn = f.spatial_picture(f.spatial[0], values, [values])['sets'][0]
        self.assertEqual(drawn['fields']['inside'], {'shapes': []})
        self.assertEqual(drawn['fields']['nearest.dx'], {'end': [250, 90, 50], 'shape': 0})
        self.assertEqual(drawn['fields']['right']['end'], [250, 90, 50])
        self.assertIsNone(drawn['fields']['left'])  # nothing to the left
        self.assertEqual(drawn['fields']['above']['end'], [250, 90, 50])  # the box's half above the point's line
        self.assertEqual(drawn['fields']['within.60'], {'shapes': [0]})
        self.assertEqual(drawn['distances'], [50, None])

    def test_fields_of_its_own_read_the_shapes_fields(self):
        mobs = [{**box(250, 80, 20, 20), 'hp': 80, 'id': 100100}, {**box(400, 80, 20, 20), 'hp': 20},
                {**box(120, 80, 20, 20), 'hp': 100}, {**box(150, 300, 20, 20)}]  # the last one has no hp
        fields = [
            {'name': 'weakest.hp', 'pick': 'lowest', 'by': 'hp', 'value': 'prop'},
            {'name': 'weakest.dx', 'pick': 'lowest', 'by': 'hp', 'value': 'dx'},
            {'name': 'strongest.dist', 'pick': 'highest', 'by': 'hp', 'value': 'dist'},
            {'name': 'nearest.hp', 'pick': 'nearest', 'value': 'prop', 'prop': 'hp', 'fill': 100},
            {'name': 'hurt', 'pick': 'all', 'value': 'count', 'where': {'field': 'hp', 'op': '<', 'value': 100}},
            {'name': 'hurt.near', 'pick': 'all', 'value': 'count', 'within': 100, 'where': {'field': 'hp', 'op': '<', 'value': 100}},
            {'name': 'ahead.hp', 'pick': 'ahead', 'value': 'prop', 'prop': 'hp'},
            {'name': 'nearest.fwd', 'pick': 'nearest', 'value': 'forward'},
            {'name': 'mobs.only', 'pick': 'all', 'value': 'count', 'inputs': ['mobs']},
        ]
        spec = {**self.spec, 'facing': 'left', 'fields': fields}
        f = Featurizer(SCHEMA, spatial=[spec])
        names = f.names()
        self.assertEqual([n for n in names if n.startswith('near.mobs.')], [f'near.mobs.{x["name"]}' for x in fields])
        self.assertNotIn('near.floor.mobs.only', names)  # only for the monsters
        values = {o['name']: o for o in sample(mobs=[])}
        values['monsters']['value'] = mobs
        x = dict(zip(names, f(list(values.values()))))
        self.assertEqual(x['near.mobs.weakest.hp'], 20)
        self.assertEqual(x['near.mobs.weakest.dx'], 200)  # its left edge, 200 px right of the point (200, 90)
        self.assertEqual(x['near.mobs.strongest.dist'], 60)  # hp 100, 60 px to the left
        self.assertEqual(x['near.mobs.nearest.hp'], 80)
        self.assertEqual(x['near.mobs.hurt'], 2)
        self.assertEqual(x['near.mobs.hurt.near'], 1)
        self.assertEqual(x['near.mobs.ahead.hp'], 80)  # facing right: ahead is right
        self.assertEqual(x['near.mobs.nearest.fwd'], 50)
        self.assertEqual(x['near.mobs.mobs.only'], 4)
        # Nothing to pick: the fill, the reach, 0
        values['monsters']['value'] = []
        x = dict(zip(names, f(list(values.values()))))
        self.assertEqual((x['near.mobs.nearest.hp'], x['near.mobs.weakest.hp'], x['near.mobs.strongest.dist'], x['near.mobs.weakest.dx']), (100, 0, 1000, 0))
        # The picture lists the fields the shapes carry, and each shape's that the fields read
        values['monsters']['value'] = mobs
        drawn = f.spatial_picture(f.spatial[0], values, [values])['sets'][0]
        self.assertEqual(drawn['props'], ['hp', 'id'])
        self.assertEqual(drawn['shapes'][1]['props'], {'hp': 20})
        self.assertNotIn('props', drawn['shapes'][3])
        self.assertEqual(drawn['fields']['weakest.hp']['shape'], 1)
        self.assertEqual(drawn['fields']['hurt'], {'shapes': [0, 1]})

    def test_fields_that_dont_fit_say_why(self):
        for bad, message in [([{'name': 'a', 'pick': 'all', 'value': 'dx'}], 'count or whether'),
                             ([{'name': 'a', 'pick': 'nearest', 'value': 'count'}], 'dx, dy'),
                             ([{'name': 'a', 'pick': 'ahead', 'value': 'dist'}], 'need Facing'),
                             ([{'name': 'a', 'pick': 'nearest', 'value': 'forward'}], 'need Facing'),
                             ([{'name': 'a', 'pick': 'lowest', 'value': 'dist'}], 'ranks by'),
                             ([{'name': 'a', 'pick': 'nearest', 'value': 'prop'}], 'which of the shape'),
                             ([{'name': 'a', 'pick': 'nearest', 'value': 'dx'}, {'name': 'a', 'pick': 'nearest', 'value': 'dy'}], 'two fields'),
                             ([{'name': 'a b', 'pick': 'nearest', 'value': 'dx'}], 'letters'),
                             ([{'name': 'a', 'pick': 'all', 'value': 'count', 'where': {'field': 'hp', 'op': '~', 'value': 1}}], 'compares'),
                             ([{'name': 'a', 'pick': 'nearest', 'value': 'dx', 'inputs': ['nope']}], 'inputs'), ([], '1..')]:
            with self.assertRaisesRegex(ValueError, message):
                Featurizer(SCHEMA, spatial=[{**self.spec, 'fields': bad}])

    def test_a_node_without_fields_of_its_own_has_the_presets(self):
        f = Featurizer(SCHEMA, spatial=[self.spec])
        self.assertEqual(f.spatial[0]['fields'], default_fields([100], False))
        self.assertEqual([n for n in f.names() if n.startswith('near.mobs.')], columns('near', ['mobs'], [100], False))

    def test_bounds_can_be_a_table_a_script_returns(self):
        for value in ({'left': -100, 'top': -50, 'right': 500, 'bottom': 250}, {'x1': 500, 'y1': 250, 'x2': -100, 'y2': -50},
                      {'minX': -100, 'minY': -50, 'maxX': 500, 'maxY': 250}, {'x': -100, 'y': -50, 'w': 600, 'h': 300},
                      [-100, -50, 500, 250], [[-100, -50], [500, 250]], {'points': [[-100, -50], [500, -50], [500, 250]]},
                      [{'x': -100, 'y': -50, 'w': 100, 'h': 100}, {'left': 0, 'top': 0, 'right': 500, 'bottom': 250}]):
            self.assertEqual(box_of(value), [-100, -50, 500, 250], value)
        for nothing in ({}, {'left': 1}, [], [1, 2, 3], 'map', None):
            self.assertIsNone(box_of(nothing))
        schema = {**SCHEMA, 'fields': SCHEMA['fields'] + [{'name': 'Map Bounds', 'type': 'object'}]}
        f = Featurizer(schema, spatial=[{**self.spec, 'bounds': 'Map Bounds'}])
        values = {o['name']: o for o in sample() + [{'name': 'Map Bounds', 'valid': True, 'value': {'left': -1000, 'top': -500, 'right': 3000, 'bottom': 800}}]}
        drawn = f.spatial_picture(f.spatial[0], values, [values])
        self.assertEqual(drawn['bounds'], [-1000, -500, 3000, 800])
        self.assertFalse(drawn['fitted'])
        values['Map Bounds'] = {'name': 'Map Bounds', 'valid': True, 'value': {'size': 3}}  # not a box: framed round everything
        self.assertTrue(f.spatial_picture(f.spatial[0], values, [values])['fitted'])

    def test_an_input_reads_x_y_w_h_as_it_says(self):
        mob = {'x': 250, 'y': 60, 'w': 40, 'h': 30, 'hp': 50}  # a script's box: from its top-left corner, no points
        values = {o['name']: o for o in sample()}
        values['monsters']['value'] = [mob]
        def measured(read):
            spec = {**self.spec, 'sets': [{'alias': 'mobs', 'shapes': ['monsters'], **({'read': read} if read else {})}],
                    'fields': [{'name': 'dx', 'pick': 'nearest', 'value': 'dx'}, {'name': 'dy', 'pick': 'nearest', 'value': 'dy'},
                               {'name': 'hp', 'pick': 'nearest', 'value': 'prop', 'prop': 'hp'}]}
            f = Featurizer(SCHEMA, spatial=[spec])
            names = f.names()
            x = f(list(values.values()))
            return [x[names.index(f'near.mobs.{k}')] for k in ('dx', 'dy', 'hp')], f.spatial[0]['sets'][0]
        self.assertEqual(measured(None)[0], [50, -30, 50])        # its corner, as before
        self.assertNotIn('read', measured(None)[1])              # a node from before: the same spec
        self.assertEqual(measured('corner')[0], [50, 0, 50])      # its left edge, level with the point (200, 90)
        self.assertEqual(measured('centre')[0], [30, -15, 50])    # the box round (250, 60), 230..270 by 45..75: nearest (230, 75)
        self.assertEqual(measured('bottom')[0], [70, 0, 50])      # (270, 90), its bottom centre
        with self.assertRaisesRegex(ValueError, 'reads x, y, w, h'):
            Featurizer(SCHEMA, spatial=[{**self.spec, 'sets': [{'alias': 'mobs', 'shapes': ['monsters'], 'read': 'middle'}]}])

    def test_a_field_can_look_only_in_an_area_ahead_that_turns_with_facing(self):
        mobs = [box(260, 50, 40, 40), box(120, 60, 30, 30), box(240, -200, 40, 40)]  # ahead, behind, ahead but far up
        fields = [{'name': 'in.reach', 'pick': 'all', 'value': 'count', 'area': {'ahead': 100, 'behind': 10, 'above': 80, 'below': 10}},
                  {'name': 'reach.dist', 'pick': 'nearest', 'value': 'dist', 'area': {'ahead': 100, 'behind': 10, 'above': 80, 'below': 10}}]
        values = {o['name']: o for o in sample()}
        values['monsters']['value'] = mobs
        def measured(left):
            values['left']['value'] = left
            f = Featurizer(SCHEMA, spatial=[{**self.spec, 'facing': 'left', 'fields': fields}])
            names = f.names()
            x = f(list(values.values()))
            return x[names.index('near.mobs.in.reach')], x[names.index('near.mobs.reach.dist')], f
        self.assertEqual(measured(False)[:2], (1, 60))   # facing right: the box at 260, 60 px away; not the one up high
        self.assertEqual(measured(True)[:2], (1, 50))    # facing left: the one at 120..150, 50 px away
        f = measured(False)[2]
        drawn = f.spatial_picture(f.spatial[0], values, [values])
        self.assertEqual(drawn['areas']['in.reach'], [190, 10, 300, 100])  # 10 behind, 100 ahead, 80 up, 10 down of (200, 90)
        self.assertEqual(drawn['sets'][0]['fields']['in.reach'], {'shapes': [0]})
        # A line through the area counts though no point of it is in it, and a box round the whole area does too
        values['monsters']['value'] = [line((150, 60), (500, 60)), box(0, -500, 900, 900)]
        self.assertEqual(measured(False)[0], 2)
        with self.assertRaisesRegex(ValueError, 'an area reaches'):
            Featurizer(SCHEMA, spatial=[{**self.spec, 'fields': [{'name': 'a', 'pick': 'all', 'value': 'count', 'area': {'ahead': 0, 'behind': 0, 'above': 5, 'below': 5}}]}])

    def test_bad_specs_say_what_is_wrong(self):
        for bad, message in [({**self.spec, 'point': 'monsters'}, 'Point'), ({**self.spec, 'sets': []}, 'wire 1'),
                             ({**self.spec, 'facing': 'player'}, 'Facing'), ({**self.spec, 'radii': [0]}, 'radii')]:
            with self.assertRaisesRegex(ValueError, message):
                Featurizer(SCHEMA, spatial=[bad])


class UnderTests(unittest.TestCase):
    # A platform stood on, a ledge up and right, a rope, and one far right and a little lower
    PLATFORMS = [{'points': [[0, 100], [1000, 100]]}, {'points': [[600, -200], [800, -200]]},
                 {'points': [[900, -300], [900, 90]]}, {'points': [[1150, 40], [1500, 40]]}]
    FIELDS = [{'name': 'on.dy', 'pick': 'under', 'value': 'dy'}, {'name': 'on.left', 'pick': 'under', 'value': 'left_end'},
              {'name': 'on.right', 'pick': 'under', 'value': 'right_end'}, {'name': 'on.ahead', 'pick': 'under', 'value': 'ahead_end'},
              {'name': 'next.dx', 'pick': 'ahead', 'value': 'forward', 'notUnder': True},
              {'name': 'next.dy', 'pick': 'ahead', 'value': 'dy', 'notUnder': True}, {'name': 'right', 'pick': 'right', 'value': 'dist'}]

    def values(self, point, facing_left):
        import spatial
        fields = spatial.checked_fields('s', self.FIELDS, ['p'], True)
        return dict(zip([f['name'] for f in fields], spatial.evaluate(self.PLATFORMS, point, facing_left, fields, 1000)[0]))

    def test_standing_on_a_platform_its_ends_and_the_next_ledge(self):
        v = self.values((300, 95), False)
        self.assertEqual((v['on.dy'], v['on.left'], v['on.right'], v['on.ahead']), (5, 300, 700, 700))
        self.assertEqual(v['right'], 5)                         # the one stood on, beside the point
        self.assertEqual((v['next.dx'], v['next.dy']), (300, -295))  # the ledge up and right, not the one stood on
        v = self.values((300, 95), True)
        self.assertEqual(v['on.ahead'], 300)                     # facing left, its left end is ahead
        self.assertEqual((v['next.dx'], v['next.dy']), (0, 0))   # nothing ahead but the one stood on

    def test_feet_a_little_into_the_platform_still_stand_on_it(self):
        v = self.values((300, 103), False)
        self.assertEqual(v['on.dy'], -3)

    def test_in_the_air_over_a_gap_nothing_is_under_and_the_next_platform_is_ahead(self):
        v = self.values((1100, 0), False)
        self.assertEqual((v['on.dy'], v['on.left'], v['on.right']), (0, 1000, 1000))  # none: dy 0, ends the reach
        self.assertEqual((v['next.dx'], v['next.dy']), (50, 40))

    def test_ropes_are_never_under_and_under_cant_leave_itself_out(self):
        import spatial
        f = spatial.checked_fields('s', [{'name': 'on', 'pick': 'under', 'value': 'dist'}], ['p'], False)
        self.assertEqual(spatial.evaluate([{'points': [[50, 0], [50, 500]]}], (50, 10), None, f, 1000)[0], [1000.0])
        with self.assertRaisesRegex(ValueError, 'leave itself out'):
            spatial.checked_fields('s', [{'name': 'on', 'pick': 'under', 'value': 'dist', 'notUnder': True}], ['p'], False)
        with self.assertRaisesRegex(ValueError, 'Facing'):
            spatial.checked_fields('s', [{'name': 'on', 'pick': 'under', 'value': 'ahead_end'}], ['p'], False)


class SampleTests(unittest.TestCase):
    def test_one_live_sample_measured_and_drawn_with_a_formula_point(self):
        import tempfile
        from worker import Worker
        with tempfile.TemporaryDirectory() as root:
            w = Worker(root)
            request = {'fields': SCHEMA['fields'], 'formulas': [{'name': 'feet', 'source': 'player + vec(0, -10)'}],
                       'spatial': {'name': 'near', 'point': 'feet', 'sets': [{'alias': 'mobs', 'shapes': ['monsters']}], 'radii': [100]},
                       'observations': sample(mobs=[(250, 70, 20, 20)]), 'frame': {'w': 800, 'h': 600}}
            out = w.spatial_sample(request)
            self.assertIsNone(out['error'])
            self.assertEqual(out['values'][out['columns'].index('near.mobs.nearest.dist')], 50)
            self.assertEqual(out['picture']['point'], [200, 80])
            request['observations'] = sample(player=None)
            out = w.spatial_sample(request)
            self.assertIsNone(out['picture'])
            self.assertIn('player', out['error'])


if __name__ == '__main__':
    unittest.main()
