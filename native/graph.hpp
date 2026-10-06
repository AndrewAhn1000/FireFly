#pragma once
#include "expression.hpp"
#include "geometry.hpp"
#include <array>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <string>
#include <variant>
#include <vector>

namespace firefly {
using Json = nlohmann::json;
enum class Type { Number, Boolean, Vector, Image, Text, Shapes };
struct Image {
  cv::Mat pixels;
  cv::Point origin{};
};
struct Value {
  Type type;
  bool valid = false;
  std::string reason;
  std::variant<double, bool, std::array<double, 2>, Image, std::string, Shapes>
      data = 0.0;
};
struct Node {
  std::string id, op;
  std::vector<std::string> inputs;
  Json params;
  Type type;
};
// Immutable compiled DAG. Owns no capture/UI resources or persistent frame
// cache.
class Graph {
public:
  explicit Graph(const Json &definition);
  // displayOverride: if non-null, receives the pixels of the first published
  // BGRA Image (e.g. from a draw_contours node) so the runtime can show it
  // instead of the raw capture frame. With a preview node ID it instead
  // receives that node's value drawn over the frame, and the result gains a
  // "preview" entry holding the value in full.
  Json evaluate(const cv::Mat &bgra, double sourceTimestamp,
                cv::Mat *displayOverride = nullptr,
                const std::string &preview = {}) const;
  const Json &definition() const { return definition_; }
  Json schema() const;

private:
  Json definition_;
  std::vector<Node> ordered_;
  std::map<std::string, std::shared_ptr<const Expression>> expressions_;
};
std::string typeName(Type type);
} // namespace firefly
