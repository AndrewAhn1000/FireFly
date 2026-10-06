#pragma once

namespace firefly {
// Has the ocr node read text with Windows' own text recognition (Windows.Media.Ocr),
// which needs no extra files but needs an OCR language installed in Windows.
void installWindowsOcr();
} // namespace firefly
