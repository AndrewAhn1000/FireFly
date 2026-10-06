#pragma once
#include <condition_variable>
#include <exception>
#include <functional>
#include <mutex>
#include <optional>
#include <thread>

// One executing job, one replaceable pending job, and one completed result.
// Submitting a newer frame never waits for inference or builds a frame backlog.
// A job submitted with `keep` runs: until it starts, only another kept job
// replaces it, and newer ordinary ones are dropped.
template <class Job, class Result> class LatestWorker {
public:
  explicit LatestWorker(std::function<Result(Job)> process)
      : process_(std::move(process)), thread_([this] { loop(); }) {}
  ~LatestWorker() {
    { std::lock_guard lock(mu_); stopping_ = true; pending_.reset(); }
    changed_.notify_one();
    thread_.join();
  }
  void submit(Job job, bool keep = false) {
    {
      std::lock_guard lock(mu_);
      if (pendingKept_ && !keep) return;
      pending_ = std::move(job); pendingKept_ = keep;
    }
    changed_.notify_one();
  }
  void clear() {
    std::lock_guard lock(mu_);
    pending_.reset(); pendingKept_ = false; completed_.reset(); error_ = nullptr;
  }
  std::optional<Result> take() {
    std::lock_guard lock(mu_);
    if (error_) { auto e = error_; error_ = nullptr; std::rethrow_exception(e); }
    auto out = std::move(completed_); completed_.reset(); return out;
  }
private:
  void loop() {
    for (;;) {
      std::optional<Job> job;
      {
        std::unique_lock lock(mu_);
        changed_.wait(lock, [&] { return stopping_ || pending_.has_value(); });
        if (stopping_) return;
        job = std::move(pending_); pending_.reset(); pendingKept_ = false;
      }
      try {
        auto result = process_(std::move(*job));
        std::lock_guard lock(mu_); completed_ = std::move(result);
      } catch (...) {
        std::lock_guard lock(mu_); error_ = std::current_exception();
      }
    }
  }
  std::function<Result(Job)> process_;
  std::mutex mu_;
  std::condition_variable changed_;
  bool stopping_ = false, pendingKept_ = false;
  std::optional<Job> pending_;
  std::optional<Result> completed_;
  std::exception_ptr error_;
  std::thread thread_;
};
