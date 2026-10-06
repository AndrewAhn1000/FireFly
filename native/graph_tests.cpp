#include "graph.hpp"
#include "ocr_node.hpp"
#include <cmath>
#include <functional>
#include <iostream>
#include <opencv2/imgproc.hpp>
using firefly::Json;
static void check(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}
static Json node(std::string id, std::string op, Json inputs = Json::array(),
                 Json params = Json::object()) {
  if (inputs.is_null())
    inputs = Json::array();
  return {{"id", id}, {"op", op}, {"inputs", inputs}, {"params", params}};
}
static Json definition(Json nodes) {
  return {{"version", 1}, {"id", "test"}, {"revision", 1}, {"nodes", nodes}};
}
static Json vision() {
  return definition(
      Json::array({node("f", "frame"),
                   node("c", "crop", {"f"},
                        {{"x", 2}, {"y", 3}, {"width", 4}, {"height", 4}}),
                   node("t", "threshold", {"c"},
                        {{"rMin", 200},
                         {"rMax", 255},
                         {"gMin", 0},
                         {"gMax", 10},
                         {"bMin", 0},
                         {"bMax", 10}}),
                   node("m", "coverage", {"t"}), node("v", "centroid", {"t"}),
                   node("o", "publish", {"m"}, {{"name", "coverage"}}),
                   node("p", "publish", {"v"}, {{"name", "position"}})}));
}
static Json value(const Json &result, const std::string &name) {
  for (auto &item : result["observations"])
    if (item["name"] == name)
      return item;
  throw std::runtime_error("Missing observation");
}
static void reject(const Json &graph) {
  try {
    firefly::Graph g(graph);
  } catch (const std::exception &) {
    return;
  }
  throw std::runtime_error("Invalid graph accepted");
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
  cv::Mat frame(10, 10, CV_8UC4, cv::Scalar(0, 0, 0, 255));
  cv::rectangle(frame, cv::Rect(3, 4, 2, 2), cv::Scalar(0, 0, 255, 255),
                cv::FILLED);
  test("actual OpenCV crop threshold coverage and source centroid", [&] {
    auto r = firefly::Graph(vision()).evaluate(frame, 123.5);
    check(value(r, "coverage")["value"] == 0.25, "Wrong coverage");
    check(value(r, "position")["value"] == Json({3.5, 4.5}),
          "Centroid lost crop origin");
    check(value(r, "position")["timestamp"] == 123.5, "Timestamp drift");
  });
  test("graph serialization round trip and topological ordering", [&] {
    auto g = vision();
    std::reverse(g["nodes"].begin(), g["nodes"].end());
    firefly::Graph a(g), b(Json::parse(g.dump()));
    check(a.evaluate(frame, 1) == b.evaluate(frame, 1), "Reload differs");
  });
  test("resized frame invalidates crop and dependent observations", [&] {
    auto r = firefly::Graph(vision()).evaluate(cv::Mat(2, 2, CV_8UC4), 2);
    check(!value(r, "coverage")["valid"].get<bool>(),
          "Out-of-bounds crop accepted");
  });
  test("empty mask produces invalid centroid not fabricated origin", [&] {
    cv::Mat empty(10, 10, CV_8UC4, cv::Scalar(0, 0, 0, 255));
    auto r = firefly::Graph(vision()).evaluate(empty, 3);
    check(value(r, "coverage")["value"] == 0, "Empty coverage not zero");
    check(!value(r, "position")["valid"].get<bool>(), "Empty centroid valid");
  });
  test("cycles missing inputs duplicate ids and names rejected", [&] {
    auto g = vision();
    g["nodes"][0]["inputs"] = {"o"};
    reject(g);
    g = vision();
    g["nodes"][1]["inputs"] = {"missing"};
    reject(g);
    g = vision();
    g["nodes"].push_back(g["nodes"][0]);
    reject(g);
    g = vision();
    g["nodes"][6]["params"]["name"] = "coverage";
    reject(g);
  });
  test("type mismatch and bad parameter bounds rejected", [&] {
    auto g = vision();
    g["nodes"][1]["inputs"] = {"m"};
    reject(g);
    g = vision();
    g["nodes"][1]["params"]["width"] = 0;
    reject(g);
    g = vision();
    g["nodes"][2]["params"]["rMin"] = 999;
    reject(g);
    g = vision();
    g["nodes"][2]["params"]["rMin"] = 2.5;
    reject(g);
  });
  test("unsupported format and unbounded graphs rejected", [&] {
    auto g = vision();
    g["version"] = 2;
    reject(g);
    g = vision();
    g["revision"] = 0;
    reject(g);
    g = vision();
    for (int i = 0; i < 257; ++i) // past the 256 nodes a graph may have
      g["nodes"].push_back(node("extra" + std::to_string(i), "frame"));
    reject(g);
  });
  test("math comparison boolean and normalization", [&] {
    auto g = definition(
        Json::array({node("a", "number", {}, {{"value", 3}}),
                     node("b", "number", {}, {{"value", 2}}),
                     node("c", "multiply", {"a", "b"}),
                     node("d", "normalize", {"c"}, {{"min", 0}, {"max", 10}}),
                     node("e", "greater", {"c", "a"}), node("f", "not", {"e"}),
                     node("o", "publish", {"d"}, {{"name", "number"}}),
                     node("p", "publish", {"f"}, {{"name", "boolean"}})}));
    auto r = firefly::Graph(g).evaluate(frame, 4);
    check(std::abs(value(r, "number")["value"].get<double>() - .6) < 1e-12,
          "Bad normalization");
    check(value(r, "boolean")["value"] == false, "Bad Boolean");
  });
  test("division by zero invalidates downstream", [&] {
    auto g = definition(
        Json::array({node("a", "number", {}, {{"value", 1}}),
                     node("b", "number", {}, {{"value", 0}}),
                     node("d", "divide", {"a", "b"}),
                     node("o", "publish", {"d"}, {{"name", "ratio"}})}));
    check(!value(firefly::Graph(g).evaluate(frame, 5), "ratio")["valid"]
               .get<bool>(),
          "Divide by zero valid");
  });
  test("vector distance and explicit schema", [&] {
    auto g = definition(
        Json::array({node("a", "vector", {}, {{"x", 0}, {"y", 0}}),
                     node("b", "vector", {}, {{"x", 3}, {"y", 4}}),
                     node("d", "distance", {"a", "b"}),
                     node("o", "publish", {"d"}, {{"name", "distance"}})}));
    firefly::Graph compiled(g);
    check(value(compiled.evaluate(frame, 6), "distance")["value"] == 5,
          "Wrong distance");
    check(compiled.schema()["fields"][0]["type"] == "number", "Wrong schema");
  });
  test("grayscale mean and image output metadata", [&] {
    auto g = definition(
        Json::array({node("f", "frame"), node("g", "grayscale", {"f"}),
                     node("m", "mean", {"g"}),
                     node("o", "publish", {"m"}, {{"name", "luma"}}),
                     node("p", "publish", {"g"}, {{"name", "image"}})}));
    auto r = firefly::Graph(g).evaluate(
        cv::Mat(3, 4, CV_8UC4, cv::Scalar(255, 255, 255, 255)), 7);
    check(value(r, "luma")["value"] == 1, "Bad mean");
    check(value(r, "image")["value"]["channels"] == 1,
          "Bad grayscale metadata");
  });
  test("text parsing and bounded Lua calculations", [&] {
    auto g = definition(
        Json::array({node("t", "text", {}, {{"value", "12.5"}}),
                     node("a", "parse_number", {"t"}),
                     node("b", "number", {}, {{"value", 2}}),
                     node("l", "lua", {"a", "b"}, {{"code", "return a * b"}}),
                     node("o", "publish", {"l"}, {{"name", "result"}})}));
    check(value(firefly::Graph(g).evaluate(frame, 8), "result")["value"] == 25,
          "Lua result incorrect");
    for (const auto *code :
         {"while true do end",
          "local x={} for i=1,10000 do x[i]={i,i,i,i} end return 1",
          "return os.execute('anything')", "return 0/0", "return 'bad'"}) {
      g["nodes"][3]["params"]["code"] = code;
      check(!value(firefly::Graph(g).evaluate(frame, 8), "result")["valid"]
                 .get<bool>(),
            "Lua limit or validation missing");
    }
    g["nodes"][3]["params"]["code"] = "return a";
    g["nodes"][0]["params"]["value"] = "12x";
    check(!value(firefly::Graph(g).evaluate(frame, 8), "result")["valid"]
               .get<bool>(),
          "Partial numeric text accepted");
  });
  // The platforms & ladders template, as the app compiles it, on masks drawn
  // like the wz extractor's: 24 px platform bands whose walking line is 6 px
  // below the top, 44 px ladders and 10 px ropes.
  auto platformer = [] {
    return definition(Json::array(
        {node("f", "frame"), node("g", "grayscale", {"f"}),
         node("clean.1", "morph", {"g"},
              {{"operation", "close"}, {"width", 3}, {"height", 5}}),
         node("band.1", "run_length", {"clean.1"},
              {{"direction", "vertical"}, {"max", 40}}),
         node("ladderRegions.1", "runs", {"clean.1"},
              {{"direction", "vertical"}, {"min", 41}}),
         node("ladderRegions.2", "components", {"ladderRegions.1"}),
         node("ladderRegions.3", "filter", {"ladderRegions.2", "band.1"},
              {{"variable", "band"},
               {"expression",
                "meanWidth >= 4 and meanWidth <= 80 and fill >= 0.65 and "
                "((touchesTop or touchesBottom) and height >= meanWidth or "
                "height >= max(48, 2.5 * band) and height >= 1.8 * meanWidth)"}}),
         node("ladderMask.1", "rasterize", {"ladderRegions.3"}),
         node("platformLines.1", "combine", {"clean.1", "ladderMask.1"},
              {{"operation", "subtract"}}),
         node("platformLines.2", "trace", {"platformLines.1", "band.1"},
              {{"position", 0.25}, {"maxStep", 8}, {"maxGap", 3},
               {"stack", 1.5}, {"maxBand", 40}}),
         node("platformLines.3", "join", {"platformLines.2", "ladderMask.1"},
              {{"maxGap", 80}, {"maxRise", 20}}),
         node("platformLines.4", "filter", {"platformLines.3"},
              {{"expression", "length >= 24 and band >= 4"}}),
         node("platforms.1", "simplify", {"platformLines.4"},
              {{"smooth", 4}, {"epsilon", 3}}),
         node("platforms.2", "segments", {"platforms.1"}, {{"rowHeight", 16}}),
         node("ladders.1", "axis_line", {"ladderRegions.3"},
              {{"direction", "vertical"}}),
         node("ladders.2", "snap", {"ladders.1", "platformLines.4"},
              {{"tolerance", 20}, {"reach", 25}}),
         node("draw.platforms", "draw_shapes", {"f", "platforms.2"},
              {{"color", "#00ff00"}, {"label", "P"}}),
         node("draw.ladders", "draw_shapes", {"draw.platforms", "ladders.2"},
              {{"color", "#ffd600"}, {"label", "L"}}),
         node("out", "publish", {"draw.ladders"}, {{"name", "annotated"}}),
         node("publish.platforms", "publish", {"platforms.2"},
              {{"name", "platforms"}}),
         node("publish.ladders", "publish", {"ladders.2"},
              {{"name", "ladders"}})}));
  };
  auto platformerOf = [&](const cv::Mat &frame, cv::Mat *display = nullptr) {
    auto r = firefly::Graph(platformer()).evaluate(frame, 1, display);
    return std::pair{value(r, "platforms")["value"], value(r, "ladders")["value"]};
  };
  auto white = cv::Scalar(255, 255, 255, 255);
  auto blank = [] { return cv::Mat(300, 400, CV_8UC4, cv::Scalar(0, 0, 0, 255)); };
  auto near = [](const Json &v, int expected, int slack = 2) {
    return std::abs(v.get<int>() - expected) <= slack;
  };
  test("platformer template splits a ladder from the platforms it joins", [&] {
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(40, 150, 321, 24), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(100, 260, 201, 24), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(180, 174, 44, 86), white, cv::FILLED);
    cv::Mat display;
    auto [platforms, ladders] = platformerOf(mask, &display);
    check(platforms.size() == 2, "Ladder split a platform in two");
    auto &top = platforms[0], &bottom = platforms[1];
    check(near(top["x1"], 40) && near(top["x2"], 360) && near(top["y1"], 156) &&
              near(top["y2"], 156),
          "Upper walking line misplaced");
    check(near(bottom["x1"], 100) && near(bottom["x2"], 300) &&
              near(bottom["y1"], 266),
          "Lower walking line misplaced");
    check(ladders.size() == 1, "Ladder not separated");
    auto &l = ladders[0];
    check(near(l["x1"], 202) && l["x1"] == l["x2"] && near(l["y1"], 156) &&
              near(l["y2"], 266) && near(l["width"], 44),
          "Ladder should run between the walking lines");
    check(display.size() == mask.size() &&
              display.at<cv::Vec4b>(156, 60) == cv::Vec4b(0, 255, 0, 255),
          "Platform not drawn");
  });
  test("platformer template chains a slope into the platform it rises from", [&] {
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(20, 200, 131, 24), white, cv::FILLED);
    std::vector<cv::Point> slope{{150, 200}, {250, 140}, {250, 164}, {150, 224}};
    cv::fillConvexPoly(mask, slope, white);
    auto [p, ladders] = platformerOf(mask);
    check(ladders.empty(), "Slope mistaken for a ladder");
    check(p.size() == 2, "Expected a flat and a sloped segment");
    check(near(p[0]["x1"], 20) && near(p[0]["y1"], 206) &&
              near(p[1]["x2"], 250) && near(p[1]["y2"], 146, 3),
          "Chain ends misplaced");
    check(p[0]["x2"] == p[1]["x1"] && p[0]["y2"] == p[1]["y1"],
          "Slope not joined to the platform");
  });
  test("platformer template keeps gaps, ropes and blobs apart", [&] {
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(20, 100, 100, 24), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(160, 100, 100, 24), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(330, 60, 10, 150), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(40, 170, 100, 100), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(300, 260, 5, 5), white, cv::FILLED);
    auto [platforms, ladders] = platformerOf(mask);
    check(ladders.size() == 1 && near(ladders[0]["x1"], 335) &&
              near(ladders[0]["width"], 10),
          "Rope not found, or blob taken for a ladder");
    int level = 0;
    for (auto &p : platforms)
      level += near(p["y1"], 106) && near(p["y2"], 106);
    check(level == 2, "Platforms across an empty gap were joined");
  });
  test("region measurements, runs and mask combination", [&] {
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(5, 6, 20, 10), white, cv::FILLED);
    for (int x : {50, 52, 54})
      cv::rectangle(mask, cv::Rect(x, 20, 1, 10), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(60, 20, 1, 50), white, cv::FILLED);
    auto r = firefly::Graph(definition(Json::array(
        {node("f", "frame"), node("g", "grayscale", {"f"}),
         node("regions", "components", {"g"}, {{"minArea", 100}}),
         node("tall", "runs", {"g"}, {{"direction", "vertical"}, {"min", 41}}),
         node("tallRegions", "components", {"tall"}),
         node("short", "run_length", {"g"}, {{"direction", "vertical"}, {"max", 40}}),
         node("both", "combine", {"g", "tall"}, {{"operation", "subtract"}}),
         node("left", "coverage", {"both"}),
         node("n", "count", {"tallRegions"}),
         node("o1", "publish", {"regions"}, {{"name", "regions"}}),
         node("o2", "publish", {"short"}, {{"name", "short"}}),
         node("o3", "publish", {"n"}, {{"name", "tall"}}),
         node("o4", "publish", {"left"}, {{"name", "left"}})})))
                 .evaluate(mask, 1);
    auto regions = value(r, "regions");
    check(regions["count"] == 1, "minArea not applied");
    auto &box = regions["value"][0];
    check(box["x"] == 5 && box["y"] == 6 && box["width"] == 20 &&
              box["height"] == 10 && box["area"] == 200 && box["fill"] == 1 &&
              box["cx"] == 14.5 && box["cy"] == 10.5 && box["touchesTop"] == 0,
          "Wrong region measurements");
    check(value(r, "short")["value"] == 10, "Wrong typical run length");
    check(value(r, "tall")["value"] == 1, "Tall run not isolated");
    check(std::abs(value(r, "left")["value"].get<double>() -
                   (200 + 30) / (300.0 * 400)) < 1e-9,
          "Subtract kept the tall run");
  });
  test("filter expressions: variables, errors and unknown fields", [&] {
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(10, 10, 30, 10), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(60, 10, 10, 30), white, cv::FILLED);
    auto graph = [&](const std::string &expression) {
      return definition(Json::array(
          {node("f", "frame"), node("g", "grayscale", {"f"}),
           node("r", "components", {"g"}), node("k", "number", {}, {{"value", 2}}),
           node("tall", "filter", {"r", "k"},
                {{"variable", "k"}, {"expression", expression}}),
           node("o", "publish", {"tall"}, {{"name", "tall"}})}));
    };
    auto tall = value(firefly::Graph(graph("height >= k * width and not touchesTop"))
                          .evaluate(mask, 1), "tall");
    check(tall["count"] == 1 && tall["value"][0]["x"] == 60, "Filter kept the wrong regions");
    for (auto bad : {"height >=", "height > (1", "height >= 2 2", "sqrt(height)",
                     "height $ 2", "min(height)"})
      reject(graph(bad));
    // The step's own result carries the reason; its observation only says the
    // input was invalid
    auto unknown = firefly::Graph(graph("heigth > 3")).evaluate(mask, 1)["nodes"]["tall"];
    check(!unknown["valid"].get<bool>() &&
              unknown["reason"].get<std::string>().find("heigth") != std::string::npos &&
              unknown["reason"].get<std::string>().find("height") != std::string::npos,
          "Unknown field not reported with the available ones");
    auto g = graph("height > 3");
    g["nodes"][2]["inputs"] = {"f"};
    check(!value(firefly::Graph(g).evaluate(mask, 1), "tall")["valid"].get<bool>(),
          "Color frame accepted as a mask");
    g = graph("height > 3");
    g["nodes"][4]["params"]["variable"] = "not a name";
    reject(g);
  });
  test("shapes are published in full and previewed on the frame", [&] {
    firefly::Graph g(platformer());
    check(g.schema()["fields"].size() == 3, "Wrong published fields");
    for (auto &field : g.schema()["fields"])
      if (field["name"] != "annotated")
        check(field["type"] == "shapes", "Wrong shapes schema");
    cv::Mat mask = blank();
    cv::rectangle(mask, cv::Rect(40, 150, 321, 24), white, cv::FILLED);
    cv::rectangle(mask, cv::Rect(180, 174, 44, 86), white, cv::FILLED);
    cv::Mat display;
    auto r = g.evaluate(mask, 1, &display, "ladderRegions.2");
    check(r["nodes"]["ladderRegions.2"]["count"] == 1 &&
              r["nodes"]["ladderRegions.2"]["value"].is_null(),
          "Debug output should only count shapes");
    check(r["preview"]["node"] == "ladderRegions.2" &&
              r["preview"]["value"][0]["width"] == 44,
          "Preview missing the node's shapes");
    check(display.size() == mask.size() &&
              display.at<cv::Vec4b>(150, 180) == cv::Vec4b(255, 229, 0, 255),
          "Preview not drawn");
    r = g.evaluate(mask, 1, &display, "clean.1");
    check(r["preview"]["coverage"].get<double>() > 0.05, "Mask preview lacks coverage");
    auto bad = platformer();
    bad["nodes"][17]["params"]["color"] = "yellow";
    reject(bad);
  });
  test("a bar read through a fractional crop, colour range and reach", [&] {
    // The bar occupies x 0.1..0.9 and y 0.2..0.8 of the frame, filled red
    // from the left to `fill`, with a gap in it like the digits drawn on a bar
    auto frame = [&](int width, int height, double fill) {
      cv::Mat f(height, width, CV_8UC4, cv::Scalar(20, 20, 20, 255));
      cv::Rect bar(std::lround(0.1 * width), std::lround(0.2 * height),
                   std::lround(0.8 * fill * width), std::lround(0.6 * height));
      cv::rectangle(f, bar, cv::Scalar(0, 0, 255, 255), cv::FILLED);
      if (fill > 0.4)
        cv::rectangle(f, cv::Rect(bar.x + bar.width / 3, bar.y, width / 25, bar.height),
                      cv::Scalar(255, 255, 255, 255), cv::FILLED);
      return f;
    };
    auto level = [&](const std::string &from) {
      return definition(Json::array(
          {node("f", "frame"),
           node("c", "crop", {"f"},
                {{"unit", "fraction"}, {"x", 0.1}, {"y", 0.2}, {"width", 0.8}, {"height", 0.6}}),
           node("t", "threshold", {"c"},
                {{"rMin", 200}, {"rMax", 255}, {"gMin", 0}, {"gMax", 60}, {"bMin", 0}, {"bMax", 60}}),
           node("r", "reach", {"t"}, {{"from", from}}),
           node("o", "publish", {"r"}, {{"name", "level"}})}));
    };
    auto read = [&](const cv::Mat &f, const std::string &from) {
      auto v = value(firefly::Graph(level(from)).evaluate(f, 1), "level");
      check(v["valid"].get<bool>(), "Reach invalid");
      return v["value"].get<double>();
    };
    for (auto [w, h] : {std::pair{100, 50}, {640, 480}, {37, 91}}) {
      check(std::abs(read(frame(w, h, 0.6), "left") - 0.6) < 0.05,
            "Bar level changed with the frame size or the gap in the bar");
      check(std::abs(read(frame(w, h, 1.0), "left") - 1.0) < 0.05, "Full bar not read as full");
      check(read(frame(w, h, 0.0), "left") == 0, "Empty bar not read as empty");
    }
    // Measured from the far edge the same bar reaches all the way across, and
    // vertically it spans the whole crop
    auto f = frame(200, 100, 0.6);
    check(std::abs(read(f, "right") - 1.0) < 0.05, "Reach from the right edge");
    check(std::abs(read(f, "top") - 1.0) < 0.05 && std::abs(read(f, "bottom") - 1.0) < 0.05,
          "Vertical reach");
    // The crop has to stay within the frame, and follows the frame's size
    auto outside = level("left");
    outside["nodes"][1]["params"]["width"] = 0.95;
    reject(outside);
    outside = level("left");
    outside["nodes"][1]["params"]["width"] = 0;
    reject(outside);
    outside = level("left");
    outside["nodes"][1]["params"]["unit"] = "percent";
    reject(outside);
    outside = level("left");
    outside["nodes"][4]["params"]["name"] = "level";
    outside["nodes"][3]["params"]["from"] = "middle";
    reject(outside);
    auto tiny = value(firefly::Graph(level("left")).evaluate(cv::Mat(2, 2, CV_8UC4, cv::Scalar(0, 0, 0, 255)), 1),
                      "level");
    check(tiny["valid"].get<bool>(), "Fractional crop should fit any frame");
    // Reach needs a mask, not a colour image
    auto colour = level("left");
    colour["nodes"][3]["inputs"] = {"c"};
    check(!value(firefly::Graph(colour).evaluate(f, 1), "level")["valid"].get<bool>(),
          "Reach accepted a colour image");
  });
  test("calculate scales, compares and takes a second number", [&] {
    auto graph = [&](const std::string &expression, bool second) {
      Json inputs = second ? Json::array({"n", "m"}) : Json::array({"n"});
      Json params = {{"expression", expression}};
      if (second)
        params["variable"] = "max";
      return definition(Json::array({node("n", "number", {}, {{"value", 0.5}}),
                                     node("m", "number", {}, {{"value", 250}}),
                                     node("c", "calculate", inputs, params),
                                     node("o", "publish", {"c"}, {{"name", "out"}})}));
    };
    cv::Mat frame(2, 2, CV_8UC4);
    auto out = [&](const Json &g) { return value(firefly::Graph(g).evaluate(frame, 1), "out"); };
    check(out(graph("value * 100", false))["value"] == 50, "Scaling");
    check(out(graph("value * max", true))["value"] == 125, "Second number");
    check(out(graph("value < 0.6", false))["value"] == 1 &&
              out(graph("value > 0.6", false))["value"] == 0,
          "Comparison should give 1 or 0");
    auto unknown = firefly::Graph(graph("value * mx", true)).evaluate(frame, 1)["nodes"]["c"];
    check(!unknown["valid"].get<bool>() &&
              unknown["reason"].get<std::string>().find("mx") != std::string::npos &&
              unknown["reason"].get<std::string>().find("max") != std::string::npos,
          "Unknown name not reported with the available ones");
    check(!out(graph("value / 0", false))["valid"].get<bool>(), "Division by zero accepted");
    for (auto bad : {"value *", "value * (2", "sqrt(value)"})
      reject(graph(bad, false));
    auto renamed = graph("value * max", true);
    renamed["nodes"][2]["params"]["variable"] = "not a name";
    reject(renamed);
    auto image = graph("value", false);
    image["nodes"][2]["inputs"] = {"o"};
    reject(image);
  });

  // Text recognition is checked against a recognizer that says what it was told to, so the
  // graph's part of it (types, settings, remembering, pacing) is tested without a language
  // pack; the real Windows recognizer is tried on real images through firefly-graph.
  auto textGraph = [](Json settings = Json::object()) {
    return definition(Json::array(
        {node("f", "frame"),
         node("c", "crop", {"f"},
              {{"x", 0}, {"y", 0}, {"width", 30}, {"height", 12}}),
         node("t", "ocr", {"c"}, settings),
         node("o", "publish", {"t"}, {{"name", "label"}})}));
  };
  auto plain = [](int shade) {
    return cv::Mat(12, 30, CV_8UC4, cv::Scalar(shade, shade, shade, 255));
  };
  auto quiet = [] {
    firefly::ocrPacing() = firefly::OcrPacing{};
    firefly::ocrPacing().everyMs = 0;
  };
  test("ocr node reads a region's text and publishes it as text", [&] {
    quiet();
    firefly::setTextRecognizer(
        [](const cv::Mat &, const std::string &) { return std::string("Rainbow Street"); });
    firefly::Graph graph(textGraph());
    auto r = graph.evaluate(plain(11), 1);
    check(value(r, "label")["value"] == "Rainbow Street", "Wrong text");
    check(value(r, "label")["type"] == "text", "Not published as text");
    check(graph.schema()["fields"][0]["type"] == "text", "Schema does not say text");
  });
  test("ocr node only takes images and valid settings", [&] {
    quiet();
    auto number = definition(Json::array({node("n", "number", Json::array(), {{"value", 1}}),
                                          node("t", "ocr", {"n"}),
                                          node("o", "publish", {"t"}, {{"name", "label"}})}));
    reject(number);
    for (Json bad : {Json({{"invert", "sideways"}}), Json({{"scale", 9}}), Json({{"scale", 1.5}}),
                     Json({{"accuracy", "reckless"}}), Json({{"language", "en_US!"}}),
                     Json({{"language", "12"}})})
      reject(textGraph(bad));
    firefly::Graph(textGraph({{"language", "en-US"}, {"scale", 3}, {"invert", "on"}}));
    firefly::Graph(textGraph({{"language", "auto"}}));
    auto fromImage = definition(Json::array({node("f", "frame"), node("n", "number_in_text", {"f"}),
                                             node("o", "publish", {"n"}, {{"name", "n"}})}));
    reject(fromImage);
  });
  test("ocr reads the same pixels once", [&] {
    quiet();
    int calls = 0;
    firefly::setTextRecognizer([&](const cv::Mat &, const std::string &) {
      return "read " + std::to_string(++calls);
    });
    firefly::Graph graph(textGraph());
    for (int i = 0; i < 3; ++i)
      check(value(graph.evaluate(plain(21), 1), "label")["value"] == "read 1", "Read again");
    check(calls == 1, "Same pixels were read more than once");
    check(value(graph.evaluate(plain(22), 1), "label")["value"] == "read 2", "New pixels not read");
    firefly::Graph other(textGraph({{"invert", "off"}}));
    other.evaluate(plain(21), 1);
    check(calls == 3, "Settings are not part of what is remembered");
  });
  test("ocr reads a changing image only every so often", [&] {
    double clock = 0;
    firefly::ocrPacing() = firefly::OcrPacing{100, [&] { return clock; }};
    int calls = 0;
    firefly::setTextRecognizer([&](const cv::Mat &, const std::string &) {
      return "read " + std::to_string(++calls);
    });
    firefly::Graph graph(textGraph());
    auto text = [&](int shade) { return value(graph.evaluate(plain(shade), 1), "label")["value"]; };
    check(text(31) == "read 1", "First read");
    clock = 50;
    check(text(32) == "read 1" && calls == 1, "A new image was read too soon");
    clock = 150;
    check(text(32) == "read 2", "A new image was not read once it was time");
    clock = 160;
    check(text(31) == "read 1" && calls == 2, "A known image should answer at once");
    quiet();
  });
  test("ocr tries an empty read again at other sizes", [&] {
    quiet();
    int calls = 0;
    std::vector<int> heights;
    // a 30 x 12 image is enlarged 4 times (80 px tall with its border); this recognizer only
    // finds the text one size up (96 px tall)
    firefly::setTextRecognizer([&](const cv::Mat &bgra, const std::string &) {
      ++calls;
      heights.push_back(bgra.rows);
      return std::string(bgra.rows == 96 ? "found" : "");
    });
    firefly::Graph graph(textGraph());
    check(value(graph.evaluate(plain(51), 1), "label")["value"] == "found", "Not found at the next size");
    check(calls == 2 && heights[0] == 80 && heights[1] == 96, "Wrong sizes tried");
    // a size that was asked for is taken as it is
    calls = 0;
    firefly::Graph fixed(textGraph({{"scale", 4}}));
    check(value(fixed.evaluate(plain(52), 1), "label")["value"] == "" && calls == 1, "A given size was retried");
    // nothing in the image: every size is tried once, then a blank box costs a read per change
    firefly::setTextRecognizer([&](const cv::Mat &, const std::string &) { ++calls; return std::string(); });
    calls = 0;
    firefly::Graph blank(definition(Json::array(
        {node("f", "frame"), node("c", "crop", {"f"}, {{"x", 0}, {"y", 0}, {"width", 30}, {"height", 12}}),
         node("blank", "ocr", {"c"}), node("o", "publish", {"blank"}, {{"name", "label"}})})));
    blank.evaluate(plain(53), 1);
    check(calls == 3, "A blank image should be tried at 3 sizes");
    blank.evaluate(plain(54), 1);
    check(calls == 4, "A blank box should cost one read once it has read blank");
  });
  test("careful ocr keeps the answer most sizes agree on", [&] {
    quiet();
    // the size chosen (4x, 80 px tall with its border) misreads the slash; the four sizes around
    // it (5x, 3x, 6x, 2x) agree
    int reads = 0;
    firefly::setTextRecognizer([&](const cv::Mat &bgra, const std::string &) {
      ++reads;
      return std::string(bgra.rows == 80 ? "81191" : "81/91");
    });
    firefly::Graph normal(textGraph());
    check(value(normal.evaluate(plain(61), 1), "label")["value"] == "81191", "Normal should take the one read");
    check(reads == 1, "Normal should read once");
    firefly::Graph careful(textGraph({{"accuracy", "careful"}}));
    reads = 0;
    check(value(careful.evaluate(plain(62), 1), "label")["value"] == "81/91", "Careful should take the majority");
    check(reads == 5, "Careful should read at five sizes");
    // and when they all differ it is the first read that counts
    firefly::setTextRecognizer([](const cv::Mat &bgra, const std::string &) {
      return "size " + std::to_string(bgra.rows);
    });
    check(value(careful.evaluate(plain(63), 1), "label")["value"] == "size 80", "A tie should go to the first read");
    // a box with no text is not read five times over each time it changes
    reads = 0;
    firefly::setTextRecognizer([&](const cv::Mat &, const std::string &) { ++reads; return std::string(); });
    firefly::Graph empty(definition(Json::array(
        {node("f", "frame"), node("c", "crop", {"f"}, {{"x", 0}, {"y", 0}, {"width", 30}, {"height", 12}}),
         node("careful", "ocr", {"c"}, {{"accuracy", "careful"}}),
         node("o", "publish", {"careful"}, {{"name", "label"}})})));
    empty.evaluate(plain(64), 1);
    check(reads == 5, "A first read of a blank box should try the five sizes");
    empty.evaluate(plain(65), 1);
    check(reads == 6, "A box that read blank should cost one read");
  });
  test("ocr fails with the recognizer's reason", [&] {
    quiet();
    firefly::setTextRecognizer([](const cv::Mat &, const std::string &) -> std::string {
      throw std::runtime_error("No OCR language is installed");
    });
    firefly::Graph graph(textGraph());
    auto r = graph.evaluate(plain(41), 1);
    check(!r["nodes"]["t"]["valid"].get<bool>() &&
              r["nodes"]["t"]["reason"].get<std::string>().find("No OCR language") != std::string::npos,
          "Reason lost");
    check(!value(r, "label")["valid"].get<bool>(), "Publish should be invalid");
    firefly::setTextRecognizer({});
    r = graph.evaluate(plain(42), 1);
    check(r["nodes"]["t"]["reason"].get<std::string>().find("not available") != std::string::npos,
          "No recognizer should say so");
  });
  test("ocr prepares an image the way recognizers read best", [&] {
    // light text on a dark ground, 30 x 12: turned around and enlarged 4 times, with a border
    // of 16 px that is light either way, so what is measured is inside it
    auto inside = [](const cv::Mat &m, int border) {
      return cv::mean(m(cv::Rect(border, border, m.cols - 2 * border, m.rows - 2 * border)))[0];
    };
    cv::Mat light = plain(20);
    cv::rectangle(light, cv::Rect(10, 3, 8, 6), cv::Scalar(255, 255, 255, 255), cv::FILLED);
    auto prepared = firefly::prepareForOcr(light, {});
    check(prepared.type() == CV_8UC4 && prepared.rows == 12 * 4 + 32 && prepared.cols == 30 * 4 + 32,
          "Wrong size");
    check(inside(prepared, 16) > 200, "Light text on dark was not turned around");
    firefly::OcrOptions off;
    off.invert = "off";
    check(inside(firefly::prepareForOcr(light, off), 16) < 100, "invert off still inverted");
    // dark text on a light ground is left as it is
    cv::Mat dark = plain(235);
    cv::rectangle(dark, cv::Rect(10, 3, 8, 6), cv::Scalar(10, 10, 10, 255), cv::FILLED);
    check(inside(firefly::prepareForOcr(dark, {}), 16) > 200, "Dark on light was inverted");
    firefly::OcrOptions on;
    on.invert = "on";
    check(inside(firefly::prepareForOcr(dark, on), 16) < 100, "invert on did not invert");
    // a mask: what is on is the text
    cv::Mat mask(12, 30, CV_8UC1, cv::Scalar(0));
    cv::rectangle(mask, cv::Rect(10, 3, 8, 6), cv::Scalar(255), cv::FILLED);
    check(inside(firefly::prepareForOcr(mask, {}), 16) > 200, "Mask text should come out dark");
    // scale is taken as given, and never past what a recognizer takes
    firefly::OcrOptions twice;
    twice.scale = 2;
    check(firefly::prepareForOcr(light, twice).rows == 12 * 2 + 24, "Wrong scale");
    firefly::OcrOptions wide;
    wide.scale = 4;
    check(firefly::prepareForOcr(cv::Mat(10, 3000, CV_8UC4, cv::Scalar::all(200)), wide).cols <= 4000,
          "Image grew past the limit");
  });
  test("number in text finds the numbers a person would", [&] {
    auto number = [&](const std::string &text, int which) {
      auto g = definition(Json::array({node("s", "text", Json::array(), {{"value", text}}),
                                       node("n", "number_in_text", {"s"}, {{"which", which}}),
                                       node("o", "publish", {"n"}, {{"name", "n"}})}));
      cv::Mat frame(2, 2, CV_8UC4);
      return value(firefly::Graph(g).evaluate(frame, 1), "n");
    };
    check(number("81/91", 1)["value"] == 81 && number("81/91", 2)["value"] == 91, "Two numbers");
    check(number("Lv. 37", 1)["value"] == 37, "Number after words");
    check(number("1,234,567 mesos", 1)["value"] == 1234567, "Thousands separators");
    check(number("-5.5%", 1)["value"] == -5.5 && number("EXP 1.75%", 1)["value"] == 1.75, "Decimals");
    check(number("81-91", 2)["value"] == 91, "A dash between numbers is not a minus");
    check(number("(-3)", 1)["value"] == -3, "Minus after a bracket");
    check(!number("81/91", 3)["valid"].get<bool>(), "A third number that is not there");
    check(!number("no digits", 1)["valid"].get<bool>(), "No number at all");
  });
  std::cout << passed << " graph tests passed\n";
}
