#include <string>
#include <windows.h>
// Integration-test driver only. Refuses every window except our controlled lab.
int main(int argc, char **argv) {
  if (argc < 2 || argc > 3)
    return 2;
  HWND target = reinterpret_cast<HWND>(std::stoull(argv[1]));
  wchar_t title[128]{};
  GetWindowTextW(target, title, 128);
  if (std::wstring(title) != L"FireFly Capture Lab")
    return 3;
  std::string mode = argc == 3 ? argv[2] : "demonstrate";
  if (mode == "check-released")
    return (GetAsyncKeyState(VK_LEFT) & 0x8000) ||
                   (GetAsyncKeyState(VK_RIGHT) & 0x8000)
               ? 7
               : 0;
  if (GetForegroundWindow() != target)
    return 4;
  INPUT key{};
  key.type = INPUT_KEYBOARD;
  key.ki.wVk = mode == "takeover" ? VK_F8 : VK_RIGHT;
  if (SendInput(1, &key, sizeof(key)) != 1)
    return 5;
  Sleep(mode == "takeover" ? 20 : 600);
  key.ki.dwFlags = KEYEVENTF_KEYUP;
  return SendInput(1, &key, sizeof(key)) == 1 ? 0 : 6;
}
