"""Versioned local behavior-cloning worker. No input injection or game reset API."""
from collections import Counter
from contextlib import contextmanager
import argparse
import bisect
import hashlib
import json
import math
import shutil
import sqlite3
import statistics
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from torch import nn

from formulas import MAX_HISTORY, FormulaSet, Missing, columns_of, functions_help
from shapes import finite
import executor as executor_
import planner as planner_
from observations import _frame as featurize_frame
from observations import goal_names
from observations import settle
from observations import HINDSIGHT, MAX_INPUTS, MAX_STEP_MS, MIN_STEP_MS, Featurizer, goal_numbers, held, on_grid, phases, suggested_step
from review import Review

torch.set_num_threads(2)

MAX_SAMPLES = 300000  # samples loaded at once, over the chosen recordings
MOVING_SHARE = 0.2    # an input whose shapes change between this share of samples moves (a plan's places aren't on it)
MAX_RECORDINGS = 2000  # recordings (corrections included) in one dataset
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


# A button the player taps, holding it a moment and letting go over and over (an attack the game makes once a press),
# is tapped the same way when a policy holds it, since holding it in such a game does it once: how long it was held
# each time and let go between, from what the player pressed in the recordings (taps_from_samples)
TAP_MAX_MS = 200     # held longer than this, most times, it's held, not tapped
TAP_MOST_MS = 300    # and three presses in four no longer than this: a key nudged often and held to walk isn't tapped
TAP_MAX_UP_MS = 250  # and let go longer than this between presses, it's pressed now and then (a turn, a step), not tapped
TAP_MIN_RUNS = 8     # this many presses at least, to tell


def _taps(series, buttons, gap_ms):
    """The buttons tapped, by id: {downMs, upMs}, the median time each press was held and the median time let go
    before the next (only pauses under a second, as between taps). series: lists of (t, held per button), each in
    time order; a step longer than gap_ms ends a press or a pause unmeasured."""
    taps = {}
    for i, button in enumerate(buttons):
        downs, ups = [], []
        for rows in series:
            run_start, last_t, last_held = None, None, None
            for t, y in rows:
                held = y[i] >= .5
                if last_t is not None and t - last_t > gap_ms:  # a gap: what was going on ends unmeasured
                    run_start, last_held = None, None
                if held != last_held:
                    if run_start is not None and last_held is not None:
                        (downs if last_held else ups).append(t - run_start)
                    run_start = t
                last_t, last_held = t, held
        ups = [u for u in ups if u < 1000]
        if len(downs) >= TAP_MIN_RUNS and ups:
            down, up = statistics.median(downs), statistics.median(ups)
            most = sorted(downs)[(3 * len(downs)) // 4]
            # A rhythm of short presses and short pauses: left and right pressed briefly to turn (about 280 ms, then
            # 390 let go) aren't tapped, nor are keys nudged often but held to walk (a jump quest's arrows: a median
            # nudge of 150 ms, but three presses in four up to 2.7 s), or walking would stutter
            if down <= TAP_MAX_MS and up <= TAP_MAX_UP_MS and most <= TAP_MOST_MS:
                taps[button['id']] = {'downMs': round(min(max(down, 40), TAP_MAX_MS)), 'upMs': round(min(max(up, 40), 500))}
    return taps


def taps_of(recordings, buttons, step):
    """Taps (see _taps) from rows on a grid of `step` ms: [(id, [(t, x, y)])]; a gap in the grid ends a press."""
    return _taps([[(t, y) for t, _, y in rows] for _, rows in recordings], buttons, 1.5 * step)


def taps_from_samples(loaded, buttons):
    """Taps (see _taps) from what the player pressed in the recordings' samples, whichever of them make rows: a
    dataset's rows have holes wherever a moment was left out (a goal with no target, a value missing), and a hold
    measured on them was cut into its last piece after each hole, so a jump quest's arrows, held for seconds, read
    as tapped and play stuttered along. A sample whose buttons don't count (the game not in front) ends a press."""
    series = []
    for _, samples in loaded:
        rows = []
        for sample in samples:
            actions = sample.get('actions') or {}
            if not actions.get('valid'):
                if rows:
                    series.append(rows)
                rows = []
                continue
            pressed = actions.get('buttons') or {}
            rows.append((sample['timestamp'], [1.0 if pressed.get(b['id']) else 0.0 for b in buttons]))
        if rows:
            series.append(rows)
    return _taps(series, buttons, 1000)


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
        self.trace = None  # what a playing policy sees, kept while it plays (see load)
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

    @staticmethod
    def _goal_request(goal):
        """A Goal as a dataset takes it: without what training works out again (the farthest target, a route's path,
        a plan's places and moves)."""
        if not isinstance(goal, dict):
            return goal
        out = {k: v for k, v in goal.items() if k not in ('cap', 'path')}
        if isinstance(out.get('plan'), dict):
            out['plan'] = {k: v for k, v in out['plan'].items() if k != 'graph'}
        return out

    @staticmethod
    def _key_events(db, rid):
        """A recording's raw key events, as planner._Keys takes them: the player's own presses and let-gos (not those
        another program sent, such as a playing policy's), and what was held when the game came to the front."""
        out = []
        try:
            rows = db.execute('SELECT data FROM inputs WHERE recording=? ORDER BY seq', (rid,)).fetchall()
        except sqlite3.OperationalError:  # a catalog without them
            return out
        for (data,) in rows:
            try:
                e = json.loads(data)
                t = float(e['timestamp'])
            except (ValueError, KeyError, TypeError):
                continue
            if e.get('kind') == 'button' and not e.get('injected') and isinstance(e.get('id'), str):
                out.append((t, e['id'], bool(e.get('down'))))
            elif e.get('kind') == 'focus' and isinstance(e.get('buttons'), dict):
                out.append((t, None, [b for b, on in e['buttons'].items() if on]))
        return out

    def _plan_samples(self, featurize, ids):
        """Each recording as [(t, x, y, level, keys)] for planner.learn, and where each ended (x, y, level); each one's
        raw key events in self._plan_events, in the same order."""
        goal = featurize.goal
        with self.db() as db:
            loaded = []
            for rid in ids:  # one at a time: recordings for moves needn't share a schema
                loaded += self._recordings(db, [rid])[0]
            self._plan_events = [self._key_events(db, rid) for rid, _ in loaded]
        series, ends, level_lines = [], {}, {}
        shapes = goal['plan'].get('places') == 'shapes'
        held = {}  # per recording: an input's lines when its States weren't read in a sample
        by_input = []  # along shapes, each recording's samples' lines by input, to tell the moving ones first
        for rid, samples in loaded:
            frames = [s['observations'] for s in samples]
            rows, inputs = [], []
            held = {}
            for n, sample in enumerate(samples):
                past = [frames[n - k] if n >= k else None for k in range(1, featurize.depth + 1)]
                try:
                    x, y = featurize._value(goal['position'], frames[n], [frames[n], *past], 'vector')[:2]
                except Missing:
                    continue
                actions = sample.get('actions') or {}
                keys = tuple(sorted(b for b, on in (actions.get('buttons') or {}).items() if on)) if actions.get('valid') else ()
                last_level = featurize.plan_level(frames[n])
                if shapes:
                    inputs.append({alias: json.dumps(lines) for alias, lines in featurize.plan_lines_by_input(frames[n], held).items()})
                    rows.append((sample['timestamp'], float(x), float(y), None, keys))
                else:
                    rows.append((sample['timestamp'], float(x), float(y), featurize.plan_level(frames[n]), keys))
            series.append(rows)
            by_input.append(inputs)
            if rows:
                ends[rid] = (rows[-1][1], rows[-1][2], last_level)
        self._plan_moving = []
        if shapes:
            # An input whose shapes change from one sample to the next more than now and then (monsters, items)
            # can't be where places are: a level's places would be made again every frame. Those are left out
            changes, pairs = Counter(), 0
            for inputs in by_input:
                for a, b in zip(inputs, inputs[1:]):
                    pairs += 1
                    for alias in a:
                        changes[alias] += a[alias] != b.get(alias)
            self._plan_moving = sorted(alias for alias, n in changes.items() if pairs and n / pairs > MOVING_SHARE)
            for rows, inputs in zip(series, by_input):
                for i, (row, lines) in enumerate(zip(rows, inputs)):
                    kept = [(alias, points) for alias, text in lines.items() if alias not in self._plan_moving for points in json.loads(text)]
                    # the same object for samples whose lines are alike, so a level's places are made once
                    rows[i] = (row[0], row[1], row[2], level_lines.setdefault(json.dumps(kept), kept), row[4])
        return series, ends

    def _learn_plan(self, featurize, goal, policy_ids):
        """A plan's places and moves, learned from its recordings (else the policy's); trained again after they were
        deleted, it keeps what it learned."""
        plan = featurize.goal['plan']
        ids = plan.get('recordings') or list(policy_ids)
        with self.db() as db:
            gone = [rid for rid in ids if not db.execute("SELECT 1 FROM recordings WHERE id=? AND status='complete'", (rid,)).fetchone()]
        stored = (goal.get('plan') or {}).get('graph') if isinstance(goal, dict) else None
        if gone and stored:
            plan['graph'] = stored
            settle(plan)
            plan['destination'] = {**plan['destination'], **{k: v for k, v in (goal['plan'].get('destination') or {}).items() if k in ('x', 'y', 'level')}}
            return
        ids = [rid for rid in ids if rid not in gone]
        if not ids:
            raise ValueError(f'{featurize.goal["name"]}: the recordings its plan learns from are gone: choose others')
        kept = self._plan_kept(featurize, ids)
        if kept:
            plan['graph'], ends = kept['graph'], {rid: tuple(e) for rid, e in kept['ends'].items()}
            settle(plan)
            self._resolve_end(featurize, plan, ends)
            return
        series, ends = self._plan_samples(featurize, ids)
        if plan.get('places') == 'shapes':
            moves = self._learn_moves(plan, series)
            plan['graph'] = {'moves': moves, 'levels': len({id(r[3]) for rows in series for r in rows}), 'moving': self._plan_moving}
            if not moves['along'] and not moves['hops']:
                raise ValueError(f'{featurize.goal["name"]}: no moves along its shapes in the recordings it learns from (is the player within {plan["snap"]:g} px of them?)')
        else:
            plan['graph'] = planner_.learn(series, plan['cell'])
        if plan.get('places') != 'shapes' and not plan['graph']['moves']:
            raise ValueError(f'{featurize.goal["name"]}: no moves in the recordings its plan learns from ({featurize.goal["position"]} isn’t in them, or never moved)')
        self._plan_keep(featurize, ids, plan['graph'], ends)
        self._resolve_end(featurize, plan, ends)

    # What a plan learned, kept on disk (<root>/plans/<hash>.json) by what it was learned from: reading every sample of
    # its recordings again (121 recordings took 20 s, every sample holding a whole level's shapes) held Play up, while
    # the Planner's preview had learned the same already
    def _plan_key(self, featurize, ids):
        p = featurize.goal['plan']
        # the position's formula, if it's one (the preview knows every formula of the graph, a version only its own)
        position = featurize.formulas.entries.get(featurize.goal['position'])
        what = [sorted(ids), featurize.goal['position'], {k: p.get(k) for k in ('places', 'cell', 'snap', 'tolerance', 'level', 'inputs', 'auto')},
                position and [position.get('source'), position.get('inputs')], 13]
        return hashlib.sha256(json.dumps(what, sort_keys=True, default=str).encode()).hexdigest()[:32]

    def _learn_moves(self, plan, series, raw=None):
        """A plan's moves along shapes (planner.learn_moves, with the recordings' key events), its snap and tolerance
        left to work out (`auto`) as the defaults at the game's own scale: learned at the defaults, and again at the
        game's scale when that's more than a tenth off. What they came to is kept with the moves (`settings`)."""
        moves = planner_.learn_moves(series, plan['cell'], plan['snap'], plan['tolerance'], raw, events=self._plan_events)
        auto = plan.get('auto') or []
        if auto and (moves.get('scale') or {}).get('jump'):
            scale = planner_.Scale(moves)
            worked = {k: round(scale.px({'snap': planner_.SNAP, 'tolerance': planner_.TOLERANCE}[k]), 1) for k in auto}
            if any(abs(worked[k] - plan[k]) > 0.1 * plan[k] for k in auto):
                plan.update(worked)
                if raw is not None:
                    raw.clear()
                moves = planner_.learn_moves(series, plan['cell'], plan['snap'], plan['tolerance'], raw, events=self._plan_events)
        moves['settings'] = {'snap': plan['snap'], 'tolerance': plan['tolerance']}
        return moves

    def _plan_kept(self, featurize, ids):
        try:
            return json.loads((self.root / 'plans' / f'{self._plan_key(featurize, ids)}.json').read_text(encoding='utf8'))
        except (OSError, ValueError):
            return None

    def _plan_keep(self, featurize, ids, graph, ends):
        try:
            folder = self.root / 'plans'
            folder.mkdir(exist_ok=True)
            path = folder / f'{self._plan_key(featurize, ids)}.json'
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'graph': graph, 'ends': ends}), encoding='utf8')
            temporary.replace(path)
        except OSError:
            pass

    def _resolve_end(self, featurize, plan, ends):
        """A destination where a recording ended, as the point it ended at."""
        dest = plan['destination']
        if dest['kind'] == 'end':
            if dest['recording'] not in ends:
                with self.db() as db:
                    _, more = self._plan_samples(featurize, [dest['recording']]) if db.execute('SELECT 1 FROM recordings WHERE id=?', (dest['recording'],)).fetchone() else (None, {})
                ends.update(more)
            if dest['recording'] not in ends:
                raise ValueError(f'{featurize.goal["name"]}: the recording whose end play heads for is gone: choose another')
            x, y, level = ends[dest['recording']]
            plan['destination'] = {**dest, 'x': x, 'y': y, **({'level': level} if level is not None else {})}

    def planner_preview(self, request):
        """A Planner node's picture: the places and moves it learned (from request['recordings'], else the
        policy's), on the level of a sample (the one given, such as what FireFly observes now, else where the first
        recording ended), and the way from there to its destination, with the target and the next move."""
        goal = request['goal']
        ids = (goal.get('plan') or {}).get('recordings') or request.get('recordingIds') or []
        if not ids:
            raise ValueError('Choose the recordings it learns from')
        with self.db() as db:  # what the first recording observed, from its metadata (not its samples: whole levels of shapes each)
            row = db.execute('SELECT metadata FROM recordings WHERE id=?', (ids[0],)).fetchone()
        if not row:
            raise ValueError('A recording it learns from no longer exists (it was deleted)')
        schema = json.loads(row[0])['observationSchema']
        known = {f['name'] for f in schema['fields']}
        schema = {**schema, 'fields': [*schema['fields'], *(f for f in request.get('fields') or [] if f['name'] not in known)]}
        formulas = FormulaSet(request.get('formulas'), schema['fields'])
        usable = [{'name': e['name'], 'source': e['source'], **({'inputs': e['inputs']} if e['inputs'] else {})} for e in formulas.ok()]
        # Before a destination is chosen it's drawn without a way there (the map is where one is clicked)
        chosen = isinstance(goal.get('plan'), dict) and goal['plan'].get('destination') is not None
        if not chosen:
            goal = {**goal, 'plan': {**goal['plan'], 'destination': {'kind': 'point', 'x': 0, 'y': 0}}}
        featurize = Featurizer(schema, formulas=usable, goal=self._goal_request(goal))
        spec = featurize.goal['plan']
        shapes = spec.get('places') == 'shapes'
        key = json.dumps([ids, featurize.goal['position'], spec.get('level'), spec['cell'], spec.get('inputs'), spec.get('snap'), spec.get('tolerance'),
                          spec.get('auto'), usable], sort_keys=True)
        cache = self.__dict__.setdefault('_plan_cache', {})
        if key not in cache:
            series, ends = self._plan_samples(featurize, ids)
            if shapes:
                raw = []
                moves = self._learn_moves(spec, series, raw)
                coverage = self._plan_coverage(series, spec) if len(series) >= 2 else None
                cache.clear()
                cache[key] = ({'moves': moves, 'levels': len({id(r[3]) for rows in series for r in rows}), 'moving': self._plan_moving}, ends, series, coverage)
            else:
                cache.clear()
                cache[key] = (planner_.Planner(planner_.learn(series, spec['cell'])), ends, series, None)
        plan, ends, series, coverage = cache[key]
        if not self._plan_kept(featurize, ids):  # for Play, which learns from the same recordings
            self._plan_keep(featurize, ids, plan if shapes else {'cell': plan.cell, 'places': plan.places, 'moves': plan.moves}, ends)
        if shapes:
            spec['graph'] = plan
            settle(spec)
        else:
            spec['graph'] = {'cell': plan.cell, 'places': plan.places, 'moves': plan.moves}
            featurize._planner = plan
        dest_spec = featurize.goal['plan']['destination']
        if dest_spec['kind'] == 'end' and dest_spec.get('recording') in ends:
            x, y, level = ends[dest_spec['recording']]
            featurize.goal['plan']['destination'] = {**dest_spec, 'x': x, 'y': y}
        sample = request.get('observations')
        position = level = destination = None
        error = None
        lines = None
        if sample is not None:
            values = {o['name']: o for o in sample}
            try:  # the position alone: the Goal's facing may look a step back, which one sample hasn't
                position = tuple(float(v) for v in featurize._value(featurize.goal['position'], values, [values], 'vector')[:2])
            except Missing as e:
                error = str(e)
            level = featurize.plan_level(values)
            if shapes:
                lines = featurize.plan_lines(values)
        else:
            last = next((rows[-1] for rows in reversed(series) if rows), None)
            values = None
            if last:
                position, level = (last[1], last[2]), last[3]
                if shapes:
                    # the level that sample was on, by the Level observation, for a destination clicked on it
                    lines, level = last[3], (list(ends.values())[-1][2] if ends else None)
        if shapes:
            plan = planner_.level_planner(lines or [], spec['graph']['moves'], spec['cell'], spec['snap'], spec['tolerance'], spec.get('solid'), spec.get('physics'))
            featurize._planner, featurize._plan_level = plan, json.dumps(lines or [])
        try:
            destination = featurize.plan_destination(values or {}, [values or {}]) if chosen else None
        except Missing as e:
            error = error or str(e)
        # along shapes a level's places are its own lines' (no level key); on a grid, the Level's value
        picture = plan.picture(None if shapes else level, position, destination, 1000 * featurize.goal['plan']['aheadS'])
        if position is not None and destination is not None and not picture.get('path'):
            # where it got stuck: the place it took the player to be at, and how far the moves from there get
            s = plan.stuck(None if shapes else level, position, destination)
            error = error or ('No move you’ve made leads from here to the destination' + (
                f" (you're at ({position[0]:.0f}, {position[1]:.0f}), its place ({s['at'][0]}, {s['at'][1]}); from there its moves reach "
                f"{s['reach']} place{'s' if s['reach'] != 1 else ''}, the nearest to the destination ({s['nearest'][0]}, {s['nearest'][1]}), "
                f"{s['short']} px short)" if s else ''))
            out_stuck = s
        else:
            out_stuck = None
        out = {**picture, 'position': list(position) if position else None, 'destination': list(destination) if destination else None,
               'level': level, 'recordings': len(series), 'error': error, 'stuck': out_stuck}
        if shapes:
            # the shapes it planned over, the same sample's, to draw under its places
            out['shapes'] = [[alias, [[round(x, 1), round(y, 1)] for x, y in points]] for alias, points in (lines or [])][:3000]
            moves = spec['graph']['moves']
            out['library'] = {'along': sum(len(w) for w in moves['along'].values()), 'hops': len(moves['hops']),
                              'levels': spec['graph']['levels'], 'coverage': coverage,
                              # the game's scale, and what snap and tolerance came to
                              'scale': moves.get('scale'), 'snap': spec['snap'], 'tolerance': spec['tolerance'],
                              # whether platforms were taken as solid from below, and what the recordings showed
                              'solid': planner_.solid_of(moves, spec.get('solid')), 'through': moves.get('through'),
                              # the movement measured, and as used (with what's set in its place; None: jumps as recorded)
                              'physics': moves.get('physics'), 'physicsUsed': getattr(plan, 'physics', None)}
            out['moving'] = spec['graph'].get('moving') or []
            if not picture['places']:
                out['error'] = out['error'] or 'None of its shapes here: tick the inputs the player can be on'
        return out

    def drive_load(self, request):
        """The Planner node's Drive (executor.py): the planner moves the player along its way, doing each hop as the
        player once did. Takes what its preview does (the Goal with its plan along shapes, the recordings, fields and
        formulas); returns the buttons it may press (any it learned a move with) and the recordings' action schema."""
        goal = request['goal']
        plan = goal.get('plan') if isinstance(goal, dict) else None
        if not isinstance(plan, dict) or plan.get('places') != 'shapes':
            raise ValueError('Drive plans along shapes: set the Planner’s Places to Along shapes')
        if plan.get('destination') is None:
            raise ValueError('Choose where to go first: click its map, or wire a position into its Destination')
        ids = plan.get('recordings') or request.get('recordingIds') or []
        if not ids:
            raise ValueError('Choose the recordings it learns from')
        with self.db() as db:
            row = db.execute('SELECT metadata FROM recordings WHERE id=?', (ids[0],)).fetchone()
        if not row:
            raise ValueError('A recording it learns from no longer exists (it was deleted)')
        metadata = json.loads(row[0])
        schema = metadata['observationSchema']
        known = {f['name'] for f in schema['fields']}
        schema = {**schema, 'fields': [*schema['fields'], *(f for f in request.get('fields') or [] if f['name'] not in known)]}
        formulas = FormulaSet(request.get('formulas'), schema['fields'])
        usable = [{'name': e['name'], 'source': e['source'], **({'inputs': e['inputs']} if e['inputs'] else {})} for e in formulas.ok()]
        featurize = Featurizer(schema, formulas=usable, goal=self._goal_request(goal))
        self._learn_plan(featurize, goal, ids)
        moves = featurize.goal['plan']['graph']['moves']
        used, examples = set(), 0
        for ways in moves['along'].values():
            for way in ways.values():
                used |= set(way['keys'])
        for hop in moves['hops']:
            used |= set(hop['keys'])
            for e in hop.get('examples') or []:
                examples += 1
                used |= set(e['keys']) | {key for _, key, _ in e['timeline']}
        if moves['hops'] and not examples:
            raise ValueError('None of its hops has the keys you pressed for it: its recordings are from before FireFly kept them, so record again')
        buttons = [{'id': b['id'], 'vk': b['vk']} for b in metadata['actionSchema']['buttons'] if b['id'] in used]
        self.driving = {'featurize': featurize, 'executor': executor_.Executor(), 'buttons': [b['id'] for b in buttons]}
        # what it does each frame (where the player was, what it planned and pressed), in <root>/traces/drive/<when>.jsonl
        self.close_trace()
        folder = self.root / 'traces' / 'drive'
        folder.mkdir(parents=True, exist_ok=True)
        self.trace = open(folder / f"{time.strftime('%Y-%m-%d %H-%M-%S')}.jsonl", 'w', encoding='utf8')
        self.trace.write(json.dumps({'version': 1, 'drive': True, 'buttons': self.driving['buttons'], 'destination': featurize.goal['plan']['destination']}) + '\n')
        return {'buttons': buttons, 'actionSchema': metadata['actionSchema'], 'hops': len(moves['hops']), 'examples': examples,
                'trace': self.trace.name}

    def drive_step(self, request):
        """One frame of driving: the buttons to hold (in drive_load's order) and what it's doing. `ageMs`, how long
        after the frame's capture its keys will be pressed."""
        d = getattr(self, 'driving', None)
        if not d:
            raise ValueError('Not driving: press Drive again')
        f, ex = d['featurize'], d['executor']
        values = {o['name']: o for o in request.get('observations') or []}
        t = float(request['timestamp'])
        now = t + max(0.0, float(request.get('ageMs') or 0))
        try:
            x, y = f._value(f.goal['position'], values, [values], 'vector')[:2]
            planner = f.plan_planner(values)
            destination = f.plan_destination(values, [values])
        except Missing as e:
            ex.hop = None
            return {'buttons': [False] * len(d['buttons']),
                    'status': {'phase': 'missing', 'text': str(e), 'done': ex.done, 'missed': ex.missed, 'misses': ex.misses}}
        away = f.plan_away(values, planner) if f.goal['plan'].get('avoid') else None
        keys, status = ex.step(t, now, float(x), float(y), planner, destination, away)
        if self.trace is not None:
            self.trace.write(json.dumps({'t': round(t, 1), 'now': round(now, 1), 'x': round(float(x), 1), 'y': round(float(y), 1),
                                         'keys': sorted(keys), 'phase': status['phase'], 'text': status['text'], 'hop': status.get('hop'),
                                         'here': ex.here, 'next': ex.route_head}) + '\n')
            self.trace.flush()
        return {'buttons': [b in keys for b in d['buttons']], 'status': status}

    @staticmethod
    def _plan_coverage(series, spec, most=6):
        """How many of each recording's hops the moves of the others plan (up to `most` recordings): {hops, replayed}."""
        hops = replayed = 0
        for n in range(min(most, len(series))):
            raw = []
            planner_.learn_moves([series[n]], spec['cell'], spec['snap'], spec['tolerance'], raw)
            if not raw:
                continue
            others = planner_.learn_moves(series[:n] + series[n + 1:], spec['cell'], spec['snap'], spec['tolerance'])
            hops += len(raw)
            replayed += planner_.replays(others, raw, spec['cell'], spec['snap'], spec['tolerance'], spec.get('solid'))
        return {'hops': hops, 'replayed': replayed} if hops else None

    def _route_path(self, featurize, goal):
        """A Goal's route, the way play follows: where its position was in the route's recording, [ms from its start,
        x, y] by time. A version trained again after that recording was deleted follows the path it kept."""
        name, rid = goal['name'], goal['route']['recording']
        with self.db() as db:
            row = db.execute('SELECT status FROM recordings WHERE id=?', (rid,)).fetchone()
            if not row or row[0] != 'complete':
                if goal.get('path'):
                    return goal['path']
                raise ValueError(f'{name}: the recording whose route play follows is gone, or not complete: choose another')
            (_, samples), = self._recordings(db, [rid])[0]
        # Only where its position was: not its facing, which needn't be there (a facing formula looking a step back),
        # with the samples before for a position that's such a formula
        path, frames = [], [s['observations'] for s in samples]
        for n, sample in enumerate(samples):
            past = [frames[n - k] if n >= k else None for k in range(1, featurize.depth + 1)]
            try:
                x, y = featurize._value(goal['position'], frames[n], [frames[n], *past], 'vector')[:2]
            except Missing:
                continue
            path.append([round(sample['timestamp'] - samples[0]['timestamp'], 1), round(x, 1), round(y, 1)])
        if len(path) < 2:
            raise ValueError(f'{name}: {goal["position"]} isn’t in the recording whose route play follows')
        return path

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
        # Corrections are recordings of their own, a few seconds each, and a policy played for a while has hundreds:
        # what limits a dataset is MAX_SAMPLES, over all of them
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_RECORDINGS or len(set(ids)) != len(ids):
            raise ValueError(f'Select 1..{MAX_RECORDINGS} distinct recordings')
        anchor = request.get('anchor') or None
        surface, near_px = request.get('surface', 'below'), request.get('nearPx', 200)
        history = int(request.get('history', 2))
        delay_ms = float(request.get('actionDelayMs', 0))
        if not 0 <= history <= 4 or not 0 <= delay_ms <= 1000:
            raise ValueError('History must be 0..4 steps and the action delay 0..1000 ms')
        with self.db() as db:
            loaded, observation_schema, action_schema = self._recordings(db, ids)
            # Every key the player pressed, to the millisecond (a recording's raw key events): a row's buttons are those
            # held at its sample and any pressed since the step before, so a press between two samples, or in a sample
            # another was nearer the time step than, still counts (1-2% of the user's presses reached no row)
            presses = {rid: [(t, key) for t, key, down in self._key_events(db, rid) if key is not None and down] for rid, _ in loaded}
            # Recorded while a version played, as the player corrected it (play.cjs)
            corrections = {rid for (rid,) in db.execute(
                f"SELECT id FROM recordings WHERE json_extract(metadata,'$.correction') AND id IN ({','.join('?' * len(ids))})", ids)}
        goal_request = self._goal_request(request.get('goal'))
        columns = request.get('columns')
        if isinstance(goal_request, dict) and goal_request.get('hint'):
            # the plan's next move, per button the policy presses, each a column of its own (kept with the others)
            goal_request = {**goal_request, 'hint': {'buttons': [b['id'] for b in self._outputs(request, action_schema)]}}
            if columns is not None:
                columns = list(columns) + [n for n in goal_names({**goal_request, 'name': str(goal_request.get('name', '')).strip()})[3:] if n not in columns]
        featurize = Featurizer(observation_schema, anchor, surface, near_px, columns,
                               request.get('derived'), request.get('formulas'), request.get('grids'), request.get('spatial'),
                               # Without the farthest target a version trained on, and the route it followed, since
                               # they're worked out again
                               goal_request)
        if featurize.goal and 'route' in featurize.goal:
            featurize.goal['path'] = self._route_path(featurize, request['goal'])
        if featurize.goal and 'plan' in featurize.goal:
            self._learn_plan(featurize, request['goal'], ids)
        featurize.goal_reach = 0.0  # the farthest a hindsight target went, which play's targets are kept within
        # Measured from where the player faces (forward, ahead, behind), a policy needs that facing as a value, or it can't
        # tell whether ahead is the left key or the right (one without it walked left whatever its plan said)
        chosen = request.get('columns')
        if chosen is not None:
            for what, facing in [(featurize.goal or {}).get('name'), (featurize.goal or {}).get('facing')], *[(sp['name'], sp.get('facing')) for sp in featurize.spatial]:
                if what and facing and facing not in chosen:
                    raise ValueError(f'{what} is measured from {facing} (ahead is the way it faces), which isn’t one of its values: '
                                     f'add {facing} to the values, or it can’t tell whether ahead is left or right')
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
                                       delay_steps, delay_ms, buttons, reasons, current, presses.get(recording_id))
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
        if featurize.goal and featurize.goal_reach:
            featurize.goal['cap'] = round(featurize.goal_reach, 1)
        options = {'anchor': anchor, 'surface': surface, 'nearPx': near_px, 'history': history, 'actionDelayMs': delay_ms,
                   'stepMs': step, 'columns': featurize.columns, 'derived': featurize.derived, 'formulas': featurize.formula_sources, 'grids': featurize.grids,
                   'spatial': featurize.spatial, 'goal': featurize.goal, 'buttons': [b['id'] for b in buttons]}
        used = {rid for rid, _ in recordings}
        return {'recordings': recordings, 'skipped': skipped, 'skippedReasons': dict(reasons.most_common()),
                'corrections': {rid for rid, _ in recordings if rid in corrections},
                'samples': total, 'observationSchema': observation_schema, 'actionSchema': action_schema,
                'outputs': buttons, 'featurize': featurize, 'options': options,
                'taps': taps_from_samples([(rid, samples) for rid, samples in loaded if rid in used], buttons)}

    @staticmethod
    def _rows(samples, grid, t0, step, featurize, history, delay_steps, delay_ms, buttons, reasons, current, presses=None):
        """One grid's rows, (time, features with their history, buttons held), and what was skipped, by
        reason. `current` holds the samples already the current one of a row on another grid: a sample
        near two grids' points is one row, not two."""
        frames = [samples[i]['observations'] if i is not None else None for i in grid]
        times = [t for t, _ in presses] if presses else []
        xs, origins = [], []
        goal = featurize.goal
        for n, i in enumerate(grid):
            if i is None:
                xs.append(None)
                origins.append(None)
                continue
            past = [frames[n - k] if n >= k else None for k in range(1, featurize.depth + 1)]
            try:
                xs.append(featurize(frames[n], past, goal=HINDSIGHT))
            except Missing as e:
                xs.append(e)
            # With a Goal, where each step's player was, for the steps before it to aim at
            origin = None
            if goal:
                try:
                    origin = featurize.goal_origin(featurize_frame(frames[n]), [featurize_frame(f) for f in [frames[n], *past]])
                except Missing:
                    pass
            origins.append(origin)
        # A Goal's targets for a step: where the player was this many steps later, evenly from the shortest look-ahead
        # to the longest (the middle with one target)
        if goal:
            low, high = goal['lookAhead']
            count = goal['targets']
            aheads = sorted({max(1, round(1000 * (low + (high - low) * (k / (count - 1) if count > 1 else .5)) / step)) for k in range(count)})

        def labels(n):
            i = grid[n] if 0 <= n < len(grid) else None
            if i is None or not samples[i]['actions'].get('valid'):
                return None
            states = samples[i]['actions']['buttons']
            if any(type(states.get(b['id'])) is not bool for b in buttons):
                raise ValueError('Invalid recorded button state')
            out = [float(states[b['id']]) for b in buttons]
            if presses:  # and every key pressed since the step before, held at its sample or not
                t = samples[i]['timestamp']
                since = {key for _, key in presses[bisect.bisect_right(times, t - step):bisect.bisect_right(times, t)]}
                out = [1.0 if b['id'] in since else v for b, v in zip(buttons, out)]
            return out
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
            row = xs[n] + [x[i] for x in earlier for i in keep]
            if not goal:
                sequence.append((round(t0 + n * step, 3), row, y))
                continue
            # One row for each target the player reached from here (hindsight): the same moment and buttons, aiming
            # where they got to. Targets they hardly moved toward teach nothing about getting anywhere, and are left out
            if origins[n] is None:
                reasons[f'{goal["name"]}: its position isn’t there'] += 1
                continue
            made = 0
            for ahead in aheads:
                later = origins[n + ahead] if n + ahead < len(origins) else None
                if later is None or math.hypot(later[0][0] - origins[n][0][0], later[0][1] - origins[n][0][1]) < goal['minMove']:
                    continue
                numbers = goal_numbers(goal, origins[n][0], later[0], origins[n][1])
                featurize.goal_reach = max(featurize.goal_reach, numbers[2])
                if 'hint' in goal:  # the plan's next move toward where the player got to
                    numbers = numbers + featurize.plan_hint(featurize_frame(frames[n]), origins[n][0], later[0])
                aimed = list(row)
                for slot, value in zip(featurize.goal_slots, numbers):
                    if slot is not None:
                        aimed[slot] = value
                sequence.append((round(t0 + n * step, 3), aimed, y))
                made += 1
            if not made:
                reasons[f'{goal["name"]}: no target in its look-ahead {goal["minMove"]:g} px or more away'] += 1
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
        # Each Spatial node: whether it can be made, its columns, and their values in the latest sample of the
        # first recording that has them, for the node's table
        spatials = []
        for g in request.get('spatial') or []:
            try:
                one = Featurizer(schema, formulas=usable, spatial=[g])  # the formulas, for a point that's one
                spec, item, values, drawn = one.spatial[0], one.items[-1], None, None
                for n in reversed(range(len(frames))):
                    if frames[n] is None:
                        continue
                    past = [frames[n], *(frames[n - k] if n >= k else None for k in range(1, one.depth + 1))]
                    try:
                        values = one.spatial_values(spec, frames[n], past)
                        drawn = one.spatial_picture(spec, frames[n], past)
                        break
                    except Missing:
                        continue
                spatials.append({'name': spec['name'], 'columns': item['names'], 'values': values, 'picture': drawn, 'error': None})
            except ValueError as e:
                spatials.append({'name': str(g.get('name', '')) if isinstance(g, dict) else '', 'columns': [], 'values': None, 'error': str(e)})
        # Each Goal node: whether it can be made, its columns, and in the latest sample how far the player was from
        # its Target (what play would aim at) and how far they went in its look-ahead (what training aims at)
        goals = []
        for g in request.get('goals') or []:
            try:
                one = Featurizer(schema, formulas=usable, goal=g)
                spec, values, moved = one.goal, None, None
                for n in reversed(range(len(frames))):
                    if frames[n] is None:
                        continue
                    past = [frames[n], *(frames[n - k] if n >= k else None for k in range(1, one.depth + 1))]
                    try:
                        values = one.goal_values(featurize_frame(frames[n]), past) if 'target' in spec else None
                    except Missing:
                        pass
                    try:
                        here = one.goal_origin(featurize_frame(frames[n]), past)[0]
                    except Missing:
                        continue
                    # Where the player was its look-ahead later, along the recording
                    later = [m for m in range(n + 1, len(frames)) if frames[m] is not None and step * (m - n) <= 1000 * spec['lookAhead'][1]]
                    for m in reversed(later):
                        try:
                            there = one.goal_origin(featurize_frame(frames[m]), [frames[m]])[0]
                            moved = round(math.hypot(there[0] - here[0], there[1] - here[1]), 1)
                            break
                        except Missing:
                            continue
                    if values is not None or moved is not None or n < len(frames) // 2:
                        break
                goals.append({'name': spec['name'], 'columns': one.items[-1]['names'], 'values': values, 'moved': moved, 'error': None})
            except ValueError as e:
                goals.append({'name': str(g.get('name', '')) if isinstance(g, dict) else '', 'columns': [], 'values': None, 'error': str(e)})
        fields = [{'name': f['name'], 'type': f['type']} for f in schema['fields']]
        return {'groups': featurize.groups() if featurize else [], 'fields': fields, 'formulas': results, 'grids': grids, 'spatial': spatials,
                'goals': goals, 'error': error,
                'stepMs': step, 'suggestedStepMs': suggested, 'functions': functions_help(), 'maxHistory': MAX_HISTORY}

    def spatial_sample(self, request):
        """A Spatial node (request['spatial']) measured and drawn on one sample, such as what FireFly observes now:
        its observations (as the runtime's observations event gives them, tracked ones included) and frame size.
        fields: every observation's type; formulas: those its point or facing can come from. A point that isn't
        there is an error, not a skipped row: {columns, values: None, picture: None, error}."""
        fields = [{'name': f['name'], 'type': f['type']} for f in request.get('fields') or []
                  if isinstance(f, dict) and isinstance(f.get('name'), str) and isinstance(f.get('type'), str)]
        schema = {'identity': '', 'fields': fields}
        usable = [{'name': e['name'], 'source': e['source'], **({'inputs': e['inputs']} if e['inputs'] else {})}
                  for e in FormulaSet(request.get('formulas'), fields).ok()]
        one = Featurizer(schema, formulas=usable, spatial=[request['spatial']])
        spec, item = one.spatial[0], one.items[-1]
        values = {o['name']: o for o in request.get('observations') or [] if isinstance(o, dict) and isinstance(o.get('name'), str)}
        size = request.get('frame')
        if isinstance(size, dict) and finite(size.get('w')) and finite(size.get('h')):
            values['@frame'] = {'name': '@frame', 'valid': True, 'value': [size['w'], size['h']]}
        try:
            return {'name': spec['name'], 'columns': item['names'], 'values': one.spatial_values(spec, values, [values]),
                    'picture': one.spatial_picture(spec, values, [values]), 'error': None}
        except Missing as e:
            return {'name': spec['name'], 'columns': item['names'], 'values': None, 'picture': None, 'error': str(e)}

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
                        'hidden': hidden, 'architecture': f'mlp{hidden}x{hidden}_multilabel',
                        'taps': data['taps']}
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
        # Where play heads is the graph's now (request['goal']: its Goal's target, route or plan), not what was saved
        # when it trained: the network learned from where the player went, whatever play aims at, so a destination
        # or planner changed since needs no training again. A plan's places and moves are learned now
        goal, override = described.get('goal'), request.get('goal')
        if goal and isinstance(override, dict) and any(override.get(k) is not None for k in ('target', 'route', 'plan')):
            goal = {**{k: v for k, v in goal.items() if k not in ('target', 'route', 'path', 'plan')},
                    **{k: override[k] for k in ('target', 'route', 'plan') if override.get(k) is not None}}
        else:
            override = None
        featurize = Featurizer(metadata['observationSchema'], described.get('anchor'), described.get('surface', 'below'),
                               described.get('nearPx', 200), described.get('columns'), described.get('derived'),
                               described.get('formulas'), described.get('grids'), described.get('spatial'),
                               self._goal_request(goal) if override else goal)
        if override and 'route' in featurize.goal:
            featurize.goal['path'] = self._route_path(featurize, goal)
        if override and 'plan' in featurize.goal:
            self._learn_plan(featurize, goal, metadata['config']['recordingIds'])
        self.loaded = (network, metadata, checkpoint['mean'], checkpoint['std'], featurize)
        self.recent = []  # the samples just before, (timestamp, observations, features or Missing), for looking back
        self.close_trace()
        if request.get('trace'):
            # Every frame it's asked about, with the numbers it saw and how sure it was of each button, so its play can
            # be compared with what it trained on (trace_report): <root>/traces/<version>/<when>.jsonl
            folder = self.root / 'traces' / model_id
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / time.strftime('%Y%m%d-%H%M%S.jsonl')
            self.trace = open(path, 'w', encoding='utf8')
            history = metadata['history']
            names = featurize.names() + [f'{n}@-{k}' for k in range(1, history + 1) for n in featurize.history_names()]
            self.trace.write(json.dumps({'version': 1, 'modelId': model_id, 'names': names,
                                         'buttons': [b['id'] for b in metadata['outputs']]}) + '\n')
            return {**metadata, 'trace': str(path)}
        return metadata

    def close_trace(self):
        """Stops keeping what the policy sees, and says where it was kept."""
        if self.trace is None:
            return {'trace': None}
        path = self.trace.name
        self.trace.close()
        self.trace = None
        return {'trace': path}

    def _keep(self, t, x=None, probabilities=None, missing=None):
        if self.trace is not None:
            self.trace.write(json.dumps({'t': t, 'x': x, 'p': probabilities, 'missing': missing}) + '\n')
            self.trace.flush()

    def trace_report(self, request):
        """What a version saw while it played (its newest trace, or `path`) beside what it trained on: how often it had
        nothing to go on and why; each value's range and mean in training and in play, and how often play went outside
        what training ever had; how unfamiliar its situations were (each frame's distance to the nearest training row,
        against how far the rows held back from training were); and how often it pressed each button against how often
        the player did. Written beside the trace as .report.json."""
        model_id = str(uuid.UUID(request['modelId']))
        metadata = json.loads((self.root / 'models' / model_id / 'metadata.json').read_text(encoding='utf8'))
        folder = self.root / 'traces' / model_id
        path = Path(request['path']) if request.get('path') else max(folder.glob('*.jsonl'), default=None, key=lambda p: p.stat().st_mtime) if folder.exists() else None
        if path is None or not path.exists():
            raise ValueError('Nothing kept of its play yet: tick “Keep what it sees” and play it')
        if self.trace is not None and Path(self.trace.name) == path:
            self.trace.flush()
        lines = [json.loads(line) for line in path.read_text(encoding='utf8').splitlines() if line.strip()]
        head, frames = lines[0], lines[1:]
        acted = [f for f in frames if f.get('x') is not None]
        if not acted:
            raise ValueError(f'It had nothing to go on in any of its {len(frames)} frames' if frames else 'It played no frames')
        # What it trained on, made again as it was (the recordings still there)
        config, described = metadata['config'], metadata['features']
        with self.db() as db:
            there = {rid for (rid,) in db.execute("SELECT id FROM recordings WHERE status='complete'")}
        ids = [rid for rid in config['recordingIds'] if rid in there]
        if not ids:
            raise ValueError('The recordings it was trained on have all been deleted')
        data = self.dataset({'recordingIds': ids, 'formulas': config.get('formulas') or [], 'columns': config.get('columns'),
                             'derived': config.get('derived') or [], 'grids': described.get('grids') or [], 'spatial': described.get('spatial') or [],
                             'goal': described.get('goal'),
                             'buttons': config.get('buttons'), 'stepMs': metadata['stepMs'], 'history': metadata['history'],
                             'actionDelayMs': config.get('actionDelayMs', 0), 'anchor': config.get('anchor'),
                             'surface': config.get('surface', 'below'), 'nearPx': config.get('nearPx', 200)})
        fixes = data['corrections']
        sequences = [[(x, y, rid in fixes) for _, x, y in sequence] for rid, sequence in data['recordings']]
        training, validation, _ = split_sequences(sequences, {n for n, (rid, _) in enumerate(data['recordings']) if rid in fixes})
        names, buttons = head['names'], head['buttons']
        tx = torch.tensor([r[0] for r in training], dtype=torch.float32)
        ty = torch.tensor([r[1] for r in training], dtype=torch.float32)
        vx = torch.tensor([r[0] for r in validation], dtype=torch.float32) if validation else tx[:0]
        px = torch.tensor([f['x'] for f in acted], dtype=torch.float32)
        pp = torch.tensor([f['p'] for f in acted], dtype=torch.float32)
        if px.shape[1] != tx.shape[1]:
            raise ValueError('What it saw has a different number of values than what it trained on: it was trained again since')
        mean, std = tx.mean(0), tx.std(0, unbiased=False).clamp_min(1e-6)
        low, high = tx.min(0).values, tx.max(0).values
        span = (high - low).clamp_min(1e-6)
        outside = ((px < low - 1e-3 * span) | (px > high + 1e-3 * span)).float().mean(0)
        shift = ((px.mean(0) - mean).abs() / std)
        values = [{'name': n, 'trainMean': float(mean[i]), 'trainLow': float(low[i]), 'trainHigh': float(high[i]),
                   'playMean': float(px[:, i].mean()), 'playLow': float(px[:, i].min()), 'playHigh': float(px[:, i].max()),
                   'outside': float(outside[i]), 'shift': float(shift[i])} for i, n in enumerate(names)]
        values.sort(key=lambda v: (v['outside'], v['shift']), reverse=True)

        # How unfamiliar: each frame's distance (in training's spread) to the training row most like it, beside the
        # rows held back from training (the last quarter of each recording), which it was never shown either
        def nearest(rows):
            z, ref = (rows - mean) / std, (tx - mean) / std
            return torch.cat([torch.cdist(chunk, ref).min(1).values for chunk in z.split(512)]) if len(rows) else torch.zeros(0)
        play_d = nearest(px)
        held_d = nearest(vx)
        typical = float(held_d.quantile(.9)) if len(held_d) else float(play_d.quantile(.5))
        unfamiliar = {'playMedian': float(play_d.median()), 'heldBackMedian': float(held_d.median()) if len(held_d) else None,
                      'heldBack90': typical, 'beyondHeldBack90': float((play_d > typical).float().mean())}
        missing = Counter(f['missing'] for f in frames if f.get('x') is None)
        report = {'trace': str(path), 'frames': len(frames), 'acted': len(acted), 'missing': dict(missing.most_common(5)),
                  'trainingRows': len(tx), 'heldBackRows': len(vx), 'unfamiliar': unfamiliar,
                  'buttons': [{'id': b, 'playerPressed': float(ty[:, i].mean()), 'playPressed': float((pp[:, i] >= .5).float().mean()),
                               'playChance': float(pp[:, i].mean())} for i, b in enumerate(buttons)],
                  'pressedNothing': float((pp < .5).all(1).float().mean()), 'playerNothing': float((ty < .5).all(1).float().mean()),
                  'values': values}
        path.with_suffix('.report.json').write_text(json.dumps(report, indent=1), encoding='utf8')
        return report

    def predict(self, request):
        if self.loaded is None:
            raise ValueError('Load a policy first')
        network, metadata, mean, std, featurize = self.loaded
        if request['observationSchema'] != metadata['observationSchema']['identity']:
            raise ValueError('Inference schema mismatch')
        t = float(request.get('timestamp', time.monotonic() * 1000))
        if self.recent and t <= self.recent[-1][0]:
            self.recent = []  # time went back: a new capture, not what led up to this
            featurize.route_at = None
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
            self._keep(t, missing=str(x))
            raise x
        for k in range(1, history + 1):
            e = earlier[k]
            if e is None or isinstance(e[2], Missing):
                self._keep(t, missing=f'Nothing usable {k} step{"s" if k > 1 else ""} earlier (history)')
                raise Missing(f'Nothing usable {k} step{"s" if k > 1 else ""} earlier (history)')
            x = x + [e[2][i] for i in featurize.history_keep]
        seen = x
        x = torch.tensor(x, dtype=torch.float32)
        if len(x) != metadata['inputSize']:
            raise ValueError('Feature size mismatch')
        begin = time.perf_counter()
        with torch.no_grad():
            probabilities = torch.sigmoid(network((x-mean)/std)).tolist()
        if not all(math.isfinite(p) and 0 <= p <= 1 for p in probabilities):
            raise ValueError('Invalid inference output')
        self._keep(t, seen, [round(p, 4) for p in probabilities])
        return {'buttons': [p >= .5 for p in probabilities], 'probabilities': probabilities,
                'latencyMs': (time.perf_counter()-begin)*1000, 'heading': getattr(featurize, 'heading', None) if featurize.goal else None}


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
            elif op == 'planner.preview':
                result = worker.planner_preview(request)
            elif op == 'drive.load':
                result = worker.drive_load(request)
            elif op == 'drive.step':
                result = worker.drive_step(request)
            elif op == 'trace.close':
                result = worker.close_trace()
            elif op == 'trace.report':
                result = worker.trace_report(request)
            elif op == 'export':
                result = worker.export(request)
            elif op == 'preview':
                result = worker.preview(request)
            elif op == 'spatial.sample':
                result = worker.spatial_sample(request)
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
