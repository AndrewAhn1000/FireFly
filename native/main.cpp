#include "capture.hpp"
#include "detection.hpp"
#include "latest_worker.hpp"
#include "onnx_node.hpp"
#include <thread>
#include "command_reader.hpp"
#include "graph.hpp"
#include "input_monitor.hpp"
#include "ocr_windows.hpp"
#include "recording.hpp"
#include "session.hpp"
#include "rate_meter.hpp"
#include "tracked.hpp"
#include "tracking.hpp"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <dwmapi.h>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <map>
#include <memory>
#include <unordered_map>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <lua.hpp>
#include <tlhelp32.h>
using firefly::Json;

// ── Lua memory scripting ──────────────────────────────────────────────────────

static Json luaToJson(lua_State *L, int idx, int depth = 0) {
  if (depth > 10) return nullptr;
  idx = lua_absindex(L, idx);
  switch (lua_type(L, idx)) {
  case LUA_TBOOLEAN: return lua_toboolean(L, idx) != 0;
  case LUA_TNUMBER:
    if (lua_isinteger(L, idx)) return (int64_t)lua_tointeger(L, idx);
    return lua_tonumber(L, idx);
  case LUA_TSTRING: return std::string(lua_tostring(L, idx));
  case LUA_TTABLE: {
    lua_Integer len = (lua_Integer)lua_rawlen(L, idx);
    if (len > 0) {
      Json arr = Json::array();
      bool isSeq = true;
      for (lua_Integer i = 1; i <= len && isSeq; ++i) {
        lua_rawgeti(L, idx, i);
        if (lua_isnil(L, -1)) isSeq = false;
        else arr.push_back(luaToJson(L, -1, depth + 1));
        lua_pop(L, 1);
      }
      if (isSeq) return arr;
    }
    Json obj = Json::object();
    lua_pushnil(L);
    while (lua_next(L, idx) != 0) {
      std::string key;
      if (lua_type(L, -2) == LUA_TSTRING) key = lua_tostring(L, -2);
      else if (lua_isinteger(L, -2)) key = std::to_string(lua_tointeger(L, -2));
      else { lua_pop(L, 1); continue; }
      obj[key] = luaToJson(L, -1, depth + 1);
      lua_pop(L, 1);
    }
    return obj;
  }
  default: return nullptr;
  }
}

static Json scriptGeometry(HWND target, const CapturedFrame *frame = nullptr) {
  Json out = Json::object(); RECT cr{}, bounds{}, full{}; POINT origin{0, 0};
  if (!GetClientRect(target, &cr)) return out;
  out["windowW"] = cr.right; out["windowH"] = cr.bottom;
  bool haveBounds = SUCCEEDED(DwmGetWindowAttribute(target, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)));
  if (!haveBounds) haveBounds = GetWindowRect(target, &bounds);
  if (frame && GetWindowRect(target, &full) && full.right - full.left == static_cast<LONG>(frame->width) && full.bottom - full.top == static_cast<LONG>(frame->height)) {
    bounds = full; haveBounds = true;
  }
  const double bw = bounds.right - bounds.left, bh = bounds.bottom - bounds.top;
  if (haveBounds && bw > 0 && bh > 0 && ClientToScreen(target, &origin))
    out["clientArea"] = {{"x", (origin.x - bounds.left) / bw}, {"y", (origin.y - bounds.top) / bh}, {"w", cr.right / bw}, {"h", cr.bottom / bh}};
  return out;
}

// A memory or Lua State, which scripts read by name as states.Name
struct ScriptState {
  std::string id, name, kind, address, byteType, script; Json offsets;
  double width = 0, height = 0;
  bool off = false; // turned off in the app: a script reading it fails saying so, and it isn't read or run
};

// The States one evaluation can read. Each is read the first time a script asks for it and then
// kept, so every script in the evaluation sees the same value (one camera for every box).
struct StateScope {
  std::shared_ptr<const std::vector<ScriptState>> defs;
  HANDLE proc = nullptr; HWND hwnd = nullptr;
  Json regions = Json::array();
  const CapturedFrame *frame = nullptr;
  std::string regionId; // the Lua Region being evaluated: no State it reads may read its boxes
  std::string selfId;   // the State being evaluated, which can't read itself
  std::map<std::string, Json> values;
  std::map<std::string, std::string> errors;
  std::vector<std::string> reading; // the States being read, innermost last
};

struct MemScriptCtx {
  HANDLE proc; HWND hwnd = nullptr; int reads = 0;
  Json regions = Json::array(), geometry;
  double width = 0, height = 0;
  std::string regionId;
  std::vector<std::string> regionsRead;
  Json lookupBoxes, lookupValue;
  std::string lookupError;
  StateScope *scope = nullptr;
};
static constexpr int MEM_READ_LIMIT = 4096;
// What a script that reached it can do about it: a list walked from its start for every item reads the
// square of its length, and a structure read a field at a time a read per field
static constexpr const char *READ_LIMIT_MESSAGE = "read limit exceeded (max %d per call): walk a linked list once, "
  "keeping the node you're at rather than starting again from the first, and read a structure in one read_bytes "
  "(unpacked with string.unpack) rather than a field at a time";
static constexpr int MAX_READ_BYTES = 4096; // the most read_bytes reads at once

// Finish all C++ exception handling before the Lua callback can perform a longjmp.
static bool prepareRegionBoxes(MemScriptCtx *ctx, const char *key, bool namesOnly = false) {
  try {
    if (ctx->reads++ >= MEM_READ_LIMIT) throw std::runtime_error("Region lookup limit exceeded");
    const Json *region = nullptr;
    if (!namesOnly) for (const auto &r : ctx->regions) if (r.value("id", std::string()) == key) { region = &r; break; }
    if (!region) for (const auto &r : ctx->regions) if (r.value("label", std::string()) == key) {
      if (region) throw std::runtime_error("Region name is ambiguous; rename duplicate Regions or use get_region_boxes with an ID");
      region = &r;
    }
    if (!region) throw std::runtime_error(std::string("Region not found: ") + key);
    const auto id = region->value("id", std::string());
    if (std::find(ctx->regionsRead.begin(), ctx->regionsRead.end(), id) == ctx->regionsRead.end())
      ctx->regionsRead.push_back(id);
    if (!ctx->regionId.empty() && region->value("id", std::string()) == ctx->regionId)
      throw std::runtime_error("A Lua Region cannot read its own output");
    if (region->value("off", false))
      throw std::runtime_error("Region \"" + region->value("label", std::string()) + "\" is hidden, so its Lua script isn't running; show it to read it");
    if (!region->value("valid", false)) throw std::runtime_error("Region boxes are unavailable; start capture and check its source");
    if (region->value("dynamic", false) && firefly::monotonicMs() - region->value("timestamp", 0.0) > 250)
      throw std::runtime_error("Region boxes are older than 250 ms; wait for a fresh result");
    Json boxes = region->at("boxes");
    if (!boxes.is_array() || boxes.size() > 4096) throw std::runtime_error("Region must have at most 4096 boxes");
    const auto &area = ctx->geometry.at("clientArea");
    if (!std::isfinite(ctx->width) || !std::isfinite(ctx->height) || ctx->width < 0 || ctx->height < 0)
      throw std::runtime_error("Region reference dimensions must be finite and non-negative");
    const double w = ctx->width > 0 ? ctx->width : ctx->geometry.at("windowW").get<double>();
    const double h = ctx->height > 0 ? ctx->height : ctx->geometry.at("windowH").get<double>();
    const double ax = area.at("x"), ay = area.at("y"), aw = area.at("w"), ah = area.at("h");
    if (aw <= 0 || ah <= 0 || w <= 0 || h <= 0) throw std::runtime_error("Game dimensions are unavailable");
    for (auto &b : boxes) {
      const double x = b.at("x"), y = b.at("y"), bw = b.at("w"), bh = b.at("h");
      if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(bw) || !std::isfinite(bh)) throw std::runtime_error("Invalid Region box");
      b = {{"x", (x - ax) / aw * w}, {"y", (y - ay) / ah * h}, {"w", bw / aw * w}, {"h", bh / ah * h}};
    }
    ctx->lookupBoxes = std::move(boxes);
    return true;
  } catch (const std::exception &e) { ctx->lookupError = e.what(); return false; }
}

static int getRegionBoxesFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  const char *key = luaL_checkstring(L, 1);
  if (!prepareRegionBoxes(ctx, key)) return luaL_error(L, "%s", ctx->lookupError.c_str());
  lua_createtable(L, static_cast<int>(ctx->lookupBoxes.size()), 0);
  for (size_t i = 0; i < ctx->lookupBoxes.size(); ++i) {
    lua_createtable(L, 0, 4);
    for (const char *k : {"x", "y", "w", "h"}) { lua_pushnumber(L, ctx->lookupBoxes[i][k].get<double>()); lua_setfield(L, -2, k); }
    lua_rawseti(L, -2, i + 1);
  }
  return 1;
}

static int regionNameIndexFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  const char *key = luaL_checkstring(L, 2);
  if (!prepareRegionBoxes(ctx, key, true)) return luaL_error(L, "%s", ctx->lookupError.c_str());
  lua_createtable(L, static_cast<int>(ctx->lookupBoxes.size()), 0);
  for (size_t i = 0; i < ctx->lookupBoxes.size(); ++i) {
    lua_createtable(L, 0, 4);
    for (const char *k : {"x", "y", "w", "h"}) { lua_pushnumber(L, ctx->lookupBoxes[i][k].get<double>()); lua_setfield(L, -2, k); }
    lua_rawseti(L, -2, i + 1);
  }
  return 1;
}

static int regionNameWriteFn(lua_State *L) {
  return luaL_error(L, "regions is read-only; assign its boxes to a local variable instead");
}

static Json runMemoryScript(HANDLE proc, HWND hwnd, const std::string &code, const Json &regions = Json::array(),
                            double width = 0, double height = 0, const std::string &regionId = "", const CapturedFrame *frame = nullptr,
                            Json *metadata = nullptr, StateScope *scope = nullptr);
static Json readMemory(HANDLE proc, const std::string &address, const Json &offsets, const std::string &bt);

static void pushJson(lua_State *L, const Json &v, int depth = 0) {
  luaL_checkstack(L, 3, "State value is nested too deeply");
  if (depth > 10 || v.is_null()) lua_pushnil(L);
  else if (v.is_boolean()) lua_pushboolean(L, v.get<bool>());
  else if (v.is_number_integer()) lua_pushinteger(L, (lua_Integer)v.get<int64_t>());
  else if (v.is_number_unsigned()) lua_pushinteger(L, (lua_Integer)v.get<uint64_t>());
  else if (v.is_number()) lua_pushnumber(L, v.get<double>());
  else if (v.is_string()) { const auto &s = v.get_ref<const std::string &>(); lua_pushlstring(L, s.data(), s.size()); }
  else if (v.is_array()) {
    lua_createtable(L, static_cast<int>(v.size()), 0);
    lua_Integer i = 1;
    for (const auto &e : v) { pushJson(L, e, depth + 1); lua_rawseti(L, -2, i++); }
  } else {
    lua_createtable(L, 0, static_cast<int>(v.size()));
    for (const auto &item : v.items()) { pushJson(L, item.value(), depth + 1); lua_setfield(L, -2, item.key().c_str()); }
  }
}

// Finish all C++ exception handling before the Lua callback can perform a longjmp.
static bool prepareState(MemScriptCtx *ctx, const char *key) {
  try {
    StateScope *scope = ctx->scope;
    if (!scope || !scope->defs) throw std::runtime_error(std::string("State not found: ") + key);
    const ScriptState *def = nullptr;
    for (const auto &s : *scope->defs) if (s.name == key) {
      if (def) throw std::runtime_error(std::string("State name is ambiguous; rename one of the States called ") + key);
      def = &s;
    }
    if (!def) throw std::runtime_error(std::string("State not found: ") + key + " (scripts can read memory and Lua States)");
    if (def->off) throw std::runtime_error("State \"" + def->name + "\" is turned off; switch it on to read it");
    if (!scope->selfId.empty() && def->id == scope->selfId) throw std::runtime_error("A Lua State cannot read itself");
    if (auto e = scope->errors.find(def->name); e != scope->errors.end()) throw std::runtime_error(e->second);
    if (auto v = scope->values.find(def->name); v != scope->values.end()) { ctx->lookupValue = v->second; return true; }
    if (std::find(scope->reading.begin(), scope->reading.end(), def->name) != scope->reading.end()) {
      std::string chain;
      for (const auto &n : scope->reading) chain += n + " → ";
      throw std::runtime_error("States read each other in a loop: " + chain + def->name);
    }
    scope->reading.push_back(def->name);
    Json value, metadata;
    try {
      value = def->kind == "memory"
        ? readMemory(scope->proc, def->address, def->offsets, def->byteType)
        : runMemoryScript(scope->proc, scope->hwnd, def->script, scope->regions, def->width, def->height,
                          scope->regionId, scope->frame, &metadata, scope);
    } catch (const std::exception &e) {
      scope->reading.pop_back();
      const std::string message = "State \"" + def->name + "\": " + e.what();
      scope->errors[def->name] = message;
      throw std::runtime_error(message);
    }
    scope->reading.pop_back();
    // A Region a State read counts as read by this script too, so a Lua Region can't read itself through one
    for (const auto &read : metadata.value("regionsRead", Json::array()))
      if (const auto id = read.get<std::string>(); std::find(ctx->regionsRead.begin(), ctx->regionsRead.end(), id) == ctx->regionsRead.end())
        ctx->regionsRead.push_back(id);
    scope->values[def->name] = value;
    ctx->lookupValue = std::move(value);
    return true;
  } catch (const std::exception &e) { ctx->lookupError = e.what(); return false; }
}

static int stateNameIndexFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  const char *key = luaL_checkstring(L, 2);
  if (!prepareState(ctx, key)) return luaL_error(L, "%s", ctx->lookupError.c_str());
  pushJson(L, ctx->lookupValue);
  return 1;
}

static int stateNameWriteFn(lua_State *L) {
  return luaL_error(L, "states is read-only; assign its values to a local variable instead");
}

// The memory and Lua States the app sends, for scripts to read as states.Name
static std::vector<ScriptState> parseScriptStates(const Json &list) {
  if (!list.is_array() || list.size() > 512) throw std::runtime_error("Expected at most 512 States");
  std::vector<ScriptState> out;
  for (const auto &d : list) {
    ScriptState s;
    s.id = d.value("id", std::string());
    s.name = d.value("name", std::string());
    s.kind = d.value("kind", std::string());
    s.off = d.value("off", false);
    if (s.name.empty() || (s.kind != "memory" && s.kind != "script"))
      throw std::runtime_error("Each State needs a name and kind \"memory\" or \"script\"");
    if (s.kind == "memory") {
      s.address = d.value("address", std::string());
      s.offsets = d.value("offsets", Json::array());
      s.byteType = d.value("byteType", std::string("u32"));
      if (s.address.empty() || !s.offsets.is_array() || s.offsets.size() > 16)
        throw std::runtime_error(s.name + ": a memory State needs an address and at most 16 offsets");
    } else {
      s.script = d.value("script", std::string());
      s.width = d.value("scriptWidth", 0.0); s.height = d.value("scriptHeight", 0.0);
      if (s.script.empty() || s.script.size() > 20000)
        throw std::runtime_error(s.name + ": a Lua State needs a script of at most 20,000 characters");
    }
    out.push_back(std::move(s));
  }
  return out;
}

template<typename T>
static int readTyped(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  if (ctx->reads++ >= MEM_READ_LIMIT)
    return luaL_error(L, READ_LIMIT_MESSAGE, MEM_READ_LIMIT);
  uintptr_t addr = (uintptr_t)(lua_Unsigned)luaL_checkinteger(L, 1);
  T val{};
  SIZE_T n = 0;
  if (!ReadProcessMemory(ctx->proc, reinterpret_cast<LPCVOID>(addr), &val, sizeof(T), &n) || n != sizeof(T)) {
    char buf[32]; snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
    return luaL_error(L, "read failed at %s", buf);
  }
  if constexpr (std::is_floating_point_v<T>) lua_pushnumber(L, (lua_Number)val);
  else lua_pushinteger(L, (lua_Integer)val);
  return 1;
}

static int getModuleBaseFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  const char *modName = luaL_checkstring(L, 1);
  wchar_t wName[256] = {};
  MultiByteToWideChar(CP_UTF8, 0, modName, -1, wName, 256);
  DWORD pid = GetProcessId(ctx->proc);
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (snap == INVALID_HANDLE_VALUE)
    return luaL_error(L, "failed to snapshot modules for pid %lu", (unsigned long)pid);
  MODULEENTRY32W me{};
  me.dwSize = sizeof(me);
  bool found = false;
  if (Module32FirstW(snap, &me)) {
    do {
      if (_wcsicmp(me.szModule, wName) == 0) { found = true; break; }
    } while (Module32NextW(snap, &me));
  }
  CloseHandle(snap);
  if (!found) return luaL_error(L, "module not found: %s", modName);
  lua_pushinteger(L, (lua_Integer)(uintptr_t)me.modBaseAddr);
  return 1;
}

static int getWindowSizeFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  if (!ctx->hwnd) return luaL_error(L, "no capture target");
  RECT r{};
  if (!GetClientRect(ctx->hwnd, &r)) return luaL_error(L, "GetClientRect failed");
  lua_newtable(L);
  lua_pushinteger(L, r.right);  lua_setfield(L, -2, "w");
  lua_pushinteger(L, r.bottom); lua_setfield(L, -2, "h");
  return 1;
}

static int listModulesFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  DWORD pid = GetProcessId(ctx->proc);
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (snap == INVALID_HANDLE_VALUE)
    return luaL_error(L, "failed to snapshot modules for pid %lu", (unsigned long)pid);
  lua_newtable(L);
  int i = 1;
  MODULEENTRY32W me{};
  me.dwSize = sizeof(me);
  if (Module32FirstW(snap, &me)) {
    do {
      char name[256] = {};
      WideCharToMultiByte(CP_UTF8, 0, me.szModule, -1, name, 256, nullptr, nullptr);
      lua_pushstring(L, name);
      lua_rawseti(L, -2, i++);
    } while (Module32NextW(snap, &me));
  }
  CloseHandle(snap);
  return 1;
}

// A block of memory as a Lua string, in one read however many values it holds: a structure's fields are then
// taken out with string.unpack, e.g. local x1, y1, x2, y2 = string.unpack("<i4i4i4i4", read_bytes(rect, 16))
static int readBytesFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  if (ctx->reads++ >= MEM_READ_LIMIT) return luaL_error(L, READ_LIMIT_MESSAGE, MEM_READ_LIMIT);
  uintptr_t addr = (uintptr_t)(lua_Unsigned)luaL_checkinteger(L, 1);
  const lua_Integer count = luaL_checkinteger(L, 2);
  if (count < 1 || count > MAX_READ_BYTES) return luaL_error(L, "read_bytes reads 1..%d bytes", MAX_READ_BYTES);
  std::string buf((size_t)count, '\0');
  SIZE_T n = 0;
  if (!ReadProcessMemory(ctx->proc, reinterpret_cast<LPCVOID>(addr), buf.data(), buf.size(), &n) || n != buf.size()) {
    char at[32]; snprintf(at, sizeof(at), "0x%llx", (unsigned long long)addr);
    return luaL_error(L, "read failed at %s", at);
  }
  lua_pushlstring(L, buf.data(), buf.size());
  return 1;
}

static int readStrFn(lua_State *L) {
  auto *ctx = static_cast<MemScriptCtx *>(lua_touserdata(L, lua_upvalueindex(1)));
  if (ctx->reads++ >= MEM_READ_LIMIT) return luaL_error(L, READ_LIMIT_MESSAGE, MEM_READ_LIMIT);
  uintptr_t addr = (uintptr_t)(lua_Unsigned)luaL_checkinteger(L, 1);
  int maxLen = (int)luaL_optinteger(L, 2, 255);
  if (maxLen < 1 || maxLen > 4096) maxLen = 255;
  std::vector<char> buf(maxLen + 1, 0);
  SIZE_T n = 0;
  ReadProcessMemory(ctx->proc, reinterpret_cast<LPCVOID>(addr), buf.data(), maxLen, &n);
  lua_pushlstring(L, buf.data(), strnlen(buf.data(), (size_t)maxLen));
  return 1;
}

// ── Persistent script VM cache ────────────────────────────────────────────────

static void hookLimit(lua_State *s, lua_Debug *) { luaL_error(s, "instruction limit exceeded"); }

struct ScriptEntry {
  lua_State              *L       = nullptr;
  std::unique_ptr<MemScriptCtx> ctx;
  int                     funcRef = LUA_NOREF;
  bool                    running = false; // a script reading a State runs that State's script inside its own
  ~ScriptEntry() { if (L) { lua_close(L); L = nullptr; } }
};

static std::unordered_map<std::string, std::unique_ptr<ScriptEntry>> g_scriptCache;
static constexpr size_t SCRIPT_CACHE_MAX = 64;

static ScriptEntry *getOrCreateScript(const std::string &code) {
  auto it = g_scriptCache.find(code);
  if (it != g_scriptCache.end()) return it->second.get();

  if (code.empty() || code.size() > 16384)
    throw std::runtime_error("Script must be 1..16384 bytes");
  if (g_scriptCache.size() >= SCRIPT_CACHE_MAX) // never one that's running: a State's script runs inside its reader's
    for (auto old = g_scriptCache.begin(); old != g_scriptCache.end(); ++old)
      if (!old->second->running) { g_scriptCache.erase(old); break; }

  auto entry = std::make_unique<ScriptEntry>();
  entry->ctx  = std::make_unique<MemScriptCtx>();
  entry->L    = luaL_newstate();
  if (!entry->L) throw std::runtime_error("Lua state allocation failed");
  lua_State *L = entry->L;

  luaL_requiref(L, LUA_MATHLIBNAME, luaopen_math,   1); lua_pop(L, 1);
  luaL_requiref(L, LUA_TABLIBNAME,  luaopen_table,  1); lua_pop(L, 1);
  luaL_requiref(L, LUA_STRLIBNAME,  luaopen_string, 1); lua_pop(L, 1);

  struct Reg { const char *name; lua_CFunction fn; };
  static const Reg regs[] = {
    {"read_u8",  readTyped<uint8_t>},  {"read_i8",  readTyped<int8_t>},
    {"read_u16", readTyped<uint16_t>}, {"read_i16", readTyped<int16_t>},
    {"read_u32", readTyped<uint32_t>}, {"read_i32", readTyped<int32_t>},
    {"read_u64", readTyped<uint64_t>}, {"read_i64", readTyped<int64_t>},
    {"read_f32", readTyped<float>},    {"read_f64", readTyped<double>},
    {"read_ptr", readTyped<uintptr_t>},{"read_str", readStrFn}, {"read_bytes", readBytesFn},
    {"get_module_base", getModuleBaseFn},
    {"list_modules",   listModulesFn},
    {"get_window_size", getWindowSizeFn},
    {"get_region_boxes", getRegionBoxesFn},
  };
  for (auto &reg : regs) {
    lua_pushlightuserdata(L, entry->ctx.get());
    lua_pushcclosure(L, reg.fn, 1);
    lua_setglobal(L, reg.name);
  }

  if (luaL_loadbufferx(L, code.data(), code.size(), "script", "t") != LUA_OK) {
    std::string err(lua_tostring(L, -1));
    throw std::runtime_error("syntax: " + err);
  }
  entry->funcRef = luaL_ref(L, LUA_REGISTRYINDEX);

  auto *ptr = entry.get();
  g_scriptCache.emplace(code, std::move(entry));
  return ptr;
}

static Json runMemoryScript(HANDLE proc, HWND hwnd, const std::string &code, const Json &regions,
                            double width, double height, const std::string &regionId, const CapturedFrame *frame,
                            Json *metadata, StateScope *scope) {
  ScriptEntry *entry = getOrCreateScript(code);
  // The same script already running further out reads itself: identical text reads the same States
  if (entry->running) throw std::runtime_error("States read each other in a loop: a State's script reads a State with the same script");
  struct Running { ScriptEntry *e; ~Running() { e->running = false; } } running{entry};
  entry->running = true;
  entry->ctx->scope  = scope;
  entry->ctx->proc   = proc;
  entry->ctx->hwnd   = hwnd;
  entry->ctx->reads  = 0;
  entry->ctx->regions = regions;
  entry->ctx->geometry = scriptGeometry(hwnd, frame);
  entry->ctx->width = width; entry->ctx->height = height; entry->ctx->regionId = regionId;
  entry->ctx->regionsRead.clear();
  lua_State *L       = entry->L;

  // Refresh the namespace on every run, including cached VMs. Resolve lazily so
  // an unused unavailable Region cannot fail an otherwise independent script.
  lua_newtable(L);
  lua_newtable(L);
  lua_pushlightuserdata(L, entry->ctx.get());
  lua_pushcclosure(L, regionNameIndexFn, 1); lua_setfield(L, -2, "__index");
  lua_pushcfunction(L, regionNameWriteFn); lua_setfield(L, -2, "__newindex");
  lua_pushboolean(L, 0); lua_setfield(L, -2, "__metatable");
  lua_setmetatable(L, -2);
  lua_setglobal(L, "regions");

  // The same for States, read only when a script asks for one
  lua_newtable(L);
  lua_newtable(L);
  lua_pushlightuserdata(L, entry->ctx.get());
  lua_pushcclosure(L, stateNameIndexFn, 1); lua_setfield(L, -2, "__index");
  lua_pushcfunction(L, stateNameWriteFn); lua_setfield(L, -2, "__newindex");
  lua_pushboolean(L, 0); lua_setfield(L, -2, "__metatable");
  lua_setmetatable(L, -2);
  lua_setglobal(L, "states");

  // Reset instruction counter each call to enforce the per-call limit
  lua_sethook(L, hookLimit, LUA_MASKCOUNT, 1'000'000);

  lua_rawgeti(L, LUA_REGISTRYINDEX, entry->funcRef);
  if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
    std::string err(lua_tostring(L, -1));
    lua_pop(L, 1);
    throw std::runtime_error(err);
  }
  Json result = luaToJson(L, -1);
  lua_pop(L, 1);
  if (metadata) {
    // Return the geometry used by this evaluation, plus actual Region dependencies so
    // shared State/Region consumers can still reject a Region reading its own output.
    metadata->update(entry->ctx->geometry);
    (*metadata)["regionsRead"] = entry->ctx->regionsRead;
  }
  return result;
}

// Reads a value of the game's memory at address, after following each offset as a pointer
static Json readMemory(HANDLE proc, const std::string &address, const Json &offsets, const std::string &bt) {
  std::string addrStr = address;
  if (addrStr.size() > 2 && addrStr.substr(0,2) == "0x") addrStr = addrStr.substr(2);
  uintptr_t addr = std::stoull(addrStr, nullptr, 16);
  for (auto& off : offsets) {
    uintptr_t ptr = 0; SIZE_T n = 0;
    if (!ReadProcessMemory(proc, reinterpret_cast<LPCVOID>(addr), &ptr, sizeof(ptr), &n) || n != sizeof(ptr))
      throw std::runtime_error("Pointer dereference failed");
    std::string os = off.get<std::string>();
    if (os.size() > 2 && os.substr(0,2) == "0x") os = os.substr(2);
    addr = ptr + std::stoull(os, nullptr, 16);
  }
  auto read = [&](void* buf, size_t sz) {
    SIZE_T n = 0;
    if (!ReadProcessMemory(proc, reinterpret_cast<LPCVOID>(addr), buf, sz, &n) || n != sz)
      throw std::runtime_error("ReadProcessMemory failed");
  };
  Json value;
  if      (bt=="u8")    { uint8_t  v; read(&v,1); value=v; }
  else if (bt=="i8")    { int8_t   v; read(&v,1); value=v; }
  else if (bt=="u16")   { uint16_t v; read(&v,2); value=v; }
  else if (bt=="i16")   { int16_t  v; read(&v,2); value=v; }
  else if (bt=="u32")   { uint32_t v; read(&v,4); value=v; }
  else if (bt=="i32")   { int32_t  v; read(&v,4); value=v; }
  else if (bt=="u64")   { uint64_t v; read(&v,8); value=(double)v; }
  else if (bt=="i64")   { int64_t  v; read(&v,8); value=(double)v; }
  else if (bt=="f32")   { float    v; read(&v,4); value=v; }
  else if (bt=="f64")   { double   v; read(&v,8); value=v; }
  else if (bt=="utf8")  { char buf[512]={}; SIZE_T n=0; ReadProcessMemory(proc,reinterpret_cast<LPCVOID>(addr),buf,511,&n); value=std::string(buf,strnlen(buf,511)); }
  else if (bt=="utf16") { wchar_t buf[512]={}; SIZE_T n=0; ReadProcessMemory(proc,reinterpret_cast<LPCVOID>(addr),buf,510,&n); value=winrt::to_string(std::wstring_view(buf,wcsnlen(buf,255))); }
  else throw std::runtime_error("Unknown byteType: " + bt);
  return value;
}

// A memory or Lua State's value as an observation of the type it's recorded as
static Json conform(const Json &value, const std::string &type) {
  if (type == "number") {
    if (!value.is_number() || !std::isfinite(value.get<double>())) throw std::runtime_error("Expected a number");
    return value.get<double>();
  }
  if (type == "boolean") {
    if (!value.is_boolean()) throw std::runtime_error("Expected true or false");
    return value;
  }
  if (type == "vector") {
    if (value.is_array() && value.size() == 2 && value[0].is_number() && value[1].is_number()) return value;
    if (value.is_object() && value.contains("x") && value.contains("y") && value["x"].is_number() && value["y"].is_number())
      return Json{value["x"], value["y"]};
    throw std::runtime_error("Expected a vector: {x, y} or two numbers");
  }
  if (type == "text") {
    if (!value.is_string()) throw std::runtime_error("Expected text");
    return value;
  }
  if (type == "shapes") {
    // Lua has one table type: the JSON bridge represents an empty table as {}.
    if (value.is_object() && value.empty()) return Json::array();
    if (!value.is_array()) throw std::runtime_error("Expected a collection: an array of items");
    return value;
  }
  return value; // anything else is kept as it is
}

static std::vector<uint8_t> fromBase64(const std::string &s) {
  static const std::string T =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> out;
  int val = 0, valb = -8;
  for (unsigned char c : s) {
    if (c == '=') break;
    auto p = T.find(c);
    if (p == std::string::npos) continue;
    val = (val << 6) | (int)p;
    if ((valb += 6) >= 0) { out.push_back((val >> valb) & 0xff); valb -= 8; }
  }
  return out;
}

static void packet(uint8_t kind, const void *data, uint32_t size) {
  uint32_t total = size + 1;
  std::cout.write(reinterpret_cast<const char *>(&total), 4);
  std::cout.put(static_cast<char>(kind));
  std::cout.write(static_cast<const char *>(data), size);
  std::cout.flush();
  if (!std::cout)
    std::exit(0);
}
static void jsonPacket(const Json &value) {
  // Text read from the screen or from memory may not be valid UTF-8, which must not fail a reply
  auto data = value.dump(-1, ' ', false, Json::error_handler_t::replace);
  packet(1, data.data(), static_cast<uint32_t>(data.size()));
}
static Json response(uint32_t id) {
  return {{"v", 1}, {"id", id}, {"ok", true}};
}
static void error(uint32_t id, const std::string &code,
                  const std::string &message) {
  jsonPacket({{"v", 1},
              {"id", id},
              {"ok", false},
              {"error", {{"code", code}, {"message", message}}}});
}
static void event(const std::string &name, const Json &result) {
  auto value = response(0);
  value["event"] = name;
  value["result"] = result;
  jsonPacket(value);
}
static BOOL CALLBACK enumerate(HWND hwnd, LPARAM param) {
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER))
    return TRUE;
  DWORD cloaked = 0;
  DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  if (cloaked)
    return TRUE;
  wchar_t title[1024]{};
  if (!GetWindowTextW(hwnd, title, 1024))
    return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  reinterpret_cast<Json *>(param)->push_back(
      {{"id", std::to_string(reinterpret_cast<uintptr_t>(hwnd))},
       {"title", winrt::to_string(title)},
       {"pid", pid}});
  return TRUE;
}
int main() {
  _setmode(_fileno(stdout), _O_BINARY);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  firefly::installWindowsOcr(); // for ocr nodes: reading text in a region
  auto capture = makeCaptureSource();
  std::shared_ptr<firefly::Graph> graph;
  std::unique_ptr<firefly::Catalog> catalog;
  // What each region follows, as template.set gave it. Replaced, never changed
  // in place, so a job keeps the set it was submitted with.
  auto tracks = std::make_shared<const firefly::Tracks>();
  // What the app's States read from followed regions, recorded with the graph's observations
  firefly::TrackedObservations tracked;
  HWND target = nullptr; // the captured window
  // States read from the game's memory or by Lua scripts ("probes"), recorded like the tracked ones.
  // They're read when a frame is sent for detection, at most every kProbeGapMs, so their values are
  // of that frame's time; the game's process is opened once per capture target.
  struct Probe { std::string name, kind, type, address, byteType, script; Json offsets; double width = 0, height = 0; };
  Json scriptRegionSnapshot = Json::array();
  auto scriptStateSnapshot = std::make_shared<const std::vector<ScriptState>>();
  constexpr double kProbeGapMs = 30;
  std::vector<Probe> probes;
  Json probeDefinitions = Json::array(), probeFields = Json::array(), lastProbes = Json::array(), probeMs = Json::object();
  double lastProbeAt = -1e9;
  HANDLE probeProcess = nullptr;
  DWORD probePid = 0;
  auto readProbes = [&](const CapturedFrame *frame) -> Json {
    if (probes.empty()) return Json::array();
    const double now = firefly::monotonicMs();
    if (now - lastProbeAt < kProbeGapMs) return lastProbes;
    lastProbeAt = now;
    DWORD pid = 0;
    if (target) GetWindowThreadProcessId(target, &pid);
    if (pid != probePid) {
      if (probeProcess) CloseHandle(probeProcess);
      probeProcess = pid ? OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid) : nullptr;
      probePid = pid;
    }
    Json out = Json::array(), ms = Json::object();
    // One scope for the pass: every probe reading a State sees the same reading of it
    StateScope scope;
    scope.defs = scriptStateSnapshot; scope.proc = probeProcess; scope.hwnd = target; scope.regions = scriptRegionSnapshot;
    scope.frame = frame;
    // Where the game's client area sits in the captured frame, which also holds the window's title bar and borders
    const Json geometry = target ? scriptGeometry(target, frame) : Json::object();
    for (const auto &p : probes) {
      const double begin = firefly::monotonicMs();
      Json o = {{"name", p.name}, {"type", p.type}};
      try {
        if (!probeProcess) throw std::runtime_error("Cannot open the game's process for reading");
        Json value = p.kind == "memory" ? readMemory(probeProcess, p.address, p.offsets, p.byteType)
                                        : runMemoryScript(probeProcess, target, p.script, scriptRegionSnapshot, p.width, p.height,
                                                          "", frame, nullptr, &scope);
        o["value"] = conform(value, p.type);
        o["valid"] = true;
        // A script's positions are in the client area's pixels (or its own coordinate size): how they map onto
        // this frame's pixels, frame x = x + value * sx, for anything that labels or crops the frame itself
        if (p.kind == "script" && frame && geometry.contains("clientArea")) {
          const auto &area = geometry["clientArea"];
          const double sw = p.width > 0 ? p.width : geometry.value("windowW", 0.0);
          const double sh = p.height > 0 ? p.height : geometry.value("windowH", 0.0);
          if (sw > 0 && sh > 0)
            o["toFrame"] = {{"x", area.value("x", 0.0) * frame->width}, {"y", area.value("y", 0.0) * frame->height},
                            {"sx", area.value("w", 1.0) * frame->width / sw}, {"sy", area.value("h", 1.0) * frame->height / sh}};
        }
      } catch (const std::exception &e) {
        o["valid"] = false; o["value"] = nullptr; o["reason"] = e.what();
      }
      ms[p.name] = firefly::monotonicMs() - begin;
      out.push_back(o);
    }
    lastProbes = out; probeMs = ms;
    return out;
  };
  // Everything recorded beside the graph's outputs: tracked observations, then probes
  auto extraDefinitions = [&] {
    Json all = tracked.definitions();
    for (const auto &d : probeDefinitions) all.push_back(d);
    return all;
  };
  auto extraFields = [&] {
    Json all = tracked.fields();
    for (const auto &f : probeFields) all.push_back(f);
    return all;
  };
  // Observations left out of recordings, by name: still observed, for States and play
  Json unrecorded = Json::array();
  auto recordedOnly = [&](const Json &observations) {
    Json kept = Json::array();
    for (const auto &o : observations)
      if (std::find(unrecorded.begin(), unrecorded.end(), o["name"]) == unrecorded.end()) kept.push_back(o);
    return kept;
  };
  firefly::InputMonitor inputs;
  firefly::Recorder recorder;
  bool recording = false;
  double nextTick = 0, lastReport = 0, started = 0, lastSample = 0;
  int hz = 15;
  Json observationIdentity, actionIdentity;
  std::shared_ptr<const CapturedFrame> latest;
  bool collectFrames = false;
  std::deque<std::shared_ptr<const CapturedFrame>> collectedFrames;
  size_t collectedBytes = 0;
  auto clearCollected = [&] { collectedFrames.clear(); collectedBytes = 0; };
  auto retainCollected = [&](const std::shared_ptr<const CapturedFrame> &frame) {
    if (!collectFrames) return;
    collectedFrames.push_back(frame);
    collectedBytes += frame->bgra.size();
    while (!collectedFrames.empty() && (collectedBytes > 128 * 1024 * 1024 ||
           frame->timestamp - collectedFrames.front()->timestamp > 5000)) {
      collectedBytes -= collectedFrames.front()->bgra.size();
      collectedFrames.pop_front();
    }
  };
  std::optional<firefly::DetectionResult> detected;
  uint64_t generation = 1, recordingGeneration = 0;
  double nextCapture = 0;
  firefly::Detector detector;
  LatestWorker<firefly::DetectionJob, firefly::DetectionResult> worker(
      [&](firefly::DetectionJob job) { return detector(std::move(job)); });
  // Template matching runs on a worker of its own, beside the graph's, so a
  // slow model doesn't hold up the boxes that follow objects, nor they it.
  uint64_t trackingGeneration = 1;
  firefly::Tracker tracker;
  LatestWorker<firefly::TrackingJob, firefly::TrackingResult> trackingWorker(
      [&](firefly::TrackingJob job) { return tracker(std::move(job)); });
  auto invalidateDetection = [&] { ++generation; worker.clear(); detected.reset(); };  // a waiting result is dropped by its generation
  auto invalidateTracking = [&] { ++trackingGeneration; trackingWorker.clear(); };
  auto invalidateAll = [&] { invalidateDetection(); invalidateTracking(); tracked.reset(); clearCollected(); };
  std::string previewNode; // graph node drawn on the live view instead of the output
  CommandReader commands;
  // How fast things actually happen, for the app to show against what a recording aims for: new frames
  // from the game (a window only yields one when it redraws), graph results, and recorded samples
  firefly::RateMeter frameRate, detectionRate, sampleRate;
  auto recordingStatus = [&] {
    auto status = recorder.status();
    status["sampleHz"] = sampleRate.hz(firefly::monotonicMs());
    // Buttons count only while the game is the window in front, so the app can say when it isn't
    if (recording) status["focused"] = inputs.stateAt(firefly::monotonicMs()).value("focused", false);
    return status;
  };
  auto stopRecording = [&](const std::string &reason) {
    if (!recording)
      return;
    inputs.stop();
    for (auto &input : inputs.drain())
      recorder.enqueue(input);
    recorder.stop(reason);
    recording = false;
    ++recordingGeneration;
    event("recording", recorder.status());
  };
  auto acquire = [&]() {
    auto frame = capture->next();
    if (!frame) return;
    if (latest && (frame->width != latest->width || frame->height != latest->height))
      invalidateAll(); // old-size overlays must not move regions on the resized view
    latest = std::make_shared<CapturedFrame>(std::move(*frame));
    frameRate.tick(latest->timestamp);
    // Boxes follow their objects at capture rate, recording or not. A frame a sample is taken from is
    // always matched too, so the sample has the tracker's result for its own frame, not an earlier one
    const double now = firefly::monotonicMs();
    const bool sampled = !recording || now >= nextTick;
    if (!tracks->empty())
      trackingWorker.submit({trackingGeneration, latest, tracks}, recording && sampled && !tracked.empty());
    if (!sampled) return;
    // On a schedule, not from now: frames come unevenly, and "now + interval" rounds every interval up to
    // the next frame (15 Hz became 12, and a game's 24 frames a second became 21 at 30). A frame is taken
    // once the schedule is due, and the schedule catches up after late frames but never runs ahead of now,
    // so a recording never averages more than hz.
    if (recording) nextTick = std::max(nextTick + 1000.0 / hz, now);
    firefly::DetectionJob job;
    job.generation = generation; job.recordingGeneration = recordingGeneration;
    job.probes = readProbes(latest.get());
    job.frame = latest; job.graph = graph; job.preview = previewNode;
    worker.submit(std::move(job));
  };
  // How long matching takes to return a frame after it was captured, lately (a running average), so a
  // detection result waits for it only while it keeps up (see receiveDetection)
  double trackLatency = -1;
  auto receiveTracking = [&] {
    auto result = trackingWorker.take();
    if (!result || !target || result->generation != trackingGeneration) return;
    const double latency = firefly::monotonicMs() - result->frame->timestamp;
    if (std::isfinite(latency) && latency >= 0) trackLatency = trackLatency < 0 ? latency : 0.8 * trackLatency + 0.2 * latency;
    if (!result->error.empty()) event("detection-error", {{"message", result->error}});
    else {
      tracked.update(result->match);
      event("template.match", result->match);
    }
  };
  // A detection result waits for the tracker to finish its frame (it's matched at the same time, and
  // usually finishes a little later), so its sample and observations event carry that frame's tracked
  // values rather than an earlier frame's. It waits only while matching keeps up (returns frames within
  // kBehindMs of capture), and only as long as matching usually takes, at most kTrackWaitMs: matching
  // that has fallen behind would otherwise hold every observation for the full wait, and a playing
  // policy's observations would reach the input guard too old to act on. Then it goes with what the
  // tracker has (held, as TrackedObservations::at does).
  constexpr double kTrackWaitMs = 100, kBehindMs = 150;
  std::optional<firefly::DetectionResult> waiting;
  double waitingSince = 0, waitUntil = 0;
  std::function<void(firefly::DetectionResult, double)> finishDetection;
  auto receiveDetection = [&] {
    auto result = worker.take();
    if (result && target && result->generation == generation) {
      const double now = firefly::monotonicMs();
      if (waiting) finishDetection(std::move(*std::exchange(waiting, std::nullopt)), now - waitingSince); // a newer one came first
      const double until = trackLatency < 0 ? now + kTrackWaitMs
        : std::min(now + kTrackWaitMs, result->frame->timestamp + 1.3 * trackLatency + 10);
      if (!result->error.empty()) event("detection-error", {{"message", result->error}});
      else if (!tracked.empty() && !tracks->empty() && tracked.newest() < result->frame->timestamp &&
               trackLatency <= kBehindMs && until > now) {
        waiting = std::move(result);
        waitingSince = now;
        waitUntil = until;
      } else finishDetection(std::move(*result), 0);
    }
    if (waiting && (tracked.newest() >= waiting->frame->timestamp || tracks->empty() ||
                    firefly::monotonicMs() >= waitUntil))
      finishDetection(std::move(*std::exchange(waiting, std::nullopt)), firefly::monotonicMs() - waitingSince);
  };
  finishDetection = [&](firefly::DetectionResult finished, double waitedMs) {
    if (!target || finished.generation != generation) return;
    auto result = std::make_optional(std::move(finished));
    retainCollected(result->frame);
    auto &observations = result->observations;
    const auto timestamp = result->frame->timestamp;
    // What the tracker found in the same frame (or the one just before it), after the graph's
    Json trackedValues = tracked.empty() ? Json::array() : tracked.at(timestamp);
    for (const auto &value : result->probes) trackedValues.push_back(value);
    // The frame's size, which a policy's grids are laid over
    const Json frameSize = {{"w", result->frame->width}, {"h", result->frame->height}};
    if (!observations.is_null()) {
      observations["tracked"] = trackedValues;
      observations["frame"] = frameSize;
      // Where the time went since the frame was captured, for play to say why an action came too late
      observations["latency"] = {{"graphMs", result->elapsedMs}, {"waitMs", waitedMs},
        {"trackingMs", trackLatency}, {"ageMs", firefly::monotonicMs() - timestamp}};
      if (!probes.empty()) observations["probeMs"] = probeMs;
    }
    if (recording && result->recordingGeneration == recordingGeneration &&
        timestamp >= started && timestamp > lastSample && !observations.is_null()) {
      auto actions = inputs.stateAt(timestamp);
      bool valid = actions.value("valid", false);
      Json sampled = observations["observations"];
      for (auto &value : trackedValues) sampled.push_back(value);
      sampled = recordedOnly(sampled);
      for (auto &value : sampled)
        valid = valid && value["valid"].get<bool>();
      recorder.enqueue({{"kind", "sample"}, {"timestamp", timestamp},
        {"observationSchema", observationIdentity["identity"]},
        {"actionSchema", actionIdentity["identity"]},
        {"observations", sampled}, {"actions", actions}, {"valid", valid}, {"frame", frameSize}});
      lastSample = timestamp;
      sampleRate.tick(timestamp);
    }
    if (!observations.is_null()) event("observations", observations);
    detectionRate.tick(timestamp);
    event("detection-status", {{"timestamp", timestamp}, {"durationMs", result->elapsedMs},
      {"frameHz", frameRate.hz(timestamp)}, {"detectionHz", detectionRate.hz(timestamp)},
      {"ageMs", std::max(0.0, firefly::monotonicMs() - timestamp)}});
    detected = std::move(result);
  };
  while (true) {
    if (target) {
      try {
        receiveTracking();
        receiveDetection();
        if (recording) for (auto &input : inputs.drain())
          recorder.enqueue(input);
        if (recording && (inputs.overflow() || recorder.failed()))
          throw std::runtime_error("Recording input/writer overflow or disk "
                                   "failure; session interrupted");
        double now = firefly::monotonicMs();
        if (now >= nextCapture) {
          acquire();
          nextCapture = now + 1000.0 / 60;
        }
        if (recording && now - lastReport > 500) {
          event("recording", recordingStatus());
          lastReport = now;
        }
      } catch (const std::exception &e) {
        stopRecording("interrupted");
        capture->stop();
        target = nullptr;
        invalidateAll();
        event("capture-error", {{"message", e.what()}});
      }
    }
    auto line = commands.next(target ? 2 : 100);
    if (!line) {
      if (commands.done())
        break;
      continue;
    }
    uint32_t id = 0;
    std::string op;
    try {
      auto request = Json::parse(*line);
      if (!request.contains("id") || !request["id"].is_number_unsigned() ||
          request["id"].get<uint64_t>() > UINT32_MAX || request["id"] == 0)
        throw std::runtime_error("Invalid request ID");
      id = request["id"];
      if (request.value("v", 0) != 1) {
        error(id, "PROTOCOL_VERSION", "Expected protocol version 1");
        continue;
      }
      op = request.at("op");
      auto r = response(id);
      if (op == "health") {
        r["captureSupported"] = winrt::Windows::Graphics::Capture::
            GraphicsCaptureSession::IsSupported();
        r["recording"] = recorder.status();
      } else if (op == "inference.devices") {
        r["devices"] = firefly::inferenceDevices();
        r["cpuThreads"] = firefly::cpuThreads();
        r["maxThreads"] = std::max(1u, std::thread::hardware_concurrency());
      } else if (op == "inference.threads") {
        // How many threads the CPU runs models on; the graph and its schema are left as they are
        const int max = (int)std::max(1u, std::thread::hardware_concurrency());
        const int threads = request.at("threads").get<int>();
        if (threads < 1 || threads > max)
          throw std::runtime_error("CPU threads must be 1.." + std::to_string(max));
        firefly::setCpuThreads(threads);
        r["cpuThreads"] = threads;
      } else if (op == "storage.init") {
        if (recording)
          throw std::runtime_error("Stop recording before changing storage");
        catalog = std::make_unique<firefly::Catalog>(std::filesystem::path(
            winrt::to_hstring(request.at("directory").get<std::string>())
                .c_str()));
      } else if (op == "session.schemas") {
        if (!graph)
          throw std::runtime_error("Apply a graph first");
        r["observationSchema"] = firefly::observationSchema(*graph, extraDefinitions(), extraFields(), unrecorded);
        r["actionSchema"] = firefly::actionSchema(request.at("buttons"));
      } else if (op == "observe.fields") {
        // Everything observed now (the graph's outputs, then the tracked ones), and what's left out of recordings
        Json fields = graph ? graph->schema()["fields"] : Json::array();
        for (const auto &field : extraFields()) fields.push_back(field);
        r["fields"] = fields;
        r["excluded"] = unrecorded;
      } else if (op == "observe.recorded") {
        if (recording)
          throw std::runtime_error("Stop recording before changing what it holds");
        Json names = request.at("exclude");
        if (!names.is_array() || names.size() > 256)
          throw std::runtime_error("Name at most 256 observations to leave out");
        for (const auto &name : names)
          if (!name.is_string()) throw std::runtime_error("Observations are left out by name");
        unrecorded = names;
        r["excluded"] = unrecorded;
      } else if (op == "dataset.delete") {
        if (!catalog)
          throw std::runtime_error("Storage not initialized");
        const auto recordingId = request.at("recordingId").get<std::string>();
        if (recording && recorder.status().value("id", std::string()) == recordingId)
          throw std::runtime_error("Stop this recording before deleting it");
        catalog->remove(recordingId);
      } else if (op == "dataset.list") {
        if (!catalog)
          throw std::runtime_error("Storage not initialized");
        r["recordings"] = catalog->list();
      } else if (op == "dataset.read") {
        if (!catalog)
          throw std::runtime_error("Storage not initialized");
        r["recording"] =
            catalog->read(request.at("recordingId"), request.value("offset", 0),
                          request.value("limit", 50), request.value("tail", false),
                          request.value("stream", std::string("samples")));
      } else if (op == "record.start") {
        if (recording)
          throw std::runtime_error("Already recording");
        if (!catalog || !graph || !target)
          throw std::runtime_error(
              "Start capture and apply a graph before recording");
        hz = request.value("hz", 15);
        if (hz < 5 || hz > 30)
          throw std::runtime_error("Recording frequency must be 5..30 Hz");
        actionIdentity = firefly::actionSchema(request.at("buttons"));
        observationIdentity = firefly::observationSchema(*graph, extraDefinitions(), extraFields(), unrecorded);
        started = firefly::monotonicMs();
        Json metadata = {
            {"version", 1},
            {"id", request.at("recordingId")},
            {"name", request.value("name", std::string("Recording"))},
            {"started", started},
            {"hz", hz},
            {"observationSchema", observationIdentity},
            {"actionSchema", actionIdentity},
            {"graph", graph->definition()},
            {"tracked", extraDefinitions()},
            {"correction", request.value("correction", false)},
            // A correction names the policy it corrects, so it can be trained on with it
            {"policyId", request.value("policyId", std::string())}};
        inputs.start(target, actionIdentity);
        try {
          recorder.start(catalog->root(), metadata);
        } catch (...) {
          inputs.stop();
          throw;
        }
        recording = true;
        ++recordingGeneration;
        sampleRate.clear();
        nextTick = 0;
        lastSample = 0;
        r["recording"] = recorder.status();
        event("recording", recorder.status());
      } else if (op == "record.stop") {
        stopRecording("complete");
        r["recording"] = recorder.status();
      } else if (op == "windows") {
        Json list = Json::array();
        EnumWindows(enumerate, reinterpret_cast<LPARAM>(&list));
        r["windows"] = list;
      } else if (op == "start") {
        if (recording)
          throw std::runtime_error("Stop recording before switching capture");
        auto s = request.at("windowId").get<std::string>();
        size_t used = 0;
        auto handle = std::stoull(s, &used);
        if (used != s.size())
          throw std::runtime_error("Invalid window ID");
        capture->start(static_cast<uintptr_t>(handle));
        target = reinterpret_cast<HWND>(static_cast<uintptr_t>(handle));
        scriptRegionSnapshot = Json::array();
        scriptStateSnapshot = std::make_shared<const std::vector<ScriptState>>();
        latest.reset();
        invalidateAll();
        frameRate.clear(); detectionRate.clear();
      } else if (op == "stop") {
        stopRecording("complete");
        capture->stop();
        target = nullptr;
        invalidateAll();
        latest.reset();
        tracks = std::make_shared<const firefly::Tracks>();
      } else if (op == "memory.read") {
        if (!target) throw std::runtime_error("No capture target");
        DWORD pid = 0;
        GetWindowThreadProcessId(target, &pid);
        if (!pid) throw std::runtime_error("Cannot get process ID");
        HANDLE proc = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid);
        if (!proc) throw std::runtime_error("Cannot open process for reading");
        try {
          r["value"] = readMemory(proc, request.at("address").get<std::string>(),
                                  request.value("offsets", Json::array()),
                                  request.value("byteType", std::string("u32")));
          CloseHandle(proc);
        } catch (...) { CloseHandle(proc); throw; }
      } else if (op == "memory.run_script") {
        if (!target) throw std::runtime_error("No capture target");
        DWORD pid = 0;
        GetWindowThreadProcessId(target, &pid);
        if (!pid) throw std::runtime_error("Cannot get process ID");
        HANDLE proc = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid);
        if (!proc) throw std::runtime_error("Cannot open process for reading");
        try {
          if (request.contains("regions")) {
            if (!request["regions"].is_array() || request["regions"].size() > 512) throw std::runtime_error("Expected at most 512 Regions");
            scriptRegionSnapshot = request["regions"];
          }
          // The memory and Lua States scripts can read, kept for recorded States too, as the Regions are
          if (request.contains("states"))
            scriptStateSnapshot = std::make_shared<const std::vector<ScriptState>>(parseScriptStates(request["states"]));
          StateScope scope;
          scope.defs = scriptStateSnapshot; scope.proc = proc; scope.hwnd = target; scope.regions = scriptRegionSnapshot;
          scope.frame = latest.get();
          scope.regionId = request.value("regionId", std::string());
          scope.selfId = request.value("stateId", std::string());
          r["timestamp"] = firefly::monotonicMs();
          r["value"] = runMemoryScript(proc, target, request.at("script").get<std::string>(), scriptRegionSnapshot,
            request.value("scriptWidth", 0.0), request.value("scriptHeight", 0.0), scope.regionId, latest.get(), &r, &scope);
          CloseHandle(proc);
        } catch (...) { CloseHandle(proc); throw; }
      } else if (op == "template.set" || op == "template.remove") {
        // Regions are followed independently: setting or removing one leaves the
        // others, and where they were, as they are. Results name the context
        // they were matched with, so the app ignores any from a replaced one.
        auto region = request.at("region").get<std::string>();
        auto next = std::make_shared<firefly::Tracks>();
        for (auto &track : *tracks)
          if (track->region != region) next->push_back(track);
        if (op == "template.set") {
          auto track = std::make_shared<firefly::Track>();
          track->region = region;
          track->context = request.value("context", std::string());
          track->multi = request.value("multiMatch", false);
          track->threshold = request.value("threshold", 0.75);
          track->look = firefly::lookNamed(request.value("preprocess", std::string("color")));
          track->reach = request.value("reach", -1);
          track->widenEachFrame = request.value("widenEachFrame", false);
          // How much further out each step looks: a little more than the last up to 8 times as far
          track->widenBy = std::clamp(request.value("widenBy", 2.0), 1.1, 8.0);
          // Where the object's box was (followed by corners, its top-left corner), and the biggest it can be,
          // both as fractions of the frame, and how far from where it was last found to look for it, in px
          if (request.contains("hint"))
            track->start = cv::Rect2d(request["hint"].value("x", 0.0), request["hint"].value("y", 0.0),
                                      request["hint"].value("w", 0.0), request["hint"].value("h", 0.0));
          if (request.contains("largest"))
            track->largest = {request["largest"].value("w", 1.0), request["largest"].value("h", 1.0)};
          for (auto& tmpl : request.at("templates")) {
            auto key = tmpl.at("key").get<std::string>();
            auto raw = fromBase64(tmpl.at("data").get<std::string>());
            cv::Mat buf(1, (int)raw.size(), CV_8UC1, raw.data());
            cv::Mat decoded = cv::imdecode(buf, cv::IMREAD_COLOR);
            if (decoded.empty()) continue;
            // A template is the whole object, or one of its corners
            auto role = tmpl.value("role", std::string());
            // Corners are matched on colour: a look's preparation would cost a small patch too much
            if (role == "tl") track->topLeft.emplace_back(std::move(decoded));
            else if (role == "br") track->bottomRight.emplace_back(std::move(decoded));
            else {
              // Which of its pixels are the object: a grayscale PNG the template's size, white where it counts
              cv::Mat mask;
              if (tmpl.contains("mask") && tmpl["mask"].is_string()) {
                auto bytes = fromBase64(tmpl["mask"].get<std::string>());
                cv::Mat mbuf(1, (int)bytes.size(), CV_8UC1, bytes.data());
                mask = cv::imdecode(mbuf, cv::IMREAD_GRAYSCALE);
                if (!mask.empty() && mask.size() != decoded.size()) cv::resize(mask, mask, decoded.size(), 0, 0, cv::INTER_NEAREST);
              }
              track->templates[key] = firefly::patternFor(decoded, track->look, mask);
            }
          }
          if (track->fitting()) track->look = firefly::Look::Color;
          if (!track->empty()) next->push_back(std::move(track));
        }
        tracks = std::move(next);
        r["regions"] = tracks->size();
      } else if (op == "observe.tracked") {
        // Which of the tracker's findings are observations, as the app's States define them
        if (recording)
          throw std::runtime_error("Stop recording before changing what it observes");
        Json fromTracker = Json::array(), fromProbes = Json::array();
        std::vector<Probe> nextProbes;
        std::set<std::string> names;
        for (const auto &d : request.at("observations")) {
          const auto kind = d.at("value").get<std::string>();
          if (!names.insert(d.at("name").get<std::string>()).second)
            throw std::runtime_error("Recorded States must have different names");
          if (kind != "memory" && kind != "script") { fromTracker.push_back(d); continue; }
          Probe p{d.at("name").get<std::string>(), kind};
          if (kind == "memory") {
            p.address = d.at("address").get<std::string>();
            p.offsets = d.value("offsets", Json::array());
            p.byteType = d.value("byteType", std::string("u32"));
            static const std::set<std::string> byteTypes{"u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "utf8", "utf16"};
            if (p.address.empty() || !p.offsets.is_array() || p.offsets.size() > 16 || !byteTypes.contains(p.byteType))
              throw std::runtime_error(p.name + ": a memory State needs an address, at most 16 offsets and a known byte type");
            p.type = p.byteType == "utf8" || p.byteType == "utf16" ? "text" : "number";
          } else {
            p.script = d.at("script").get<std::string>();
            p.width = d.value("scriptWidth", 0.0); p.height = d.value("scriptHeight", 0.0);
            p.type = d.value("type", std::string("object"));
            if (p.script.empty() || p.script.size() > 20000)
              throw std::runtime_error(p.name + ": a Lua State needs a script of at most 20,000 characters");
            // Collection States feed the same list/geometry formula inputs as region shapes.
            if (p.type == "collection") p.type = "shapes";
            if (p.type != "number" && p.type != "boolean" && p.type != "vector" && p.type != "text" && p.type != "shapes") p.type = "object";
          }
          nextProbes.push_back(std::move(p));
          fromProbes.push_back(d);
        }
        tracked.configure(fromTracker);
        probes = std::move(nextProbes);
        probeDefinitions = fromProbes;
        probeFields = Json::array();
        for (const auto &p : probes) {
          Json field = {{"name", p.name}, {"type", p.type}};
          if (p.type == "vector") field["size"] = 2;
          probeFields.push_back(field);
        }
        lastProbeAt = -1e9; lastProbes = Json::array(); probeMs = Json::object();
        r["fields"] = extraFields();
      } else if (op == "template.clear") {
        tracks = std::make_shared<const firefly::Tracks>();
      } else if (op == "graph.validate" || op == "graph.apply") {
        if (op == "graph.apply" && recording)
          throw std::runtime_error(
              "Stop recording before replacing its observation schema");
        auto candidate = std::make_shared<firefly::Graph>(request.at("graph"));
        r["schema"] = candidate->schema();
        if (op == "graph.apply") {
          graph = std::move(candidate);
          invalidateDetection();
        }
      } else if (op == "graph.preview") {
        auto &node = request.at("node");
        previewNode = node.is_string() ? node.get<std::string>() : "";
        invalidateDetection();
      } else if (op == "graph.get") {
        r["graph"] = graph ? graph->definition() : Json(nullptr);
      } else if (op == "collection.frames") {
        if (request.value("enabled", false) && (!target || request.value("windowId", std::string()) != std::to_string(reinterpret_cast<uintptr_t>(target))))
          throw CaptureError("NOT_CAPTURING", "Start capture on the selected window before collecting");
        collectFrames = request.value("enabled", false);
        if (!collectFrames) clearCollected();
      } else if (op == "frame") {
        if (!target)
          throw CaptureError("NOT_CAPTURING",
                             "Select a window and start capture.");
        const bool processed = request.value("processed", false);
        std::shared_ptr<const CapturedFrame> exact;
        if (request.contains("timestamp")) {
          const double stamp = request.at("timestamp").get<double>();
          for (const auto &kept : collectedFrames) if (kept->timestamp == stamp) { exact = kept; break; }
          if (!exact) throw CaptureError("FRAME_EXPIRED", "The source frame is no longer available");
        }
        if (!latest || (processed && !detected)) {
          r["pending"] = true;
          jsonPacket(r);
          continue;
        }
        // Raw preview never waits for detection. Processed previews use their
        // own source frame and timestamp, never an old overlay on a new image.
        const auto &frame = exact ? *exact : processed ? *detected->frame : *latest;
        // The live view polls every display frame, and a game repaints less often: a frame the caller
        // already has (`since`, its capture time) isn't sent again, which saves main.cjs reading and
        // copying megabytes of pixels on its busy thread
        if (!processed && request.contains("since") && request["since"].is_number() &&
            request["since"].get<double>() == frame.timestamp) {
          r["unchanged"] = true;
          r["timestamp"] = frame.timestamp;
          jsonPacket(r);
          continue;
        }
        const uint8_t *sendBgra = frame.bgra.data();
        int sendW = frame.width, sendH = frame.height;
        cv::Mat overlayContig;
        if (processed && !detected->overlay.empty() && detected->overlay.channels() == 4) {
          overlayContig = detected->overlay.isContinuous() ? detected->overlay : detected->overlay.clone();
          sendBgra = overlayContig.data; sendW = overlayContig.cols; sendH = overlayContig.rows;
        }
        const size_t pixelBytes = (size_t)sendW * sendH * 4;
        std::vector<uint8_t> bytes(20 + pixelBytes);
        std::memcpy(bytes.data(), &id, 4);
        std::memcpy(bytes.data() + 4, &sendW, 4);
        std::memcpy(bytes.data() + 8, &sendH, 4);
        std::memcpy(bytes.data() + 12, &frame.timestamp, 8);
        std::memcpy(bytes.data() + 20, sendBgra, pixelBytes);
        packet(2, bytes.data(), static_cast<uint32_t>(bytes.size()));
        continue;
      } else if (op == CommandReader::kTooLongOp) {
        error(id, "REQUEST_TOO_LARGE", "The request was larger than the runtime reads (64 MB)");
        continue;
      } else if (op == "shutdown") {
        stopRecording("complete");
        capture->stop();
        jsonPacket(r);
        break;
      } else {
        error(id, "UNKNOWN_OPERATION", "Unsupported operation");
        continue;
      }
      jsonPacket(r);
    } catch (const CaptureError &e) {
      stopRecording("interrupted");
      capture->stop();
      target = nullptr;
      invalidateAll();
      error(id, e.code, e.what());
    } catch (const winrt::hresult_error &e) {
      stopRecording("interrupted");
      capture->stop();
      target = nullptr;
      invalidateAll();
      error(id, "WINDOWS_CAPTURE_ERROR", winrt::to_string(e.message()));
    } catch (const std::exception &e) {
      if (op == "frame") {
        stopRecording("interrupted");
        capture->stop();
        target = nullptr;
        invalidateAll();
      }
      error(id, op.starts_with("graph.") ? "GRAPH_INVALID" : "REQUEST_FAILED",
            e.what());
    }
  }
  stopRecording("interrupted");
  capture->stop();
}

