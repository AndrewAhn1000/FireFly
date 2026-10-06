"""State-triggered image collection. No training/model dependencies; runs in its own process."""
import base64
import csv
import json
import math
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from formulas import FormulaSet, Missing


KINDS = {'state', 'condition', 'logic', 'formula', 'trigger', 'capture', 'format', 'output', 'table'}


class Tables:
    """What Table nodes have kept, per game (scope) and table name, across sessions: one row of
    the wired values for every screenshot saved while the table said they were new."""
    def __init__(self, path):
        self.path, self.db, self.cache = path, None, {}

    def _open(self):
        if self.db is None:
            if not self.path:
                raise ValueError('Tables are unavailable: FireFly gave the worker no place to keep them')
            if self.path != ':memory:':
                Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(self.path)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS table_rows (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL,'
                       ' columns TEXT NOT NULL, saved_at TEXT NOT NULL, image TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS table_rows_name ON table_rows (scope, name)')
            self.db = db
        return self.db

    def _columns(self, scope, name):
        # Every row's values, read once and then kept up to date, since each frame compares against them
        if (scope, name) not in self.cache:
            found = self._open().execute('SELECT columns FROM table_rows WHERE scope = ? AND name = ? ORDER BY id', (scope, name))
            self.cache[(scope, name)] = [json.loads(c) for (c,) in found]
        return self.cache[(scope, name)]

    def check(self, scope, name, columns, match):
        """Whether a frame with these values is new to the table, and why, by each column's Match:
        'same' columns choose the rows to compare with (all of them must be equal), and an 'any'
        column is new while it holds an item none of those rows held; 'store' (Any value) columns aren't compared."""
        same = [c for c in columns if match.get(c, 'same') == 'same']
        each = [c for c in columns if match.get(c) == 'any']
        if not same and not each:
            return True, 'Keeping every image: no column is compared'
        here = [r for r in self._columns(scope, name) if all(c in r and r[c] == columns[c] for c in same)]
        if not here:
            return True, 'New: ' + (', '.join(f'{c} {_short(columns[c])}' for c in same) + ' not kept before' if same else 'the table is empty')
        for c in each:
            held = {_item_key(i) for r in here for i in _items(r.get(c))}
            fresh = [i for i in _items(columns[c]) if _item_key(i) not in held]
            if fresh:
                return True, f'New: {c} {_short(fresh)}'
        return False, f'Kept already ({len(here)} row{"" if len(here) == 1 else "s"} like it)'

    def record(self, scope, name, columns, image):
        db = self._open()
        with db:
            db.execute('INSERT INTO table_rows (scope, name, columns, saved_at, image) VALUES (?, ?, ?, ?, ?)',
                       (scope, name, json.dumps(columns, ensure_ascii=False), datetime.now(timezone.utc).isoformat(), image))
        if (scope, name) in self.cache:
            self.cache[(scope, name)].append(columns)

    def rows(self, scope, name, offset=0, limit=100, filter='', sort=None):
        """One page of a table's rows: those holding every word of filter (in a column's name or value), sorted by a
        column or when they were saved ({'column', 'up'}), newest first by default. total counts the matching rows."""
        db = self._open()
        where, args = 'scope = ? AND name = ?', [scope, name]
        # Matched against the stored JSON without spaces, so "[2,-1]" finds [2, -1]
        for word in str(filter or '').lower().split():
            where += " AND instr(lower(replace(columns, ' ', '')), ?) > 0"
            args.append(word)
        column = (sort or {}).get('column', 'savedAt')
        direction = 'ASC' if (sort or {}).get('up') else 'DESC'
        if column == 'savedAt':
            order, order_args = f'id {direction}', []
        else:
            order, order_args = f'json_extract(columns, ?) {direction}, id DESC', ['$."' + str(column).replace('"', '') + '"']
        everything = db.execute('SELECT COUNT(*) FROM table_rows WHERE scope = ? AND name = ?', (scope, name)).fetchone()[0]
        total = db.execute(f'SELECT COUNT(*) FROM table_rows WHERE {where}', args).fetchone()[0]
        found = db.execute(f'SELECT id, columns, saved_at, image FROM table_rows WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?',
                           [*args, *order_args, max(1, min(1000, int(limit))), max(0, int(offset))]).fetchall()
        # Every column any row has, in the order they first appear
        names = []
        for (key,) in db.execute('SELECT j.key FROM table_rows, json_each(table_rows.columns) AS j WHERE scope = ? AND name = ? '
                                 'ORDER BY table_rows.id, j.id', (scope, name)):
            if key not in names:
                names.append(key)
        return {'all': everything, 'total': total, 'columns': names,
                'rows': [{'key': str(i), 'columns': json.loads(c), 'savedAt': s, 'image': img} for i, c, s, img in found]}

    def forget_image(self, image):
        """Deletes every row, in any table, whose screenshot is this file (once the file itself is gone)."""
        db = self._open()
        with db:
            # Paths compared without regard to case or slash direction, as Windows does
            count = db.execute("DELETE FROM table_rows WHERE lower(replace(image, '/', char(92))) = ?",
                               (str(image).replace('/', chr(92)).lower(),)).rowcount
        self.cache.clear()
        return count

    def delete(self, scope, name, key=None):
        db = self._open()
        with db:
            if key is None:
                db.execute('DELETE FROM table_rows WHERE scope = ? AND name = ?', (scope, name))
            else:
                db.execute('DELETE FROM table_rows WHERE scope = ? AND name = ? AND id = ?', (scope, name, int(key)))
        self.cache.pop((scope, name), None)

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None


TABLES = Tables(os.environ.get('FIREFLY_TABLES'))


def _normal(value):
    # 3 and 3.0 are one value, as JSON keeps them once a row is stored
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normal(v) for v in value]
    if isinstance(value, dict):
        return {k: _normal(v) for k, v in value.items()}
    return value


def _items(value):
    return [] if value is None else value if isinstance(value, list) else [value]


def _item_key(item):
    return json.dumps(item, sort_keys=True, separators=(',', ':'))


def _short(value):
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 60 else text[:57] + '…'


def validate(doc):
    nodes = doc.get('nodes', [])
    if not nodes or len(nodes) > 200:
        raise ValueError('Use between 1 and 200 nodes')
    by_id = {n['id']: n for n in nodes}
    if len(by_id) != len(nodes):
        raise ValueError('Duplicate node identifiers')
    incoming = {}
    for n in nodes:
        if n['data']['kind'] not in KINDS:
            raise ValueError('Unsupported collection node')
    for e in doc.get('edges', []):
        if e['source'] not in by_id or e['target'] not in by_id:
            raise ValueError('A connection points to a missing node')
        key = (e['target'], e.get('targetHandle', 'in'))
        if key in incoming:
            raise ValueError('Each input accepts one connection')
        incoming[key] = e['source']
    visited, visiting = set(), set()
    def walk(key):
        if key in visiting:
            raise ValueError('Collection graphs cannot contain cycles')
        if key in visited:
            return
        visiting.add(key)
        for (target, handle), source in incoming.items():
            if target == key:
                walk(source)
        visiting.remove(key)
        visited.add(key)
    for key in by_id:
        walk(key)
    for n in nodes:
        key, d = n['id'], n['data']
        kind = d['kind']
        handles = (
            ['in'] if kind in ('condition', 'trigger', 'capture', 'output') else
            logic_inputs(d) if kind == 'logic' else
            ['image', *d.get('inputs', [])] if kind == 'format' else
            d.get('inputs', []) if kind in ('formula', 'table') else []
        )
        for handle in handles:
            source = by_id.get(incoming.get((key, handle)))
            if not source:
                raise ValueError(f'{d.get("name", kind)}: connect {handle}')
            sk = source['data']['kind']
            allowed = (
                {'trigger'} if kind == 'capture' else
                ({'capture'} if handle == 'image' else {'state', 'formula'}) if kind == 'format' else
                {'state', 'formula'} if kind == 'table' else
                {'capture', 'format'} if kind == 'output' else
                {'state', 'condition', 'logic', 'formula', 'table'}
            )
            if sk not in allowed:
                raise ValueError(f'{kind} cannot receive {sk}')
        if kind == 'logic' and not handles:
            raise ValueError(f'{d.get("name", "Logic")}: wire a condition into it')
        if kind == 'table':
            if not str(d.get('name', '')).strip():
                raise ValueError('Name the table')
            match = d.get('match', {})
            if not isinstance(match, dict) or any(m not in ('same', 'any', 'store') for m in match.values()):
                raise ValueError(f'{d["name"]}: each column is compared as Same value, Any new item or Any value')
        if kind == 'trigger':
            for field in ('holdMs', 'intervalMs', 'cooldownMs'):
                value = d.get(field, 0)
                if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError('Trigger times must be non-negative numbers')
            if d.get('mode') not in ('rise', 'fall', 'repeat'):
                raise ValueError('Choose a trigger mode')
            if d.get('mode') == 'repeat' and d.get('intervalMs', 0) < 100:
                raise ValueError('Repeat interval must be at least 100 ms')
        if kind == 'capture':
            if d.get('format') not in ('png', 'jpeg'):
                raise ValueError('Choose PNG or JPEG')
            if d.get('area') == 'crop':
                box = d.get('crop', {})
                if any(not isinstance(box.get(k), (int, float)) or not math.isfinite(box[k]) for k in ('x', 'y', 'w', 'h')) or box['x'] < 0 or box['y'] < 0 or box['w'] <= 0 or box['h'] <= 0 or box['x'] + box['w'] > 1.00001 or box['y'] + box['h'] > 1.00001:
                    raise ValueError('Select a valid region crop')
            w, h = d.get('width', 0), d.get('height', 0)
            if (w == 0) != (h == 0) or any(not isinstance(v, int) or v < 0 or v > 8192 for v in (w, h)):
                raise ValueError('Set both resize dimensions (1–8192), or leave both zero')
        if kind == 'format':
            if d.get('formatType', 'yolo') not in ('yolo',):
                raise ValueError('Unsupported dataset format')
            val_split = d.get('valSplit', 20)
            if not isinstance(val_split, (int, float)) or not math.isfinite(val_split) or val_split < 0 or val_split > 100:
                raise ValueError('Validation split must be between 0 and 100%')
            classes = d.get('classes', {})
            if not isinstance(classes, dict):
                raise ValueError('Format classes must be a JSON object')
        if kind == 'output':
            if not d.get('directory') or not Path(d['directory']).is_absolute():
                raise ValueError('Choose an absolute dataset folder')
            source = by_id.get(incoming.get((key, 'in')))
            if not source or source['data']['kind'] != 'format':
                if d.get('metadata') not in ('none', 'json', 'jsonl', 'csv', 'yolo'):
                    raise ValueError('Choose a metadata format')
                if 'valSplit' in d:
                    val_split = d.get('valSplit')
                    if not isinstance(val_split, (int, float)) or not math.isfinite(val_split) or val_split < 0 or val_split > 100:
                        raise ValueError('Validation split must be between 0 and 100%')
            pattern_path(d.get('pattern', '{session}/{sequence}'), {'session': 'preview', 'sequence': '000001', 'timestamp': '1000', 'trigger': 'example', 'graph': 'graph'}, {})
            labels = json.loads(d.get('labels', '{}'))
            if not isinstance(labels, dict):
                raise ValueError('Custom labels must be a JSON object')
    if not any(n['data']['kind'] == 'output' for n in nodes):
        raise ValueError('Add a Dataset Output node')
    return by_id, incoming


def logic_inputs(d):
    """A Logic node's inputs: the ones wired into it (graphs from before wired inputs had a and b), only the first for Not."""
    inputs = d.get('inputs')
    inputs = ['a', 'b'] if inputs is None else inputs
    return inputs[:1] if d.get('operator') == 'not' else inputs


def safe_piece(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip(' .')[:100] or 'unknown'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I):
        value = '_' + value
    return value


def pattern_path(pattern, tokens, values):
    if not isinstance(pattern, str) or not pattern or len(pattern) > 500:
        raise ValueError('Enter a relative filename pattern')
    def token(match):
        key = match[1]
        if key.startswith('state:'):
            return safe_piece(values.get(key[6:], 'unknown'))
        if key not in tokens:
            raise ValueError(f'Unknown filename token: {key}')
        return safe_piece(tokens[key])
    # Validate literal pieces before replacing state values, which cannot introduce folders.
    if pattern.startswith(('/', '\\')) or ':' in re.sub(r'\{[^{}]+\}', '', pattern):
        raise ValueError('Filename pattern must be relative to the dataset folder')
    pieces = pattern.replace('\\', '/').split('/')
    if any(p in ('', '.', '..') for p in pieces):
        raise ValueError('Filename pattern cannot contain empty folders or . / ..')
    return Path(*[safe_piece(re.sub(r'\{([^{}]+)\}', token, p)) for p in pieces])


class Graph:
    def __init__(self, doc, scope='', tables=None):
        self.nodes, self.incoming = validate(doc)
        self.doc = doc
        self.scope = scope
        self.tables = tables or TABLES
        # The tables each trigger's condition depends on, through any conditions, logic and formulas
        self.trigger_tables = {key: self._tables_behind(key) for key, n in self.nodes.items() if n['data']['kind'] == 'trigger'}
        self.triggers = {}
        self.previous = {}
        self.compiled = {}
        self.last = -math.inf

    def _tables_behind(self, key):
        found, stack, seen = [], [key], set()
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node != key and self.nodes[node]['data']['kind'] == 'table':
                found.append(node)
            stack += [source for (target, _), source in self.incoming.items() if target == node]
        return found

    def evaluate(self, snapshot, max_age=250):
        t = snapshot['timestamp']
        if not math.isfinite(t) or t <= self.last:
            return {'events': [], 'values': {}, 'issues': {}}
        self.last = t
        observations = {v['name']: v for v in snapshot.get('observations', []) + snapshot.get('tracked', [])}
        memo, issues, kept, shown = {}, {}, {}, {}
        def read(key):
            if key in memo:
                return memo[key]
            d = self.nodes[key]['data']
            kind = d['kind']
            def get(handle='in'):
                return read(self.incoming[(key, handle)])
            value = None
            try:
                if kind == 'state':
                    o = observations.get(d.get('name'), {})
                    if not o.get('valid') or o.get('heldMs', 0) > max_age:
                        raise Missing(o.get('reason') or 'Unavailable or older than the input age limit')
                    value = o.get('value')
                elif kind == 'condition':
                    v, op = get(), d.get('operator', 'true')
                    if v is None:
                        raise Missing('Input is unknown')
                    expected = d.get('value', '')
                    if op == 'changed':
                        value = key in self.previous and v != self.previous[key]
                        self.previous[key] = v
                    elif op in ('true', 'false'):
                        if not isinstance(v, bool):
                            raise ValueError('This condition needs a Boolean state')
                        value = v if op == 'true' else not v
                    elif op in ('eq', 'ne'):
                        try: expected = json.loads(str(expected))
                        except (ValueError, TypeError): pass
                        value = v == expected if op == 'eq' else v != expected
                    else:
                        if isinstance(v, bool) or not isinstance(v, (int, float)):
                            raise ValueError('This comparison needs a numeric state')
                        b = float(expected)
                        value = {'gt': lambda: v > b, 'ge': lambda: v >= b, 'lt': lambda: v < b, 'le': lambda: v <= b, 'between': lambda: b <= v <= float(d.get('upper', b))}[op]()
                elif kind == 'logic':
                    op, values = d.get('operator', 'all'), [get(handle) for handle in logic_inputs(d)]
                    if any(v is None for v in values):
                        raise Missing('A condition is unknown')
                    if not all(isinstance(v, bool) for v in values):
                        raise ValueError('Logic nodes need Boolean inputs')
                    value = not values[0] if op == 'not' else all(values) if op == 'all' else any(values)
                elif kind == 'formula':
                    vals = {alias: get(alias) for alias in d.get('inputs', [])}
                    fields = []
                    for alias, v in vals.items():
                        # A State wired in says what it is (a list of two numbers isn't a vector); otherwise the value does
                        source = self.nodes.get(self.incoming.get((key, alias)), {}).get('data', {})
                        declared = observations.get(source.get('name'), {}).get('type') if source.get('kind') == 'state' else None
                        k = declared if declared in ('number', 'boolean', 'vector', 'shapes') else 'boolean' if isinstance(v, bool) else 'number' if isinstance(v, (int, float)) else 'vector' if isinstance(v, (list, tuple)) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v) else 'shapes' if isinstance(v, list) else 'number'
                        fields.append({'name': alias, 'type': k})
                    signature = json.dumps(fields)
                    if key not in self.compiled or self.compiled[key][0] != signature:
                        formula = FormulaSet([{'name': '__result', 'source': d.get('source', '')}], fields)
                        entry = formula.entries['__result']
                        if entry.get('error'):
                            raise ValueError(entry['error'])
                        if formula.depth:
                            raise ValueError('Use Trigger timing instead of historical formula indices in collection graphs')
                        self.compiled[key] = signature, formula
                    value = self.compiled[key][1].evaluate('__result', [{a: {'valid': v is not None, 'value': v} for a, v in vals.items()}])
                elif kind == 'trigger':
                    v = get()
                    s = self.triggers.setdefault(key, {'previous': None, 'since': None, 'fired': False, 'last': -math.inf})
                    if v is None:
                        s['since'] = None
                        raise Missing('Condition is unknown')
                    if not isinstance(v, bool):
                        raise ValueError('A trigger needs a Boolean condition')
                    target = not v if d['mode'] == 'fall' else v
                    old_target = None if s['previous'] is None else (not s['previous'] if d['mode'] == 'fall' else s['previous'])
                    if not target:
                        s['since'], s['fired'] = None, False
                    elif old_target is False or (old_target is None and d.get('initial', False)):
                        s['since'], s['fired'] = t, False
                    elif old_target is None:
                        s['fired'] = True
                    elif s['since'] is None and not s['fired']:
                        s['since'] = t
                    s['previous'] = v
                    gap = max(d.get('cooldownMs', 0), d.get('intervalMs', 1000) if d['mode'] == 'repeat' else 0)
                    value = bool(target and s['since'] is not None and t - s['since'] >= d.get('holdMs', 0) and t - s['last'] >= gap and (d['mode'] == 'repeat' or not s['fired']))
                    if value:
                        s['last'], s['fired'] = t, True
                elif kind == 'table':
                    # True while its values are new to the table
                    values = {alias: get(alias) for alias in d.get('inputs', [])}
                    unknown = [alias for alias, v in values.items() if v is None]
                    if unknown:
                        raise Missing(f'{", ".join(unknown)} unknown')
                    kept[key] = {alias: _normal(v) for alias, v in values.items()}
                    new, why = self.tables.check(self.scope, d['name'], kept[key], d.get('match', {}))
                    value = new
                    shown[key] = why
                elif kind in ('capture', 'output'):
                    value = get()
                elif kind == 'format':
                    for alias in d.get('inputs', []):
                        try: get(alias)
                        except Exception: pass
                    value = get('image')
            except (Missing, ValueError, TypeError, KeyError, ZeroDivisionError) as e:
                issues[key] = str(e)
            memo[key] = value
            return value
        events, recorded = [], set()
        for key, n in self.nodes.items():
            if n['data']['kind'] == 'output' and read(key) is True:
                in_id = self.incoming[(key, 'in')]
                format_id = in_id if self.nodes[in_id]['data']['kind'] == 'format' else None
                format_data = self.nodes[format_id]['data'] if format_id else None
                capture_id = self.incoming[(format_id, 'image')] if format_id else in_id
                format_state_sources = {}
                for alias in (format_data or {}).get('inputs', []):
                    src_id = self.incoming.get((format_id, alias))
                    if src_id and src_id in self.nodes:
                        format_state_sources[alias] = self.nodes[src_id]['data'].get('name', alias)
                trigger_id = self.incoming[(capture_id, 'in')]
                # The values of each table its trigger depends on that said they're new, stored once the
                # image is written. Once per frame: two outputs after one trigger are one screenshot to it.
                records = []
                for k in self.trigger_tables.get(trigger_id, []):
                    if memo.get(k) is True and k in kept and k not in recorded:
                        recorded.add(k)
                        records.append({'scope': self.scope, 'table': self.nodes[k]['data']['name'], 'columns': kept[k]})
                events.append({
                    'records': records,
                    'outputId': key,
                    'capture': self.nodes[capture_id]['data'],
                    'output': n['data'],
                    'format': format_data,
                    'formatStateSources': format_state_sources,
                    'trigger': self.nodes[trigger_id]['data'].get('name', 'Trigger'),
                    'triggerId': trigger_id
                })
        for key in self.nodes:
            read(key)
        previews = {k: f'{len(v)} items' if isinstance(v, list) and len(v) > 20 else v for k, v in memo.items()}
        previews.update(shown)
        return {'events': events, 'values': previews, 'issues': issues}


def save(request, tables=None):
    """Writes the image and its metadata, and only then stores its values in the tables it came through."""
    result = write_image(request)
    for record in request['event'].get('records', []):
        (tables or TABLES).record(record['scope'], record['table'], record['columns'], result['path'])
    return result


def write_image(request):
    frame, event = request['frame'], request['event']
    config, capture = event['output'], event['capture']
    width, height = frame['width'], frame['height']
    raw = base64.b64decode(frame['pixels'], validate=True)
    if len(raw) != width * height * 4:
        raise ValueError('Frame size does not match its pixels')
    image = Image.frombytes('RGBA', (width, height), raw, 'raw', 'BGRA').convert('RGB')
    crop = [0, 0, width, height]
    if capture.get('area') == 'crop':
        c = capture['crop']
        x, y = round(c['x'] * width), round(c['y'] * height)
        right, bottom = min(width, round((c['x'] + c['w']) * width)), min(height, round((c['y'] + c['h']) * height))
        if right <= x or bottom <= y:
            raise ValueError('Crop is empty at this capture size')
        crop = [x, y, right - x, bottom - y]
        image = image.crop((x, y, right, bottom))
    if capture.get('width') and capture.get('height'):
        image = image.resize((capture['width'], capture['height']), Image.Resampling.LANCZOS)
    snapshot = request['snapshot']
    all_values = {o['name']: o for o in snapshot.get('observations', []) + snapshot.get('tracked', [])}
    selected = {name: {**all_values.get(name, {'name': name, 'valid': False, 'value': None, 'reason': 'Unavailable'}), 'sourceTimestamp': snapshot['timestamp'] - all_values.get(name, {}).get('heldMs', 0)} for name in config.get('fields', [])}
    tokens = {'session': request['session'], 'sequence': str(request['sequence']).zfill(6), 'timestamp': str(round(frame['timestamp'], 3)), 'trigger': event['trigger'], 'graph': request['name']}
    relative = pattern_path(config.get('pattern', '{session}/{sequence}'), tokens, {k: v.get('value') for k, v in all_values.items() if v.get('valid')})
    root = Path(config['directory']).resolve()
    kind = config.get('metadata', 'json')
    fmt = event.get('format')
    is_yolo = (fmt is not None and fmt.get('formatType', 'yolo') == 'yolo') or (kind == 'yolo')

    if is_yolo:
        val_split = float(fmt.get('valSplit', 20) if fmt else config.get('valSplit', 20))
        val_ratio = (val_split / 100.0) if val_split > 1.0 else val_split
        val_ratio = max(0.0, min(1.0, val_ratio))
        if val_ratio <= 0.0:
            split = 'train'
        elif val_ratio >= 1.0:
            split = 'val'
        else:
            val_step = max(2, round(1.0 / val_ratio))
            split = 'val' if (request['sequence'] % val_step == 0) else 'train'

        img_subpath = Path('images') / split / relative
        lbl_subpath = Path('labels') / split / relative
        filename = (root / img_subpath).with_name(relative.name + ('.png' if capture['format'] == 'png' else '.jpg')).resolve()
        lbl_filename = (root / lbl_subpath).with_name(relative.name + '.txt').resolve()
        if root not in filename.parents or root not in lbl_filename.parents:
            raise ValueError('Output must stay inside the dataset folder')
        filename.parent.mkdir(parents=True, exist_ok=True)
        lbl_filename.parent.mkdir(parents=True, exist_ok=True)

        while True:
            try:
                stream = filename.open('xb')
                break
            except FileExistsError:
                stem = filename.stem + '-' + uuid.uuid4().hex[:8]
                filename = filename.with_name(stem + filename.suffix)
                lbl_filename = lbl_filename.with_name(stem + '.txt')

        with stream:
            image.save(stream, format='PNG' if capture['format'] == 'png' else 'JPEG', quality=max(1, min(100, int(capture.get('quality', 95)))))

        if fmt:
            inputs = fmt.get('inputs', [])
            classes_map = fmt.get('classes', {})
            state_sources = event.get('formatStateSources', {})
            class_names = []
            state_to_class = {}
            for alias in inputs:
                state_name = state_sources.get(alias, alias)
                assigned = classes_map.get(alias, alias)
                if isinstance(assigned, int) or (isinstance(assigned, str) and str(assigned).isdigit()):
                    cid = int(assigned)
                    state_to_class[state_name] = cid
                    while len(class_names) <= cid:
                        class_names.append(f'class_{len(class_names)}')
                    class_names[cid] = alias
                else:
                    cname = str(assigned).strip() or alias
                    if cname not in class_names:
                        class_names.append(cname)
                    state_to_class[state_name] = class_names.index(cname)
            if not class_names:
                class_names = ['object']
            fields = list(state_to_class.keys())
            labels_obj = {'classes': class_names, 'states': state_to_class}
        else:
            fields = config.get('fields', [])
            labels_obj = json.loads(config.get('labels', '{}'))
            custom_classes = labels_obj.get('classes')
            if isinstance(custom_classes, list):
                class_names = [str(c) for c in custom_classes]
            elif isinstance(custom_classes, dict):
                if all(str(k).isdigit() for k in custom_classes.keys()):
                    sorted_keys = sorted(custom_classes.keys(), key=lambda x: int(x))
                    class_names = [str(custom_classes[k]) for k in sorted_keys]
                else:
                    class_names = list(custom_classes.values())
            else:
                class_names = [str(f) for f in fields]

            custom_states = labels_obj.get('states')
            if isinstance(custom_states, dict):
                state_to_class = {}
                for k, v in custom_states.items():
                    if isinstance(v, int):
                        state_to_class[k] = v
                    elif str(v).isdigit():
                        state_to_class[k] = int(v)
                    elif v in class_names:
                        state_to_class[k] = class_names.index(v)
                    else:
                        class_names.append(str(v))
                        state_to_class[k] = len(class_names) - 1
            else:
                state_to_class = {f: i for i, f in enumerate(fields)}

            for f, cid in state_to_class.items():
                while len(class_names) <= cid:
                    class_names.append(f)

        for f in fields:
            if f not in selected:
                selected[f] = {**all_values.get(f, {'name': f, 'valid': False, 'value': None, 'reason': 'Unavailable'}), 'sourceTimestamp': snapshot['timestamp'] - all_values.get(f, {}).get('heldMs', 0)}

        crop_x, crop_y, crop_w, crop_h = crop[0], crop[1], crop[2], crop[3]
        yolo_lines = []

        for state_name in fields:
            cid = state_to_class.get(state_name)
            if cid is None:
                continue
            state_data = all_values.get(state_name, {})
            if not state_data.get('valid'):
                continue
            val = state_data.get('value')
            if not isinstance(val, list):
                continue
            for item in val:
                if not isinstance(item, dict):
                    continue
                if 'w' in item and 'h' in item and 'x' in item and 'y' in item:
                    bx, by, bw, bh = float(item['x']), float(item['y']), float(item['w']), float(item['h'])
                elif all(k in item for k in ('x1', 'y1', 'x2', 'y2')):
                    x1, x2 = float(item['x1']), float(item['x2'])
                    y1, y2 = float(item['y1']), float(item['y2'])
                    bx, by, bw, bh = min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1)
                else:
                    continue
                # A Lua State's boxes are in the game's client area, which the frame holds below the window's
                # title bar and inside its borders: the runtime says how they map onto the frame's pixels
                to_frame = state_data.get('toFrame')
                if isinstance(to_frame, dict):
                    sx, sy = float(to_frame.get('sx', 1)), float(to_frame.get('sy', 1))
                    bx, by = float(to_frame.get('x', 0)) + bx * sx, float(to_frame.get('y', 0)) + by * sy
                    bw, bh = bw * sx, bh * sy
                if bw <= 0 or bh <= 0 or crop_w <= 0 or crop_h <= 0:
                    continue

                adj_x = bx - crop_x
                adj_y = by - crop_y
                clp_x1 = max(0.0, adj_x)
                clp_y1 = max(0.0, adj_y)
                clp_x2 = min(float(crop_w), adj_x + bw)
                clp_y2 = min(float(crop_h), adj_y + bh)
                if clp_x2 <= clp_x1 or clp_y2 <= clp_y1:
                    continue
                clipped_w = clp_x2 - clp_x1
                clipped_h = clp_y2 - clp_y1
                if clipped_w < 2.0 or clipped_h < 2.0:
                    continue

                cx = max(0.0, min(1.0, (clp_x1 + clipped_w / 2.0) / float(crop_w)))
                cy = max(0.0, min(1.0, (clp_y1 + clipped_h / 2.0) / float(crop_h)))
                nw = max(0.0, min(1.0, clipped_w / float(crop_w)))
                nh = max(0.0, min(1.0, clipped_h / float(crop_h)))

                yolo_lines.append(f"{cid} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        lbl_filename.write_text('\n'.join(yolo_lines) + ('\n' if yolo_lines else ''), encoding='utf-8')

        # Write or update data.yaml at dataset root
        yaml_path = root / 'data.yaml'
        names_yaml = "\n".join(f"  {i}: {name}" for i, name in enumerate(class_names))
        yaml_content = f"""# YOLO dataset configuration generated by FireFly
path: {root.as_posix()}
train: images/train
val: images/val

names:
{names_yaml}
nc: {len(class_names)}
"""
        yaml_path.write_text(yaml_content, encoding='utf-8')

        metadata = {'image': filename.relative_to(root).as_posix(), 'label': lbl_filename.relative_to(root).as_posix(), 'split': split, 'session': request['session'], 'sequence': request['sequence'], 'graph': request['name'], 'graphId': request['graphId'], 'graphRevision': request['revision'], 'trigger': event['trigger'], 'triggers': event.get('triggers', [event['trigger']]), 'timestamp': frame['timestamp'], 'savedAt': datetime.now(timezone.utc).isoformat(), 'sourceSize': [width, height], 'imageSize': list(image.size), 'crop': crop, 'states': selected, 'labels': labels_obj, 'boxCount': len(yolo_lines)}
        lbl_filename.with_suffix('.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        if request.get('doc'):
            try:
                with (root / f"{request['session']}-graph.json").open('x', encoding='utf-8') as graph_file:
                    json.dump({'name': request['name'], 'revision': request['revision'], 'graph': request['doc']}, graph_file, ensure_ascii=False, indent=2)
            except FileExistsError:
                pass
        return {'path': str(filename), 'metadata': metadata}

    filename = (root / relative).with_name(relative.name + ('.png' if capture['format'] == 'png' else '.jpg')).resolve()
    if root not in filename.parents:
        raise ValueError('Output must stay inside the dataset folder')
    filename.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation: patterns without sequence tokens must never overwrite earlier samples.
    while True:
        try:
            stream = filename.open('xb')
            break
        except FileExistsError:
            filename = filename.with_name(filename.stem + '-' + uuid.uuid4().hex[:8] + filename.suffix)
    with stream:
        image.save(stream, format='PNG' if capture['format'] == 'png' else 'JPEG', quality=max(1, min(100, int(capture.get('quality', 95)))))
    metadata = {'image': filename.relative_to(root).as_posix(), 'session': request['session'], 'sequence': request['sequence'], 'graph': request['name'], 'graphId': request['graphId'], 'graphRevision': request['revision'], 'trigger': event['trigger'], 'triggers': event.get('triggers', [event['trigger']]), 'timestamp': frame['timestamp'], 'savedAt': datetime.now(timezone.utc).isoformat(), 'sourceSize': [width, height], 'imageSize': list(image.size), 'crop': crop, 'coordinates': 'State spatial values are kept as observed: source-frame pixels, except Lua States, which are in the game client area; their toFrame maps them onto the source frame (x + value * sx). crop and imageSize describe the image transform.', 'states': selected, 'labels': json.loads(config.get('labels', '{}'))}
    if kind != 'none' and request.get('doc'):
        try:
            with (root / f"{request['session']}-graph.json").open('x', encoding='utf-8') as graph_file:
                json.dump({'name': request['name'], 'revision': request['revision'], 'graph': request['doc']}, graph_file, ensure_ascii=False, indent=2)
        except FileExistsError:
            pass
    if kind == 'json':
        filename.with_suffix(filename.suffix + '.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    elif kind == 'jsonl':
        with (root / f"{request['session']}-manifest.jsonl").open('a', encoding='utf-8') as out:
            out.write(json.dumps(metadata, ensure_ascii=False) + '\n')
    elif kind == 'csv':
        # One manifest per output/session gives every row a stable, known column schema.
        manifest = root / f"{request['session']}-{safe_piece(event['outputId'])}.csv"
        row = {k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in metadata.items() if k != 'states'}
        for name, o in selected.items():
            row[f'state.{name}'] = json.dumps(o.get('value'), ensure_ascii=False)
            row[f'valid.{name}'] = o.get('valid', False)
            row[f'heldMs.{name}'] = o.get('heldMs', 0)
        fresh = not manifest.exists()
        with manifest.open('a', newline='', encoding='utf-8') as out:
            writer = csv.DictWriter(out, fieldnames=list(row))
            if fresh: writer.writeheader()
            writer.writerow(row)
    return {'path': str(filename), 'metadata': metadata}


def main():
    graphs = {}
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            op = request['op']
            if op == 'configure':
                graphs[request['graphId']] = Graph(request['doc'], request.get('scope', ''))
                result = {}
            elif op == 'table.rows':
                result = TABLES.rows(request['scope'], request['table'], request.get('offset', 0), request.get('limit', 100),
                                     request.get('filter', ''), request.get('sort'))
            elif op == 'table.forget_image':
                result = {'rows': TABLES.forget_image(request['image'])}
            elif op == 'table.delete':
                TABLES.delete(request['scope'], request['table'], request.get('key'))
                result = {}
            elif op == 'evaluate':
                result = graphs[request['graphId']].evaluate(request['snapshot'], request.get('maxAgeMs', 250))
            elif op == 'remove':
                graphs.pop(request['graphId'], None)
                result = {}
            elif op == 'save':
                result = save(request)
            elif op == 'shutdown':
                break
            else:
                raise ValueError('Unknown collection operation')
            print(json.dumps({'id': request['id'], 'ok': True, 'result': result}, ensure_ascii=False, allow_nan=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id'), 'ok': False, 'error': str(error)}), flush=True)


if __name__ == '__main__':
    main()
