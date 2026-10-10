"""Versioned local behavior-cloning worker. No input injection or game reset API."""
from collections import Counter
from contextlib import contextmanager
import argparse
import json
import math
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from torch import nn

from formulas import MAX_HISTORY, FormulaSet, Missing, columns_of, functions_help
from shapes import finite
from observations import MAX_INPUTS, MAX_STEP_MS, MIN_STEP_MS, Featurizer, held, on_grid, phases, suggested_step
from review import Review

torch.set_num_threads(2)

MAX_SAMPLES = 300000  # samples loaded at once, over the chosen recordings
PREVIEW_ROWS = 300    # grid rows a formula is tried on, to show what it gives
VERSION = 3           # of a policy: what its inputs are and how they're made
# How much of each epoch corrections make up, however short they are beside the recordings: as plain rows,
# a few seconds of corrections among minutes of play were a few percent of what a policy learned from, and
# it went on doing what the recordings did there. The player can choose it (correctionShare), 0 being as
# plain rows; this is when they don't.
CORRECTION_SHARE = .4
MAX_CORRECTION_SHARE = .9  # the recordings still teach it everything the corrections don't show
# A correction ends once the player has let go for this long (play.cjs correctionIdleMs): that wait isn't
# something they showed the policy, and weighted as a correction it would teach it to stand still
CORRECTION_IDLE_MS = 1500


def hidden_for(inputs):
    """How wide a policy's hidden layers are: wider for many inputs, as a grid of the screen gives."""
    return 128 if inputs > 200 else 64


def policy(inputs, outputs, hidden=64):
    return nn.Sequential(nn.Linear(inputs, hidden), nn.ReLU(), nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, outputs))


def features(observations, schema, anchor=None, surface='below', near_px=200):
    """One sample's observations as the numbers a policy sees (see observations.py)."""
    return Featurizer(schema, anchor, surface, near_px)(observations)


def button_stats(logits, labels, buttons):
    """How well each button is predicted: precision, recall and F1 of pressing it, and how often it is.
    Accuracy alone flatters a button that's rarely pressed, since never pressing it is mostly right."""
    predicted, held = logits >= 0, labels >= .5
    stats = []
    for i, button in enumerate(buttons):
        p, h = predicted[:, i], held[:, i]
        tp, fp, fn = int((p & h).sum()), int((p & ~h).sum()), int((~p & h).sum())
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        stats.append({'button': button['id'], 'precision': precision, 'recall': recall, 'f1': f1,
                      'pressed': float(h.float().mean()) if len(h) else 0.0})
    return stats


def split_sequences(sequences, whole=()):
    """Training and validation rows: the last quarter of every recording is for validation, after a gap
    (neighbouring rows are nearly the same, and would make validation look better than it is). Taking
    the last recording whole left validation without whatever it didn't do: a correction of only walking
    scored every jump and climb of the recordings before it as never pressed. The sequences numbered in
    `whole` (corrections, each a few seconds) are trained on whole: a quarter and a gap was most of one."""
    training, validation = [], []
    for n, sequence in enumerate(sequences):
        boundary = int(len(sequence) * .75)
        gap = max(5, int(len(sequence) * .05))
        if n in whole or boundary - gap < 10:
            training += sequence  # too short to split
            continue
        training += sequence[:boundary-gap]
        validation += sequence[boundary:]
    split = 'temporal_with_gap'
    if len(training) < 20 or len(validation) < 5:
        raise ValueError('Need at least 20 training and 5 validation samples after temporal splitting; record longer sessions')
    return training, validation, split


class Worker:
    def __init__(self, root, emit=lambda event: None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / 'models').mkdir(exist_ok=True)
        self.emit = emit
        self.loaded = None
        self.recent = []
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS training_runs(id TEXT PRIMARY KEY, status TEXT, config TEXT, metrics TEXT, model_id TEXT)')
            db.execute("UPDATE training_runs SET status='interrupted' WHERE status='running'")

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.root / 'catalog.sqlite', timeout=3)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _recordings(self, db, ids):
        """The chosen recordings' metadata and samples (in order), checked to be complete and alike."""
        out, observation_schema, action_schema, total = [], None, None, 0
        for recording_id in ids:
            row = db.execute('SELECT status,metadata FROM recordings WHERE id=?', (recording_id,)).fetchone()
            if not row:
                raise ValueError(f'A chosen recording no longer exists (it was deleted): {recording_id}')
            if row[0] != 'complete':
                raise ValueError('Only complete recordings can be trained on; one is still recording, or was interrupted')
            metadata = json.loads(row[1])
            if observation_schema is None:
                observation_schema, action_schema = metadata['observationSchema'], metadata['actionSchema']
            if (metadata['observationSchema']['identity'] != observation_schema['identity'] or
                    metadata['actionSchema']['identity'] != action_schema['identity']):
                raise ValueError('Incompatible observation/action schemas across recordings')
            samples = []
            for (data,) in db.execute('SELECT data FROM samples WHERE recording=? ORDER BY seq', (recording_id,)):
                sample = json.loads(data)
                if sample['observationSchema'] != observation_schema['identity'] or sample['actionSchema'] != action_schema['identity']:
                    raise ValueError('Sample schema identity mismatch')
                if samples and float(sample['timestamp']) <= samples[-1]['timestamp']:
                    continue  # never happens from the recorder; kept in order regardless
                sample['timestamp'] = float(sample['timestamp'])
                sample['observations'] = {o['name']: o for o in sample['observations']}
                # The frame's size, which grids are laid over (recordings from before it was kept have none)
                frame = sample.get('frame')
                if isinstance(frame, dict) and finite(frame.get('w')) and finite(frame.get('h')):
                    sample['observations']['@frame'] = {'name': '@frame', 'valid': True, 'value': [frame['w'], frame['h']]}
                samples.append(sample)
            total += len(samples)
            if total > MAX_SAMPLES:
                raise ValueError(f'At most {MAX_SAMPLES:,} samples at once; choose fewer recordings')
            out.append((recording_id, samples))
        return out, observation_schema, action_schema

    @staticmethod
    def _step(request, recordings):
        step = request.get('stepMs')
        if step in (None, '', 0):
            return suggested_step([[s['timestamp'] for s in samples] for _, samples in recordings])
        step = float(step)
        if not MIN_STEP_MS <= step <= MAX_STEP_MS:
            raise ValueError(f'The time step must be {MIN_STEP_MS}..{MAX_STEP_MS} ms')
        return step

    def dataset(self, request):
        """The chosen recordings as numbers a policy learns from, the same way for training and export:
        per recording, rows of (time, features with their history, buttons held).

        Each recording is put on an even grid of stepMs (the same for all of them; by default the
        interval most samples were taken at): each grid point takes the sample nearest it within half a
        step, and is a gap if there's none. A row needs its sample's buttons (the game
        in front), every value it's made of (see Featurizer: the player not being found skips it), the
        `history` grid points before it, and, with an action delay, the buttons that many steps later.
        What was skipped, and why, is counted in skippedReasons."""
        ids = request['recordingIds']
        if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or len(set(ids)) != len(ids):
            raise ValueError('Select 1..100 distinct recordings')
        anchor = request.get('anchor') or None
        surface, near_px = request.get('surface', 'below'), request.get('nearPx', 200)
        history = int(request.get('history', 2))
        delay_ms = float(request.get('actionDelayMs', 0))
        if not 0 <= history <= 4 or not 0 <= delay_ms <= 1000:
            raise ValueError('History must be 0..4 steps and the action delay 0..1000 ms')
        with self.db() as db:
            loaded, observation_schema, action_schema = self._recordings(db, ids)
            # Recorded while a version played, as the player corrected it (play.cjs)
            corrections = {rid for (rid,) in db.execute(
                f"SELECT id FROM recordings WHERE json_extract(metadata,'$.correction') AND id IN ({','.join('?' * len(ids))})", ids)}
        featurize = Featurizer(observation_schema, anchor, surface, near_px, request.get('columns'),
                               request.get('derived'), request.get('formulas'), request.get('grids'))
        inputs = featurize.size + history * len(featurize.history_keep)
        if inputs > MAX_INPUTS:
            raise ValueError(f'Too many inputs ({inputs}); use fewer values, fewer grid cells or less history')
        step = self._step(request, loaded)
        delay_steps = round(delay_ms / step)
        buttons = self._outputs(request, action_schema)
        recordings, skipped, reasons, total = [], [], Counter(), 0
        for recording_id, samples in loaded:
            if not samples:
                skipped.append(recording_id)  # such as a correction the player let go of at once
                continue
            timestamps = [s['timestamp'] for s in samples]
            count = phases(timestamps, step)
            grids = [(step * p / count, on_grid(timestamps, step, step * p / count)) for p in range(count)]
            placed = {i for _, grid in grids for i in grid if i is not None}
            if len(samples) > len(placed):
                reasons['Another sample was nearer its time step'] += len(samples) - len(placed)
            sequence, current = [], set()
            for offset, grid in grids:
                sequence += self._rows(samples, grid, samples[0]['timestamp'] + offset, step, featurize, history,
                                       delay_steps, delay_ms, buttons, reasons, current)
            sequence.sort(key=lambda row: row[0])
            if recording_id in corrections:
                # The wait for the player to let go, at its end
                idle_from = timestamps[-1] - CORRECTION_IDLE_MS
                while sequence and sequence[-1][0] >= idle_from and not any(sequence[-1][2]):
                    sequence.pop()
                    reasons['Waiting for the player to let go, at the end of a correction'] += 1
            total += len(sequence)
            if sequence:
                recordings.append((recording_id, sequence))
            else:
                skipped.append(recording_id)  # nothing usable in it, such as a game that was never in front
        if not recordings:
            top = ', '.join(f'{reason} ({count})' for reason, count in reasons.most_common(3))
            raise ValueError('The chosen recordings have no usable samples' + (f': {top}' if top else ''))
        options = {'anchor': anchor, 'surface': surface, 'nearPx': near_px, 'history': history, 'actionDelayMs': delay_ms,
                   'stepMs': step, 'columns': featurize.columns, 'derived': featurize.derived, 'formulas': featurize.formula_sources, 'grids': featurize.grids,
                   'buttons': [b['id'] for b in buttons]}
        return {'recordings': recordings, 'skipped': skipped, 'skippedReasons': dict(reasons.most_common()),
                'corrections': {rid for rid, _ in recordings if rid in corrections},
                'samples': total, 'observationSchema': observation_schema, 'actionSchema': action_schema,
                'outputs': buttons, 'featurize': featurize, 'options': options}

    @staticmethod
    def _rows(samples, grid, t0, step, featurize, history, delay_steps, delay_ms, buttons, reasons, current):
        """One grid's rows, (time, features with their history, buttons held), and what was skipped, by
        reason. `current` holds the samples already the current one of a row on another grid: a sample
        near two grids' points is one row, not two."""
        frames = [samples[i]['observations'] if i is not None else None for i in grid]
        xs = []
        for n, i in enumerate(grid):
            if i is None:
                xs.append(None)
                continue
            try:
                xs.append(featurize(frames[n], [frames[n - k] if n >= k else None for k in range(1, featurize.depth + 1)]))
            except Missing as e:
                xs.append(e)

        def labels(n):
            i = grid[n] if 0 <= n < len(grid) else None
            if i is None or not samples[i]['actions'].get('valid'):
                return None
            states = samples[i]['actions']['buttons']
            if any(type(states.get(b['id'])) is not bool for b in buttons):
                raise ValueError('Invalid recorded button state')
            return [float(states[b['id']]) for b in buttons]
        sequence = []
        for n, i in enumerate(grid):
            if i is None or i in current:
                continue
            current.add(i)
            actions = samples[i]['actions']
            if not actions.get('valid'):
                reasons[actions.get('reason') or 'No button state'] += 1
                continue
            if isinstance(xs[n], Missing):
                reasons[str(xs[n])] += 1
                continue
            earlier = [xs[n - k] if n >= k else None for k in range(1, history + 1)]
            if any(not isinstance(x, list) for x in earlier):
                reasons[f'Not all of the {history} step{"s" if history > 1 else ""} before it are usable (history)'] += 1
                continue
            y = labels(n) if delay_steps == 0 else labels(n + delay_steps)
            if y is None:
                reasons[f'No buttons recorded {delay_ms:g} ms later (action delay)'] += 1
                continue
            keep = featurize.history_keep
            sequence.append((round(t0 + n * step, 3), xs[n] + [x[i] for x in earlier for i in keep], y))
        return sequence

    @staticmethod
    def _outputs(request, action_schema):
        """The buttons a dataset's labels are, and a policy learns and presses: `buttons` (ids) if given,
        in the recordings' order, else every button recorded."""
        chosen = request.get('buttons')
        if chosen is None:
            return list(action_schema['buttons'])
        known = {b['id'] for b in action_schema['buttons']}
        if not isinstance(chosen, list) or not chosen or any(c not in known for c in chosen):
            raise ValueError('Choose at least one of the recorded buttons')
        return [b for b in action_schema['buttons'] if b['id'] in chosen]

    def preview(self, request):
        """What a dataset of these recordings, with these options, would hold, without training on it: its
        rows and values, its labels and how often each is pressed, and what was skipped and why."""
        data = self.dataset(request)
        featurize, history = data['featurize'], data['options']['history']
        labels = [y for _, sequence in data['recordings'] for _, _, y in sequence]
        return {'samples': data['samples'], 'stepMs': data['options']['stepMs'],
                'recordings': [{'id': rid, 'rows': len(sequence)} for rid, sequence in data['recordings']],
                'skipped': data['skipped'], 'skippedReasons': data['skippedReasons'],
                'values': featurize.names(), 'inputs': featurize.size + history * len(featurize.history_keep),
                'buttons': [{'id': b['id'], 'pressed': sum(y[i] for y in labels) / len(labels) if labels else 0}
                            for i, b in enumerate(data['outputs'])]}

    def columns(self, request):
        """What a dataset of these recordings can hold with these options: every value to choose from, by
        observation, derived value or formula; each formula's type, columns or error, and a preview of
        it over the first recording (its first value and how often it's missing); and the time step."""
        ids = request.get('recordingIds') or []
        # What else is observed now, beyond what the recording holds (States not recorded yet): formulas
        # over them are checked too, and have no preview until a recording holds them
        extra = [{'name': f['name'], 'type': f['type']} for f in request.get('fields') or []
                 if isinstance(f, dict) and isinstance(f.get('name'), str) and isinstance(f.get('type'), str)]
        if not ids and not extra:
            raise ValueError('Choose a recording, or add States')
        if ids:
            with self.db() as db:
                loaded, schema, _ = self._recordings(db, ids[:1])
                timestamps = [[t for (t,) in db.execute("SELECT json_extract(data,'$.timestamp') FROM samples WHERE recording=? ORDER BY seq", (rid,))]
                              for rid in ids[:100]]
        else:
            loaded, schema, timestamps = [(None, [])], {'identity': '', 'fields': []}, []
        known = {f['name'] for f in schema['fields']}
        schema = {**schema, 'fields': [*schema['fields'], *(f for f in extra if f['name'] not in known)]}
        formulas = FormulaSet(request.get('formulas'), schema['fields'])
        # With what each formula's inputs are wired to: without them, a formula over an input (p) can't be read
        usable = [{'name': e['name'], 'source': e['source'], **({'inputs': e['inputs']} if e['inputs'] else {})} for e in formulas.ok()]
        featurize, error = None, None
        for attempt in (usable, None):  # without the formulas, if they clash with other values
            try:
                featurize = Featurizer(schema, request.get('anchor') or None, request.get('surface', 'below'),
                                       request.get('nearPx', 200), derived=request.get('derived'), formulas=attempt)
                break
            except ValueError as e:
                error = error or str(e)
        suggested = suggested_step(timestamps)
        step = float(request['stepMs']) if request.get('stepMs') else suggested
        if not MIN_STEP_MS <= step <= MAX_STEP_MS:
            raise ValueError(f'The time step must be {MIN_STEP_MS}..{MAX_STEP_MS} ms')
        results = formulas.results()
        samples = loaded[0][1]
        grid = on_grid([s['timestamp'] for s in samples], step)[:PREVIEW_ROWS]
        frames = [samples[i]['observations'] if i is not None else None for i in grid]
        for result in results:
            if result['error']:
                continue
            first, missing, reason, rows = None, 0, Counter(), 0
            for n, frame in enumerate(frames):
                if frame is None:
                    continue
                rows += 1
                try:
                    value = formulas.evaluate(result['name'], [frame, *(frames[n - k] if n >= k else None for k in range(1, formulas.depth + 1))])
                    if first is None:
                        first = columns_of(value, result['type'])
                except Missing as e:
                    missing += 1
                    reason[str(e)] += 1
            result['preview'] = {'value': first, 'missing': missing, 'rows': rows,
                                 'reason': reason.most_common(1)[0][0] if reason else None}
        # Each grid: whether it can be made, and its cells in the latest sample of the first recording
        # (the one most like what's on screen now), for the Grid node's picture
        grids = []
        for g in request.get('grids') or []:
            try:
                one = Featurizer(schema, formulas=usable, grids=[g])  # the formulas, for a centre that's one
                spec, values, width, height = one.grids[0], None, None, None
                for n in reversed(range(len(frames))):
                    if frames[n] is None:
                        continue
                    try:
                        values = one.grid_cells(spec, frames[n], [frames[n], *(frames[n - k] if n >= k else None for k in range(1, one.depth + 1))])
                    except Missing:
                        continue
                    width, height = (spec['cols'] * spec['cell'], spec['rows'] * spec['cell']) if 'center' in spec else one.screen(frames[n], spec)
                    break
                grids.append({'name': spec['name'], 'cols': spec['cols'], 'rows': spec['rows'], 'error': None, 'values': values, 'centred': 'center' in spec,
                              'screen': [width, height] if values is not None else None})
            except ValueError as e:
                grids.append({'name': str(g.get('name', '')) if isinstance(g, dict) else '', 'error': str(e), 'values': None})
        fields = [{'name': f['name'], 'type': f['type']} for f in schema['fields']]
        return {'groups': featurize.groups() if featurize else [], 'fields': fields, 'formulas': results, 'grids': grids, 'error': error,
                'stepMs': step, 'suggestedStepMs': suggested, 'functions': functions_help(), 'maxHistory': MAX_HISTORY}

    def export(self, request):
        """Writes the chosen recordings as a dataset for any trainer: a CSV (a recording and timestamp
        column, then every input, then every button) or a NumPy .npz (X, y, timestamps, recordings,
        features, buttons), and beside it a JSON manifest naming every column and saying how it was made."""
        path = Path(request['path'])
        kind = path.suffix.lower()
        if kind not in ('.csv', '.npz'):
            raise ValueError('Export to a .csv or .npz file')
        data = self.dataset(request)
        featurize, history = data['featurize'], data['options']['history']
        features = featurize.names() + [f'{n}@-{k}' for k in range(1, history + 1) for n in featurize.history_names()]
        step = data['options']['stepMs']
        buttons = [b['id'] for b in data['outputs']]
        rows = [(rid, t, x, y) for rid, sequence in data['recordings'] for t, x, y in sequence]
        path.parent.mkdir(parents=True, exist_ok=True)
        if kind == '.csv':
            import csv
            with open(path, 'w', newline='', encoding='utf-8') as file:
                out = csv.writer(file)
                out.writerow(['recording', 'timestamp', *features, *(f'button.{b}' for b in buttons)])
                for rid, t, x, y in rows:
                    out.writerow([rid, t, *x, *(int(v) for v in y)])
        else:
            np.savez_compressed(path, X=np.array([x for *_, x, _ in rows], dtype=np.float32),
                                y=np.array([y for *_, y in rows], dtype=np.uint8),
                                timestamps=np.array([t for _, t, _, _ in rows], dtype=np.float64),
                                recordings=np.array([rid for rid, *_ in rows]),
                                features=np.array(features), buttons=np.array(buttons))
        manifest = {'version': 1, 'created': time.time(), 'file': path.name, 'format': kind[1:],
                    'samples': len(rows), 'stepMs': step, 'features': features, 'buttons': buttons,
                    'recordings': [rid for rid, _ in data['recordings']], 'skipped': data['skipped'],
                    'skippedReasons': data['skippedReasons'],
                    'options': data['options'], 'inputs': featurize.describe(),
                    'observationSchema': {k: v for k, v in data['observationSchema'].items() if k != 'definition'},
                    'actionSchema': data['actionSchema'],
                    'notes': f'Each recording is on an even grid of {step:g} ms: a row is a grid point, its timestamp the grid '
                             'time, made from the sample nearest it within half a step. Rows with a value missing (such as the '
                             'player not being found) are left out; skippedReasons counts why. Features are the numbers '
                             'FireFly\u2019s own policies see (worker/observations.py, formulas in worker/formulas.py); a name ending '
                             '@-k is the value k steps earlier. Buttons are 1 when held (actionDelayMs later, if set).'}
        manifest_path = path.with_suffix(path.suffix + '.json')
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf8')
        return {'path': str(path), 'manifest': str(manifest_path), 'samples': len(rows), 'stepMs': step,
                'features': len(features), 'buttons': len(buttons), 'skipped': data['skipped'],
                'skippedReasons': data['skippedReasons']}

    @staticmethod
    def _policy(request):
        """The named policy a training is a version of: {id, name}, from a Policy node."""
        p = request.get('policy')
        if p is None:
            return None
        if not isinstance(p, dict) or not str(p.get('id', '')).strip() or len(str(p.get('name', ''))) > 80:
            raise ValueError('A policy has an id and a name of up to 80 characters')
        return {'id': str(p['id']), 'name': str(p.get('name') or 'Policy')}

    def train(self, request):
        epochs, lr = int(request.get('epochs', 60)), float(request.get('learningRate', .003))
        if not 1 <= epochs <= 200 or not .00001 <= lr <= .1:
            raise ValueError('Epochs must be 1..200 and learning rate 0.00001..0.1')
        chosen_share = request.get('correctionShare')
        chosen_share = CORRECTION_SHARE if chosen_share is None else float(chosen_share)
        if not 0 <= chosen_share <= MAX_CORRECTION_SHARE:
            raise ValueError(f'The corrections\' share of training must be 0..{MAX_CORRECTION_SHARE:.0%}')
        data = self.dataset(request)
        ids, skipped = request['recordingIds'], data['skipped']
        observation_schema, action_schema, featurize = data['observationSchema'], data['actionSchema'], data['featurize']
        anchor, surface, near_px = data['options']['anchor'], data['options']['surface'], data['options']['nearPx']
        history, delay_ms, step = data['options']['history'], data['options']['actionDelayMs'], data['options']['stepMs']
        fixes = data['corrections']
        sequences = [[(x, y, rid in fixes) for _, x, y in sequence] for rid, sequence in data['recordings']]
        training, validation, split = split_sequences(sequences, {n for n, (rid, _) in enumerate(data['recordings']) if rid in fixes})
        torch.manual_seed(7)
        x = torch.tensor([r[0] for r in training], dtype=torch.float32)
        y = torch.tensor([r[1] for r in training], dtype=torch.float32)
        fix = torch.tensor([r[2] for r in training], dtype=torch.bool)
        vx = torch.tensor([r[0] for r in validation], dtype=torch.float32)
        vy = torch.tensor([r[1] for r in validation], dtype=torch.float32)
        mean, std = x.mean(0), x.std(0, unbiased=False).clamp_min(1e-6)
        x, vx = (x-mean)/std, (vx-mean)/std
        hidden = hidden_for(x.shape[1])
        network = policy(x.shape[1], y.shape[1], hidden)
        optimizer = torch.optim.Adam(network.parameters(), lr=lr)
        # Each epoch draws its rows so that the corrections are the chosen share of them (or more, if they
        # already are), the recordings the rest; without corrections, every row once, in a new order
        fixed = int(fix.sum())
        share = max(chosen_share, fixed / len(x)) if 0 < fixed < len(x) else fixed / len(x)
        draw = torch.where(fix, share / max(fixed, 1), (1 - share) / max(len(x) - fixed, 1)) if 0 < fixed < len(x) else None
        # A button pressed in 5% of samples would be learned as never pressed; weighting its presses by
        # how rarely it's pressed (at most 20x) makes missing one cost as much as pressing it wrongly.
        # How often is counted over the rows as they're drawn.
        rate = ((draw if draw is not None else torch.full((len(y),), 1 / len(y)))[:, None] * y).sum(0)
        pos_weight = ((1 - rate) / rate.clamp_min(1 / len(y))).clamp(1, 20)
        loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        run = str(uuid.uuid4())
        config = {'recordingIds': ids, 'epochs': epochs, 'learningRate': lr, 'split': split,
                  'anchor': anchor, 'surface': surface, 'nearPx': near_px, 'history': history,
                  'actionDelayMs': delay_ms, 'stepMs': step, 'skipped': skipped, 'skippedReasons': data['skippedReasons'],
                  'columns': featurize.columns, 'derived': featurize.derived, 'formulas': featurize.formula_sources,
                  'buttons': [b['id'] for b in data['outputs']], 'policy': self._policy(request),
                  'correctionShare': chosen_share}
        with self.db() as db:
            db.execute('INSERT INTO training_runs VALUES(?,?,?,?,?)', (run, 'running', json.dumps(config), '[]', None))
        metrics = []
        try:
            best_score, best_loss, best, best_buttons, best_learned = float('inf'), float('inf'), None, [], None
            for epoch in range(epochs):
                network.train()
                order = torch.multinomial(draw, len(x), replacement=True) if draw is not None else torch.randperm(len(x))
                for batch in order.split(64):
                    optimizer.zero_grad()
                    loss = loss_fn(network(x[batch]), y[batch])
                    loss.backward()
                    optimizer.step()
                network.eval()
                with torch.no_grad():
                    train_loss = float(loss_fn(network(x), y))
                    validation_logits = network(vx)
                    validation_loss = float(loss_fn(validation_logits, vy))
                    accuracy = float(((validation_logits >= 0) == (vy >= .5)).float().mean())
                    buttons = button_stats(validation_logits, vy, data['outputs'])
                    # How it does on the corrections: there's nothing of them to validate on (they're
                    # trained whole), so these are the rows it learned from, and what they say is whether
                    # it can do what it was shown. Never most of them means its values can't tell those
                    # moments from the recordings' (such as a portal no State shows).
                    if fixed:
                        fix_logits = network(x[fix])
                        fix_loss = float(loss_fn(fix_logits, y[fix]))
                        learned = float(((fix_logits >= 0) == (y[fix] >= .5)).all(1).float().mean())
                if not math.isfinite(train_loss + validation_loss):
                    raise ValueError('Nonfinite training loss')
                # The version kept does both: what the recordings it hadn't seen did, and the corrections, by their share
                score = (1 - share) * validation_loss + share * fix_loss if fixed else validation_loss
                if score < best_score:
                    best_score, best_loss, best_buttons = score, validation_loss, buttons
                    best_learned = learned if fixed else None
                    best = {key: value.detach().clone() for key, value in network.state_dict().items()}
                metric = {'epoch': epoch+1, 'loss': train_loss, 'validationLoss': validation_loss, 'buttonAccuracy': accuracy,
                          'buttonF1': sum(b['f1'] for b in buttons) / len(buttons),
                          **({'correctionsLearned': learned} if fixed else {})}
                metrics.append(metric)
                self.emit({'event': 'training', 'result': {'runId': run, **metric}})
            directory = self.root / 'models' / run
            directory.mkdir()
            torch.save({'state': best, 'mean': mean, 'std': std}, directory / 'checkpoint.pt')
            metadata = {'version': VERSION, 'id': run, 'created': time.time(), 'observationSchema': observation_schema,
                        'actionSchema': action_schema, 'outputs': [{'id': b['id'], 'vk': b['vk']} for b in data['outputs']],
                        'policy': config['policy'], 'inputSize': x.shape[1], 'outputSize': y.shape[1],
                        'trainingSamples': len(x), 'validationSamples': len(vx), 'config': config,
                        'features': featurize.describe(), 'history': history, 'stepMs': step,
                        'metrics': metrics, 'bestValidationLoss': best_loss, 'buttons': best_buttons,
                        'corrections': {'recordings': len(fixes), 'rows': fixed, 'share': share, 'learned': best_learned} if fixed else None,
                        'hidden': hidden, 'architecture': f'mlp{hidden}x{hidden}_multilabel'}
            temporary = directory / 'metadata.tmp'
            temporary.write_text(json.dumps(metadata, indent=2), encoding='utf8')
            temporary.replace(directory / 'metadata.json')
            with self.db() as db:
                db.execute('UPDATE training_runs SET status=?,metrics=?,model_id=? WHERE id=?', ('complete', json.dumps(metrics), run, run))
            return metadata
        except Exception:
            with self.db() as db:
                db.execute('UPDATE training_runs SET status=?,metrics=? WHERE id=?', ('failed', json.dumps(metrics), run))
            raise

    def list_models(self):
        """The newest 100 versions, newest first: their numbers (v1 the oldest) count by this order."""
        models = [json.loads(file.read_text(encoding='utf8')) for file in (self.root/'models').glob('*/metadata.json')]
        models.sort(key=lambda m: m.get('created', 0), reverse=True)
        for metadata in models[:100]:
            metadata.pop('metrics', None)
            metadata['observationSchema'].pop('definition', None)
        return models[:100]

    def deleted_models(self):
        """Deleted versions, each by the policy it was a version of: their corrections are still that
        policy's, and Train with corrections still uses them."""
        path = self.root / 'models' / 'deleted.json'
        return json.loads(path.read_text(encoding='utf8')) if path.exists() else {}

    def delete_model(self, request):
        """Deletes a trained version: its folder goes, and it's remembered with its policy (above)."""
        model_id = str(uuid.UUID(request['modelId']))
        directory = self.root / 'models' / model_id
        if not (directory / 'metadata.json').exists():
            raise ValueError('That policy version no longer exists')
        metadata = json.loads((directory / 'metadata.json').read_text(encoding='utf8'))
        if self.loaded is not None and self.loaded[1]['id'] == model_id:
            self.loaded, self.recent = None, []
        deleted = self.deleted_models()
        deleted[model_id] = (metadata.get('policy') or {}).get('id')
        temporary = self.root / 'models' / 'deleted.json.tmp'
        temporary.write_text(json.dumps(deleted), encoding='utf8')
        temporary.replace(self.root / 'models' / 'deleted.json')
        shutil.rmtree(directory)
        return {'deleted': model_id}

    def load(self, request):
        model_id = str(uuid.UUID(request['modelId']))
        directory = self.root/'models'/model_id
        metadata = json.loads((directory/'metadata.json').read_text(encoding='utf8'))
        if request['observationSchema'] != metadata['observationSchema']['identity'] or request['actionSchema'] != metadata['actionSchema']['identity']:
            raise ValueError('Model observation/action schema mismatch')
        if metadata['version'] != VERSION:
            raise ValueError('This policy was trained by an older FireFly, which saw its inputs differently; train it again')
        if not 1 <= metadata['inputSize'] <= MAX_INPUTS or not 1 <= metadata['outputSize'] <= 128:  # buttons (session.cpp)
            raise ValueError('Unsupported model metadata')
        checkpoint = torch.load(directory/'checkpoint.pt', map_location='cpu', weights_only=True)
        network = policy(metadata['inputSize'], metadata['outputSize'], metadata.get('hidden', 64))
        network.load_state_dict(checkpoint['state'])
        network.eval()
        described = metadata['features']
        featurize = Featurizer(metadata['observationSchema'], described.get('anchor'), described.get('surface', 'below'),
                               described.get('nearPx', 200), described.get('columns'), described.get('derived'),
                               described.get('formulas'), described.get('grids'))
        self.loaded = (network, metadata, checkpoint['mean'], checkpoint['std'], featurize)
        self.recent = []  # the samples just before, (timestamp, observations, features or Missing), for looking back
        return metadata

    def predict(self, request):
        if self.loaded is None:
            raise ValueError('Load a policy first')
        network, metadata, mean, std, featurize = self.loaded
        if request['observationSchema'] != metadata['observationSchema']['identity']:
            raise ValueError('Inference schema mismatch')
        t = float(request.get('timestamp', time.monotonic() * 1000))
        if self.recent and t <= self.recent[-1][0]:
            self.recent = []  # time went back: a new capture, not what led up to this
        step, history = metadata['stepMs'], metadata['history']
        # What was there k steps ago is found as in training: the sample nearest then, within half a step.
        # Detection in play can run slower than the step (a model beside template matching), and then
        # that often finds nothing, every frame failed and the policy pressed nothing at all: failing
        # that, the nearest sample up to a whole step further back (never nearer, which would make a step
        # shorter than it is), each step back an older sample than the last
        times = [r[0] for r in self.recent]
        earlier, before = [None], t
        for k in range(1, max(featurize.depth, history) + 1):
            older = [i for i, s in enumerate(times) if s < before]
            i = held(times, t - k * step, step)
            if i is None or i not in older:
                back = [j for j in older if t - (k + 1) * step <= times[j] <= t - k * step]
                i = max(back, key=lambda j: times[j]) if back else None
            earlier.append(self.recent[i] if i is not None else None)
            if i is not None:
                before = times[i]
        frame = {o['name']: o for o in request['observations']}
        size = request.get('frame')
        if isinstance(size, dict) and finite(size.get('w')) and finite(size.get('h')):
            frame['@frame'] = {'name': '@frame', 'valid': True, 'value': [size['w'], size['h']]}
        try:
            x = featurize(frame, [e[1] if e else None for e in earlier[1:featurize.depth + 1]])
        except Missing as e:
            x = e
        keep = t - (max(featurize.depth, history) + 2) * step
        self.recent = [r for r in self.recent if r[0] >= keep] + [(t, frame, x)]
        if isinstance(x, Missing):
            raise x
        for k in range(1, history + 1):
            e = earlier[k]
            if e is None or isinstance(e[2], Missing):
                raise Missing(f'Nothing usable {k} step{"s" if k > 1 else ""} earlier (history)')
            x = x + [e[2][i] for i in featurize.history_keep]
        x = torch.tensor(x, dtype=torch.float32)
        if len(x) != metadata['inputSize']:
            raise ValueError('Feature size mismatch')
        begin = time.perf_counter()
        with torch.no_grad():
            probabilities = torch.sigmoid(network((x-mean)/std)).tolist()
        if not all(math.isfinite(p) and 0 <= p <= 1 for p in probabilities):
            raise ValueError('Invalid inference output')
        return {'buttons': [p >= .5 for p in probabilities], 'probabilities': probabilities,
                'latencyMs': (time.perf_counter()-begin)*1000}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    def emit(value):
        print(json.dumps({'v': 1, 'id': 0, 'ok': True, **value}, allow_nan=False), flush=True)
    worker = Worker(args.root, emit)
    review = Review(worker)
    while True:
        line = sys.stdin.buffer.readline(1_048_577)
        if not line:
            break
        if len(line) > 1_048_576:
            break
        request_id = 0
        try:
            request = json.loads(line)
            request_id = request['id']
            if request['v'] != 1:
                raise ValueError('Protocol version mismatch')
            op = request['op']
            if op == 'health':
                result = {'torch': torch.__version__}
            elif op == 'train':
                result = worker.train(request)
            elif op == 'models':
                result = worker.list_models()
            elif op == 'models.delete':
                result = worker.delete_model(request)
            elif op == 'models.deleted':
                result = worker.deleted_models()
            elif op == 'load':
                result = worker.load(request)
            elif op == 'predict':
                result = worker.predict(request)
            elif op == 'export':
                result = worker.export(request)
            elif op == 'preview':
                result = worker.preview(request)
            elif op == 'columns':
                result = worker.columns(request)
            elif op.startswith('events.'):
                result = review.run(op, request)
            elif op == 'shutdown':
                break
            else:
                raise ValueError('Unknown worker operation')
            print(json.dumps({'v': 1, 'id': request_id, 'ok': True, 'result': result}, allow_nan=False), flush=True)
        except Exception as error:
            print(json.dumps({'v': 1, 'id': request_id, 'ok': False, 'error': str(error)}), flush=True)


if __name__ == '__main__':
    main()
