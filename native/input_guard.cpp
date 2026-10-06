#include "command_reader.hpp"
#include "session.hpp"
#include <cmath>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <atomic>
#include <future>
#include <set>
#include <thread>
using firefly::Json;
static constexpr ULONG_PTR marker = 0x46495245464C59;
// Shared between the hooks' thread and the main loop
static std::atomic<bool> takeover = false, active = false;
static std::atomic<HWND> guardedWindow = nullptr;
// When the player last pressed a key, or clicked or scrolled over the window, whether or not the guard
// is pressing anything: a correction ends once they've let go for a while (see "idle"). Moving the mouse
// isn't taking over, nor keeping a correction going: a policy only presses buttons, never moves the mouse,
// and a hand resting on the mouse moved it a few pixels and stopped play after its first action.
static std::atomic<double> lastHuman = 0;
static LRESULT CALLBACK keyboard(int code, WPARAM w, LPARAM l) {
  if (code == HC_ACTION) {
    auto key = reinterpret_cast<KBDLLHOOKSTRUCT *>(l);
    if (key->dwExtraInfo != marker) {
      lastHuman = firefly::monotonicMs();
      if (active && (w == WM_KEYDOWN || w == WM_SYSKEYDOWN))
        takeover = true;
    }
  }
  return CallNextHookEx(nullptr, code, w, l);
}
static LRESULT CALLBACK mouse(int code, WPARAM w, LPARAM l) {
  const HWND window = guardedWindow;
  const bool press = w == WM_LBUTTONDOWN || w == WM_RBUTTONDOWN || w == WM_MBUTTONDOWN ||
                     w == WM_XBUTTONDOWN || w == WM_MOUSEWHEEL || w == WM_MOUSEHWHEEL;
  const bool release = w == WM_LBUTTONUP || w == WM_RBUTTONUP || w == WM_MBUTTONUP || w == WM_XBUTTONUP;
  // Movement returns straight away: it's most of the mouse's events, and none of the guard's business
  if (code == HC_ACTION && window && (press || release)) {
    auto input = reinterpret_cast<MSLLHOOKSTRUCT *>(l);
    RECT bounds{};
    GetClientRect(window, &bounds);
    POINT point = input->pt;
    ScreenToClient(window, &point);
    bool inside = PtInRect(&bounds, point) != 0;
    if (input->dwExtraInfo != marker && inside) {
      lastHuman = firefly::monotonicMs();
      if (active && press)
        takeover = true;
    }
  }
  return CallNextHookEx(nullptr, code, w, l);
}
static void reply(const Json &value) {
  auto data = value.dump();
  uint32_t length = static_cast<uint32_t>(data.size() + 1);
  std::cout.write(reinterpret_cast<const char *>(&length), 4);
  std::cout.put(1);
  std::cout << data;
  std::cout.flush();
}
static bool emit(int vk, bool down) {
  INPUT input{};
  if (vk == 1 || vk == 2 || vk == 4) {
    input.type = INPUT_MOUSE;
    input.mi.dwExtraInfo = marker;
    input.mi.dwFlags =
        vk == 1   ? (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP)
        : vk == 2 ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
                  : (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP);
  } else {
    // By scan code, as a keyboard sends it (Windows works out the virtual key): games that bind keys by
    // scan code, or read them through DirectInput or raw input, see nothing of a key sent by virtual key
    // alone, whose scan code is 0. MapleStory walked on the arrows, which it reads by virtual key, and
    // never jumped on space, a key binding.
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = static_cast<WORD>(vk);
    input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
    input.ki.dwFlags = (down ? 0 : KEYEVENTF_KEYUP) | (input.ki.wScan ? KEYEVENTF_SCANCODE : 0);
    // The navigation keys and arrows, not the number pad's keys with the same scan codes; and the number
    // pad's /, not the main one
    if ((vk >= 33 && vk <= 40) || vk == 45 || vk == 46 || vk == 111)
      input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    input.ki.dwExtraInfo = marker;
  }
  return SendInput(1, &input, sizeof(input)) == 1;
}
struct Guard {
  std::set<int> held;
  void release() {
    for (int vk : held)
      emit(vk, false);
    held.clear();
    active = false;
  }
  ~Guard() { release(); }
};
int main() {
  _setmode(_fileno(stdout), _O_BINARY);
  Guard guard;
  CommandReader commands;
  // The hooks run on their own thread, blocked in GetMessage: Windows holds every mouse and keyboard
  // event on the system until they've seen it, and runs them only while their thread waits for messages.
  // On this thread they ran only between 2 ms waits for a command, which last a timer tick (about 15 ms),
  // so the cursor lagged for as long as FireFly ran once Play had been used.
  std::promise<bool> hooked;
  DWORD hookThread = 0;
  std::thread hooks([&] {
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL); // it sleeps until an event comes
    MSG message;
    PeekMessage(&message, nullptr, 0, 0, PM_NOREMOVE); // this thread's queue, for WM_QUIT at the end
    hookThread = GetCurrentThreadId();
    HHOOK keyHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, GetModuleHandle(nullptr), 0),
          mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouse, GetModuleHandle(nullptr), 0);
    hooked.set_value(keyHook && mouseHook);
    while (GetMessage(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessage(&message);
    }
    if (keyHook)
      UnhookWindowsHookEx(keyHook);
    if (mouseHook)
      UnhookWindowsHookEx(mouseHook);
  });
  const bool hooksReady = hooked.get_future().get();
  HWND target = nullptr;
  DWORD pid = 0;
  Json schema;
  std::string observation;
  double last = 0;
  bool configured = false;
  while (true) {
    DWORD currentPid = 0;
    if (target)
      GetWindowThreadProcessId(target, &currentPid);
    if (active &&
        (takeover || GetForegroundWindow() != target || !IsWindow(target) ||
         currentPid != pid || firefly::monotonicMs() - last > 300)) {
      guard.release();
      configured = false;
      reply({{"v", 1},
             {"id", 0},
             {"ok", true},
             {"event", "guard-stopped"},
             {"result",
              {{"reason", takeover ? "Human takeover / emergency stop"
                                   : "Focus lost, target closed, or action "
                                     "watchdog expired"}}}});
    }
    auto line = commands.next(2);
    if (!line) {
      if (commands.done())
        break;
      continue;
    }
    uint32_t id = 0;
    try {
      auto request = Json::parse(*line);
      id = request.at("id");
      if (request.value("v", 0) != 1)
        throw std::runtime_error("Protocol version mismatch");
      auto op = request.at("op").get<std::string>();
      auto response = Json{{"v", 1}, {"id", id}, {"ok", true}};
      if (op == "configure") {
        guard.release();
        if (!hooksReady)
          throw std::runtime_error("Takeover hooks unavailable");
        auto handle = std::stoull(request.at("windowId").get<std::string>());
        target = reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
        guardedWindow = target;
        if (!IsWindow(target))
          throw std::runtime_error("Target window closed");
        GetWindowThreadProcessId(target, &pid);
        schema = firefly::actionSchema(request.at("buttons"));
        observation = request.at("observationSchema");
        configured = true;
        takeover = false;
      } else if (op == "apply") {
        if (!configured)
          throw std::runtime_error("Input guardian is not configured");
        if (GetForegroundWindow() != target)
          throw std::runtime_error(
              "Focus the selected window before agent play (foreground=" +
              std::to_string(
                  reinterpret_cast<uintptr_t>(GetForegroundWindow())) +
              ", target=" +
              std::to_string(reinterpret_cast<uintptr_t>(target)) + ")");
        if (!IsWindow(target) || currentPid != pid)
          throw std::runtime_error("Selected process changed");
        if (request.at("actionSchema") != schema["identity"] ||
            request.at("observationSchema") != observation)
          throw std::runtime_error("Action or observation schema mismatch");
        double timestamp = request.at("timestamp");
        double age = firefly::monotonicMs() - timestamp;
        if (!std::isfinite(age) || age < 0 || age > 250)
          throw std::runtime_error("Stale observation (" + std::to_string(static_cast<int>(age)) +
                                   " ms old; the limit is 250); refusing action");
        response["ageMs"] = age;
        // Whether the game's window has the keyboard, not just the front: brought forward from another
        // process, Windows can put a window in front without giving it keyboard focus, and keys sent
        // then reach nothing of the game's (play looked fine and pressed nothing)
        GUITHREADINFO gui{sizeof(gui)};
        const DWORD thread = GetWindowThreadProcessId(target, nullptr);
        const bool has = thread && GetGUIThreadInfo(thread, &gui) && gui.hwndFocus &&
                         (gui.hwndFocus == target || IsChild(target, gui.hwndFocus));
        response["keyboardFocus"] = has;
        if (GetAsyncKeyState(VK_CONTROL) & 0x8000 ||
            GetAsyncKeyState(VK_MENU) & 0x8000 ||
            GetAsyncKeyState(VK_LWIN) & 0x8000 ||
            GetAsyncKeyState(VK_RWIN) & 0x8000)
          throw std::runtime_error(
              "Release system modifiers before agent play");
        auto states = request.at("buttons");
        if (!states.is_array() || states.size() != schema["buttons"].size())
          throw std::runtime_error("Invalid action shape");
        std::set<int> desired;
        for (size_t i = 0; i < states.size(); ++i) {
          if (!states[i].is_boolean())
            throw std::runtime_error("Predictions must be Boolean");
          if (states[i].get<bool>())
            desired.insert(schema["buttons"][i]["vk"].get<int>());
        }
        for (auto it = guard.held.begin(); it != guard.held.end();)
          if (!desired.contains(*it)) {
            if (!emit(*it, false))
              throw std::runtime_error("Input release rejected by Windows");
            it = guard.held.erase(it);
          } else
            ++it;
        for (int vk : desired)
          if (!guard.held.contains(vk)) {
            guard.held.insert(vk);
            if (!emit(vk, true))
              throw std::runtime_error(
                  "Application does not accept synthetic input");
          }
        last = firefly::monotonicMs();
        active = true;
        response["held"] = desired.size();
      } else if (op == "idle") {
        // How long since the player last used the keyboard or mouse, and whether they still hold
        // any of the configured buttons; changes nothing
        response["idleMs"] = firefly::monotonicMs() - lastHuman;
        bool held = false;
        if (schema.is_object())
          for (const auto &b : schema["buttons"])
            held = held || (GetAsyncKeyState(b["vk"].get<int>()) & 0x8000) != 0;
        response["held"] = held;
      } else if (op == "focus") {
        // Bring the target to the front, as Play is pressed, so the player needn't click it (a click in
        // the game is input to it). Windows lets a process started by the one in front do this; if it
        // still refuses, joining the front window's input queue for the call usually lets it through.
        const HWND window = reinterpret_cast<HWND>(
            static_cast<uintptr_t>(std::stoull(request.at("windowId").get<std::string>())));
        if (!IsWindow(window))
          throw std::runtime_error("Target window closed");
        if (IsIconic(window))
          ShowWindow(window, SW_RESTORE);
        if (!SetForegroundWindow(window) || GetForegroundWindow() != window) {
          const DWORD front = GetWindowThreadProcessId(GetForegroundWindow(), nullptr),
                      self = GetCurrentThreadId();
          const bool joined = front && front != self && AttachThreadInput(self, front, TRUE);
          BringWindowToTop(window);
          SetForegroundWindow(window);
          if (joined)
            AttachThreadInput(self, front, FALSE);
        }
        // In front isn't enough: its keyboard focus may still be elsewhere, and keys then go nowhere. Joined
        // to the game's input queue for the call, the guard can give the keyboard to its window.
        const DWORD game = GetWindowThreadProcessId(window, nullptr);
        GUITHREADINFO gui{sizeof(gui)};
        auto keyboard = [&] { return game && GetGUIThreadInfo(game, &gui) && gui.hwndFocus &&
                                     (gui.hwndFocus == window || IsChild(window, gui.hwndFocus)); };
        if (GetForegroundWindow() == window && !keyboard() && game && game != GetCurrentThreadId() &&
            AttachThreadInput(GetCurrentThreadId(), game, TRUE)) {
          SetActiveWindow(window);
          SetFocus(window);
          AttachThreadInput(GetCurrentThreadId(), game, FALSE);
        }
        response["focused"] = GetForegroundWindow() == window;
        response["keyboardFocus"] = keyboard();
      } else if (op == "focused") {
        // Whether the target is in front, to wait for the player to switch to it; changes nothing
        response["focused"] = configured && GetForegroundWindow() == target;
      } else if (op == "stop") {
        guard.release();
        configured = false;
      } else if (op == "shutdown") {
        guard.release();
        reply(response);
        break;
      } else if (op != "health")
        throw std::runtime_error("Unsupported guard operation");
      reply(response);
    } catch (const std::exception &e) {
      guard.release();
      configured = false;
      reply({{"v", 1},
             {"id", id},
             {"ok", false},
             {"error", {{"code", "INPUT_REJECTED"}, {"message", e.what()}}}});
    }
  }
  guard.release();
  PostThreadMessageW(hookThread, WM_QUIT, 0, 0);
  hooks.join();
  return 0;
}
