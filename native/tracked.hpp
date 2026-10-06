#pragma once
#include "graph.hpp"
#include <deque>
#include <limits>
#include <optional>
#include <set>

namespace firefly {
// Observations read from what the tracker finds, recorded alongside the graph's:
// where a followed region's box is or how fast it moves (vectors, frame px and
// px per second), or whether chosen templates of it are detected (Boolean,
// settled like the app's template states). The app defines them from its States.
class TrackedObservations {
public:
  // [{name, region, value: "position" | "velocity" | "detected" | "matches",
  //   templates: [template ids] or null for any, settleMs}]
  void configure(const Json &definitions);
  const Json &definitions() const { return definitions_; }
  bool empty() const { return defs_.empty(); }
  Json fields() const; // as in an observation schema: [{name, type, size?}]
  // Takes a template.match event, every region's result in one frame
  void update(const Json &match);
  // Their values for the frame captured at `timestamp`: from the latest
  // tracking result at or before it, if it's no older than maxAgeMs. Matching
  // skips frames while it's busy, so that's often an earlier frame's: its values
  // are held, as the app shows them, and say how old they are (heldMs).
  Json at(double timestamp, double maxAgeMs = 1000) const;
  // The capture time of the newest tracking result, or -infinity before any
  double newest() const { return history_.empty() ? -std::numeric_limits<double>::infinity() : history_.back().first; }
  void reset(); // forgets results and settling, as when the capture changes

private:
  struct Definition {
    std::string name, region, value;
    std::optional<std::set<std::string>> templates;
    double settleMs = 250;
  };
  // A template state's settled answer: `next` has been seen since `since`
  struct Settled {
    std::optional<bool> value, next;
    double since = 0;
    std::optional<double> lostSince; // when the object stopped being found
  };
  std::vector<Definition> defs_;
  Json definitions_ = Json::array();
  std::vector<Settled> settled_;
  std::deque<std::pair<double, Json>> history_; // (capture ms, observations), newest last
};
} // namespace firefly
