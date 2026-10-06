#pragma once
#include <string>
namespace firefly {
void validateLua(const std::string &code);
double evaluateLua(const std::string &code, double a, double b);
} // namespace firefly
