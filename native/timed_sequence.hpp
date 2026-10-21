#pragma once
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

namespace firefly {
// One bounded input action. The clock and input callbacks are supplied by the guard;
// tests exercise the real timer without sending keyboard events to another application.
class TimedSequence {
public:
  static constexpr double maxDurationMs = 30000;
  struct Press { double at; int vk; bool down; };
  // What sending a press did: an OS event, nothing (the key was already as the press says), or refused
  enum class Sent { emitted, unchanged, failed };
  // One press as it went, in ms from the action's start: when it was due, when the send began and returned
  struct Dispatch { size_t index; double at, sent, done; Sent outcome; };
  struct Status {
    uint64_t id = 0;
    // cause: who cancelled it (the guard's reason: focus, takeover, request...), empty unless cancelled
    std::string state = "idle", error, cause;
    double started = 0, finished = 0, duration = 0, lateMs = 0;
    size_t executed = 0;
  };
  // A finished (or running) action with every press it sent, kept for the last few actions
  struct Record { Status status; std::vector<Dispatch> dispatched; };
  static constexpr size_t keptRecords = 8;
  using Clock = std::function<double()>;
  // release: let go of every key held but `keep` (empty: all of them)
  TimedSequence(Clock clock, std::function<Sent(const Press &)> send,
                std::function<void(const std::set<int> &)> release)
      : clock_(std::move(clock)), send_(std::move(send)), release_(std::move(release)) {
    if (!cancel_) throw std::runtime_error("Cannot create action cancellation event");
  }
  TimedSequence(const TimedSequence &) = delete;
  ~TimedSequence() { stop(); CloseHandle(cancel_); }

  Status status() const { std::lock_guard lock(mutex_); return status_; }
  bool running() const { return status().state == "running"; }
  void reset() { stop("configure"); std::lock_guard lock(mutex_); status_ = {}; dispatched_.clear(); history_.clear(); }
  // Cancels a running action, saying why; an action already ended keeps its own end
  void stop(const std::string &cause = "request") {
    if (thread_.joinable()) {
      { std::lock_guard lock(mutex_); cause_ = cause; }
      SetEvent(cancel_);
      thread_.join();
    }
    ResetEvent(cancel_);
  }
  // The presses of action `id` as they went, if it's the current one or one of the last few
  std::optional<Record> record(uint64_t id) const {
    std::lock_guard lock(mutex_);
    if (id && status_.id == id) return Record{status_, dispatched_};
    for (const auto &r : history_) if (r.status.id == id) return r;
    return std::nullopt;
  }

  // IDs increase within a configured session. Repeating an ID (even after it
  // finished) or delivering an older action cannot replay inputs. `keep`: keys left held when it completes (a
  // movement going on after a pause, such as a key held through a landing it waits for); a cancelled or failed
  // action lets go of everything
  bool start(uint64_t id, std::vector<Press> presses, double duration, std::set<int> keep = {}) {
    if (!id || id > 9007199254740991ULL || !std::isfinite(duration) || duration < 0 || duration > maxDurationMs || presses.size() > 512)
      throw std::runtime_error("Invalid action ID or duration (maximum 30 s)");
    double previous = 0;
    for (const auto &p : presses) {
      if (!std::isfinite(p.at) || p.at < previous || p.at > duration)
        throw std::runtime_error("Action events must be ordered within its duration");
      previous = p.at;
    }
    if (id <= status().id) return false;
    stop();
    const double start = clock_();
    {
      std::lock_guard lock(mutex_);
      if (status_.id) {
        history_.push_front({status_, std::move(dispatched_)});
        if (history_.size() > keptRecords) history_.pop_back();
      }
      status_ = {id, "running", "", "", start, 0, duration, 0, 0};
      dispatched_.clear();
      dispatched_.reserve(presses.size());
      cause_.clear();
    }
    thread_ = std::thread([this, presses = std::move(presses), start, duration, keep = std::move(keep)] {
      SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
      HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
      if (!timer) timer = CreateWaitableTimerW(nullptr, TRUE, nullptr);
      const auto cancelled = [&] { return WaitForSingleObject(cancel_, 0) == WAIT_OBJECT_0; };
      const auto waitUntil = [&](double due) {
        const double wait = due - clock_();
        if (wait > 1.5 && timer) {
          LARGE_INTEGER when;
          when.QuadPart = -static_cast<LONGLONG>((wait - 1.0) * 10000);
          if (SetWaitableTimer(timer, &when, 0, nullptr, nullptr, FALSE)) {
            HANDLE both[] = {cancel_, timer};
            if (WaitForMultipleObjects(2, both, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) return false;
          }
        }
        while (clock_() < due) { if (cancelled()) return false; YieldProcessor(); }
        return !cancelled();
      };
      std::string state = "completed", error;
      try {
        for (size_t i = 0; i < presses.size(); ++i) {
          const auto &p = presses[i];
          if (!waitUntil(start + p.at)) { state = "cancelled"; break; }
          if (clock_() > start + duration + 250) {
            state = "failed"; error = "Action execution deadline expired"; break;
          }
          const double sent = clock_() - start;
          const Sent outcome = send_(p);
          const double done = clock_() - start;
          std::lock_guard lock(mutex_);
          dispatched_.push_back({i, p.at, sent, done, outcome});
          if (outcome == Sent::failed) { state = "failed"; error = "Input rejected or target no longer safe"; break; }
          ++status_.executed;
          status_.lateMs = std::max(status_.lateMs, sent - p.at);
        }
        if (state == "completed" && !waitUntil(start + duration)) state = "cancelled";
      } catch (const std::exception &e) { state = "failed"; error = e.what(); }
      // A completed or cancelled action never leaves a key held while waiting
      // for the next observation. Completion is published after the releases.
      release_(state == "completed" ? keep : std::set<int>{});
      if (timer) CloseHandle(timer);
      std::lock_guard lock(mutex_);
      status_.state = state; status_.error = error; status_.finished = clock_();
      if (state == "cancelled") status_.cause = cause_.empty() ? "request" : cause_;
    });
    return true;
  }

private:
  Clock clock_;
  std::function<Sent(const Press &)> send_;
  std::function<void(const std::set<int> &)> release_;
  HANDLE cancel_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::thread thread_;
  mutable std::mutex mutex_;
  Status status_;
  std::vector<Dispatch> dispatched_;
  std::deque<Record> history_; // newest first
  std::string cause_;
};
} // namespace firefly
