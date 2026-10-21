import unittest

import replay_report

MAP = 'm1'
START = 10000.0  # the executor's start (monotonic ms)


def recorded(speed=0.1, ms=1000, every=40):
    """A recording walking right at `speed` px/ms from (0, 100) for `ms`, sampled every `every` ms."""
    return {'clip': {'recording': 'r1', 'from': 0, 'to': ms}, 'start': [0, 100], 'end': [speed * ms, 100], 'ms': ms,
            'trajectory': [[t, speed * t, 100, 'L1'] for t in range(0, ms + 1, every)]}


def trace(live_x, events=True, dispatch=True, reads=True, every=20, ms=1000, reuse_every=0, fail=None):
    """A run of one recorded link: frames every `every` ms from the executor's start, the player at live_x(elapsed);
    every `reuse_every`th frame repeats the reading before it, marked reused."""
    frames, last = [], None
    sequence = [[0, 0, True], [ms, 0, False]]
    for n, t in enumerate(range(0, ms + 1, every)):
        reused = bool(reuse_every) and n % reuse_every == 1 and last is not None
        x = last if reused else live_x(t)
        last = x
        f = {'t': START + t, 'maps': {MAP: {'link': 'L', **({'position': [x, 100], 'level': 'L1'} if events else
                                                            {'monitor': {'observedAt': START + t, 'actual': [x, 100]}})}},
             'execution': {'id': 1, 'state': 'running', 'startedAt': START}}
        if reads:
            f['reads'] = {'pos': [START + t + 3, reused]}
        if n == 0:
            f['action'] = {'id': 1, 'durationMs': ms}
            f['sequence'] = sequence
            if events:
                f['events'] = [{'kind': 'link', 'attempt': 1, 'map': MAP, 'link': 'L', 'recorded': recorded(ms=ms)}]
        frames.append(f)
    end = {'t': START + ms + every, 'maps': {MAP: {}}, 'execution': {'id': 1, 'state': 'completed', 'startedAt': START, 'finishedAt': START + ms}}
    if events:
        end['events'] = [{'kind': 'link-end', 'attempt': 1, 'map': MAP, 'link': 'L', 'worked': fail is None,
                          **({'cause': 'deviation', 'why': fail} if fail else {})}]
    if dispatch:
        end['dispatch'] = [{'id': 1, 'state': 'completed', 'startedAt': START, 'events': [[0, 0, 0.5, 0.6, 'emitted'], [1, ms, ms + 2.0, ms + 2.1, 'emitted']]}]
    frames.append(end)
    return {'buttons': ['right']}, frames


class ReplayReportTests(unittest.TestCase):
    def test_a_replay_on_its_recording_has_no_error(self):
        head, frames = trace(lambda t: 0.1 * t)
        a = replay_report.report(head, frames)['attempts'][0]
        self.assertEqual(a['startOffsetPx'], 0)
        self.assertIsNone(a['firstOverMs'])
        self.assertIsNone(a['continuedMs'])
        self.assertEqual(a['ended']['worked'], True)
        self.assertEqual(a['executor']['state'], 'completed')
        self.assertEqual(a['executor']['emitted'], 2)
        e = a['events'][1]
        self.assertEqual((e['sentMs'], e['lateMs'], e['outcome']), (1002.0, 2.0, 'emitted'))
        self.assertEqual(a['readings']['readLagMs']['median'], 3)

    def test_a_late_replay_shows_its_raw_error_and_lag_apart(self):
        # 40 ms behind the recording, walking at 0.1 px/ms: 4 px off at the same time, none once lined up
        head, frames = trace(lambda t: 0.1 * max(0, t - 40), ms=2000)
        a = replay_report.report(head, frames, threshold_px=3)['attempts'][0]
        e = a['events'][1]
        self.assertEqual((e['errorPx'], e['live']['interpolated'], e['recorded']['interpolated']), (4.0, False, False))
        self.assertAlmostEqual(replay_report._lag([(t, 0.1 * (t - 40), 100, 'L1') for t in range(300, 700, 20)],
                                                  [(t, 0.1 * t, 100, 'L1') for t in range(0, 2001, 40)], 500)[0], 40)
        series = [d for t, d, _ in a['series'] if 100 < t < 1900]
        self.assertTrue(all(abs(d - 4) < 0.01 for d in series), series)
        self.assertIsNotNone(a['firstOverMs'], 'a 4 px error over a 3 px threshold was not flagged')

    def test_a_player_standing_still_has_no_lag_to_tell(self):
        head, frames = trace(lambda t: 0.0)
        frames[0]['events'][0]['recorded'] = {**recorded(), 'trajectory': [[t, 0, 100, 'L1'] for t in range(0, 1001, 40)]}
        e = replay_report.report(head, frames)['attempts'][0]['events'][0]
        self.assertIsNone(e['lagMs'])
        self.assertEqual(e['alignedErrorPx'], 0)

    def test_reused_readings_are_not_part_of_the_live_path(self):
        # every other reading is the one before again, marked reused: taken as new, a walk would look like a stutter
        head, frames = trace(lambda t: 0.1 * t, reuse_every=2)
        a = replay_report.report(head, frames, threshold_px=1)['attempts'][0]
        self.assertGreater(a['readings']['reused'], 10)
        self.assertFalse(a['readings']['inferred'])
        self.assertEqual(a['readings']['medianGapMs'], 40)
        self.assertIsNone(a['firstOverMs'], 'a reused reading counted as a position')

    def test_the_divergence_it_ended_in_and_how_long_inputs_went_on(self):
        # on the path for 600 ms, then off by 30 px for good
        head, frames = trace(lambda t: 0.1 * t + (30 if t >= 600 else 0), fail='deviated')
        a = replay_report.report(head, frames)['attempts'][0]
        self.assertEqual(a['lastOnsetMs'], 600)
        self.assertEqual(a['firstOverMs'], 600)
        self.assertEqual(a['continuedMs'], 400)
        self.assertEqual(a['ended'], {'worked': False, 'cause': 'deviation', 'why': 'deviated'})

    def test_lining_up_is_kept_with_the_attempt_it_led_to_and_one_that_failed_is_listed(self):
        head, frames = trace(lambda t: 0.1 * t)
        lined = {'kind': 'line-up', 'map': MAP, 'target': [0, 100], 'from': [9, 100], 'to': [1, 100], 'offPx': 1.0, 'taps': [], 'worked': True}
        frames[0]['events'] = [lined, *frames[0]['events']]
        frames[-1]['events'].append({'kind': 'line-up', 'map': MAP, 'target': [100, 100], 'from': [130, 100], 'to': [120, 100], 'offPx': 20.0,
                                     'taps': [], 'worked': False, 'why': '20.0 px off after 8 taps'})
        out = replay_report.report(head, frames)['attempts']
        self.assertEqual(out[0]['lineUp'], lined)
        self.assertEqual((out[1]['kind'], out[1]['ended']), ('line-up', {'worked': False, 'cause': 'line-up', 'why': '20.0 px off after 8 taps'}))

    def test_a_movement_in_parts_is_compared_on_the_recordings_clock_from_each_wait(self):
        # recorded: walking right 0.1 px/ms for 1 s, waiting for a State at 500 ms; live: the State turned true 100 ms
        # late (at 10600), and the second part was played from then
        rec = {'clip': {'recording': 'r1', 'from': 0, 'to': 1000}, 'start': [0, 100], 'end': [100, 100], 'ms': 1000,
               'trajectory': [[t, 0.1 * t, 100, 'L1'] for t in range(0, 1001, 40)]}
        live_x = lambda t: 0.1 * min(500, t - START) if t < 10600 else 50 + 0.1 * (t - 10600)  # noqa: E731
        frames = []
        for t in range(10000, 11201, 20):
            f = {'t': t, 'maps': {MAP: {'link': 'L', 'position': [live_x(t), 100], 'level': 'L1'}}, 'reads': {'pos': [t + 3, False]},
                 'execution': {'id': 1 if t < 10615 else 2, 'state': 'running', 'startedAt': START if t < 10615 else 10615}}
            if t == 10000:
                f.update(action={'id': 1, 'durationMs': 400}, sequence=[[0, 0, True], [400, 0, False]],
                         events=[{'kind': 'link', 'attempt': 1, 'map': MAP, 'link': 'L', 'recorded': rec},
                                 {'kind': 'segment', 'attempt': 1, 'index': 0, 'actionId': 1, 'recorded': [0, 400], 'anchor': [None, 0.0]}])
            if t == 10620:
                f.update(action={'id': 2, 'durationMs': 500}, sequence=[[0, 0, True], [500, 0, False]],
                         events=[{'kind': 'sync', 'attempt': 1, 'index': 1, 'worked': True, 'waitedMs': 220.0, 'lateMs': 20.0},
                                 {'kind': 'segment', 'attempt': 1, 'index': 1, 'actionId': 2, 'recorded': [500, 1000], 'anchor': [10600, 500]}])
            frames.append(f)
        frames.append({'t': 11300, 'maps': {MAP: {}}, 'execution': {'id': 2, 'state': 'completed', 'startedAt': 10615, 'finishedAt': 11115},
                       'events': [{'kind': 'link-end', 'attempt': 1, 'map': MAP, 'link': 'L', 'worked': True}],
                       'dispatch': [{'id': 1, 'state': 'completed', 'startedAt': START, 'events': [[0, 0, 0.2, 0.3, 'emitted'], [1, 400, 400.1, 400.2, 'emitted']]},
                                    {'id': 2, 'state': 'completed', 'startedAt': 10615, 'events': [[0, 0, 0.1, 0.2, 'unchanged'], [1, 500, 500.1, 500.2, 'emitted']]}]})
        a = replay_report.report({'buttons': ['right']}, frames)['attempts'][0]
        self.assertEqual(a['parts'], 2)
        self.assertEqual([e['at'] for e in a['events']], [0, 400, 500, 1000], 'presses keep their recorded times across the parts')
        self.assertEqual([e['part'] for e in a['events']], [0, 0, 1, 1])
        self.assertAlmostEqual(a['events'][2]['sentMs'], 515.1, places=1)   # 15 ms after the State turned true, on the recording's clock
        self.assertEqual(a['events'][2]['outcome'], 'unchanged')            # the held key, kept through the wait
        self.assertEqual(a['syncs'], [{'index': 1, 'worked': True, 'waitedMs': 220.0, 'lateMs': 20.0, 'why': None, 'transitionAt': None, 'recordedAt': None}])
        after = [d for t, d, _ in a['series'] if 520 <= t <= 1000 and d is not None]
        self.assertTrue(after and max(after) < 0.5, 'readings after the wait were compared on the wrong clock')
        self.assertEqual(a['executor']['sent'], 4)

    def test_an_older_trace_uses_the_monitor_and_the_maps_links(self):
        head, frames = trace(lambda t: 0.1 * t, events=False, dispatch=False, reads=False)
        out = replay_report.report(head, frames, links=lambda mid, lid: {**recorded(), 'trajectory': [p[:3] + [None] for p in recorded()['trajectory']]})
        a = out['attempts'][0]
        self.assertEqual(len(out['notes']), 2)
        self.assertTrue(a['readings']['inferred'])
        self.assertIsNone(a['events'][0]['sentMs'])
        self.assertIsNone(a['firstOverMs'])
        unknown = replay_report.report(head, frames)['attempts']
        self.assertEqual([(x['recorded'], x['link']) for x in unknown], [(False, 'L')], 'a link with no recording known is listed, not compared')
        self.assertEqual(len(a['livePath']), 51)
        self.assertEqual(a['recordedPath'][0], [0.0, 0.0, 100.0])


class OutcomeTests(unittest.TestCase):
    """Direct arrivals, corrected arrivals, recoveries, retries and failures are counted apart, with the denominator."""

    def test_a_corrected_arrival_keeps_its_correction(self):
        head, frames = trace(lambda t: 0.1 * t)
        fin = {'kind': 'finish', 'attempt': 1, 'map': MAP, 'link': 'L', 'worked': True, 'arrival': 'corrected', 'corrections': 1,
               'taps': [{'axis': 'x', 'keys': ['left'], 'ms': 40, 'movedPx': -4.0}], 'offPx': 2.0, 'dropped': [[985.3, 'right']],
               'facing': {'recorded': 'right', 'kept': False, 'why': 'no tap that way is short enough'}}
        frames[-1]['events'] = [fin, {**frames[-1]['events'][0], 'arrival': 'corrected'}]
        rep = replay_report.report(head, frames)
        a = rep['attempts'][0]
        self.assertEqual((a['outcome'], a['ended']['arrival']), ('corrected', 'corrected'))
        self.assertEqual(a['ended']['finish']['taps'], fin['taps'])
        self.assertEqual(a['ended']['finish']['facing']['kept'], False)
        self.assertEqual(rep['summary'], {'attempts': 1, 'direct': 0, 'corrected': 1, 'recovered': 0, 'failed': 0, 'unended': 0, 'retries': 0})

    def test_outcomes_are_counted_apart(self):
        attempts = [{'link': 'a', 'map': 'm', 'ended': {'worked': True, 'arrival': 'direct'}},
                    {'link': 'b', 'map': 'm', 'ended': {'worked': True, 'arrival': 'corrected'}},
                    {'link': 'c', 'map': 'm', 'ended': {'worked': False, 'cause': 'arrival', 'recovered': True}},
                    {'link': 'd', 'map': 'm', 'ended': {'worked': False, 'cause': 'finish'}},
                    {'link': 'd', 'map': 'm', 'ended': {'worked': False, 'cause': 'deviation', 'recovered': False}},
                    {'link': 'd', 'map': 'm', 'ended': None},
                    {'kind': 'line-up', 'ended': {'worked': False}}]
        self.assertEqual([replay_report.outcome(a['ended']) for a in attempts[:6]], ['direct', 'corrected', 'recovered', 'failed', 'failed', None])
        self.assertEqual(replay_report.summary(attempts), {'attempts': 6, 'direct': 1, 'corrected': 1, 'recovered': 1, 'failed': 2, 'unended': 1, 'retries': 2})


if __name__ == '__main__':
    unittest.main()
