#include "session.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <cmath>
#include <iomanip>
#include <set>
#include <sstream>
namespace firefly {
double monotonicMs() {
  LARGE_INTEGER count, frequency;
  QueryPerformanceCounter(&count);
  QueryPerformanceFrequency(&frequency);
  return count.QuadPart * 1000.0 / frequency.QuadPart;
}
std::string sha256(const std::string &value) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  auto good = [](NTSTATUS status) {
    if (status < 0)
      throw std::runtime_error("SHA256 provider failed");
  };
  try {
    good(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                     nullptr, 0));
    DWORD size = 0, read = 0;
    good(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                           reinterpret_cast<PUCHAR>(&size), sizeof(size), &read,
                           0));
    std::vector<UCHAR> object(size), digest(32);
    good(
        BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0));
    good(BCryptHashData(
        hash, reinterpret_cast<PUCHAR>(const_cast<char *>(value.data())),
        static_cast<ULONG>(value.size()), 0));
    good(BCryptFinishHash(hash, digest.data(), 32, 0));
    BCryptDestroyHash(hash);
    hash = nullptr;
    BCryptCloseAlgorithmProvider(algorithm, 0);
    algorithm = nullptr;
    std::ostringstream out;
    for (auto byte : digest)
      out << std::hex << std::setfill('0') << std::setw(2)
          << static_cast<int>(byte);
    return out.str();
  } catch (...) {
    if (hash)
      BCryptDestroyHash(hash);
    if (algorithm)
      BCryptCloseAlgorithmProvider(algorithm, 0);
    throw;
  }
}
Json observationSchema(const Graph &graph, const Json &trackedDefinitions,
                       const Json &trackedFields, const Json &excluded) {
  auto definition = graph.definition();
  definition.erase("id");
  definition.erase("revision");
  for (auto &n : definition["nodes"])
    n.erase("position");
  std::sort(definition["nodes"].begin(), definition["nodes"].end(),
            [](const Json &a, const Json &b) { return a["id"] < b["id"]; });
  Json fields = graph.schema()["fields"];
  if (!trackedFields.empty()) {
    for (const auto &field : trackedFields) {
      for (const auto &existing : fields)
        if (existing["name"] == field["name"])
          throw std::runtime_error("A tracked observation is named like a graph output: " +
                                   field["name"].get<std::string>());
      fields.push_back(field);
    }
    definition["tracked"] = trackedDefinitions;
  }
  if (!excluded.empty()) {
    std::set<std::string> left;
    for (const auto &name : excluded) left.insert(name.get<std::string>());
    Json kept = Json::array();
    for (const auto &field : fields)
      if (!left.contains(field["name"].get<std::string>())) kept.push_back(field);
    fields = std::move(kept);
    definition["excluded"] = left; // sorted, so the order they were given in doesn't matter
  }
  Json schema = {{"version", 1},
                 {"fields", fields},
                 {"definition", definition}};
  schema["identity"] = sha256(schema.dump());
  return schema;
}
Json actionSchema(const Json &buttons) {
  if (!buttons.is_array() || buttons.empty() || buttons.size() > 24)
    throw std::runtime_error("Configure 1..24 action buttons");
  std::set<int> keys;
  std::set<std::string> names;
  for (auto &b : buttons) {
    auto name = b.at("id").get<std::string>();
    int key = b.at("vk").get<int>();
    if (!b["vk"].is_number_integer() || name.empty() || name.size() > 48 ||
        !names.insert(name).second || !keys.insert(key).second)
      throw std::runtime_error("Action IDs and physical inputs must be unique");
    // The keyboard's keys and the mouse buttons (src/Keyboard.tsx), explicitly excluding what makes
    // operating-system shortcuts (Ctrl, Alt, Shift, Windows, Menu), lock keys that stay on for the whole
    // system (Caps, Num, Scroll Lock), and Print Screen and Pause.
    const bool allowed =
        key == 1 || key == 2 || key == 4 ||           // mouse left, right, middle
        key == 8 || key == 9 || key == 13 ||          // Backspace, Tab, Enter
        key == 27 || key == 32 ||                     // Esc, Space
        (key >= 33 && key <= 40) ||                   // Page Up/Down, End, Home, arrows
        key == 45 || key == 46 ||                     // Insert, Delete
        (key >= 48 && key <= 57) ||                   // digits
        (key >= 65 && key <= 90) ||                   // A-Z
        (key >= 96 && key <= 107) ||                  // number pad digits, * and +
        (key >= 109 && key <= 111) ||                 // number pad -, . and /
        (key >= 112 && key <= 123) ||                 // F1-F12
        (key >= 186 && key <= 192) ||                 // ; = , - . / `
        (key >= 219 && key <= 222);                   // [ \ ] '
    if (!allowed)
      throw std::runtime_error("Supported buttons: the mouse's left, right and middle, and the keyboard's "
                               "keys but Ctrl, Alt, Shift, Windows, Menu, the lock keys, Print Screen and Pause");
  }
  Json result = {{"version", 1}, {"buttons", buttons}};
  result["identity"] = sha256(result.dump());
  return result;
}
void ActionTimeline::reset(double timestamp, const Json &buttons,
                           bool focused) {
  history_.clear();
  append(timestamp, buttons, focused);
}
void ActionTimeline::append(double timestamp, const Json &buttons,
                            bool focused) {
  if (!std::isfinite(timestamp) ||
      (!history_.empty() && timestamp < history_.back().timestamp))
    throw std::runtime_error("Input timestamps must be monotonic");
  history_.push_back({timestamp, buttons, focused});
  while (history_.size() > 8192)
    history_.pop_front();
}
Json ActionTimeline::at(double timestamp) const {
  if (history_.empty() || timestamp < history_.front().timestamp)
    return {{"valid", false},
            {"reason", "Frame predates retained input history"},
            {"buttons", Json::object()}};
  for (auto i = history_.rbegin(); i != history_.rend(); ++i)
    if (i->timestamp <= timestamp)
      return {{"valid", i->focused},
              {"focused", i->focused},
              {"stateTimestamp", i->timestamp},
              {"buttons", i->buttons},
              {"reason", i->focused ? "" : "The game wasn't the window in front, so its buttons couldn't be recorded"}};
  throw std::logic_error("No matching input state");
}
} // namespace firefly
