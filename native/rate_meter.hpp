#pragma once
#include <deque>

namespace firefly {
// How many times a second something happens, over the last `windowMs`: new
// frames from the game, graph results, recorded samples. Times are ms on one clock.
class RateMeter {
public:
  explicit RateMeter(double windowMs = 2000) : window_(windowMs) {}
  void tick(double t) {
    times_.push_back(t);
    while (times_.size() > 2 && t - times_.front() > window_) times_.pop_front();
  }
  // 0 until there are two ticks, and once nothing has happened for a whole window
  double hz(double now) const {
    if (times_.size() < 2 || now - times_.back() > window_ || times_.back() <= times_.front()) return 0;
    return (times_.size() - 1) * 1000.0 / (times_.back() - times_.front());
  }
  void clear() { times_.clear(); }

private:
  double window_;
  std::deque<double> times_;
};
} // namespace firefly
