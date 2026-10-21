"""What taps do: how far a key held for so long moved the player, learned per map (kept with its stats as `_taps`)
and read as a response model by the tap positioner (positioning.py) and the movement controllers. A dynamics model in
the terms of docs/movement-architecture.md: it predicts (the most a tap could move the player, what it usually does)
and decides nothing.

A tap's move isn't in proportion to how long it is: a short one may not move the player at all (the game didn't see
it), a longer one walks and then slides on. So each correction is chosen from what taps of each length did before,
never more than twice the last one in a line-up, and never one that, worst case, could carry the player past what it
may move (its target and tolerance, a window's far side, the end of the line it stands on). When even the shortest
tap that moves it could do that, it isn't tried: the correction fails, saying so, and the map plans from where the
player is."""
import math

# A tap is at most TAP_GROWTH times the last one along its axis: how far a tap moves the player isn't in proportion to
# how long it is (a short one may barely move it, a longer one walks and slides on), so one tap's move per ms says
# little about the next; and no shorter than TAP_MIN_MS. With a walking speed (the platformer model's), a tap along x is also no longer than one that, at walking speed
# plus the most it has slid on after a tap (at least SLIDE_MS of walking), stays within what's left (and Start
# within past it) and short of the end of the line the player stands on (EDGE_PX)
TAP_GROWTH, SLIDE_MS, TAP_MIN_MS = 2.0, 30, 5

# A tap's move isn't in proportion to how long it is: a short one may not move the player at all (the game didn't see
# it), a longer one walks and then slides on. So each correction is chosen from what taps of each length did before
# (`TapResponse`: kept per map, by axis, with its stats as `_taps`), never more than twice the last one in a line-up,
# and never one that, worst case, could carry the player past what it may move (its target and tolerance, a window's
# far side, the end of the line it stands on). When even the shortest tap that moves it could do that, it isn't tried:
# the correction fails, saying so, and the map plans from where the player is.
TAP_GRID = (5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 400)
TAPS_KEPT = 60  # per axis and context
TAP_NEAR = 0.3  # taps within this share of a length count toward what one that long typically does
# A tap's context is what its controller tells taps apart by (MapRun.control.context; the platformer's is the grade
# of the ground the way it taps, platformer_control.TAP_GRADE): what a tap does is kept by context, and a tap chosen
# from taps in the same one
# A tap blocked by something the lines don't show (a wall): its key held, the player stood still for BLOCKED_MS or
# longer, from TAP_LAG_MS after it went down (readings lag the press) to its let-go. Over every tap in the user's
# traces (1,293), one moving freely stood at most 62 ms (up a steep slope, its readings 1 px apart); the three pushing
# against the second jump quest's starting wall stood 80-188 ms. Kept marked 'blocked', and not taken as what a tap
# that long does: it says how far the wall was, not how far a tap moves
BLOCKED_MS, TAP_LAG_MS = 75.0, 40.0
# Taps kept from before blocked ones were told apart: in one context, a tap TAP_LONGER_MS or more longer than one
# that moved the player TAP_SLACK_PX further was stopped short by something, and isn't taken as moving freely either
# (a game step either way, about 30 ms and 4 px, is spread, not that)
TAP_LONGER_MS, TAP_SLACK_PX = 40.0, 4.0


def _free_taps(taps):
    """Taps [(ms, px, context)] that moved the player freely: in each context, from the shortest, one TAP_LONGER_MS or
    more longer than a kept one that moved it TAP_SLACK_PX less was stopped short (by a wall the lines don't show) and
    is left out. Only within a context: up a steep slope the same tap moves the player a fraction of what it does on the
    flat, and that's not being stopped."""
    kept, out = [], set()
    for n in sorted(range(len(taps)), key=lambda n: taps[n][0]):
        ms, px, c = taps[n][:3]
        if not any(k[2] == c and ms - k[0] >= TAP_LONGER_MS and k[1] - px > TAP_SLACK_PX for k in kept):
            kept.append(taps[n])
            out.add(n)
    return [t for n, t in enumerate(taps) if n in out]


def _stood_held(tap):
    """Whether a tap ({start, ms, reads: [(read time, position along its axis)]}) was blocked: the player still, within
    half a px, for BLOCKED_MS or longer between TAP_LAG_MS after its key went down and its let-go. None when its
    readings can't say (a tap too short for BLOCKED_MS of them while held, or none)."""
    if not tap.get('reads') or tap.get('start') is None:
        return None
    held = [(t, p) for t, p in tap['reads'] if tap['start'] + TAP_LAG_MS <= t <= tap['start'] + tap['ms'] + 10]
    if len(held) < 2 or held[-1][0] - held[0][0] < BLOCKED_MS:
        return None
    a = 0
    for b in range(len(held)):
        while abs(held[b][1] - held[a][1]) > 0.5:
            a += 1
        if held[b][0] - held[a][0] >= BLOCKED_MS:
            return True
    return False


def kept_taps(seen):
    """Taps [[ms, px] or [ms, px, context]] with at most TAPS_KEPT of each context, the newest, in order."""
    count, out = {}, []
    for t in reversed([list(t) for t in seen or [] if isinstance(t, (list, tuple)) and len(t) >= 2]):
        ctx = t[2] if len(t) > 2 else None
        if count.get(ctx, 0) < TAPS_KEPT:
            count[ctx] = count.get(ctx, 0) + 1
            out.append(t)
    return out[::-1]


class TapResponse:
    """What taps along one axis did: [[ms, px moved] or [ms, px, context]], newest last. `walk` (px/ms, the platformer
    model's walking speed, or None) caps how much more a longer tap can move than a shorter one did.

    With a `context` (Controller.context), what a tap moves the player is read from taps in that context where they say (`own`;
    `context` says whether there were any): up a slope the same tap moves it far less than on the flat or down it. What
    doesn't depend on the ground is read from every tap: whether the game takes a tap that short at all (the shortest
    that has moved it, the longest that hasn't), so one flat tap of 60 ms doesn't hide that 25 ms taps move it."""

    def __init__(self, seen, walk, context=None):
        taps = _free_taps([(float(t[0]), abs(float(t[1])), t[2] if len(t) > 2 else None, t[3] if len(t) > 3 else None) for t in seen or []
                           if t[0] and t[0] > 0 and not (len(t) > 3 and t[3] == 'blocked')])
        self.seen = [(ms, px) for ms, px, _, _ in taps]
        self.mixed = len({c for _, _, c, _ in taps} - {None}) > 1 or (any(c for _, _, c, _ in taps) and any(c is None for _, _, c, _ in taps))
        self.own = [(ms, px) for ms, px, c, _ in taps if c == context] if context is not None else []
        # taps whose readings showed them moving freely the whole time their key was held ('free', _stood_held): only
        # those may say a shorter tap moves no more than they did, since one stopped by a wall moves less
        self.checked = [(ms, px) for ms, px, _, mark in taps if mark == 'free']
        self.checked_own = [(ms, px) for ms, px, c, mark in taps if mark == 'free' and c == context] if context is not None else []
        self.context = context if self.own else None
        self.walk = walk

    def shortest_moving(self):
        """The shortest tap that moved the player, or None."""
        return min((ms for ms, px in self.seen if px >= 0.5), default=None)

    def longest_still(self, below=math.inf):
        """The longest tap under `below` ms that didn't move it, or 0."""
        return max((ms for ms, px in self.seen if px < 0.5 and ms < below), default=0.0)

    def _upper(self, seen, ms, mixed=False, checked=()):
        up = [px + self.walk * (ms - m) for m, px in seen if m <= ms] if self.walk else [px for m, px in seen if m == ms]
        # "nor more than a longer tap moved" holds within one context only: among taps from anywhere, a long tap up a
        # steep slope (120 ms, 4 px) would bound a flat one (19 px); and only for longer taps known to have moved
        # freely (`checked`): the second quest's 250 and 300 ms taps against its starting wall (16 and 20 px) held a
        # 200 ms tap's most to 20 px, and it moved 27
        down = [px for m, px in checked if m >= ms] if not mixed else []
        best = max(up) if up else (self.walk * (ms + SLIDE_MS) if self.walk else None)
        if down and (best is None or max(down) < best):
            best = max(down)
        return best

    def upper(self, ms):
        """The most a tap `ms` long could move the player, by what taps did: no more than a shorter tap moved plus
        walking for the difference, nor more than a longer one moved; with nothing to go on, walking for it and
        SLIDE_MS more (None without a walking speed). By taps in its context when one of them is no longer than it."""
        if any(m <= ms for m, _ in self.own):
            own = self._upper(self.own, ms, checked=self.checked_own)
            if any(m >= ms for m, _ in self.own):
                return own
            # longer than any tap in its context: no less than what taps anywhere say a tap that long can do (a flat
            # context's 60 ms taps put a 120 ms one at 16 px, where 100 ms taps had moved the player 19)
            seen = self._upper(self.seen, ms, mixed=self.mixed, checked=self.checked)
            return own if seen is None else max(own, seen)
        return self._upper(self.seen, ms, mixed=self.mixed, checked=self.checked)

    def typical(self, ms):
        """What a tap `ms` long is expected to move the player (what it usually does; the most it could is `upper`,
        which keeps every tap from overshooting): the median of taps near that long in its context; with none, of
        every tap near that long, and failing that of the nearest length any tap was, no more than its context's taps
        say it could (`upper` by them: up a slope that's far less than taps elsewhere did). With no taps, half the most
        it could. Estimating untried lengths in a context as half the most they could chose a 150 ms tap for 12 px on
        the flat, where 100 ms taps had moved the player 15-19 px; it went 22, and the correction swung back and forth."""
        own = sorted(px for m, px in self.own if abs(m - ms) <= TAP_NEAR * ms)
        if own:
            return own[len(own) // 2]
        pool = sorted(px for m, px in self.seen if abs(m - ms) <= TAP_NEAR * ms)
        if not pool and self.seen:
            nearest = min({m for m, _ in self.seen}, key=lambda m: abs(m - ms))
            pool = sorted(px for m, px in self.seen if m == nearest)
        if pool:
            expected = pool[len(pool) // 2]
            cap = self._upper(self.own, ms, checked=self.checked_own) if self.own else None
            return expected if cap is None else min(expected, cap)
        up = self.upper(ms)
        return 0.0 if up is None else up / 2

    def most(self, ms, also=()):
        """The most a tap `ms` long could move the player by these taps and those of every other ground it may cross
        (`also`, TapResponses): the largest of them."""
        found = [u for u in (r.upper(ms) for r in (self, *also)) if u is not None]
        return max(found) if found else None

    def choose(self, need, allowed, first_ms, last_ms=None, cap_ms=None, also=()):
        """A tap for `need` px with at most `allowed` px of movement: (ms, None), or (None, why) when none is safe.
        Nothing having moved the player yet, it tries `first_ms`, then half again past the longest that didn't; else
        the shortest tap that typically covers `need`, at least the shortest that moved it. Never longer than the
        longest whose most could stay within `allowed`, nor twice `last_ms`, nor `cap_ms` (after one that overshot)."""
        grid = sorted(set(TAP_GRID) | {round(first_ms, 1)})
        safe = [ms for ms in grid if (u := self.most(ms, also)) is not None and u <= allowed]
        longest = max(safe, default=None)
        moving = self.shortest_moving()
        if moving is None:
            still = self.longest_still()
            want = first_ms if not still else max(first_ms, still * 1.5)
            if longest is None or longest <= still:
                return None, (f'no tap short enough to be safe has moved it yet (the longest that didn’t, {still:.0f} ms; '
                              f'a longer one could move it more than the {allowed:.1f} px it may)' if still else
                              f'even a {grid[0]} ms tap could move it more than the {allowed:.1f} px it may')
        else:
            want = next((ms for ms in grid if ms >= moving and self.typical(ms) >= need), grid[-1])
            if longest is None or longest < moving:
                return None, (f'the shortest tap that has moved it, {moving:.0f} ms, could move it {self.most(moving, also):.1f} px, '
                              f'more than the {allowed:.1f} px it may')
        ms = min(want, longest)
        if last_ms:
            ms = min(ms, TAP_GROWTH * last_ms)
        if cap_ms:
            ms = min(ms, cap_ms)
        return max(ms, TAP_MIN_MS), None
