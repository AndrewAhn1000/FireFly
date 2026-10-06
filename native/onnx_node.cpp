#include "onnx_node.hpp"
#include <atomic>
#include <stdexcept>

namespace firefly {
static std::atomic<int> threadsForCpu{2};
void setCpuThreads(int threads) {
  if (threads < 1 || threads > 256) throw std::runtime_error("CPU threads must be 1..256");
  threadsForCpu = threads;
}
int cpuThreads() { return threadsForCpu; }
} // namespace firefly

#ifdef FIREFLY_ONNX

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <mutex>
#include <onnxruntime_cxx_api.h>
#include <opencv2/imgproc.hpp>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
static std::wstring toOrtPath(const std::string &s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}
#else
static std::string toOrtPath(const std::string &s) { return s; }
#endif

#ifdef FIREFLY_DIRECTML
#include <d3d12.h>
#include <dxgi1_2.h>
#include <dml_provider_factory.h>
#endif

namespace firefly {
namespace {

static Ort::Env &ortEnv() {
  static Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "firefly");
  return env;
}

struct CachedSession {
  Ort::Session session;
  int64_t inferH, inferW;
  std::string inputName, outputName; // a detector's own (images, output0); segment's are fixed
  static Ort::SessionOptions options(const std::string &provider, int device, int threads) {
    Ort::SessionOptions opts;
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    // As many threads as chosen for the CPU (2 by default, leaving capacity for capture, template
    // matching and the UI); a GPU keeps 2 for what it hands back. Don't busy-spin between runs.
    opts.SetIntraOpNumThreads(provider == "cpu" ? threads : 2);
    opts.AddConfigEntry("session.intra_op.allow_spinning", "0");
    if (provider == "directml") {
#ifdef FIREFLY_DIRECTML
      opts.DisableMemPattern();
      opts.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
      Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(opts, device));
#else
      throw std::runtime_error("GPU inference is unavailable in this build. Install the DirectML runtime and rebuild, or select CPU.");
#endif
    } else if (provider != "cpu") throw std::runtime_error("Unknown inference provider: " + provider);
    return opts;
  }
  explicit CachedSession(const std::string &path, const std::string &provider, int device, int threads)
      : session(ortEnv(), toOrtPath(path).c_str(), options(provider, device, threads)) {
    auto shape =
        session.GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
    // Expected shape [batch, 3, H, W] — static spatial dims from train_unet.py
    inferH = (shape.size() >= 3 && shape[2] > 0) ? shape[2] : 512;
    inferW = (shape.size() >= 4 && shape[3] > 0) ? shape[3] : 512;
    Ort::AllocatorWithDefaultOptions allocator;
    inputName = session.GetInputNameAllocated(0, allocator).get();
    outputName = session.GetOutputNameAllocated(0, allocator).get();
  }
};

static std::mutex cacheMu;
static std::map<std::string, std::shared_ptr<CachedSession>> cache;

std::shared_ptr<CachedSession> getSession(const std::string &modelPath, const std::string &provider, int device) {
  std::lock_guard lock(cacheMu);
  const int threads = provider == "cpu" ? cpuThreads() : 2;
  const auto key = provider + ":" + std::to_string(device) + ":" + std::to_string(threads) + ":" + modelPath;
  auto it = cache.find(key);
  if (it != cache.end())
    return it->second;
  auto s = std::make_shared<CachedSession>(modelPath, provider, device, threads);
  if (cache.size() >= 4) cache.erase(cache.begin());
  cache[key] = s;
  return s;
}

} // namespace

cv::Mat segmentOnnx(const std::string &modelPath, const cv::Mat &bgra,
                    float threshold, const std::string &provider, int device) {
  if (bgra.empty() || bgra.type() != CV_8UC4)
    throw std::runtime_error("segment: input must be BGRA8");

  auto sess = getSession(modelPath, provider, device);
  const int origH = bgra.rows, origW = bgra.cols;
  const int inferH = (int)sess->inferH, inferW = (int)sess->inferW;

  // Letterbox to the model input the same way the training crops were built
  // (wz extractor preprocess.py): scale to fit keeping the aspect ratio,
  // centre, pad with black. Stretching instead distorts vertical vs horizontal
  // scale, which the model was never trained on.
  const double scale =
      std::min((double)inferW / origW, (double)inferH / origH);
  const int fitW = std::clamp((int)std::lround(origW * scale), 1, inferW);
  const int fitH = std::clamp((int)std::lround(origH * scale), 1, inferH);
  const int padX = (inferW - fitW) / 2, padY = (inferH - fitH) / 2;

  cv::Mat resized(inferH, inferW, CV_8UC4, cv::Scalar::all(0));
  if (fitW != origW || fitH != origH)
    // INTER_AREA when shrinking: antialiased like the PIL resizes used in training.
    cv::resize(bgra, resized(cv::Rect(padX, padY, fitW, fitH)),
               cv::Size(fitW, fitH), 0, 0,
               scale < 1.0 ? cv::INTER_AREA : cv::INTER_LINEAR);
  else
    bgra.copyTo(resized(cv::Rect(padX, padY, fitW, fitH)));

  // BGRA -> RGB float [0, 1]
  cv::Mat rgb;
  cv::cvtColor(resized, rgb, cv::COLOR_BGRA2RGB);
  cv::Mat flt;
  rgb.convertTo(flt, CV_32F, 1.0 / 255.0);

  // ImageNet normalization per channel
  static constexpr float mean[3] = {0.485f, 0.456f, 0.406f};
  static constexpr float stdv[3] = {0.229f, 0.224f, 0.225f};
  std::vector<cv::Mat> ch(3);
  cv::split(flt, ch);
  for (int c = 0; c < 3; ++c)
    ch[c] = (ch[c] - mean[c]) / stdv[c];

  // Pack into [1, 3, H, W] contiguous float32 tensor (CHW layout)
  std::vector<float> tensor((size_t)3 * inferH * inferW);
  for (int c = 0; c < 3; ++c) {
    cv::Mat cont;
    ch[c].convertTo(cont, CV_32F);
    std::copy(cont.ptr<float>(), cont.ptr<float>() + (size_t)inferH * inferW,
              tensor.data() + (size_t)c * inferH * inferW);
  }

  Ort::MemoryInfo mem =
      Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeCPU);
  std::array<int64_t, 4> inShape{1, 3, inferH, inferW};
  Ort::Value inTensor = Ort::Value::CreateTensor<float>(
      mem, tensor.data(), tensor.size(), inShape.data(), 4);

  const char *inNames[]  = {"image"};
  const char *outNames[] = {"logits"};
  auto outputs = sess->session.Run(Ort::RunOptions{}, inNames, &inTensor, 1,
                                   outNames, 1);

  // Apply sigmoid + threshold -> 0/255 single-channel mask
  auto outShape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
  const int outH = (int)outShape[2], outW = (int)outShape[3];
  const float *logits = outputs[0].GetTensorData<float>();
  cv::Mat mask(outH, outW, CV_8UC1);
  for (int i = 0; i < outH * outW; ++i) {
    float prob = 1.0f / (1.0f + std::exp(-logits[i]));
    mask.data[i] = (prob >= threshold) ? 255u : 0u;
  }

  // Drop the letterbox padding, then resize back to the original frame.
  const cv::Rect content(padX * outW / inferW, padY * outH / inferH,
                         std::max(1, fitW * outW / inferW),
                         std::max(1, fitH * outH / inferH));
  cv::Mat out;
  cv::resize(mask(content), out, cv::Size(origW, origH), 0, 0,
             cv::INTER_NEAREST);
  return out;
}

std::vector<Detection> detectOnnx(const std::string &modelPath, const cv::Mat &bgra, float confidence, float iou,
                                  const std::string &provider, int device) {
  if (bgra.empty() || bgra.type() != CV_8UC4)
    throw std::runtime_error("detect: input must be BGRA8");
  auto sess = getSession(modelPath, provider, device);
  const int origH = bgra.rows, origW = bgra.cols;
  const int inferH = (int)sess->inferH, inferW = (int)sess->inferW;

  // Fitted in as Ultralytics' LetterBox does in training and prediction: aspect kept, centred, grey 114 around
  const double scale = std::min((double)inferW / origW, (double)inferH / origH);
  const int fitW = std::clamp((int)std::lround(origW * scale), 1, inferW);
  const int fitH = std::clamp((int)std::lround(origH * scale), 1, inferH);
  const int padX = (inferW - fitW) / 2, padY = (inferH - fitH) / 2;
  cv::Mat rgb;
  cv::cvtColor(bgra, rgb, cv::COLOR_BGRA2RGB);
  cv::Mat canvas(inferH, inferW, CV_8UC3, cv::Scalar::all(114));
  if (fitW != origW || fitH != origH)
    cv::resize(rgb, canvas(cv::Rect(padX, padY, fitW, fitH)), cv::Size(fitW, fitH), 0, 0, cv::INTER_LINEAR);
  else
    rgb.copyTo(canvas(cv::Rect(padX, padY, fitW, fitH)));

  // [1, 3, H, W] float RGB 0..1, no other normalisation
  std::vector<float> tensor((size_t)3 * inferH * inferW);
  const size_t plane = (size_t)inferH * inferW;
  for (int y = 0; y < inferH; ++y) {
    const uchar *row = canvas.ptr<uchar>(y);
    for (int x = 0; x < inferW; ++x)
      for (int c = 0; c < 3; ++c)
        tensor[c * plane + (size_t)y * inferW + x] = row[x * 3 + c] / 255.0f;
  }
  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeCPU);
  std::array<int64_t, 4> inShape{1, 3, inferH, inferW};
  Ort::Value inTensor = Ort::Value::CreateTensor<float>(mem, tensor.data(), tensor.size(), inShape.data(), 4);
  const char *inNames[] = {sess->inputName.c_str()};
  const char *outNames[] = {sess->outputName.c_str()};
  auto outputs = sess->session.Run(Ort::RunOptions{}, inNames, &inTensor, 1, outNames, 1);

  // A box from the model's input pixels back to the frame's, inside it
  auto toFrame = [&](float x1, float y1, float x2, float y2) {
    x1 = std::clamp((float)((x1 - padX) / scale), 0.0f, (float)origW);
    x2 = std::clamp((float)((x2 - padX) / scale), 0.0f, (float)origW);
    y1 = std::clamp((float)((y1 - padY) / scale), 0.0f, (float)origH);
    y2 = std::clamp((float)((y2 - padY) / scale), 0.0f, (float)origH);
    return cv::Rect2f(x1, y1, x2 - x1, y2 - y1);
  };
  auto shape = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
  const float *out = outputs[0].GetTensorData<float>();
  if (shape.size() != 3 || shape[0] != 1)
    throw std::runtime_error("detect: expected a [1, 4 + classes, anchors] output (a YOLO detection model)");
  std::vector<Detection> found;
  if (shape[2] == 6 && shape[1] <= 1000) {
    // End-to-end: the model already kept one box per object
    for (int64_t i = 0; i < shape[1]; ++i) {
      const float *d = out + i * 6;
      if (d[4] >= confidence) found.push_back({(int)d[5], d[4], toFrame(d[0], d[1], d[2], d[3])});
    }
  } else {
    const int64_t classes = shape[1] - 4, anchors = shape[2];
    if (classes < 1) throw std::runtime_error("detect: the model's output has no classes");
    for (int64_t j = 0; j < anchors; ++j) {
      int cls = 0;
      float best = out[4 * anchors + j];
      for (int64_t k = 1; k < classes; ++k)
        if (float v = out[(4 + k) * anchors + j]; v > best) { best = v; cls = (int)k; }
      if (best < confidence) continue;
      const float cx = out[j], cy = out[anchors + j], w = out[2 * anchors + j], h = out[3 * anchors + j];
      found.push_back({cls, best, toFrame(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)});
    }
  }
  // Of overlapping boxes of a class, the surest (non-maximum suppression); at most 300
  std::sort(found.begin(), found.end(), [](const Detection &a, const Detection &b) { return a.confidence > b.confidence; });
  std::vector<Detection> kept;
  for (const auto &d : found) {
    if (d.box.width < 1 || d.box.height < 1) continue;
    bool overlaps = false;
    for (const auto &k : kept) {
      if (k.cls != d.cls) continue;
      const float inter = (d.box & k.box).area();
      if (inter / (d.box.area() + k.box.area() - inter) > iou) { overlaps = true; break; }
    }
    if (!overlaps) kept.push_back(d);
    if (kept.size() >= 300) break;
  }
  return kept;
}

nlohmann::json inferenceDevices() {
  nlohmann::json devices = nlohmann::json::array({{{"id", "cpu"}, {"provider", "cpu"}, {"device", 0}, {"label", "CPU"}}});
#ifdef FIREFLY_DIRECTML
  IDXGIFactory1 *factory = nullptr;
  if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
    IDXGIAdapter1 *adapter = nullptr;
    for (UINT i = 0; SUCCEEDED(factory->EnumAdapters1(i, &adapter)); ++i) {
      DXGI_ADAPTER_DESC1 desc{};
      if (SUCCEEDED(adapter->GetDesc1(&desc)) && !(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) &&
          SUCCEEDED(D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), nullptr))) {
        char name[512]{};
        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof(name), nullptr, nullptr);
        devices.push_back({{"id", "directml:" + std::to_string(i)}, {"provider", "directml"},
          {"device", i}, {"label", std::string("GPU · ") + name + " (DirectML)"}});
      }
      adapter->Release(); adapter = nullptr;
    }
    factory->Release();
  }
#endif
  return devices;
}

} // namespace firefly

#else // FIREFLY_ONNX not defined

namespace firefly {
cv::Mat segmentOnnx(const std::string &, const cv::Mat &, float, const std::string &, int) {
  throw std::runtime_error(
      "ONNX Runtime not installed. Run: npm run native:onnxruntime");
}
std::vector<Detection> detectOnnx(const std::string &, const cv::Mat &, float, float, const std::string &, int) {
  throw std::runtime_error(
      "ONNX Runtime not installed. Run: npm run native:onnxruntime");
}
nlohmann::json inferenceDevices() { return nlohmann::json::array(); }
} // namespace firefly

#endif
