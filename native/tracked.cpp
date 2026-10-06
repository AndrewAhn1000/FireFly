#include "tracked.hpp"
#include <cmath>
#include <stdexcept>

namespace firefly {
namespace {
constexpr double kKeepMs = 2000; // how long results are kept for samples that arrive late
constexpr double kLostHoldMs = 500; // how long a template state keeps its answer while the object isn't found (LOST_HOLD_MS in the app)

Json invalid(const std::string &name, const std::string &type, const std::string &reason) {
  return {{"name", name}, {"type", type}, {"valid", false}, {"value", nullptr}, {"reason", reason}};
}
Json valid(const std::string &name, const std::string &type, Json value) {
  return {{"name", name}, {"type", type}, {"valid", true}, {"value", std::move(value)}};
}
const char *typeOf(const std::string &value) {
  return value == "detected" ? "boolean" : value == "matches" ? "shapes" : "vector";
}
} // namespace

void TrackedObservations::configure(const Json &definitions) {
  if (!definitions.is_array() || definitions.size() > 64)
    throw std::runtime_error("Tracked observations must be a list of at most 64");
  std::vector<Definition> defs;
  std::set<std::string> names;
  for (const auto &d : definitions) {
    Definition def;
    def.name = d.at("name").get<std::string>();
    def.region = d.at("region").get<std::string>();
    def.value = d.at("value").get<std::string>();
    if (def.name.empty() || def.name.size() > 80 || !names.insert(def.name).second)
      throw std::runtime_error("Tracked observation names must be unique, 1..80 characters");
    if (def.value != "position" && def.value != "velocity" && def.value != "detected" && def.value != "matches")
      throw std::runtime_error("A tracked observation is a position, a velocity, detected templates or every match");
    if (d.contains("templates") && !d["templates"].is_null()) {
      def.templates.emplace();
      for (const auto &id : d["templates"]) def.templates->insert(id.get<std::string>());
    }
    def.settleMs = d.value("settleMs", 0.0);
    if (!std::isfinite(def.settleMs) || def.settleMs < 0 || def.settleMs > 10000)
      throw std::runtime_error("Settle time must be 0..10000 ms");
    defs.push_back(std::move(def));
  }
  defs_ = std::move(defs);
  definitions_ = definitions;
  reset();
}

Json TrackedObservations::fields() const {
  Json fields = Json::array();
  for (const auto &d : defs_) {
    Json field = {{"name", d.name}, {"type", typeOf(d.value)}};
    if (d.value == "position" || d.value == "velocity") field["size"] = 2;
    fields.push_back(field);
  }
  return fields;
}

void TrackedObservations::reset() {
  settled_.assign(defs_.size(), {});
  history_.clear();
}

void TrackedObservations::update(const Json &match) {
  if (defs_.empty() || !match.is_object() || !match.contains("timestamp")) return;
  const double t = match["timestamp"].get<double>();
  if (!history_.empty() && t <= history_.back().first) return;
  Json observations = Json::array();
  for (size_t i = 0; i < defs_.size(); ++i) {
    const auto &d = defs_[i];
    const std::string type = typeOf(d.value);
    const Json *entry = nullptr;
    if (match.contains("regions") && match["regions"].is_array())
      for (const auto &r : match["regions"])
        if (r.value("region", std::string()) == d.region) { entry = &r; break; }
    if (!entry) {
      settled_[i] = {};
      observations.push_back(invalid(d.name, type, "The region isn't following its object"));
      continue;
    }
    // Every match: where each instance is, as points at the centres of their boxes in frame px (with the
    // box's size, how well it matched and which template), so formulas can find the nearest or count
    // them. Multi-match gives every instance; following one object, its box while it's found. None is
    // an answer (an empty list), not a missing value.
    if (d.value == "matches") {
      const double W = match.value("width", 0.0), H = match.value("height", 0.0);
      Json points = Json::array();
      auto add = [&](const Json &m) {
        if (!m.contains("x") || !m.contains("w")) return;
        const auto id = m.value("templateId", std::string());
        if (d.templates && !id.empty() && !d.templates->contains(id)) return;
        const double x = m["x"].get<double>() * W, y = m["y"].get<double>() * H, w = m["w"].get<double>() * W, h = m["h"].get<double>() * H;
        points.push_back({{"x", x + w / 2}, {"y", y + h / 2}, {"w", w}, {"h", h},
                          {"confidence", m.value("confidence", 0.0)}, {"templateId", id}});
      };
      if (entry->contains("matches")) for (const auto &m : (*entry)["matches"]) add(m);
      else if (entry->value("found", false)) add(*entry);
      observations.push_back(valid(d.name, type, std::move(points)));
      continue;
    }
    if (d.value != "detected") {
      const auto &v = (*entry)[d.value];
      observations.push_back(v.is_array() && v.size() == 2
        ? valid(d.name, type, v) : invalid(d.name, type, "The object isn't found"));
      continue;
    }
    // Detected: one of the chosen templates won a place of its own (following one object) or an
    // instance (multi-match); by corners there are no templates to tell apart
    const Json *won = entry->contains("matches") ? &(*entry)["matches"]
      : entry->contains("detected") ? &(*entry)["detected"] : nullptr;
    auto &s = settled_[i];
    if (!won) {
      s = {};
      observations.push_back(invalid(d.name, type, "Following by corners has no templates to detect"));
      continue;
    }
    // Following one object, a frame it isn't found in keeps the answer for a while, as in the app:
    // not recognising it says nothing about which template it is. Multi-match finding none is an answer.
    const bool found = entry->contains("matches") || entry->value("found", true);
    if (!found && s.value) {
      if (!s.lostSince) s.lostSince = t;
      if (t - *s.lostSince < kLostHoldMs) { observations.push_back(valid(d.name, type, *s.value)); continue; }
    } else if (found) s.lostSince.reset();
    bool raw = false;
    for (const auto &m : *won) {
      const auto id = m.value("templateId", std::string());
      if (!id.empty() && (!d.templates || d.templates->contains(id))) { raw = true; break; }
    }
    // As the app's template states: a new answer is taken once it has held for the settle time
    if (!s.value || d.settleMs <= 0 || raw == *s.value) s = {raw, std::nullopt, 0};
    else if (s.next != raw) { s.next = raw; s.since = t; }
    else if (t - s.since >= d.settleMs) s = {raw, std::nullopt, 0};
    observations.push_back(valid(d.name, type, *s.value));
  }
  history_.emplace_back(t, std::move(observations));
  while (!history_.empty() && t - history_.front().first > kKeepMs) history_.pop_front();
}

Json TrackedObservations::at(double timestamp, double maxAgeMs) const {
  for (auto it = history_.rbegin(); it != history_.rend(); ++it)
    if (it->first <= timestamp) {
      const double age = timestamp - it->first;
      if (age > maxAgeMs) break;
      Json observations = it->second;
      if (age > 0)
        for (auto &o : observations) o["heldMs"] = std::round(age);
      return observations;
    }
  Json observations = Json::array();
  for (const auto &d : defs_)
    observations.push_back(invalid(d.name, typeOf(d.value), history_.empty() || history_.front().first > timestamp
      ? "No tracking result yet" : "No tracking result in the " + std::to_string(static_cast<int>(maxAgeMs)) + " ms before this frame"));
  return observations;
}
} // namespace firefly
