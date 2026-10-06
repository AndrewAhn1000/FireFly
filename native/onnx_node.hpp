#pragma once
#include <opencv2/core.hpp>
#include <string>
#include <nlohmann/json.hpp>

namespace firefly {
// Run a UNet ONNX model exported by train_unet.py on a BGRA8 frame.
// Sessions are cached by model path, provider and adapter; GPU failures are explicit.
// The frame is letterboxed (aspect preserved, black padding) to the model input,
// matching how the training crops were built.
// Returns a single-channel CV_8UC1 mask (0 or 255), same size as bgra.
cv::Mat segmentOnnx(const std::string &modelPath, const cv::Mat &bgra,
                    float threshold, const std::string &provider = "cpu", int device = 0);
// A box a detector found: its class (an index into the model's class names), how sure it is, and where, in the
// frame's pixels
struct Detection { int cls; float confidence; cv::Rect2f box; };
// Run a YOLO detector exported by Ultralytics (train_yolo.py) on a BGRA8 frame: an [N, 3, H, W] RGB 0..1 input,
// the frame fitted in as YOLO trains (aspect kept, centred, grey 114 around it), and either the raw
// [1, 4 + classes, anchors] output or an end-to-end [1, n, 6] one (x1 y1 x2 y2 score class). Boxes under
// confidence are dropped, and of boxes of one class overlapping more than iou (intersection over union) only the
// surest is kept. Sessions are cached as segment's are.
std::vector<Detection> detectOnnx(const std::string &modelPath, const cv::Mat &bgra, float confidence, float iou,
                                  const std::string &provider = "cpu", int device = 0);
nlohmann::json inferenceDevices();
// How many threads a model runs on with the CPU (default 2): a setting of the runtime, not of the
// graph, so changing it doesn't change what a recording's schema says it holds. Sessions made with
// another count are made again on their next frame.
void setCpuThreads(int threads);
int cpuThreads();
} // namespace firefly
