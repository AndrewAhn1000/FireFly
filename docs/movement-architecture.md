# Movement architecture: executor, controllers, dynamics models

FireFly replays demonstrations: a map's recorded movements, gone over by a tree's Go to node or a policy's Goal. The
adaptive execution built for the user's jump quests works, but it grew inside the generic executor
(`worker/behavior.py`). About 985 of its 2,577 lines decide where a jump is pressed, whether a landing is the one
waited for, how far a tap may go before an edge, and so on. This document splits that into three layers with fixed
interfaces, so that:

- the executor runs any demonstration of any game without knowing what a platform, slope, jump or landing is;
- what one kind of game needs (a side-view platformer) is one optional implementation, chosen per map;
- predictions and their uncertainty are kept apart from the decisions made with them.

The split moves code without changing what it decides. That is checked against the user's recorded runs
(`worker/trace_replay.py`, below) before and after each step.

**Status: done.** The modules after the split:

| Module | Lines | Role |
|---|---|---|
| `behavior.py` | 1,512 | the executor, with no movement model in it |
| `movement_control.py` | 178 | the interface and its generic behaviour |
| `platformer_control.py` | 883 | the side-view platformer's controller |
| `positioning.py` | 174 | the tap positioner |
| `tap_response.py` | 197 | what taps do |

`platformer.py` now also holds the analysis (`annotate`). Every step decided the same as before on all the user's
recorded runs.

## The three layers

**Executor** (`worker/behavior.py`: `Behavior`, `MapRun`). It owns:
- **Action scheduling:** it cuts a recorded movement into parts and sends each part as a timed key sequence, keeping
  the keys held between parts.
- **The input guard:** action ids, the guard's acknowledgements, and cancelling.
- **Observation:** the frame's values, read times and the position formula.
- **Feedback coordination:** waiting for a State (Wait for) to turn false and then true after a given key; the
  trajectory monitor; arrival within Arrive within; timeouts.
- **Recovery:** settling after a failure and planning again over the map's links (Dijkstra, learned cost and
  chance, give up).
- **Records:** every attempt, written to the trace.

It sees the player only as a state: a position (x, y), a level, the map's Wait for value, and read times. It never
imports a movement model.

**Movement controller** (optional, one per map; the protocol is in `worker/movement_control.py`, the side-view
platformer's in `worker/platformer_control.py`). It makes the decisions specific to a kind of movement, at fixed
points the executor asks:
- **Action feasibility:** where a movement may start from, how close to that it must be, which movements can't be
  executed safely, and what its recording presses that it shouldn't replay.
- **Adaptive control:** when a part waiting on a controlled trigger is sent, and with what lead time and expected
  offset.
- **Positioning:** the actions that put the player within a tolerance of a target state.
- **Completion checks:** whether a State turning true happened at the expected destination; whether a movement
  ending off its place is recoverable; a terminal correction.

It keeps per-map learned state and asks the dynamics model for predictions; it has no physics of its own.

**Dynamics model** (optional; `worker/platformer.py` for the side-view platformer). It holds:
- **Motion parameters** fitted from recordings: walking speed, launch speed, gravity, press-to-launch delays,
  run-up, how far the position stands off the lines.
- **The world's geometry:** ground lines, edges, grades.
- **Predictions:** where a press lands, how much room there is before an edge, how a recorded jump can be pressed
  safely.
- **Learned response distributions:** what a tap of each length did, by context.
- **Uncertainty:** the fit's error, the delays' spread, calibration from runs.

It also annotates recordings at analysis time: jumps, endings, start regions and checkpoints. It decides nothing at
run time.

Timed playback is the executor alone. Only the executor and a controller can send actions. Only a controller may
read a dynamics model.

## Interfaces (as built)

`MapRun.control` is the map's controller (`movement_control.controller_for`):
- a `PlatformerController` when the map's analysis measured a platformer model (`MapRun.dynamics`, loaded by
  `movement_control.load_dynamics`, which only the controller reads);
- else the base `Controller`.

The base controller is exactly what the executor did for a map without a model, so such a map behaves as before. The
property follows `MapRun.dynamics`, so a test that removes a map's model in place gets the generic controller.

```python
class Controller:                                    # worker/movement_control.py
    margin = 0.0                                     # how far a correction keeps from what limits it
    ANNOTATIONS = ()                                 # link fields its analysis wrote, said with each attempt
    STATE = ()                                       # its own keys in a movement's run state, cleared with the attempt

    # feasibility: what a movement presses and where it starts
    def keys(self) -> set                            # keys it presses beyond the recordings' and Line up's
    def unsafe(self) -> dict                         # link id -> why; planned only with no other way
    def triggers(self, link, forced) -> list         # [{at, kind != 'sync', ...}]: parts it starts
    def played(self, link, clip) -> clip             # the clip as played (presses left out)
    def completion(self, link) -> spec | None        # its terminal correction, if any
    def complete(self, ex, st, link, fin, level, x, y, t) -> None | {running} | {fail} | {done}
    def start(self, link, level, bounds) -> {at, tol, region}
    def admits(self, start, level, x, y) -> bool     # may begin where it is (within `region`)
    def attempt_info(self, link, forced) -> dict     # merged into the trace's `link` event

    # feedback while a movement plays
    def frame(self, ex, st, level, x, y)             # every frame of a movement in parts
    def trigger(self, ex, st, seg, trigger, level, x, y, overdue, span) -> {wait} | {fail} | {lead, offset}
    def extra_ms(self, st) -> tuple                  # how much longer a wait for its trigger may run
    def next_part(self, st)                          # a part began: its trigger's state let go of
    def ending(self, ex, st, seen)                   # the attempt is ending
    def confirms(self, level, x, y, ex, ey) -> (valid, certain)   # a Wait for transition at its destination
    def recoverable(self, link, level, x, y, shift, off) -> str | False  # ended off its place, but fixable

    # positioning, through the generic tap positioner
    def positioner(self, ex) -> TapPositioner
    def tap_response(self, axis, context=None) -> TapResponse
    def note_tap(self, axis, ms, px, context=None, blocked=None)
    def walk(self) -> float | None                   # walking speed, when measured
    def distance(self, level, x, y, tx, ty) -> float
    def along(self, level, x, y, tx, ty, within) -> bool
    def bound(self, level, x, y, way, beyond=None) -> (px | None, kind | None)
    def room(self, level, x, y, way, beyond=None) -> px | None
    def safe_stop(self, level, x, y, tx, ty) -> bool
    def context(self, level, x, y, way) -> str | None
    def crossing(self, level, x, y, way, reach) -> list
```

**The run state.** A movement's state, `st`, is shared:
- the executor's keys (`segs`, `seg`, `anchor`, `segStart`, `waiting`, `link`…) are read by the controller and never
  written by it;
- the controller's own keys (`STATE`, and the trigger's `repo`, `standRepo`, `takeoffWait`, reset by `next_part`)
  are its to write;
- `st['finish']` is the completion's state, cleared by the executor with the attempt.

The executor turns a trigger's `offset` into its generic expected-path offset (`shiftX`). It moves the trajectory
monitor and the arrival check, and the map plans on from there.

**The executor's services** to controllers and the positioner are the `Behavior`'s public methods:
- `play(st, line, ms, keep)` and `playing(st)`: send an action and follow the guard's feedback;
- `hold(keys)` and `release(keys)`: this frame's keys;
- `settled(st, name, x, y, ms)`: standing still;
- `say(kind, st, **fields)`: a trace event under the attempt;
- `sync(mr)`: the map's Wait for now;
- `position_reads(mr)`: the observations the position formula read this frame, with their read times;
- `now`, and `shared['observation_time']` and `shared['execution']`.

The settings a model needs from a map's `replay` (`takeoff`, `ground`) are parsed by its module
(`movement_control.model_settings`), not by the executor.

### Where each function went

| Before (`behavior.py`) | Lines | Now |
|---|---|---|
| `_go_step`, `_link`, `_play_parts`, `_segments`, `_sync_gate`, `_monitor_movement`, `_arrived`, `_fail_link`, `_resolve_arrival`, `_attempt_*`, `_line_up`, `_play`, `_playing`, `_settled` | 633 | executor (stays), with the platformer calls replaced by `mr.control` |
| `_takeoff`, `_stand_into`, `_reposition`, `_landed_due`, `_watch_takeoff`, `_seen`, `_recorded_dx`, `_stopping` | 393 | `PlatformerController.trigger`, `.frame`, `.ending` (the helpers are its methods under the same names) |
| `_start_for`, `_start_tol`, `_in_start_region` | 37 | `PlatformerController.start`, `.admits` |
| `_bounds` (its takeoff half), `_played`, `MapRun.unsafe` | 50 | `.triggers`, `.played`, `.unsafe` |
| `_sync_destination` (its ground half), `_on_its_platform` | 30 | `.confirms`, `.recoverable` |
| `_finish_of`, `_finish`, `_facing_tap` | 99 | `.completion`, `.complete` |
| `_tap_step`, `_send_tap`, `_taps_begun` | 140 | `positioning.TapPositioner.step`, `.send`, `.begin` |
| `_room_bound`, `_room`, `_safe_stop`, `_crossing`, `_along_line`, `_start_off`, `MapRun.tap_context` | 140 | `PlatformerController.bound`, `.room`, `.safe_stop`, `.crossing`, `.along`, `.distance`, `.context` |
| `TapResponse`, `kept_taps`, `_free_taps`, `_stood_held` | 150 | `tap_response.py` (dynamics: the response model) |
| `MapRun.note_tap`, `.tap_response` | 16 | `Controller.note_tap`, `.tap_response` (the taps stay in `MapRun.taps`, kept with its stats) |
| `MapRun.jump_shift`, `.learn_jump` | 18 | `PlatformerController` learned state |
| `Worker._takeoffs` (analysis) | 70 | `platformer.annotate(graph, recordings, grounds, calibration)`; the worker still gathers the recordings |

Positioning is a controller because it decides actions. The tap positioner is generic: it corrects a 1-D error with
keys each way, by a response model, within a bound. That is why the base controller has it too (without a model it
scales taps from the last one, as now). What the platformer adds is geometry: the bound comes from the ground line,
the context from its grade, and the distance is measured along a slope.

### Rules the executor keeps

1. `behavior.py` imports no model or controller module. It reads `MapRun.dynamics` only to choose its controller,
   and names nothing after platforms, jumps, ground or landings in its code (`worker/test_architecture.py`).
   User-facing messages weren't reworded, so outputs stayed identical. A few still say "landing", and "on its
   platform" is now the controller's own wording, returned by `recoverable`.
2. Its constants are about time and feedback: Wait for windows, settle time, monitor distance, timeouts. Pixel
   thresholds about the world belong to the controller.
3. Trace events keep their kinds and fields. The Runs panel, the Replay report and `calibration.py` read them, so
   their meaning can't change in a refactor. Platformer events (`takeoff`, `takeoff-outcome`, `reposition`,
   `stand-reposition`, `stop-watch`, `finish`, `start-region`) are emitted by the controller through `say`.
4. The link fields the analysis writes (`takeoffs`, `finish`, `startRegion`, `checkpoints`, `unsafe`) stay where they
   are, so cached analyses and the map editor keep working. They are the platformer's annotations, and only its
   controller reads them. A later step can namespace them under `link.platformer` together with an analysis-cache
   bump.

## What "timed" means today

The two Press jumps settings don't differ only in how jumps are pressed. With a platformer model present (any map with
Ground lines), timed playback also uses the model in four places:
- it lines up with a movement's start by tapping, using ground-line room, slope grades and distances along a slope;
- it confirms that a landing waited for is on the expected ground line;
- it judges whether a movement that ended off its place is on its platform, and so recoverable by lining up;
- it narrows Start within by a walk's resting position (`_start_tol`, whatever the mode).

What only adaptive does: takeoff triggers, walk-off presses left out, the terminal correction (with its trailing
presses left out), start regions, and the unsafe marking. The comparison the user asked for is therefore timed jump
presses against adaptive ones. Positioning is the same in both; it is not raw timed replay against adaptation.

In the new structure this becomes explicit. The platformer controller has two capabilities:
- geometry-aware positioning and confirmation, on whenever the model exists;
- adaptive triggers and completion, on with Press jumps set to adaptive.

A third setting, raw replay with no controller at all, would then be one switch. It isn't added in this refactor.

## Assumptions the platformer controller still makes

The platformer model contains no MapleStory addresses, identifiers or names:
- it learns its keys (jump, left, right) from what the recordings pressed in the air and on the ground;
- its motion parameters come from fitting the recordings;
- its world is the lines of a shapes State the user picks.

It does make assumptions that hold for MapleStory but aren't learned:
- **Screen y grows downward.** "Up a slope" and "a line below" are read with that sign.
- **Absolute pixel thresholds:**

  | Constant | Value |
  |---|---|
  | `EDGE_PX` | 2 |
  | `ON_PX` | 3 |
  | `LAND_MARGIN` | 6 |
  | `EXEC_PX` | 8 |
  | `INSET_PX` | 4 |
  | `NUDGE_PX` | 12 |
  | `START_REGION_PX` | 16 |
  | `RUNUP_PX` | 32 |
  | `RISE_PX` | 3 |
  | `TAP_SLACK_PX` | 4 |

  They are sized to a game whose steps are 2–4 px. They should be derived from the measured model (a game step is
  walking speed × the update interval, about 30 ms).
- **Thresholds measured on the user's traces:**

  | Constant | Value |
  |---|---|
  | `BLOCKED_MS` | 75 |
  | `TAP_LAG_MS` | 40 |
  | `LANDING_CONFIRM_MS` | 120 |
  | `STOP_WATCH_MS` | 400 |
  | `CAL_FRESH_MS` | 60 |
  | `REST_MS` | 400 |

  Each is generic in form, but its value comes from one game's reading cadence and update interval. They should
  become multiples of the measured frame gap and game step.
- **One jump key and one key each way along x.** A game with run, crouch or double-jump keys has movements the model
  doesn't know. It leaves those timed, which is right, but it can't adapt them.

These are listed as follow-ups, not changed in this refactor: changing them changes decisions.

## Probabilistic displacement (investigation, not implemented)

The tap data show a tap's move is not a function of its length. On the first map, flat ground:

| Hold | 0 px | 2 px | 7 px | 15 px |
|---|---|---|---|---|
| 40 ms | 1% | 56% | 44% | |
| 80 ms | | | 22% | 78% |

The guard holds each tap to within 0.4 ms of what was asked. What varies is how many of the game's input samples
(about every 30 ms, at a phase FireFly can't observe) the hold spans. `TapResponse` today keeps:
- a worst case (`upper`), which bounds safety;
- a median (`typical`), which picks the length.

The proposed replacement keeps the same interface for the positioner, but answers from a distribution. The
investigation needed first, with no change to the controller:
1. **Fit the distribution:** per context, discrete outcomes (the game's steps) with probabilities as a function of
   hold, smoothed across neighbouring holds. Check by leaving one run out: does it predict held-out taps' outcome
   frequencies better than the median and worst-case pair?
2. **Choose by probability:** pick the hold that maximises the chance of ending within the tolerance, subject to the
   chance of crossing a hazard staying under a bound. Replay the line-ups recorded in traces through it offline:
   would it have needed fewer taps, or refused fewer starts (the second JQ's 2 px start at its crest)?
3. **Look for an observable phase:** check whether the game's update phase can be seen at all. Frame capture times
   didn't separate outcomes; the position's change cadence within a hold might.

A positioner that chose by probability would replace the worst-case rule "each tap at worst halves the error". That
changes decisions, so it would come as its own change, compared on the benchmarks.

## Verification: `worker/trace_replay.py`

Every step of the migration is checked against the user's own runs:
1. **`freeze`** turns a run request (as `behavior.load` takes it) into a bundle with everything it needs: the
   maps with their learned movements, the clips' keys and the maps' stats. No recording or cache is read again.
2. **`run`** feeds every trace's observations, on its own clock, through a fresh tree made from the bundle. A
   stand-in guard starts each action when it's sent, completes it after its length, and reports a frame late, as in
   play. Each frame's output is written down: keys, presses, action, node statuses, map status, text, events, and
   what the maps learned.
3. **`compare`** checks two outputs frame by frame and prints the first difference.

The replay is open loop: positions are what happened, whatever the replay presses. It isn't a simulation of the game,
but it drives every decision path with real inputs. On the user's data today it covers:
- 238 trace replays: the three benchmarks, each in both Press jumps modes;
- about 171,000 frames;
- 1,178 takeoff decisions, 1,660 Wait for transitions, 165 terminal corrections, 252 line-ups and 38 start-region
  starts.

Two runs of the same code give identical output for every trace. A refactor step is accepted only when:
- every trace's output is identical;
- the Python tests pass (331 then, 334 with the architecture test);
- `npm run test:play` passes.

Since this work, a run's trace header also keeps its request (`request`: tree, trees, maps, fields). Later runs
can then be frozen from the trace itself (a REQUESTS entry with `trace` instead of `request`), rather than from
the map as it is now.

## Migration steps (done)

Each step was one change that left FireFly working. Each was accepted on three checks: all 238 trace replays
identical to the outputs recorded before step 1, the Python tests passing, and `npm run test:play` passing (37 of 37).

0. **The replay harness, and the request in each trace's header.**
1. **The controller seam.** `Controller` and `PlatformerController` were added, and the geometry queries and Wait for
   confirmation moved to them.
2. **Positioning.** `TapResponse` and its helpers moved to `tap_response.py`, and the tap controller to
   `positioning.TapPositioner`. Taps' learned state is reached through the controller. `_line_up` stays as the
   executor's start phase.
3. **Feasibility.** What it presses, unsafe movements, its triggers, the presses it leaves out, its terminal
   correction's spec, where a movement starts and how near (`start`, `admits`), and the trace's model info.
4. **Triggers.** `_takeoff` and its helpers became `trigger`, `frame`, `ending`, `extra_ms` and `next_part`. Walking
   back and tapping into a stretch hold and release keys through the executor's services. A trigger's `offset` is
   the executor's `shiftX`, and a failed one fails as `<kind>-failed`.
5. **Completion.** The terminal correction moved to `complete`, which returns running, fail or done. The executor
   says the status, fails the link or arrives. 5b: the model is loaded by the controller module
   (`MapRun.dynamics`), and the executor's own state keys got generic names (`startStill`, `endStill`,
   `pendingTransition`).
6. **Analysis.** `Worker._takeoffs`' fit and annotations moved to `platformer.annotate`. Checked by analysing the
   three benchmarks' recordings again with the new code: maps and clips came out identical, apart from link ids.
7. **Audit.** `test_architecture.py` was added, and the model's settings parse moved to its module.

**One side effect.** A recorded movement's link id is derived from the analysis cache key, which hashes the
analysis code (`ANALYSIS`). Every change to `platformer.py`, `movement.py` or `keys.py` therefore gives each movement
a new id, and its learned per-link stats (runs, fails, time, jump shifts) are left behind, since `MapRun` keeps stats
only for links it has. Step 6 changed `platformer.py`, so the user's two maps start their link stats afresh. Taps
(`_taps`) aren't keyed by link and are kept. This has happened with every analysis change before. A follow-up could
key a movement by its recording and clip times instead.

## Deferred

Per the user's instruction, none of these are part of this work:
- handoff between movements;
- chained-jump planning (jump 11 for jump 12);
- adaptive crest stopping;
- further jump-quest-specific corrections;
- a probabilistic tap controller.
