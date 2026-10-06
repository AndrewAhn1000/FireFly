#include "expression.hpp"
#include <cctype>
#include <cmath>
#include <stdexcept>

namespace firefly {
namespace {
struct Token {
  enum Type { Number, Name, Symbol, End } type;
  std::string text;
  double value = 0;
  size_t at = 0;
};

std::vector<Token> tokenize(const std::string &s) {
  std::vector<Token> out;
  size_t i = 0;
  while (i < s.size()) {
    unsigned char c = s[i];
    if (std::isspace(c)) {
      ++i;
    } else if (std::isdigit(c) ||
               (c == '.' && i + 1 < s.size() && std::isdigit((unsigned char)s[i + 1]))) {
      size_t used = 0;
      double v = std::stod(s.substr(i), &used);
      out.push_back({Token::Number, s.substr(i, used), v, i});
      i += used;
    } else if (std::isalpha(c) || c == '_') {
      size_t j = i;
      while (j < s.size() && (std::isalnum((unsigned char)s[j]) || s[j] == '_'))
        ++j;
      out.push_back({Token::Name, s.substr(i, j - i), 0, i});
      i = j;
    } else {
      static const char *pairs[] = {"<=", ">=", "==", "!=", "&&", "||"};
      std::string symbol(1, s[i]);
      for (auto pair : pairs)
        if (s.compare(i, 2, pair) == 0)
          symbol = pair;
      if (symbol.size() == 1 && std::string("+-*/%()<>!,").find(s[i]) == std::string::npos)
        throw std::invalid_argument("Unexpected '" + symbol + "' at position " +
                                    std::to_string(i + 1));
      out.push_back({Token::Symbol, symbol, 0, i});
      i += symbol.size();
    }
  }
  out.push_back({Token::End, "", 0, s.size()});
  return out;
}
} // namespace

// Recursive descent, lowest precedence first: or, and, not, comparison,
// sum, product, unary minus, primary.
class ExpressionParser {
public:
  ExpressionParser(Expression &e, const std::string &source)
      : e_(e), tokens_(tokenize(source)) {}

  void parse() {
    e_.root_ = orExpr();
    if (peek().type != Token::End)
      fail("Unexpected '" + peek().text + "'");
  }

private:
  using Kind = Expression::Kind;

  const Token &peek() const { return tokens_[pos_]; }
  bool accept(const char *a, const char *b = nullptr) {
    auto &t = peek();
    if ((t.type == Token::Symbol || t.type == Token::Name) &&
        (t.text == a || (b && t.text == b))) {
      ++pos_;
      return true;
    }
    return false;
  }
  [[noreturn]] void fail(const std::string &why) const {
    throw std::invalid_argument(why + " at position " + std::to_string(peek().at + 1));
  }
  int add(Kind kind, int a = -1, int b = -1) {
    e_.nodes_.push_back({kind, 0, "", a, b});
    return (int)e_.nodes_.size() - 1;
  }
  // Guards the recursion against deeply nested input
  struct Depth {
    ExpressionParser &p;
    explicit Depth(ExpressionParser &parser) : p(parser) {
      if (++p.depth_ > 64)
        p.fail("Expression is nested too deeply");
    }
    ~Depth() { --p.depth_; }
  };

  int orExpr() {
    int left = andExpr();
    while (accept("or", "||"))
      left = add(Kind::Or, left, andExpr());
    return left;
  }
  int andExpr() {
    int left = notExpr();
    while (accept("and", "&&"))
      left = add(Kind::And, left, notExpr());
    return left;
  }
  int notExpr() {
    Depth guard(*this);
    if (accept("not", "!"))
      return add(Kind::Not, notExpr());
    return comparison();
  }
  int comparison() {
    int left = sum();
    static const std::pair<const char *, Kind> ops[] = {
        {"<=", Kind::Le}, {">=", Kind::Ge}, {"==", Kind::Eq},
        {"!=", Kind::Ne}, {"<", Kind::Lt},  {">", Kind::Gt}};
    for (auto &[symbol, kind] : ops)
      if (accept(symbol))
        return add(kind, left, sum());
    return left;
  }
  int sum() {
    int left = product();
    for (;;) {
      if (accept("+"))
        left = add(Kind::Add, left, product());
      else if (accept("-"))
        left = add(Kind::Sub, left, product());
      else
        return left;
    }
  }
  int product() {
    int left = unary();
    for (;;) {
      if (accept("*"))
        left = add(Kind::Mul, left, unary());
      else if (accept("/"))
        left = add(Kind::Div, left, unary());
      else if (accept("%"))
        left = add(Kind::Mod, left, unary());
      else
        return left;
    }
  }
  int unary() {
    Depth guard(*this);
    if (accept("-"))
      return add(Kind::Neg, unary());
    return primary();
  }
  int primary() {
    auto t = peek();
    if (t.type == Token::Number) {
      ++pos_;
      int n = add(Kind::Number);
      e_.nodes_[n].value = t.value;
      return n;
    }
    if (accept("(")) {
      Depth guard(*this);
      int inner = orExpr();
      if (!accept(")"))
        fail("Missing ')'");
      return inner;
    }
    if (t.type != Token::Name)
      fail(t.type == Token::End ? "Expression ends early" : "Unexpected '" + t.text + "'");
    ++pos_;
    if (t.text == "true" || t.text == "false") {
      int n = add(Kind::Number);
      e_.nodes_[n].value = t.text == "true";
      return n;
    }
    if (t.text == "and" || t.text == "or" || t.text == "not")
      fail("Unexpected '" + t.text + "'");
    if (!accept("(")) {
      int n = add(Kind::Name);
      e_.nodes_[n].name = t.text;
      return n;
    }
    Kind kind;
    if (t.text == "min")
      kind = Kind::Min;
    else if (t.text == "max")
      kind = Kind::Max;
    else if (t.text == "abs")
      kind = Kind::Abs;
    else
      fail("Unknown function '" + t.text + "'");
    int a = orExpr(), b = -1;
    if (kind != Kind::Abs) {
      if (!accept(","))
        fail(t.text + "() takes two arguments");
      b = orExpr();
    }
    if (!accept(")"))
      fail("Missing ')'");
    return add(kind, a, b);
  }

  Expression &e_;
  std::vector<Token> tokens_;
  size_t pos_ = 0;
  int depth_ = 0;
};

Expression::Expression(const std::string &source) {
  if (source.empty() || source.size() > 1000)
    throw std::invalid_argument("Expression must be 1..1000 characters");
  ExpressionParser(*this, source).parse();
}

double Expression::evaluate(const Lookup &lookup) const {
  return eval(root_, lookup);
}

double Expression::eval(int i, const Lookup &lookup) const {
  auto &n = nodes_[i];
  auto a = [&] { return eval(n.a, lookup); };
  auto b = [&] { return eval(n.b, lookup); };
  switch (n.kind) {
  case Kind::Number:
    return n.value;
  case Kind::Name:
    if (auto v = lookup(n.name))
      return *v;
    throw std::runtime_error("Unknown field '" + n.name + "'");
  case Kind::Neg:
    return -a();
  case Kind::Not:
    return a() == 0;
  case Kind::Add:
    return a() + b();
  case Kind::Sub:
    return a() - b();
  case Kind::Mul:
    return a() * b();
  case Kind::Div:
    return a() / b();
  case Kind::Mod:
    return std::fmod(a(), b());
  case Kind::Lt:
    return a() < b();
  case Kind::Le:
    return a() <= b();
  case Kind::Gt:
    return a() > b();
  case Kind::Ge:
    return a() >= b();
  case Kind::Eq:
    return a() == b();
  case Kind::Ne:
    return a() != b();
  case Kind::And:
    return a() != 0 && b() != 0;
  case Kind::Or:
    return a() != 0 || b() != 0;
  case Kind::Min:
    return std::min(a(), b());
  case Kind::Max:
    return std::max(a(), b());
  case Kind::Abs:
    return std::abs(a());
  }
  throw std::logic_error("Unknown expression node");
}
} // namespace firefly
