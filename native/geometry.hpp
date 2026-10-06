#pragma once
#include <map>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <string>
#include <vector>

namespace firefly {
// Something found in a mask: a region of pixels (box and mask), a point, a
// segment or a polyline, with named measurements such as area or width.
struct Shape {
  std::vector<cv::Point2f> points; // image coordinates
  cv::Rect box;                    // a region's bounds, in image coordinates
  cv::Mat mask;                    // a region's pixels within box, else empty
  std::map<std::string, double> props; // positions in props are frame coordinates
};

// Shapes found on an image of this size whose top-left sits at origin in the
// frame.
struct Shapes {
  cv::Size size;
  cv::Point origin;
  std::vector<Shape> items;
};

enum class Axis { Vertical, Horizontal };

// Mask of the pixels on runs along axis whose length is within [min, max]
// (max 0: no limit).
cv::Mat keepRuns(const cv::Mat &mask, Axis axis, int min, int max);
// Median length of the runs along axis no longer than max (0: no limit), or 0.
double runLength(const cv::Mat &mask, Axis axis, int max);

// Connected regions with their measurements.
Shapes regions(const cv::Mat &mask, int connectivity, int minArea,
               cv::Point origin);
cv::Mat rasterize(const Shapes &shapes, int thickness);

struct TraceOptions {
  double position = 0; // where the line sits in a band: 0 top edge .. 1 bottom
  int maxStep = 8;     // largest change of a band's top between columns
  int maxGap = 3;      // columns a band may skip before its line ends
  double stack = 1.5;  // runs this many bands tall hold two stacked bands (0: off)
  int maxBand = 0;     // cap on a line's band height (0: none)
};
// Follows horizontal bands column by column into lines (one point per column).
Shapes traceBands(const cv::Mat &mask, double typicalBand, const TraceOptions &o,
                  cv::Point origin);
// Joins lines end to start across gaps of up to maxGap columns whose ends are
// within maxRise vertically, and, given cover, only where it fills the gap.
Shapes joinGaps(Shapes lines, const cv::Mat *cover, int maxGap, double maxRise);
Shapes simplify(Shapes lines, int smooth, double epsilon);
// Straight segments of each line, in reading order: rows of rowHeight, then x.
Shapes toSegments(const Shapes &lines, int rowHeight);
// A line through each region along axis, e.g. a ladder's centre line.
Shapes axisLines(const Shapes &regions, Axis axis);
// Moves line ends vertically onto the nearest target line within tolerance.
Shapes snapEnds(Shapes lines, const Shapes &targets, double tolerance, double reach);

void drawShapes(cv::Mat &bgra, const Shapes &shapes, cv::Point offset,
                const cv::Scalar &color, int thickness, const std::string &label,
                bool boxes);
// Up to limit items as JSON objects in frame coordinates.
nlohmann::json shapesJson(const Shapes &shapes, size_t limit);
double polylineLength(const std::vector<cv::Point2f> &points);
} // namespace firefly
