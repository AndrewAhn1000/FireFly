#pragma once
#include "template_match.hpp"
#include <vector>

namespace firefly {
struct CornerSearch {
  double threshold = 0.75; // least score for a corner to count as found
  cv::Size largest;        // biggest the object can be; empty for no limit
  cv::Point was{-1, -1};   // where its top-left corner was, if known
  int reach = 96;          // how far from there to look first, in px
  bool anywhere = true;    // and then look through the whole image
};

struct CornerFit {
  bool found = false;
  cv::Rect box; // from the top-left corner's top-left to the bottom-right's
  double topLeft = 0, bottomRight = 0; // how well each corner matched
};

// Finds an object whose size changes but whose corners don't, such as a window
// or panel, from a patch of its top-left corner and of its bottom-right one.
// Where several places match about equally well, the top-left corner nearest to
// where it was wins, and then the bottom-right corner nearest to that, which
// makes the smallest object. Matching is not repeated over the whole image
// unless search.anywhere says so, which is the costly part.
CornerFit fitCorners(Pyramid &image, const std::vector<Pattern> &topLeft,
                     const std::vector<Pattern> &bottomRight,
                     const CornerSearch &search);
CornerFit fitCorners(const cv::Mat &image, const std::vector<cv::Mat> &topLeft,
                     const std::vector<cv::Mat> &bottomRight,
                     const CornerSearch &search);
} // namespace firefly
