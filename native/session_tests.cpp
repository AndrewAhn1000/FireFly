#include "recording.hpp"
#include <cmath>
#include <fstream>
#include <iostream>
using namespace firefly;
static void check(bool value, const char *message) {
  if (!value)
    throw std::runtime_error(message);
}
int main() {
  try {
    check(
        sha256("abc") ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "SHA256 mismatch");
    ActionTimeline timeline;
    timeline.reset(100, {{"left", false}}, true);
    timeline.append(120, {{"left", true}}, true);
    timeline.append(140, {{"left", false}}, false);
    check(!timeline.at(90)["valid"].get<bool>(), "Prehistory valid");
    check(timeline.at(119)["buttons"]["left"] == false,
          "Future action leaked backward");
    check(timeline.at(120)["buttons"]["left"] == true,
          "Boundary alignment incorrect");
    check(!timeline.at(141)["valid"].get<bool>(), "Focus loss labeled valid");
    auto a = actionSchema(Json::array({{{"id", "move"}, {"vk", 37}}}));
    auto b = actionSchema(Json::array({{{"id", "move"}, {"vk", 39}}}));
    check(a["identity"] != b["identity"], "Action mismatch not identified");
    bool rejected = false;
    try {
      actionSchema(Json::array({{{"id", "os"}, {"vk", 91}}}));
    } catch (...) {
      rejected = true;
    }
    check(rejected, "System key allowed");
    // The whole keyboard, Shift, Ctrl and Alt too, but the keys that open Windows' menus or stay switched on
    for (int vk : {8, 9, 13, 16, 17, 18, 27, 33, 36, 45, 46, 96, 107, 111, 112, 123, 186, 192, 219, 222})
      actionSchema(Json::array({{{"id", "key"}, {"vk", vk}}}));
    // Every key at once
    Json every = Json::array();
    for (int vk : {1, 2, 4, 8, 9, 13, 16, 17, 18, 27, 32})
      every.push_back({{"id", "k" + std::to_string(vk)}, {"vk", vk}});
    for (int vk = 33; vk <= 90; ++vk)
      if (vk <= 40 || vk == 45 || vk == 46 || (vk >= 48 && vk <= 57) || vk >= 65)
        every.push_back({{"id", "k" + std::to_string(vk)}, {"vk", vk}});
    check(actionSchema(every)["buttons"].size() > 24, "More than 24 buttons refused");
    // A policy holding Alt or Ctrl never makes a Windows shortcut of them; the modifier and other keys are kept
    check(withoutShortcuts({18, 9, 27, 32, 115, 65}) == std::set<int>{18, 65}, "Alt+Tab, Esc, Space or F4 pressed");
    check(withoutShortcuts({17, 16, 27, 37}) == std::set<int>{16, 17, 37}, "Ctrl+Esc or Ctrl+Shift+Esc pressed");
    check(withoutShortcuts({9, 27, 32, 115, 16}) == std::set<int>{9, 16, 27, 32, 115}, "Keys without Alt or Ctrl were held back");
    for (int vk : {20, 44, 19, 91, 92, 93, 144, 145, 160, 162, 164, 108}) {
      bool refused = false;
      try { actionSchema(Json::array({{{"id", "key"}, {"vk", vk}}})); } catch (...) { refused = true; }
      check(refused, ("A modifier, lock or system key was allowed: " + std::to_string(vk)).c_str());
    }
    Json definition = {
        {"version", 1},
        {"id", "g"},
        {"revision", 1},
        {"nodes", Json::array({{{"id", "v"},
                                {"op", "number"},
                                {"inputs", Json::array()},
                                {"params", {{"value", 1}}}},
                               {{"id", "p"},
                                {"op", "publish"},
                                {"inputs", {"v"}},
                                {"params", {{"name", "value"}}}}})}};
    auto first = observationSchema(Graph(definition));
    definition["nodes"][0]["position"] = {{"x", 100}, {"y", 2}};
    check(first["identity"] == observationSchema(Graph(definition))["identity"],
          "Layout changed schema");
    definition["nodes"][0]["params"]["value"] = 2;
    check(first["identity"] != observationSchema(Graph(definition))["identity"],
          "Meaning change retained schema");
    // Tracked observations join the fields and the identity; none leaves both as the graph's alone
    {
      Graph graph(definition);
      const Json none = observationSchema(graph);
      check(observationSchema(graph, Json::array(), Json::array())["identity"] == none["identity"],
            "No tracked observations changed the schema");
      Json defs = {{{"name", "player"}, {"region", "r"}, {"value", "position"}}};
      Json fields = {{{"name", "player"}, {"type", "vector"}, {"size", 2}}};
      auto withTracked = observationSchema(graph, defs, fields);
      check(withTracked["identity"] != none["identity"] && withTracked["fields"].size() == 2 &&
            withTracked["fields"][1]["name"] == "player", "Tracked observations missing from the schema");
      defs[0]["value"] = "velocity";
      check(observationSchema(graph, defs, fields)["identity"] != withTracked["identity"],
            "A changed tracked observation kept the schema");
      bool clash = false;
      try { observationSchema(graph, defs, Json{{{"name", "value"}, {"type", "vector"}, {"size", 2}}}); }
      catch (const std::exception &) { clash = true; }
      check(clash, "A tracked observation named like a graph output was accepted");
      // Observations left out of recordings leave the fields, and change the identity whatever their order
      auto without = observationSchema(graph, defs, fields, Json{"player"});
      check(without["fields"].size() == 1 && without["fields"][0]["name"] == "value", "A left-out observation stayed in the fields");
      check(without["identity"] != observationSchema(graph, defs, fields)["identity"], "Leaving an observation out kept the identity");
      check(observationSchema(graph, defs, fields, Json{"player", "value"})["identity"] ==
            observationSchema(graph, defs, fields, Json{"value", "player"})["identity"], "The order left out changed the identity");
    }
    auto root = std::filesystem::current_path() / "session-test-data" /
                std::to_string(static_cast<long long>(monotonicMs() * 1000));
    Catalog catalog(root);
    Recorder recorder;
    double start = monotonicMs();
    recorder.start(root, {{"id", "record-one"},
                          {"name", "Test"},
                          {"started", start},
                          {"observationSchema", first},
                          {"actionSchema", a}});
    for (int i = 0; i < 10; ++i)
      check(recorder.enqueue({{"kind", "sample"},
                              {"timestamp", start + i},
                              {"valid", i != 3},
                              {"actions", timeline.at(125)},
                              {"observations", Json::array()}}),
            "Enqueue failed");
    // Text read from the screen can hold bytes that aren't UTF-8; it must not fail the recording
    check(recorder.enqueue({{"kind", "sample"},
                            {"timestamp", start + 10},
                            {"valid", true},
                            {"actions", timeline.at(125)},
                            {"observations",
                             Json::array({{{"name", "label"},
                                           {"type", "text"},
                                           {"valid", true},
                                           {"value", std::string("Lv \xC3\x28 ok")}}})}}),
          "Enqueue of text that isn't UTF-8 failed");
    recorder.enqueue(
        {{"kind", "button"}, {"timestamp", start}, {"down", true}});
    Json live;
    for (int attempt = 0; attempt < 100; ++attempt) {
      live = catalog.read("record-one", 0, 3, true);
      if (live["samples"] == 11 && live["inputEvents"] == 1) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    check(recorder.active() && live["status"] == "recording" &&
              live["samples"] == 11 && live["invalidSamples"] == 1 &&
              live["offset"] == 8 && live["rows"].size() == 3 &&
              live["rows"][0]["seq"] == 9 && live["rows"][2]["seq"] == 11,
          "Live committed tail/count mismatch");
    check(catalog.list()[0]["samples"] == 11, "Live listing totals stale");
    auto liveInputs = catalog.read("record-one", 0, 50, true, "inputs");
    check(liveInputs["total"] == 1 && liveInputs["rows"][0]["down"] == true &&
              liveInputs["rows"][0]["seq"] == 1, "Live input events missing");
    rejected = false;
    try { catalog.read("record-one", 0, 50, false, "invalid"); }
    catch (...) { rejected = true; }
    check(rejected, "Invalid dataset stream accepted");
    recorder.stop();
    check(!recorder.failed(), "Writer failed");
    auto rows = catalog.read("record-one", 2, 3);
    check(rows["rows"].size() == 3 && rows["samples"] == 11 &&
              rows["invalidSamples"] == 1,
          "Dataset paging/count mismatch");
    Catalog reopened(root);
    check(reopened.list()[0]["status"] == "complete", "Reopen status mismatch");
    std::ifstream stream(root / "recordings" / "record-one" / "sequence.jsonl");
    std::string line;
    int count = 0;
    while (std::getline(stream, line)) {
      (void)Json::parse(line);
      ++count;
    }
    check(count == 12, "Structured sequence file incomplete");
    stream.close(); // Windows won't delete a file that's open
    // A deleted recording is gone: its rows, its input events and its files; bad ids are refused
    reopened.remove("record-one");
    check(reopened.list().empty(), "Deleted recording still listed");
    check(!std::filesystem::exists(root / "recordings" / "record-one"), "Deleted recording's files remain");
    rejected = false;
    try { reopened.read("record-one", 0, 10); } catch (...) { rejected = true; }
    check(rejected, "Deleted recording could still be read");
    rejected = false;
    try { reopened.remove("../outside"); } catch (...) { rejected = true; }
    check(rejected, "A recording id reaching outside the folder was accepted");
    std::cout << "PASS timestamp boundaries, focus validity, SHA256 "
                 "identities, action restrictions, schema changes, queued "
                 "persistence, paging and reopen\n";
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
