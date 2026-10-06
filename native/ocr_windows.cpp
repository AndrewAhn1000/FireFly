#include "ocr_windows.hpp"
#include "ocr_node.hpp"
#include <chrono>
#include <map>
#include <mutex>
#include <stdexcept>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>

namespace firefly {
namespace {
using namespace winrt::Windows::Graphics::Imaging;
using namespace winrt::Windows::Media::Ocr;
using winrt::Windows::Globalization::Language;

std::string installed() {
  std::string tags;
  for (auto language : OcrEngine::AvailableRecognizerLanguages())
    tags += (tags.empty() ? "" : ", ") + winrt::to_string(language.LanguageTag());
  return tags;
}

// One engine per language, made when first needed. An empty tag means the user's
// languages, or else whichever OCR language is installed.
OcrEngine engineFor(const std::string &tag) {
  static std::mutex lock;
  static std::map<std::string, OcrEngine> engines;
  std::lock_guard guard(lock);
  if (auto known = engines.find(tag); known != engines.end())
    return known->second;
  OcrEngine engine{nullptr};
  if (tag.empty()) {
    engine = OcrEngine::TryCreateFromUserProfileLanguages();
    if (!engine)
      for (auto language : OcrEngine::AvailableRecognizerLanguages())
        if ((engine = OcrEngine::TryCreateFromLanguage(language)))
          break;
    if (!engine)
      throw std::runtime_error(
          "Windows has no OCR language installed. Add one in Settings > Time & "
          "language > Language & region: choose a language, then its options, "
          "and install Optical character recognition.");
  } else {
    Language language{winrt::to_hstring(tag)};
    if (OcrEngine::IsLanguageSupported(language))
      engine = OcrEngine::TryCreateFromLanguage(language);
    if (!engine) {
      const auto have = installed();
      throw std::runtime_error(
          "Windows has no OCR language " + tag + " installed" +
          (have.empty() ? "" : " (installed: " + have + ")") +
          ". Add it in Settings > Time & language > Language & region, and install Optical character recognition for it.");
    }
  }
  engines.emplace(tag, engine);
  return engine;
}

std::string recognize(const cv::Mat &bgra, const std::string &language) {
  // The engine is used from whichever thread reads, which needs an apartment (the runtime
  // has one already; a tool or a test may not)
  thread_local const bool ready = [] {
    try {
      winrt::init_apartment();
    } catch (const winrt::hresult_error &) {
    }
    return true;
  }();
  (void)ready;
  try {
    auto engine = engineFor(language);
    const uint32_t largest = OcrEngine::MaxImageDimension();
    if (bgra.type() != CV_8UC4 || !bgra.isContinuous() ||
        (uint32_t)bgra.cols > largest || (uint32_t)bgra.rows > largest)
      throw std::runtime_error("The image is too big to read text from");
    winrt::Windows::Storage::Streams::DataWriter writer;
    writer.WriteBytes(winrt::array_view<const uint8_t>(
        bgra.data, bgra.data + bgra.total() * bgra.elemSize()));
    auto bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        writer.DetachBuffer(), BitmapPixelFormat::Bgra8, bgra.cols, bgra.rows,
        BitmapAlphaMode::Premultiplied);
    auto reading = engine.RecognizeAsync(bitmap);
    if (reading.wait_for(std::chrono::seconds(10)) !=
        winrt::Windows::Foundation::AsyncStatus::Completed)
      throw std::runtime_error("Text recognition took too long");
    std::string text;
    for (auto line : reading.GetResults().Lines()) {
      if (!text.empty())
        text += '\n';
      text += winrt::to_string(line.Text());
    }
    return text;
  } catch (const winrt::hresult_error &e) {
    throw std::runtime_error("Windows text recognition failed: " +
                             winrt::to_string(e.message()));
  }
}
} // namespace

void installWindowsOcr() { setTextRecognizer(recognize); }
} // namespace firefly
