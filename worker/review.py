"""Replayable observation-change rules and separate, revisioned event annotations."""
import hashlib
import json
import math
import time
import uuid


def validate_rule(rule):
    if not isinstance(rule.get('name'), str) or not 1 <= len(rule['name']) <= 80:
        raise ValueError('Event name must contain 1..80 characters')
    if rule.get('trigger') not in ('increase', 'decrease', 'rising', 'above', 'below'):
        raise ValueError('Unknown event trigger')
    if not isinstance(rule.get('observation'), str) or not rule['observation']:
        raise ValueError('Choose an observation')
    if rule.get('mode', 'review') not in ('review', 'automatic'):
        raise ValueError('Replay supports review or automatic confirmation')
    for key, default in [('threshold', 0), ('cooldownMs', 1000), ('reward', 0)]:
        value = rule.get(key, default)
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('Rule values must be finite numbers')
    if not 0 <= rule.get('cooldownMs', 1000) <= 86400000:
        raise ValueError('Cooldown must be 0..86400000 ms')
    condition = rule.get('previousBelow')
    if condition is not None and (not isinstance(condition.get('observation'), str) or
            type(condition.get('value')) not in (int, float) or not math.isfinite(condition['value'])):
        raise ValueError('Invalid previous-state condition')
    return rule


def scalar(row, name):
    if not row.get('valid', False):
        return None
    for observation in row['observations']:
        if observation['name'] == name and observation['valid']:
            value = observation['value']
            if type(value) in (bool, int, float) and math.isfinite(value):
                return value
    return None


def detect(rows, rule):
    validate_rule(rule)
    previous = None
    last = -math.inf
    was_true = False
    found = []
    for index, row in enumerate(rows):
        now = scalar(row, rule['observation'])
        before = scalar(previous, rule['observation']) if previous else None
        if now is None or before is None:
            previous = row
            was_true = False
            continue
        trigger = rule['trigger']
        condition = {'increase': now > before, 'decrease': now < before,
                     'rising': bool(now) and not bool(before),
                     'above': now > rule.get('threshold', 0),
                     'below': now < rule.get('threshold', 0)}[trigger]
        # Persistent threshold conditions emit once per rising edge.
        edge = condition and (trigger not in ('above', 'below') or not was_true)
        was_true = condition
        extra = rule.get('previousBelow')
        if extra:
            old = scalar(previous, extra['observation'])
            edge = edge and old is not None and old < extra['value']
        if edge and row['timestamp']-last >= rule.get('cooldownMs', 1000):
            last = row['timestamp']
            found.append({'timestamp': row['timestamp'], 'seq': row['seq'], 'before': before, 'after': now,
                          'history': rows[max(0, index-5):index+6]})
        previous = row
    return found


class Review:
    def __init__(self, worker):
        self.worker = worker
        with worker.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS event_rules(id TEXT PRIMARY KEY,definition TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS event_annotations(id TEXT PRIMARY KEY,recording TEXT NOT NULL,timestamp REAL NOT NULL,data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS event_recording ON event_annotations(recording,timestamp);
                CREATE TABLE IF NOT EXISTS annotation_history(id INTEGER PRIMARY KEY,event TEXT NOT NULL,changed REAL NOT NULL,data TEXT NOT NULL);''')

    def rows(self, db, recording):
        status = db.execute('SELECT status FROM recordings WHERE id=?', (recording,)).fetchone()
        if not status or status[0] == 'recording':
            raise ValueError('Choose a stopped recording')
        result = []
        for seq, data in db.execute('SELECT seq,data FROM samples WHERE recording=? ORDER BY seq LIMIT 100001', (recording,)):
            result.append({**json.loads(data), 'seq': seq})
        if len(result) > 100000:
            raise ValueError('Review replay limit is 100,000 samples')
        return result

    def run(self, op, request):
        with self.worker.db() as db:
            if op == 'events.rules':
                return [json.loads(row[0]) for row in db.execute('SELECT definition FROM event_rules ORDER BY id')]
            if op in ('events.test', 'events.detect'):
                rule = validate_rule(request['rule'])
                identity = hashlib.sha256(json.dumps(rule, sort_keys=True).encode()).hexdigest()
                recording = request['recordingId']
                rows = self.rows(db, recording)
                detections = detect(rows, rule)
                if len(detections) > 2000:
                    raise ValueError('Too many events; increase cooldown or narrow the rule')
                if op == 'events.detect':
                    db.execute('INSERT OR IGNORE INTO event_rules VALUES(?,?)', (identity, json.dumps(rule)))
                    for detection in detections:
                        event_id = hashlib.sha256(f'{recording}:{identity}:{detection["seq"]}'.encode()).hexdigest()
                        annotation = {**detection, 'id': event_id, 'recordingId': recording, 'rule': rule,
                                      'name': rule['name'], 'status': 'confirmed' if rule.get('mode') == 'automatic' else 'pending',
                                      'reward': rule.get('reward', 0), 'revision': 1}
                        db.execute('INSERT OR IGNORE INTO event_annotations VALUES(?,?,?,?)',
                                   (event_id, recording, detection['timestamp'], json.dumps(annotation)))
                return {'count': len(detections), 'potentialReward': len(detections)*rule.get('reward', 0), 'preview': detections[:10]}
            if op == 'events.list':
                offset = int(request.get('offset', 0))
                if offset < 0:
                    raise ValueError('Invalid page')
                summaries = []
                for row in db.execute('SELECT data FROM event_annotations WHERE recording=? ORDER BY timestamp,id LIMIT 50 OFFSET ?', (request['recordingId'], offset)):
                    annotation = json.loads(row[0])
                    annotation.pop('history', None)
                    summaries.append(annotation)
                return summaries
            if op == 'events.get':
                row = db.execute('SELECT data FROM event_annotations WHERE id=?', (request['eventId'],)).fetchone()
                if not row:
                    raise ValueError('Event not found')
                return json.loads(row[0])
            if op == 'events.update':
                row = db.execute('SELECT data FROM event_annotations WHERE id=?', (request['eventId'],)).fetchone()
                if not row:
                    raise ValueError('Event not found')
                annotation = json.loads(row[0])
                if request.get('revision') != annotation['revision']:
                    raise ValueError('Annotation changed; refresh before editing')
                if request.get('status') not in ('pending', 'confirmed', 'rejected'):
                    raise ValueError('Invalid confirmation status')
                name = request.get('name', annotation['name'])
                if not isinstance(name, str) or not 1 <= len(name) <= 80:
                    raise ValueError('Invalid event name')
                db.execute('INSERT INTO annotation_history(event,changed,data) VALUES(?,?,?)', (annotation['id'], time.time(), row[0]))
                annotation.update(status=request['status'], name=name, revision=annotation['revision']+1)
                db.execute('UPDATE event_annotations SET data=? WHERE id=?', (json.dumps(annotation), annotation['id']))
                return annotation
            if op == 'events.add':
                rows = self.rows(db, request['recordingId'])
                timestamp = float(request['timestamp'])
                name = request['name']
                if not rows or not math.isfinite(timestamp) or not rows[0]['timestamp'] <= timestamp <= rows[-1]['timestamp']:
                    raise ValueError('Timestamp must be within the recording')
                if not isinstance(name, str) or not 1 <= len(name) <= 80:
                    raise ValueError('Invalid event name')
                index = min(range(len(rows)), key=lambda i: abs(rows[i]['timestamp']-timestamp))
                annotation = {'id': str(uuid.uuid4()), 'recordingId': request['recordingId'], 'timestamp': timestamp,
                              'seq': rows[index]['seq'], 'name': name, 'status': 'confirmed', 'reward': 0, 'revision': 1,
                              'manual': True, 'history': rows[max(0,index-5):index+6]}
                db.execute('INSERT INTO event_annotations VALUES(?,?,?,?)', (annotation['id'], request['recordingId'], timestamp, json.dumps(annotation)))
                return annotation
            raise ValueError('Unknown review operation')
