#include "input_monitor.hpp"
namespace firefly {
thread_local InputMonitor *InputMonitor::instance_ = nullptr;
void InputMonitor::start(HWND target, const Json &schema) {
  stop();
  target_ = target;
  GetWindowThreadProcessId(target_, &targetPid_);
  mapping_.clear();
  held_ = Json::object();
  for (auto &button : schema["buttons"]) {
    mapping_[button["vk"]] = button["id"];
    held_[button["id"].get<std::string>()] = false;
  }
  events_.clear();
  overflow_ = false;
  initialized_ = false;
  error_.clear();
  focused_ = false;
  timeline_.reset(monotonicMs(), held_, false);
  running_ = true;
  thread_ = std::thread(&InputMonitor::loop, this);
  std::unique_lock lock(mutex_);
  ready_.wait(lock, [&] { return initialized_; });
  if (!error_.empty()) {
    auto error = error_;
    lock.unlock();
    stop();
    throw std::runtime_error(error);
  }
}
void InputMonitor::stop() {
  running_ = false;
  if (thread_.joinable()) {
    PostThreadMessageW(threadId_, WM_QUIT, 0, 0);
    thread_.join();
  }
}
void InputMonitor::append(Json event) {
  if (events_.size() >= 8192) {
    overflow_ = true;
    return;
  }
  events_.push_back(std::move(event));
}
void InputMonitor::focus() {
  DWORD pid = 0;
  GetWindowThreadProcessId(target_, &pid);
  bool focused = IsWindow(target_) && pid == targetPid_ &&
                 GetForegroundWindow() == target_;
  std::lock_guard lock(mutex_);
  if (focused == focused_)
    return;
  focused_ = focused;
  for (auto &[vk, id] : mapping_)
    held_[id] = focused && ((GetAsyncKeyState(vk) & 0x8000) != 0);
  double time = monotonicMs();
  timeline_.append(time, held_, focused_);
  append({{"kind", "focus"},
          {"timestamp", time},
          {"focused", focused_},
          {"buttons", held_}});
}
void InputMonitor::button(int vk, bool down, bool injected) {
  focus();
  std::lock_guard lock(mutex_);
  if (!focused_ || !mapping_.contains(vk))
    return;
  auto id = mapping_[vk];
  if (held_[id] == down)
    return;
  held_[id] = down;
  double time = monotonicMs();
  timeline_.append(time, held_, true);
  append({{"kind", "button"},
          {"timestamp", time},
          {"id", id},
          {"vk", vk},
          {"down", down},
          {"injected", injected}});
}
LRESULT CALLBACK InputMonitor::keyboard(int code, WPARAM w, LPARAM l) {
  if (code == HC_ACTION && instance_)
    try {
      auto key = reinterpret_cast<KBDLLHOOKSTRUCT *>(l);
      instance_->button(key->vkCode, w == WM_KEYDOWN || w == WM_SYSKEYDOWN,
                        (key->flags & LLKHF_INJECTED) != 0);
    } catch (...) {
      instance_->overflow_ = true;
    }
  return CallNextHookEx(nullptr, code, w, l);
}
LRESULT CALLBACK InputMonitor::mouse(int code, WPARAM w, LPARAM l) {
  if (code == HC_ACTION && instance_)
    try {
      auto data = reinterpret_cast<MSLLHOOKSTRUCT *>(l);
      auto *self = instance_;
      int vk = 0;
      bool down = false;
      if (w == WM_LBUTTONDOWN || w == WM_LBUTTONUP) {
        vk = VK_LBUTTON;
        down = w == WM_LBUTTONDOWN;
      }
      if (w == WM_RBUTTONDOWN || w == WM_RBUTTONUP) {
        vk = VK_RBUTTON;
        down = w == WM_RBUTTONDOWN;
      }
      if (w == WM_MBUTTONDOWN || w == WM_MBUTTONUP) {
        vk = VK_MBUTTON;
        down = w == WM_MBUTTONDOWN;
      }
      if (vk)
        self->button(vk, down, (data->flags & LLMHF_INJECTED) != 0);
      else if (w == WM_MOUSEMOVE || w == WM_MOUSEWHEEL) {
        self->focus();
        std::lock_guard lock(self->mutex_);
        if (self->focused_) {
          POINT point = data->pt;
          ScreenToClient(self->target_, &point);
          self->append(
              {{"kind", w == WM_MOUSEMOVE ? "mouse_move" : "mouse_wheel"},
               {"timestamp", monotonicMs()},
               {"x", point.x},
               {"y", point.y},
               {"wheel", w == WM_MOUSEWHEEL
                             ? static_cast<short>(HIWORD(data->mouseData))
                             : 0},
               {"injected", (data->flags & LLMHF_INJECTED) != 0}});
        }
      }
    } catch (...) {
      instance_->overflow_ = true;
    }
  return CallNextHookEx(nullptr, code, w, l);
}
// Windows holds every mouse and keyboard event until the low-level hooks have seen it, and runs a hook
// only while its thread is waiting for messages. So the thread blocks in GetMessage, which runs a hook
// the moment an event arrives, with a 5 ms timer for the focus poll. It used to handle what had arrived
// and then Sleep(5), which lasts a timer tick (about 15 ms): the cursor moved in 15-30 ms jumps while
// recording.
void InputMonitor::loop() {
  instance_ = this;
  // Waiting for input, it must run the moment an event comes, ahead of the capture and matching threads
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
  MSG message;
  PeekMessage(&message, nullptr, 0, 0, PM_NOREMOVE); // this thread's queue, for stop()'s WM_QUIT
  threadId_ = GetCurrentThreadId();
  HHOOK keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard,
                                         GetModuleHandle(nullptr), 0),
        mouseHook =
            SetWindowsHookExW(WH_MOUSE_LL, mouse, GetModuleHandle(nullptr), 0);
  {
    std::lock_guard lock(mutex_);
    if (!keyboardHook || !mouseHook)
      error_ = "Windows input hooks unavailable; recording was not started";
    initialized_ = true;
  }
  ready_.notify_one();
  const UINT_PTR timer = SetTimer(nullptr, 0, 5, nullptr);
  while (running_ && keyboardHook && mouseHook && GetMessage(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER) {
      focus();
      continue;
    }
    TranslateMessage(&message);
    DispatchMessage(&message);
  }
  KillTimer(nullptr, timer);
  if (keyboardHook)
    UnhookWindowsHookEx(keyboardHook);
  if (mouseHook)
    UnhookWindowsHookEx(mouseHook);
  instance_ = nullptr;
}
Json InputMonitor::stateAt(double timestamp) {
  std::lock_guard lock(mutex_);
  return timeline_.at(timestamp);
}
std::vector<Json> InputMonitor::drain() {
  std::lock_guard lock(mutex_);
  std::vector<Json> result(events_.begin(), events_.end());
  events_.clear();
  return result;
}
} // namespace firefly
