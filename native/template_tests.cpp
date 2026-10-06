#include "template_fit.hpp"
#include "template_match.hpp"
#include <functional>
#include <iostream>
#include <opencv2/imgproc.hpp>
using firefly::CornerFit;
using firefly::CornerSearch;

static void check(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}

constexpr int kCorner = 12;

static cv::Mat noise(int width, int height, uint64_t seed) {
  cv::Mat image(height, width, CV_8UC3);
  cv::RNG(seed).fill(image, cv::RNG::UNIFORM, 0, 256);
  return image;
}

// A window whose size changes: its interior is different each time, like the
// preview of a map, but its corners look the same at every size
static void panel(cv::Mat &frame, cv::Rect box, uint64_t interior) {
  noise(box.width, box.height, interior).copyTo(frame(box));
  cv::rectangle(frame, box, cv::Scalar(255, 255, 255), 2);
  noise(kCorner, kCorner, 1)
      .copyTo(frame(cv::Rect(box.x, box.y, kCorner, kCorner)));
  noise(kCorner, kCorner, 2)
      .copyTo(frame(cv::Rect(box.x + box.width - kCorner,
                             box.y + box.height - kCorner, kCorner, kCorner)));
}

// The patches the app cuts from the corners of a box drawn around the object
static std::vector<cv::Mat> topLeft, bottomRight;
static void snap(const cv::Mat &frame, cv::Rect box) {
  topLeft = {frame(cv::Rect(box.x, box.y, kCorner, kCorner)).clone()};
  bottomRight = {frame(cv::Rect(box.x + box.width - kCorner,
                                box.y + box.height - kCorner, kCorner, kCorner))
                     .clone()};
}

static bool same(const CornerFit &fit, cv::Rect box) {
  return fit.found && fit.box == box;
}

int main() {
  int passed = 0;
  auto test = [&](const char *name, std::function<void()> fn) {
    try {
      fn();
      std::cout << "PASS " << name << '\n';
      ++passed;
    } catch (const std::exception &e) {
      std::cerr << "FAIL " << name << ": " << e.what() << '\n';
      std::exit(1);
    }
  };
  const cv::Rect original(40, 30, 200, 120);
  {
    cv::Mat reference = noise(640, 360, 7);
    panel(reference, original, 11);
    snap(reference, original);
  }
  auto search = [] {
    CornerSearch s;
    s.was = {40, 30};
    s.largest = {600, 360};
    return s;
  };
  auto frameWith = [](std::function<void(cv::Mat &)> draw) {
    cv::Mat frame = noise(640, 360, 8);
    draw(frame);
    return frame;
  };

  test("the box is the object at its size when it is unchanged", [&] {
    auto frame = frameWith([&](cv::Mat &f) { panel(f, original, 12); });
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(same(fit, original), "Box is not the panel");
    check(fit.topLeft > 0.95 && fit.bottomRight > 0.95, "Weak corner scores");
  });
  test("the box shrinks to an object that got smaller", [&] {
    cv::Rect smaller(40, 30, 120, 70);
    auto frame = frameWith([&](cv::Mat &f) { panel(f, smaller, 13); });
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(same(fit, smaller), "Box did not shrink to the panel");
  });
  test("the box grows to an object that got bigger", [&] {
    cv::Rect bigger(40, 30, 380, 260);
    auto frame = frameWith([&](cv::Mat &f) { panel(f, bigger, 14); });
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(same(fit, bigger), "Box did not grow to the panel");
  });
  test("a box that moved and changed size is found by looking everywhere", [&] {
    cv::Rect moved(310, 150, 150, 90);
    auto frame = frameWith([&](cv::Mat &f) { panel(f, moved, 15); });
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(same(fit, moved), "Moved panel not found");
    auto fixed = search();
    fixed.anywhere = false;
    check(!firefly::fitCorners(frame, topLeft, bottomRight, fixed).found,
          "Looked beyond its reach when told not to");
  });
  test("other objects with the same corners don't pull the box away", [&] {
    cv::Rect mine(40, 30, 120, 70), other(250, 20, 180, 140);
    auto frame = frameWith([&](cv::Mat &f) {
      panel(f, other, 16);
      panel(f, mine, 17);
    });
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(same(fit, mine), "Followed another object");
    auto elsewhere = search();
    elsewhere.was = {250, 20};
    check(same(firefly::fitCorners(frame, topLeft, bottomRight, elsewhere),
               other),
          "Did not follow the object it was left on");
    // A lone bottom-right corner that a scan would meet before the real one
    // (higher up) but that is further from the top-left corner
    noise(kCorner, kCorner, 2).copyTo(frame(cv::Rect(500, 60, kCorner, kCorner)));
    check(same(firefly::fitCorners(frame, topLeft, bottomRight, search()), mine),
          "Took a bottom-right corner that was further away");
  });
  test("nothing is found where the corners are not", [&] {
    auto frame = frameWith([](cv::Mat &) {});
    auto fit = firefly::fitCorners(frame, topLeft, bottomRight, search());
    check(!fit.found, "Found a panel in noise");
    // one corner alone is not an object
    frame = frameWith([&](cv::Mat &f) {
      noise(kCorner, kCorner, 1).copyTo(f(cv::Rect(40, 30, kCorner, kCorner)));
    });
    check(!firefly::fitCorners(frame, topLeft, bottomRight, search()).found,
          "Found an object from one corner");
  });
  test("an object bigger than it can be is not found", [&] {
    cv::Rect huge(40, 30, 400, 300);
    auto frame = frameWith([&](cv::Mat &f) { panel(f, huge, 18); });
    auto s = search();
    s.largest = {300, 200};
    check(!firefly::fitCorners(frame, topLeft, bottomRight, s).found,
          "Found an object past the limit");
    s.largest = {500, 400};
    check(same(firefly::fitCorners(frame, topLeft, bottomRight, s), huge),
          "Missed an object within the limit");
  });
  test("a patch with no detail is not looked for", [&] {
    cv::Mat flat(kCorner, kCorner, CV_8UC3, cv::Scalar(90, 120, 40));
    cv::Mat frame(200, 200, CV_8UC3, cv::Scalar(90, 120, 40));
    check(firefly::findPeaks(frame, flat, cv::Rect(0, 0, 200, 200), 0.5, 4)
              .empty(),
          "Matched a flat patch");
  });
  test("a place is reported once, not once for each neighbour", [&] {
    cv::Mat frame = noise(200, 100, 9);
    auto patch = frame(cv::Rect(20, 10, kCorner, kCorner)).clone();
    patch.copyTo(frame(cv::Rect(150, 60, kCorner, kCorner)));
    auto peaks =
        firefly::findPeaks(frame, patch, cv::Rect(0, 0, 200, 100), 0.9, 6);
    check(peaks.size() == 2, "Wrong number of places");
    check(peaks[0].at != peaks[1].at, "The same place twice");
  });
  test("a search area past the image is clipped", [&] {
    cv::Mat frame = noise(100, 100, 3);
    auto patch = frame(cv::Rect(80, 80, kCorner, kCorner)).clone();
    auto peaks =
        firefly::findPeaks(frame, patch, cv::Rect(60, 60, 500, 500), 0.9, 1);
    check(peaks.size() == 1 && peaks[0].at == cv::Point(80, 80),
          "Clipped search lost the place");
    check(firefly::findPeaks(frame, patch, cv::Rect(300, 300, 50, 50), 0.9, 1)
              .empty(),
          "Found something outside the image");
  });
  // What a region matches on: colour, brightness alone, or edges
  auto scoreIn = [](const cv::Mat &frame, const cv::Mat &templ, firefly::Look look) {
    firefly::Pyramid pyramid(firefly::prepareLook(frame, look));
    std::map<std::string, firefly::Pattern> one;
    one.emplace("t", firefly::patternFor(templ, look));
    auto hits = firefly::matchTemplates(pyramid, one, 0, 1, 1);
    return hits.empty() ? std::make_pair(cv::Rect(), 0.0) : std::make_pair(hits[0].box, hits[0].confidence);
  };
  test("grayscale and edges are one channel, and a flat patch has no edges to match", [&] {
    auto image = noise(40, 30, 3);
    check(firefly::prepareLook(image, firefly::Look::Color).type() == CV_8UC3, "Colour changed");
    check(firefly::prepareLook(image, firefly::Look::Gray).type() == CV_8UC1, "Grayscale isn't one channel");
    auto edges = firefly::prepareLook(image, firefly::Look::Edges);
    check(edges.type() == CV_8UC1 && edges.size() == image.size(), "Edges aren't one channel the same size");
    cv::Mat flat(30, 40, CV_8UC3, cv::Scalar(40, 120, 200));
    check(cv::countNonZero(firefly::prepareLook(flat, firefly::Look::Edges)) == 0, "A flat patch has edges");
    check(!firefly::Pattern(firefly::prepareLook(flat, firefly::Look::Edges)).detail, "A patch with no edges would be looked for");
  });
  test("grayscale matches a pose in another colour that colour misses", [&] {
    // The same sprite in red tones as a template, and in blue tones in the frame
    cv::Mat shade = noise(24, 20, 21), gray;
    cv::cvtColor(shade, gray, cv::COLOR_BGR2GRAY);
    cv::GaussianBlur(gray, gray, cv::Size(3, 3), 0);
    auto tone = [&](cv::Scalar weights) {
      std::vector<cv::Mat> channels(3);
      for (int c = 0; c < 3; ++c) gray.convertTo(channels[c], CV_8U, weights[c]);
      cv::Mat out; cv::merge(channels, out); return out;
    };
    cv::Mat frame = noise(160, 100, 22);
    cv::Rect at(90, 50, 24, 20);
    tone({1, .3, .3}).copyTo(frame(at));           // blue (BGR)
    const auto templ = tone({.3, .3, 1});            // red
    auto [colorAt, color] = scoreIn(frame, templ, firefly::Look::Color);
    auto [grayAt, grayScore] = scoreIn(frame, templ, firefly::Look::Gray);
    check(grayAt == at && grayScore > .95, "Grayscale didn't find the recoloured sprite");
    check(color < .75 && grayScore - color > .2, "Colour should have scored the other colour lower");
  });
  test("every look copes with an object lit unevenly, as in a darker part of a map", [&] {
    // A textured, outlined sprite, then the same with its light falling off from 100% to 25% across it.
    // Measured, colour and grayscale both score it 0.88, and edges (without the template's border) too.
    cv::Mat body;
    cv::GaussianBlur(noise(28, 28, 41), body, cv::Size(5, 5), 0);
    cv::rectangle(body, cv::Rect(2, 2, 24, 24), cv::Scalar(10, 10, 10), 2);
    cv::line(body, {6, 14}, {22, 14}, cv::Scalar(10, 10, 10), 2);
    cv::Mat lit = body.clone();
    for (int x = 0; x < lit.cols; ++x) lit.col(x).convertTo(lit.col(x), -1, 1.0 - 0.75 * x / (lit.cols - 1));
    cv::Mat frame;
    cv::GaussianBlur(noise(200, 120, 43), frame, cv::Size(5, 5), 0);
    cv::Rect at(120, 60, 28, 28);
    lit.copyTo(frame(at));
    auto [colorAt, color] = scoreIn(frame, body, firefly::Look::Color);
    auto [grayAt, grayScore] = scoreIn(frame, body, firefly::Look::Gray);
    auto [edgesAt, edges] = scoreIn(frame, body, firefly::Look::Edges);
    check(colorAt == at && grayAt == at && edgesAt == at, "A look didn't find the unevenly lit object");
    check(edges > .8 && color > .8 && grayScore > .8, ("Uneven light cost too much: colour " + std::to_string(color) + ", gray "
          + std::to_string(grayScore) + ", edges " + std::to_string(edges)).c_str());
    // Leaving a template's border out is what makes edges work: an identical sprite matches fully
    cv::Mat same = frame.clone();
    body.copyTo(same(at));
    auto [sameAt, sameEdges] = scoreIn(same, body, firefly::Look::Edges);
    check(sameAt == at && sameEdges > .97, ("An identical sprite by edges: " + std::to_string(sameEdges)).c_str());
  });
  test("every look copes with an object on a flat ground of another colour", [&] {
    // A shape drawn in dark outlines, taken on a light grey ground, now in front of a blue one in a
    // busy scene. Its outlines stand out less there, but they're the same shape, and a flat ground
    // has no edges either way, whatever its colour. (No look survives contrast reversing, such as a
    // light line that was invisible on the ground it was taken on.)
    auto sprite = [](cv::Scalar ground) {
      cv::Mat s(28, 28, CV_8UC3, ground);
      cv::rectangle(s, cv::Rect(4, 4, 20, 20), cv::Scalar(20, 20, 20), 2);
      cv::line(s, {8, 14}, {20, 14}, cv::Scalar(20, 20, 20), 2);
      cv::circle(s, {14, 9}, 3, cv::Scalar(20, 20, 20), -1);
      cv::GaussianBlur(s, s, cv::Size(3, 3), 0);
      return s;
    };
    cv::Mat frame;
    cv::GaussianBlur(noise(200, 120, 31), frame, cv::Size(5, 5), 0); // a scene with detail, not pixel noise
    cv::Rect at(120, 60, 28, 28);
    sprite(cv::Scalar(160, 110, 60)).copyTo(frame(at));
    const auto templ = sprite(cv::Scalar(200, 200, 200));
    auto [colorAt, color] = scoreIn(frame, templ, firefly::Look::Color);
    auto [edgesAt, edges] = scoreIn(frame, templ, firefly::Look::Edges);
    auto [grayAt, grayScore] = scoreIn(frame, templ, firefly::Look::Gray);
    check(colorAt == at && grayAt == at && edgesAt == at, ("A look didn't find the object on its new ground: colour " + std::to_string(colorAt.x) + ","
          + std::to_string(colorAt.y) + " gray " + std::to_string(grayAt.x) + "," + std::to_string(grayAt.y) + " edges " + std::to_string(edgesAt.x) + ","
          + std::to_string(edgesAt.y) + " " + std::to_string(edgesAt.width) + "x" + std::to_string(edgesAt.height) + " score " + std::to_string(edges)).c_str());
    check(color > .8 && grayScore > .8 && edges > .8, ("A look scored the object on its new ground too low: edges " + std::to_string(edges)).c_str());
  });
  test("a mask leaves a template's background out, so a sprite on another background still matches", [&] {
    // A round sprite taken on one scene, found in front of another: without a mask the old scene's
    // pixels in the template's corners count against it
    cv::Mat body; cv::GaussianBlur(noise(40, 40, 61), body, cv::Size(5, 5), 0);
    cv::Mat shape(40, 40, CV_8UC1, cv::Scalar(0));
    cv::circle(shape, {20, 20}, 16, cv::Scalar(255), -1);
    auto onScene = [&](uint64_t seed) {
      cv::Mat out; cv::GaussianBlur(noise(40, 40, seed), out, cv::Size(5, 5), 0);
      body.copyTo(out, shape);
      return out;
    };
    const cv::Mat templ = onScene(62);
    cv::Mat frame; cv::GaussianBlur(noise(220, 140, 63), frame, cv::Size(5, 5), 0);
    const cv::Rect at(130, 70, 40, 40);
    onScene(64).copyTo(frame(at));
    auto score = [&](const cv::Mat &mask) {
      firefly::Pyramid pyramid(frame);
      std::map<std::string, firefly::Pattern> one;
      one.emplace("t", firefly::patternFor(templ, firefly::Look::Color, mask));
      auto hits = firefly::matchTemplates(pyramid, one, 0, 1, 1);
      return hits.empty() ? std::make_pair(cv::Rect(), 0.0) : std::make_pair(hits[0].box, hits[0].confidence);
    };
    auto [plainAt, plain] = score({});
    auto [maskedAt, masked] = score(shape);
    check(maskedAt == at && masked > .98, ("Masked, the sprite wasn't found fully: " + std::to_string(masked)).c_str());
    check(masked - plain > .15, ("The mask should have helped: " + std::to_string(plain) + " -> " + std::to_string(masked)).c_str());
    // A mask that keeps everything is none, one that keeps almost nothing can't match anything, and a
    // masked template is still found by edges and in the smaller copy (a wide search)
    check(firefly::Pattern(templ, cv::Mat(40, 40, CV_8UC1, cv::Scalar(255))).mask.empty(), "A mask keeping everything was kept");
    cv::Mat speck(40, 40, CV_8UC1, cv::Scalar(0)); speck(cv::Rect(0, 0, 3, 3)).setTo(255);
    check(!firefly::Pattern(templ, speck).detail, "A mask of 9 pixels would be looked for");
    firefly::Pyramid edges(firefly::prepareLook(frame, firefly::Look::Edges));
    std::map<std::string, firefly::Pattern> e; e.emplace("t", firefly::patternFor(templ, firefly::Look::Edges, shape));
    auto edgeHits = firefly::matchTemplates(edges, e, 0, 1, 1);
    check(!edgeHits.empty() && edgeHits[0].box == at, "A masked template wasn't found by its edges");
  });
  test("strongest template wins before the instance limit, not first key", [&] {
    cv::Mat frame = noise(160, 100, 55);
    cv::Rect at(60, 40, 18, 14);
    auto exact = frame(at).clone();
    auto weaker = exact.clone();
    noise(5, 5, 75).copyTo(weaker(cv::Rect(0, 0, 5, 5)));
    auto hits = firefly::matchTemplates(frame, {{"a-weaker", weaker}, {"z-exact", exact}}, .7, 1);
    check(hits.size() == 1 && hits[0].templateId == "z-exact" && hits[0].box == at,
          "The earlier weaker template won");
    auto reversed = firefly::matchTemplates(frame, {{"z-weaker", weaker}, {"a-exact", exact}}, .7, 1);
    check(reversed.size() == 1 && reversed[0].templateId == "a-exact",
          "Ranking depends on key order");
  });
  test("the template that won keeps the place unless another is clearly better", [&] {
    cv::Mat frame = noise(160, 100, 56);
    cv::Rect at(60, 40, 18, 14);
    auto exact = frame(at).clone();
    auto close = exact.clone(), far = exact.clone();
    noise(3, 3, 76).copyTo(close(cv::Rect(0, 0, 3, 3)));
    noise(9, 9, 77).copyTo(far(cv::Rect(0, 0, 9, 9)));
    firefly::Pyramid pyramid(frame);
    std::map<std::string, firefly::Pattern> templates;
    templates.emplace("exact", firefly::Pattern(exact));
    templates.emplace("close", firefly::Pattern(close));
    templates.emplace("far", firefly::Pattern(far));
    auto plain = firefly::matchTemplates(pyramid, templates, 0, 3, 1);
    check(plain[0].templateId == "exact", "The best template didn't win");
    // Only one template owns a place, so each one's score there is taken on its own
    auto alone = [&](const char *id) {
      std::map<std::string, firefly::Pattern> one;
      one.emplace(id, templates.at(id));
      return firefly::matchTemplates(pyramid, one, 0, 1, 1)[0].confidence;
    };
    const double best = plain[0].confidence, closeScore = alone("close"), farScore = alone("far");
    check(farScore < closeScore && closeScore < best, "The test's templates don't score as intended");
    // A margin bigger than its shortfall keeps the winner in place, a smaller one doesn't
    auto kept = firefly::matchTemplates(pyramid, templates, 0, 3, 1, {}, {"close", best - closeScore + .01, .1});
    check(kept[0].templateId == "close" && kept[0].confidence == closeScore, "A nearly-as-good winner lost its place");
    auto beaten = firefly::matchTemplates(pyramid, templates, 0, 3, 1, {}, {"far", (best - farScore) / 2, .1});
    check(beaten[0].templateId == "exact", "A clearly better template didn't take over");
    auto under = firefly::matchTemplates(pyramid, templates, 0, 3, 1, {}, {"close", best - closeScore + .01, closeScore + .001});
    check(under[0].templateId == "exact", "A winner under the threshold kept its place");
    // Last frame's template matching a lookalike somewhere else doesn't take the box there, however big the margin
    auto elsewhere = noise(18, 14, 78);
    elsewhere.copyTo(frame(cv::Rect(10, 70, 18, 14)));
    noise(4, 4, 79).copyTo(frame(cv::Rect(10, 70, 4, 4)));
    firefly::Pyramid moved(frame);
    templates.emplace("elsewhere", firefly::Pattern(elsewhere));
    auto away = firefly::matchTemplates(moved, templates, 0, 4, 1, {}, {"elsewhere", .5, .1});
    check(away[0].templateId == "exact" && away[0].box == at, "A preferred template pulled the box onto a lookalike");
  });
  test("multiple templates compete per instance and keep their identities", [&] {
    auto a = noise(18, 14, 80), b = noise(18, 14, 90);
    cv::Mat frame = noise(160, 100, 20);
    a.copyTo(frame(cv::Rect(10, 10, 18, 14)));
    a.copyTo(frame(cv::Rect(50, 10, 18, 14)));
    b.copyTo(frame(cv::Rect(100, 60, 18, 14)));
    auto weaker = a.clone();
    noise(4, 4, 75).copyTo(weaker(cv::Rect(0, 0, 4, 4)));
    auto hits = firefly::matchTemplates(frame, {{"a-weaker", weaker}, {"b", b}, {"z-a", a}}, .7, 50);
    check(hits.size() == 3, "Duplicate or missing instances across templates");
    int aCount = 0, bCount = 0;
    double previous = 2;
    for (const auto &hit : hits) {
      check(hit.confidence <= previous, "Matches are not confidence-ranked");
      previous = hit.confidence;
      aCount += hit.templateId == "z-a"; bCount += hit.templateId == "b";
    }
    check(aCount == 2 && bCount == 1, "Wrong winning template identities");
  });
  test("template may equal frame size and flat templates never match everywhere", [&] {
    auto frame = noise(20, 20, 37);
    auto hits = firefly::matchTemplates(frame, {{"same", frame}}, .9, 50);
    check(hits.size() == 1 && hits[0].box == cv::Rect(0, 0, 20, 20), "Equal-size match lost");
    cv::Mat flat(5, 5, CV_8UC3, cv::Scalar(20, 50, 80));
    check(firefly::matchTemplates(frame, {{"flat", flat}}, .5, 50).empty(), "Flat false positive");
    check(firefly::matchTemplates(frame, {{"other", noise(12, 12, 2)}}, .99, 50).empty(), "Absent template matched");
  });
  // Larger templates are looked for in a smaller copy of the frame first. A
  // place there is at most a pixel or two off, so it's scored again at full size.
  auto scene = [](int width, int height, uint64_t seed) {
    cv::Mat image = noise(width, height, seed);
    cv::GaussianBlur(image, image, {0, 0}, 1.5); // neighbouring pixels alike, as in a game
    return image;
  };
  test("a large template is found where it is, at every offset of the smaller copy", [&] {
    for (int dx = 0; dx < 8; ++dx) {
      cv::Mat frame = scene(640, 360, 60);
      auto templ = scene(64, 48, 61 + dx);
      const cv::Rect at(200 + dx, 150 + 3 * dx % 8, 64, 48);
      templ.copyTo(frame(at));
      firefly::Pattern pattern(templ);
      check(pattern.level > 0, "The template was not shrunk, so this tests nothing");
      auto hits = firefly::matchTemplates(frame, {{"t", templ}}, .45, 1);
      check(hits.size() == 1 && hits[0].box == at && hits[0].confidence > .999,
            "Missed or misplaced by the smaller copy");
    }
  });
  test("every copy of a sprite is found, each once", [&] {
    cv::Mat frame = scene(800, 450, 70);
    auto sprite = scene(32, 32, 71);
    const std::vector<cv::Point> places{{13, 7}, {101, 40}, {250, 251}, {251, 330}, {600, 99}, {767, 417}};
    for (auto p : places) sprite.copyTo(frame(cv::Rect(p, sprite.size())));
    auto hits = firefly::matchTemplates(frame, {{"s", sprite}}, .9, 50);
    check(hits.size() == places.size(), "Wrong number of copies");
    for (auto p : places)
      check(std::any_of(hits.begin(), hits.end(), [&](auto &h) { return h.box.tl() == p; }),
            "A copy was missed");
  });
  test("scores in the smaller copy agree with a full-size search", [&] {
    cv::Mat frame = scene(640, 360, 80);
    for (int i = 0; i < 12; ++i) {
      const cv::Rect at(17 * i + 9, 11 * i + 5, 40 + i, 30 + i);
      auto templ = frame(at).clone();
      cv::Mat shifted; // a little different from what's in the frame
      cv::add(templ, cv::Scalar::all(i % 3 * 4), shifted);
      cv::Mat scores;
      cv::matchTemplate(frame, shifted, scores, cv::TM_CCOEFF_NORMED);
      double best; cv::Point where;
      cv::minMaxLoc(scores, nullptr, &best, nullptr, &where);
      auto hits = firefly::matchTemplates(frame, {{"t", shifted}}, .45, 1);
      check(hits.size() == 1 && hits[0].box.tl() == where && std::abs(hits[0].confidence - best) < 1e-3,
            "Not the full-size search's best place");
    }
  });
  std::cout << passed << " template tests passed\n";
}
