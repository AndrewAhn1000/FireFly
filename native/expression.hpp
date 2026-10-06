#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace firefly {
// Arithmetic and boolean expressions over named numbers, e.g.
//   height >= max(48, 2.5 * band) and (fill > 0.6 or not touchesTop)
// Supports + - * / %, comparisons, and/or/not (also && || !), parentheses,
// min(a, b), max(a, b), abs(a) and true/false. Booleans are 1 and 0.
class Expression {
public:
  using Lookup = std::function<std::optional<double>(const std::string &)>;
  // Throws std::invalid_argument describing the first syntax error.
  explicit Expression(const std::string &source);
  // Throws std::runtime_error naming the first unknown name.
  double evaluate(const Lookup &lookup) const;

private:
  enum class Kind { Number, Name, Neg, Not, Add, Sub, Mul, Div, Mod, Lt, Le,
                    Gt, Ge, Eq, Ne, And, Or, Min, Max, Abs };
  struct Node {
    Kind kind;
    double value = 0;
    std::string name;
    int a = -1, b = -1;
  };
  friend class ExpressionParser;
  double eval(int node, const Lookup &lookup) const;
  std::vector<Node> nodes_;
  int root_ = -1;
};
} // namespace firefly
