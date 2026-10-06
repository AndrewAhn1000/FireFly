from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import torch
from worker import Worker, features, split_sequences
from formulas import Missing


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.schema = {'version': 1, 'identity': 'obs-test', 'fields': [{'name': 'error', 'type': 'number'}]}
        self.actions = {'version': 1, 'identity': 'act-test', 'buttons': [{'id': 'left', 'vk': 37}, {'id': 'right', 'vk': 39}]}
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            for sequence in range(3):
                rid = str(sequence)
                metadata = {'observationSchema': self.schema, 'actionSchema': self.actions}
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps(metadata)))
                for i in range(241):
                    value = ((i*53+sequence*17) % 241)/120-1
                    sample = {'valid': True, 'timestamp': 1000 + i * 66, 'observationSchema': 'obs-test', 'actionSchema': 'act-test',
                              'observations': [{'name': 'error', 'type': 'number', 'valid': True, 'value': value}],
                              'actions': {'valid': True, 'buttons': {'left': value < -.08, 'right': value > .08}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps(sample)))
        self.worker = Worker(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_train_checkpoint_and_actual_inference(self):
        metrics = []
        self.worker.emit = metrics.append
        model = self.worker.train({'recordingIds': ['0', '1', '2'], 'epochs': 70, 'history': 0})
        self.assertEqual(model['config']['split'], 'temporal_with_gap')
        self.assertEqual(len(metrics), 70)
        self.assertLess(model['bestValidationLoss'], .12)
        self.assertEqual(model['version'], 3)
        self.assertEqual(model['stepMs'], 66)
        self.assertEqual([b['button'] for b in model['buttons']], ['left', 'right'])
        self.assertGreater(min(b['f1'] for b in model['buttons']), .9)
        self.assertTrue((self.root/'models'/model['id']/'checkpoint.pt').exists())
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-test', 'actionSchema': 'act-test'})
        for value, expected in [(-.7, [True, False]), (.7, [False, True]), (0, [False, False])]:
            result = self.worker.predict({'observationSchema': 'obs-test', 'observations': [{'name': 'error', 'type': 'number', 'valid': True, 'value': value}]})
            self.assertEqual(result['buttons'], expected)
            self.assertEqual(len(result['probabilities']), 2)
        with self.assertRaisesRegex(ValueError, 'schema mismatch'):
            self.worker.load({'modelId': model['id'], 'observationSchema': 'wrong', 'actionSchema': 'act-test'})

    def test_walks_toward_the_ladder_from_shapes_relative_to_the_player(self):
        # The player and a ladder move about the screen; the button held is the way to the ladder
        schema = {'version': 1, 'identity': 'obs-shapes', 'fields': [
            {'name': 'ladders', 'type': 'shapes'}, {'name': 'player', 'type': 'vector', 'size': 2}]}
        def observations(player, ladder):
            return [{'name': 'ladders', 'type': 'shapes', 'valid': True, 'value': [{'x1': ladder, 'y1': 0, 'x2': ladder, 'y2': 600}]},
                    {'name': 'player', 'type': 'vector', 'valid': True, 'value': [player, 300]}]
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            for sequence in range(3):
                rid = f's{sequence}'
                metadata = {'observationSchema': schema, 'actionSchema': self.actions}
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (rid, 'complete', json.dumps(metadata)))
                for i in range(300):
                    player, ladder = (i * 37 + sequence * 11) % 700 + 50, (i * 91 + sequence * 29) % 700 + 50
                    sample = {'valid': True, 'timestamp': 1000 + i * 66, 'observationSchema': 'obs-shapes', 'actionSchema': 'act-test',
                              'observations': observations(player, ladder),
                              'actions': {'valid': True, 'buttons': {'left': ladder < player - 20, 'right': ladder > player + 20}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (rid, i, json.dumps(sample)))
        model = self.worker.train({'recordingIds': ['s0', 's1', 's2'], 'epochs': 120, 'anchor': 'player', 'history': 1,
                                   'surface': 'off', 'nearPx': 300})
        shapes = model['features']['derived'][0]
        self.assertEqual((shapes['kind'], shapes['a'], shapes['b'], shapes['surface'], shapes['nearPx']), ('shapes', 'player', 'ladders', 'off', 300))
        self.assertEqual(model['inputSize'], 2 * (10 + 2))
        self.assertGreater(min(b['f1'] for b in model['buttons']), .9)
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-shapes', 'actionSchema': 'act-test'})
        for t, (player, ladder, expected) in enumerate([(400, 100, [True, False]), (400, 700, [False, True]), (100, 600, [False, True])]):
            # With history 1 it needs what was there a step before, and without it, it can't say
            predict = {'observationSchema': 'obs-shapes', 'observations': observations(player, ladder)}
            with self.assertRaisesRegex(ValueError, 'earlier'):
                self.worker.predict({**predict, 'timestamp': 5000 + t * 5000})
            result = self.worker.predict({**predict, 'timestamp': 5000 + t * 5000 + 66})
            self.assertEqual(result['buttons'], expected)

    def test_exports_a_dataset_with_every_column_named(self):
        import csv
        import numpy as np
        out = self.root / 'exports'
        for name in ('set.csv', 'set.npz'):
            result = self.worker.export({'recordingIds': ['0', '1'], 'history': 1, 'path': str(out / name)})
            # Each recording's first row has nothing a step before it for its history
            self.assertEqual((result['samples'], result['features'], result['buttons'], result['stepMs']), (480, 2, 2, 66))
            self.assertEqual(result['skippedReasons'], {'Not all of the 1 step before it are usable (history)': 2})
            manifest = json.loads(Path(result['manifest']).read_text(encoding='utf8'))
            self.assertEqual(manifest['features'], ['error', 'error@-1'])
            self.assertEqual(manifest['buttons'], ['left', 'right'])
            self.assertEqual(manifest['recordings'], ['0', '1'])
            self.assertEqual(manifest['options']['history'], 1)
        with open(out / 'set.csv', encoding='utf-8') as file:
            rows = list(csv.reader(file))
        self.assertEqual(rows[0], ['recording', 'timestamp', 'error', 'error@-1', 'button.left', 'button.right'])
        self.assertEqual(len(rows), 481)
        self.assertEqual([float(rows[1][1]), float(rows[2][1])], [1066.0, 1132.0])
        self.assertEqual(rows[1][0], '0')
        first = float(rows[1][2])
        self.assertEqual([rows[1][4], rows[1][5]], [str(int(first < -.08)), str(int(first > .08))])
        data = np.load(out / 'set.npz')
        self.assertEqual(data['X'].shape, (480, 2))
        self.assertEqual(data['y'].shape, (480, 2))
        self.assertEqual(list(data['features']), ['error', 'error@-1'])
        self.assertAlmostEqual(float(data['X'][0][0]), first, places=5)
        with self.assertRaisesRegex(ValueError, '.csv or .npz'):
            self.worker.export({'recordingIds': ['0'], 'path': str(out / 'set.txt')})

    def test_formulas_on_a_fixed_time_step(self):
        # Samples near every 50 ms with a few ms of jitter, the player lost now and then, and a stretch
        # where the game wasn't in front
        schema = {'version': 1, 'identity': 'obs-f', 'fields': [{'name': 'player', 'type': 'vector'}, {'name': 'hp', 'type': 'number'}]}
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute('INSERT INTO recordings VALUES(?,?,?)', ('f', 'complete', json.dumps({'observationSchema': schema, 'actionSchema': self.actions})))
            for i in range(100):
                lost, away = i % 10 == 5, 80 <= i < 90
                sample = {'valid': not lost and not away, 'timestamp': 1000 + i * 50 + (3 if i % 3 else -4), 'observationSchema': 'obs-f', 'actionSchema': 'act-test',
                          'observations': [{'name': 'player', 'type': 'vector', 'valid': not lost, 'value': None if lost else [i * 2, 300]},
                                           {'name': 'hp', 'type': 'number', 'valid': True, 'value': 50}],
                          'actions': {'valid': not away, 'reason': 'Not in front' if away else '',
                                      'buttons': {'left': False, 'right': i % 2 == 0}}}
                db.execute('INSERT INTO samples VALUES(?,?,?)', ('f', i, json.dumps(sample)))
        formulas = [{'name': 'speed', 'source': '(player.x - player.x[-1]) / 0.05'}, {'name': 'hurt', 'source': 'hp < 60'},
                    {'name': 'where', 'source': 'player ?? vec(-1, -1)'}]
        data = self.worker.dataset({'recordingIds': ['f'], 'history': 0, 'formulas': formulas, 'columns': ['speed', 'hurt', 'where.x']})
        self.assertEqual(data['options']['stepMs'], 50)
        rows = data['recordings'][0][1]
        # 100 grid points: 10 not in front; of the other 90, 9 with the player lost and 9 just after one
        # (speed needs where it was a step before), and the first, with nothing before it
        self.assertEqual(data['skippedReasons'], {'Not in front': 10, 'player isn’t found': 9,
                                                  'player isn’t found 1 step earlier': 9, 'there’s no sample 1 step earlier': 1})
        self.assertEqual(len(rows), 71)
        self.assertTrue(all(x[:2] == [40.0, 1.0] for _, x, _ in rows))
        self.assertEqual([t for t, _, _ in rows[:2]], [996.0 + 50, 996.0 + 100])  # grid time from the first sample
        # The columns op: each formula's type and columns, a preview, and the step
        result = self.worker.columns({'recordingIds': ['f'], 'formulas': formulas + [{'name': 'bad', 'source': 'player + hp'}]})
        byname = {f['name']: f for f in result['formulas']}
        self.assertEqual((byname['speed']['type'], byname['speed']['columns']), ('number', ['speed']))
        self.assertEqual(byname['where']['columns'], ['where.x', 'where.y'])
        self.assertEqual(byname['speed']['preview']['value'], [40.0])
        self.assertEqual(byname['where']['preview']['missing'], 0)
        self.assertGreater(byname['speed']['preview']['missing'], 0)
        self.assertRegex(byname['bad']['error'], 'can’t combine')
        self.assertIsNone(result['error'])
        self.assertEqual((result['stepMs'], result['suggestedStepMs']), (50, 50))
        self.assertIn('speed', [g['observation'] for g in result['groups'] if g['formula']])
        # A policy trained with them plays the same way: speed needs what was there a step before
        model = self.worker.train({'recordingIds': ['f'], 'history': 0, 'formulas': formulas, 'columns': ['speed'], 'epochs': 2})
        self.assertEqual((model['version'], model['stepMs'], model['config']['formulas'][0]['name']), (3, 50, 'speed'))
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-f', 'actionSchema': 'act-test'})
        def predict(t, x):
            return self.worker.predict({'observationSchema': 'obs-f', 'timestamp': t, 'observations': [
                {'name': 'player', 'type': 'vector', 'valid': True, 'value': [x, 0]}, {'name': 'hp', 'type': 'number', 'valid': True, 'value': 1}]})
        with self.assertRaisesRegex(ValueError, '1 step earlier'):
            predict(10000, 0)
        with self.assertRaisesRegex(ValueError, '1 step earlier'):
            predict(10020, 1)   # too soon: still nothing a step (50 +- 25 ms) before it
        self.assertEqual(len(predict(10052, 2)['buttons']), 2)

    def test_a_policy_sees_a_grid_of_the_screen(self):
        # Where a platform is on the screen says which way to go: left of centre, go left
        schema = {'version': 1, 'identity': 'obs-grid', 'fields': [{'name': 'hp', 'type': 'number'}, {'name': 'platforms', 'type': 'shapes'}]}
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            for r in range(3):
                db.execute('INSERT INTO recordings VALUES(?,?,?)', (f'g{r}', 'complete', json.dumps({'observationSchema': schema, 'actionSchema': self.actions})))
                for i in range(300):
                    x = (i * 37 + r * 13) % 560 + 20
                    sample = {'valid': True, 'timestamp': 1000 + i * 50, 'observationSchema': 'obs-grid', 'actionSchema': 'act-test',
                              'frame': {'w': 640, 'h': 360},
                              'observations': [{'name': 'hp', 'type': 'number', 'valid': True, 'value': 1},
                                               {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': [{'x1': x, 'y1': 200, 'x2': x + 40, 'y2': 200}]}],
                              'actions': {'valid': True, 'buttons': {'left': x < 300, 'right': x >= 340}}}
                    db.execute('INSERT INTO samples VALUES(?,?,?)', (f'g{r}', i, json.dumps(sample)))
        grid = {'name': 'layout', 'shapes': 'platforms', 'cols': 16, 'rows': 9, 'width': 1280, 'height': 720}
        preview = self.worker.preview({'recordingIds': ['g0'], 'history': 2, 'grids': [grid]})
        self.assertEqual(preview['inputs'], 1 + 144 + 2 * 1)       # earlier steps leave the grid out
        model = self.worker.train({'recordingIds': ['g0', 'g1', 'g2'], 'epochs': 60, 'history': 2, 'grids': [grid]})
        self.assertEqual((model['inputSize'], model['hidden']), (147, 64))
        self.assertGreater(min(b['f1'] for b in model['buttons']), .9)
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-grid', 'actionSchema': 'act-test'})
        def predict(t, x):
            return self.worker.predict({'observationSchema': 'obs-grid', 'timestamp': t, 'frame': {'w': 640, 'h': 360}, 'observations': [
                {'name': 'hp', 'type': 'number', 'valid': True, 'value': 1},
                {'name': 'platforms', 'type': 'shapes', 'valid': True, 'value': [{'x1': x, 'y1': 200, 'x2': x + 40, 'y2': 200}]}]})
        for t in (5000, 5050):
            with self.assertRaises(ValueError):
                predict(t, 60)
        self.assertEqual(predict(5100, 60)['buttons'], [True, False])
        result = self.worker.columns({'recordingIds': ['g0'], 'grids': [grid, {**grid, 'name': 'bad', 'shapes': 'hp'}]})
        good, bad = result['grids']
        self.assertEqual((good['cols'], good['rows'], len(good['values']), good['screen']), (16, 9, 144, [640, 360]))
        self.assertGreater(sum(good['values']), 0)
        # Beside formulas over wired inputs, as a Policy Graph has: the grid's picture is made all the same
        # (they used to reach it without their inputs, and every one failed: "There's no ... called p")
        wired = [{'name': 'floor below', 'source': 'below(plats, p).y ?? 500', 'inputs': {'plats': 'platforms', 'p': 'spot'}},
                 {'name': 'spot', 'source': 'vec(300, 100)'}]
        result = self.worker.columns({'recordingIds': ['g0'], 'formulas': wired, 'grids': [grid]})
        self.assertEqual(([f['error'] for f in result['formulas']], result['grids'][0]['error'], result['error']), ([None, None], None, None))
        self.assertGreater(sum(result['grids'][0]['values']), 0)
        centred = self.worker.columns({'recordingIds': ['g0'], 'formulas': wired, 'grids': [{**grid, 'name': 'near', 'center': 'spot', 'cell': 40}]})
        self.assertIsNone(centred['grids'][0]['error'])
        self.assertRegex(bad['error'], 'shapes observation')
        # Many inputs get a wider network
        wide = self.worker.train({'recordingIds': ['g0', 'g1', 'g2'], 'epochs': 2, 'history': 0, 'grids': [{**grid, 'cols': 32, 'rows': 18}]})
        self.assertEqual((wide['inputSize'], wide['hidden']), (1 + 576, 128))

    def test_a_policy_learns_the_buttons_chosen_and_says_what_its_dataset_holds(self):
        preview = self.worker.preview({'recordingIds': ['0', '1'], 'history': 1, 'buttons': ['right']})
        self.assertEqual((preview['samples'], preview['values'], preview['inputs']), (480, ['error'], 2))
        self.assertEqual([b['id'] for b in preview['buttons']], ['right'])
        self.assertTrue(0.3 < preview['buttons'][0]['pressed'] < 0.7)
        with self.assertRaisesRegex(ValueError, 'recorded buttons'):
            self.worker.preview({'recordingIds': ['0'], 'buttons': ['jump']})
        model = self.worker.train({'recordingIds': ['0', '1', '2'], 'epochs': 40, 'history': 0, 'buttons': ['right'],
                                   'policy': {'id': 'node-1', 'name': 'Go right'}})
        self.assertEqual((model['outputSize'], model['outputs'], model['policy']), (1, [{'id': 'right', 'vk': 39}], {'id': 'node-1', 'name': 'Go right'}))
        self.assertEqual([b['button'] for b in model['buttons']], ['right'])
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-test', 'actionSchema': 'act-test'})
        result = self.worker.predict({'observationSchema': 'obs-test', 'observations': [{'name': 'error', 'type': 'number', 'valid': True, 'value': .7}]})
        self.assertEqual(result['buttons'], [True])
        out = self.root / 'right.csv'
        self.worker.export({'recordingIds': ['0'], 'history': 0, 'buttons': ['right'], 'path': str(out)})
        self.assertEqual(out.read_text(encoding='utf8').splitlines()[0], 'recording,timestamp,error,button.right')
        # Deleting the version: it's gone from the list and can't be played, and it's remembered with its policy
        self.worker.delete_model({'modelId': model['id']})
        self.assertNotIn(model['id'], [m['id'] for m in self.worker.list_models()])
        self.assertEqual(self.worker.deleted_models(), {model['id']: 'node-1'})
        with self.assertRaisesRegex(ValueError, 'Load a policy first'):
            self.worker.predict({'observationSchema': 'obs-test', 'observations': []})
        with self.assertRaisesRegex(ValueError, 'no longer exists'):
            self.worker.delete_model({'modelId': model['id']})

    def test_formulas_over_states_not_recorded_yet_are_checked(self):
        # No recording: the live States alone type-check a formula (no preview)
        live = [{'name': 'player', 'type': 'vector'}, {'name': 'hp', 'type': 'number'}]
        result = self.worker.columns({'fields': live, 'formulas': [{'name': 'up', 'source': 'p.y - 1', 'inputs': {'p': 'player'}},
                                                                   {'name': 'bad', 'source': 'p + h', 'inputs': {'p': 'player', 'h': 'hp'}}]})
        byname = {f['name']: f for f in result['formulas']}
        self.assertEqual((byname['up']['error'], byname['up']['type'], byname['up']['preview']['rows']), (None, 'number', 0))
        self.assertIsNotNone(byname['bad']['error'])
        # With a recording that doesn't hold one of them: checked all the same, and missing in the preview
        result = self.worker.columns({'recordingIds': ['0'], 'fields': live,
                                      'formulas': [{'name': 'both', 'source': 'e + h', 'inputs': {'e': 'error', 'h': 'hp'}}]})
        both = result['formulas'][0]
        self.assertEqual((both['error'], both['preview']['value']), (None, None))
        self.assertEqual(both['preview']['missing'], both['preview']['rows'])
        with self.assertRaisesRegex(ValueError, 'Choose a recording, or add States'):
            self.worker.columns({})

    def test_formula_inputs_stand_for_what_they_are_wired_to(self):
        formulas = [{'name': 'double', 'source': 'a * 2', 'inputs': {'a': 'error'}},
                    {'name': 'more', 'source': 'x + 1', 'inputs': {'x': 'double'}}]
        result = self.worker.columns({'recordingIds': ['0'], 'formulas': formulas + [{'name': 'loose', 'source': 'a', 'inputs': {'a': 'nope'}}]})
        byname = {f['name']: f for f in result['formulas']}
        self.assertEqual((byname['double']['error'], byname['more']['type']), (None, 'number'))
        self.assertRegex(byname['loose']['error'], 'Input “a” is wired to “nope”')
        data = self.worker.dataset({'recordingIds': ['0'], 'history': 0, 'formulas': formulas, 'columns': ['error', 'more']})
        for _, x, _ in data['recordings'][0][1][:5]:
            self.assertAlmostEqual(x[1], x[0] * 2 + 1)
        self.assertEqual(data['options']['formulas'][0]['inputs'], {'a': 'error'})

    def test_play_slower_than_the_step_still_finds_its_earlier_steps(self):
        # Trained on samples 66 ms apart; played with detection only every 90 ms, there's no sample within
        # half a step of two steps back (132 ms; the nearest is 180), and every frame used to fail
        model = self.worker.train({'recordingIds': ['0', '1', '2'], 'epochs': 3, 'history': 2})
        self.assertAlmostEqual(model['stepMs'], 66, delta=1)
        self.worker.load({'modelId': model['id'], 'observationSchema': 'obs-test', 'actionSchema': 'act-test'})
        def predict(t):
            return self.worker.predict({'observationSchema': 'obs-test', 'timestamp': t,
                                        'observations': [{'name': 'error', 'type': 'number', 'valid': True, 'value': .5}]})
        for t in (1000, 1090):
            with self.assertRaisesRegex(Missing, 'earlier'):
                predict(t)  # not yet two samples before it
        for t in (1180, 1270, 1360):
            self.assertEqual(len(predict(t)['buttons']), 2)

    def test_a_recording_with_no_samples_is_skipped(self):
        # A correction the player let go of at once has none
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute('INSERT INTO recordings VALUES(?,?,?)', ('empty', 'complete', json.dumps({'observationSchema': self.schema, 'actionSchema': self.actions})))
        data = self.worker.dataset({'recordingIds': ['0', 'empty'], 'history': 0})
        self.assertEqual((data['skipped'], [rid for rid, _ in data['recordings']]), (['empty'], ['0']))

    def test_validation_and_temporal_gap(self):
        training, validation, split = split_sequences([list(range(100))])
        self.assertEqual(split, 'temporal_with_gap')
        self.assertGreater(validation[0]-training[-1], 5)
        # Every recording's last quarter, so validation holds what each of them did
        training, validation, _ = split_sequences([list(range(100)), list(range(1000, 1040)), list(range(2000, 2012))])
        self.assertEqual((validation[0], validation[25], len(validation)), (75, 1030, 35))
        self.assertIn(2011, training)  # too short to split
        for value in [float('nan'), float('inf'), 'bad']:
            with self.assertRaises(ValueError):
                features([{'name': 'error', 'type': 'number', 'valid': True, 'value': value}], self.schema)
        with self.assertRaisesRegex(ValueError, 'Nothing here'):
            features([{'name': 'image', 'type': 'image', 'valid': True, 'value': {}}], {'fields': [{'name': 'image', 'type': 'image'}]})
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            db.execute("UPDATE recordings SET status='interrupted' WHERE id='0'")
        with self.assertRaisesRegex(ValueError, 'complete'):
            self.worker.train({'recordingIds': ['0']})

    def test_recording_schema_mismatch(self):
        with closing(sqlite3.connect(self.root/'catalog.sqlite')) as db, db:
            metadata = {'observationSchema': {**self.schema, 'identity': 'other'}, 'actionSchema': self.actions}
            db.execute('UPDATE recordings SET metadata=? WHERE id=?', (json.dumps(metadata), '1'))
        with self.assertRaisesRegex(ValueError, 'Incompatible'):
            self.worker.train({'recordingIds': ['0', '1']})


if __name__ == '__main__':
    unittest.main()

