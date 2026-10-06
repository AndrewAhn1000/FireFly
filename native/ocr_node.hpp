#pragma once
#include <functional>
#include <opencv2/core.hpp>
#include <string>

namespace firefly {
struct OcrOptions {
  std::string language = "auto"; // a tag such as en-US, or auto for the user's languages
  int scale = 0;                 // enlarge by this much; 0 picks one from the size
  std::string invert = "auto";   // "auto", "on" or "off": see prepareForOcr
  std::string accuracy = "normal"; // "careful" reads at five sizes and takes the majority
};

// The image a recognizer is given, 8-bit BGRA. Recognizers read dark text on a
// light ground best, and small text badly, so a mask (whose nonzero pixels are
// the text) is inverted, a colour image is inverted when its text is the
// lighter of its two tones, dim text has its contrast stretched, and the
// image is enlarged (by options.scale, or so that small text is about
// 48 px tall) and given a light border.
cv::Mat prepareForOcr(const cv::Mat &image, const OcrOptions &options);

// Recognizes the text in a prepared image: language is a tag, or empty for the
// user's languages. Lines are joined by newlines. Throws with a reason it
// can't, such as no language being installed.
using TextRecognizer =
    std::function<std::string(const cv::Mat &bgra, const std::string &language)>;
void setTextRecognizer(TextRecognizer recognizer);

// Reads the text in an image (a colour image, or a one-channel mask) with the
// recognizer set. The result is remembered by the pixels, so a box that isn't
// changing costs nothing, and an image that keeps changing is only read every
// OcrPacing::everyMs, the text in between being the last read: recognition
// takes tens of milliseconds and must not hold up every frame. key tells the
// readers apart.
//
// Recognizers read text at one size that they miss or misread at the next.
// So when the size is left automatic and nothing is found, the image is read
// again at the sizes around the chosen one (unless the reader's last image was
// blank too, which isn't worth the effort), and with accuracy "careful" it is
// read at the five sizes around the chosen one and the answer most of them
// give is kept. A read takes a few milliseconds.
std::string readText(const std::string &key, const cv::Mat &image,
                     const OcrOptions &options);

struct OcrPacing {
  double everyMs = 250;
  std::function<double()> now; // milliseconds; the steady clock when empty
};
OcrPacing &ocrPacing();
} // namespace firefly
