#include "ocr_node.hpp"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <deque>
#include <map>
#include <mutex>
#include <opencv2/imgproc.hpp>
#include <stdexcept>
#include <vector>

namespace firefly {
namespace {
constexpr size_t kRemembered = 64; // images whose text is kept
constexpr int kLargest = 4000;     // px, of either side of a prepared image
constexpr double kReadable = 48;   // px tall: what small text is enlarged to
constexpr int kLargestScale = 6;   // enlarged no further than this when trying sizes

struct Last {
  bool read = false;
  double at = 0; // when it was last read
  std::string text, error;
};

struct State {
  std::mutex lock;
  TextRecognizer recognizer;
  OcrPacing pacing;
  std::map<uint64_t, std::string> byPixels;
  std::deque<uint64_t> order; // oldest first
  std::map<std::string, Last> last;
};

State &state() {
  static State s;
  return s;
}

double now() {
  auto &p = state().pacing;
  if (p.now)
    return p.now();
  return std::chrono::duration<double, std::milli>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void mix(uint64_t &h, const void *data, size_t size) {
  auto bytes = static_cast<const unsigned char *>(data);
  for (size_t i = 0; i < size; ++i)
    h = (h ^ bytes[i]) * 1099511628211ull; // FNV-1a
}

uint64_t fingerprint(const cv::Mat &image, const OcrOptions &o) {
  uint64_t h = 14695981039346656037ull;
  const int shape[] = {image.rows, image.cols, image.channels(), image.type(),
                       o.scale};
  mix(h, shape, sizeof shape);
  mix(h, o.language.data(), o.language.size());
  mix(h, o.invert.data(), o.invert.size());
  mix(h, o.accuracy.data(), o.accuracy.size());
  for (int r = 0; r < image.rows; ++r)
    mix(h, image.ptr(r), image.cols * image.elemSize());
  return h;
}

std::string tidy(std::string text) {
  text.erase(std::remove(text.begin(), text.end(), '\r'), text.end());
  const auto plain = [](unsigned char c) { return !std::isspace(c); };
  auto first = std::find_if(text.begin(), text.end(), plain);
  auto last = std::find_if(text.rbegin(), text.rend(), plain).base();
  return first < last ? std::string(first, last) : std::string();
}

// How much a box this tall is enlarged, unless it is told
int chosenScale(int rows) {
  return std::clamp((int)std::ceil(kReadable / std::max(1, rows)), 1, 4);
}

// The sizes around s that are worth a try, nearest first, larger before smaller
std::vector<int> neighbours(int s) {
  std::vector<int> sizes;
  for (int step : {1, -1, 2, -2})
    if (s + step >= 1 && s + step <= kLargestScale)
      sizes.push_back(s + step);
  return sizes;
}

// The text in an image. blank: the reader's last image had none, so an empty read
// isn't tried again.
std::string recognizeText(const TextRecognizer &recognize, const cv::Mat &image,
                          const OcrOptions &options, bool blank) {
  const std::string language = options.language == "auto" ? "" : options.language;
  const auto at = [&](int scale) {
    OcrOptions sized = options;
    sized.scale = scale;
    return tidy(recognize(prepareForOcr(image, sized), language));
  };
  const int center = options.scale > 0 ? options.scale : chosenScale(image.rows);
  const auto nearby = neighbours(center);
  std::string text = at(options.scale); // 0: the size chosen from the height

  if (options.accuracy != "careful") {
    // Nothing found: the size above, then the size below
    for (size_t i = 0; text.empty() && options.scale == 0 && !blank && i < 2 && i < nearby.size(); ++i)
      text = at(nearby[i]);
    return text;
  }
  if (text.empty() && blank)
    return "";
  // The answer most of the five nearest sizes give; a tie goes to the earliest read
  std::vector<std::pair<std::string, int>> votes;
  if (!text.empty())
    votes.push_back({text, 1});
  for (size_t i = 0; i < 4 && i < nearby.size(); ++i) {
    const auto other = at(nearby[i]);
    if (other.empty())
      continue;
    auto same = std::find_if(votes.begin(), votes.end(), [&](auto &v) { return v.first == other; });
    if (same != votes.end())
      ++same->second;
    else
      votes.push_back({other, 1});
  }
  if (votes.empty())
    return "";
  return std::max_element(votes.begin(), votes.end(), [](auto &a, auto &b) { return a.second < b.second; })->first;
}
} // namespace

cv::Mat prepareForOcr(const cv::Mat &image, const OcrOptions &o) {
  if (image.empty() || image.depth() != CV_8U)
    throw std::runtime_error("Text can only be read from an 8-bit image");
  const bool mask = image.channels() == 1;
  cv::Mat gray;
  if (image.channels() == 4)
    cv::cvtColor(image, gray, cv::COLOR_BGRA2GRAY);
  else if (image.channels() == 3)
    cv::cvtColor(image, gray, cv::COLOR_BGR2GRAY);
  else if (mask)
    gray = image.clone();
  else
    throw std::runtime_error("Text can only be read from a colour image or a mask");

  bool flip = o.invert == "on";
  if (o.invert == "auto") {
    if (mask) {
      flip = true; // the text is what is on
    } else {
      // The text is the lighter tone when that is the minority of the box
      cv::Mat tones;
      cv::threshold(gray, tones, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);
      flip = cv::countNonZero(tones) * 2 < (int)gray.total();
    }
  }
  if (flip)
    cv::bitwise_not(gray, gray);
  if (!mask)
    cv::normalize(gray, gray, 0, 255, cv::NORM_MINMAX);

  int scale = o.scale > 0 ? o.scale : chosenScale(gray.rows);
  const int border = 8 + 2 * scale;
  while (scale > 1 && (std::max(gray.cols, gray.rows) * scale + 2 * border > kLargest))
    --scale;
  if (scale > 1)
    cv::resize(gray, gray, cv::Size(), scale, scale,
               mask ? cv::INTER_LINEAR : cv::INTER_CUBIC);
  cv::copyMakeBorder(gray, gray, border, border, border, border,
                     cv::BORDER_CONSTANT, cv::Scalar(255));
  cv::Mat bgra;
  cv::cvtColor(gray, bgra, cv::COLOR_GRAY2BGRA);
  return bgra;
}

void setTextRecognizer(TextRecognizer recognizer) {
  std::lock_guard lock(state().lock);
  state().recognizer = std::move(recognizer);
}

OcrPacing &ocrPacing() { return state().pacing; }

std::string readText(const std::string &key, const cv::Mat &image,
                     const OcrOptions &options) {
  if (image.empty())
    throw std::runtime_error("There is no image to read");
  auto &s = state();
  TextRecognizer recognize;
  double every;
  {
    std::lock_guard lock(s.lock);
    recognize = s.recognizer;
    every = s.pacing.everyMs;
  }
  if (!recognize)
    throw std::runtime_error("Text recognition is not available here");

  const uint64_t pixels = fingerprint(image, options);
  bool blank = false; // the last read of this reader found no text
  {
    std::lock_guard lock(s.lock);
    if (auto known = s.byPixels.find(pixels); known != s.byPixels.end())
      return known->second;
    const Last &last = s.last[key];
    const double since = now() - last.at; // negative if the clock was set back
    if (last.read && since >= 0 && since < every) {
      if (!last.error.empty())
        throw std::runtime_error(last.error);
      return last.text;
    }
    blank = last.read && last.error.empty() && last.text.empty();
  }

  std::string text, error;
  try {
    text = recognizeText(recognize, image, options, blank);
  } catch (const std::exception &e) {
    error = e.what();
  }
  {
    std::lock_guard lock(s.lock);
    s.last[key] = {true, now(), text, error};
    if (error.empty() && s.byPixels.emplace(pixels, text).second) {
      s.order.push_back(pixels);
      if (s.order.size() > kRemembered) {
        s.byPixels.erase(s.order.front());
        s.order.pop_front();
      }
    }
  }
  if (!error.empty())
    throw std::runtime_error(error);
  return text;
}
} // namespace firefly
