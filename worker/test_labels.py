import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from worker import Worker

SCHEMA = {'identity': 'obs', 'fields': [{'name': 'x', 'type': 'number'}]}
ACTIONS = {'identity': 'act', 'buttons': [{'id': 'space', 'vk': 32}, {'id': 'right', 'vk': 39}]}


class PressedSinceTests(unittest.TestCase):
    """A row's buttons are those held at its sample and any pressed since the step before, from the recording's raw key
    events: a tap between two samples, held at neither, still counts."""

    def catalog(self, inputs):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        with closing(sqlite3.connect(root / 'catalog.sqlite')) as db, db:
            db.execute('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT,metadata TEXT)')
            db.execute('CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT)')
            if inputs is not None:
                db.execute('CREATE TABLE inputs(recording TEXT,seq INTEGER,data TEXT)')
            db.execute('INSERT INTO recordings VALUES(?,?,?)', ('r', 'complete', json.dumps({'observationSchema': SCHEMA, 'actionSchema': ACTIONS})))
            for n in range(40):  # every 50 ms, nothing held at any of them
                held = 'right' if 10 <= n < 20 else None
                db.execute('INSERT INTO samples VALUES(?,?,?)', ('r', n, json.dumps({
                    'valid': True, 'timestamp': 1000 + 50 * n, 'observationSchema': 'obs', 'actionSchema': 'act',
                    'observations': [{'name': 'x', 'valid': True, 'value': n}],
                    'actions': {'valid': True, 'buttons': {'space': False, 'right': held == 'right'}}})))
            for k, e in enumerate(inputs or []):
                db.execute('INSERT INTO inputs VALUES(?,?,?)', ('r', k, json.dumps(e)))
        return root

    def tearDown(self):
        self.temp.cleanup()

    def rows(self, root):
        data = Worker(root).dataset({'recordingIds': ['r'], 'columns': ['x'], 'buttons': ['space', 'right'], 'stepMs': 50, 'history': 0})
        return {round(r[0]): r[2] for _, seq in data['recordings'] for r in seq}

    def tap(self, t0, t1, key='space', injected=False):
        return [{'kind': 'button', 'id': key, 'down': True, 'injected': injected, 'timestamp': t0},
                {'kind': 'button', 'id': key, 'down': False, 'injected': injected, 'timestamp': t1}]

    def test_a_tap_between_two_samples_counts_at_the_next(self):
        rows = self.rows(self.catalog(self.tap(2210, 2230)))     # between the samples at 2200 and 2250
        self.assertEqual(rows[2250], [1.0, 0.0])
        self.assertEqual((rows[2200], rows[2300]), ([0.0, 0.0], [0.0, 0.0]))  # the step before and after: not
        self.assertEqual(rows[1500], [0.0, 1.0])                  # held keys as they were

    def test_without_key_events_or_from_another_program_it_is_the_samples(self):
        self.assertEqual(self.rows(self.catalog(None))[2250], [0.0, 0.0])
        self.tearDown()
        self.assertEqual(self.rows(self.catalog(self.tap(2210, 2230, injected=True)))[2250], [0.0, 0.0])


if __name__ == '__main__':
    unittest.main()
