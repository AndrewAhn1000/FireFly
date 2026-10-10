#pragma once
#include "capture.hpp"
#include "graph.hpp"
#include "template_match.hpp"
#include <deque>
#include <map>

namespace firefly {
// What one region follows, as template.set gave it. Its templates are prepared
// once here and shared by every job until the region's next template.set.
struct Track {
  std::string region, context;
  std::map<std::string, Pattern> templates;
  // An object whose size changes is followed by its corners instead: patches
  // of its top-left and bottom-right, and the box stretches between them.
  std::vector<Pattern> topLeft, bottomRight;
  cv::Point2d largest{1, 1};        // biggest the object can be, as fractions of the frame
  std::optional<cv::Rect2d> start;  // where its box was when it was set, the same way (corners: its top-left)
  bool multi = false;
  Look look = Look::Color; // what it's matched on; its patterns were prepared this way
  double threshold = .75;
  // How far from where the object was last found to look for it, in frame px: how far its centre
  // (its top-left corner, followed by corners) may move. Negative looks through the whole frame
  // every time. Multi-match always looks through the whole frame.
  int reach = -1;
  // Where an object not within its reach is looked for: further and further out in the same frame until
  // it's found or the whole frame is searched (false), or one step further out each frame it isn't found,
  // back to its reach once it is (true): a frame costs less, and a lost object takes a few frames to find.
  bool widenEachFrame = false;
  // How much further out each step looks: its reach times this (a reach of under 16 px grows from 16)
  double widenBy = 2;
  bool fitting() const { return !multi && !topLeft.empty() && !bottomRight.empty(); }
  bool empty() const { return !fitting() && templates.empty(); }
};
using Tracks = std::vector<std::shared_ptr<const Track>>;
struct TrackingJob {
  uint64_t generation = 0;
  std::shared_ptr<const CapturedFrame> frame;
  std::shared_ptr<const Tracks> tracks;
};
struct TrackingResult {
  uint64_t generation;
  std::shared_ptr<const CapturedFrame> frame;
  Json match = nullptr; // the template.match event: every region's result in this frame
  double elapsedMs = 0;
  std::string error;
};
// Template matching, run by its own worker so that neither it nor the
// observation graph waits for the other. Every region is matched in the same
// frame, which is converted and shrunk once for all of them. Each result also
// says where the box's centre is and how fast it moves (`position`, `velocity`).
// Only accessed by that one worker; where a region's object was is kept until
// the region's context or the generation changes.
class Tracker {
public:
  TrackingResult operator()(TrackingJob job);
private:
  struct History {
    std::string context;
    std::optional<cv::Rect> last; // where the object was last found, in frame px
    std::string winner;           // the template it was found as, which keeps winning unless clearly beaten
    std::deque<std::pair<double, cv::Point2d>> path; // where the box's centre was lately: (capture ms, px)
    int widened = -1; // widening each frame: how far the last frame looked without finding it; -1 once found
  };
  Json follow(const Track &track, History &history, Pyramid &pyramid, const CapturedFrame &frame);
  uint64_t generation_ = 0;
  std::map<std::string, History> history_;
};
}
