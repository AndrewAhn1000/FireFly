#include "tracking.hpp"
#include "template_fit.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <opencv2/imgproc.hpp>

namespace firefly {
namespace {
constexpr double kMotionMs = 100; // velocity is fitted to where the box was over this long
constexpr double kGapMs = 250;    // a longer gap without the object starts its path again
constexpr double kJump = 2;       // and so does a move of more than this many times the box's size
constexpr int kGrowFrom = 16;     // px: the least a search not finding its object grows from, so a reach of 0 grows too
constexpr int kCornerReach = 96;  // how far a corner is looked for near where it was when the whole frame is searched too
constexpr double kStick = 0.05;   // how much better another template has to match to take over the object from the one that won it

using Path = std::deque<std::pair<double, cv::Point2d>>;

// How fast the box's centre moved along its path, in px per second: the slope of a least-squares line
// through where it was, so a pixel of jitter hardly shows; unknown until the path spans a few frames
std::optional<cv::Point2d> pathVelocity(const Path &path) {
  if (path.size() < 2 || path.back().first - path.front().first < 20) return std::nullopt;
  double mt = 0, mx = 0, my = 0;
  for (auto &[at, p] : path) { mt += at; mx += p.x; my += p.y; }
  mt /= path.size(); mx /= path.size(); my /= path.size();
  double tt = 0, tx = 0, ty = 0;
  for (auto &[at, p] : path) { tt += (at - mt) * (at - mt); tx += (at - mt) * (p.x - mx); ty += (at - mt) * (p.y - my); }
  return cv::Point2d(tx / tt * 1000, ty / tt * 1000);
}

// Where the found box's centre is, in frame px, and how fast it moves, in px per second, fitted to where
// it was over the last kMotionMs.
// Both are null while the object isn't found, and velocity is also null until its path spans a few
// frames. A gap or a jump, as when the object is lost, the map changes or it teleports, starts the path
// again rather than counting as speed.
void addMotion(Json &result, Path &path, const CapturedFrame &frame) {
  result["position"] = nullptr;
  result["velocity"] = nullptr;
  if (!result.value("found", false) || !result.contains("w")) return;
  const double w = result["w"].get<double>() * frame.width, h = result["h"].get<double>() * frame.height;
  const cv::Point2d centre(result["x"].get<double>() * frame.width + w / 2, result["y"].get<double>() * frame.height + h / 2);
  const double t = frame.timestamp;
  result["position"] = {centre.x, centre.y};
  if (!path.empty() && (t - path.back().first > kGapMs || cv::norm(centre - path.back().second) > kJump * std::max(w, h)))
    path.clear();
  if (path.empty() || t > path.back().first) path.emplace_back(t, centre);
  while (path.size() > 2 && t - path.front().first > kMotionMs) path.pop_front();
  if (auto v = pathVelocity(path)) result["velocity"] = {v->x, v->y};
}
} // namespace

Json Tracker::follow(const Track &track, History &history, Pyramid &pyramid, const CapturedFrame &frame) {
  Json out;
  auto px = [&](cv::Point2d p) { return cv::Point((int)std::lround(p.x * frame.width), (int)std::lround(p.y * frame.height)); };
  // Limited to near where it was, the object is looked for within its reach first, and while it isn't
  // found there, twice as far, and twice as far again, in the same frame, until it's found or the whole
  // window has been searched. So an object anywhere in the window is found on the frame it's in (its
  // position is only missing when it isn't recognised anywhere), and nearest first: the box goes to the
  // object near where it was rather than to a lookalike further away. Only a frame the object isn't found
  // in at all costs a search of the whole window, a little more with the smaller searches before it.
  const bool near = track.reach >= 0 && !track.multi && (history.last || track.start);
  const int longest = std::max(frame.width, frame.height);
  // The searches of one frame, nearest first: the reach, then twice as far until it covers the window
  auto further = [&](int reach) { return std::max(reach, kGrowFrom) * 2; };
  // Where it's heading: how far its centre has moved since it was last found, at the speed it was moving
  // then, for up to kGapMs (after longer its path starts again). It's looked for there as well as where it
  // was, so an object faster than its reach between frames isn't lost, and one that stops is still found.
  cv::Point2d moved(0, 0);
  if (history.last && !history.path.empty())
    if (auto v = pathVelocity(history.path))
      moved = *v * (std::clamp(frame.timestamp - history.path.back().first, 0.0, kGapMs) / 1000);
  if (track.fitting()) {
    CornerSearch search;
    search.threshold = track.threshold;
    auto largest = px(track.largest); search.largest = cv::Size(largest.x, largest.y);
    if (history.last) search.was = history.last->tl();
    else if (track.start) search.was = px(track.start->tl());
    CornerFit fit;
    if (!near) { // within kCornerReach of where it was, and failing that anywhere
      search.reach = kCornerReach; search.anywhere = true;
      fit = fitCorners(pyramid, track.topLeft, track.bottomRight, search);
    } else
      for (int reach = track.reach;; reach = further(reach)) {
        search.reach = reach + (int)std::ceil(cv::norm(moved));
        search.anywhere = reach >= longest;
        fit = fitCorners(pyramid, track.topLeft, track.bottomRight, search);
        if (fit.found || search.anywhere) break;
      }
    if (fit.found) history.last = fit.box;
    out = {{"x", (double)fit.box.x / frame.width}, {"y", (double)fit.box.y / frame.height},
      {"w", (double)fit.box.width / frame.width}, {"h", (double)fit.box.height / frame.height},
      {"confidence", std::min(fit.topLeft, fit.bottomRight)}, {"found", fit.found}};
  } else {
    // One object is looked for as its best place anywhere, which is reported even when it scores under
    // the threshold, so the app can show how close it came; it's only found when it reaches it. Every
    // template's own best place is scored to pick it anyway, so which of them win a place of their own
    // comes for nothing: those are what the region's template states read.
    // Near where it was, a template is looked for where its centre is at most reach from the last box's,
    // or from where it was heading
    auto within = [&](int reach) -> std::function<cv::Rect(const Pattern &)> {
      const cv::Point2d c = history.last ? (cv::Point2d(history.last->tl()) + cv::Point2d(history.last->br())) / 2
        : cv::Point2d((track.start->x + track.start->width / 2) * frame.width, (track.start->y + track.start->height / 2) * frame.height);
      return [c, moved, reach](const Pattern &p) {
        auto around = [&](cv::Point2d at) {
          return cv::Rect((int)std::lround(at.x - p.image.cols / 2.0) - reach, (int)std::lround(at.y - p.image.rows / 2.0) - reach,
                          p.image.cols + 2 * reach, p.image.rows + 2 * reach);
        };
        return around(c) | around(c + moved);
      };
    };
    // Two poses that match about as well would otherwise swap from frame to frame: the one found last
    // time keeps the object unless another matches it clearly better
    std::vector<TemplateHit> hits;
    if (track.multi) hits = matchTemplates(pyramid, track.templates, track.threshold, 50);
    else
      for (int reach = track.reach;; reach = further(reach)) {
        const bool whole = !near || reach >= longest;
        hits = matchTemplates(pyramid, track.templates, 0, (int)track.templates.size(), 1,
                              whole ? std::function<cv::Rect(const Pattern &)>() : within(reach),
                              {history.winner, kStick, track.threshold});
        if (whole || (!hits.empty() && hits.front().confidence >= track.threshold)) break;
      }
    auto encode = [&](const TemplateHit &hit) {
      return Json{{"x", (double)hit.box.x / frame.width}, {"y", (double)hit.box.y / frame.height},
        {"w", (double)hit.box.width / frame.width}, {"h", (double)hit.box.height / frame.height},
        {"confidence", hit.confidence}, {"templateId", hit.templateId}};
    };
    out = hits.empty() ? Json{{"confidence", 0}} : encode(hits.front());
    const bool found = !hits.empty() && hits.front().confidence >= track.threshold;
    out["found"] = found;
    if (found) { history.last = hits.front().box; history.winner = hits.front().templateId; }
    if (!track.multi) {
      out["detected"] = Json::array();
      for (auto &hit : hits)
        if (hit.confidence >= track.threshold) out["detected"].push_back(encode(hit));
    }
    if (track.multi) {
      out["matches"] = Json::array();
      for (auto &hit : hits) out["matches"].push_back(encode(hit));
      out["topConfidence"] = hits.empty() ? 0 : hits.front().confidence;
    }
  }
  return out;
}

TrackingResult Tracker::operator()(TrackingJob job) {
  TrackingResult out{job.generation, job.frame};
  const auto begin = std::chrono::steady_clock::now();
  try {
    if (generation_ != job.generation) { generation_ = job.generation; history_.clear(); }
    const auto &frame = *job.frame;
    cv::Mat bgra(frame.height, frame.width, CV_8UC4, const_cast<uint8_t *>(frame.bgra.data()));
    cv::Mat bgr; cv::cvtColor(bgra, bgr, cv::COLOR_BGRA2BGR);
    // Shared by every region that matches on the same look, so each is prepared, and each smaller copy
    // made, once per frame
    std::map<Look, Pyramid> pyramids;
    auto pyramidFor = [&](Look look) -> Pyramid & {
      auto it = pyramids.find(look);
      if (it == pyramids.end()) it = pyramids.emplace(look, Pyramid(prepareLook(bgr, look))).first;
      return it->second;
    };
    Json regions = Json::array();
    std::map<std::string, History> kept;
    for (const auto &track : *job.tracks) {
      const auto regionBegin = std::chrono::steady_clock::now();
      Json result;
      auto &history = history_[track->region];
      if (history.context != track->context) history = {track->context};
      // One region's failure doesn't cost the others their results
      try { result = follow(*track, history, pyramidFor(track->look), frame); }
      catch (const std::exception &e) { result = {{"found", false}, {"confidence", 0}, {"error", e.what()}}; }
      addMotion(result, history.path, frame);
      result["region"] = track->region;
      result["context"] = track->context;
      result["durationMs"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - regionBegin).count();
      regions.push_back(std::move(result));
      kept.insert(*history_.find(track->region));
    }
    history_ = std::move(kept); // regions no longer followed are forgotten
    out.match = {{"regions", std::move(regions)}, {"timestamp", frame.timestamp},
      {"width", frame.width}, {"height", frame.height}};
  } catch (const std::exception &e) { out.error = e.what(); }
  out.elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
  if (!out.match.is_null()) out.match["durationMs"] = out.elapsedMs;
  return out;
}
}
