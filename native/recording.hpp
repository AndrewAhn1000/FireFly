#pragma once
#include "session.hpp"
#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <thread>
namespace firefly {
class Catalog {
public:
  explicit Catalog(std::filesystem::path root);
  Json list() const;
  // Deletes a recording: its samples, input events and files
  void remove(const std::string &id) const;
  Json read(const std::string &id, int offset, int limit,
            bool tail = false, const std::string &stream = "samples") const;
  const std::filesystem::path &root() const { return root_; }

private:
  std::filesystem::path root_;
};
class Recorder {
public:
  ~Recorder() { stop("interrupted"); }
  void start(const std::filesystem::path &root, Json metadata);
  bool enqueue(Json item);
  void stop(const std::string &status = "complete");
  Json status() const;
  bool active() const { return active_; }
  bool failed() const { return failed_; }

private:
  void writer();
  mutable std::mutex mutex_;
  std::condition_variable changed_, ready_;
  std::deque<std::string> queue_;
  size_t queuedBytes_ = 0;
  bool stopping_ = false, initialized_ = false;
  std::atomic<bool> active_{false}, failed_{false};
  std::atomic<int> samples_{0}, inputs_{0}, invalid_{0};
  std::string error_, ending_, id_;
  std::filesystem::path root_;
  Json metadata_;
  double started_ = 0, ended_ = 0;
  std::thread thread_;
};
} // namespace firefly
