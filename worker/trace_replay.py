"""Behaviour traces replayed through the executor, to check that a change to it decides as it did: a refactor's safety
net, not part of play.

A trace (<data>/traces/behavior/*.jsonl) keeps every frame's observations (`values`, `reads`) and times (`t`, `now`).
Replayed, those observations are fed to a tree frozen with everything it needs (`freeze`: its maps with their learned
movements, the clips' keys and the maps' stats, so no recording or cache is read again) on the frames' own clock,
open loop: the player goes where the trace says whatever the replay presses. Only the guard is stood in for (`Guard`):
an action starts when it's sent, runs for its length and completes, and the tree hears how its action is going from
the guard's reply to the frame before, as in play (electron/play.cjs). What the tree did each frame (its keys,
presses, action, node statuses, maps, text, events and what its maps learned) is the replay's output, and two outputs
of the same trace and bundle are equal when the executor decides the same.

  python trace_replay.py freeze  BUNDLES.json REQUESTS.json [--data DIR]
  python trace_replay.py run     BUNDLES.json OUT_DIR [--data DIR] [--only NAME]
  python trace_replay.py compare OUT_DIR OTHER_DIR

REQUESTS.json is {name: {request | trace, map, recording?}}: `request` as behavior.load takes it ({tree, trees, maps,
fields}), or `trace`, a trace whose header keeps the request it ran (traces since the header has kept it), `map` the
map id whose traces it replays, and `recording`, when given, only those traces whose movements came from it (a link
event's clip). `run` writes OUT_DIR/<name>/<trace>.jsonl and OUT_DIR/summary.json."""
import argparse
import hashlib
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path

import behavior as behavior_

DATA = Path(os.environ.get('APPDATA', '.')) / 'firefly' / 'data'


def freeze(worker, request):
    """Everything a tree needs to run, as behavior.load makes it, frozen: {tree, fields, clips, trees, maps, stats}."""
    maps = {mid: worker._with_grid(m, mid) for mid, m in (request.get('maps') or {}).items()}
    clips = worker._tree_clips({**request, 'maps': maps})
    return {'tree': request['tree'], 'fields': request.get('fields') or [], 'clips': clips, 'trees': request.get('trees') or {},
            'maps': maps, 'stats': worker._map_stats(maps.keys()), 'treeId': request.get('treeId')}


def thaw(bundle):
    return behavior_.Behavior(bundle['tree'], bundle['fields'], bundle['clips'], bundle['trees'], bundle['maps'],
                              json.loads(json.dumps(bundle['stats'])), bundle.get('treeId'))


class Guard:
    """The input guard as the tree hears it: one action at a time, started when sent (stopping one running), running
    for its length, then completed; its state as of the last frame applied."""

    def __init__(self):
        self.act = None

    def apply(self, out, now):
        if self.act and self.act['state'] == 'running' and now >= self.act['start'] + self.act['length']:
            self.act['state'] = 'completed'
        seq = out['sequence']
        if seq is not None:
            if self.act and self.act['state'] == 'running':
                self.act['state'] = 'cancelled'
            if seq:
                a = out.get('action') or {}
                self.act = {'id': a.get('id', 0), 'start': now, 'length': float(a.get('durationMs', seq[-1][0])), 'state': 'running'}

    def report(self, now):
        a = self.act
        if a is None:
            return {'id': 0, 'state': 'idle'}
        return {'id': a['id'], 'state': a['state'], 'startedAt': a['start'], 'elapsedMs': max(0.0, min(now, a['start'] + a['length']) - a['start'])}


def frames_of(path):
    """A trace's header and frames (the guard's closing records left out)."""
    with open(path, encoding='utf8') as f:
        head = json.loads(f.readline() or '{}')
        frames = []
        for line in f:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not row.get('closing') and isinstance(row.get('t'), (int, float)):
                frames.append(row)
    return head, frames


def observations(frame):
    """A trace frame's observations as play passes them: {name: {valid, value, readAt?, reused?}}."""
    reads = frame.get('reads') or {}
    out = {}
    for name, v in (frame.get('values') or {}).items():
        o = {'valid': v is not None, 'value': v}
        if name in reads:
            o['readAt'], o['reused'] = reads[name][0], reads[name][1]
        out[name] = o
    return out


def _plain(v):
    if isinstance(v, float):
        return round(v, 4) if math.isfinite(v) else str(v)
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, set):
        return sorted(_plain(x) for x in v)
    return v


def replay(bundle, frames):
    """The tree's output on every frame of a trace, fed its observations: [{keys, sequence, action, nodes, trees, maps,
    text, done, events, learned}], until the tree ends."""
    b, guard, execution, out = thaw(bundle), Guard(), {'id': 0, 'state': 'idle'}, []
    for f in frames:
        now, t = float(f['now']), float(f['t'])
        o = b.tick(now, observations(f), execution=execution, observation_time=t)
        guard.apply(o, now)
        execution = guard.report(now)
        out.append(_plain({**o, 'learned': b.stats()}))
        if o['done']:
            break
    return out


def _recording_of(frames):
    seen = Counter()
    for f in frames:
        for e in f.get('events') or []:
            if e.get('kind') == 'link':
                rec = (((e.get('recorded') or {}).get('clip') or {}).get('recording'))
                if rec:
                    seen[rec] += 1
    return seen.most_common(1)[0][0] if seen else None


def traces(data, map_id, recording=None):
    """The traces of a map (by the tree id their header names, or their frames' maps), those whose movements came from
    `recording` when it's given, oldest first."""
    for path in sorted((Path(data) / 'traces' / 'behavior').glob('*.jsonl')):
        try:
            head, frames = frames_of(path)
        except (OSError, ValueError):
            continue
        if head.get('treeId') != map_id and not any(map_id in (f.get('maps') or {}) for f in frames[:50]):
            continue
        if recording and _recording_of(frames) != recording:
            continue
        yield path, frames


def digest(rows):
    return hashlib.sha256('\n'.join(json.dumps(r, sort_keys=True) for r in rows).encode()).hexdigest()[:16]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=('freeze', 'run', 'compare'))
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('--data', default=str(DATA))
    ap.add_argument('--only')
    args = ap.parse_args(argv)
    if args.command == 'freeze':
        from worker import Worker
        w = Worker(args.data)
        requests = json.loads(Path(args.b).read_text(encoding='utf8'))
        bundles = {}
        for name, r in requests.items():
            request = r.get('request') or frames_of(r['trace'])[0].get('request')
            if not request:
                raise SystemExit(f'{name}: its trace keeps no request (it ran before traces kept one)')
            bundles[name] = {**{k: v for k, v in r.items() if k not in ('request', 'trace')}, 'bundle': freeze(w, request)}
        Path(args.a).write_text(json.dumps(bundles), encoding='utf8')
        print('froze', ', '.join(bundles))
    elif args.command == 'run':
        bundles = json.loads(Path(args.a).read_text(encoding='utf8'))
        out = Path(args.b)
        summary = {}
        for name, r in bundles.items():
            if args.only and name != args.only:
                continue
            (out / name).mkdir(parents=True, exist_ok=True)
            summary[name] = {}
            for path, frames in traces(args.data, r['map'], r.get('recording')):
                rows = replay(r['bundle'], frames)
                with open(out / name / path.name, 'w', encoding='utf8') as f:
                    for row in rows:
                        f.write(json.dumps(row, sort_keys=True) + '\n')
                summary[name][path.name] = {'frames': len(rows), 'of': len(frames), 'digest': digest(rows),
                                            'events': dict(Counter(e['kind'] for row in rows for e in row['events']))}
            print(name, len(summary[name]), 'traces,', sum(s['frames'] for s in summary[name].values()), 'frames')
        (out / 'summary.json').write_text(json.dumps(summary, indent=1, sort_keys=True), encoding='utf8')
    else:
        a, b = (json.loads((Path(d) / 'summary.json').read_text(encoding='utf8')) for d in (args.a, args.b))
        same = differ = 0
        for name in sorted(set(a) | set(b)):
            for trace in sorted(set(a.get(name, {})) | set(b.get(name, {}))):
                x, y = a.get(name, {}).get(trace), b.get(name, {}).get(trace)
                if x and y and x['digest'] == y['digest']:
                    same += 1
                    continue
                differ += 1
                print(f'{name} {trace}: differs', end='')
                if x and y:
                    ra = (Path(args.a) / name / trace).read_text(encoding='utf8').splitlines()
                    rb = (Path(args.b) / name / trace).read_text(encoding='utf8').splitlines()
                    k = next((i for i, (p, q) in enumerate(zip(ra, rb)) if p != q), min(len(ra), len(rb)))
                    print(f' from frame {k} of {len(ra)}/{len(rb)}')
                    if k < min(len(ra), len(rb)):
                        pa, pb = json.loads(ra[k]), json.loads(rb[k])
                        for key in sorted(set(pa) | set(pb)):
                            if pa.get(key) != pb.get(key):
                                print(f'    {key}: {json.dumps(pa.get(key))[:300]}\n     vs {json.dumps(pb.get(key))[:300]}')
                else:
                    print(' (only in one)')
        print(f'{same} traces the same, {differ} differ')
        return 1 if differ else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
