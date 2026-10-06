import math
import unittest

from formulas import FormulaSet, Missing, columns_of, parse
from observations import Featurizer

FIELDS = [{'name': 'player', 'type': 'vector'}, {'name': 'enemy', 'type': 'vector'}, {'name': 'hp', 'type': 'number'},
          {'name': 'hp max', 'type': 'number'}, {'name': 'grounded', 'type': 'boolean'}, {'name': 'ladders', 'type': 'shapes'},
          {'name': 'platforms', 'type': 'shapes'}, {'name': 'label', 'type': 'text'}, {'name': 'view', 'type': 'image'}]


def frame(player=(100, 100), enemy=(130, 60), hp=30, found=True):
    values = {'player': list(player) if found else None, 'enemy': list(enemy), 'hp': hp, 'hp max': 100, 'grounded': True,
              'ladders': [{'x1': 60, 'y1': 0, 'x2': 60, 'y2': 200}, {'x1': 310, 'y1': 0, 'x2': 310, 'y2': 200}],
              'platforms': [{'x1': 40, 'y1': 130, 'x2': 260, 'y2': 130}], 'label': 'x', 'view': {}}
    return {name: {'name': name, 'valid': value is not None, 'value': value} for name, value in values.items()}


def run(source, frames=None, **names):
    formulas = FormulaSet([{'name': 'f', 'source': source}, *({'name': k, 'source': v} for k, v in names.items())], FIELDS)
    entry = formulas.entries['f']
    if entry['error']:
        raise AssertionError(entry['error'])
    return formulas.evaluate('f', frames or [frame()])


def error(source, **names):
    formulas = FormulaSet([{'name': 'f', 'source': source}, *({'name': k, 'source': v} for k, v in names.items())], FIELDS)
    return formulas.entries['f']['error']


class FormulaTests(unittest.TestCase):
    def test_arithmetic_and_precedence(self):
        self.assertEqual(run('1 + 2 * 3 - 4 / 2'), 5.0)
        self.assertEqual(run('(1 + 2) * 3'), 9.0)
        self.assertEqual(run('-2 * -3'), 6.0)
        self.assertEqual(run('7 % 4'), 3.0)
        self.assertEqual(run('hp / `hp max`'), .3)
        self.assertIs(run('hp < 50 and not grounded or hp > 20'), True)
        self.assertIs(run('hp == 30 && !(hp != 30)'), True)
        self.assertEqual(run('true + true'), 2.0)

    def test_vectors(self):
        self.assertEqual(run('enemy - player'), (30.0, -40.0))
        self.assertEqual(run('distance(player, enemy)'), 50.0)
        self.assertEqual(run('len(enemy - player) == distance(player, enemy)'), True)
        self.assertEqual(run('(enemy - player) * 2'), (60.0, -80.0))
        self.assertEqual(run('2 * player / 4'), (50.0, 50.0))
        self.assertEqual(run('(enemy - player).y'), -40.0)
        self.assertEqual(run('normalize(vec(3, 4))'), (.6, .8))
        self.assertEqual(run('dot(vec(1, 2), vec(3, 4))'), 11.0)
        self.assertAlmostEqual(run('angle(vec(0, 1))'), math.pi / 2)
        self.assertEqual(run('-player'), (-100.0, -100.0))

    def test_functions(self):
        self.assertEqual(run('abs(-3) + sign(-9) + sqrt(16) + floor(1.7) + ceil(1.2) + round(2.4)'), 11.0)
        self.assertEqual(run('min(hp, 10, 50)'), 10.0)
        self.assertEqual(run('max(hp, 10, 50)'), 50.0)
        self.assertEqual(run('clamp(hp, 0, 20)'), 20.0)
        self.assertEqual(run('pow(2, 10)'), 1024.0)
        self.assertEqual(run('hypot(3, 4)'), 5.0)
        self.assertEqual(run('if(hp < 50, 1, 2)'), 1.0)
        self.assertEqual(run('if(grounded, player, enemy)'), (100.0, 100.0))

    def test_shapes(self):
        self.assertEqual(run('nearest(ladders, player)'), (-40.0, 0.0))
        self.assertEqual(run('nearest_right(ladders, player)'), (210.0, 0.0))
        self.assertEqual(run('below(platforms, player).y'), 30.0)
        self.assertEqual(run('below_ends(platforms, player)'), (-60.0, 160.0))
        self.assertEqual(run('count_within(ladders, player, 100)'), 1.0)
        self.assertEqual(run('count(ladders)'), 2.0)
        self.assertIs(run('count(platforms) >= 1'), True)
        self.assertIn('count', error('count(hp)'))
        with self.assertRaisesRegex(Missing, 'no shape above'):
            run('above(platforms, player)')
        self.assertEqual(run('found(above(platforms, player))'), False)
        self.assertEqual(run('above(platforms, player).y ?? -999'), -999.0)

    def test_names_with_spaces_and_other_formulas(self):
        self.assertEqual(run('`hp max` - hp'), 70.0)
        self.assertEqual(run('ratio * 100', ratio='hp / `hp max`'), 30.0)
        self.assertEqual(run('gap.x', gap='enemy - player'), 30.0)

    def test_missing_skips_unless_it_falls_back(self):
        lost = [frame(found=False)]
        with self.assertRaisesRegex(Missing, 'player isn’t found'):
            run('distance(player, enemy)', lost)
        self.assertEqual(run('distance(player, enemy) ?? 0', lost), 0.0)
        self.assertEqual(run('found(player)', lost), False)
        self.assertEqual(run('if(found(player), player.x, -1)', lost), -1.0)
        with self.assertRaisesRegex(Missing, 'player isn’t found'):
            run('d + 1', lost, d='distance(player, enemy)')  # through another formula too
        self.assertEqual(run('found(player) or hp > 10', lost), True)
        with self.assertRaisesRegex(Missing, 'division by zero'):
            run('hp / (hp - 30)')
        with self.assertRaises(Missing):
            run('sqrt(-1)')
        with self.assertRaises(Missing):
            run('log(0)')
        with self.assertRaises(Missing):
            run('normalize(vec(0, 0))')

    def test_steps_back(self):
        now, before, earlier = frame(player=(110, 100)), frame(player=(100, 100)), frame(player=(95, 100))
        self.assertEqual(run('player.x - player.x[-1]', [now, before]), 10.0)
        self.assertEqual(run('player - player[-2]', [now, before, earlier]), (15.0, 0.0))
        self.assertEqual(run('(player - player[-1]).x', [now, before]), 10.0)
        with self.assertRaisesRegex(Missing, '2 steps earlier'):
            run('player.x - player.x[-2]', [now, before])
        with self.assertRaisesRegex(Missing, '1 step earlier'):
            run('player.x[-1]', [now, None])
        # A formula looked back on is worked out at that step
        self.assertEqual(run('speed - speed[-1]', [now, before, earlier], speed='player.x - player.x[-1]'), 5.0)
        formulas = FormulaSet([{'name': 'a', 'source': 'player.x[-2]'}, {'name': 'b', 'source': 'a[-3] + hp'}], FIELDS)
        self.assertEqual((formulas.entries['a']['depth'], formulas.entries['b']['depth'], formulas.depth), (2, 5, 5))

    def test_types_are_checked_before_anything_runs(self):
        self.assertRegex(error('player + hp'), 'can’t combine vector and number')
        self.assertRegex(error('hp.x'), 'only a vector has')
        self.assertRegex(error('ladders'), 'has to give a number, true/false or a vector; this gives shapes')
        self.assertRegex(error('label'), 'text, which formulas can’t use')
        self.assertRegex(error('view'), 'image')
        self.assertRegex(error('nope + 1'), 'no observation or formula called “nope”')
        self.assertRegex(error('distance(player)'), r'Use it as distance\(a, b\) \(vector, vector\), not \(vector\)')
        self.assertRegex(error('nearest(player, ladders)'), 'shapes, vector')
        self.assertRegex(error('frob(1)'), 'no function called')
        self.assertRegex(error('if(hp, player, hp)'), 'same type either way')
        self.assertRegex(error('player ?? 0'), 'same type on both sides')
        self.assertRegex(error('player < enemy'), 'compares numbers')
        self.assertRegex(error('1 < hp < 3'), 'two values at a time')
        self.assertRegex(error('bad * 2', bad='hp +'), 'uses “bad”, which has an error')

    def test_reading_errors(self):
        self.assertRegex(error(''), 'Write a formula')
        self.assertRegex(error('1 +'), 'ends too soon')
        self.assertRegex(error('(1 + 2'), 'expected \\)')
        self.assertRegex(error('hp $ 2'), 'At 4: unexpected')
        self.assertRegex(error('hp[1]'), r'a step back, such as \[-1\]')
        self.assertRegex(error('hp[-31]'), r'\[-30\]')
        self.assertRegex(error('`hp max'), 'isn’t closed')
        self.assertRegex(error('hp hp'), 'unexpected')
        self.assertEqual(parse('a.x[-1]'), ('hist', ('member', ('ref', 'a', 0), 'x', 2), 1))

    def test_cycles_and_names(self):
        formulas = FormulaSet([{'name': 'a', 'source': 'b + 1'}, {'name': 'b', 'source': 'a * 2'}, {'name': 'c', 'source': 'c'},
                               {'name': 'hp', 'source': '1'}, {'name': 'd', 'source': '1'}, {'name': 'd', 'source': '2'},
                               {'name': '', 'source': '1'}, {'name': 'ok', 'source': 'hp * 2'}], FIELDS)
        results = {r['name']: r for r in formulas.results() if r['name'] != 'd'}
        self.assertTrue(results['a']['error'] and results['b']['error'])
        self.assertRegex(results['c']['error'], 'uses itself')
        self.assertRegex(results['hp']['error'], 'An observation is already called')
        self.assertRegex([r for r in formulas.results() if r['name'] == 'd'][1]['error'], 'already called')
        self.assertRegex(results['']['error'], 'Name each formula')
        self.assertEqual((results['ok']['type'], results['ok']['columns'], results['ok']['error']), ('number', ['ok'], None))

    def test_result_types_fit_the_dataset(self):
        formulas = FormulaSet([{'name': 'n', 'source': 'hp'}, {'name': 'b', 'source': 'hp > 3'}, {'name': 'v', 'source': 'player'}], FIELDS)
        self.assertEqual([r['columns'] for r in formulas.results()], [['n'], ['b'], ['v.x', 'v.y']])
        self.assertEqual(columns_of(True, 'boolean'), [1.0])
        self.assertEqual(columns_of((1, 2), 'vector'), [1.0, 2.0])
        self.assertEqual(columns_of(True, 'number'), [1.0])  # if(c, true, 3) is a number


class FeaturizerFormulaTests(unittest.TestCase):
    schema = {'fields': FIELDS}

    def test_formulas_are_columns_and_skip_what_is_missing(self):
        f = Featurizer(self.schema, formulas=[{'name': 'to enemy', 'source': 'enemy - player'},
                                              {'name': 'low', 'source': 'hp < 0.5 * `hp max`'},
                                              {'name': 'moved', 'source': 'player.x - player.x[-1]'}],
                       columns=['hp', 'to enemy.x', 'to enemy.y', 'low', 'moved'])
        self.assertEqual(f.names(), ['hp', 'to enemy.x', 'to enemy.y', 'low', 'moved'])
        self.assertEqual(f.depth, 1)
        self.assertEqual(f(frame(player=(110, 100)), [frame()]), [30.0, 20.0, -40.0, 1.0, 10.0])
        with self.assertRaisesRegex(Missing, 'player isn’t found'):
            f(frame(found=False), [frame()])
        with self.assertRaisesRegex(Missing, '1 step earlier'):
            f(frame(), [None])
        groups = {g['observation']: g for g in f.groups()}
        self.assertEqual((groups['to enemy']['formula'], groups['to enemy']['type']), (True, 'vector'))
        self.assertEqual(f.describe()['formulas'][1], {'name': 'low', 'source': 'hp < 0.5 * `hp max`'})
        # A formula left out isn't worked out, so what it needs doesn't cost the sample
        only_hp = Featurizer(self.schema, formulas=[{'name': 'd', 'source': 'distance(player, enemy)'}], columns=['hp'])
        self.assertEqual(only_hp(frame(found=False)), [30.0])

    def test_a_broken_formula_or_a_clash_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Fix the formulas first: bad:'):
            Featurizer(self.schema, formulas=[{'name': 'bad', 'source': 'player +'}])
        with self.assertRaisesRegex(ValueError, 'Two values are called player.x'):
            Featurizer(self.schema, formulas=[{'name': 'player.x', 'source': '1'}])


if __name__ == '__main__':
    unittest.main()
