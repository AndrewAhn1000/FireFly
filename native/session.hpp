#pragma once
#include "graph.hpp"
#include <deque>
#include <mutex>
#include <string>
namespace firefly {
double monotonicMs();
std::string sha256(const std::string &value);
// The graph's published fields, then any tracked observations' (see tracked.hpp),
// less those left out of recordings (`excluded`, names); the tracked definitions
// and what's left out go into the identity too. Without either, the identity is
// the graph's alone.
Json observationSchema(const Graph &graph, const Json &trackedDefinitions = Json::array(),
                       const Json &trackedFields = Json::array(),
                       const Json &excluded = Json::array());
Json actionSchema(const Json &buttons);
class ActionTimeline {
public:
  void reset(double timestamp, const Json &buttons, bool focused);
  void append(double timestamp, const Json &buttons, bool focused);
  Json at(double timestamp) const;

private:
  struct Snapshot {
    double timestamp;
    Json buttons;
    bool focused;
  };
  std::deque<Snapshot> history_;
};
} // namespace firefly
