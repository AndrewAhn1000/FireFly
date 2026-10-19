"""A recording's key presses, to the millisecond: what was held at any moment, the presses between two moments, a
stretch's presses as a timeline, and where the player stood still. Nothing in it is about one game.

The recorder keeps every key event (the `inputs` table; Worker._key_events reads the player's own, not those another
program sent). A clip of a recording, from `start` to `end`, is the keys held at its start and every press and let-go
until its end, then every key still held let go, so playing it leaves nothing pressed."""
import bisect

REST_MS = 80   # standing still: not REST_PX from where they were, with nothing held, for this long or more
REST_PX = 1


class Keys:
    """A recording's raw key events: [(t, id, down)] for a press or let-go, [(t, None, [ids held])] for what was held
    then (the recorder notes it when the game comes to the front)."""

    def __init__(self, events):
        self.times, self.states, self.presses = [], [], []
        held = set()
        for t, key, down in sorted(events, key=lambda e: e[0]):
            if key is None:
                held = set(down)
            else:
                (held.add if down else held.discard)(key)
                self.presses.append((t, key, bool(down)))
            self.times.append(t)
            self.states.append(frozenset(held))
        self.press_times = [p[0] for p in self.presses]

    def held(self, t):
        i = bisect.bisect_right(self.times, t) - 1
        return self.states[i] if i >= 0 else frozenset()

    def between(self, t0, t1):
        return self.presses[bisect.bisect_left(self.press_times, t0):bisect.bisect_right(self.press_times, t1)]


def clip(keys, start, end):
    """A stretch of a recording's keys: {keys: held at its start, timeline: [[ms from start, key, down]] up to its end,
    then every key still held let go at its end, end: its length (ms)}."""
    held = set(keys.held(start - 0.001))
    line = []
    for t, key, down in keys.between(start, end):
        line.append([round(t - start, 1), key, down])
        (held.add if down else held.discard)(key)
    line += [[round(end - start, 1), key, False] for key in sorted(held)]
    return {'keys': sorted(keys.held(start - 0.001)), 'timeline': line, 'end': round(end - start, 1)}


def stands(track, keys, grounded=None):
    """Where the player stood still in a recording: runs of samples [(t, x, y)] not REST_PX apart with nothing held
    (and, given `grounded`, a parallel list, not off the ground), REST_MS or longer, as (first, last) sample indices."""
    out, k = [], 0
    while k < len(track):
        if keys.held(track[k][0]) or (grounded is not None and grounded[k] is False):
            k += 1
            continue
        j = k
        while (j + 1 < len(track) and abs(track[j + 1][1] - track[k][1]) <= REST_PX and abs(track[j + 1][2] - track[k][2]) <= REST_PX
               and not keys.held(track[j + 1][0]) and (grounded is None or grounded[j + 1] is not False)):
            j += 1
        if j > k and track[j][0] - track[k][0] >= REST_MS:
            out.append((k, j))
        k = j + 1
    return out


def clips_between_stands(track, keys, grounded=None):
    """The stretches between stands: each from the first key pressed after one stand to the start of the next, where
    the player moved: [{from, to, ms, start (x, y), end (x, y), a (sample index), b}]."""
    found = stands(track, keys, grounded)
    out = []
    for (a0, a1), (b0, _) in zip(found, found[1:]):
        first = next((p[0] for p in keys.between(track[a1][0], track[b0][0]) if p[2]), None)
        if first is None:
            continue
        sx, sy, ex, ey = track[a1][1], track[a1][2], track[b0][1], track[b0][2]
        if abs(ex - sx) + abs(ey - sy) < 3:
            continue  # stood still again where it was
        out.append({'from': round(first, 1), 'to': round(track[b0][0], 1), 'ms': round(track[b0][0] - first), 'start': (sx, sy), 'end': (ex, ey),
                    'a': a1, 'b': b0})
    return out
