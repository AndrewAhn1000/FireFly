#include "graph.hpp"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <vector>
#ifdef FIREFLY_WINDOWS_OCR
#include "ocr_windows.hpp"
#endif
int main(int argc, char **argv) {
  try {
#ifdef FIREFLY_WINDOWS_OCR
    firefly::installWindowsOcr(); // so ocr nodes read text like the runtime's
#endif
    if (argc < 2 || argc > 5)
      throw std::runtime_error("Usage: firefly-graph graph.json [image.png "
                               "[display.png [preview-node]]]");
    std::ifstream file(argv[1]);
    if (!file)
      throw std::runtime_error("Cannot open graph file");
    std::string input;
    char c;
    while (file.get(c)) {
      if (input.size() >= 256000)
        throw std::runtime_error("Graph exceeds 256 KB");
      input += c;
    }
    firefly::Graph graph(firefly::Json::parse(input));
    if (argc == 2) {
      std::cout << graph.schema().dump(2) << '\n';
      return 0;
    }
    cv::Mat image = cv::imread(argv[2], cv::IMREAD_COLOR);
    if (image.empty())
      throw std::runtime_error("Cannot decode image");
    cv::cvtColor(image, image, cv::COLOR_BGR2BGRA);
    // display.png receives the image the runtime would show: the first
    // published BGRA image, or the preview node's value drawn over the frame
    cv::Mat display;
    auto result = graph.evaluate(image, 0.0, &display, argc == 5 ? argv[4] : "");
    // FIREFLY_GRAPH_REPEAT=N: the graph evaluated N more times on the image, and how long each took (to
    // stderr), to see what a frame costs live once models and caches are warm
    if (const char *repeat = std::getenv("FIREFLY_GRAPH_REPEAT"); repeat && std::atoi(repeat) > 0) {
      std::vector<double> times;
      for (int i = 0, n = std::atoi(repeat); i < n; ++i) {
        const auto start = std::chrono::steady_clock::now();
        graph.evaluate(image, 0.0, nullptr, "");
        times.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count());
      }
      std::sort(times.begin(), times.end());
      std::cerr << "evaluate: median " << times[times.size() / 2] << " ms, fastest " << times.front()
                << " ms, slowest " << times.back() << " ms over " << times.size() << " runs\n";
    }
    if (argc >= 4 && (display.empty() || !cv::imwrite(argv[3], display)))
      throw std::runtime_error("Graph published no displayable image");
    std::cout << result.dump(2) << '\n';
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
