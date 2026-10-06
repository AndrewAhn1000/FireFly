#include "lua_node.hpp"
#include <lua.hpp>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <stdexcept>
namespace firefly {
namespace {
struct Budget {
  size_t allocated = 0;
};
void *allocate(void *user, void *pointer, size_t oldSize, size_t size) {
  auto &budget = *static_cast<Budget *>(user);
  if (!pointer)
    oldSize = 0;
  if (!size) {
    budget.allocated -= oldSize;
    std::free(pointer);
    return nullptr;
  }
  if (size > 262144 || budget.allocated - oldSize > 262144 - size)
    return nullptr;
  auto replacement = std::realloc(pointer, size);
  if (replacement)
    budget.allocated = budget.allocated - oldSize + size;
  return replacement;
}
void limit(lua_State *state, lua_Debug *) {
  luaL_error(state, "Lua instruction budget exceeded");
}
struct State {
  Budget budget;
  lua_State *state;
  State() : state(lua_newstate(allocate, &budget, 7)) {
    if (!state)
      throw std::runtime_error("Lua memory unavailable");
  }
  ~State() { lua_close(state); }
  void load(const std::string &code) {
    if (code.empty() || code.size() > 4096)
      throw std::runtime_error("Lua source must contain 1..4096 bytes");
    if (luaL_loadbufferx(state, code.data(), code.size(), "custom-node", "t") !=
        LUA_OK) {
      auto message = std::string(lua_tostring(state, -1));
      throw std::runtime_error(message);
    }
  }
};
} // namespace
void validateLua(const std::string &code) {
  State state;
  state.load(code);
}
double evaluateLua(const std::string &code, double a, double b) {
  State owner;
  auto *state = owner.state;
  // Empty globals: no filesystem, networking, process, module or debug APIs.
  lua_pushnumber(state, a);
  lua_setglobal(state, "a");
  lua_pushnumber(state, b);
  lua_setglobal(state, "b");
  owner.load(code);
  lua_sethook(state, limit, LUA_MASKCOUNT, 10000);
  if (lua_pcall(state, 0, 1, 0) != LUA_OK)
    throw std::runtime_error(lua_tostring(state, -1));
  if (lua_type(state, -1) != LUA_TNUMBER)
    throw std::runtime_error("Lua node must return a number");
  double result = lua_tonumber(state, -1);
  if (!std::isfinite(result))
    throw std::runtime_error("Lua returned a nonfinite number");
  return result;
}
} // namespace firefly
