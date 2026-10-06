#include "geometry.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <opencv2/imgproc.hpp>

namespace firefly {
namespace {
using Json = nlohmann::json;

// Rows of the result hold the runs along axis: columns for vertical runs,
// transposed so scans are contiguous. Transposing again undoes it.
cv::Mat runLines(const cv::Mat &mask, Axis axis) {
  if (axis == Axis::Horizontal)
    return mask;
  cv::Mat t;
  cv::transpose(mask, t);
  return t;
}

// Calls f(row, start, end) for each run [start, end) of nonzero pixels.
template <typename F> void forEachRun(const cv::Mat &rows, F &&f) {
  for (int r = 0; r < rows.rows; ++r) {
    const uchar *p = rows.ptr<uchar>(r);
    for (int i = 0; i < rows.cols;) {
      if (!p[i]) {
        ++i;
        continue;
      }
      int start = i;
      while (i < rows.cols && p[i])
        ++i;
      f(r, start, i);
    }
  }
}

// A band's rows in one column (inclusive).
struct Slice {
  int x, top, bottom;
};
using Chain = std::vector<Slice>;

cv::Point rounded(const cv::Point2f &p, cv::Point offset) {
  return {(int)std::lround(p.x) + offset.x, (int)std::lround(p.y) + offset.y};
}

void label(cv::Mat &bgra, const std::string &text, cv::Point at,
           const cv::Scalar &color) {
  cv::putText(bgra, text, at, cv::FONT_HERSHEY_SIMPLEX, 0.4,
              cv::Scalar(0, 0, 0, 255), 3, cv::LINE_AA);
  cv::putText(bgra, text, at, cv::FONT_HERSHEY_SIMPLEX, 0.4, color, 1,
              cv::LINE_AA);
}

// y of a line at x: interpolated between its points, held flat up to reach
// beyond its ends.
std::optional<double> yAt(const Shape &line, double x, double reach) {
  auto &p = line.points;
  if (p.size() < 2)
    return std::nullopt;
  auto [lo, hi] = std::minmax_element(p.begin(), p.end(), [](auto &a, auto &b) {
    return a.x < b.x;
  });
  if (x < lo->x - reach || x > hi->x + reach)
    return std::nullopt;
  if (x <= lo->x)
    return lo->y;
  if (x >= hi->x)
    return hi->y;
  for (size_t k = 1; k < p.size(); ++k) {
    auto &a = p[k - 1], &b = p[k];
    if (std::min(a.x, b.x) <= x && x <= std::max(a.x, b.x))
      return a.x == b.x ? std::min(a.y, b.y)
                        : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  }
  return std::nullopt;
}
} // namespace

cv::Mat keepRuns(const cv::Mat &mask, Axis axis, int min, int max) {
  cv::Mat rows = runLines(mask, axis);
  cv::Mat kept = cv::Mat::zeros(rows.size(), CV_8UC1);
  forEachRun(rows, [&](int r, int start, int end) {
    int length = end - start;
    if (length >= min && (max <= 0 || length <= max))
      std::fill(kept.ptr<uchar>(r) + start, kept.ptr<uchar>(r) + end, uchar(255));
  });
  return runLines(kept, axis);
}

double runLength(const cv::Mat &mask, Axis axis, int max) {
  std::vector<int> lengths;
  forEachRun(runLines(mask, axis), [&](int, int start, int end) {
    if (max <= 0 || end - start <= max)
      lengths.push_back(end - start);
  });
  if (lengths.empty())
    return 0;
  std::nth_element(lengths.begin(), lengths.begin() + lengths.size() / 2,
                   lengths.end());
  return lengths[lengths.size() / 2];
}

Shapes regions(const cv::Mat &mask, int connectivity, int minArea,
               cv::Point origin) {
  cv::Mat labels, stats, centroids;
  int count = cv::connectedComponentsWithStats(mask, labels, stats, centroids,
                                               connectivity, CV_32S);
  Shapes out{mask.size(), origin, {}};
  for (int i = 1; i < count; ++i) {
    int area = stats.at<int>(i, cv::CC_STAT_AREA);
    if (area < minArea)
      continue;
    cv::Rect box(stats.at<int>(i, cv::CC_STAT_LEFT), stats.at<int>(i, cv::CC_STAT_TOP),
                 stats.at<int>(i, cv::CC_STAT_WIDTH),
                 stats.at<int>(i, cv::CC_STAT_HEIGHT));
    Shape s;
    s.box = box;
    s.mask = labels(box) == i;
    s.props = {{"x", box.x + origin.x},
               {"y", box.y + origin.y},
               {"width", box.width},
               {"height", box.height},
               {"area", area},
               {"cx", centroids.at<double>(i, 0) + origin.x},
               {"cy", centroids.at<double>(i, 1) + origin.y},
               {"fill", area / double(box.area())},
               {"meanWidth", area / double(box.height)},
               {"meanHeight", area / double(box.width)},
               {"touchesTop", box.y == 0},
               {"touchesBottom", box.y + box.height == mask.rows},
               {"touchesLeft", box.x == 0},
               {"touchesRight", box.x + box.width == mask.cols}};
    out.items.push_back(std::move(s));
  }
  return out;
}

cv::Mat rasterize(const Shapes &shapes, int thickness) {
  cv::Mat out = cv::Mat::zeros(shapes.size, CV_8UC1);
  for (auto &s : shapes.items) {
    if (!s.mask.empty()) {
      cv::Mat target = out(s.box);
      cv::bitwise_or(target, s.mask, target);
    } else if (s.points.size() == 1) {
      cv::circle(out, rounded(s.points[0], {}), thickness, 255, cv::FILLED);
    } else if (s.points.size() > 1) {
      std::vector<cv::Point> pts;
      for (auto &p : s.points)
        pts.push_back(rounded(p, {}));
      cv::polylines(out, pts, false, 255, thickness);
    }
  }
  return out;
}

Shapes traceBands(const cv::Mat &mask, double typicalBand, const TraceOptions &o,
                  cv::Point origin) {
  cv::Mat columns = runLines(mask, Axis::Vertical);
  const int typical = (int)std::lround(typicalBand);
  std::vector<Chain> chains;
  std::vector<size_t> open;
  std::vector<std::pair<int, int>> runs;
  std::vector<bool> claimed;
  for (int x = 0; x < columns.rows; ++x) {
    runs.clear();
    forEachRun(columns.row(x), [&](int, int top, int end) {
      // Two stacked bands, e.g. a ramp over the end of the platform it
      // rises from: trace the upper and lower surface separately
      if (o.stack > 0 && typical > 0 && end - top >= o.stack * typical) {
        runs.emplace_back(top, top + typical - 1);
        runs.emplace_back(end - typical, end - 1);
      } else
        runs.emplace_back(top, end - 1);
    });
    claimed.assign(runs.size(), false);
    std::erase_if(open, [&](size_t i) {
      return x - chains[i].back().x > o.maxGap + 1;
    });
    // A band continues into the run that overlaps its previous slice with the
    // nearest top edge, so slopes chain naturally; a bigger jump than maxStep
    // means the run merged with another surface
    for (size_t i : open) {
      const Slice last = chains[i].back();
      int best = -1;
      for (int r = 0; r < (int)runs.size(); ++r) {
        auto [t, b] = runs[r];
        if (claimed[r] || b < last.top - 2 || t > last.bottom + 2 ||
            std::abs(t - last.top) > o.maxStep * (x - last.x))
          continue;
        if (best < 0 ||
            std::abs(t - last.top) < std::abs(runs[best].first - last.top))
          best = r;
      }
      if (best < 0)
        continue;
      claimed[best] = true;
      chains[i].push_back({x, runs[best].first, runs[best].second});
    }
    for (size_t r = 0; r < runs.size(); ++r)
      if (!claimed[r]) {
        chains.push_back({{x, runs[r].first, runs[r].second}});
        open.push_back(chains.size() - 1);
      }
  }

  Shapes out{mask.size(), origin, {}};
  for (auto &c : chains) {
    // Where a slope overlaps the platform it joins, columns are taller than
    // the band, so the line sits at a fixed offset from each column's top edge
    // using the band's typical (median) height
    std::vector<int> heights;
    for (auto &s : c)
      heights.push_back(s.bottom - s.top + 1);
    std::nth_element(heights.begin(), heights.begin() + heights.size() / 2,
                     heights.end());
    double band = heights[heights.size() / 2];
    if (o.maxBand > 0)
      band = std::min(band, (double)o.maxBand);
    Shape line;
    for (auto &s : c)
      line.points.emplace_back((float)s.x, (float)(s.top + o.position * band));
    line.props = {{"band", band}, {"length", c.back().x - c.front().x + 1}};
    out.items.push_back(std::move(line));
  }
  return out;
}

Shapes joinGaps(Shapes lines, const cv::Mat *cover, int maxGap, double maxRise) {
  auto &items = lines.items;
  std::erase_if(items, [](const Shape &s) { return s.points.empty(); });
  std::sort(items.begin(), items.end(), [](const Shape &a, const Shape &b) {
    return a.points.front().x < b.points.front().x;
  });
  for (size_t i = 0; i < items.size(); ++i)
    for (bool joined = true; joined && !items[i].points.empty();) {
      joined = false;
      const cv::Point2f end = items[i].points.back();
      for (size_t j = i + 1; j < items.size() && !joined; ++j) {
        auto &next = items[j];
        if (next.points.empty())
          continue;
        const cv::Point2f start = next.points.front();
        long gap = std::lround(start.x) - std::lround(end.x) - 1;
        if (gap < 1 || gap > maxGap || std::abs(start.y - end.y) > maxRise)
          continue;
        bool covered = true;
        for (long x = std::lround(end.x) + 1; cover && x < std::lround(start.x) && covered; ++x) {
          double y = end.y + (start.y - end.y) * (x - end.x) / (start.x - end.x);
          int row = (int)std::lround(y);
          covered = row >= 0 && row < cover->rows && x >= 0 && x < cover->cols &&
                    cover->at<uchar>(row, (int)x) != 0;
        }
        if (!covered)
          continue;
        auto &line = items[i];
        double a = (double)line.points.size(), b = (double)next.points.size();
        for (auto &[key, v] : line.props)
          if (auto it = next.props.find(key); it != next.props.end())
            v = (v * a + it->second * b) / (a + b);
        line.points.insert(line.points.end(), next.points.begin(), next.points.end());
        if (line.props.contains("length"))
          line.props["length"] = line.points.back().x - line.points.front().x + 1;
        next.points.clear();
        joined = true;
      }
    }
  std::erase_if(items, [](const Shape &s) { return s.points.empty(); });
  return lines;
}

Shapes simplify(Shapes lines, int smooth, double epsilon) {
  for (auto &s : lines.items) {
    auto &p = s.points;
    if (p.size() < 2)
      continue;
    // Average y over the points within ±smooth in x, e.g. to remove the stair
    // steps of an upsampled mask
    std::vector<cv::Point2f> line = p;
    if (smooth > 0)
      for (size_t k = 0; k < p.size(); ++k) {
        double sum = 0;
        int n = 0;
        for (size_t j = k; j-- > 0 && p[k].x - p[j].x <= smooth; ++n)
          sum += p[j].y;
        for (size_t j = k; j < p.size() && p[j].x - p[k].x <= smooth; ++j, ++n)
          sum += p[j].y;
        line[k].y = (float)(sum / n);
      }
    if (epsilon > 0)
      cv::approxPolyDP(line, p, epsilon, false);
    else
      p = line;
  }
  return lines;
}

Shapes toSegments(const Shapes &lines, int rowHeight) {
  std::vector<std::pair<std::pair<long, float>, const Shape *>> order;
  for (auto &s : lines.items) {
    if (s.points.size() < 2)
      continue;
    double y = 0;
    for (auto &p : s.points)
      y += p.y;
    order.push_back({{std::lround(y / s.points.size() / rowHeight), s.points.front().x}, &s});
  }
  std::stable_sort(order.begin(), order.end(),
                   [](auto &a, auto &b) { return a.first < b.first; });
  Shapes out{lines.size, lines.origin, {}};
  for (auto &[key, s] : order)
    for (size_t k = 1; k < s->points.size(); ++k) {
      Shape segment;
      segment.points = {s->points[k - 1], s->points[k]};
      out.items.push_back(std::move(segment));
    }
  return out;
}

Shapes axisLines(const Shapes &regions, Axis axis) {
  Shapes out{regions.size, regions.origin, {}};
  for (auto &r : regions.items) {
    const cv::Rect &b = r.box;
    auto prop = [&](const char *key, double fallback) {
      auto it = r.props.find(key);
      return it == r.props.end() ? fallback : it->second;
    };
    double area = prop("area", b.area());
    Shape line;
    if (axis == Axis::Vertical) {
      // Centroid props are in frame coordinates; points are image coordinates
      float x = (float)(prop("cx", b.x + (b.width - 1) / 2.0 + regions.origin.x) -
                        regions.origin.x);
      line.points = {{x, (float)b.y}, {x, (float)(b.y + b.height - 1)}};
      line.props = {{"width", (double)std::lround(area / b.height)}};
    } else {
      float y = (float)(prop("cy", b.y + (b.height - 1) / 2.0 + regions.origin.y) -
                        regions.origin.y);
      line.points = {{(float)b.x, y}, {(float)(b.x + b.width - 1), y}};
      line.props = {{"thickness", (double)std::lround(area / b.width)}};
    }
    out.items.push_back(std::move(line));
  }
  return out;
}

Shapes snapEnds(Shapes lines, const Shapes &targets, double tolerance,
                double reach) {
  // Targets in this set's image coordinates
  cv::Point2f shift(float(targets.origin.x - lines.origin.x),
                    float(targets.origin.y - lines.origin.y));
  for (auto &s : lines.items) {
    if (s.points.size() < 2)
      continue;
    for (auto *end : {&s.points.front(), &s.points.back()}) {
      std::optional<double> best;
      for (auto &t : targets.items)
        if (auto y = yAt(t, end->x - shift.x, reach)) {
          double snapped = *y + shift.y;
          if (std::abs(snapped - end->y) <= tolerance &&
              (!best || std::abs(snapped - end->y) < std::abs(*best - end->y)))
            best = snapped;
        }
      if (best)
        end->y = (float)*best;
    }
  }
  return lines;
}

void drawShapes(cv::Mat &bgra, const Shapes &shapes, cv::Point offset,
                const cv::Scalar &color, int thickness, const std::string &text,
                bool boxes) {
  for (size_t i = 0; i < shapes.items.size(); ++i) {
    auto &s = shapes.items[i];
    cv::Point anchor;
    if (s.points.empty()) {
      cv::Rect box = s.box + offset;
      if (boxes || s.mask.empty())
        cv::rectangle(bgra, box, color, thickness, cv::LINE_AA);
      else {
        std::vector<std::vector<cv::Point>> contours;
        cv::findContours(s.mask, contours, cv::RETR_EXTERNAL,
                         cv::CHAIN_APPROX_SIMPLE, box.tl());
        cv::drawContours(bgra, contours, -1, color, thickness, cv::LINE_AA);
      }
      anchor = box.tl();
    } else if (s.points.size() == 1) {
      anchor = rounded(s.points[0], offset);
      cv::circle(bgra, anchor, thickness + 2, color, cv::FILLED, cv::LINE_AA);
    } else {
      std::vector<cv::Point> pts;
      for (auto &p : s.points)
        pts.push_back(rounded(p, offset));
      cv::polylines(bgra, pts, false, color, thickness, cv::LINE_AA);
      anchor = pts.front();
      auto width = s.props.find("width");
      if (width != s.props.end() && pts.size() == 2) {
        // Caps across the ends show the measured width, e.g. of a ladder
        cv::Point2f d = s.points.back() - s.points.front();
        double norm = std::hypot(d.x, d.y);
        double half = std::max(4.0, width->second / 2);
        cv::Point cap(0, 0);
        if (norm > 0)
          cap = cv::Point((int)std::lround(-d.y / norm * half),
                          (int)std::lround(d.x / norm * half));
        for (auto &p : pts)
          cv::line(bgra, p - cap, p + cap, color, thickness, cv::LINE_AA);
      } else if (pts.front() != pts.back()) // a closed outline, such as a detected box, has no ends to mark
        for (auto &p : {pts.front(), pts.back()})
          cv::circle(bgra, p, thickness + 1, color, cv::FILLED, cv::LINE_AA);
    }
    if (!text.empty())
      label(bgra, text + std::to_string(i), anchor + cv::Point(3, -6), color);
  }
}

Json shapesJson(const Shapes &shapes, size_t limit) {
  Json out = Json::array();
  for (size_t i = 0; i < shapes.items.size() && i < limit; ++i) {
    auto &s = shapes.items[i];
    Json item = Json::object();
    auto X = [&](float x) { return std::lround(x) + shapes.origin.x; };
    auto Y = [&](float y) { return std::lround(y) + shapes.origin.y; };
    if (s.points.size() == 1) {
      item["x"] = X(s.points[0].x);
      item["y"] = Y(s.points[0].y);
    } else if (s.points.size() == 2) {
      item["x1"] = X(s.points[0].x);
      item["y1"] = Y(s.points[0].y);
      item["x2"] = X(s.points[1].x);
      item["y2"] = Y(s.points[1].y);
    } else if (s.points.size() > 2) {
      Json points = Json::array();
      for (auto &p : s.points)
        points.push_back({X(p.x), Y(p.y)});
      item["points"] = points;
    }
    for (auto &[key, v] : s.props)
      if (v == std::floor(v) && std::abs(v) < 1e15)
        item[key] = (long long)v;
      else
        item[key] = std::round(v * 1000) / 1000;
    out.push_back(item);
  }
  return out;
}

double polylineLength(const std::vector<cv::Point2f> &points) {
  double length = 0;
  for (size_t k = 1; k < points.size(); ++k)
    length += std::hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
  return length;
}
} // namespace firefly
