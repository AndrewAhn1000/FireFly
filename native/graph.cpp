#include "graph.hpp"
#include "lua_node.hpp"
#include "ocr_node.hpp"
#include "onnx_node.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <functional>
#include <opencv2/imgproc.hpp>
#include <set>
#include <stdexcept>

namespace firefly {
namespace {
void require(bool ok, const std::string &why) {
  if (!ok)
    throw std::invalid_argument(why);
}
double number(const Json &p, const std::string &key) {
  require(p.contains(key) && p[key].is_number(),
          "Missing numeric parameter: " + key);
  auto v = p[key].get<double>();
  require(std::isfinite(v), "Nonfinite parameter: " + key);
  return v;
}
int integer(const Json &p, const std::string &key, int low, int high) {
  double v = number(p, key);
  require(v >= low && v <= high && v == std::floor(v),
          "Invalid integer parameter: " + key);
  return static_cast<int>(v);
}
std::string text(const Json &p, const std::string &key) {
  require(p.contains(key) && p[key].is_string(), "Missing string: " + key);
  auto s = p[key].get<std::string>();
  require(!s.empty() && s.size() <= 80, "String length must be 1..80: " + key);
  return s;
}
// Optional parameters: validated when present, otherwise the fallback
int integer(const Json &p, const std::string &key, int low, int high,
            int fallback) {
  return p.contains(key) ? integer(p, key, low, high) : fallback;
}
double number(const Json &p, const std::string &key, double low, double high,
              double fallback) {
  if (!p.contains(key))
    return fallback;
  double v = number(p, key);
  require(v >= low && v <= high, key + " is out of range");
  return v;
}
// One of options; the first is the default
std::string choice(const Json &p, const std::string &key,
                   std::initializer_list<const char *> options) {
  if (!p.contains(key))
    return *options.begin();
  auto v = text(p, key);
  std::string all;
  for (auto o : options) {
    if (v == o)
      return v;
    all += all.empty() ? o : std::string(", ") + o;
  }
  throw std::invalid_argument(key + " must be one of: " + all);
}
Axis axis(const Json &p) {
  return choice(p, "direction", {"vertical", "horizontal"}) == "vertical"
             ? Axis::Vertical
             : Axis::Horizontal;
}
// "#rrggbb" parameter as an opaque BGRA colour
cv::Scalar color(const Json &p, const std::string &key,
                 const std::string &fallback) {
  auto hex = p.contains(key) ? text(p, key) : fallback;
  require(hex.size() == 7 && hex[0] == '#' &&
              std::all_of(hex.begin() + 1, hex.end(),
                          [](unsigned char c) { return std::isxdigit(c); }),
          key + " must be a #rrggbb colour");
  int v = std::stoi(hex.substr(1), nullptr, 16);
  return cv::Scalar(v & 255, (v >> 8) & 255, (v >> 16) & 255, 255);
}
std::string label(const Json &p) {
  if (!p.contains("label"))
    return "";
  require(p["label"].is_string() && p["label"].get<std::string>().size() <= 8,
          "label must be text of up to 8 characters");
  return p["label"].get<std::string>();
}
bool identifier(const std::string &s) {
  return !s.empty() && !std::isdigit((unsigned char)s[0]) &&
         std::all_of(s.begin(), s.end(), [](unsigned char c) {
           return std::isalnum(c) || c == '_';
         });
}
TraceOptions traceOptions(const Json &p) {
  TraceOptions o;
  o.position = number(p, "position", 0, 1, o.position);
  o.maxStep = integer(p, "maxStep", 1, 1000, o.maxStep);
  o.maxGap = integer(p, "maxGap", 0, 1000, o.maxGap);
  o.stack = number(p, "stack", 0, 100, o.stack);
  o.maxBand = integer(p, "maxBand", 0, 65535, o.maxBand);
  return o;
}
// The numbers in a text, in order: 1,234.5 is one number and 81/91 is two. A minus counts
// when it starts the text or follows a space or a bracket, so 81-91 is two positive numbers.
std::vector<double> numbersIn(const std::string &s) {
  std::vector<double> found;
  const auto digit = [&](size_t i) {
    return i < s.size() && std::isdigit((unsigned char)s[i]);
  };
  for (size_t i = 0; i < s.size();) {
    const size_t start = i;
    bool negative = false;
    if (s[i] == '-' && digit(i + 1) &&
        (i == 0 || std::isspace((unsigned char)s[i - 1]) || s[i - 1] == '(')) {
      negative = true;
      ++i;
    }
    if (!digit(i) && !(s[i] == '.' && digit(i + 1))) {
      i = start + 1;
      continue;
    }
    std::string token;
    while (i < s.size()) {
      if (digit(i))
        token += s[i++];
      else if (s[i] == ',' && digit(i + 1) && digit(i + 2) && digit(i + 3) &&
               !digit(i + 4))
        ++i; // a thousands separator, as in 1,234
      else
        break;
    }
    if (i < s.size() && s[i] == '.' && digit(i + 1)) {
      token += s[i++];
      while (digit(i))
        token += s[i++];
    }
    try {
      found.push_back((negative ? -1 : 1) * std::stod(token));
    } catch (const std::exception &) {
      // too long to be a number: left out
    }
  }
  return found;
}
bool binaryNumber(const std::string &op) {
  return op == "add" || op == "subtract" || op == "multiply" ||
         op == "divide" || op == "greater";
}
Value invalid(Type t, const std::string &reason) {
  return {t, false, reason, 0.0};
}
Value valid(Type t, decltype(Value::data) data) {
  return {t, true, "", std::move(data)};
}
// Shapes list at most limit items; 0 gives just their count
Json serialized(const Value &v, size_t limit = 0) {
  Json out = {{"type", typeName(v.type)}, {"valid", v.valid}};
  if (!v.valid) {
    out["reason"] = v.reason;
    out["value"] = nullptr;
    return out;
  }
  if (v.type == Type::Number)
    out["value"] = std::get<double>(v.data);
  else if (v.type == Type::Boolean)
    out["value"] = std::get<bool>(v.data);
  else if (v.type == Type::Vector)
    out["value"] = std::get<std::array<double, 2>>(v.data);
  else if (v.type == Type::Text)
    out["value"] = std::get<std::string>(v.data);
  else if (v.type == Type::Shapes) {
    auto &shapes = std::get<Shapes>(v.data);
    out["count"] = shapes.items.size();
    out["value"] = limit ? shapesJson(shapes, limit) : Json(nullptr);
  } else {
    auto &image = std::get<Image>(v.data);
    out["value"] = {{"width", image.pixels.cols},
                    {"height", image.pixels.rows},
                    {"channels", image.pixels.channels()},
                    {"origin", {image.origin.x, image.origin.y}}};
  }
  return out;
}
// A node's value drawn over the frame: masks tinted, shapes outlined with
// their index, other values printed.
cv::Mat previewImage(const cv::Mat &frame, const Value &v) {
  cv::Mat out = frame.clone();
  if (!v.valid)
    return out;
  if (v.type == Type::Image) {
    auto &image = std::get<Image>(v.data);
    if (image.pixels.channels() == 4 && image.pixels.size() == frame.size())
      return image.pixels.clone();
    cv::Rect area = cv::Rect(image.origin, image.pixels.size()) &
                    cv::Rect(0, 0, frame.cols, frame.rows);
    if (image.pixels.channels() == 1 && !area.empty()) {
      cv::Mat tinted = out.clone();
      tinted(area).setTo(cv::Scalar(255, 0, 255, 255),
                         image.pixels(area - image.origin));
      cv::addWeighted(out, 0.35, tinted, 0.65, 0, out);
    }
  } else if (v.type == Type::Shapes) {
    auto &shapes = std::get<Shapes>(v.data);
    drawShapes(out, shapes, shapes.origin, cv::Scalar(255, 229, 0, 255), 2,
               "#", false);
  } else {
    auto text = "= " + serialized(v)["value"].dump(-1, ' ', false, Json::error_handler_t::replace);
    cv::putText(out, text, {12, 32}, cv::FONT_HERSHEY_SIMPLEX, 0.8,
                cv::Scalar(0, 0, 0, 255), 4, cv::LINE_AA);
    cv::putText(out, text, {12, 32}, cv::FONT_HERSHEY_SIMPLEX, 0.8,
                cv::Scalar(255, 229, 0, 255), 2, cv::LINE_AA);
  }
  return out;
}
} // namespace
std::string typeName(Type type) {
  switch (type) {
  case Type::Number:
    return "number";
  case Type::Boolean:
    return "boolean";
  case Type::Vector:
    return "vector";
  case Type::Image:
    return "image";
  case Type::Text:
    return "text";
  case Type::Shapes:
    return "shapes";
  }
  throw std::logic_error("Unknown type");
}
Graph::Graph(const Json &definition) : definition_(definition) {
  require(definition.is_object(), "Graph must be an object");
  require(definition.value("version", 0) == 1,
          "Unsupported graph format version");
  text(definition, "id");
  integer(definition, "revision", 1, 1000000000);
  require(definition.contains("nodes") && definition["nodes"].is_array(),
          "nodes must be an array");
  // Room for several models running at once, each with its flow, beside the regions' values
  require(!definition["nodes"].empty() && definition["nodes"].size() <= 256,
          "Graph requires 1..256 nodes");
  require(definition.dump().size() <= 256000, "Graph exceeds 256 KB limit");
  std::map<std::string, Json> nodes;
  for (auto &n : definition["nodes"]) {
    auto id = text(n, "id");
    require(!nodes.contains(id), "Duplicate node ID: " + id);
    nodes[id] = n;
  }
  std::map<std::string, int> marks;
  std::map<std::string, Type> types;
  std::set<std::string> names;
  std::function<void(const std::string &)> visit = [&](const std::string &id) {
    require(nodes.contains(id), "Missing input node: " + id);
    require(marks[id] != 1, "Graph contains a cycle at " + id);
    if (marks[id] == 2)
      return;
    marks[id] = 1;
    auto &raw = nodes.at(id);
    Node n;
    n.id = id;
    n.op = text(raw, "op");
    n.params = raw.value("params", Json::object());
    require(n.params.is_object(), id + ": params must be an object");
    require(raw.contains("inputs") && raw["inputs"].is_array(),
            id + ": inputs must be an array");
    n.inputs = raw["inputs"].get<std::vector<std::string>>();
    require(n.inputs.size() <= 2, id + ": too many inputs");
    for (auto &input : n.inputs)
      visit(input);
    auto arity = [&](size_t low, size_t high = 0) {
      require(n.inputs.size() >= low && n.inputs.size() <= std::max(low, high),
              id + ": wrong input count");
    };
    auto expect = [&](size_t index, Type type) {
      require(types.at(n.inputs.at(index)) == type,
              id + ": expected " + typeName(type) + " at input " +
                  std::to_string(index));
    };
    auto &p = n.params;
    auto &op = n.op;
    try {
      if (op == "frame") {
        arity(0);
        n.type = Type::Image;
      } else if (op == "text") {
        arity(0);
        text(p, "value");
        n.type = Type::Text;
      } else if (op == "parse_number" || op == "text_contains") {
        arity(1);
        expect(0, Type::Text);
        n.type = op == "parse_number" ? Type::Number : Type::Boolean;
        if (op == "text_contains")
          text(p, "value");
      } else if (op == "number_in_text") {
        arity(1);
        expect(0, Type::Text);
        integer(p, "which", 1, 32, 1);
        n.type = Type::Number;
      } else if (op == "ocr") {
        arity(1);
        expect(0, Type::Image); // a colour image, or a mask of the text
        integer(p, "scale", 0, 8, 0);
        choice(p, "invert", {"auto", "off", "on"});
        choice(p, "accuracy", {"normal", "careful"});
        if (p.contains("language")) {
          auto language = text(p, "language");
          require(language == "auto" ||
                      (std::isalpha((unsigned char)language[0]) &&
                       language.size() <= 20 &&
                       std::all_of(language.begin(), language.end(),
                                   [](unsigned char c) {
                                     return std::isalnum(c) || c == '-';
                                   })),
                  "language must be auto or a tag such as en-US");
        }
        n.type = Type::Text;
      } else if (op == "lua") {
        arity(2);
        expect(0, Type::Number);
        expect(1, Type::Number);
        require(p.contains("code") && p["code"].is_string(),
                "Lua source missing");
        validateLua(p["code"].get<std::string>());
        n.type = Type::Number;
      } else if (op == "number") {
        arity(0);
        number(p, "value");
        n.type = Type::Number;
      } else if (op == "boolean") {
        arity(0);
        require(p.contains("value") && p["value"].is_boolean(),
                id + ": expected Boolean value");
        n.type = Type::Boolean;
      } else if (op == "vector") {
        arity(0);
        number(p, "x");
        number(p, "y");
        n.type = Type::Vector;
      } else if (op == "crop" || op == "grayscale" || op == "threshold" ||
                 op == "mean" || op == "coverage" || op == "centroid") {
        arity(1);
        expect(0, Type::Image);
        n.type = Type::Image;
        if (op == "crop") {
          if (choice(p, "unit", {"pixels", "fraction"}) == "fraction") {
            double x = number(p, "x"), y = number(p, "y"),
                   w = number(p, "width"), h = number(p, "height");
            require(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 + 1e-9 &&
                        y + h <= 1 + 1e-9,
                    id + ": a fractional crop must lie within the frame (0 to 1)");
          } else {
            integer(p, "x", 0, 32768);
            integer(p, "y", 0, 32768);
            integer(p, "width", 1, 32768);
            integer(p, "height", 1, 32768);
          }
        }
        if (op == "threshold")
          for (auto c : {"r", "g", "b"}) {
            auto low = integer(p, std::string(c) + "Min", 0, 255);
            auto high = integer(p, std::string(c) + "Max", 0, 255);
            require(low <= high, id + ": threshold minimum exceeds maximum");
          }
        if (op == "mean" || op == "coverage")
          n.type = Type::Number;
        if (op == "centroid")
          n.type = Type::Vector;
      } else if (op == "segment") {
        arity(1);
        expect(0, Type::Image);
        require(p.contains("model") && p["model"].is_string() &&
                    !p["model"].get<std::string>().empty(),
                id + ": segment requires a non-empty model path");
        auto provider = p.value("provider", std::string("cpu"));
        require(provider == "cpu" || provider == "directml", id + ": unknown inference provider");
        if (p.contains("device")) integer(p, "device", 0, 128);
        if (p.contains("threshold")) {
          double t = number(p, "threshold");
          require(t >= 0.0 && t <= 1.0, id + ": threshold must be in [0, 1]");
        }
        n.type = Type::Image;
      } else if (op == "detect") {
        // A YOLO detector: the frame in, its boxes out
        arity(1);
        expect(0, Type::Image);
        require(p.contains("model") && p["model"].is_string() && !p["model"].get<std::string>().empty(),
                id + ": detect requires a non-empty model path");
        auto provider = p.value("provider", std::string("cpu"));
        require(provider == "cpu" || provider == "directml", id + ": unknown inference provider");
        if (p.contains("device")) integer(p, "device", 0, 128);
        for (const char *key : {"confidence", "iou"})
          if (p.contains(key)) {
            double v = number(p, key);
            require(v >= 0.0 && v <= 1.0, id + ": " + key + " must be in [0, 1]");
          }
        n.type = Type::Shapes;
      } else if (op == "draw_contours") {
        arity(2);
        expect(0, Type::Image); // BGRA color frame
        expect(1, Type::Image); // single-channel mask
        for (auto c : {"r", "g", "b"})
          if (p.contains(c)) integer(p, c, 0, 255);
        if (p.contains("thickness")) integer(p, "thickness", 1, 32);
        n.type = Type::Image;
        // Geometry: masks → shapes → measurements. Masks are one-channel
        // images where nonzero pixels are foreground.
      } else if (op == "morph") {
        arity(1);
        expect(0, Type::Image);
        choice(p, "operation", {"close", "open", "dilate", "erode"});
        integer(p, "width", 1, 255, 3);
        integer(p, "height", 1, 255, 3);
        n.type = Type::Image;
      } else if (op == "runs" || op == "run_length") {
        arity(1);
        expect(0, Type::Image);
        axis(p);
        integer(p, "min", 1, 65535, 1);
        integer(p, "max", 0, 65535, 0);
        n.type = op == "runs" ? Type::Image : Type::Number;
      } else if (op == "combine") {
        arity(2);
        expect(0, Type::Image);
        expect(1, Type::Image);
        choice(p, "operation", {"subtract", "intersect", "union"});
        n.type = Type::Image;
      } else if (op == "components") {
        arity(1);
        expect(0, Type::Image);
        int connectivity = integer(p, "connectivity", 4, 8, 8);
        require(connectivity == 4 || connectivity == 8,
                "connectivity must be 4 or 8");
        integer(p, "minArea", 1, 1 << 30, 1);
        n.type = Type::Shapes;
      } else if (op == "trace") {
        arity(1, 2);
        expect(0, Type::Image);
        if (n.inputs.size() == 2)
          expect(1, Type::Number); // typical band height
        traceOptions(p);
        n.type = Type::Shapes;
      } else if (op == "filter") {
        arity(1, 2);
        expect(0, Type::Shapes);
        if (n.inputs.size() == 2)
          expect(1, Type::Number);
        require(p.contains("expression") && p["expression"].is_string(),
                "filter needs an expression");
        if (p.contains("variable"))
          require(identifier(text(p, "variable")),
                  "variable must be a name like band");
        expressions_[id] =
            std::make_shared<Expression>(p["expression"].get<std::string>());
        n.type = Type::Shapes;
      } else if (op == "join") {
        arity(1, 2);
        expect(0, Type::Shapes);
        if (n.inputs.size() == 2)
          expect(1, Type::Image); // only join across gaps this mask covers
        integer(p, "maxGap", 1, 65535, 80);
        number(p, "maxRise", 0, 1e6, 20);
        n.type = Type::Shapes;
      } else if (op == "simplify") {
        arity(1);
        expect(0, Type::Shapes);
        integer(p, "smooth", 0, 1000, 0);
        number(p, "epsilon", 0, 1000, 2);
        n.type = Type::Shapes;
      } else if (op == "segments") {
        arity(1);
        expect(0, Type::Shapes);
        integer(p, "rowHeight", 1, 10000, 16);
        n.type = Type::Shapes;
      } else if (op == "axis_line") {
        arity(1);
        expect(0, Type::Shapes);
        axis(p);
        n.type = Type::Shapes;
      } else if (op == "snap") {
        arity(2);
        expect(0, Type::Shapes);
        expect(1, Type::Shapes);
        number(p, "tolerance", 0, 1e6, 20);
        number(p, "reach", 0, 1e6, 0);
        n.type = Type::Shapes;
      } else if (op == "rasterize") {
        arity(1);
        expect(0, Type::Shapes);
        integer(p, "thickness", 1, 64, 1);
        n.type = Type::Image;
      } else if (op == "count") {
        arity(1);
        expect(0, Type::Shapes);
        n.type = Type::Number;
      } else if (op == "reach") {
        arity(1);
        expect(0, Type::Image);
        choice(p, "from", {"left", "right", "top", "bottom"});
        n.type = Type::Number;
      } else if (op == "calculate") {
        arity(1, 2);
        expect(0, Type::Number);
        if (n.inputs.size() == 2)
          expect(1, Type::Number);
        require(p.contains("expression") && p["expression"].is_string(),
                "calculate needs an expression");
        if (p.contains("variable"))
          require(identifier(text(p, "variable")),
                  "variable must be a name like max");
        expressions_[id] =
            std::make_shared<Expression>(p["expression"].get<std::string>());
        n.type = Type::Number;
      } else if (op == "draw_shapes") {
        arity(2);
        expect(0, Type::Image); // BGRA color frame
        expect(1, Type::Shapes);
        color(p, "color", "#00ff00");
        integer(p, "thickness", 1, 32, 2);
        label(p);
        choice(p, "style", {"auto", "box"});
        n.type = Type::Image;
      } else if (binaryNumber(op)) {
        arity(2);
        expect(0, Type::Number);
        expect(1, Type::Number);
        n.type = op == "greater" ? Type::Boolean : Type::Number;
      } else if (op == "clamp" || op == "normalize") {
        arity(1);
        expect(0, Type::Number);
        auto low = number(p, "min"), high = number(p, "max");
        require(low < high, id + ": min must be below max");
        n.type = Type::Number;
      } else if (op == "component") {
        arity(1);
        expect(0, Type::Vector);
        integer(p, "index", 0, 1);
        n.type = Type::Number;
      } else if (op == "distance") {
        arity(2);
        expect(0, Type::Vector);
        expect(1, Type::Vector);
        n.type = Type::Number;
      } else if (op == "and" || op == "or" || op == "not") {
        arity(op == "not" ? 1 : 2);
        for (size_t i = 0; i < n.inputs.size(); ++i)
          expect(i, Type::Boolean);
        n.type = Type::Boolean;
      } else if (op == "publish") {
        arity(1);
        auto name = text(p, "name");
        require(names.insert(name).second,
                "Duplicate observation name: " + name);
        n.type = types.at(n.inputs[0]);
        require(names.size() <= 16, "At most 16 published observations");
      } else
        throw std::invalid_argument("unknown node operation: " + op);
    } catch (const std::invalid_argument &e) {
      // Name the node so editors can point at the step
      std::string why = e.what();
      throw std::invalid_argument(why.starts_with(id + ":") ? why
                                                            : id + ": " + why);
    }
    marks[id] = 2;
    types[id] = n.type;
    ordered_.push_back(std::move(n));
  };
  for (auto &[id, raw] : nodes)
    visit(id);
  require(!names.empty(), "Graph must publish at least one observation");
}
Json Graph::schema() const {
  Json fields = Json::array();
  for (auto &n : ordered_)
    if (n.op == "publish") {
      Json field = {{"name", n.params["name"]}, {"type", typeName(n.type)}};
      if (n.type == Type::Vector)
        field["size"] = 2;
      fields.push_back(field);
    }
  return {{"id", definition_["id"]},
          {"version", definition_["revision"]},
          {"fields", fields}};
}
Json Graph::evaluate(const cv::Mat &bgra, double sourceTimestamp,
                     cv::Mat *displayOverride,
                     const std::string &preview) const {
  require(std::isfinite(sourceTimestamp) && sourceTimestamp >= 0,
          "Invalid source timestamp");
  const bool frameValid = !bgra.empty() && bgra.type() == CV_8UC4 &&
                          bgra.total() <= 16 * 1024 * 1024;
  std::map<std::string, Value> values;
  Json observations = Json::array(), debug = Json::object();
  for (auto &n : ordered_) {
    auto value = invalid(n.type, "Unavailable");
    std::vector<const Value *> inputs;
    bool ready = true;
    for (auto &id : n.inputs) {
      inputs.push_back(&values.at(id));
      if (!inputs.back()->valid)
        ready = false;
    }
    if (!ready)
      value = invalid(n.type, "Upstream input invalid");
    else
      try {
        auto a = [&](size_t i) { return std::get<double>(inputs.at(i)->data); };
        auto b = [&](size_t i) { return std::get<bool>(inputs.at(i)->data); };
        auto shapes = [&](size_t i) -> const Shapes & {
          return std::get<Shapes>(inputs.at(i)->data);
        };
        auto mask = [&](size_t i) -> const Image & {
          auto &image = std::get<Image>(inputs.at(i)->data);
          if (image.pixels.channels() != 1)
            throw std::runtime_error("Expects a one-channel mask");
          return image;
        };
        auto &op = n.op;
        auto &p = n.params;
        if (op == "frame")
          value = frameValid ? valid(n.type, Image{bgra, {0, 0}})
                             : invalid(n.type, "Frame must be nonempty BGRA8");
        else if (op == "text")
          value = valid(n.type, p["value"].get<std::string>());
        else if (op == "parse_number") {
          auto input = std::get<std::string>(inputs[0]->data);
          size_t used = 0;
          double parsed = std::stod(input, &used);
          if (used != input.size() || !std::isfinite(parsed))
            throw std::runtime_error("Text is not a finite number");
          value = valid(n.type, parsed);
        } else if (op == "text_contains")
          value = valid(n.type, std::get<std::string>(inputs[0]->data)
                                        .find(p["value"].get<std::string>()) !=
                                    std::string::npos);
        else if (op == "number_in_text") {
          auto numbers = numbersIn(std::get<std::string>(inputs[0]->data));
          const size_t which = (size_t)p.value("which", 1);
          if (numbers.empty())
            throw std::runtime_error("There is no number in the text");
          if (which > numbers.size())
            throw std::runtime_error("The text has only " +
                                     std::to_string(numbers.size()) +
                                     (numbers.size() == 1 ? " number" : " numbers"));
          value = valid(n.type, numbers[which - 1]);
        } else if (op == "ocr") {
          OcrOptions options;
          options.language = p.value("language", std::string("auto"));
          options.scale = p.value("scale", 0);
          options.invert = p.value("invert", std::string("auto"));
          options.accuracy = p.value("accuracy", std::string("normal"));
          value = valid(n.type, readText(n.id, std::get<Image>(inputs[0]->data).pixels, options));
        } else if (op == "number")
          value = valid(n.type, p["value"].get<double>());
        else if (op == "boolean")
          value = valid(n.type, p["value"].get<bool>());
        else if (op == "vector")
          value = valid(n.type, std::array<double, 2>{p["x"], p["y"]});
        else if (op == "publish") {
          value = *inputs[0];
          // Capture the first published BGRA image as the display override
          if (displayOverride && displayOverride->empty() && value.valid &&
              value.type == Type::Image) {
            auto &img = std::get<Image>(value.data);
            if (img.pixels.channels() == 4 && !img.pixels.empty())
              *displayOverride = img.pixels;
          }
        }
        else if (op == "crop" || op == "grayscale" || op == "threshold" ||
                 op == "mean" || op == "coverage" || op == "centroid") {
          auto image = std::get<Image>(inputs[0]->data);
          cv::Mat result;
          if (op == "crop") {
            int x, y, w, h;
            if (choice(p, "unit", {"pixels", "fraction"}) == "fraction") {
              // Relative to the frame, so a region reads the same part of it at any window size
              const int cols = image.pixels.cols, rows = image.pixels.rows;
              x = std::clamp((int)std::lround(p["x"].get<double>() * cols), 0, cols - 1);
              y = std::clamp((int)std::lround(p["y"].get<double>() * rows), 0, rows - 1);
              w = std::clamp((int)std::lround(p["width"].get<double>() * cols), 1, cols - x);
              h = std::clamp((int)std::lround(p["height"].get<double>() * rows), 1, rows - y);
            } else {
              x = p["x"], y = p["y"], w = p["width"], h = p["height"];
            }
            if (x + w > image.pixels.cols || y + h > image.pixels.rows)
              value = invalid(n.type, "Crop exceeds current source dimensions; "
                                      "adjust it after resizing");
            else
              value = valid(n.type, Image{image.pixels(cv::Rect(x, y, w, h)),
                                          image.origin + cv::Point(x, y)});
          } else if (op == "grayscale" || op == "mean") {
            if (image.pixels.channels() == 1)
              result = image.pixels;
            else
              cv::cvtColor(image.pixels, result, cv::COLOR_BGRA2GRAY);
            value = op == "mean" ? valid(n.type, cv::mean(result)[0] / 255.0)
                                 : valid(n.type, Image{result, image.origin});
          } else if (op == "threshold") {
            if (image.pixels.channels() != 4)
              value = invalid(n.type, "RGB threshold requires a color image");
            else {
              cv::inRange(image.pixels,
                          cv::Scalar(p["bMin"].get<int>(), p["gMin"].get<int>(),
                                     p["rMin"].get<int>(), 0),
                          cv::Scalar(p["bMax"].get<int>(), p["gMax"].get<int>(),
                                     p["rMax"].get<int>(), 255),
                          result);
              value = valid(n.type, Image{result, image.origin});
            }
          } else if (image.pixels.channels() != 1)
            value = invalid(
                n.type,
                "Measurement requires a one-channel mask or grayscale image");
          else if (op == "coverage")
            value = valid(n.type,
                          static_cast<double>(cv::countNonZero(image.pixels)) /
                              image.pixels.total());
          else {
            auto moments = cv::moments(image.pixels, true);
            if (moments.m00 == 0)
              value = invalid(n.type, "No nonzero pixels");
            else
              value = valid(n.type,
                            std::array<double, 2>{
                                moments.m10 / moments.m00 + image.origin.x,
                                moments.m01 / moments.m00 + image.origin.y});
          }
        } else if (op == "segment") {
          auto image = std::get<Image>(inputs[0]->data);
          float thr = (float)p.value("threshold", 0.5);
          cv::Mat mask =
              segmentOnnx(p["model"].get<std::string>(), image.pixels, thr,
                          p.value("provider", std::string("cpu")), p.value("device", 0));
          value = valid(n.type, Image{mask, image.origin});
        } else if (op == "detect") {
          auto image = std::get<Image>(inputs[0]->data);
          auto found = detectOnnx(p["model"].get<std::string>(), image.pixels, (float)p.value("confidence", 0.25),
                                  (float)p.value("iou", 0.7), p.value("provider", std::string("cpu")), p.value("device", 0));
          // Each box as a shape: its outline, a path round its corners back to the first (points are a path, drawn
          // and measured open, so four corners alone left out the left side), and, in frame pixels, x y w h
          // (as a Lua State's boxes have them, which Format Dataset reads), width height cx cy area for filters,
          // and its confidence and class
          Shapes shapes{image.pixels.size(), image.origin, {}};
          for (const auto &d : found) {
            Shape s;
            const float x = std::round(d.box.x), y = std::round(d.box.y);
            const float w = std::max(1.0f, std::round(d.box.width)), h = std::max(1.0f, std::round(d.box.height));
            s.points = {{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}, {x, y}};
            s.box = cv::Rect((int)x, (int)y, (int)w, (int)h);
            const double X = x + image.origin.x, Y = y + image.origin.y;
            s.props = {{"x", X}, {"y", Y}, {"w", w}, {"h", h}, {"width", w}, {"height", h}, {"cx", X + w / 2},
                       {"cy", Y + h / 2}, {"area", (double)w * h}, {"confidence", std::round(d.confidence * 1000) / 1000},
                       {"class", (double)d.cls}};
            shapes.items.push_back(std::move(s));
          }
          value = valid(n.type, std::move(shapes));
        } else if (op == "draw_contours") {
          auto frame = std::get<Image>(inputs[0]->data);
          auto mask  = std::get<Image>(inputs[1]->data);
          cv::Mat mask1;
          if (mask.pixels.channels() == 1)
            mask1 = mask.pixels;
          else
            cv::cvtColor(mask.pixels, mask1, cv::COLOR_BGRA2GRAY);
          if (mask1.size() != frame.pixels.size())
            cv::resize(mask1, mask1, frame.pixels.size(), 0, 0,
                       cv::INTER_NEAREST);
          std::vector<std::vector<cv::Point>> contours;
          cv::findContours(mask1, contours, cv::RETR_EXTERNAL,
                           cv::CHAIN_APPROX_SIMPLE);
          cv::Mat annotated = frame.pixels.clone();
          int r = p.value("r", 0), g = p.value("g", 255), b = p.value("b", 0);
          int thickness = p.value("thickness", 2);
          cv::drawContours(annotated, contours, -1,
                           cv::Scalar(b, g, r, 255), thickness);
          value = valid(n.type, Image{annotated, frame.origin});
        } else if (op == "morph") {
          auto &image = std::get<Image>(inputs[0]->data);
          auto operation = choice(p, "operation", {"close", "open", "dilate", "erode"});
          int kind = operation == "close"  ? cv::MORPH_CLOSE
                     : operation == "open" ? cv::MORPH_OPEN
                     : operation == "dilate" ? cv::MORPH_DILATE
                                             : cv::MORPH_ERODE;
          cv::Mat result;
          cv::morphologyEx(image.pixels, result, kind,
                           cv::getStructuringElement(
                               cv::MORPH_RECT, {integer(p, "width", 1, 255, 3),
                                                integer(p, "height", 1, 255, 3)}));
          value = valid(n.type, Image{result, image.origin});
        } else if (op == "runs") {
          auto &image = mask(0);
          value = valid(n.type, Image{keepRuns(image.pixels, axis(p),
                                               integer(p, "min", 1, 65535, 1),
                                               integer(p, "max", 0, 65535, 0)),
                                      image.origin});
        } else if (op == "run_length") {
          value = valid(n.type, runLength(mask(0).pixels, axis(p),
                                          integer(p, "max", 0, 65535, 0)));
        } else if (op == "combine") {
          auto &x = mask(0), &y = mask(1);
          if (x.pixels.size() != y.pixels.size() || x.origin != y.origin)
            throw std::runtime_error("Masks differ in size or position");
          auto operation = choice(p, "operation", {"subtract", "intersect", "union"});
          cv::Mat result, first = x.pixels > 0, second = y.pixels > 0;
          if (operation == "subtract")
            result = first & ~second;
          else if (operation == "intersect")
            result = first & second;
          else
            result = first | second;
          value = valid(n.type, Image{result, x.origin});
        } else if (op == "components") {
          auto &image = mask(0);
          value = valid(n.type, regions(image.pixels,
                                        integer(p, "connectivity", 4, 8, 8),
                                        integer(p, "minArea", 1, 1 << 30, 1),
                                        image.origin));
        } else if (op == "trace") {
          auto &image = mask(0);
          double typical = inputs.size() > 1
                               ? a(1)
                               : runLength(image.pixels, Axis::Vertical, 0);
          value = valid(n.type, traceBands(image.pixels, typical,
                                           traceOptions(p), image.origin));
        } else if (op == "filter") {
          auto &input = shapes(0);
          auto &expression = *expressions_.at(n.id);
          std::string variable = p.value("variable", std::string("value"));
          Shapes kept{input.size, input.origin, {}};
          for (auto &s : input.items) {
            auto lookup = [&](const std::string &name) -> std::optional<double> {
              if (inputs.size() > 1 && name == variable)
                return a(1);
              if (auto it = s.props.find(name); it != s.props.end())
                return it->second;
              if (name == "length")
                return polylineLength(s.points);
              if (name == "frameWidth" || name == "frameHeight")
                return name == "frameWidth" ? input.size.width : input.size.height;
              return std::nullopt;
            };
            try {
              if (expression.evaluate(lookup) != 0)
                kept.items.push_back(s);
            } catch (const std::runtime_error &e) {
              std::string fields;
              for (auto &[key, v] : s.props)
                fields += (fields.empty() ? "" : ", ") + key;
              throw std::runtime_error(std::string(e.what()) + "; shapes have: " +
                                       (fields.empty() ? "length" : fields + ", length"));
            }
          }
          value = valid(n.type, std::move(kept));
        } else if (op == "join") {
          auto &input = shapes(0);
          const cv::Mat *cover = nullptr;
          if (inputs.size() > 1) {
            auto &m = mask(1);
            if (m.pixels.size() != input.size || m.origin != input.origin)
              throw std::runtime_error("Mask differs in size or position from the shapes");
            cover = &m.pixels;
          }
          value = valid(n.type, joinGaps(input, cover, integer(p, "maxGap", 1, 65535, 80),
                                         number(p, "maxRise", 0, 1e6, 20)));
        } else if (op == "simplify") {
          value = valid(n.type, simplify(shapes(0), integer(p, "smooth", 0, 1000, 0),
                                         number(p, "epsilon", 0, 1000, 2)));
        } else if (op == "segments") {
          value = valid(n.type, toSegments(shapes(0), integer(p, "rowHeight", 1, 10000, 16)));
        } else if (op == "axis_line") {
          value = valid(n.type, axisLines(shapes(0), axis(p)));
        } else if (op == "snap") {
          value = valid(n.type, snapEnds(shapes(0), shapes(1),
                                         number(p, "tolerance", 0, 1e6, 20),
                                         number(p, "reach", 0, 1e6, 0)));
        } else if (op == "rasterize") {
          auto &input = shapes(0);
          value = valid(n.type, Image{rasterize(input, integer(p, "thickness", 1, 64, 1)),
                                      input.origin});
        } else if (op == "count") {
          value = valid(n.type, (double)shapes(0).items.size());
        } else if (op == "reach") {
          // How far the mask extends from an edge, as a share of the frame's
          // width or height: gaps inside it (such as digits on a bar) don't count
          const cv::Mat &m = mask(0).pixels;
          const std::string from = choice(p, "from", {"left", "right", "top", "bottom"});
          const bool across = from == "left" || from == "right";
          cv::Mat profile; // whether each column (or row) holds any of the mask
          cv::reduce(m, profile, across ? 0 : 1, cv::REDUCE_MAX, CV_8U);
          const int length = (int)profile.total();
          const uchar *has = profile.ptr<uchar>();
          int first = -1, last = -1;
          for (int i = 0; i < length; ++i)
            if (has[i]) {
              if (first < 0)
                first = i;
              last = i;
            }
          double reach = 0;
          if (first >= 0)
            reach = from == "left" || from == "top" ? (last + 1.0) / length
                                                    : (length - first) / (double)length;
          value = valid(n.type, reach);
        } else if (op == "calculate") {
          auto &expression = *expressions_.at(n.id);
          const std::string variable = p.value("variable", std::string("other"));
          auto lookup = [&](const std::string &name) -> std::optional<double> {
            if (name == "value")
              return a(0);
            if (inputs.size() > 1 && name == variable)
              return a(1);
            return std::nullopt;
          };
          double result;
          try {
            result = expression.evaluate(lookup);
          } catch (const std::runtime_error &e) {
            throw std::runtime_error(std::string(e.what()) + "; available: value" +
                                     (inputs.size() > 1 ? ", " + variable : ""));
          }
          if (!std::isfinite(result))
            throw std::runtime_error("Nonfinite calculation result");
          value = valid(n.type, result);
        } else if (op == "draw_shapes") {
          auto &frame = std::get<Image>(inputs[0]->data);
          auto &input = shapes(1);
          if (frame.pixels.channels() != 4)
            throw std::runtime_error("Draws onto a BGRA frame");
          cv::Mat annotated = frame.pixels.clone();
          drawShapes(annotated, input, input.origin - frame.origin,
                     color(p, "color", "#00ff00"), integer(p, "thickness", 1, 32, 2),
                     label(p), choice(p, "style", {"auto", "box"}) == "box");
          value = valid(n.type, Image{annotated, frame.origin});
        } else if (op == "greater")
          value = valid(n.type, a(0) > a(1));
        else if (op == "and")
          value = valid(n.type, b(0) && b(1));
        else if (op == "or")
          value = valid(n.type, b(0) || b(1));
        else if (op == "not")
          value = valid(n.type, !b(0));
        else {
          double result = 0;
          if (op == "add")
            result = a(0) + a(1);
          else if (op == "lua")
            result = evaluateLua(p["code"].get<std::string>(), a(0), a(1));
          else if (op == "subtract")
            result = a(0) - a(1);
          else if (op == "multiply")
            result = a(0) * a(1);
          else if (op == "divide") {
            if (a(1) == 0)
              throw std::runtime_error("Division by zero");
            result = a(0) / a(1);
          } else if (op == "clamp" || op == "normalize") {
            double low = p["min"], high = p["max"];
            result = std::clamp(a(0), low, high);
            if (op == "normalize")
              result = (result - low) / (high - low);
          } else if (op == "component") {
            result = std::get<std::array<double, 2>>(
                inputs[0]->data)[p["index"].get<int>()];
          } else if (op == "distance") {
            auto x = std::get<std::array<double, 2>>(inputs[0]->data),
                 y = std::get<std::array<double, 2>>(inputs[1]->data);
            result = std::hypot(x[0] - y[0], x[1] - y[1]);
          }
          if (!std::isfinite(result))
            throw std::runtime_error("Nonfinite calculation result");
          value = valid(n.type, result);
        }
      } catch (const std::exception &e) {
        value = invalid(n.type, e.what());
      }
    debug[n.id] = serialized(value);
    if (n.op == "publish") {
      auto observation = serialized(value, SIZE_MAX);
      observation["name"] = n.params["name"];
      observation["timestamp"] = sourceTimestamp;
      observation["schemaVersion"] = definition_["revision"];
      observations.push_back(observation);
    }
    values.emplace(n.id, std::move(value));
  }
  Json result = {{"schema", schema()},
                 {"timestamp", sourceTimestamp},
                 {"observations", observations},
                 {"nodes", debug}};
  if (auto it = values.find(preview); !preview.empty() && it != values.end()) {
    auto info = serialized(it->second, 200);
    if (it->second.valid && it->second.type == Type::Image) {
      auto &image = std::get<Image>(it->second.data);
      if (image.pixels.channels() == 1)
        info["coverage"] = (double)cv::countNonZero(image.pixels) / image.pixels.total();
    }
    info["node"] = preview;
    result["preview"] = info;
    if (displayOverride && frameValid)
      *displayOverride = previewImage(bgra, it->second);
  }
  return result;
}
} // namespace firefly
