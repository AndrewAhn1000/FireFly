import base64
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from collection import Graph, Tables, save, pattern_path


def document(mode='rise', initial=False):
    data = [
        ('state', {'kind': 'state', 'name': 'enemy'}),
        ('trigger', {'kind': 'trigger', 'name': 'Enemy visible', 'mode': mode, 'initial': initial, 'holdMs': 0, 'cooldownMs': 0, 'intervalMs': 100}),
        ('capture', {'kind': 'capture', 'name': 'Image', 'format': 'png', 'area': 'window'}),
        ('output', {'kind': 'output', 'name': 'Dataset', 'directory': str(Path(tempfile.gettempdir()).resolve()), 'pattern': '{session}/{sequence}', 'metadata': 'json', 'fields': ['enemy'], 'labels': '{"source":"observed"}'}),
    ]
    return {'nodes': [{'id': key, 'data': d} for key, d in data], 'edges': [{'source': a, 'target': b, 'targetHandle': 'in'} for a, b in [('state', 'trigger'), ('trigger', 'capture'), ('capture', 'output')]]}


def snapshot(t, value, held=0):
    return {'timestamp': t, 'observations': [{'name': 'enemy', 'type': 'boolean', 'valid': value is not None, 'value': value, 'heldMs': held}]}


def table_document(directory, match=None, after_format=False, gate=None):
    """Table → Trigger → Capture → Dataset Output, the table comparing Map ID, Map Region and the mob and NPC
    animations. gate puts a Logic node between table and trigger: 'all' (with a Busy state) or 'not'."""
    data = [
        ('map', {'kind': 'state', 'name': 'Map ID'}),
        ('region', {'kind': 'state', 'name': 'Map Region'}),
        ('mobs', {'kind': 'state', 'name': 'Mob animations'}),
        ('npcs', {'kind': 'state', 'name': 'NPC animations'}),
        ('table', {'kind': 'table', 'name': 'Seen', 'inputs': ['map_id', 'map_region', 'mobs', 'npcs'],
                   'match': match or {'map_id': 'same', 'map_region': 'same', 'mobs': 'any', 'npcs': 'any'}}),
        ('trigger', {'kind': 'trigger', 'name': 'While new', 'mode': 'repeat', 'initial': True, 'holdMs': 0, 'cooldownMs': 0, 'intervalMs': 100}),
        ('capture', {'kind': 'capture', 'name': 'Image', 'format': 'png', 'area': 'window'}),
        ('output', {'kind': 'output', 'name': 'Dataset', 'directory': directory, 'pattern': '{sequence}', 'metadata': 'none', 'fields': [], 'labels': '{}'}),
    ]
    edges = [('map', 'table', 'map_id'), ('region', 'table', 'map_region'), ('mobs', 'table', 'mobs'), ('npcs', 'table', 'npcs'),
             ('table', 'trigger', 'in'), ('trigger', 'capture', 'in'), ('capture', 'output', 'in')]
    if gate:
        data.append(('gate', {'kind': 'logic', 'name': 'Gate', 'operator': gate}))
        edges = [e for e in edges if e[:2] != ('table', 'trigger')] + [('table', 'gate', 'a'), ('gate', 'trigger', 'in')]
        if gate == 'all':
            data.append(('busy', {'kind': 'state', 'name': 'Busy'}))
            edges.append(('busy', 'gate', 'b'))
    if after_format:
        data.append(('format', {'kind': 'format', 'name': 'YOLO', 'formatType': 'yolo', 'valSplit': 0, 'inputs': [], 'classes': {}}))
        edges = [e for e in edges if e[:2] != ('capture', 'output')] + [('capture', 'format', 'image'), ('format', 'output', 'in')]
    return {'nodes': [{'id': k, 'data': d} for k, d in data], 'edges': [{'source': a, 'target': b, 'targetHandle': h} for a, b, h in edges]}


def table_snapshot(t, mobs, npcs=(), region=(2.0, -1.0), map_id=100000000.0, busy=True):
    values = {'Map ID': map_id, 'Map Region': list(region), 'Mob animations': list(mobs), 'NPC animations': list(npcs), 'Busy': busy}
    return {'timestamp': t, 'observations': [{'name': k, 'valid': v is not None, 'value': v} for k, v in values.items()]}


class CollectionTests(unittest.TestCase):
    def test_edges_unknown_does_not_rearm_and_duplicate_timestamps(self):
        g = Graph(document())
        self.assertFalse(g.evaluate(snapshot(1, True))['events'])
        self.assertFalse(g.evaluate(snapshot(2, False))['events'])
        self.assertEqual(len(g.evaluate(snapshot(3, True))['events']), 1)
        self.assertFalse(g.evaluate(snapshot(3, True))['events'])
        self.assertFalse(g.evaluate(snapshot(4, None))['events'])
        self.assertFalse(g.evaluate(snapshot(5, True))['events'])
        g.evaluate(snapshot(6, False))
        self.assertEqual(len(g.evaluate(snapshot(7, True))['events']), 1)

    def test_hold_cooldown_and_staleness(self):
        doc = document(initial=True)
        doc['nodes'][1]['data'].update(holdMs=100, cooldownMs=500)
        g = Graph(doc)
        self.assertFalse(g.evaluate(snapshot(1, True))['events'])
        self.assertFalse(g.evaluate(snapshot(101, True, 300), 250)['events'])
        self.assertFalse(g.evaluate(snapshot(102, True))['events'])
        self.assertTrue(g.evaluate(snapshot(202, True))['events'])
        g.evaluate(snapshot(250, False))
        self.assertFalse(g.evaluate(snapshot(260, True))['events'])
        self.assertFalse(g.evaluate(snapshot(500, True))['events'])
        self.assertTrue(g.evaluate(snapshot(702, True))['events'])

    def test_repeat_and_fall(self):
        g = Graph(document('repeat', True))
        self.assertTrue(g.evaluate(snapshot(1, True))['events'])
        self.assertFalse(g.evaluate(snapshot(50, True))['events'])
        self.assertTrue(g.evaluate(snapshot(101, True))['events'])
        g = Graph(document('fall'))
        self.assertFalse(g.evaluate(snapshot(1, True))['events'])
        self.assertTrue(g.evaluate(snapshot(2, False))['events'])

    def test_formula_and_validation(self):
        doc = document(initial=True)
        doc['nodes'].insert(1, {'id': 'formula', 'data': {'kind': 'formula', 'source': 'not a', 'inputs': ['a']}})
        doc['edges'][0] = {'source': 'formula', 'target': 'trigger', 'targetHandle': 'in'}
        doc['edges'].append({'source': 'state', 'target': 'formula', 'targetHandle': 'a'})
        result = Graph(doc).evaluate(snapshot(1, False))
        self.assertEqual(result['issues'], {})
        self.assertTrue(result['events'])
        doc['edges'][-1]['source'] = 'trigger'
        with self.assertRaises(ValueError): Graph(doc)

    def test_paths_and_image_metadata(self):
        for pattern in ('../escape', 'a/../../b', '/absolute', 'C:/absolute', 'a//b'):
            with self.assertRaises(ValueError): pattern_path(pattern, {}, {})
        self.assertEqual(str(pattern_path('{state:map}', {}, {'map': '../escape'})), '_escape')
        with tempfile.TemporaryDirectory() as directory:
            doc = document(initial=True)
            doc['nodes'][-1]['data']['directory'] = directory
            doc['nodes'][2]['data'].update(area='crop', crop={'x': .5, 'y': 0, 'w': .5, 'h': 1}, width=4, height=4)
            event = Graph(doc).evaluate(snapshot(300, True))['events'][0]
            request = {'frame': {'width': 2, 'height': 2, 'timestamp': 300, 'pixels': base64.b64encode(bytes([0, 0, 255, 255]) * 4).decode()}, 'event': event, 'snapshot': snapshot(300, True), 'graphId': 'g', 'name': 'Graph', 'session': 'session', 'revision': 'revision', 'sequence': 1}
            result = save(request)
            with Image.open(result['path']) as image:
                self.assertEqual(image.size, (4, 4))
                self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
            metadata = json.loads(Path(result['path'] + '.json').read_text())
            self.assertEqual(metadata['timestamp'], 300)
            self.assertEqual(metadata['crop'], [1, 0, 1, 2])
            self.assertEqual(metadata['states']['enemy']['value'], True)
            self.assertNotEqual(save(request)['path'], result['path'], 'Repeated patterns must not overwrite')
            for kind in ('jsonl', 'csv', 'none'):
                request['event']['output']['metadata'] = kind
                self.assertTrue(Path(save(request)['path']).exists())

    def test_yolo_output(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = document(initial=True)
            doc['nodes'][-1]['data'].update(
                directory=directory,
                metadata='yolo',
                fields=['enemy'],
                labels='{"classes": ["mob"], "states": {"enemy": 0}}',
                valSplit=20
            )
            event = Graph(doc).evaluate(snapshot(300, True))['events'][0]
            mob_snapshot = {
                'timestamp': 300,
                'observations': [
                    {'name': 'enemy', 'valid': True, 'value': [{'x': 100, 'y': 200, 'w': 200, 'h': 100}]}
                ]
            }
            req_train = {
                'frame': {'width': 1000, 'height': 500, 'timestamp': 300, 'pixels': base64.b64encode(bytes([0, 0, 255, 255]) * 500000).decode()},
                'event': event, 'snapshot': mob_snapshot, 'graphId': 'g', 'name': 'Graph',
                'session': 'sess', 'revision': 'rev', 'sequence': 1
            }
            res_train = save(req_train)
            self.assertIn('images/train', Path(res_train['path']).as_posix())
            label_train = Path(directory) / res_train['metadata']['label']
            self.assertTrue(label_train.exists())
            self.assertEqual(label_train.read_text().strip(), "0 0.200000 0.500000 0.200000 0.200000")

            req_val = dict(req_train, sequence=5)
            res_val = save(req_val)
            self.assertIn('images/val', Path(res_val['path']).as_posix())
            label_val = Path(directory) / res_val['metadata']['label']
            self.assertTrue(label_val.exists())

            data_yaml = Path(directory) / 'data.yaml'
            self.assertTrue(data_yaml.exists())
            self.assertIn('0: mob', data_yaml.read_text())

    def test_format_node_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = {
                'version': 1,
                'nodes': [
                    {'id': 'state_m', 'data': {'kind': 'state', 'name': 'monsters'}},
                    {'id': 'state_c', 'data': {'kind': 'state', 'name': 'in_combat'}},
                    {'id': 'cond', 'data': {'kind': 'condition', 'operator': 'true'}},
                    {'id': 'trig', 'data': {'kind': 'trigger', 'mode': 'rise', 'initial': True, 'holdMs': 0, 'intervalMs': 2000, 'cooldownMs': 1000}},
                    {'id': 'cap', 'data': {'kind': 'capture', 'area': 'window', 'format': 'png'}},
                    {'id': 'fmt', 'data': {'kind': 'format', 'formatType': 'yolo', 'valSplit': 20, 'inputs': ['monsters'], 'classes': {'monsters': 'monster'}}},
                    {'id': 'out', 'data': {'kind': 'output', 'directory': directory, 'pattern': '{session}/{sequence}'}}
                ],
                'edges': [
                    {'source': 'state_c', 'target': 'cond', 'sourceHandle': 'out', 'targetHandle': 'in'},
                    {'source': 'cond', 'target': 'trig', 'sourceHandle': 'out', 'targetHandle': 'in'},
                    {'source': 'trig', 'target': 'cap', 'sourceHandle': 'out', 'targetHandle': 'in'},
                    {'source': 'cap', 'target': 'fmt', 'sourceHandle': 'out', 'targetHandle': 'image'},
                    {'source': 'state_m', 'target': 'fmt', 'sourceHandle': 'out', 'targetHandle': 'monsters'},
                    {'source': 'fmt', 'target': 'out', 'sourceHandle': 'out', 'targetHandle': 'in'}
                ]
            }
            snap = {
                'timestamp': 300,
                'observations': [
                    {'name': 'in_combat', 'type': 'boolean', 'valid': True, 'value': True},
                    {'name': 'monsters', 'valid': True, 'value': [{'x': 50, 'y': 100, 'w': 100, 'h': 50}]}
                ]
            }
            eval_res = Graph(doc).evaluate(snap)
            self.assertEqual(len(eval_res['events']), 1)
            event = eval_res['events'][0]
            self.assertIsNotNone(event.get('format'))
            self.assertEqual(event['format']['classes'], {'monsters': 'monster'})

            req = {
                'frame': {'width': 500, 'height': 500, 'timestamp': 300, 'pixels': base64.b64encode(bytes([255, 0, 0, 255]) * 250000).decode()},
                'event': event, 'snapshot': snap, 'graphId': 'g', 'name': 'TestGraph',
                'session': 'sess', 'revision': 'rev', 'sequence': 1
            }
            res = save(req)
            self.assertIn('images/train', Path(res['path']).as_posix())
            label_file = Path(directory) / res['metadata']['label']
            self.assertTrue(label_file.exists())
            self.assertEqual(label_file.read_text().strip(), "0 0.200000 0.250000 0.200000 0.100000")
            yaml_file = Path(directory) / 'data.yaml'
            self.assertTrue(yaml_file.exists())
            self.assertIn('0: monster', yaml_file.read_text())
            # A Lua State's boxes are in the game's client area: its toFrame (title bar 26 px, border 1 px) moves them
            # onto the frame, and scales them when the script uses its own coordinate size
            for to_frame, expected in (({'x': 1, 'y': 26, 'sx': 1, 'sy': 1}, '0 0.202000 0.302000 0.200000 0.100000'),
                                       ({'x': 0, 'y': 0, 'sx': 2, 'sy': 1}, '0 0.400000 0.250000 0.400000 0.100000')):
                moved = {'timestamp': 300, 'observations': [{'name': 'in_combat', 'type': 'boolean', 'valid': True, 'value': True}],
                         'tracked': [{'name': 'monsters', 'valid': True, 'value': [{'x': 50, 'y': 100, 'w': 100, 'h': 50}], 'toFrame': to_frame}]}
                res = save(dict(req, snapshot=moved, sequence=2))
                self.assertEqual((Path(directory) / res['metadata']['label']).read_text().strip(), expected)

    def test_formula_counts_lists_by_their_declared_type(self):
        def count(value, kind='shapes'):
            data = [('list', {'kind': 'state', 'name': 'List'}),
                    ('formula', {'kind': 'formula', 'name': 'How many', 'source': 'count(items)', 'inputs': ['items']}),
                    ('busy', {'kind': 'formula', 'name': 'Busy', 'source': 'count(items) >= 1', 'inputs': ['items']}),
                    ('trigger', {'kind': 'trigger', 'name': 'T', 'mode': 'repeat', 'initial': True, 'holdMs': 0, 'cooldownMs': 0, 'intervalMs': 100}),
                    ('capture', {'kind': 'capture', 'name': 'Image', 'format': 'png', 'area': 'window'}),
                    ('output', {'kind': 'output', 'name': 'Dataset', 'directory': str(Path(tempfile.gettempdir()).resolve()), 'pattern': '{sequence}', 'metadata': 'none', 'fields': [], 'labels': '{}'})]
            edges = [('list', 'formula', 'items'), ('list', 'busy', 'items'), ('busy', 'trigger', 'in'), ('trigger', 'capture', 'in'), ('capture', 'output', 'in')]
            doc = {'nodes': [{'id': k, 'data': d} for k, d in data], 'edges': [{'source': a, 'target': b, 'targetHandle': h} for a, b, h in edges]}
            result = Graph(doc).evaluate({'timestamp': 1, 'observations': [{'name': 'List', 'type': kind, 'valid': True, 'value': value}]})
            return result['values']['formula'], result['issues']
        self.assertEqual(count([4, 5])[0], 2.0, 'Two animation numbers are a list of two, not a vector')
        self.assertEqual(count([{'x': 1, 'y': 2, 'w': 3, 'h': 4}, {'x': 9, 'y': 9, 'w': 3, 'h': 4}, {'x': 0, 'y': 0, 'w': 1, 'h': 1}])[0], 3.0)
        self.assertEqual(count([])[0], 0.0)
        self.assertIn('count', count([4, 5], 'vector')[1].get('formula', ''), 'A vector State is not a list')

    def test_logic_takes_any_number_of_wired_conditions(self):
        def doc(operator, inputs):
            data = [(n, {'kind': 'state', 'name': n}) for n in ('p', 'q', 'r')] + [
                ('logic', {'kind': 'logic', 'name': 'Combine', 'operator': operator, 'inputs': inputs}),
                ('trigger', {'kind': 'trigger', 'name': 'T', 'mode': 'repeat', 'initial': True, 'holdMs': 0, 'cooldownMs': 0, 'intervalMs': 100}),
                ('capture', {'kind': 'capture', 'name': 'Image', 'format': 'png', 'area': 'window'}),
                ('output', {'kind': 'output', 'name': 'Dataset', 'directory': str(Path(tempfile.gettempdir()).resolve()), 'pattern': '{sequence}', 'metadata': 'none', 'fields': [], 'labels': '{}'})]
            edges = [(s, 'logic', h) for s, h in zip(('p', 'q', 'r'), inputs)] + [('logic', 'trigger', 'in'), ('trigger', 'capture', 'in'), ('capture', 'output', 'in')]
            return {'nodes': [{'id': k, 'data': d} for k, d in data], 'edges': [{'source': a, 'target': b, 'targetHandle': h} for a, b, h in edges]}
        def value(operator, inputs, p, q, r):
            s = {'timestamp': 1, 'observations': [{'name': n, 'valid': True, 'value': v} for n, v in (('p', p), ('q', q), ('r', r))]}
            return Graph(doc(operator, inputs)).evaluate(s)['values']['logic']
        self.assertTrue(value('all', ['a', 'b', 'c'], True, True, True))
        self.assertFalse(value('all', ['a', 'b', 'c'], True, True, False), 'All needs every one of three')
        self.assertTrue(value('any', ['a', 'b', 'c'], False, False, True), 'Any needs one of three')
        self.assertFalse(value('not', ['a'], True, False, False))
        self.assertTrue(value('all', ['a'], True, False, False), 'One input is allowed')
        with self.assertRaises(ValueError): Graph(doc('all', []))

    def test_table_rows_are_paged_filtered_sorted_and_forgotten_with_their_image(self):
        with tempfile.TemporaryDirectory() as directory:
            tables = Tables(str(Path(directory) / 'tables.sqlite'))
            try:
                for i in range(250):
                    tables.record('game', 'Seen', {'map_id': 100000000 + i % 5, 'map_region': [i % 3, -1], 'mobs': [i]}, f'C:\\data\\images\\{i:06}.png')
                tables.record('game', 'Other', {'map_id': 1}, 'C:\\data\\images\\000007.png')
                page = tables.rows('game', 'Seen', offset=0, limit=100)
                self.assertEqual((page['all'], page['total'], len(page['rows'])), (250, 250, 100))
                self.assertEqual(page['columns'], ['map_id', 'map_region', 'mobs'])
                self.assertEqual(page['rows'][0]['columns']['mobs'], [249], 'Newest first')
                self.assertEqual(len(tables.rows('game', 'Seen', offset=200, limit=100)['rows']), 50, 'The last page holds what is left')
                found = tables.rows('game', 'Seen', filter='100000002 [1,-1]')
                self.assertEqual(found['total'], len([i for i in range(250) if i % 5 == 2 and i % 3 == 1]), 'Every word must match, spaces aside')
                self.assertEqual(found['all'], 250)
                ordered = tables.rows('game', 'Seen', limit=5, sort={'column': 'map_id', 'up': True})['rows']
                self.assertEqual([r['columns']['map_id'] for r in ordered], [100000000] * 5)
                self.assertEqual(tables.rows('game', 'Seen', limit=1, sort={'column': 'savedAt', 'up': True})['rows'][0]['columns']['mobs'], [0])
                # A deleted screenshot takes its rows with it, in every table, however its path is written
                self.assertEqual(tables.forget_image('c:/DATA/images/000007.png'), 2)
                self.assertEqual(tables.rows('game', 'Seen')['all'], 249)
                self.assertEqual(tables.rows('game', 'Other')['all'], 0)
            finally:
                tables.close()

    def test_table_keeps_screenshots_whose_values_are_new(self):
        with tempfile.TemporaryDirectory() as directory:
            tables = Tables(str(Path(directory) / 'tables.sqlite'))
            try:
                self.check_table(directory, tables)
            finally:
                tables.close()  # before the folder goes: Windows can't delete an open database

    def check_table(self, directory, tables):
        pixels = base64.b64encode(bytes([0, 0, 255, 255]) * 4).decode()
        def keep(graph, s):
            """Evaluates a frame and saves what it lets through, as collection does; the path saved, or None."""
            events, path = graph.evaluate(s)['events'], None
            for sequence, event in enumerate(events, 1):
                request = {'frame': {'width': 2, 'height': 2, 'timestamp': s['timestamp'], 'pixels': pixels}, 'event': event, 'snapshot': s,
                           'graphId': 'g', 'name': 'Graph', 'session': 'session', 'revision': 'r', 'sequence': sequence}
                path = save(request, tables)['path']
            return path
        def stored():
            return [r['columns'] for r in tables.rows('game', 'Seen')['rows']][::-1]
        first = Graph(table_document(directory), 'game', tables).evaluate(table_snapshot(1, [1]))
        self.assertEqual(first['values']['table'], 'New: map_id 100000000, map_region [2, -1] not kept before')
        self.assertEqual(stored(), [], 'Evaluating stores nothing; only a saved screenshot does')
        g = Graph(table_document(directory), 'game', tables)
        image = keep(g, table_snapshot(1, [1]))
        self.assertTrue(image)
        self.assertEqual(stored(), [{'map_id': 100000000, 'map_region': [2, -1], 'mobs': [1], 'npcs': []}])
        self.assertEqual(tables.rows('game', 'Seen')['rows'][0]['image'], image)
        self.assertIsNone(keep(g, table_snapshot(200, [1])))
        self.assertEqual(g.evaluate(table_snapshot(300, [1]))['values']['table'], 'Kept already (1 row like it)')
        self.assertTrue(keep(g, table_snapshot(400, [1, 3])), 'A mob animation not kept in this region is new')
        self.assertEqual(g.evaluate(table_snapshot(500, [3, 1]))['values']['table'], 'Kept already (2 rows like it)')
        self.assertIsNone(keep(g, table_snapshot(600, [3])), 'Every item has been kept here, in some row')
        self.assertEqual(g.evaluate(table_snapshot(700, [1], [7]))['values']['table'], 'New: npcs [7]')
        self.assertTrue(keep(g, table_snapshot(800, [1], region=(3, -1))), 'Another region is compared with its own rows')
        self.assertTrue(Graph(table_document(directory), 'other game', tables).evaluate(table_snapshot(1, [1]))['events'], 'Tables are per game')
        # Any value: kept with the row, never compared
        store = Graph(table_document(directory, {'map_id': 'same', 'map_region': 'same', 'mobs': 'store', 'npcs': 'store'}), 'game', tables)
        self.assertFalse(store.evaluate(table_snapshot(1, [9], [9]))['events'])
        everything = Graph(table_document(directory, {c: 'store' for c in ('map_id', 'map_region', 'mobs', 'npcs')}), 'game', tables)
        self.assertEqual(everything.evaluate(table_snapshot(1, [1]))['values']['table'], 'Keeping every image: no column is compared')
        unknown = table_snapshot(300, [5])
        unknown['observations'][0]['valid'] = False
        self.assertIn('map_id unknown', Graph(table_document(directory), 'game', tables).evaluate(unknown)['issues']['table'])
        # Through Format Dataset, and with two outputs: one row for the one screenshot
        doc = table_document(directory, after_format=True)
        doc['nodes'].append({'id': 'output2', 'data': dict(next(n for n in doc['nodes'] if n['id'] == 'output')['data'], name='Copy')})
        doc['edges'].append({'source': 'format', 'target': 'output2', 'targetHandle': 'in'})
        events = Graph(doc, 'game', tables).evaluate(table_snapshot(1, [11]))['events']
        self.assertEqual(len(events), 2)
        self.assertEqual([len(e['records']) for e in events], [1, 0])
        self.assertIsNotNone(events[0]['format'])
        # Combined with other conditions: the table still learns what was saved; not when it said "kept already"
        busy = Graph(table_document(directory, gate='all'), 'game', tables)
        self.assertFalse(busy.evaluate(table_snapshot(1, [12], busy=False))['events'])
        self.assertEqual(busy.evaluate(table_snapshot(200, [12]))['events'][0]['records'][0]['columns']['mobs'], [12])
        events = Graph(table_document(directory, gate='not'), 'game', tables).evaluate(table_snapshot(1, [1]))['events']
        self.assertEqual([e['records'] for e in events], [[]], 'A trigger that fires on "kept already" stores nothing')
        # Deleting rows makes their values new again
        tables.delete('game', 'Seen', tables.rows('game', 'Seen')['rows'][0]['key'])
        self.assertTrue(g.evaluate(table_snapshot(900, [1], region=(3, -1)))['events'])
        tables.delete('game', 'Seen')
        self.assertEqual(stored(), [])
        self.assertTrue(g.evaluate(table_snapshot(1000, [1]))['events'])
        # Validation
        bad = table_document(directory, {'map_id': 'sometimes'})
        with self.assertRaises(ValueError): Graph(bad, 'game', tables)
        bad = table_document(directory)
        bad['edges'] = [e for e in bad['edges'] if e['target'] != 'output'] + [{'source': 'table', 'target': 'output', 'targetHandle': 'in'}]
        with self.assertRaises(ValueError): Graph(bad, 'game', tables)


if __name__ == '__main__':
    unittest.main()
