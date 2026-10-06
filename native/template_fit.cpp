#include "template_fit.hpp"
#include <algorithm>
#include <cmath>
#include <opencv2/imgproc.hpp>
#include <tuple>

namespace firefly {
namespace {
constexpr int kPlaces = 6;    // places kept for each template and search
constexpr double kTie = 0.05; // scores this close count as equally good

double distance(cv::Point a, cv::Point b) {
  return std::hypot((double)(a.x - b.x), (double)(a.y - b.y));
}

struct Corner {
  cv::Point at;
  double score;
  const Pattern *patch;
};
} // namespace

CornerFit fitCorners(Pyramid &image, const std::vector<Pattern> &topLeft,
                     const std::vector<Pattern> &bottomRight,
                     const CornerSearch &s) {
  CornerFit fit;
  const cv::Size size = image.at(0).size();
  auto collect = [&](const std::vector<Pattern> &patches, auto roiFor) {
    std::vector<Corner> found;
    for (auto &patch : patches)
      for (auto &peak :
           findPeaks(image, patch, roiFor(patch), s.threshold, kPlaces))
        found.push_back({peak.at, peak.score, &patch});
    return found;
  };
  const bool known = s.was.x >= 0 && s.was.y >= 0;
  std::vector<Corner> tops;
  if (known)
    tops = collect(topLeft, [&](const Pattern &patch) {
      return cv::Rect(s.was.x - s.reach, s.was.y - s.reach,
                      2 * s.reach + patch.image.cols,
                      2 * s.reach + patch.image.rows);
    });
  if (tops.empty() && s.anywhere)
    tops = collect(topLeft, [&](const Pattern &) {
      return cv::Rect(cv::Point(), size);
    });
  if (tops.empty())
    return fit;

  const double best =
      std::max_element(tops.begin(), tops.end(), [](auto &a, auto &b) {
        return a.score < b.score;
      })->score;
  tops.erase(std::remove_if(tops.begin(), tops.end(),
                            [&](auto &c) { return c.score < best - kTie; }),
             tops.end());
  std::sort(tops.begin(), tops.end(), [&](const Corner &a, const Corner &b) {
    if (known) {
      double da = distance(a.at, s.was), db = distance(b.at, s.was);
      if (da != db)
        return da < db;
    }
    if (a.score != b.score)
      return a.score > b.score;
    return std::tie(a.at.y, a.at.x) < std::tie(b.at.y, b.at.x);
  });

  for (const Corner &top : tops) {
    fit.topLeft = std::max(fit.topLeft, top.score);
    // The bottom-right patch lies right of and below the top-left one, and
    // not so far that the object would be bigger than it can be
    std::vector<Corner> bottoms;
    for (auto &patch : bottomRight) {
      const int x0 =
          std::max(0, top.at.x + top.patch->image.cols - patch.image.cols);
      const int y0 =
          std::max(0, top.at.y + top.patch->image.rows - patch.image.rows);
      int x1 = size.width, y1 = size.height;
      if (!s.largest.empty()) {
        x1 = std::min(x1, top.at.x + s.largest.width);
        y1 = std::min(y1, top.at.y + s.largest.height);
      }
      if (x1 <= x0 || y1 <= y0)
        continue;
      for (auto &peak : findPeaks(image, patch,
                                  cv::Rect(x0, y0, x1 - x0, y1 - y0),
                                  s.threshold, kPlaces))
        bottoms.push_back({peak.at, peak.score, &patch});
    }
    if (bottoms.empty())
      continue;
    double bestBottom = 0;
    for (auto &b : bottoms)
      bestBottom = std::max(bestBottom, b.score);
    const Corner *pick = nullptr;
    double nearest = 0;
    for (auto &b : bottoms) {
      if (b.score < bestBottom - kTie)
        continue;
      const double away = distance(top.at, b.at);
      if (!pick || away < nearest) {
        pick = &b;
        nearest = away;
      }
    }
    fit.found = true;
    fit.topLeft = top.score;
    fit.bottomRight = pick->score;
    fit.box =
        cv::Rect(top.at, cv::Point(pick->at.x + pick->patch->image.cols,
                                   pick->at.y + pick->patch->image.rows));
    return fit;
  }
  return fit;
}

CornerFit fitCorners(const cv::Mat &image, const std::vector<cv::Mat> &topLeft,
                     const std::vector<cv::Mat> &bottomRight,
                     const CornerSearch &search) {
  Pyramid pyramid(image);
  auto prepare = [](const std::vector<cv::Mat> &patches) {
    return std::vector<Pattern>(patches.begin(), patches.end());
  };
  return fitCorners(pyramid, prepare(topLeft), prepare(bottomRight), search);
}
} // namespace firefly
