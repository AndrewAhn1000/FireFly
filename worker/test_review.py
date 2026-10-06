import json
import tempfile
import unittest
from pathlib import Path
from worker import Worker
from review import Review, detect


def sample(seq, level, hp=.3):
    return {'seq': seq, 'timestamp': seq*100, 'valid': True,
            'observations': [{'name': 'level', 'value': level, 'valid': True}, {'name': 'hp', 'value': hp, 'valid': True}],
            'actions': {'buttons': {'use': seq == 2}}}


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.worker = Worker(Path(self.temp.name))
        with self.worker.db() as db:
            db.executescript('CREATE TABLE recordings(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE samples(recording TEXT,seq INTEGER,data TEXT);')
            db.execute("INSERT INTO recordings VALUES('demo','complete')")
            for i, level in enumerate([1, 1, 2, 2, 2, 3, 3, 3]):
                db.execute('INSERT INTO samples VALUES(?,?,?)', ('demo', i, json.dumps(sample(i, level))))
        self.review = Review(self.worker)
        self.rule = {'name': 'possible_level_up', 'observation': 'level', 'trigger': 'increase', 'cooldownMs': 0, 'reward': 5}

    def tearDown(self):
        self.temp.cleanup()

    def test_detection_history_confirmation_and_immutable_samples(self):
        with self.worker.db() as db:
            original = db.execute('SELECT * FROM samples').fetchall()
        request = {'recordingId': 'demo', 'rule': self.rule}
        self.assertEqual(self.review.run('events.test', request)['count'], 2)
        self.assertEqual(self.review.run('events.list', request), [])
        self.review.run('events.detect', request)
        events = self.review.run('events.list', request)
        self.assertEqual(events[0]['timestamp'], 200)
        self.assertEqual(events[0]['before'], 1)
        self.assertEqual(events[0]['after'], 2)
        self.assertEqual(events[0]['status'], 'pending')
        detail = self.review.run('events.get', {'eventId': events[0]['id']})
        self.assertTrue(detail['history'][2]['actions']['buttons']['use'])
        updated = self.review.run('events.update', {'eventId': events[0]['id'], 'revision': 1, 'status': 'confirmed', 'name': 'level_up'})
        self.assertEqual(updated['revision'], 2)
        self.review.run('events.detect', request)
        self.assertEqual(len(self.review.run('events.list', request)), 2)
        self.assertEqual(self.review.run('events.list', request)[0]['name'], 'level_up')
        with self.assertRaisesRegex(ValueError, 'refresh'):
            self.review.run('events.update', {'eventId': updated['id'], 'revision': 1, 'status': 'rejected'})
        self.review.run('events.update', {'eventId': updated['id'], 'revision': 2, 'status': 'rejected'})
        with self.worker.db() as db:
            self.assertEqual(original, db.execute('SELECT * FROM samples').fetchall())
            self.assertEqual(db.execute('SELECT count(*) FROM annotation_history').fetchone()[0], 2)

    def test_cooldown_dedup_invalid_gaps_and_previous_state(self):
        rows = [sample(i, v, hp) for i, (v, hp) in enumerate([(1,.3),(2,.9),(3,.9),(3,.9),(1,.2),(2,.9)])]
        self.assertEqual(len(detect(rows, {**self.rule, 'cooldownMs': 500})), 1)
        self.assertEqual(len(detect(rows, {**self.rule, 'trigger': 'above', 'threshold': 1})), 2)
        found = detect(rows, {**self.rule, 'previousBelow': {'observation': 'hp', 'value': .5}})
        self.assertEqual([event['seq'] for event in found], [1,5])
        rows[0]['valid'] = False
        self.assertEqual(detect(rows, self.rule)[0]['seq'], 2)

    def test_manual_and_automatic_annotations(self):
        self.review.run('events.detect', {'recordingId': 'demo', 'rule': {**self.rule, 'mode': 'automatic'}})
        self.assertTrue(all(e['status'] == 'confirmed' for e in self.review.run('events.list', {'recordingId': 'demo'})))
        result = self.review.run('events.add', {'recordingId': 'demo', 'timestamp': 235, 'name': 'manual'})
        self.assertEqual(result['seq'], 2)
        with self.assertRaisesRegex(ValueError, 'within'):
            self.review.run('events.add', {'recordingId': 'demo', 'timestamp': -1, 'name': 'manual'})
