#include "timed_sequence.hpp"
#include <chrono>
#include <iostream>
#include <set>

using firefly::TimedSequence;
static double now() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
static void check(bool value, const char *message) {
  if (!value) throw std::runtime_error(message);
}
struct Harness {
  std::mutex mutex;
  std::set<int> held;
  struct Event { int key; bool down; double time; };
  std::vector<Event> events;
  std::atomic<bool> accept = true;
  TimedSequence runner{now, [this](const TimedSequence::Press &p) {
    std::lock_guard lock(mutex);
    if (!accept) return TimedSequence::Sent::failed;
    if (held.contains(p.vk) == p.down) return TimedSequence::Sent::unchanged;
    if (p.down) held.insert(p.vk); else held.erase(p.vk);
    events.push_back({p.vk, p.down, now()});
    return TimedSequence::Sent::emitted;
  }, [this](const std::set<int> &keep) {
    std::lock_guard lock(mutex);
    for (int key : held)
      if (!keep.contains(key)) events.push_back({key, false, now()});
    std::erase_if(held, [&](int key) { return !keep.contains(key); });
  }};
  void finish() {
    const double deadline = now() + 3500;
    while (runner.running() && now() < deadline) Sleep(1);
    check(!runner.running(), "action did not finish by its deadline");
    runner.stop();
  }
};
int main() {
  try {
    Harness h;
    h.runner.start(1, {{0, 39, true}, {10, 39, true}, {2000, 39, false}}, 2000);
    check(!h.runner.start(1, {{0, 39, true}}, 2000), "duplicate action restarted");
    h.finish();
    check(h.events.size() == 2, "continuous hold emitted extra transitions");
    check(h.events[1].time - h.events[0].time >= 1950, "hold ended early");
    check(h.held.empty(), "completed action left keys held");
    const auto first = h.runner.status();
    check(first.state == "completed" && first.executed == 3 && first.finished >= first.started + 2000, "invalid completion report");
    check(!h.runner.start(1, {{0, 39, true}}, 1), "completed ID replayed");
    {
      const auto r = h.runner.record(1);
      check(r && r->dispatched.size() == 3, "every press of an action is recorded");
      const auto &d = r->dispatched;
      check(d[0].index == 0 && d[1].index == 1 && d[2].index == 2 && d[2].at == 2000, "dispatch records keep their order and due times");
      check(d[0].outcome == TimedSequence::Sent::emitted && d[1].outcome == TimedSequence::Sent::unchanged &&
            d[2].outcome == TimedSequence::Sent::emitted, "dispatch records say whether an OS event was sent");
      for (const auto &e : d) check(e.sent >= e.at && e.done >= e.sent, "a press is sent at or after it is due");
      check(r->status.cause.empty(), "a completed action has no cancel cause");
    }

    h.events.clear();
    h.runner.start(2, {{0, 40, true}, {10, 32, true}, {26, 32, false}, {40, 40, false}}, 60);
    h.finish();
    check(h.events.size() == 4 && h.events[0].key == 40 && h.events[1].key == 32 &&
          h.events[1].down && !h.events[2].down && h.events[3].key == 40, "short pulse order lost");
    const double pulse = h.events[2].time - h.events[1].time;
    check(pulse >= 10, "short pulse collapsed into simultaneous events");
    std::cout << "16 ms pulse: " << pulse << " ms; maximum dispatch lateness: " << h.runner.status().lateMs << " ms\n";
    check(h.runner.status().finished >= h.runner.status().started + 60, "completed before action duration");

    h.runner.start(3, {{0, 39, true}, {1000, 39, false}}, 1000);
    Sleep(20);
    h.runner.stop("focus");
    check(h.runner.status().state == "cancelled" && h.held.empty(), "cancel did not release inputs");
    check(h.runner.status().cause == "focus", "a cancel keeps its cause");
    check(h.runner.record(3)->dispatched.size() == 1, "a cancelled action records only what it sent");
    check(h.runner.record(1) && h.runner.record(2), "earlier actions stay kept after newer ones start");
    check(!h.runner.start(2, {}, 0), "old action replayed");

    h.accept = false;
    h.runner.start(4, {{0, 39, true}}, 100);
    h.finish();
    check(h.runner.status().state == "failed" && h.held.empty(), "input failure reported as success");
    check(h.runner.record(4)->dispatched.size() == 1 && h.runner.record(4)->dispatched[0].outcome == TimedSequence::Sent::failed &&
          h.runner.status().executed == 0, "a refused press is recorded as failed and not counted as executed");
    bool refused = false;
    try { h.runner.start(5, {{50, 39, true}, {10, 39, false}}, 60); }
    catch (const std::exception &) { refused = true; }
    check(refused, "unordered sequence accepted");
    refused = false;
    try { h.runner.start(5, {}, 30001); } catch (const std::exception &) { refused = true; }
    check(refused, "unbounded duration accepted");
    h.accept = true;
    check(h.runner.start(5, {{0, 39, true}, {20000, 39, false}}, 20000), "long movement rejected");
    Sleep(20);
    h.runner.stop();
    check(h.runner.status().state == "cancelled" && h.held.empty(), "long movement did not cancel promptly");
    check(h.runner.record(5)->status.cause == "request", "a cancel without a cause is a request");

    // A completed action can leave keys held (a movement going on through a pause); a cancelled one never does
    h.events.clear();
    h.runner.start(6, {{0, 39, true}, {0, 32, true}, {20, 32, false}}, 30, {39});
    h.finish();
    check(h.held == std::set<int>{39}, "a kept key was let go when its action completed");
    check(h.events.size() == 3 && h.events[2].key == 32 && !h.events[2].down, "only the presses ran: nothing else let go");
    h.runner.start(7, {{0, 39, true}, {1000, 39, false}}, 1000, {39});
    Sleep(20);
    h.runner.stop("focus");
    check(h.held.empty(), "a cancelled action left a kept key held");
    h.runner.reset();
    check(!h.runner.record(1) && !h.runner.record(5), "a new session forgets old actions' records");
    check(h.runner.status().id == 0 && h.runner.status().state == "idle", "new session retained old action");
    std::cout << "Timed sequence tests passed (no system inputs emitted)\n";
  } catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
