#include "latest_worker.hpp"
#include "rate_meter.hpp"
#include "detection.hpp"
#include "tracked.hpp"
#include "tracking.hpp"
#include "onnx_node.hpp"
#include <future>
#include <set>
#include <iostream>
#include <opencv2/imgproc.hpp>
using firefly::Json;
static void check(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
int main() {
  try {
    // A deliberately blocked detector cannot delay capture/submission. Pending
    // frames are replaced, including during a capture/configuration change.
    std::promise<void> entered, release;
    auto gate = release.get_future().share();
    struct Stamp { int frame, generation; };
    LatestWorker<Stamp, Stamp> worker([&](Stamp job) {
      if (job.frame == 1) { entered.set_value(); gate.wait(); }
      return job;
    });
    worker.submit({1, 1}); entered.get_future().wait();
    for (int i = 2; i <= 100; ++i) worker.submit({i, 1});
    worker.clear(); worker.submit({101, 2});
    const bool previewFree = !worker.take().has_value();
    release.set_value(); check(previewFree, "Preview waited for unfinished detection");
    std::optional<Stamp> newest;
    for (int i = 0; i < 1000; ++i) {
      auto r = worker.take();
      if (r && r->generation == 2) { newest = r; break; }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    check(newest && newest->frame == 101, "Queued obsolete frames were not replaced");
    // A kept job runs: newer ordinary ones don't replace it while it waits, a newer kept one does
    {
      std::promise<void> busy, go;
      auto open = go.get_future().share();
      std::vector<int> ran;
      std::mutex ranMu;
      LatestWorker<Stamp, Stamp> kept([&](Stamp job) {
        if (job.frame == 1) { busy.set_value(); open.wait(); }
        std::lock_guard lock(ranMu); ran.push_back(job.frame); return job;
      });
      kept.submit({1, 1}); busy.get_future().wait();
      kept.submit({2, 1}, true); kept.submit({3, 1}); kept.submit({4, 1});
      go.set_value();
      for (int i = 0; i < 1000; ++i) { { std::lock_guard lock(ranMu); if (ran.size() >= 2) break; } std::this_thread::sleep_for(std::chrono::milliseconds(1)); }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      { std::lock_guard lock(ranMu); check(ran.size() == 2 && ran[1] == 2, "A kept job was replaced by an ordinary one"); }
      kept.submit({5, 1}, true); kept.submit({6, 1}, true); kept.submit({7, 1});
      for (int i = 0; i < 1000; ++i) { { std::lock_guard lock(ranMu); if (ran.size() >= 3) break; } std::this_thread::sleep_for(std::chrono::milliseconds(1)); }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      { std::lock_guard lock(ranMu); check(ran.size() >= 3 && ran[2] >= 5, "A kept job didn't run"); }
    }

    // Rates are measured over the last two seconds, and drop to 0 once nothing happens
    {
      firefly::RateMeter meter;
      check(meter.hz(0) == 0, "A rate from nothing");
      for (int i = 0; i <= 240; ++i) meter.tick(i * 41.667);  // 24 frames a second for 10 s
      check(std::abs(meter.hz(10000) - 24) < .1, "Measured rate wrong");
      meter.tick(10100); meter.tick(10200);                     // then 10 a second: the old ones age out
      check(meter.hz(10200) > 20, "Window too short");
      for (int i = 3; i <= 30; ++i) meter.tick(10000 + i * 100);
      check(std::abs(meter.hz(13000) - 10) < .1, "Old ticks weren't forgotten");
      check(meter.hz(15500) == 0, "A rate stayed after everything stopped");
    }
    cv::Mat original(30, 40, CV_8UC4, cv::Scalar(21, 32, 43, 255));
    auto annotated = original.clone();
    cv::line(annotated, {3, 9}, {25, 9}, cv::Scalar(0, 255, 0, 255), 2);
    auto lines = firefly::drawingLayer(original, annotated);
    check(!lines.empty() && lines.at<cv::Vec4b>(9, 10) == cv::Vec4b(0, 255, 0, 255), "Detection line missing or wrong color");
    check(lines.at<cv::Vec4b>(0, 0)[3] == 0, "Old captured pixels leaked into transparent layer");
    check(firefly::drawingLayer(original, original).empty(), "No detections should clear prior drawings");
    check(firefly::drawingLayer(original, cv::Mat(3, 4, CV_8UC4)).empty(), "Wrong-sized drawing should be rejected");
    // Strided/cropped matrices and alpha-only differences must behave correctly too.
    auto alphaOnly = original.clone(); alphaOnly.at<cv::Vec4b>(1, 1)[3] = 0;
    check(firefly::drawingLayer(original, alphaOnly).empty(), "Capture alpha difference must not create a line");
    check(!firefly::drawingLayer(original(cv::Rect(0, 0, 30, 20)), annotated(cv::Rect(0, 0, 30, 20))).empty(), "Strided drawing failed");

    firefly::Detector detector;
    auto frame = std::make_shared<CapturedFrame>();
    frame->width = 64; frame->height = 48; frame->timestamp = 12345;
    frame->bgra.resize(64 * 48 * 4);
    cv::Mat pixels(48, 64, CV_8UC4, frame->bgra.data());
    cv::randu(pixels, 0, 255);
    cv::Mat bgr; cv::cvtColor(pixels, bgr, cv::COLOR_BGRA2BGR);
    firefly::DetectionJob job;
    job.frame = frame; job.generation = 12; job.recordingGeneration = 5;
    job.graph = std::make_shared<firefly::Graph>(Json{
      {"version", 1}, {"id", "test"}, {"revision", 3}, {"nodes", Json::array({
        {{"id", "frame"}, {"op", "frame"}, {"inputs", Json::array()}, {"params", Json::object()}},
        {{"id", "out"}, {"op", "publish"}, {"inputs", {"frame"}}, {"params", {{"name", "frame"}}}}
      })}});
    auto out = detector(job);
    check(out.error.empty(), "Detection failed");
    check(out.frame == frame && out.generation == 12 && out.recordingGeneration == 5, "Frame/configuration identity lost");
    check(out.observations["timestamp"] == 12345 && out.observations["schema"]["version"] == 3, "Observation timestamp/schema lost");
    check(out.elapsedMs >= 0 && out.observations.contains("detectionMs"), "Detection timing missing");
    check(out.observations["displayOverlay"].is_null(), "Unannotated graph should clear drawings");
    auto drawnGraph = job.graph->definition();
    drawnGraph["nodes"] = Json::array({
      {{"id", "frame"}, {"op", "frame"}, {"inputs", Json::array()}, {"params", Json::object()}},
      {{"id", "mask"}, {"op", "threshold"}, {"inputs", {"frame"}}, {"params", {{"rMin", 100}, {"rMax", 255}, {"gMin", 0}, {"gMax", 255}, {"bMin", 0}, {"bMax", 255}}}},
      {{"id", "draw"}, {"op", "draw_contours"}, {"inputs", {"frame", "mask"}}, {"params", {{"r", 0}, {"g", 255}, {"b", 0}, {"thickness", 2}}}},
      {{"id", "out"}, {"op", "publish"}, {"inputs", {"draw"}}, {"params", {{"name", "image"}}}}
    });
    job.graph = std::make_shared<firefly::Graph>(drawnGraph);
    auto drawnResult = detector(job);
    const auto &drawing = drawnResult.observations["displayOverlay"];
    check(drawing.is_object() && drawing["timestamp"] == frame->timestamp && drawing["width"] == frame->width, "Drawing source metadata missing");
    check(drawing["dataUrl"].get<std::string>().starts_with("data:image/png;base64,iVBOR"), "Transparent PNG transport missing");
    job.preview = "mask";
    check(detector(job).observations["displayOverlay"].is_null(), "Step preview should not obscure raw capture");

    // Template matching runs on its own worker, and matches every region in the same frame
    firefly::Tracker tracker;
    auto sprite = std::make_shared<firefly::Track>();
    sprite->region = "region-1"; sprite->context = "context-1"; sprite->multi = true;
    sprite->templates.emplace("sprite", firefly::Pattern(bgr(cv::Rect(20, 15, 12, 10)).clone()));
    auto other = std::make_shared<firefly::Track>();
    other->region = "region-2"; other->context = "context-2";
    other->templates.emplace("other", firefly::Pattern(bgr(cv::Rect(40, 30, 14, 12)).clone()));
    auto tracks = std::make_shared<firefly::Tracks>(firefly::Tracks{sprite, other});
    auto tracked = tracker({7, frame, tracks});
    check(tracked.error.empty() && tracked.generation == 7 && tracked.frame == frame, "Tracking identity lost");
    check(tracked.match["timestamp"] == 12345 && tracked.match["width"] == 64, "Template event source lost");
    const auto &regions = tracked.match["regions"];
    check(regions.size() == 2, "Not every region was matched");
    const auto &first = regions[0], &second = regions[1];
    check(first["region"] == "region-1" && first["context"] == "context-1", "Region identity lost");
    check(first["templateId"] == "sprite" && first["found"] == true, "Best template not returned");
    check(first["matches"].size() == 1 && first["x"] == 20.0 / 64, "Template instance wrong");
    check(second["region"] == "region-2" && second["context"] == "context-2" && second["found"] == true, "Second region lost");
    check(second["x"] == 40.0 / 64 && second["y"] == 30.0 / 48 && !second.contains("matches"), "Second region's match wrong");
    check(first.contains("durationMs") && tracked.match.contains("durationMs"), "Tracking timing missing");
    // A region that can't be matched reports so without costing the others their results
    auto broken = std::make_shared<firefly::Track>();
    broken->region = "region-3"; broken->multi = true;
    broken->templates.emplace("wrong", firefly::Pattern(cv::Mat(4, 4, CV_8UC3, cv::Scalar(1, 2, 3))));
    auto withBroken = tracker({7, frame, std::make_shared<firefly::Tracks>(firefly::Tracks{broken, other})});
    check(withBroken.match["regions"].size() == 2 && withBroken.match["regions"][0]["found"] == false &&
          withBroken.match["regions"][1]["found"] == true, "One region's result affected another's");
    // Following one object, every template that wins a place of its own is reported, not only the best,
    // so each of the region's template states can be true at once. The box still follows the best.
    auto both = std::make_shared<firefly::Track>();
    both->region = "region-6"; both->threshold = .9;
    both->templates.emplace("left", firefly::Pattern(bgr(cv::Rect(4, 4, 12, 10)).clone()));
    both->templates.emplace("right", firefly::Pattern(bgr(cv::Rect(44, 30, 14, 12)).clone()));
    auto bothResult = tracker({7, frame, std::make_shared<firefly::Tracks>(firefly::Tracks{both})}).match["regions"][0];
    check(bothResult["found"] == true && bothResult["detected"].size() == 2, "Not every visible template was reported");
    check(bothResult["detected"][0]["templateId"] == bothResult["templateId"], "The box didn't follow the best template");
    std::set<std::string> seen{bothResult["detected"][0]["templateId"], bothResult["detected"][1]["templateId"]};
    check(seen == std::set<std::string>{"left", "right"}, "Wrong templates reported");
    // Each result says where the box's centre is, in frame px, and how fast it moves, in px per second
    {
      cv::Mat scene(120, 200, CV_8UC3), sprite(16, 20, CV_8UC3);
      cv::randu(scene, 0, 255); cv::randu(sprite, 0, 255);
      auto frameAt = [&](cv::Point at, double timestamp, bool shown = true) {
        auto f = std::make_shared<CapturedFrame>();
        f->width = 200; f->height = 120; f->timestamp = timestamp; f->bgra.resize(200 * 120 * 4);
        cv::Mat bgrFrame = scene.clone();
        if (shown) sprite.copyTo(bgrFrame(cv::Rect(at, sprite.size())));
        cv::cvtColor(bgrFrame, cv::Mat(120, 200, CV_8UC4, f->bgra.data()), cv::COLOR_BGR2BGRA);
        return f;
      };
      auto moving = std::make_shared<firefly::Track>();
      moving->region = "moving"; moving->context = "m";
      moving->templates.emplace("sprite", firefly::Pattern(sprite));
      auto tracks = std::make_shared<firefly::Tracks>(firefly::Tracks{moving});
      firefly::Tracker follower;
      Json last;
      // 3 px right and 1.5 px up every 30 ms: 100 px/s right, 50 px/s up (y is down)
      for (int i = 0; i < 6; ++i)
        last = follower({1, frameAt({20 + 3 * i, 80 - (3 * i) / 2}, 1000 + 30 * i), tracks}).match["regions"][0];
      check(last["position"][0] == 20 + 15 + 10.0 && last["position"][1] == 80 - 7 + 8.0, "Position isn't the box's centre");
      const double vx = last["velocity"][0], vy = last["velocity"][1];
      check(std::abs(vx - 100) < 1 && std::abs(vy + 50) < 8, "Velocity is wrong");
      // After a long gap its path starts again, so the speed isn't known yet rather than made up
      auto afterGap = follower({1, frameAt({150, 20}, 2000), tracks}).match["regions"][0];
      check(afterGap["found"] == true && afterGap["velocity"].is_null() && afterGap["position"][0] == 160.0, "A gap was counted as speed");
      auto lost = follower({1, frameAt({150, 20}, 2030, false), tracks}).match["regions"][0];
      check(lost["found"] == false && lost["position"].is_null() && lost["velocity"].is_null(), "A lost object still had a position");
    }
    // Limited to near where it was, the object isn't taken from a lookalike elsewhere, even a better one,
    // and one that went further is looked for twice as far, and further, in the same frame until it's found
    {
      cv::Mat scene(120, 200, CV_8UC3), sprite(16, 20, CV_8UC3);
      cv::randu(scene, 0, 255); cv::randu(sprite, 0, 255);
      auto worn = sprite.clone(); cv::randu(worn(cv::Rect(0, 0, 6, 16)), 0, 255); // the object in a pose the template doesn't quite cover
      auto frameWith = [&](std::vector<std::pair<cv::Mat, cv::Point>> drawn, double timestamp) {
        auto f = std::make_shared<CapturedFrame>();
        f->width = 200; f->height = 120; f->timestamp = timestamp; f->bgra.resize(200 * 120 * 4);
        cv::Mat bgrFrame = scene.clone();
        for (auto &[image, at] : drawn) image.copyTo(bgrFrame(cv::Rect(at, image.size())));
        cv::cvtColor(bgrFrame, cv::Mat(120, 200, CV_8UC4, f->bgra.data()), cv::COLOR_BGR2BGRA);
        return f;
      };
      auto trackWith = [&](int reach) {
        auto t = std::make_shared<firefly::Track>();
        t->region = "near"; t->context = "n"; t->threshold = .5; t->reach = reach;
        t->templates.emplace("sprite", firefly::Pattern(sprite));
        t->start = cv::Rect2d(30 / 200.0, 40 / 120.0, 20 / 200.0, 16 / 120.0);
        return std::make_shared<firefly::Tracks>(firefly::Tracks{t});
      };
      for (int reach : {20, -1}) {
        firefly::Tracker follower;
        auto tracks = trackWith(reach);
        auto first = follower({1, frameWith({{sprite, {30, 40}}}, 0), tracks}).match["regions"][0];
        check(first["found"] == true && first["x"] == 30 / 200.0, "The object wasn't found where it was put");
        auto next = follower({1, frameWith({{worn, {34, 42}}, {sprite, {150, 80}}}, 30), tracks}).match["regions"][0];
        if (reach >= 0) check(next["found"] == true && next["x"] == 34 / 200.0, "A lookalike elsewhere took the box from its object");
        else check(next["x"] == 150 / 200.0, "Searching the whole window no longer finds the best place");
      }
      firefly::Tracker follower;
      auto tracks = trackWith(20);
      follower({1, frameWith({{sprite, {30, 40}}}, 0), tracks});
      // 120 px away, past its 20 px reach: found on that same frame (searched within 20, 40, 80, then 160)
      auto recovered = follower({1, frameWith({{sprite, {150, 80}}}, 30), tracks}).match["regions"][0];
      check(recovered["found"] == true && recovered["x"] == 150 / 200.0, "An object past its reach wasn't found on the frame it was in");
      auto stays = follower({1, frameWith({{sprite, {152, 81}}}, 60), tracks}).match["regions"][0];
      check(stays["found"] == true && stays["x"] == 152 / 200.0, "The object wasn't followed from where it was found again");
      // Gone, then back at the far corner: found on the first frame it's there, whatever came before
      firefly::Tracker gone;
      gone({1, frameWith({{sprite, {30, 40}}}, 0), tracks});
      for (int i = 1; i <= 6; ++i)
        check(gone({1, frameWith({}, 30.0 * i), tracks}).match["regions"][0]["found"] == false, "An object that isn't there was found");
      auto back = gone({1, frameWith({{sprite, {170, 4}}}, 210), tracks}).match["regions"][0];
      check(back["found"] == true && back["x"] == 170 / 200.0, "An object back after a while wasn't found on the frame it was back");
      // Nearest first: with the object a little past its reach and a lookalike further, the box goes to the object
      firefly::Tracker nearest;
      nearest({1, frameWith({{sprite, {30, 40}}}, 0), tracks});
      auto picked = nearest({1, frameWith({{sprite, {62, 44}}, {sprite, {170, 90}}}, 30), tracks}).match["regions"][0];
      check(picked["found"] == true && picked["x"] == 62 / 200.0, "A search growing past its reach took a lookalike further away");
      // Widening each frame instead: a frame looks one step further out than the last, so an object 120 px
      // away is found on the 4th frame (within 20, 40, 80, then 160), and the search is back to its reach
      // once it's found
      auto widening = trackWith(20);
      std::const_pointer_cast<firefly::Track>((*widening)[0])->widenEachFrame = true;
      firefly::Tracker stepwise;
      stepwise({1, frameWith({{sprite, {30, 40}}}, 0), widening});
      std::vector<bool> found;
      for (int i = 1; i <= 4; ++i)
        found.push_back(stepwise({1, frameWith({{sprite, {150, 80}}}, 30.0 * i), widening}).match["regions"][0]["found"]);
      check(found == std::vector<bool>{false, false, false, true}, "Widening each frame didn't take a step a frame to find the object");
      // Found, its next search is its reach again: a lookalike past it, with the object gone, isn't taken
      auto after = stepwise({1, frameWith({{sprite, {20, 10}}}, 150), widening}).match["regions"][0];
      check(after["found"] == false, "Once found, the search didn't go back to its reach");
      // Widening by 4 times a step instead of twice: within 20, 80, then 320, so found on the 3rd frame
      auto bigger = trackWith(20);
      {
        auto t = std::const_pointer_cast<firefly::Track>((*bigger)[0]);
        t->widenEachFrame = true; t->widenBy = 4;
      }
      firefly::Tracker quicker;
      quicker({1, frameWith({{sprite, {30, 40}}}, 0), bigger});
      std::vector<bool> foundSooner;
      for (int i = 1; i <= 3; ++i)
        foundSooner.push_back(quicker({1, frameWith({{sprite, {150, 80}}}, 30.0 * i), bigger}).match["regions"][0]["found"]);
      check(foundSooner == std::vector<bool>{false, false, true}, "Widening by more a step didn't find the object sooner");
      // A little at a time (1.1 times) still gets there: every step is at least a pixel further
      auto slow = trackWith(20);
      {
        auto t = std::const_pointer_cast<firefly::Track>((*slow)[0]);
        t->widenBy = 1.1;
      }
      firefly::Tracker patient;
      patient({1, frameWith({{sprite, {30, 40}}}, 0), slow});
      check(patient({1, frameWith({{sprite, {150, 80}}}, 30), slow}).match["regions"][0]["found"] == true, "Widening a little at a time in one frame never got there");
      // The same frames searched in one frame each (the default) find it at once
      firefly::Tracker atOnce;
      atOnce({1, frameWith({{sprite, {30, 40}}}, 0), tracks});
      check(atOnce({1, frameWith({{sprite, {150, 80}}}, 30), tracks}).match["regions"][0]["found"] == true, "The default stopped searching the whole frame");
    }
    // An object moving further between frames than its reach is still followed: it's also looked for
    // where it was heading
    {
      cv::Mat scene(120, 200, CV_8UC3), sprite(16, 20, CV_8UC3);
      cv::randu(scene, 0, 255); cv::randu(sprite, 0, 255);
      auto frameAt = [&](int x, double timestamp) {
        auto f = std::make_shared<CapturedFrame>();
        f->width = 200; f->height = 120; f->timestamp = timestamp; f->bgra.resize(200 * 120 * 4);
        cv::Mat bgrFrame = scene.clone();
        sprite.copyTo(bgrFrame(cv::Rect(x, 50, 20, 16)));
        cv::cvtColor(bgrFrame, cv::Mat(120, 200, CV_8UC4, f->bgra.data()), cv::COLOR_BGR2BGRA);
        return f;
      };
      auto t = std::make_shared<firefly::Track>();
      t->region = "fast"; t->context = "f"; t->threshold = .5; t->reach = 8;
      t->templates.emplace("sprite", firefly::Pattern(sprite));
      t->start = cv::Rect2d(10 / 200.0, 50 / 120.0, 20 / 200.0, 16 / 120.0);
      auto tracks = std::make_shared<firefly::Tracks>(firefly::Tracks{t});
      firefly::Tracker follower;
      // 6 px every 30 ms (200 px/s), within its 8 px reach
      for (int i = 0; i < 3; ++i)
        check(follower({1, frameAt(10 + 6 * i, 30.0 * i), tracks}).match["regions"][0]["found"] == true, "A slow object was lost");
      // A frame 60 ms later: 12 px on, past its reach from where it was, but where it was heading
      auto ahead = follower({1, frameAt(34, 120), tracks}).match["regions"][0];
      check(ahead["found"] == true && ahead["x"] == 34 / 200.0, "An object faster than its reach wasn't looked for where it was heading");
      // And one that stops dead is still found where it was
      auto stopped = follower({1, frameAt(34, 150), tracks}).match["regions"][0];
      check(stopped["found"] == true && stopped["x"] == 34 / 200.0, "An object that stopped wasn't found where it was");
    }
    // Tracked observations: what the app's States read from the tracker, as observations of a frame
    {
      firefly::TrackedObservations obs;
      obs.configure({{{"name", "where"}, {"region", "p"}, {"value", "position"}},
                     {{"name", "moving"}, {"region", "p"}, {"value", "velocity"}},
                     {{"name", "left"}, {"region", "p"}, {"value", "detected"}, {"templates", {"L1", "L2"}}, {"settleMs", 100}},
                     {{"name", "any"}, {"region", "p"}, {"value", "detected"}, {"templates", nullptr}, {"settleMs", 0}}});
      check(obs.fields().size() == 4 && obs.fields()[0]["type"] == "vector" && obs.fields()[2]["type"] == "boolean", "Tracked fields wrong");
      auto result = [](double t, bool found, std::string won) {
        Json region = {{"region", "p"}, {"found", found}, {"position", found ? Json{10, 20} : Json(nullptr)},
                       {"velocity", found ? Json{5, -1} : Json(nullptr)}, {"detected", Json::array()}};
        if (!won.empty()) region["detected"].push_back({{"templateId", won}});
        return Json{{"timestamp", t}, {"regions", {region}}};
      };
      obs.update(result(1000, true, "L1"));
      auto at = obs.at(1010);
      check(at[0]["valid"] == true && at[0]["value"] == Json{10, 20} && at[1]["value"] == Json{5, -1}, "Position/velocity not read");
      // Matching skips frames while busy: a later frame holds the last result, saying how old it is, up to a second
      check(at[0]["heldMs"] == 10 && !obs.at(1000)[0].contains("heldMs"), "How long a value was held isn't said");
      check(obs.at(1900)[2]["valid"] == true && obs.at(1900)[2]["heldMs"] == 900, "A result wasn't held");
      check(obs.at(2100)[0]["valid"] == false && obs.at(2100)[0]["reason"] == "No tracking result in the 1000 ms before this frame", "Held a result too long");
      check(obs.at(900)[0]["reason"] == "No tracking result yet", "Took a result from after the frame");
      check(at[2]["value"] == true && at[3]["value"] == true, "Detected templates not read");
      // A frame of another template doesn't flip a settled state, one without any settle time does change
      obs.update(result(1033, true, "R1"));
      check(obs.at(1033)[2]["value"] == true && obs.at(1033)[3]["value"] == true, "A single frame flipped a settled state");
      obs.update(result(1066, false, ""));
      auto lost = obs.at(1066);
      // A frame the object isn't found in keeps template states as they were, for up to half a second
      check(lost[0]["valid"] == false && lost[2]["value"] == true && lost[3]["value"] == true, "A lost frame read wrong");
      obs.update(result(1140, false, ""));
      check(obs.at(1140)[2]["value"] == true && obs.at(1140)[3]["value"] == true, "A moment lost flipped a state");
      obs.update(result(1600, false, ""));
      check(obs.at(1600)[3]["value"] == false && obs.at(1600)[2]["value"] == false, "Something gone for good kept its state");
      // A sample takes the latest result at or before its frame, and none that's too old
      check(obs.at(1050)[0]["value"] == Json{10, 20}, "Didn't take the result for its frame");
      check(obs.at(1100)[0]["valid"] == false && obs.at(1100)[0]["heldMs"] == 34, "Held a found position past a lost frame");
      check(obs.at(2700)[0]["valid"] == false && obs.at(900)[0]["valid"] == false, "Took a result from the wrong time");
      // A region with no result, as when it stopped following, is invalid
      obs.update({{"timestamp", 1700}, {"regions", Json::array()}});
      check(obs.at(1700)[0]["valid"] == false && obs.at(1700)[2]["valid"] == false, "A region not followed had values");
      // Every match: points at the centres of the instances, in frame px; none is an empty list, not missing
      {
        firefly::TrackedObservations all;
        all.configure({{{"name", "mobs"}, {"region", "m"}, {"value", "matches"}},
                       {{"name", "red mobs"}, {"region", "m"}, {"value", "matches"}, {"templates", {"red"}}},
                       {{"name", "me"}, {"region", "p"}, {"value", "matches"}}});
        check(all.fields()[0]["type"] == "shapes" && !all.fields()[0].contains("size"), "Every match isn't shapes");
        Json frame = {{"timestamp", 100}, {"width", 200}, {"height", 100}, {"regions", {
          {{"region", "m"}, {"found", true}, {"matches", {
            {{"x", .1}, {"y", .2}, {"w", .05}, {"h", .1}, {"confidence", .9}, {"templateId", "red"}},
            {{"x", .5}, {"y", .5}, {"w", .05}, {"h", .1}, {"confidence", .8}, {"templateId", "blue"}}}}},
          {{"region", "p"}, {"found", true}, {"x", .25}, {"y", .5}, {"w", .1}, {"h", .2}, {"confidence", .7}, {"templateId", "t"}}}}};
        all.update(frame);
        auto seen = all.at(100);
        check(seen[0]["valid"] == true && seen[0]["value"].size() == 2, "Not every match");
        check(seen[0]["value"][0]["x"] == 25.0 && seen[0]["value"][0]["y"] == 25.0 && seen[0]["value"][0]["w"] == 10.0, "A match isn't at its box's centre in px");
        check(seen[1]["value"].size() == 1 && seen[1]["value"][0]["templateId"] == "red", "Chosen templates not kept apart");
        check(seen[2]["value"].size() == 1 && seen[2]["value"][0]["x"] == 60.0, "Following one object, its box isn't the match");
        frame["timestamp"] = 200; frame["regions"][0]["matches"] = Json::array(); frame["regions"][1]["found"] = false;
        all.update(frame);
        check(all.at(200)[0]["valid"] == true && all.at(200)[0]["value"].empty() && all.at(200)[2]["value"].empty(), "None found should be an empty list");
      }
      bool rejected = false;
      try { obs.configure({{{"name", "x"}, {"region", "p"}, {"value", "speed"}}}); } catch (const std::exception &) { rejected = true; }
      check(rejected, "An unknown tracked value was accepted");
    }
    // One object is found only at its region's threshold, but how well it matched is reported either way
    auto altered = bgr(cv::Rect(40, 30, 14, 12)).clone();
    cv::randu(altered(cv::Rect(0, 0, 7, 12)), 0, 255);
    auto loose = std::make_shared<firefly::Track>();
    loose->region = "region-4"; loose->templates.emplace("altered", firefly::Pattern(altered));
    loose->threshold = .2;
    auto strict = std::make_shared<firefly::Track>(*loose);
    strict->region = "region-5"; strict->threshold = .95;
    auto thresholds = tracker({7, frame, std::make_shared<firefly::Tracks>(firefly::Tracks{loose, strict})});
    const auto &looseResult = thresholds.match["regions"][0], &strictResult = thresholds.match["regions"][1];
    const double partial = looseResult["confidence"];
    check(looseResult["found"] == true && partial > .2 && partial < .95, "A partial match wasn't found under a low threshold");
    check(strictResult["found"] == false && std::abs(strictResult["confidence"].get<double>() - partial) < 1e-6,
          "A match under the threshold was found, or its confidence wasn't reported");
#ifdef FIREFLY_ONNX
    check(!firefly::inferenceDevices().empty(), "No inference devices advertised");
#endif
    for (const auto &params : {Json{{"model", "test.onnx"}, {"provider", "unknown"}},
                               Json{{"model", "test.onnx"}, {"provider", "directml"}, {"device", -1}}}) {
      auto definition = job.graph->definition();
      definition["nodes"].push_back({{"id", "invalid-inference"}, {"op", "segment"}, {"inputs", {"frame"}}, {"params", params}});
      bool rejected = false;
      try { firefly::Graph invalid(definition); } catch (const std::exception &) { rejected = true; }
      check(rejected, "Invalid inference device/provider was accepted");
    }
    std::cout << "PASS: bounded latest-frame worker, stale generation rejection, source frame/timestamp, recording identity, template matching and device discovery\n";
    return 0;
  } catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
