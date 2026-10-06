#pragma once
#include <deque>
#include <functional>
#include <map>
#include <opencv2/core.hpp>
#include <string>
#include <vector>

namespace firefly {
// What templates and frames are matched on: their colours as they are, their
// brightness alone (grayscale: a pose in another colour or tint still matches),
// or how sharply brightness changes (edges: outlines and shapes, whatever their
// colours and however light or dark). A template and the frame it's looked for
// in are always prepared the same way.
enum class Look { Color, Gray, Edges };
Look lookNamed(const std::string &name); // "color" (or anything else), "gray", "edges"
// A BGR image as matched with this look: BGR itself, or one channel for the others
cv::Mat prepareLook(const cv::Mat &bgr, Look look);

// A template made ready once rather than on every frame: whether it has detail
// enough to match anything, and a smaller copy of it for a first, cheaper look.
struct Pattern {
  Pattern() = default;
  // mask, if given (8-bit, one channel, image's size): which of its pixels are the object and count
  // (non-zero), so a background around a sprite, which changes as it moves, doesn't
  explicit Pattern(cv::Mat image, cv::Mat mask = {});
  cv::Mat image;  // BGR, or one channel (see Look), at full size
  cv::Mat mask, coarseMask; // empty for every pixel; else as image and coarse, 255 where a pixel counts
  // image with its left-out pixels set to the mean of the kept ones: matched without the mask (fast),
  // those pixels add nothing to the score, so a pattern matched only at full size (edges) finds its
  // likely places at the unmasked cost, and only they are scored with the mask (see findPeaks)
  cv::Mat filled;
  // The kept pixels, for scoring a few places directly (maskedScoreAt): where each is, its value less its
  // channel's mean over the kept pixels (channels interleaved), and the sum of those squared
  std::vector<cv::Point> keptAt;
  std::vector<float> keptT;
  double keptT2 = 0;
  void fill(); // makes filled and the kept pixels from image and mask
  cv::Mat coarse; // image halved `level` times; image itself at level 0
  int level = 0;
  bool detail = false;
  // Where image lies in the template it was made from, and that template's size: a place it's found
  // at is a box of `full` at `-inset` from it. Edges leave out a template's border (see patternFor).
  cv::Point inset{0, 0};
  cv::Size full;
};
// A template made ready to be looked for with this look. Its edges near its border are worked out
// without what surrounds it, unlike the same object in a frame, which on a small template costs a
// quarter of its area (an identical sprite scored 0.72), so matching by edges leaves that border out.
Pattern patternFor(const cv::Mat &bgr, Look look, const cv::Mat &mask = {});
// A masked pattern's TM_CCOEFF_NORMED score with its top-left at `at` in image (as prepared for its look),
// worked out directly over its kept pixels: what OpenCV's masked matchTemplate gives (per-channel means
// over the kept pixels, channels summed), without its cost per call, which dominates when only a few
// places are scored. -1 where the image under the mask is flat.
double maskedScoreAt(const cv::Mat &image, const Pattern &pattern, cv::Point at);

// A frame (BGR, or one channel) and copies of it halved as many times as the patterns looked for
// in it need, each made the first time it is asked for. Level l is 2^l times
// smaller, and its pixel (x, y) is the average of the frame's square of 2^l
// pixels at (x, y) * 2^l.
class Pyramid {
public:
  explicit Pyramid(cv::Mat image);
  const cv::Mat &at(int level);

private:
  std::deque<cv::Mat> levels_; // a deque, so a reference to a level outlives making the next
};

// A place where a template matched an image, and how well: 1 is identical.
struct Peak {
  cv::Point at;
  double score = 0;
};

// Where the pattern matches the frame with at least this score, best first and
// at most limit of them. Only roi is searched. Once a place is taken the ones
// within half a template's size of it are not, so its neighbours don't come up
// as places of their own. A template with hardly any detail matches nowhere.
// A large area is looked through in the pyramid's smaller copy first, and the
// likeliest places there are scored again at full size, so scores are always
// TM_CCOEFF_NORMED at full size.
std::vector<Peak> findPeaks(Pyramid &frame, const Pattern &pattern, cv::Rect roi,
                            double least, int limit);
std::vector<Peak> findPeaks(const cv::Mat &image, const cv::Mat &templ,
                            cv::Rect roi, double least, int limit);

struct TemplateHit {
  std::string templateId;
  cv::Rect box;
  double confidence;
};
// A template that keeps the best place unless another beats it there by
// `margin`: the one that won an object last frame, so two poses scoring about
// the same don't swap from frame to frame. It never wins a place of its own
// elsewhere this way, and only if it scores at least `least`.
struct Preference {
  std::string templateId;
  double margin = 0, least = 0;
};
// Globally ranked matches. Competing templates at the same instance produce
// one winner; the result cap is applied only after comparing every template.
// Each template is looked for in at most `each` places (all `limit` of them if
// not given): 1 finds where every template matches best, and which of them win.
// `area`, if given, says where in the frame to look for each template; else the
// whole frame is searched. `prefer` can settle a near-tie for the best place,
// never changing confidences.
std::vector<TemplateHit> matchTemplates(Pyramid &frame,
    const std::map<std::string, Pattern> &templates, double threshold, int limit,
    int each = -1, const std::function<cv::Rect(const Pattern &)> &area = {},
    const Preference &prefer = {});
std::vector<TemplateHit> matchTemplates(const cv::Mat &frame,
    const std::map<std::string, cv::Mat> &templates, double threshold, int limit);
}
