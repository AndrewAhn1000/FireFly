#pragma once
#include "capture.hpp"
#include "graph.hpp"

namespace firefly {
// Extract only drawing pixels, leaving the captured background transparent.
// Empty means no compatible drawing. The live capture never waits for this work.
cv::Mat drawingLayer(const cv::Mat &frame, const cv::Mat &annotated);
struct DetectionJob {
  uint64_t generation = 0, recordingGeneration = 0;
  std::shared_ptr<const CapturedFrame> frame;
  std::shared_ptr<const Graph> graph;
  std::string preview;
  Json probes = Json::array(); // memory and Lua States read as this frame was sent (see main.cpp)
  // When it was sent (monotonicMs), after reading the probes, which took probesMs: for observations' latency
  double submittedAt = 0, probesMs = 0;
};
struct DetectionResult {
  uint64_t generation, recordingGeneration;
  std::shared_ptr<const CapturedFrame> frame;
  Json observations = nullptr;
  Json probes = Json::array();
  cv::Mat overlay;
  double elapsedMs = 0;
  std::string error;
  // Where the time went (monotonicMs, see DetectionJob): sent, the worker starting on it and done with it, and the
  // main loop taking it
  double submittedAt = 0, probesMs = 0, startedAt = 0, finishedAt = 0, takenAt = 0;
};
// Evaluates the observation graph. Template matching has a worker of its own (tracking.hpp).
class Detector {
public:
  DetectionResult operator()(DetectionJob job);
};
}
