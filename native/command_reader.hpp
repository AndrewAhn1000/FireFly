#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <regex>
#include <string>
#include <thread>
#include <windows.h>
// The owner thread remains free to capture while stdin is idle.
//
// A request is one line of JSON. Lines can be large: template.set carries every template, and its mask,
// as base64 PNG, which passed the 64 KB this used to allow with a few templates, and a line too long
// ended the runtime. So does nothing now: a line past kMaxLine is answered with an error (its id is read
// from the start of it) and skipped, and when requests queue up faster than they're handled, reading
// waits for room rather than giving up.
class CommandReader {
public:
  static constexpr size_t kMaxLine = 64u << 20; // 64 MB
  static constexpr size_t kMaxQueued = 256;
  // What a line too long becomes: the main loop answers it as a request it refuses
  static constexpr const char *kTooLongOp = "request.too-long";

  CommandReader()
      : thread_([this] {
          read();
          finished_ = true;
        }) {}
  ~CommandReader() {
    stopping_ = true;
    room_.notify_all();
    while (!finished_) {
      CancelSynchronousIo(thread_.native_handle());
      Sleep(1);
    }
    if (thread_.joinable())
      thread_.join();
  }
  std::optional<std::string> next(int timeoutMs) {
    std::unique_lock lock(mutex_);
    changed_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                      [&] { return !lines_.empty() || done_; });
    if (lines_.empty())
      return {};
    auto line = std::move(lines_.front());
    lines_.pop_front();
    room_.notify_one();
    return line;
  }
  bool done() {
    std::lock_guard lock(mutex_);
    return done_ && lines_.empty();
  }

private:
  void push(std::string line) {
    std::unique_lock lock(mutex_);
    room_.wait(lock, [&] { return lines_.size() < kMaxQueued || stopping_; });
    lines_.push_back(std::move(line));
    changed_.notify_one();
  }
  // The request a line too long was, from its start, so it can be answered
  static std::string tooLong(const std::string &start) {
    static const std::regex id("\"id\"\\s*:\\s*(\\d+)");
    std::smatch m;
    const std::string head = start.substr(0, 256);
    const std::string number = std::regex_search(head, m, id) ? m[1].str() : "0";
    return std::string("{\"v\":1,\"id\":") + number + ",\"op\":\"" + kTooLongOp + "\"}";
  }
  void read() {
    std::string line;
    bool skipping = false; // past kMaxLine: the rest of this line is dropped
    char buffer[65536];
    DWORD count = 0;
    while (!stopping_ &&
           ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer),
                    &count, nullptr) &&
           count) {
      for (DWORD i = 0; i < count; ++i) {
        char c = buffer[i];
        if (c == '\n') {
          if (!skipping && !line.empty()) push(std::move(line));
          line.clear();
          skipping = false;
        } else if (!skipping) {
          if (line.size() >= kMaxLine) {
            push(tooLong(line));
            line.clear();
            skipping = true;
          } else {
            line += c;
          }
        }
      }
    }
    std::lock_guard lock(mutex_);
    done_ = true;
    changed_.notify_one();
  }
  std::mutex mutex_;
  std::condition_variable changed_, room_;
  std::deque<std::string> lines_;
  bool done_ = false;
  std::atomic<bool> stopping_{false}, finished_{false};
  std::thread thread_;
};
