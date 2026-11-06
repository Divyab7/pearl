// Whole runs through the C++ orchestrator with a simulated arm (same rules as src/commands.cpp) and scripted 0G
// answers. Each run is written to out/runs/; fw-crosscheck.ts then verifies them with the REAL TypeScript verifier
// (hash chain, request ids, provenance, policy replay, robot signature, sealed file).
#include <sys/stat.h>
#include <chrono>
#include <deque>
#include <fstream>
#include <map>
#include "harness.h"
#include "../../src/pearl/json.h"
#include "../../src/pearl/orch.h"
#include "../../src/pearl/seal.h"

using namespace pearl;

static std::string readFile(const std::string& p) {
  std::ifstream f(p, std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}
static std::string repo() {
  std::string v = VECTORS_PATH;
  return v.substr(0, v.find("/firmware/"));
}

/** The arm, following commands.cpp: refuses what its state does not allow, finishes a move one pump later. */
struct SimArm : orch::ArmLink {
  std::string state = "IDLE";
  int pos[4] = {90, 90, 90, 10};
  std::string pendingId;
  int moveCount = 0;
  int failAtMove = -1;  // inject a safety event when this move starts
  std::string injectEv;
  int clearAfter = 0;   // hand: pumps until hand_clear
  bool handClear = true;
  std::deque<std::string> out;
  const int safePose[4] = {90, 120, 60, 10};

  void emit(JsonDocument& d) {
    std::string s;
    serializeJson(d, s);
    out.push_back(s);
  }
  void ev(const char* e) {
    JsonDocument d;
    d["t"] = "event";
    d["ev"] = e;
    if (!strcmp(e, "trip_bump")) d["accG"] = 2.7;
    if (!strncmp(e, "hand", 4)) d["tofMm"] = !strcmp(e, "hand_clear") ? 610 : 140;
    emit(d);
  }
  void nack(const std::string& id, const char* reason) {
    JsonDocument d;
    d["t"] = "nack";
    if (!id.empty()) d["id"] = id;
    d["reason"] = reason;
    emit(d);
  }
  void send(const JsonDocument& c) override {
    std::string cmd = c["cmd"] | "";
    std::string id = c["id"] | "";
    if (cmd == "move" || cmd == "grip") {
      if (state != "IDLE" && state != "WAITING") return nack(id, "state");
      int j[4] = {pos[0], pos[1], pos[2], pos[3]};
      if (cmd == "move")
        for (int k = 0; k < 4; k++) j[k] = c["joints"][k];
      else j[3] = c["close"] ? 80 : 10;
      moveCount++;
      if (moveCount == failAtMove) {
        if (injectEv == "trip_bump") state = "TRIPPED";
        else {
          state = "FROZEN_HAND";
          handClear = false;
        }
        ev(injectEv.c_str());
        return;
      }
      for (int k = 0; k < 4; k++) pos[k] = j[k];
      pendingId = id;
      state = "MOVING";
    } else if (cmd == "hold") {
      if (state == "IDLE" || state == "MOVING") {
        pendingId.clear();
        state = "WAITING";
      }
    } else if (cmd == "resume") {
      if (state == "FROZEN_HAND" && handClear) state = "IDLE";
      else if (state == "WAITING" || state == "SAFE") state = "IDLE";
      else nack("", "state");
    } else if (cmd == "safe") {
      if (state == "TRIPPED") return nack("", "state");
      for (int k = 0; k < 4; k++) pos[k] = safePose[k];
      pendingId.clear();
      state = "SAFE";
    }
  }
  bool recv(JsonDocument& m, uint32_t) override {
    if (state == "MOVING") {
      state = "IDLE";
      JsonDocument d;
      d["t"] = "done";
      d["id"] = pendingId;
      pendingId.clear();
      emit(d);
    }
    if (state == "FROZEN_HAND" && !handClear && --clearAfter <= 0) {
      handClear = true;
      ev("hand_clear");
    }
    if (out.empty()) {
      JsonDocument t;
      t["t"] = "tel";
      t["ms"] = 1000;
      t["state"] = state;
      JsonArray j = t["joints"].to<JsonArray>();
      for (int k = 0; k < 4; k++) j.add(pos[k]);
      t["tofMm"] = handClear ? 612 : 140;
      t["accG"] = 1.01;
      t["hbAgeMs"] = 120;
      emit(t);
    }
    deserializeJson(m, out.front());
    out.pop_front();
    return true;
  }
};

/** Scripted 0G Router: answers by checkpoint, with the documented trace fields. */
struct SimPlatform : orch::Platform {
  std::map<std::string, std::deque<std::string>> answers;
  bool down = false;
  int n = 0;
  long long t0 = 1762405800000;  // 2026-11-06T05:10:00Z
  int tick = 0;
  Bytes jpeg;
  uint32_t millis() override {
    using namespace std::chrono;
    return static_cast<uint32_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
  }
  void sleep(uint32_t) override {}
  std::string nowIso() override {
    long long ms = t0 + 1500LL * tick++;
    time_t s = ms / 1000;
    struct tm g;
    gmtime_r(&s, &g);
    char b[40];
    snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, static_cast<int>(ms % 1000));
    return b;
  }
  run::HttpResult post(const std::string&, const orch::Headers& h, const std::string& body, uint32_t timeoutMs) override {
    run::HttpResult r;
    r.latencyMs = 800 + 37 * (n % 9);
    if (down) {
      r.error = "network error: connect ETIMEDOUT 10.255.255.1:80";
      return r;
    }
    JsonDocument b;
    deserializeJson(b, body);
    JsonDocument user;
    deserializeJson(user, b["messages"][1]["content"][0]["text"].as<const char*>());
    std::string cp = user["checkpoint"] | "";
    if (answers[cp].empty()) {
      r.error = "network error: no scripted answer";
      return r;
    }
    std::string rid = "0g-req-" + std::to_string(++n) + "-" + cp;
    JsonDocument resp;
    resp["model"] = "glm-5.3-flash";
    resp["choices"][0]["message"]["content"] = answers[cp].front();
    answers[cp].pop_front();
    resp["x_0g_trace"]["request_id"] = rid;
    resp["x_0g_trace"]["provider"] = "0xprovider";
    resp["x_0g_trace"]["billing"]["total_cost"] = 1234;
    resp["tee_verified"] = true;
    serializeJson(resp, r.body);
    r.status = 200;
    r.xRequestId = rid;
    for (auto& kv : h)
      if (kv.first == "X-Client-Request-Id") {
        r.xClientRequestId = kv.second;
        r.hasXClientRequestId = true;
      }
    (void)timeoutMs;
    return r;
  }
  bool camera(Bytes& out, std::string&) override {
    if (jpeg.empty()) return false;
    out = jpeg;
    return true;
  }
  void saveFrame(const std::string& ep, size_t idx, const Bytes& locked) override {
    std::string dir = std::string(OUT_DIR) + "/runs";
    std::ofstream(dir + "/" + ep + ".frame-" + std::to_string(idx) + ".locked", std::ios::binary).write(reinterpret_cast<const char*>(locked.data()), static_cast<std::streamsize>(locked.size()));
  }
};

static const char* PICK = R"({"action":"PICK","slot":"A2","reason":"Red cube at A2.","confidence":0.94})";
static const char* HELD = R"({"action":"CONTINUE","grasped":true,"reason":"Cube held.","confidence":0.9})";
static const char* IN_BIN = R"({"action":"DONE","placed":true,"reason":"Cube in the bin.","confidence":0.95})";

static orch::Prompts prompts() {
  orch::Prompts p;
  const char* files[4] = {"plan.txt", "verify_grasp.txt", "verify_place.txt", "incident.txt"};
  for (int i = 0; i < 4; i++) {
    p.text[i] = readFile(repo() + "/prompts/" + files[i]);
    p.hash[i] = sha256Hex(p.text[i]);
  }
  return p;
}

static void runOne(const char* name, SimPlatform& plat, SimArm& arm, const char* expectOutcome) {
  run::ArmCfg cfg;
  CHECK(run::parseArmConfig(readFile(repo() + "/config/arm.json"), cfg));
  orch::Prompts pr = prompts();
  Bytes pk;
  fromHex(vectors()["eth"]["privateKey"].as<const char*>(), pk);
  eth::Key key;
  eth::keyFromPrivate(pk.data(), key);
  orch::Orchestrator o(plat, arm, cfg, pr, key, "esp32-s3-01", "arm-1");
  JsonObjectConst rj = vectors()["seal"]["recipient"]["publicJwk"];
  o.hasOwner = true;
  o.owner = {rj["x"].as<const char*>(), rj["y"].as<const char*>()};
  o.router.baseUrl = "https://router-api.0g.ai/v1";
  o.router.model = "glm-5.3-flash";
  std::string why;
  o.monitor().pump(0);
  CHECK(o.canStart(why));
  Bytes runKey;
  unbase64(vectors()["seal"]["runKey"].as<const char*>(), runKey);
  std::string id = std::string("ep_20261106051000_") + name;
  std::string dir = std::string(OUT_DIR) + "/runs";
  mkdir(OUT_DIR, 0755);
  mkdir(dir.c_str(), 0755);
  orch::Result r = o.run({"red", "A2"}, id, runKey);
  CHECK_EQ(r.outcome, std::string(expectOutcome));
  CHECK(!r.sealedCanonical.empty());
  std::ofstream(dir + "/" + id + ".json") << r.logCanonical;
  std::ofstream(dir + "/" + id + ".sealed.json") << r.sealedCanonical;
  // the sealed file opens with the run key and holds exactly the readable log
  JsonDocument s;
  CHECK(parseExact(r.sealedCanonical, s));
  std::string back;
  CHECK(seal::openEpisode(runKey, s.as<JsonObjectConst>(), back));
  CHECK_EQ(back, r.logCanonical);
  // the owner's copy of the run key travels inside the file and opens with the owner's private key
  JsonArrayConst ks = s["keys"].as<JsonArrayConst>();
  CHECK_EQ(ks.size(), (size_t)1);
  Bytes fromFile;
  CHECK(seal::unwrapRunKey(ks[0].as<JsonObjectConst>(), o.owner, vectors()["seal"]["recipient"]["d"].as<const char*>(), seal::runContext(key.address, id), fromFile));
  CHECK(fromFile == runKey);
}

TEST(run_normal_pick_to_bin) {
  SimPlatform p;
  SimArm a;
  p.answers["PLAN"] = {PICK};
  p.answers["VERIFY_GRASP"] = {HELD};
  p.answers["VERIFY_PLACE"] = {IN_BIN};
  p.jpeg = utf8("JPEG-FRAME-BYTES");
  runOne("normal", p, a, "DONE");
}

TEST(run_bump_trips_and_resume_is_overridden) {
  SimPlatform p;
  SimArm a;
  a.failAtMove = 6;  // while carrying
  a.injectEv = "trip_bump";
  p.answers["PLAN"] = {PICK};
  p.answers["VERIFY_GRASP"] = {HELD};
  p.answers["INCIDENT"] = {R"({"action":"RESUME","severity":3,"file_claim":true,"reason":"Base struck hard.","confidence":0.88})"};
  runOne("bump", p, a, "TRIPPED");
}

TEST(run_hand_in_zone_resumes_after_clear) {
  SimPlatform p;
  SimArm a;
  a.failAtMove = 6;
  a.injectEv = "hand_in_zone";
  a.clearAfter = 3;
  p.answers["PLAN"] = {PICK};
  p.answers["VERIFY_GRASP"] = {HELD};
  p.answers["INCIDENT"] = {R"({"action":"RESUME","severity":2,"file_claim":false,"reason":"Hand gone.","confidence":0.9})"};
  p.answers["VERIFY_PLACE"] = {IN_BIN};
  runOne("hand", p, a, "DONE");
}

TEST(run_without_0g_is_a_failsafe_stop) {
  SimPlatform p;
  SimArm a;
  p.down = true;
  runOne("cut0g", p, a, "FAILSAFE");
}

TEST(run_low_confidence_and_bad_json_are_handled) {
  SimPlatform p;
  SimArm a;
  p.answers["PLAN"] = {R"(```json
{"action":"PICK","slot":"A2","reason":"maybe","confidence":0.4}
```)"};
  runOne("lowconf", p, a, "ABORTED");
  SimPlatform p2;
  SimArm a2;
  p2.answers["PLAN"] = {R"({"action":"PICK","slot":"A2","reason":"x","confidence":0.9,"extra":1})"};
  runOne("badschema", p2, a2, "FAILSAFE");
}
