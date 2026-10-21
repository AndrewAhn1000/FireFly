# Timed action execution

Behavior Press nodes and recording clips use the native input executor's
`sequenceProtocol: 1` when advertised by `configure`. Older guards and offline
behavior simulations retain elapsed-time playback. Ordinary policy-held buttons
continue to require fresh observation-driven `apply` requests.


> **Where the code is now.** Since the split described in `docs/movement-architecture.md`, the movement-specific
> functions this document names belong to the side-view platformer's controller,
> `worker/platformer_control.py` (`PlatformerController`), not `Behavior`. Most keep their names
> (`_takeoff`, `_stand_into`, `_reposition`, `_landed_due`, `_recorded_dx`, `_start_for`, `_start_tol`,
> `_in_start_region`, `_facing_tap`). The ones renamed:
>
> | Before | Now |
> |---|---|
> | `_finish` | `complete` |
> | `_finish_of` | `completion` |
> | `_played` | `played` |
> | `_start_off` | `distance` |
> | `_along_line` | `along` |
> | `_room_bound` | `bound` |
> | `_room` | `room` |
> | `_safe_stop` | `safe_stop` |
> | `_crossing` | `crossing` |
> | `_on_its_platform` | `recoverable` |
> | `MapRun.tap_context` | `context` |
> | `MapRun.learn_jump` | `learn_jump` |
> | `MapRun.jump_shift` | `jump_shift` |
>
> The bounded tap controller (`_tap_step`, `_send_tap`, `_taps_begun`) is `positioning.TapPositioner`
> (`step`, `send`, `begin`). `TapResponse` and its helpers are in `worker/tap_response.py`. A Wait for transition's
> pending state is `pendingTransition` (`TRANSITION_CONFIRM_MS`); it was `pendingLanding`
> (`LANDING_CONFIRM_MS`). What each decides is unchanged, checked against the user's runs with
> `worker/trace_replay.py`.

## Protocol

An `apply` starting a timed action includes the existing schemas and observation
timestamp, plus:

```json
{
  "actionId": 1,
  "durationMs": 100,
  "sequence": [[0, 0, true], [16, 0, false]]
}
```

Events are `[milliseconds from executor start, configured button index, down]`.
Initial held keys are represented by time-zero events. The separate `buttons`
array does not pre-press keys for a managed sequence. Actions last at most 30
seconds and contain at most 512 ordered events within their duration. The guard
releases remaining keys on completion, cancellation, or input failure.

IDs increase within one configured session. Duplicate or older IDs do not replay
inputs, including after completion. Configuring a new session releases inputs and
resets the ID history. An empty sequence without an ID cancels current playback.

`apply` and `heartbeat` return `execution` with:

- `id`, `state`: idle, running, completed, cancelled, or failed.
- `startedAt`, `finishedAt`, `elapsedMs`, `durationMs`: native monotonic milliseconds.
- `executed`: processed sequence events; repeated held states need no new OS event.
- `lateMs`: maximum event dispatch lateness (measured when the send begins), not game input-consumption latency.
- `cause`: why a cancelled action was cancelled (focus, takeover, window, watchdog, request, configure, stop, error, shutdown).
- `held`: virtual keys actually held by the guard at the time of the reply.
- `error`, `clock`.

Completion is published after key release. The behavior worker uses the matching
ID's completion, not its own estimate of elapsed time. Nested trees share IDs.
Cancelled/failed clips fail the node or map link; map arrival checks still require
observations.

## Liveness and freshness

Electron sends a heartbeat every 50 ms only while a managed action is running.
It carries `actionId` and both schema identities. The guard renews its 300 ms
watchdog only for that matching running action, with the target still valid and
focused and no human takeover. Heartbeats cannot start actions or sustain ordinary
held-key predictions. Terminal actions stop receiving heartbeats.

New actions retain the guard's 250 ms observation-age limit. Stale observations
cannot advance a managed tree. While a clip runs, continuation results do not
reapply estimated button states, even if the clip finishes during computation.
The newest observation arriving while computation is busy replaces the pending
one; older deliveries are ignored. Focus loss and takeover still cancel playback.

## Validation and next stages

`timed-sequence` runs the actual native timer with a fake input sink, so tests do
not inject system input. It covers a two-second hold, a short pulse, event order,
duplicate/old IDs, completion, cancellation, rejected input, and duration bounds.
Play-loop and Python tests cover delayed observations, completion races, nested
trees, and cancellation after an estimated end time.

This is the timer-execution milestone. It does not add a D3D hook or attach render
frame indices to recordings. Event dispatch timing does not guarantee which game
update consumes an input. In-game replay should compare repeated runs from the
same starting state before calibrating movement clips.

## Driving a learned map

Learned-map Drive defaults to **Recorded sequences**. `movement.learn` finds
stop-to-stop movements (keys released, position stable for at least 80 ms; grounded
when that observation is available). It retains each recording's complete key
timeline. It does not join movements at intermediate grid cells. Checkpoints can
join recordings only on the same level and within 4 px; their positions are not
averaged. Each recorded variant remains a separate edge with its own timing and
failure statistics.

A replay starts within the map's **Start within** of the recorded start (default
6 px) after standing still for **Still for** (default 80 ms). The native
executor runs the entire sequence, up to 30 seconds/512 events. Passing a waypoint
does not interrupt or replan it. After matching executor completion, the worker
requires arrival within **Arrive within** of the recorded end (default 6 px) and the
same stillness before replanning. These are the map grid's `replay` settings
(`replay_settings` in `worker/behavior.py`); nothing in them is about a game.

A replay carries whatever offset it starts with all the way: in the user's runs a
rope jump came out 4–5 px off, the offset decided by the speed at the last landing
before it, and missed. So the map can **line up with taps** (`replay.lineUp`: the
keys moving the player each way along x, and y if set; `_line_up`): further than
Start within from a recorded start, but within **From within** (default 48 px), it
taps toward it, standing still between taps. Each tap is as long as the last one's
move per ms says is needed for what's left (1.5x when it barely moved), within
5..400 ms, up to **Up to** taps (default 8), so it learns how far a tap goes in the
game rather than being told. Without keys, or out of taps, the Go node fails saying
how far off it was and the least a tap moved it. Each line-up is a trace event
(`line-up`: from, to, each tap's keys, length and move), shown in the map's Runs
with the attempt it led to, or on its own when it failed.
Cancellation and failed arrival fail the link. Focus loss, takeover, watchdog and
fresh-observation requirements still apply. The map's ordinary link timeout does
not cut a recorded sequence off before its duration and arrival allowance.

An unlinked destination marker resolves to a recorded checkpoint on the same level
using `Planner.place_at`; the status names that point. Manually linked places retain
their behavior. The editor shows checkpoints, the active route, the nearest stop,
and omitted clips. Missing timestamped events, capture gaps, input resynchronization,
or movements longer than the limit are not replaced with guessed inputs. Older
recordings without the optional grounded State can use position-and-key rest checks.

**Grid held keys (legacy)** retains the old cell controller, including empty-key
coasting links. Policy planning still uses its spatial grid independently of Drive's
execution mode. Sequence caches use a separate format/key and generated link IDs
cannot inherit the old grid's failed-link statistics.

## Monitoring recorded movements

Each recorded link retains its sampled trajectory. During playback, the worker
compares the live position against the same level of that trajectory within
150 ms either side of the current playback time. Playback time uses the captured
observation timestamp and the native executor's acknowledged start, rather than
the time the worker finishes processing. Interpolation never crosses levels.

A deviation greater than 24 px must persist for at least 150 ms of new observations
before it fails the link. A confirmed deviation cancels the remaining sequence,
releases inputs, and fails the Go node instead of continuing from an invalid
position. Restart from a valid checkpoint after correcting the cause. The monitor
allows timing variation; it does not change recorded input timing or guarantee a
jump succeeds. Duplicate observations cannot confirm a deviation.

Missing position feedback for 250 ms also fails an active recorded link. The main
process independently stops supervised playback when no fresh matching position
check arrives for 500 ms, including when the worker stalls while frames still
arrive. Ordinary Press nodes and manually selected clips retain their independent
timed execution. Monitor status and behavior traces include expected/actual
position, error distance, elapsed playback time, and tracking/suspect/failed state.

## Measuring a replay

Tree Replay's **Movement** report (`behavior.replay`) compares each recorded link a run replayed with its recording.
It only measures; nothing in it changes how a tree runs.

- The guard keeps every press of its last 8 actions: due, send began and send returned (ms from the action's start),
  and whether an OS event went (`emitted`, `unchanged` for a key already in that state, `failed`). The `dispatch` op
  returns them; Electron asks once per ended action and the next behaviour step writes them into the trace.
- Memory and Lua readings carry `readAt` (monotonic ms the read began) and `reused` when a frame got the previous read
  again (the probe gap, now the runtime's `probes.gap`). Repeated readings are left out of the live path. Positions are
  stamped with their frame's capture time, so the report shows how long after capture they were read.
- Link attempts are trace events: begun (with a recorded link's clip and trajectory) and ended (with a cause).
- Per key event: due and sent time, recorded and live positions at the due time (observed or interpolated, and the
  distance in ms to the nearest real reading), raw error, and the lag fitted over ±150 ms of readings with the error
  left after it. A lag can't be told where the player isn't moving.
- Per attempt: where the raw error first passed the threshold and where the divergence it ended in began, counting only
  readings whose recorded position is within 25 ms of a real recorded one, and how long inputs went on after that.

The first run measured (2026-10-19, a 16 s recorded link) showed dispatch at most 5.2 ms late and the replay within a few
px for 9.7 s, then diverged for good. Its recorded trajectory had readings 42–208 ms apart, and one recorded position
was about 200 ms ahead of its stamp, so recorded timing, not only replay timing, needs checking before calibrating.
Recordings made now carry `readAt` on their memory and Lua values.

## Waiting for a State inside a movement

Some presses only count in some state. Measured on MapleStory (2026-10-19, FireFly's runtime and guard driven by a
script on flat ground):
- a jump pressed in the air was ignored, whether released before landing or held through it (0 of 46);
- holding the key never jumped again (10 of 10);
- a fresh press on the ground always jumped, from the moment FireFly saw the landing (~15 ms after the first grounded
  reading, at most ~45 ms after the landing) to 250 ms after it (59 of 59), launching 0–50 ms after the press.

So a recorded press timed by the clock is lost when the replay lands a little later than the recording did.

A map's **Wait for** (`replay.sync`, a true/false formula such as `` `On Ground` ``) fixes this without FireFly knowing
what it means:
- **Learning** (`movement.sync_points`): every press in a recorded movement that came up to
  **syncWindowMs** (default 300: on the user's jump quest, jumps came 180–280 ms after a landing, walking a few steps first) after the State turned true (false at one sample, true at the next; a press between the
  two counts, at the press) splits the movement there. A recording without the State keeps its movements timed by the
  clock, with a note.
- **Playing** (`Behavior._play_parts`): each part plays on the guard's clock. The keys the recording held through the
  wait stay held (the guard's `keep`: a completed action leaves them down, the play loop holds them each frame, and the
  next action starts from the keys already down rather than letting go and pressing again). The next part starts once
  the State has been false and then true since the part before began, its presses as long after that moment as they
  were in the recording.
- **Whose landing:** each wait belongs to its own turning true. `after` (with `afterKey`) is when the last key went
  down before the State turned false on the way to it, the jump whose landing it is. When that key is in the part
  playing, only a turning false and then true seen after it was sent counts. A part can hold more than one landing:
  on the user's long movement, the part from jump 11's press holds jump 11's landing and jump 12. Its wait for jump
  12's landing took jump 11's, about 2 s early, in all 5 runs that got there. Jump 13 was pressed on landing, came
  down 10–15 px short, and jump 14 missed its platform. `worker/test_sync.py`'s `OwnLandingTests` reproduces it on the
  test platformer (without `after`, the third of three jumps is lost).
- **Failing:** a wait running past its recorded time plus `SYNC_SLACK_MS` (300 ms, or half as long again) fails the
  link with cause `sync` (for instance a jump that never left the ground).
- **Monitoring:** the trajectory monitor and the replay report map live time onto the recording's from each wait's
  moment, holding at the part's end while it waits.

Trace events: `segment` (a part begun: its action, each press's recorded time, its clock anchor) and `sync` (a wait:
how long, how late, or why it failed). The map's Runs shows them.

On the test platformer (`worker/test_sync.py`), a jump 4% stronger than the recording's lands about 27 ms late. The
clock-timed replay then made 1 jump instead of 2 (the second press reached the game in the air); the one that waited
made 2. On the user's recordings with On Ground, 11 of 78 learned movements wait, 34 times in all.

## Pressing a jump where it's safe (adaptive takeoff)

A recorded jump timed by the clock takes off wherever the replay happens to be at that moment. On the user's jump quest
the most frequent failure, the walk-off jump at x −1324, failed 8 of 8 times this way: each replay pressed 0.6–6 px past
where it can be pressed safely. An optional **platformer model** (`worker/platformer.py`) lets the executor press a
simple jump where it's safe instead. The map still plans; the model only times presses inside a recorded movement, and
nothing in it is about one game.

**Turning it on.** In the map's replay settings:
- **Ground lines:** a shapes State whose lines the player stands on (`replay.ground`). This measures every recorded
  jump, and Runs reports it in either mode.
- **Press jumps:** `timed` (as recorded, the baseline) or `adaptive` (`replay.takeoff`).

Measuring needs to know when the player is on the ground: the map's On the ground, else its Wait for.

**Measured from the map's own recordings** (`platformer.fit`, cached with the learned movements):
- the jump key and the keys each way;
- walking speed;
- launch speed and gravity, each jump's launch time free;
- the fall cap;
- how far the position stands off the lines (`feet`; the user's map position is `` `Mem Char Position` + vec(0, -8) ``,
  measured as 8.0);
- positions at their read times (`readAt` of the States the position formula reads).

On the user's recordings the fit gives 0.557 px/ms up and 0.002003 px/ms² (the game's own: 0.555 and 0.002), and walking
0.1252 px/ms.

**Timing, reconciled.** Two measurements of press to launch differ:

| Source | Press to launch |
|---|---|
| Recordings (p10 / p50 / p90) | −12 / −2 / +14 ms |
| Controlled experiment | 19–52 ms |

They measure different things:
- **The recordings' figure is a kinematic origin.** The launch is fitted as the start of the arc through read-time
  positions. The game moves the player a whole update (about 30 ms) at once, and positions are read up to an update
  late. So the curve through them starts up to an update before the game took the press, and can come before the press.
  The negative values come from the fitting, not from the recorded timestamps. The same fit on the experiment's presses,
  timed by the guard's exact send times, gives −11 / +5 / +20 ms (−13..+24): the same kind of number, about 6 ms later
  for presses FireFly sends.
- **The experiment's 19–52 ms are upper bounds.** They run from the guard's send time to the first reading in the air.

So the model uses two separate margins:
- **Where it lands:** in the fitted convention, at every delay from the recordings' p10 to p90. The late end is widened
  by `INJECTED_MS` = 10 ms (`delays`: −14, −3, +22 on the user's recordings).
- **When it leaves the ground**, for walking off the end first: the recordings' p90 of press to first rising reading
  (`leaveMs`, 68 ms there, against the experiment's 48 for presses FireFly sends; the recordings read less often).

**A jump's safe stretch** (`platformer.jumps`, per recorded movement). A recorded jump is:
- **adapted** when it was pressed on the ground, holds only the jump key and one way's key, keeps them through the air,
  and goes from one ground line to another, and the model lands its own recorded press on the same line within 15 px.
  Its safe stretch is the press positions, within 60 px of the recorded one, where at every delay:
  - the player leaves the ground at least `EDGE_PX` (2 px) before its line's end;
  - it lands at least `LAND_MARGIN` (6 px) inside the target, or the model's error on this jump plus 2 px if that's
    more. A model 6 px off on a jump landing 31 px inside its platform no longer excludes it; what matters is the error
    against the room.
- **aimed** at the press position nearest the recording, at least `INSET_PX` (4 px) inside the stretch.
- **narrow** when the stretch is under `EXEC_PX` (8 px), and **unsafe** when there is none.
  - The movement holding it is marked `unsafe` (why). With adaptive takeoff, Go to plans without unsafe movements and
    takes one only when there's no other way, saying so (the link event's `takeoff.forced`).
  - Taken that way, its jump is pressed at the most robust place found (the most `room`) within where it lands on its
    target at all. It is never silently played as recorded.
- **planned from the line** when its key went down after the player, by its last reading on the line carried on at its
  speed, had already walked off the line's end. That press wasn't made on the ground, so the model isn't checked
  against it. Instead the stretch is of earlier presses on the line that still reach the line it landed on, with
  `UNCHECKED_PX` (4 px) more landing margin (`pressedPastEdge`). The user's −1324 walk-off jump, pressed 0.3 px past
  its line's end in the 5:30 PM recording, gets −1314..−1303, aimed at −1310. Of 8 replays taking it as recorded, all
  between −1320 and −1328, 3 never left the ground.
- **pressed by position** (`position`, `position_jump`): a running jump whose keys change in the air, from a ground
  line.
  - **What changes:** its arc isn't the model's to predict, so it gets no safe stretch. Only its press is timed by
    where the player is, and its keys in the air keep their timing from the press.
  - **The aim:** where the recording pressed it. If that's nearer the end of the line than the edge margin, it's
    aimed that far in instead. The edge margin is `EDGE_PX` plus how far the player walks over the spread of when the
    game takes a press (6.9 px on the user's recordings).
  - **An experiment, checked every time:** pressing earlier can change where it lands. Each press is checked
    (`takeoff-outcome`: risen `RISE_PX` within `NO_JUMP_MS`). A position jump that didn't take off is aimed
    `SHIFT_STEP` (2 px) further in, up to `SHIFT_MAX` (10). This is kept with the map's stats per movement and jump
    (`MapRun.learn_jump`, `jumps` in its link's stats).
  - **The user's first movement:** its second jump was recorded at −940, 2 px from the platform's end at −938. It was
    pressed 280 ms after a landing whose place varies, at −935..−945. All 6 of 28 attempts that fell pressed at
    −935..−939. Now it's aimed at −944.9.
  - **Timing (2026-10-20):** a position jump keeps its recorded run-up and its delay from what its part began on (a
    landing), as the rope jump at the user's quest's end showed was needed. It's pressed earlier only where waiting
    would carry the player past the latest safe press, and then just at that point. Short of the window at its recorded
    time, it waits for the player to be in it. A version that refused such a jump outright failed the first movement
    every run: its own recording pressed at −940.1, past the model's latest safe press (−942.8). It's now pressed at
    −942.8. The learned aim shift is off.
  - **Aim versus window:** the aim is where it prefers to press. Its window runs to the latest press the model rates
    safe: the player, walking on while the game takes the press (up to the late end of `delays`), still leaves
    `EDGE_PX` short of the end (`lateMargin`; −942.8 there). That's the model's estimate, not a margin the outcomes
    have checked; outcomes move both in. Past the aim but inside the window, it's pressed at once.
  - **Turning into the jump:** while the key forward is held through the wait, the press is timed from walking speed,
    and the player's position is carried on at it. The readings during a turn still show it going the other way;
    waiting for them to show walking let the player pass the aim between frames, three runs in a row.
- **a walk-off** (`walkoff`): a flight that didn't rise `RISE_PX`. The player walked off an edge and the jump key went
  down in the air, where it did nothing. It's played as recorded and never moved.
  - In this model a jump rises. That's the platformer model's own definition, not FireFly's: another game's jumps need
    their own model.
  - The user's movement from (−1907, −1054) pressed space 61 ms after walking off and rose 0 px. Taken for a position
    jump, its press was moved 11 px earlier, onto the platform. The replay then jumped where the recording fell, and all
    three runs stopped there, about the 17th movement.
  - Played as recorded, the press reached the game with the player still on the ground, 1 px short of the edge, when it
    got there a little later than recorded (01:53:57), and it jumped. With adaptive takeoff, a press the analysis found
    did nothing is left out of what's played, with its let-go (`_played`; the link event's `takeoff.dropped`). The
    recording keeps it, and timed mode plays it.
- **timed** (played as recorded) otherwise: keys changing in the air, ropes, or a landing the model can't predict.

On the user's 5:30 PM recording: 23 jumps adapted, 4 unsafe, 2 narrow (5 movements unsafe), 18 timed.

Against the existing replays (90 presses), with the margins above:

| Replay took off | Worked |
|---|---|
| Inside the safe stretch | 79 of 79 |
| Outside it | 12 of 22 |

8 of the 10 failures outside it were the −1324 walk-off jump.

**Playing** (`Behavior._play_parts`, `_takeoff`):
- **Splitting the movement:** an adapted jump cuts the movement into parts like a Wait for does. A jump at a wait's
  moment replaces the wait. The keys held into the jump (the direction) stay held while it waits.
- **Waiting:** each frame it estimates where the player is now from its newest reading, carried on at walking speed.
  - Standing, the jump is pressed as long after its part began as in the recording (a press can't move a standing
    player), if the player is within its stretch, else it fails. Pressing it at once instead turned the user's jump
    13, pressed 98 ms after a landing as the player turned, into one pressed on landing: it came down 13 px short in 4
    of 4 runs, and jump 14 after it missed its platform's end.
  - Moving, it's sent once the aim is due within `TAKEOFF_HORIZON_MS` (40 ms) or 1.5 frames, whichever is longer. The
    press goes in the action `lead` ms on, so the guard times it to the millisecond. That decision is made once and
    never moved again, so there's no rescheduling near the target.
  - Past the aim but still inside the stretch, it's pressed at once. Past the stretch, the link fails with cause
    `takeoff`.
  - **Past the stretch:** a moving jump can't be reached going that way. If it can stop before the edge (the room left
    is more than its stopping distance: the most a tap has slid on, at least `SLIDE_MS` of walking, plus how far it
    went since its reading), it walks back (`_reposition`). Otherwise it fails at once ("too near to stop"). In the
    three failed runs it walked back from −941, 3 px from the end, still sliding toward it, and went off it. Walking
    back: it lets go of the way forward, holds the other way to `RUNUP_PX` (32 px) behind the aim on
    the line it jumps from, then comes at it again. It does this up to `REPOSITIONS` (2) times, each giving its wait
    `REPOSITION_MS` more. The keys each way are the model's. It fails with cause `takeoff` when:
    - the model has no keys each way;
    - the line leaves under `RUNUP_MIN_PX` to run at it;
    - it has passed the stretch again after the last walk back.

    The map then plans again. Leaving the line it jumps from while walking back fails it at once, with nothing held,
    and so does standing on a line below that one while waiting (it fell: waiting won't bring it back up). The failed
    runs held the way back for 3 s along the floor they fell to. Trace event `reposition`; Runs lists where it walked back from and to. The user's jump 1
    (stretch −883..−863, moving left) was reached past it once, at −884, and gave up; now it walks back to −847.
  - It only presses on the line it jumps from, and not while Wait for is false.
- **The rest of the movement:** everything after the jump keeps its recorded timing relative to the jump.
- **Monitoring and arrival:** the trajectory monitor and the arrival check expect the rest of the path shifted by how
  far from the recorded press it took off (`shiftX`). An end reached that way counts as at its place for the next plan,
  which lines up with the next movement from there.

**Runs.** Each `takeoff` event holds the plan: aim, stretch, lead, estimated and observed position, and predicted
landing. The replay report adds per jump (`replay_report._jumps`):
- where the player was when the guard sent the press;
- whether that was inside the stretch;
- where the model says that lands;
- where it landed: its target, back where it left, elsewhere, or no jump;
- the landing error.

A landing further from the model's than the landing margin (6 px) is marked ⚠ (`modelOff`), and the Runs list counts
those, so a jump the model is off on stays visible when it happens to land (the user's jump 9, −12.8 px).

**Tap length** (`TapResponse`). How far a tap moves the player isn't in proportion to how long it is. On the user's
game, 5 ms taps never moved the player, 40 ms taps moved 0–8 px, an 80 ms tap 15 px, and a longer one walks and then
slides on. Two controllers failed on this in turn:
- Scaling the next tap by the last one's move per ms turned a 40 ms tap that moved 1 px of 15 into a 260 ms tap that
  carried the player 37 px past and off the platform.
- A fixed worst-case bound then left taps of 5–17 ms. The game didn't see them: 21 of 24 moved nothing, and line-up
  gave up on the slope in three runs.

Now each correction is chosen from what taps of each length did, kept per map and axis with its stats (`_taps`,
`MapRun.note_tap`; seeded from the `line-up` events of its runs' traces when it has none yet, `Worker._traced_taps`):
- **The worst case** (`upper`) is no more than a shorter tap moved plus walking speed for the difference, and no more
  than a longer one moved. With nothing to go on, walking for it plus `SLIDE_MS` (30 ms).
- **Nothing has moved it yet:** it tries the first tap, then half again past the longest that didn't move it.
  Otherwise it takes the shortest tap that typically covers what's left (the median of taps within 30% of that
  length), at least the shortest that has moved it.
- **Limits:** never longer than the longest whose worst case stays within what it may move, nor twice the last tap.
- **What it may move:** in line-up, never worse than now (at most as far past the start as it is from it, or Start
  within). In a standing jump, never past the far side of its stretch. In both, never off the end of the line the
  player stands on.
- **When even the shortest tap that moves it could overshoot that,** it isn't tried. The correction fails saying so,
  and the map plans from where the player is.
- **By context** (`MapRun.tap_context`, `TAP_GRADE`). Each tap is kept with the ground's grade under the player the
  way it taps, by the platformer model's lines: `up` or `down` past 0.2 px per px, else `flat`
  (`TapResponse(..., context)`). It is never more than twice the last tap in that context.
  - **How far a tap moves the player** is read from taps in its context where they say. Its typical move comes from the
    context's taps near that length, else from what they bound it to; its worst case comes from the context's taps
    once one is no longer than it. With no taps in the context, every tap counts.
  - **Whether the game takes a tap that short at all** (the shortest that has moved it, the longest that hasn't) doesn't
    depend on the ground, so every tap counts. Read from the context alone, the first run with contexts (02:59) kept one
    60 ms flat tap that moved 8 px. Every small line-up after it refused ("the shortest tap that has moved it, 60 ms,
    could move it 8.0 px, more than the 6.0 px it may"), though 25 ms taps move the player 2 px. Both runs stopped
    within the first four movements. Up to 60 taps are kept per context, and taps from before contexts
  count as having none. Nothing about how a game moves on a slope is written in: it's read off the taps.
  - The case behind it (02:37): one 100 ms correction tap carried the player 17 px down the user's slope (67 px in 55),
    to (−1904, −1122). Lining up with the next start (−1897, −1129), back up it, then chose 25–50 ms taps from taps
    made on the flat and down the slope. They moved it 0–1 px each, and it ran out of its 8 taps 2.0 px off, with Start
    within 2 px.
  - `SlopeTapTests` replays this from the user's taps as they were before that run, on their own ground line. With
    contexts it lines up in 4 taps, the third 120 ms up the slope. Without them it runs out of taps, as it did.

**Standing jumps outside their stretch** are tapped into it (`_stand_into`, standing still between taps, trace event
`stand-reposition`), then pressed, but only from a real standstill with no key held into the jump. The user's jump 15
was at −2039, 0.2 px outside −2039..−2003, and failed outright.

A standing jump with a **run-up** (a key held from earlier in its part into the jump; the user's movement 12 presses
right and jumps 37 ms later) is never interrupted:
- Letting go of the right to tap the player into the stretch made it jump from a standstill. It came down short and
  the run ended.
- Instead, it's checked where the run-up as recorded will carry the player at the press (`_recorded_dx`). If the
  movement opens with such a jump, and from the recorded start it would take off outside its stretch, the movement
  starts that much further along, toward the jump's aim (`_start_for`), and lining up happens before anything is
  pressed. Movement 12 starts from −1317 instead of −1322.
- A run-up later in a movement that would miss its stretch fails, saying so.

**Start within on a slope** (`_start_off`). On a ground line that also runs under the recorded start, it is measured
in the line's terms: along it (x) and off it (how much further above or below the line the player is than the start
was). The straight distance counted the slope's rise. On the user's slope (67 px in 55) the player stopped at
(−1544, −583): 3.6 px straight, 2.1 measured this way. On flat ground, and without the model, it's the straight
distance as before.

**Arrival, alignment and recovery.** A recorded movement that ends further than Arrive within from its place, but on
the ground line under its recorded end and within Line up with taps' range of it, reached its platform; only its
alignment is off. It isn't learned as failed then (`_on_its_platform`, link-end `pending`). It's learned once lining
up says (`_resolve_arrival`, trace event `link-recovered`):
- **Worked, its time with the correction's:** when the next line-up succeeds, the next movement begins within Start
  within, or the Go node is at its destination.
- **Failed:** when lining up fails or the Go node fails first.

Only failed ones count toward Give up on a link after. Runs says "reached its platform, put right (…)" or "not put
right". In three runs, 19 arrival misses (2–17 px), all on their platform and all lined up next, were each counted as a
failed movement. One that misses its platform, or a map without the model or Line up with taps, fails as before.
Counts are per denominator: jumps are the presses the analysis classes as jumps; walk-offs and timed ones are listed
apart.

**Cache.** Learned movements are cached by a hash of the code that analyses them (`ANALYSIS` in `worker.py`: movement,
platformer and keys). Position-timed jumps went unused in a round of runs because the version bumped by hand was
forgotten.

**A recorded correction after a landing** isn't fixed by waiting for the landing. Movement 15's left tap already waited
for it: sent 0–24 ms after On Ground turned true, against about 30 ms before the first grounded reading in the
recording. The same 65 ms tap moved the player 7 px left in the recording and 1–2 px right live, because live it landed
7 px further right and still moving right. Ending a movement at its recorded end is a matter for the bounded line-up.

**Ending a movement on its recorded end (terminal correction).** The user's movement (−1813, −1002) → (−1900, −1127)
failed three times in a row (02:01:04, attempts 21, 23 and 25) with its keys sent exactly as in the run where it
worked:
1. its first jump landed and stopped at −1894 rather than −1903;
2. its second went straight up from there onto the flat end of the line above (−1898..−1875);
3. the Right pressed in the air 113 ms before the landing and let go of 125 ms after moved the player 2 px in the
   recording, during the landing lag, and 20 px live, off that line's end.

Cutting the press at the live landing wouldn't do. Seeing the landing and the let-go reaching the game take 60–100 ms,
6–10 px of walking, about the margin there was. So:
- **At learn time** (`platformer.finish`, the link's `finish`): after a movement's last landing, the player stays on
  the ground on the line it ends on. Its trailing presses of the keys each way (the model's) that went down after its
  last takeoff are a positioning nudge when they meet both conditions:
  - pressed in the air, they didn't change its speed across (`STEER`, 20% of walking); one that did steered and is
    part of the jump;
  - after the landing they moved it at most `NUDGE_PX` (12 px); more is a walk to its end, played as recorded.

  Any other key pressed after the last takeoff (up, an attack), leaving the ground again, or landing on another line
  than the end's keeps the ending as recorded (`status: 'kept'`, with why). On the user's map: 8 movements correctable
  (2 with a nudge: movement 19's Right at 985 ms, 1 px, and movement 14's Left, 4 px), 4 kept.
- **Playing** (`Behavior._finish`; adaptive takeoff with Line up with taps along x, so timed replay stays the
  baseline): the nudge isn't sent (`_played`; the link event's `finish.drop`). Once the movement has played, the
  correction begins only when the player has landed where its end is safely reachable:
  - on the ground (Wait for);
  - on the ground line its recorded end is on, so getting there crosses no edge;
  - within Line up with taps' range of the end, standing still.

  The bounded tap controller then taps it within Arrive within of the end. It's the same `_tap_step` that lines up
  with a start, so it uses the learned taps, is never worse than now, and never goes past its line's end. Elsewhere
  (another platform, in the air) it never begins, and the movement's own arrival applies.
- **Facing.** The nudge was also the last key each way, so it set the way the player ended up facing (`restore`).
  When the correction's last tap didn't face that way, one tap that way is sent, if one can't carry it out of Arrive
  within or off its line (`_facing_tap`: the shortest tap that has moved it, else the longest safe one longer than any
  that didn't). The `finish` event says `facing.kept`:
  - true only on evidence, the tap having moved the player;
  - null when it was sent and moved nothing, since such a tap may not have reached the game;
  - false with why when no tap was safe.
- **Accounting.** The link-end carries `arrival`: `direct` (onto its end with no correction tap) or `corrected`. A
  correction that fails ends the link with cause `finish`. The `finish` event holds the taps, the presses left out and
  the facing. The replay report gives each attempt an `outcome` and the run a `summary`, each counted apart with the
  denominator: direct, corrected, recovered (missed its end on its platform, put right by the next line-up), failed,
  not ended, and retries (attempts of a link already tried in the run). Runs shows the summary above the list and the
  correction under each attempt.

On the real map, offline, with the failed attempt's frames up to its landing and the player held where it stood without
the Right (−1894, −1129): part 2 is sent without the Right, the player is 6 px from its end (within Arrive within, 8),
and a 20 ms Right capped at 2 px of movement faces it as recorded. `FinishTests` and `FinishAnalysisTests` in
`worker/test_takeoff.py` reproduce it on the test platformer: a short ledge whose right end is 10 px from the recorded
end, recorded with a 110 ms landing lag (the Right moves it 1.5 px), replayed 4 px nearer the edge with no lag. Timed,
it walks off. Adaptive, the Right isn't sent and it ends on the ledge. Also covered: correcting a landing 6.5 px off
with a left tap, saying the facing couldn't be kept safely, never beginning on another platform, and keeping the
presses without Line up with taps.

**Jump 1's spread, measured** (scratch analysis of every replay of that movement). Two things vary, both below
FireFly's timing:
- **Its flight**, in 3 of 4 replays, was the same path frame for frame: about 0.168 px/ms across, landing at −1889/−1890
  at the same moment. The 4th (attempt 23) left the ground one game update sooner after the Left. The game moves the
  player about every 30 ms, 5 px a step in the air, and the run-up is 49 ms, so it gets 1 or 2 updates of walking
  depending on their phase. That run walked 4 px instead of 7, flew at 0.127 px/ms, and landed 17 px short (−1872).
  The recording walked 7 px.
- **The slide after landing** was 13 px in the run that worked (and 10 px in the recording) but 5 px in attempts 21 and
  25. The Left was let go 15–17 ms after the landing reading in all three. With the same inputs to within 5 ms, which
  update the landing and the let-go fall on decides it.

**A position jump's takeoff region** (`TAKEOFF_REGION_PX`, 4 px: half the model's executable stretch). A running
jump whose keys change in the air keeps its recorded delay after what its part began on (a landing), and that alone
pressed it wherever the jump before had landed.
- **The case behind it:** the user's last movement's jump 4 follows jump 3, which is played as recorded (the model is
  35 px off on it) and landed anywhere from −1819 to −1825. Jump 4 was pressed 4.6–7.6 px short of its recorded place
  in the runs that made it. In 03:05 it was 11.9 px short and came down past its ledge's edge.
- **The rule:** the recorded delay is the earliest press. If the player would be short of within 4 px of the recorded
  place by then, the press waits until the player gets there, with the key forward held. It is never past the latest
  safe press (the region's far side is that limit), and past the window the existing checks stop it before the edge.
  Everything after the press stays timed from the press.
- **What it changes on the user's map:** jump 4 (5 of 5 runs were pressed more than 4 px short), the second
  movement's jump 14 (2 of 6) and jump 2 of the movement from (−1738, −520) (4 of 6). The last two worked every time
  pressed 4–7.5 px short, so watch them in the repeated runs.
- **Tests:** `TakeoffRegionTests` on the test platformer: a hop played as recorded, then a position jump onto a ledge
  only reached pressed near its recorded place. Replayed 9 px behind, timed and the recorded delay alone both miss it;
  with the region it waits and lands on the ledge. Replayed as recorded, it keeps its recorded delay.

**Walks, their ends, and going on from them.** A walk (a movement that never leaves the ground) that starts and ends on one
ground line gets the terminal correction too (`platformer._walk_finish`, the link's `finish.walk`). Its presses are the
movement, so none are left out.
- **Accepted ends:** a movement accepted within Arrive within of its end but outside its place's reach (Start within)
  leaves the map going on from its destination (`shifted`). That holds until the next movement begins, not only for
  one frame. Lining up with the next movement takes frames, and on the second the map took the nearest place instead.
- **Missed ends:** a movement that missed its end on its destination's platform (`pendingArrival`) also goes on from its
  destination, not from whichever place is nearest.
- **The case behind it** (03:21–03:29): the user's 14 px walk (−1753, −520) → (−1739, −520) moved the player 7 px in 6
  of 12 attempts. It was judged by its place's 2 px reach rather than Arrive within (8). Its start and end were then
  equally near, so the map lined up back to the start and replayed the walk, three times, and gave up on it (03:28:07).
- **Counterfactual on those 8 runs:** of 28 arrival misses, 25 ended within Arrive within on their line (direct now), 1
  was 10 px off on its line (corrected now), and 2 walked off a platform's edge (unchanged).
- **Tests:** `WalkEndTests` and `MidpointRecoveryTests`.

**Tap contexts by steepness.** `flat` under a grade of 0.2, else `up`/`down` and `gentle`/`steep`, from 45° (`TAP_GRADE`,
`TAP_STEEP`). A 120 ms tap chosen from taps up the map's long slopes (1.22) moved the player 18 px up an 11 px bump of
0.73, and the line-up took 7 taps (03:28:50). With no taps in its context, the expected move comes from every tap. The
worst case then uses only the conservative rule (a shorter tap's move plus walking), since "no more than a longer tap
moved" holds within one context only: a steep-uphill 120 ms tap (4 px) had bounded a flat one (19 px). Taps kept as
`up`/`down` before steepness count only among every tap. Tests: `SteepnessTapTests`.

**Jumps judged as played** (`platformer.jumps(..., dropped)`, `asPlayed`). A jump whose only keys changing in the air are
presses the movement's end correction leaves out (its trailing nudge) is judged without them. The executor takes it
that way only where they are left out (`_bounds`: the link's finish active), else as recorded.
- **The case behind it** (03:42–03:49): the user's movement to (−1900, −1127) failed 3 of 7 times. Each time, a slow
  first jump (its 49 ms run-up given one game step of walking instead of two: 0.127–0.130 px/ms across, against
  0.142–0.170) left the player at −1871 to −1874. From there its second jump, straight up, wasn't under the platform
  above.
- **What changed:** the second jump's only key in the air was the 2 px Right the correction drops. As played, it is a
  standing jump the model knows (1 px off, safe stretch −1947..−1881, aimed at −1903, where it was pressed). The
  existing standing logic (`_stand_into`) taps the player into that stretch first: only from a standstill, with
  nothing held into the jump, never past the stretch's far side or off its line. It's the only jump on the user's map
  this changes.
- **A latent bug, fixed:** when the last tap carried the player into the stretch, the takeoff waited on that finished
  tap for ever and the movement timed out.
- **Tests:** `AsPlayedJumpTests`.

**After a recorded movement fails** (any cause, a deviation included): every key is let go of, this frame's held keys too
(they used to stay down for the frame it failed in). Nothing is held or planned until the player is on the ground (the
map's Wait for) and still (Still for), within `SETTLE_MS` (4 s), else the Go node fails. Then the map plans from where
the player is. The failure counts against its link, so Give up applies.
- **Before:** a deviation ended the tree at once, and other failures planned straight away. The map's approach tree then
  walked the player along x through falls and off further edges.
- **Tests:** `SettleTests`, and `test_movement.py`'s cancelled and missed-jump cases, which now replan once still.

**Recovery checkpoints** (`platformer.checkpoints`, `partial`; stages 1–2 of 5: inferred and drawn, not resumed from
yet). A long recorded movement has no place inside it. The user's second jump quest's first movement is 13 s and 12
jumps without a stop, so after a failure in it the player was 400–600 px from any place and the run ended. The
recording already holds its intermediate landings. Each landing on a ground line the model knows is a checkpoint, kept
as a movement state, not a place:
- **The state:** the position region it resumes from (±`CHECK_REGION_PX`), level and ground line, the speed across
  (measured over up to 150 ms on the ground, until a key next goes down) with its range (±`CHECK_SPEED` of walking),
  direction, the keys held, the time in the clip the rest starts from, and the next jump (status, how soon).
- **`stable`:** under `STABLE` (30%) of walking with no key each way held, so the player can stop there and go on.
- **`dynamic`:** running on. It is reproducible only by running up into it: the model's `runUp` (from the recordings'
  own starts from standing, their 90th percentile: 13 px on the user's map) has to fit in the ground behind it
  (`roomPx`, plus `EDGE_PX`), and its next jump has to be one pressed by position (`BY_POSITION`), since arriving from a
  run-up rather than as recorded changes a jump played on recorded time.
- **`partial(link, checkpoint)`:** the rest of the movement as a link of its own (`<id>@<n>`). It keeps `parent`,
  `recording` and `checkpoint`, so its outcomes are learned apart from the whole movement's, and everything in it is
  re-timed from the checkpoint.
- **On the user's map:** 52 landings, 9 stable, 27 dynamic resumable, 16 not (10 with too little ground behind them, 6
  with a jump after played as recorded). Across the map's 24 movements, 29 of its 30 landings that a press waits for
  were dynamic.
- **Against the four failed runs:** the three that stopped at jump 9 came to rest on its 35 px platform, 7–9 px from the
  dynamic checkpoint at (3, −136). Its run-up start at −10 is within line-up range, and resuming there skips 9.7 s of
  the route. The fourth fell to the floor, where no checkpoint is and the start is 802 px along: a walk along the line
  (stage 5).
- **Shown:** the map editor draws them as small diamonds (filled stable, outlined dynamic, faint when not reproducible),
  and its learned summary counts them.
- **Tests:** `worker/test_checkpoints.py`.

**Ground a correction can't stop on** (`Ground.safe_room` in the optional movement model, `CREST_GRADE` 0.2). A tap's
room ends at the line's end or at the first downhill (the way it taps) past its target, whichever comes first. A
downhill before the target is the way there and doesn't count. The executor's `_room` asks the model for it.
- **The case behind it** (14:23 and 14:35): the walk to (438, −342) stopped 15–16 px short. Its correction's 250 ms tap
  was allowed because its worst case stayed short of the line's end, 37 px on. It carried the player 2 px past the
  crest at 439, and it slid down the slope beyond, with nothing held, and off the end of the line.
- **A first safeguard only:** how far the player goes on after a key is let go of isn't modelled yet.
- **Effect on past runs:** it would have tightened 41 of 561 taps, most at the first map's (−1897, −1129) on the top
  of its long slope.
- **The worst-case bound:** a tap longer than any in its context also takes the worst case from all taps. A flat
  context's 60 ms taps had put a 120 ms tap at 16 px, where 100 ms taps had moved the player 19.
- **Tests:** `CrestTests`, including a downhill walked down to a target below it.

**A landing pending confirmation** (`pendingLanding`, `LANDING_CONFIRM_MS` 120). A wait's State turning true is a landing
pending until a reading puts the player at its expected destination.
- **Confirmed:** the next part plays, timed from the moment it turned true.
- **A reading on another platform:** rejected at once.
- **No reading confirming it within the timeout:** rejected too. A reading on no line says nothing yet, since the
  position can lag the State by a frame.
- **The case behind it** (14:33, the first map's last movement): the frame On Ground turned true still carried the
  position from before, 8 px above the line. The right landing was taken for a wrong one and the wait timed out.
- **Tests:** `PendingLandingTests` in `worker/test_replay_regressions.py`.

The four failures of 14:52–14:54 were each one jump that ended within a few px of a limit. Each fix below is tested on
its original jump in `worker/test_takeoff_traces.py`: the recording's samples around it, or the trace's readings up to
where the trace's own press changed what followed. Each test also shows the jump as it was before the fix.

**A takeoff read from the last reading on the ground** (`_on_ground_at` in the optional movement model,
`TAKE_STALE_MS` 100). A flight's last reading flagged on the ground can already be in the air: On Ground can lag the
position by a reading. One more than `ON_PX` above the line the reading before stood on, within `TAKE_STALE_MS` of it, is
taken as off the ground, and the takeoff is the reading before. A reading beside the line rather than above it (walked
off its end) isn't moved.
- **The case behind it** (14:54:34, the second map's movement 6, jump 3): On Ground was still true 16 px up, so the jump
  read as "not from and to a ground line" and played as recorded. Two jumps of the second map read this way.

**A small predicted miss is the model's error** (`_near_miss`). When the model lands the recorded press off its target,
it looks for the nearest press within `MODEL_MAX_PX` that the model does land there. If there is one, the jump's
`modelErr` is the model's landing carried back to the recorded press (an arc moves with where it's pressed), minus the
recorded landing, and `nearMiss` is how far the press had to move. The margin grows with the error (|error| + 2), as for
any jump. So a near miss is taken as uncertainty, not as proof the recorded press was safe. A miss further than
`MODEL_MAX_PX` is still "lands it elsewhere".
- **The case behind it** (the same jump): the recorded press, by the model, landed at 303.2 on a platform ending at
  303. The recording itself came down at about 300. Played 2–3 px later than recorded, it came down at about 304 and
  fell.
- **Now:** a narrow 2 px stretch at 338–340 (`margin` 10.5), where the model lands it at least 10 px inside at every
  delay.

**A position jump's window keeps its landing** (`position_jump`'s `landingWindow`). With the line its recording landed
on, the window also holds only presses whose landing, moved with the press, stays `LAND_MARGIN + UNCHECKED_PX` (10 px)
inside that line. Taking a jump with keys changing in the air to move with its press is only roughly right, hence the
wider margin. Where no press both lands with that room and is safe to leave from, the window is the latest safe press.
- **The case behind it** (14:52:27, the first map's g2 → g3, jump 5): the recording landed 8 px inside its platform. It
  was pressed 6 px before where it was recorded (its 4 px takeoff region plus 2 px of estimate) and came down 1 px short.
- **Now:** its window is −2109.2..−2106.8, from 2 px after the recorded press.
- **Effect:** it narrows the windows of 22 of the three maps' 145 recorded jumps.

**A stop watched before refusing** (`STOP_WATCH_MS` 400, the `stop-watch` event). Past a moving jump's safe stretch,
too near the edge by the stopping distance to walk back, with nothing held that moves the player (no repositioning
already under way): the stopping distance is the most a tap slid on after walking, which isn't what a landing slides.
So it's watched, holding nothing, until it's still (Still for), and walked back from where it stopped if that's short
of the edge.
- **Fails at once:** going off its line while watched.
- **Fails:** stopping past the edge margin, or not stopping within `STOP_WATCH_MS`.
- **Unchanged:** with the way forward held, it refuses as before.
- **The case behind it** (14:53:07, the first map's last movement, jump 6): the jump before landed 4 px further on than
  recorded, 1 px from the late limit. It was refused for a 7 px stopping distance. With nothing held, it slid 2 px and
  stood.

**A jump pressed no sooner after its landing than recorded** (`_landed_due`, the takeoff event's `prepMs`). A jump
pressed by position (adapt, narrow), in a part begun on the map's Wait for turning true, isn't pressed sooner after
that than in the recording. It can be pressed later, up to the end of its safe stretch (its `interval`), where it's
pressed instead. It's never pressed sooner than its aim. Held back by the stretch's end, it's decided from the frame
that can't wait for the next (1.5 frames), not `TAKEOFF_HORIZON_MS` ahead: each frame's reading shows how far the player
has really got. Where it is between readings is reckoned at walking speed, and just after a landing it's slower, so it
is really further back, away from the edge.
- **The case behind it** (14:54:19, the second map's movement 1, jump 6): it was pressed about 50 ms after its landing
  against the recording's 70.6, and came down 15 px short. Only position jumps kept their recorded time from the
  landing (`TAKEOFF_REGION_PX` above); this one was narrow, pressed at its aim as soon as the player got there.
- **The traces:** the adaptive jumps pressed 20–60 ms after a landing went across at a median of 0.109–0.113 px/ms
  (74 jumps). Those pressed 60–120 ms after went at 0.127 (102 jumps).
- **Now:** pressed 72 ms after the landing, at −207, within its stretch (−210..−206.5).
- **Effect:** in the traces, 332 of 981 such presses came 5 ms or more sooner than recorded. All but this one landed
  where expected. It moves those later, within their safe stretches.

**A model's stretch checked against the recording** (`_distrusted` in the optional movement model; the row keeps the
model's verdict as `model`, and `arrival`). A jump the model would press by position is played as recorded (timed, the
baseline) when the model's stretch doesn't fit what the recording did:
- **Behind its approach:** its stretch lies behind where the recording came onto the line it jumps from, the way it
  ran. The movement as recorded can't get there.
- **A near miss** (`nearMiss`) is also played as recorded when:
  - its recording landed within `COLLIDE_PX` of its target's far end and the model carries it on past. A wall the lines
    don't show may have stopped it, so the miss says nothing about the model's error;
  - no press is safe with that error allowed for (`unsafe`);
  - there's less than half the executable stretch either side of its aim where it lands at all.
- **The case behind it** (18:05 and 18:06, the first quest's alternate route, g2 → g3, jump 12): fix A had moved it to a
  0.5 px stretch 25 px behind where the jump before lands. It was refused for that 2 runs of 3. Its recording landed
  against its target's far end and stood there.
- **Of the eight jumps fix A moved off timed playback:** this one and g3 → g4's jump 2 (unsafe once its error is
  allowed for) are timed again. The other six keep their new rows. Four were played since, 10 times, all got past (two weren't reached).
  The approach check changes no other jump of the 145.
- **Tests:** `TrustedNearMissTests`.

**Taps blocked, measured and kept from swinging** (`_stood_held`, `BLOCKED_MS` 75, `_free_taps`, `OVERSHOOT_SHARE`,
`SWING_STOP`). Line-up at 18:02:49 swung 14, 13, 14, 13 px either side of its start with four 200 ms taps of 27 px. The
map's taps had a 200 ms tap expected to move about 14 px on the flat, for two reasons:
- **A measurement bug:** a 31 px tap had been measured as 1 px. Line-up had gone on to the next start mid-tap, and the
  move was the change in its error to the new target. A tap's move is now where the player went.
- **Walls:** 150–300 ms taps pushing against the second quest's starting wall had moved only 11–20 px.

What's done about it:
- **Blocked taps:** a tap whose readings show the player still for `BLOCKED_MS` while its key is held (from
  `TAP_LAG_MS` after it went down) is kept marked `blocked`, and isn't taken as what a tap that long does. Over every
  tap in the traces (1,293), one moving freely stood at most 62 ms, up a steep slope; the wall's three stood 80–188 ms.
  A tap whose readings could tell is kept `free`.
- **Only checked taps bound a shorter one:** a longer tap's move bounds a shorter one's most ("no more than a longer one
  moved") only if it's marked `free`.
- **Taps kept from before:** in one context, a tap `TAP_LONGER_MS` or more longer than one that moved `TAP_SLACK_PX`
  further was stopped short, and isn't taken as moving freely. Different contexts aren't compared: up a steep slope
  taps move a fraction of what they do on the flat.
- **Halving at worst:** a tap may, at the most it could move, leave the player at most `OVERSHOOT_SHARE` (half) as far
  off as now, the other side, or within the tolerance. Near the game's smallest step, where even the shortest tap that
  moves it could do more, that tap is still allowed if it can't leave the player further off than now. Start within
  isn't changed.
- **Swinging:** a tap that went past the target without halving the error caps the next at what covers what's left at
  its own rate. Two such in a row (`SWING_STOP`) end the line-up rather than repeat it.
- **Not done:** a floor on how far a tap is expected to go. It refused good first taps, since an untried length is
  expected to do what the nearest tried one did.
- **Now:** from where it swung, three taps (150, 40, 40 ms) put it within 2 px.
- **Unchanged:** at 18:03:29, 3 px off a 2 px Start within with 40 ms taps that move 2 or 7 px, it still refuses.
- **Tests:** `BlockedTapTests`; `ExpectedTapTests` shows either newer guard alone stopping the 03:04 swing.

**A press kept on ground graded as where it was recorded** (`Ground.graded`, `GRADE_MIN_PX`, the row's `terrain`). The
model's walking speed and launch come from ground about level, and it doesn't know what a slope does to a running
jump's speed. So a model-placed stretch (adapt, narrow, unsafe, and a position jump's window) keeps to the stretch of
its line graded as where the recording pressed: flat, downhill or uphill, the way it runs, by `CREST_GRADE`.
- **Short segments:** a segment under `GRADE_MIN_PX` (3 px) is a step in how the line was drawn and goes with the
  ground round it.
- **Fallback:** when that leaves no executable stretch where the model had one, the jump is played as recorded.
- **The case behind it** (20:39:21, the second quest's movement 1, jump 3): it was recorded on the flat 0.8 px before a
  56-in-32 drop. For 6 px more landing room the model aimed it 9.5 px later, on the drop. Every run it came down about
  48 px further than recorded, leaving jump 4 0–3 px of its stretch.
- **The calibration below agrees:** downhill takeoffs flew 50 px further than the model, 14 of 14.
- **Effect:** it changes 6 of the three analyses' 145 jumps. This one is played as recorded; five keep their aims in
  narrower stretches.
- **Tests:** `TerrainTests`.

**A movement's own start region** (`platformer.start_region`, the link's `startRegion`, `START_REGION_PX` 16; the
executor's `_in_start_region`, a `start-region` trace event). Start within stays the map's. A movement may also begin
anywhere in its region, without lining up, when what follows takes the difference up:
- **A jump opening it:** an opening run-up of only its forward key into a jump pressed by position (adapt or position).
  The takeoff stays reachable, but the jump must leave as fast as recorded. So the recorded run-up has to be at least
  the model's measured run-up to walking speed (`runUp`), and a start further on may shorten it only to that. Used only
  with adaptive takeoff.
- **A walk:** a walk on one line with the end correction (finish `walk`, `correct`; only keys each way). A start
  further back ends short, which the correction takes up. One further on is allowed only as far as there's ground past
  its end to stop on (`Ground.safe_room`, less `EDGE_PX`). Used only when the end correction is. Only a walk whose
  whole length, its start to its end, is on ground of one grade: started elsewhere, a walk goes as recorded only where
  the ground under it is the same all along.
- **Both:** stay on the start's line and on ground graded as there.
- **The case behind it:** at 20:39:57 the crest walk's line-up refused 3 px off its start; 40 ms taps move the player 2
  or 7 px.
- **Why one grade:** the crest walk (404, −329) → (438, −342) climbs a steep rise. Begun 5 px back (21:14:49), its first
  press stopped the player at the rise's foot, without the momentum it had in the recording. Its second press, from
  standing on the rise, moved it 0 px, and it came 26 px short. It now has no region.
- **Unchanged:** the movement from (438, −342) has none. Its jump is pressed after a 3.9 px run-up from standing, under
  the measured 13 px.
- **Effect:** 8 of the three analyses' 55 movements have regions: the first map's 7 walks, each on one grade (one of
  them, g7 → g8, short and all up one slope), and the second map's g22 → g23 jump.
- **The start-region event:** said once per movement attempt (`regionSaid`).
- **How far on, from where it rests:** a walk's forward allowance comes from where its recording came to rest. That's
  the furthest it got along its way on the ground, up to `REST_MS` after its clip or the next key, since it slides on
  after its last key. The allowance is the ground past that rest, to a line's end or a downhill, less `EDGE_PX`.
  - It's kept as the region's `aheadPx` and `rest`.
  - It narrows Start within as well (`_start_tol`, at least `START_TOL_MIN_PX`), since a start inside Start within
    can be too far on too.
  - **The case behind it:** the first quest's walk to (−1337, −672) rests 2 px from its line's end, where the floor
    drops. Begun 2 px on (−1341), inside Start within, it walked off 7 times in 9. From its start or behind it, 26 of
    27 stayed on. Its forward allowance is now 0 (it must begin at −1343 or behind).
  - **A conservative cost:** g20 → g21 goes from 5 px on to 1. It rests 3 px from its line's end in the recording, but
    in play it walked 15–17 px against the recording's 19. The two runs begun 4–5 px on rested before the end, and
    would now tap back first.
  - **Tests:** `RestingStartTests`.
- **Tests:** `StartRegionTests`, on a level walk and the crest walk.

**Landing calibration** (`worker/calibration.py`, the worker's `map.calibration` op; measurement only, nothing moves a
takeoff). Each jump pressed by position whose flight the model predicts (adapt, narrow, unsafe) is an outcome:
- **Its state at the press:** where it was pressed (between readings), its speed along its way just before, the grade
  under it, and how long after the landing its part began on.
- **Where it came down:** through its platform's height, against the model from the same press at the median delay.
- **Left out, and counted:** flights stopped across in the air (`STOPPED_MS`), ones never crossing the height, and ones
  the model has landing where they left.
- **The correction:** reusable, from that state (speed against walking, pressed within `FRESH_MS` of a landing,
  downhill, uphill), fitted by least squares. It's scored leaving each run out, beside no correction and per-jump
  offsets.

On the user's runs:

| Map | Takeoffs (runs, jumps) | As modelled | Reusable | Per-jump |
|---|---|---|---|---|
| Second | 97 (14 runs, 48 jumps) | 9.4 px | 1.8 px | 2.8 px |
| First | 1,362 (62 runs, 372 jumps) | 2.5 px | 1.9 px | 1.9 px |

- **Second map:** downhill takeoffs came down +50 px past the model. Flat ones +1.8.
- **First map:** presses within 60 ms of a landing flew −8.5 px short (77). Later ones −1.8.
- **Tests:** `CalibrationTests`.

**Calibrated near-miss margins** (`calibration.summary`, `CAL_MIN` 20; `platformer.jumps(..., calibration)`, the row's
`calibrated`, `roomBare`, `edgeAtLaunchPx` and `keptBy`). The map's runs give the model's error per condition: the grade
pressed on, and whether within `CAL_FRESH_MS` (60) of a landing. Only conditions with at least `CAL_MIN` outcomes count,
and outcomes that came down at their platform's far end are left out. A near miss in a condition the runs measured
takes its landing margin from that condition's p90 (plus 2, at least `LAND_MARGIN`), not from its one recording's
difference from the model, which is that recording's own spread too.
- **Applies to:** near misses only. Other jumps keep their margins.
- **Where it lives:** `Worker._map_sequences` analyses a map again with its summary once it has one. That analysis is
  cached with the summary in its identity (`_calibration`: `<root>/plans/calibration-<map>.json`, kept until the runs
  change). The editor's `map.grid` passes the map's id, so it shows the same.
- **The better of two:** a calibrated near miss still unsafe with its margin, whose recorded press the model has
  missing its target, is kept pressed by position at its most robust place. That needs it to land on its target at
  every delay with no margin (`roomBare` > 0) and leave its line `EDGE_PX` short of its end at the latest fitted launch
  (`edgeAtLaunchPx`; `leaveMs`, the first rising reading, is an upper bound by up to a reading). Its movement stays
  marked unsafe, and `keptBy` says what it has to spare.
- **The case behind it:** the alternate route's g3 → g4 jump 2, played as recorded, came down 2–3 px short of its
  platform both times. That's where the model had it, and the first map's flat-ground p90 is 3.7 px over 1,344
  outcomes. Pressed at −1088 (18:01:43) it landed 8 px inside. It's now pressed by position at −1090.6, landing 3.5 px
  inside at the median delay and 2.3 at the worst, leaving its line 4.8 px short of its end.
- **Effect:** 3 of the 145 jumps change, all near misses. That's g3 → g4 jump 2 above, and the second map's movement 6:
  jump 3's stretch goes 2 → 6 px (aim 339 → 341, landing 11.5 px inside), and jump 6 goes narrow → unsafe at its same aim
  (79.4, landing 8 px inside). The main route is unchanged.
- **Tests:** `CalibratedNearMissTests`.

**Taps over every ground they cross, and stopping short of a downhill** (`TapResponse.most`, `_crossing`,
`Ground.safe_bound`, `_safe_stop`). When a hazard (a downhill or a line's end) is what limits a tap, its most is the
largest that the taps on every ground it may cross say. Each tap's move was measured once the player stood still, so
it includes the slide after the key is let go.
- **Downhills keep their margin:** a downhill keeps its `EDGE_PX` margin, which a line's end, possibly a wall, gives up
  for a target the player stood at.
- **Where a correction may stop:** a correction is done only within its tolerance and short of that margin before a
  downhill beyond its target. It's never kept from the target itself, a place the player stood. Past it, it taps back,
  and with no tap that can, it fails saying so.
- **The case behind it** (21:14:49): the crest walk's correction from 418, on its gentle rise, chose a 150 ms tap that
  its rise's taps put at 21 px at most. It ran onto the flat top and went 23 px, 2 px past the crest at 439. The player
  slid to 441, which, within Arrive within (8), was taken as there.
- **Now:** the flat's taps put a 150 ms tap at 25 px, and a tap of at most 100 ms is chosen. 441 isn't done; 436 and 438
  are.
- **Not for safe ground:** past a target on safe ground the crossing ground isn't counted, since it's only a correction
  to come back from. Counting it there left a line-up up a steep slope out of taps.
- **Tests:** `CrestCorrectionTests`.

**A jump with no landing room marked unsafe** (`THIN_LANDING_PX`, the row's `landingRoom` and `unsafeWhy`). A jump
played as recorded whose recording landed under `THIN_LANDING_PX` (3 px) from an end of the platform it landed on marks
its movement unsafe: taken only with no other way, and said so.
- **The case behind it:** the alternate route's jump 12 landed at its platform's very end. Played as recorded it went
  past it in both runs since.
- **Effect:** it's the only one of the 145.
- **Next:** what it needs is planning jump 11's landing for jump 12's start.
- **Tests:** `ThinLandingTests`.

**Expected and most.** A tap's expected move (`TapResponse.typical`) and the most it could move (`upper`) are apart:
- **The most it could move** limits every tap, as before.
- **The expected move** is the median of taps of about that length in its context, else of every tap of about that
  length (else the nearest length tried), capped by what its context's taps say it could.
- **Why:** estimating untried lengths in a context as half the most they could move picked a 150 ms tap for a 12 px
  correction on the flat, where 100 ms taps had moved the player 15–19 px. It went 22 px, and the correction swung four
  times (03:04).
- **Tests:** `ExpectedTapTests`, from the map's taps at that moment, with the flat ground's stepped response: one
  120 ms tap now, against seven swinging taps with the old estimate.

**A part that only presses keys at its start** (0 ms, such as Right pressed on a landing and held into a jump) is done
once it's sent (`_play_parts`), and its trigger is looked at in the same update, rather than when the guard's reply
says it completed, a frame later.
- **The case behind it** (02:35 and 02:38): both runs failed the last movement's jump 6. It's a running jump pressed by
  position, from the end of a small ledge, recorded 0.6 px past the latest press the model rates safe.
  - Jump 5 landed at −1831 (as recorded) and at −1828.
  - On the frame after the landing, still inside the window, the jump wasn't looked at: the guard's reply still said
    the 0 ms Right part was running.
  - A frame later the player was past the window and too near the edge to walk back. It walked off.
- **When its trigger comes in that update too,** only the next part is sent (trace event `segment-merged`). The guard
  starts an action with exactly its presses at 0 down, keeping keys already down, and the next part's presses at 0 are
  the keys this one leaves held. So the keys go in order with no let-go between, as they would have as two actions. A
  0 ms action completes as it starts, so one sent alone is over before the next arrives.
- **Walking from the press.** Deciding the jump in the very update that presses the key forward, its position is
  carried on at walking speed only from when that key went down (`_takeoff`'s `since`), not from the last reading.
  Otherwise the press would come before the run-up, which in MapleStory makes a slower, shorter jump.
- **Tests.** `ZeroLengthPartTests` in `worker/test_takeoff.py` reproduce jump 6 on the test platformer with
  `run_as_played`: the guard simulated as it is, its reply about an action reaching the tree a frame later. Decided in
  the update its part is sent, the jump is pressed inside its window. Waiting for the guard's word, it's past it.

The guard's records also show that the Left starting each replay went down through the frame's held keys, not the
timed sequence (its first event is `unchanged`), so when the run-up began isn't recorded to the millisecond. Neither
spread is something to time away without seeing the game's update phase. The correction at the end deals with where
they leave the player.

**A start at a line's end.** A line's end may be a wall: the user's quest starts at (−668, 266), the end of its floor
line. Line-up's room keeps `EDGE_PX` short of a line's end, but never short of the recorded start itself, since the
player stood there. Its worst case still stops at the line's end. Keeping 2 px short refused every tap from 3 px off.

**Lining up on a slope.** Line up with taps fixes the larger of the x and y errors. On a slope the y error comes from x,
and with no keys for y it gave up: the user's run stopped 3 px left of a start on a slope of 67 px in 55, 4 px off in
y. With the model's ground lines (`_along_line`), when the player stands on a line that passes within Start within of
the start at its x, it taps along x, since moving along the line carries it there in y too. The trace's `line-up` event
says `alongLine`. Start within isn't relaxed. A start on another line, or without the model, is still refused with "no
keys for y". `LineUpTests` in `worker/test_takeoff.py` use that slope.

This is measured the same way in both modes, so timed and adaptive runs compare directly. `worker/test_takeoff.py`: on
the test platformer, a jump recorded 4 px short of its stretch, replayed from 5 px behind, misses timed and makes it
adaptive, with the report saying so.

Not covered: ropes, keys changing in the air, and anything but a running or standing jump.
