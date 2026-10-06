#pragma once
#include "session.hpp"
#include <atomic>
#include <condition_variable>
#include <thread>
#include <windows.h>
namespace firefly {
class InputMonitor {
public:
  ~InputMonitor() { stop(); }
  void start(HWND target, const Json &schema);
  void stop();
  Json stateAt(double timestamp);
  std::vector<Json> drain();
  bool overflow() const { return overflow_; }

private:
  void loop();
  void focus();
  void button(int vk, bool down, bool injected);
  void append(Json event);
  static LRESULT CALLBACK keyboard(int code, WPARAM w, LPARAM l);
  static LRESULT CALLBACK mouse(int code, WPARAM w, LPARAM l);
  static thread_local InputMonitor *instance_;
  HWND target_ = nullptr;
  DWORD targetPid_ = 0;
  std::thread thread_;
  std::atomic<DWORD> threadId_{0};
  std::atomic<bool> running_{false}, overflow_{false};
  std::mutex mutex_;
  std::condition_variable ready_;
  bool initialized_ = false;
  std::string error_;
  bool focused_ = false;
  std::map<int, std::string> mapping_;
  Json held_;
  ActionTimeline timeline_;
  std::deque<Json> events_;
};
} // namespace firefly
