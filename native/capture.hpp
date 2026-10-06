#pragma once
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
struct CapturedFrame {
  uint32_t width, height;
  double timestamp;
  std::vector<uint8_t> bgra;
};
struct CaptureError : std::runtime_error {
  std::string code;
  CaptureError(std::string code, const std::string &message)
      : std::runtime_error(message), code(std::move(code)) {}
};
class CaptureSource {
public:
  virtual ~CaptureSource() = default;
  virtual void start(uintptr_t window) = 0;
  virtual void stop() noexcept = 0;
  virtual std::optional<CapturedFrame> next() = 0;
};
std::unique_ptr<CaptureSource> makeCaptureSource();
