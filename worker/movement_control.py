"""The movement controller: what a map's recorded movements need beyond being played as recorded, asked by the
executor (behavior.py) at fixed points (docs/movement-architecture.md). The executor knows the player only as a state
(a position, a level, the map's Wait for) and asks its map's controller, `MapRun.control`, whatever depends on what
kind of movement it is: how far the player is from a target in the terms correcting it uses, what limits a correction
each way, whether a State turning true happened where it was expected, whether a movement that ended off its place can
be put right.

`Controller` is the generic behaviour, a map without a movement model: straight distances, nothing limiting a
correction, a transition expected within Arrive within of its recorded place. A map whose analysis measured a movement
model gets that model's controller (`controller_for`)."""
import math

from positioning import TapPositioner
from tap_response import TapResponse, kept_taps


class Controller:
    """A map's movement decisions with no model: nothing in it is about how anything moves."""

    margin = 0.0  # how far a correction keeps from what limits it (bound)

    def __init__(self, mr):
        self.mr = mr

    def walk(self):
        """The player's walking speed (px/ms), when a model has measured it: what bounds how much further a longer tap
        can go."""
        return None

    def positioner(self, ex):
        """What puts the player within a tolerance of a target (positioning.TapPositioner), through the executor `ex`."""
        return TapPositioner(ex, self.mr)

    def tap_response(self, axis, context=None):
        """What taps along `axis` did (TapResponse), those in `context` when there are any (context()), with the
        walking speed when a model has one."""
        return TapResponse(self.mr.taps.get(axis), self.walk(), context)

    def note_tap(self, axis, ms, px, context=None, blocked=None):
        """A tap from standing still along `axis`: how long, how far it moved the player once it stood still again,
        and its context (context(), kept when known); and, when its readings could tell (tap_response._stood_held),
        'blocked' (kept as what stopped it, not as what a tap does) or 'free'."""
        mr = self.mr
        tail = [context, 'blocked' if blocked else 'free'] if blocked is not None else ([context] if context else [])
        mr.taps[axis] = kept_taps([*mr.taps.get(axis, []), [round(ms, 1), round(abs(px), 1), *tail]])
        mr.stats['_taps'] = mr.taps
        mr.changed = True

    # ── feasibility: what a movement presses and where it starts ──
    def keys(self):
        """Keys it presses beyond its recordings' and Line up with taps'."""
        return set()

    def unsafe(self):
        """The recorded movements it can't execute safely, planned only with no other way: {link id: why}."""
        return {}

    def triggers(self, link, forced=False):
        """Where a recorded movement's parts start on its say rather than the recording's clock or a wait: [{at, kind,
        ...}] (kind anything but 'sync'), each sent when trigger() says. `forced`: the movement is taken though it's
        marked unsafe."""
        return []

    def played(self, link, clip):
        """A recorded movement's clip as it's played (presses it leaves out)."""
        return clip

    def completion(self, link):
        """A recorded movement's terminal correction, when it has one (None: it arrives as played)."""
        return None

    def complete(self, ex, st, link, fin, level, x, y, t):
        """One frame of a recorded movement's terminal correction (`fin`, completion()) once it has played, `t` ms
        into it: None while it hasn't begun (the usual arrival applies); else {running: text}, {fail: why}, or {done:
        how it arrived}. Its state is st['finish']."""
        return None

    def start(self, link, level, bounds):
        """Where a recorded movement starts from and how near the player must be: {at: (x, y), tol, region}, region
        (what the trace says of it) when it may begin elsewhere too (admits). `bounds`: its parts (Behavior._bounds)."""
        return {'at': tuple(link['start']), 'tol': self.mr.replay['startPx'], 'region': None}

    def admits(self, start, level, x, y):
        """Whether the player at (x, y) may begin the movement of `start` (start()) where it is."""
        return False

    def attempt_info(self, link, forced=False):
        """What the trace says of how a recorded movement is played beside its recording (its `link` event)."""
        return {}

    ANNOTATIONS = ()  # what its analysis wrote on a recorded movement, said with each attempt in the trace

    # ── feedback while a movement plays ──
    STATE = ()  # its own keys in a movement's run state, cleared with the attempt

    def frame(self, ex, st, level, x, y):
        """Every frame of a recorded movement in parts, through the executor `ex`."""

    def ending(self, ex, st, seen):
        """The movement of `st` is ending (`seen`: where the player was last, (x, y, level))."""

    def extra_ms(self, st):
        """How much longer than its recorded time a part waiting on its trigger may wait (each added in turn)."""
        return ()

    def next_part(self, st):
        """A part has begun: what it kept for the trigger before is let go of."""

    def trigger(self, ex, st, seg, trigger, level, x, y, overdue, span):
        """Whether the part waiting on `trigger` (one of triggers()) is sent now: {wait: what it's waiting for},
        {fail: why}, or {lead: ms its presses go on from now, offset: px the rest of the movement is aside along x}.
        `overdue`: it has waited past its recorded time (`span` ms) and what extra_ms allows."""
        return {'fail': f'nothing sends a part on a {trigger["kind"]} trigger'}

    # ── geometry: distances and what limits a correction ──
    def distance(self, level, x, y, tx, ty):
        """How far the player at (x, y) is from (tx, ty), in the terms a correction toward it uses."""
        return math.hypot(x - tx, y - ty)

    def along(self, level, x, y, tx, ty, within):
        """Whether correcting along x alone brings the player within `within` px of (tx, ty)."""
        return False

    def bound(self, level, x, y, way, beyond=None):
        """How far the player can go `way` (-1 or 1) along x before what it mustn't cross, and what that is ('end' or
        'downhill'): (px, kind), or (None, None) when nothing is known to limit it."""
        return None, None

    def room(self, level, x, y, way, beyond=None):
        """bound()'s distance alone (None when nothing limits it)."""
        return self.bound(level, x, y, way, beyond)[0]

    def safe_stop(self, level, x, y, tx, ty):
        """Whether the player may stop at (x, y) correcting toward (tx, ty)."""
        return True

    def context(self, level, x, y, way):
        """What a tap from (x, y) `way` along x depends on, to tell its taps apart by (None: nothing known)."""
        return None

    def crossing(self, level, x, y, way, reach):
        """The contexts a tap from (x, y) `way` may cross within `reach` px, the first where it starts."""
        return []

    def confirms(self, level, x, y, ex, ey):
        """Whether a State turning true with the player at (x, y) happened at its expected destination (ex, ey):
        (valid, certain), certain False when this reading can't say yet."""
        return math.hypot(x - ex, y - ey) <= self.mr.replay['arrivePx'], True

    def recoverable(self, link, level, x, y, shift, off):
        """Whether a recorded movement that ended `off` px from its end (`shift` px aside along x) can be put right
        from where it is by lining up: where it is, said ('on its platform'), or False."""
        return False


def model_settings(replay):
    """A map's settings for its movement model, from its grid's `replay`: the side-view platformer's `takeoff` (how
    jumps are pressed) and `ground` (the State whose lines are the ground)."""
    from platformer_control import settings
    return settings(replay)


def load_dynamics(doc):
    """The dynamics model a map's analysis measured (its `platformer`, Worker._takeoffs), ready for its controller;
    None without one."""
    if (doc or {}).get('platformer'):
        from platformer_control import load
        return load(doc)
    return None


def controller_for(mr):
    """The controller for a map: its dynamics model's (MapRun.dynamics), when its analysis measured one, else the
    generic one."""
    if mr.dynamics:
        from platformer_control import PlatformerController
        return PlatformerController(mr)
    return Controller(mr)
