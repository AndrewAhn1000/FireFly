#include "detection.hpp"
#include <chrono>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#ifdef _WIN32
#include <winrt/base.h>
#endif

namespace firefly {
cv::Mat drawingLayer(const cv::Mat &frame, const cv::Mat &annotated) {
  if (frame.empty() || annotated.empty() || frame.type() != CV_8UC4 ||
      annotated.type() != CV_8UC4 || frame.size() != annotated.size()) return {};
  cv::Mat layer = cv::Mat::zeros(frame.size(), CV_8UC4);
  bool changed = false;
  for (int y = 0; y < frame.rows; ++y) {
    const auto *source = frame.ptr<cv::Vec4b>(y), *drawn = annotated.ptr<cv::Vec4b>(y);
    auto *out = layer.ptr<cv::Vec4b>(y);
    for (int x = 0; x < frame.cols; ++x) {
      if (source[x][0] != drawn[x][0] || source[x][1] != drawn[x][1] || source[x][2] != drawn[x][2]) {
        out[x] = {drawn[x][0], drawn[x][1], drawn[x][2], 255};
        changed = true;
      }
    }
  }
  return changed ? layer : cv::Mat{};
}

static std::string pngUrl(const cv::Mat &image) {
  std::vector<uchar> bytes;
  if (!cv::imencode(".png", image, bytes, {cv::IMWRITE_PNG_COMPRESSION, 1}))
    throw std::runtime_error("Could not encode detection drawings");
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string url = "data:image/png;base64,";
  url.reserve(url.size() + ((bytes.size() + 2) / 3) * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    uint32_t n = uint32_t(bytes[i]) << 16;
    if (i + 1 < bytes.size()) n |= uint32_t(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) n |= bytes[i + 2];
    url += alphabet[(n >> 18) & 63]; url += alphabet[(n >> 12) & 63];
    url += i + 1 < bytes.size() ? alphabet[(n >> 6) & 63] : '=';
    url += i + 2 < bytes.size() ? alphabet[n & 63] : '=';
  }
  return url;
}

DetectionResult Detector::operator()(DetectionJob job) {
  DetectionResult out{job.generation, job.recordingGeneration, job.frame};
  out.probes = std::move(job.probes);
  const auto begin = std::chrono::steady_clock::now();
  try {
#ifdef _WIN32
    // OCR's WinRT calls now run on the detection thread.
    thread_local const bool apartment = [] { winrt::init_apartment(winrt::apartment_type::multi_threaded); return true; }();
    (void)apartment;
#endif
    const auto &frame = *job.frame;
    cv::Mat bgra(frame.height, frame.width, CV_8UC4, const_cast<uint8_t *>(frame.bgra.data()));
    if (job.graph) {
      out.observations = job.graph->evaluate(bgra, frame.timestamp, &out.overlay, job.preview);
      out.observations["latencyMs"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
      out.observations["displayOverlay"] = nullptr;
      // Step previews intentionally replace the processed image; they must not
      // become an opaque mask over the independent live capture.
      if (job.preview.empty()) {
        auto layer = drawingLayer(bgra, out.overlay);
        if (!layer.empty()) out.observations["displayOverlay"] = {
          {"dataUrl", pngUrl(layer)}, {"width", frame.width}, {"height", frame.height},
          {"timestamp", frame.timestamp}};
      }
    }
  } catch (const std::exception &e) { out.error = e.what(); }
  out.elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - begin).count();
  if (!out.observations.is_null()) {
    out.observations["detectionMs"] = out.elapsedMs;
    out.observations["timestamp"] = job.frame->timestamp;
  }
  return out;
}
}
