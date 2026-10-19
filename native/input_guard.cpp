#include "command_reader.hpp"
#include "session.hpp"
#include <cmath>
#include <cstdio>
#include <string>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <atomic>
#include <deque>
#include <future>
#include <mutex>
#include <set>
#include <thread>
#include <vector>
#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif
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
// What took over (a virtual key, or 1/2/4/5/6 for the mouse's buttons, 0x0A for its wheel), for the stop's reason
static std::atomic<int> takeoverInput = 0;
// The last few seconds of what the guard saw: the window in front changing, every key and click and who sent it,
// and the guard letting go. A stop nobody made is logged with it (play.log), since the reason alone said only what
// the guard noticed, not what caused it. Written by the hooks' thread and the main loop.
struct Seen {
  double at;
  enum Kind { Key, Click, Front, Note } kind;
  int vk = 0;          // Key, Click: the key or button
  bool down = false;   // Key, Click
  int from = 0;        // Key, Click: 0 the player, 1 the guard (the policy), 2 another program (injected)
  bool inside = false; // Click: over the game's window
  std::string text;    // Front: the window; Note: what
};
static std::mutex seenLock;
static std::deque<Seen> seen;
static void see(Seen event) {
  std::lock_guard lock(seenLock);
  seen.push_back(std::move(event));
  while (seen.size() > 400 || (seen.size() > 1 && seen.back().at - seen.front().at > 5000))
    seen.pop_front();
}
// Only the player's own keyboard and mouse count. Input another program sends (Windows marks it injected: an
// auto-potion or macro tool, keyboard or mouse software, an overlay) isn't the player taking over, nor the
// player still correcting, and it started corrections nobody made; the guard's own input is injected too.
static LRESULT CALLBACK keyboard(int code, WPARAM w, LPARAM l) {
  if (code == HC_ACTION) {
    auto key = reinterpret_cast<KBDLLHOOKSTRUCT *>(l);
    const bool down = w == WM_KEYDOWN || w == WM_SYSKEYDOWN;
    // A held key repeats: only its first press and its release
    static std::set<int> pressed;
    if (!down || !pressed.contains(static_cast<int>(key->vkCode))) {
      Seen event{firefly::monotonicMs(), Seen::Key, static_cast<int>(key->vkCode), down,
                 key->dwExtraInfo == marker ? 1 : key->flags & LLKHF_INJECTED ? 2 : 0};
      see(std::move(event));
    }
    if (down) pressed.insert(static_cast<int>(key->vkCode));
    else pressed.erase(static_cast<int>(key->vkCode));
    if (key->dwExtraInfo != marker && !(key->flags & LLKHF_INJECTED)) {
      lastHuman = firefly::monotonicMs();
      if (active && (w == WM_KEYDOWN || w == WM_SYSKEYDOWN) && !takeover) {
        takeoverInput = static_cast<int>(key->vkCode);
        takeover = true;
      }
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
    if (w != WM_MOUSEWHEEL && w != WM_MOUSEHWHEEL) {
      const bool left = w == WM_LBUTTONDOWN || w == WM_LBUTTONUP, right = w == WM_RBUTTONDOWN || w == WM_RBUTTONUP;
      Seen event{firefly::monotonicMs(), Seen::Click, left ? VK_LBUTTON : right ? VK_RBUTTON : w == WM_MBUTTONDOWN || w == WM_MBUTTONUP ? VK_MBUTTON : VK_XBUTTON1,
                 press, input->dwExtraInfo == marker ? 1 : input->flags & LLMHF_INJECTED ? 2 : 0, inside};
      see(std::move(event));
    }
    if (input->dwExtraInfo != marker && !(input->flags & LLMHF_INJECTED) && inside) {
      lastHuman = firefly::monotonicMs();
      if (active && press && !takeover) {
        takeoverInput = w == WM_LBUTTONDOWN ? VK_LBUTTON : w == WM_RBUTTONDOWN ? VK_RBUTTON : w == WM_MBUTTONDOWN ? VK_MBUTTON
                        : w == WM_XBUTTONDOWN ? VK_XBUTTON1 : 0x0A;
        takeover = true;
      }
    }
  }
  return CallNextHookEx(nullptr, code, w, l);
}
// A window, for a stop's reason: its title, or, untitled (overlays, popups, notifications), its kind and program
static std::string windowName(HWND window) {
  if (!window) return "no window: Windows was switching between windows";
  wchar_t wide[256] = {};
  char text[768] = {};
  std::string name;
  if (GetWindowTextW(window, wide, 256) > 0) {
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, text, sizeof(text), nullptr, nullptr); // JSON holds only UTF-8
    name = std::string("\"") + text + "\"";
  } else {
    name = "an untitled window";
    if (GetClassNameW(window, wide, 256) > 0) {
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, text, sizeof(text), nullptr, nullptr);
      name += std::string(" (") + text + ")";
    }
  }
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (HANDLE process = pid ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr) {
    wchar_t path[MAX_PATH] = {};
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameW(process, 0, path, &size)) {
      const wchar_t *file = wcsrchr(path, L'\\');
      WideCharToMultiByte(CP_UTF8, 0, file ? file + 1 : path, -1, text, sizeof(text), nullptr, nullptr);
      name += std::string(" of ") + text;
    }
    CloseHandle(process);
  }
  return name;
}
// The input that took over, by name: "key 0x41 (A)", "left mouse button"
static std::string inputName(int vk) {
  switch (vk) {
    case VK_LBUTTON: return "left mouse button";
    case VK_RBUTTON: return "right mouse button";
    case VK_MBUTTON: return "middle mouse button";
    case VK_XBUTTON1: return "a side mouse button";
    case 0x0A: return "mouse wheel";
  }
  char hex[16];
  snprintf(hex, sizeof(hex), "0x%02X", vk);
  char name[64] = {};
  const UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  LONG lparam = static_cast<LONG>(scan << 16);
  if ((vk >= 33 && vk <= 46) || vk == VK_DIVIDE || vk == VK_RCONTROL || vk == VK_RMENU) lparam |= 1 << 24; // extended
  std::string text = std::string("key ") + hex;
  if (GetKeyNameTextA(lparam, name, sizeof(name)) > 0) text += std::string(" (") + name + ")";
  return text;
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
// A run of presses played on the guard's own clock, to the millisecond: a hop done as the player did it, from where
// they stood still, every press and let-go at its time. Pressed once a frame (every 30-60 ms), a press was up to half
// a frame off its time, a few px at walking speed, and a jump with a few px of room missed. Its thread waits on a
// high-resolution timer to about a millisecond before each press and then spins to it.
struct Playback {
  struct Press {
    double at; // ms from the start
    int vk;
    bool down;
  };
  std::thread thread;
  HANDLE cancel = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::atomic<bool> running = false;
  std::atomic<double> lateMs = 0; // the latest any press went, for `apply`'s reply
  double started = 0;
  void stop() {
    if (thread.joinable()) {
      SetEvent(cancel);
      thread.join();
    }
    ResetEvent(cancel);
    running = false;
  }
  ~Playback() {
    stop();
    CloseHandle(cancel);
  }
};
static std::mutex keysLock; // the guard's held keys, between the main loop and a playback's thread
struct Guard {
  std::set<int> held;
  Playback playback;
  // Presses played from now, on the playback's thread (any playing before stops first)
  void play(std::vector<Playback::Press> presses) {
    playback.stop();
    playback.started = firefly::monotonicMs();
    playback.lateMs = 0;
    playback.running = true;
    playback.thread = std::thread([this, presses = std::move(presses)] {
      SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
      HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
      if (!timer) // before Windows 10 1803: a timer of the system's own tick, the spin making up the rest
        timer = CreateWaitableTimerW(nullptr, TRUE, nullptr);
      const double start = playback.started;
      const auto cancelled = [&] { return WaitForSingleObject(playback.cancel, 0) == WAIT_OBJECT_0; };
      for (const auto &p : presses) {
        const double due = start + p.at;
        const double wait = due - firefly::monotonicMs();
        if (wait > 1.5 && timer) {
          LARGE_INTEGER when;
          when.QuadPart = -static_cast<LONGLONG>((wait - 1.0) * 10000); // relative, in 100 ns
          SetWaitableTimer(timer, &when, 0, nullptr, nullptr, FALSE);
          HANDLE both[] = {playback.cancel, timer};
          if (WaitForMultipleObjects(2, both, FALSE, INFINITE) == WAIT_OBJECT_0)
            break;
        }
        bool stopped = false;
        while (firefly::monotonicMs() < due)
          if ((stopped = cancelled()))
            break;
          else
            YieldProcessor();
        std::lock_guard lock(keysLock);
        if (stopped || cancelled())
          break;
        if (p.down != held.contains(p.vk)) {
          emit(p.vk, p.down);
          if (p.down) held.insert(p.vk);
          else held.erase(p.vk);
        }
        const double late = firefly::monotonicMs() - due;
        if (late > playback.lateMs) playback.lateMs = late;
      }
      if (timer)
        CloseHandle(timer);
      playback.running = false;
    });
  }
  // Every key up, the guard still in charge: while the game is out of front for a moment
  void letGo() {
    playback.stop();
    std::lock_guard lock(keysLock);
    for (bool modifiers : {false, true})
      for (int vk : held)
        if ((vk >= VK_SHIFT && vk <= VK_MENU) == modifiers)
          emit(vk, false);
    held.clear();
  }
  void release() {
    playback.stop();
    std::lock_guard lock(keysLock);
    // The other keys first, then Shift, Ctrl and Alt (16-18), so letting go makes no combination either
    for (bool modifiers : {false, true})
      for (int vk : held)
        if ((vk >= VK_SHIFT && vk <= VK_MENU) == modifiers)
          emit(vk, false);
    held.clear();
    active = false;
  }
  ~Guard() { release(); }
};
// The guard's own keys in a row are one line ("the policy: 12 keys"), as it presses many
static Json traceLines(HWND target) {
  std::deque<Seen> copy;
  {
    std::lock_guard lock(seenLock);
    copy = seen;
  }
  const double now = firefly::monotonicMs();
  Json lines = Json::array();
  int policyKeys = 0;
  const auto flush = [&](double at) {
    if (!policyKeys) return;
    char head[32];
    snprintf(head, sizeof(head), "%6.0f ms  ", at - now);
    lines.push_back(std::string(head) + "the policy pressed or let go of keys (" + std::to_string(policyKeys) + ")");
    policyKeys = 0;
  };
  double lastPolicy = 0;
  for (const auto &e : copy) {
    if (now - e.at > 3000) continue;
    if ((e.kind == Seen::Key || e.kind == Seen::Click) && e.from == 1) {
      ++policyKeys;
      lastPolicy = e.at;
      continue;
    }
    flush(lastPolicy);
    char head[32];
    snprintf(head, sizeof(head), "%6.0f ms  ", e.at - now);
    static const char *from[] = {"you", "the policy", "another program (injected)"};
    std::string text;
    if (e.kind == Seen::Front) text = "in front: " + e.text;
    else if (e.kind == Seen::Note) text = e.text;
    else if (e.kind == Seen::Key) text = std::string(e.down ? "key down " : "key up ") + inputName(e.vk) + ", from " + from[e.from];
    else text = inputName(e.vk) + (e.down ? " down" : " up") + (e.inside ? " over the game" : " outside the game") + ", from " + from[e.from];
    lines.push_back(std::string(head) + text);
  }
  flush(lastPolicy);
  if (target && IsWindow(target))
    lines.push_back(std::string("the game's window now: ") + (IsIconic(target) ? "minimized" : IsWindowVisible(target) ? "shown" : "hidden") +
                    (GetForegroundWindow() == target ? ", in front" : ", not in front: " + windowName(GetForegroundWindow()) + " is"));
  if (lines.size() > 60) lines.erase(lines.begin(), lines.begin() + (lines.size() - 60));
  return lines;
}
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
    // Each window coming to the front, with its name taken now, while it's there
    HWINEVENTHOOK frontHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr,
        [](HWINEVENTHOOK, DWORD, HWND window, LONG, LONG, DWORD, DWORD) {
          see({firefly::monotonicMs(), Seen::Front, 0, false, 0, false, window == guardedWindow ? "the game" : windowName(window)});
        }, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    hooked.set_value(keyHook && mouseHook);
    while (GetMessage(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessage(&message);
    }
    if (frontHook)
      UnhookWinEvent(frontHook);
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
  constexpr double kFocusGraceMs = 250;
  double lostSince = 0; // when the game went out of front, while the guard is in charge; 0 while it's in front
  HWND lostTo = nullptr;
  while (true) {
    DWORD currentPid = 0;
    if (target)
      GetWindowThreadProcessId(target, &currentPid);
    const HWND front = GetForegroundWindow();
    const double quiet = firefly::monotonicMs() - last;
    // Windows reports no window, or a popup or overlay, in front for a moment now and then (switching windows, a
    // notification): every key is let go of at once, so nothing reaches the other window, but only a game out of
    // front for longer than kFocusGraceMs ends play
    if (front == target || !active) lostSince = 0;
    else if (!lostSince) {
      lostSince = firefly::monotonicMs();
      lostTo = front;
      guard.letGo();
      see({lostSince, Seen::Note, 0, false, 0, false, "the guard saw the game out of front and let go of every key"});
    }
    const bool lost = lostSince && firefly::monotonicMs() - lostSince > kFocusGraceMs;
    if (active && (takeover || lost || !IsWindow(target) || currentPid != pid || quiet > 300)) {
      guard.release();
      configured = false;
      // Which of them it was: they need different fixes (the window in front says what took focus; a watchdog
      // says FireFly stopped sending actions, so detection or the policy fell behind)
      std::string reason;
      if (takeover) reason = "Human takeover / emergency stop (" + inputName(takeoverInput) + ")";
      else if (!IsWindow(target) || currentPid != pid) reason = "The game's window closed";
      else if (lost) {
        reason = "Focus lost: " + windowName(front) + " came to the front";
        if (lostTo != front) reason += " (first " + windowName(lostTo) + ")";
      } else {
        char ms[32];
        snprintf(ms, sizeof(ms), "%.0f", quiet);
        reason = std::string("Action watchdog expired: no action for ") + ms + " ms (detection or the policy fell behind)";
      }
      reply({{"v", 1}, {"id", 0}, {"ok", true}, {"event", "guard-stopped"}, {"result", {{"reason", reason}, {"trace", traceLines(target)}}}});
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
        response["actionSchema"] = schema["identity"]; // what `apply` must carry
      } else if (op == "apply") {
        if (!configured)
          throw std::runtime_error("Input guardian is not configured");
        if (GetForegroundWindow() != target) {
          // Out of front for a moment (see kFocusGraceMs): nothing pressed, every key let go of, and play carries
          // on; before play has acted (active), as before, it's a refusal
          if (!active)
            throw std::runtime_error(
                "Focus the selected window before agent play (foreground=" +
                std::to_string(reinterpret_cast<uintptr_t>(GetForegroundWindow())) +
                ", target=" + std::to_string(reinterpret_cast<uintptr_t>(target)) + ")");
          guard.letGo();
          last = firefly::monotonicMs();
          response["held"] = 0;
          response["outOfFront"] = true;
          reply(response);
          continue;
        }
        if (!IsWindow(target) || currentPid != pid)
          throw std::runtime_error("Selected process changed");
        if (request.at("actionSchema") != schema["identity"] ||
            request.at("observationSchema") != observation)
          throw std::runtime_error("Action or observation schema mismatch");
        double timestamp = request.at("timestamp");
        double age = firefly::monotonicMs() - timestamp;
        // A frame's time is when Windows composed it, for the next refresh of the screen, which can be a few ms
        // ahead of now: that's a frame 0 ms old, not a stale one (a runtime from before it kept times from
        // running ahead stopped play here, "Stale observation (0 ms old…)")
        if (std::isfinite(age) && age < 0 && age >= -50)
          age = 0;
        if (!std::isfinite(age) || age < 0)
          throw std::runtime_error("Observation from the future (its time is " + std::to_string(static_cast<int>(-age)) +
                                   " ms ahead of the clock); refusing action");
        if (age > 250)
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
        // A Ctrl or Alt the player holds would make shortcuts of the policy's keys. Windows reports the
        // guard's own presses as held too, and a policy can press Ctrl and Alt itself, so only those it
        // isn't holding count.
        const auto holds = [&](int vk) { std::lock_guard lock(keysLock); return guard.held.contains(vk); };
        if ((GetAsyncKeyState(VK_CONTROL) & 0x8000 && !holds(VK_CONTROL)) ||
            (GetAsyncKeyState(VK_MENU) & 0x8000 && !holds(VK_MENU)) ||
            GetAsyncKeyState(VK_LWIN) & 0x8000 ||
            GetAsyncKeyState(VK_RWIN) & 0x8000)
          throw std::runtime_error(
              "Release system modifiers before agent play");
        auto states = request.at("buttons");
        if (!states.is_array() || states.size() != schema["buttons"].size())
          throw std::runtime_error("Invalid action shape");
        // Presses to play on the guard's own clock (see Playback), [[ms from now, button, down]], once the buttons
        // are as `buttons` says: while they play, `apply` keeps the guard going but leaves the keys to them. An empty
        // one stops what plays, and the buttons are as `buttons` says
        std::vector<Playback::Press> presses;
        if (request.contains("sequence")) {
          const auto &sequence = request.at("sequence");
          if (!sequence.is_array() || sequence.size() > 512)
            throw std::runtime_error("Invalid key sequence");
          double at = 0;
          for (const auto &e : sequence) {
            if (!e.is_array() || e.size() != 3 || !e[0].is_number() || !e[1].is_number_integer() || !e[2].is_boolean())
              throw std::runtime_error("Invalid key sequence");
            const int i = e[1].get<int>();
            const double t = e[0].get<double>();
            if (i < 0 || i >= static_cast<int>(schema["buttons"].size()) || !std::isfinite(t) || t < at || t > 10000)
              throw std::runtime_error("Invalid key sequence: buttons in its order, times in order from 0 to 10 s");
            at = t;
            presses.push_back({t, schema["buttons"][i]["vk"].get<int>(), e[2].get<bool>()});
          }
        } else if (guard.playback.running) {
          last = firefly::monotonicMs();
          active = true;
          response["playing"] = true;
          response["lateMs"] = guard.playback.lateMs.load();
          reply(response);
          continue;
        }
        guard.playback.stop(); // one that ended (or before a new one): its thread is done with the keys
        std::set<int> desired;
        for (size_t i = 0; i < states.size(); ++i) {
          if (!states[i].is_boolean())
            throw std::runtime_error("Predictions must be Boolean");
          if (states[i].get<bool>())
            desired.insert(schema["buttons"][i]["vk"].get<int>());
        }
        desired = firefly::withoutShortcuts(std::move(desired));
        std::unique_lock keys(keysLock);
        // Shift, Ctrl and Alt go down before the other keys and up after them, as a player presses
        // them, so a game sees a combination rather than the key alone
        const auto modifier = [](int vk) { return vk >= VK_SHIFT && vk <= VK_MENU; };
        for (bool modifiers : {false, true})
          for (auto it = guard.held.begin(); it != guard.held.end();)
            if (modifier(*it) == modifiers && !desired.contains(*it)) {
              if (!emit(*it, false))
                throw std::runtime_error("Input release rejected by Windows");
              it = guard.held.erase(it);
            } else
              ++it;
        for (bool modifiers : {true, false})
          for (int vk : desired)
            if (modifier(vk) == modifiers && !guard.held.contains(vk)) {
              guard.held.insert(vk);
              if (!emit(vk, true))
                throw std::runtime_error(
                    "Application does not accept synthetic input");
            }
        keys.unlock();
        last = firefly::monotonicMs();
        active = true;
        response["held"] = desired.size();
        if (!presses.empty()) {
          char note[96];
          snprintf(note, sizeof(note), "the guard began playing %zu presses over %.0f ms", presses.size(), presses.back().at);
          see({firefly::monotonicMs(), Seen::Note, 0, false, 0, false, note});
          guard.play(std::move(presses));
          response["playing"] = true;
        }
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
      } else if (op == "trace") {
        response["trace"] = traceLines(target);
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
