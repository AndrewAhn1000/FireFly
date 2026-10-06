#include "template_match.hpp"
#include <algorithm>
#include <cmath>
#include <optional>
#include <opencv2/core/utility.hpp>
#include <opencv2/imgproc.hpp>
#include <tuple>

namespace firefly {
namespace {
constexpr int kCoarseSide = 10; // a pattern is halved only while its shorter side stays at least this
constexpr int kMostLevels = 3;  // and at most this many times, 8x smaller
constexpr double kSlack = 0.35; // places in the smaller copy this far under the least score still get a full-size look
// A masked template matched only at full size (edges) takes its likely places from its filled copy, whose
// scores are lower than the masked ones where the frame behind the object is busy, so they get more slack,
// and more of them are looked at. (In the smaller copy the mask is used as it is: it's cheap there, and the
// filled copy lost low-detail sprites in busy scenes, measured 91/120 found in grayscale, against 118.)
constexpr double kFilledSlack = 0.6;
constexpr int kFilledGuesses = 2;

constexpr int kLeastMasked = 16; // a mask has to leave at least this many pixels to match anything by

bool hasDetail(const cv::Mat &patch, const cv::Mat &mask = {}) {
  if (!mask.empty() && cv::countNonZero(mask) < kLeastMasked) return false;
  cv::Scalar mean, deviation;
  cv::meanStdDev(patch, mean, deviation, mask);
  return std::max({deviation[0], deviation[1], deviation[2]}) >= 2.0;
}

// A mask as matchTemplate takes it: as many channels as the template
cv::Mat maskFor(const cv::Mat &templ, const cv::Mat &mask) {
  if (mask.empty() || templ.channels() == 1) return mask;
  cv::Mat out;
  cv::merge(std::vector<cv::Mat>(templ.channels(), mask), out);
  return out;
}

// matchTemplate with a mask gives NaN or infinity where the image under the mask is flat; those are no match
void matchScores(const cv::Mat &image, const cv::Mat &templ, cv::Mat &scores, const cv::Mat &mask) {
  if (mask.empty()) { cv::matchTemplate(image, templ, scores, cv::TM_CCOEFF_NORMED); return; }
  cv::matchTemplate(image, templ, scores, cv::TM_CCOEFF_NORMED, maskFor(templ, mask));
  cv::patchNaNs(scores, -1);
  cv::min(scores, 1.0, scores);
  cv::max(scores, -1.0, scores);
}

// Each pixel the average of a square of four, so a place halves exactly
cv::Mat halve(const cv::Mat &image) {
  cv::Mat even = image(cv::Rect(0, 0, image.cols & ~1, image.rows & ~1)), out;
  cv::resize(even, out, cv::Size(even.cols / 2, even.rows / 2), 0, 0, cv::INTER_AREA);
  return out;
}

// TM_CCOEFF_NORMED for every place in image. matchTemplate costs about the
// same per pixel whatever the template's size, and runs on one core, so a big
// image is scored in bands of rows on several at once.
cv::Mat scoresOf(const cv::Mat &image, const cv::Mat &templ, const cv::Mat &mask) {
  cv::Mat scores(image.rows - templ.rows + 1, image.cols - templ.cols + 1, CV_32F);
  // Each band also reads the template's height of rows past its own
  const int bands = std::clamp(scores.rows / std::max(64, 2 * templ.rows), 1, 8);
  const int rows = (scores.rows + bands - 1) / bands;
  cv::parallel_for_(cv::Range(0, bands), [&](const cv::Range &range) {
    for (int band = range.start; band < range.end; ++band) {
      const int first = band * rows, end = std::min(scores.rows, first + rows);
      if (first >= end) continue;
      cv::Mat part;
      matchScores(image.rowRange(first, end + templ.rows - 1), templ, part, mask);
      part.copyTo(scores.rowRange(first, end));
    }
  });
  return scores;
}

// The best of these places, at most limit of them, where once a place is
// taken the others in a box of size apart round it are not
std::vector<Peak> keepApart(std::vector<Peak> found, cv::Size apart, int limit) {
  std::sort(found.begin(), found.end(), [](const Peak &a, const Peak &b) {
    if (a.score != b.score)
      return a.score > b.score;
    return std::tie(a.at.y, a.at.x) < std::tie(b.at.y, b.at.x);
  });
  std::vector<Peak> peaks;
  for (auto &peak : found) {
    if ((int)peaks.size() >= limit)
      break;
    if (std::none_of(peaks.begin(), peaks.end(), [&](const Peak &taken) {
          return std::abs(peak.at.x - taken.at.x) <= apart.width / 2 &&
                 std::abs(peak.at.y - taken.at.y) <= apart.height / 2;
        }))
      peaks.push_back(peak);
  }
  return peaks;
}

// The best places in all of image, offset by where image is in the frame.
// Once a place is taken, the others in a box of size apart round it are not.
std::vector<Peak> strongest(const cv::Mat &image, const cv::Mat &templ,
                            cv::Point offset, double least, int limit,
                            cv::Size apart, const cv::Mat &mask) {
  const cv::Mat scores = scoresOf(image, templ, mask);
  // Only a place that scores best in the box round it can be taken, and these
  // are found in one pass rather than by searching the scores once per place
  cv::Mat around, best, enough;
  cv::dilate(scores, around, cv::getStructuringElement(cv::MORPH_RECT, apart));
  cv::compare(scores, around, best, cv::CMP_GE);
  cv::compare(scores, least, enough, cv::CMP_GE);
  std::vector<cv::Point> places;
  cv::findNonZero(best & enough, places);
  std::vector<Peak> found;
  found.reserve(places.size());
  for (auto &at : places)
    found.push_back({at + offset, scores.at<float>(at)});
  return keepApart(std::move(found), apart, limit);
}

// The best place near a guess, scored at full size up to reach either way.
// Where the scores change slowly one way, as they do along a stripe, the guess
// can be further off than that, so while the best is at an edge of what was
// scored the look moves there and goes on uphill.
std::optional<Peak> climb(const cv::Mat &image, const cv::Mat &templ, cv::Rect roi,
                          cv::Point guess, int reach, double least, const Pattern *masked) {
  std::optional<Peak> best;
  for (int moves = 0; moves < 8; ++moves) {
    cv::Rect near(guess.x - reach, guess.y - reach, templ.cols + 2 * reach,
                  templ.rows + 2 * reach);
    near &= roi;
    if (near.width < templ.cols || near.height < templ.rows)
      break;
    cv::Mat scores;
    if (masked) {
      scores.create(near.height - templ.rows + 1, near.width - templ.cols + 1, CV_32F);
      for (int y = 0; y < scores.rows; ++y)
        for (int x = 0; x < scores.cols; ++x)
          scores.at<float>(y, x) = float(maskedScoreAt(image, *masked, near.tl() + cv::Point(x, y)));
    } else {
      cv::matchTemplate(image(near), templ, scores, cv::TM_CCOEFF_NORMED);
    }
    double score;
    cv::Point at;
    cv::minMaxLoc(scores, nullptr, &score, nullptr, &at);
    if (best && !(score > best->score))
      break;
    best = Peak{at + near.tl(), score};
    const bool edge = (at.x == 0 && near.x > roi.x) ||
                      (at.y == 0 && near.y > roi.y) ||
                      (at.x == scores.cols - 1 && near.x + near.width < roi.x + roi.width) ||
                      (at.y == scores.rows - 1 && near.y + near.height < roi.y + roi.height);
    if (!edge)
      break;
    guess = best->at;
  }
  if (best && !(best->score >= least))
    best.reset();
  return best;
}
} // namespace

Look lookNamed(const std::string &name) {
  return name == "gray" ? Look::Gray : name == "edges" ? Look::Edges : Look::Color;
}

cv::Mat prepareLook(const cv::Mat &bgr, Look look) {
  if (look == Look::Color || bgr.empty()) return bgr;
  cv::Mat gray;
  cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
  if (look == Look::Gray) return gray;
  // Edges: the strength of the brightness gradient, after a light blur so single-pixel noise doesn't
  // count as an edge. Flat areas are 0, whatever their colour or brightness.
  cv::Mat blurred, dx, dy, ax, ay, edges;
  cv::GaussianBlur(gray, blurred, cv::Size(3, 3), 0);
  cv::Sobel(blurred, dx, CV_16S, 1, 0, 3);
  cv::Sobel(blurred, dy, CV_16S, 0, 1, 3);
  cv::convertScaleAbs(dx, ax);
  cv::convertScaleAbs(dy, ay);
  cv::addWeighted(ax, 0.5, ay, 0.5, 0, edges);
  return edges;
}

Pattern patternFor(const cv::Mat &bgr, Look look, const cv::Mat &mask) {
  constexpr int kInset = 3; // the blur's and the gradient's reach
  cv::Mat prepared = prepareLook(bgr, look);
  if (look != Look::Edges) return Pattern(prepared, mask);
  const bool room = prepared.cols >= 2 * kInset + 8 && prepared.rows >= 2 * kInset + 8;
  const cv::Rect inner(kInset, kInset, prepared.cols - 2 * kInset, prepared.rows - 2 * kInset);
  Pattern pattern(room ? prepared(inner).clone() : prepared, room && !mask.empty() ? mask(inner).clone() : mask);
  if (room) pattern.inset = {kInset, kInset};
  pattern.full = prepared.size();
  // Edges are thin lines, and halving them depends on which pixel they start on, so a first look in a
  // smaller copy can miss the object altogether (it did, in a busy scene): they're only matched at full size
  pattern.coarse = pattern.image;
  pattern.coarseMask = pattern.mask;
  pattern.level = 0;
  pattern.fill();
  return pattern;
}

Pattern::Pattern(cv::Mat source, cv::Mat keep) : image(std::move(source)), full(image.size()) {
  // A mask that doesn't fit the image, or leaves out nothing, is none
  if (!keep.empty() && keep.size() == image.size() && keep.type() == CV_8UC1 && cv::countNonZero(keep) < keep.total())
    cv::threshold(keep, mask, 127, 255, cv::THRESH_BINARY);
  detail = !image.empty() && (image.type() == CV_8UC3 || image.type() == CV_8UC1) && hasDetail(image, mask);
  coarse = image;
  coarseMask = mask;
  while (detail && level < kMostLevels &&
         std::min(coarse.cols, coarse.rows) / 2 >= kCoarseSide) {
    cv::Mat smaller = halve(coarse), smallerMask;
    // A pixel of the smaller copy counts where most of the four it's made from do
    if (!mask.empty()) cv::threshold(halve(coarseMask), smallerMask, 127, 255, cv::THRESH_BINARY);
    if (!hasDetail(smaller, smallerMask))
      break;
    coarse = std::move(smaller);
    coarseMask = std::move(smallerMask);
    ++level;
  }
  fill();
}

void Pattern::fill() {
  auto filledCopy = [](const cv::Mat &img, const cv::Mat &keep) {
    if (keep.empty()) return cv::Mat();
    cv::Mat out = img.clone(), left;
    cv::bitwise_not(keep, left);
    out.setTo(cv::mean(img, keep), left);
    return out;
  };
  filled = filledCopy(image, mask);
  keptAt.clear(); keptT.clear(); keptT2 = 0;
  if (mask.empty()) return;
  const int ch = image.channels();
  const cv::Scalar mean = cv::mean(image, mask);
  for (int y = 0; y < image.rows; ++y)
    for (int x = 0; x < image.cols; ++x)
      if (mask.at<uchar>(y, x)) {
        keptAt.emplace_back(x, y);
        const uchar *px = image.ptr<uchar>(y) + x * ch;
        for (int c = 0; c < ch; ++c) {
          const float t = float(px[c] - mean[c]);
          keptT.push_back(t);
          keptT2 += double(t) * t;
        }
      }
}

double maskedScoreAt(const cv::Mat &image, const Pattern &p, cv::Point at) {
  const int ch = image.channels(), n = (int)p.keptAt.size();
  if (!n || p.keptT2 <= 0) return -1;
  double cross = 0, sum[3] = {0, 0, 0}, sum2[3] = {0, 0, 0};
  const float *t = p.keptT.data();
  for (int k = 0; k < n; ++k) {
    const cv::Point q = at + p.keptAt[k];
    const uchar *px = image.ptr<uchar>(q.y) + q.x * ch;
    for (int c = 0; c < ch; ++c, ++t) {
      const double v = px[c];
      cross += *t * v; sum[c] += v; sum2[c] += v * v;
    }
  }
  double variance = 0;
  for (int c = 0; c < ch; ++c) variance += sum2[c] - sum[c] * sum[c] / n;
  if (variance <= 1e-9) return -1;
  return std::clamp(cross / std::sqrt(p.keptT2 * variance), -1.0, 1.0);
}

Pyramid::Pyramid(cv::Mat image) { levels_.push_back(std::move(image)); }

const cv::Mat &Pyramid::at(int level) {
  while ((int)levels_.size() <= level) {
    const cv::Mat &last = levels_.back();
    levels_.push_back(last.cols < 2 || last.rows < 2 ? cv::Mat() : halve(last));
  }
  return levels_[level];
}

std::vector<Peak> findPeaks(Pyramid &frame, const Pattern &pattern, cv::Rect roi,
                            double least, int limit) {
  const cv::Mat &image = frame.at(0), &templ = pattern.image;
  roi &= cv::Rect(cv::Point(), image.size());
  if (limit <= 0 || !pattern.detail || templ.type() != image.type() ||
      roi.width < templ.cols || roi.height < templ.rows)
    return {};
  // Scoring every place at full size costs the area times the template's, so
  // a large area is first looked through with both shrunk, and only the
  // likeliest places are scored again at full size, a step either way.
  // A masked template's likely places are scored with its mask directly (maskedScoreAt), since OpenCV's
  // masked matchTemplate costs about 0.7 ms a call however few places it scores
  const bool masked = !pattern.mask.empty();
  const int step = 1 << pattern.level, guesses = 4 * limit + 4;
  const double places = double(roi.width - templ.cols + 1) * (roi.height - templ.rows + 1);
  if (places <= double(guesses) * (2 * step + 1) * (2 * step + 1))
    return strongest(image(roi), templ, roi.tl(), least, limit, templ.size(), pattern.mask);
  if (pattern.level == 0) {
    if (!masked) return strongest(image(roi), templ, roi.tl(), least, limit, templ.size(), {});
    std::vector<Peak> found;
    for (auto &guess : strongest(image(roi), pattern.filled, roi.tl(), least - kFilledSlack, guesses * kFilledGuesses, {3, 3}, {}))
      if (auto peak = climb(image, templ, roi, guess.at, 1, least, &pattern))
        found.push_back(*peak);
    return keepApart(std::move(found), templ.size(), limit);
  }
  const cv::Mat &small = frame.at(pattern.level);
  cv::Rect area(cv::Point((roi.x + step - 1) / step, (roi.y + step - 1) / step),
                cv::Point((roi.x + roi.width) / step, (roi.y + roi.height) / step));
  area &= cv::Rect(cv::Point(), small.size());
  if (area.width < pattern.coarse.cols || area.height < pattern.coarse.rows)
    return strongest(image(roi), templ, roi.tl(), least, limit, templ.size(), pattern.mask);

  // Any place that beats its neighbours in the smaller copy is a guess, not
  // only ones a template apart: there a lookalike beside the object can
  // outscore it, which at full size it doesn't
  std::vector<Peak> found;
  for (auto &guess : strongest(small(area), pattern.coarse, area.tl(), least - kSlack, guesses, {3, 3}, pattern.coarseMask))
    if (auto peak = climb(image, templ, roi, guess.at * step, step, least, masked ? &pattern : nullptr))
      found.push_back(*peak);
  // Neighbouring guesses can settle on the same place
  return keepApart(std::move(found), templ.size(), limit);
}

std::vector<Peak> findPeaks(const cv::Mat &image, const cv::Mat &templ,
                            cv::Rect roi, double least, int limit) {
  Pyramid frame(image);
  return findPeaks(frame, Pattern(templ), roi, least, limit);
}

std::vector<TemplateHit> matchTemplates(Pyramid &frame,
    const std::map<std::string, Pattern> &templates, double threshold, int limit,
    int each, const std::function<cv::Rect(const Pattern &)> &area, const Preference &prefer) {
  if (!std::isfinite(threshold)) return {};
  threshold = std::clamp(threshold, 0.0, 1.0);
  limit = std::clamp(limit, 0, 50);
  each = each < 0 ? limit : std::min(each, limit);
  struct Candidate { const std::string *id; cv::Rect box; double score; };
  std::vector<Candidate> found;
  const cv::Rect all(cv::Point(), frame.at(0).size());
  for (const auto &[id, pattern] : templates)
    for (auto &peak : findPeaks(frame, pattern, area ? area(pattern) : all, threshold, each))
      found.push_back({&id, cv::Rect(peak.at - pattern.inset, pattern.full), peak.score});
  std::stable_sort(found.begin(), found.end(),
                   [](const Candidate &a, const Candidate &b) { return a.score > b.score; });
  // The preferred template keeps the best place only if it's there too, nearly as good: a tie between
  // two templates for the same object. Its best place anywhere else never beats the best one, which
  // would move the box onto a lookalike and keep it there.
  if (prefer.margin > 0 && !found.empty() && *found.front().id != prefer.templateId) {
    auto it = std::find_if(found.begin(), found.end(), [&](const Candidate &c) {
      return *c.id == prefer.templateId && (c.box & found.front().box).area() > 0;
    });
    if (it != found.end() && it->score >= prefer.least && it->score + prefer.margin >= found.front().score)
      std::rotate(found.begin(), it, it + 1);
  }
  std::vector<TemplateHit> hits;
  for (const auto &candidate : found) {
    if ((int)hits.size() >= limit) break;
    // The most confident template owns an instance: no overlapping placement,
    // of any template and any size, is another one.
    if (std::none_of(hits.begin(), hits.end(), [&](const TemplateHit &hit) {
          return (hit.box & candidate.box).area() > 0;
        }))
      hits.push_back({*candidate.id, candidate.box, candidate.score});
  }
  return hits;
}

std::vector<TemplateHit> matchTemplates(const cv::Mat &frame,
    const std::map<std::string, cv::Mat> &templates, double threshold, int limit) {
  Pyramid pyramid(frame);
  std::map<std::string, Pattern> patterns;
  for (const auto &[id, image] : templates) patterns.emplace(id, Pattern(image));
  return matchTemplates(pyramid, patterns, threshold, limit);
}
}
