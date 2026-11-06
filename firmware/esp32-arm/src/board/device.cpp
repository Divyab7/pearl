#ifdef PEARL_DEVICE
#include "device.h"
#include <Arduino.h>
#include <WiFi.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include "board/api.h"
#include "board/assets.h"
#include "board/feed.h"
#include "board/locallink.h"
#include "board/platform.h"
#include "board/state_feed.h"
#include "board/store.h"
#include "config.h"
#include "state.h"
#include "pearl/json.h"
#include "pearl/orch.h"
#include "pearl/publish.h"
#include "secrets.h"

// secrets.h may predate env:device: every device setting has a safe "not configured" default
#ifndef OG_API_KEY
#define OG_API_KEY ""
#endif
#ifndef OG_MODEL
#define OG_MODEL ""
#endif
#ifndef OG_BASE_URL
#define OG_BASE_URL "https://router-api.0g.ai/v1"
#endif
#ifndef OG_ANCHOR_ADDRESS
#define OG_ANCHOR_ADDRESS ""
#endif
#ifndef ARKIV_ACCESS_KEY
#define ARKIV_ACCESS_KEY ""
#endif
#ifndef CAMERA_URL
#define CAMERA_URL ""
#endif
#ifndef OG_STORAGE_NODES
#define OG_STORAGE_NODES ""
#endif

using namespace pearl;

// ---------------------------------------------------------------- status snapshot
namespace statefeed {
static SemaphoreHandle_t lock;
static std::string ph = "IDLE", ep, color, from, out;
static std::atomic<bool> isBusy{false};
void begin() { lock = xSemaphoreCreateMutex(); }
void phase(const std::string& p, const std::string& e) {
  xSemaphoreTake(lock, portMAX_DELAY);
  ph = p;
  if (!e.empty()) ep = e;
  xSemaphoreGive(lock);
  feed::send("status", json());
}
void task(const std::string& c, const std::string& f) {
  xSemaphoreTake(lock, portMAX_DELAY);
  color = c;
  from = f;
  out.clear();
  xSemaphoreGive(lock);
}
void outcome(const std::string& o) {
  xSemaphoreTake(lock, portMAX_DELAY);
  out = o;
  xSemaphoreGive(lock);
}
std::string json() {
  JsonDocument d;
  xSemaphoreTake(lock, portMAX_DELAY);
  d["phase"] = ph;
  if (ep.empty()) d["episodeId"] = nullptr;
  else d["episodeId"] = ep;
  if (color.empty()) d["task"] = nullptr;
  else {
    d["task"]["task"] = "pick";
    d["task"]["color"] = color;
    d["task"]["from"] = from;
    d["task"]["to"] = "BIN";
  }
  if (out.empty()) d["outcome"] = nullptr;
  else d["outcome"] = out;
  xSemaphoreGive(lock);
  d["records"] = 0;
  d["lastDecision"] = nullptr;
  std::string s;
  serializeJson(d, s);
  return s;
}
bool busy() { return isBusy; }
void setBusy(bool b) { isBusy = b; }
}  // namespace statefeed

namespace device {

/** The arm on this chip, through locallink's queues. */
struct LocalArm : orch::ArmLink {
  void send(const JsonDocument& cmd) override { locallink::toArm(cmd); }
  bool recv(JsonDocument& msg, uint32_t waitMs) override { return locallink::nextFromArm(msg, waitMs); }
};

static Esp32Platform plat;
static LocalArm arm;
static eth::Key devKey;
static run::ArmCfg cfg;
static orch::Prompts prompts;
static orch::Orchestrator* orchestrator;
static publish::Config pub;
static QueueHandle_t startQ;
static std::atomic<bool> resetClear{false};
static std::atomic<bool> cut{false};
static bool keyOk = false;

struct StartReq {
  char id[40];
  char color[17];
  char from[4];
};

const eth::Key& key() { return devKey; }
const char* deviceId() { return DEVICE_ID; }
bool cut0g() { return cut; }
void setCut0g(bool on) {
  cut = on;
  if (orchestrator) orchestrator->cut0g = on;
}
void requestStop() {
  if (orchestrator) orchestrator->requestStop();
  JsonDocument d;
  d["cmd"] = "safe";
  locallink::toArm(d);
}
void requestResetClear() { resetClear = true; }
bool cameraConfigured() { return !plat.cameraUrl.empty(); }
bool cameraJpeg(Bytes& out, std::string& err) { return plat.get(plat.cameraUrl, out, err); }

std::string modulesJson() {
  JsonDocument d;
  d["ogChainAnchor"] = pub.anchorAddress.empty() ? "not_configured" : "on";
  d["indexArkiv"] = "on";
  d["robotZerobot"] = "off";
  std::string s;
  serializeJson(d, s);
  return s;
}

static std::string newEpisodeId() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm g;
  gmtime_r(&tv.tv_sec, &g);
  char b[40];
  uint8_t r[2];
  randomFill(r, 2);
  snprintf(b, sizeof b, "ep_%04d%02d%02d%02d%02d%02d_%02x%02x", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, r[0], r[1]);
  return b;
}

bool requestStart(const std::string& color, const std::string& from, std::string& id, std::string& why) {
  if (!keyOk) why = "the robot has no key (NVS failed)";
  else if (!clockReady()) why = "no network time yet (NTP): runs need real timestamps";
  else if (statefeed::busy()) why = "an episode is already running";
  else if (dev.state == DevState::TRIPPED) why = "device is TRIPPED: operator reset required";
  else if (dev.state == DevState::FROZEN_HAND) why = "device is FROZEN_HAND: clear the zone first";
  else {
    StartReq r = {};
    id = newEpisodeId();
    strncpy(r.id, id.c_str(), sizeof r.id - 1);
    strncpy(r.color, color.c_str(), sizeof r.color - 1);
    strncpy(r.from, from.c_str(), sizeof r.from - 1);
    statefeed::setBusy(true);
    if (xQueueSend(startQ, &r, 0) == pdTRUE) return true;
    statefeed::setBusy(false);
    why = "busy";
  }
  return false;
}

static void worker(void*) {
  for (;;) {
    StartReq req;
    if (xQueueReceive(startQ, &req, pdMS_TO_TICKS(50)) != pdTRUE) {
      // idle: keep the monitor current (telemetry, trips) and apply an operator reset
      orchestrator->monitor().pump(50);
      if (resetClear.exchange(false)) orchestrator->monitor().clearTrip();
      continue;
    }
    std::string id = req.id;
    Bytes runKey = randomBytes(32);
    store::saveRunKey(id, runKey);  // kept so the robot can lock this run for its owner (now or after a re-link)
    statefeed::task(req.color, req.from);
    {
      // the owner linked now gets a copy of this run's key inside the sealed file
      std::string ownerJson;
      JsonDocument o;
      orchestrator->hasOwner = store::loadOwner(ownerJson) && !deserializeJson(o, ownerJson) && o["x"].is<const char*>() && o["y"].is<const char*>();
      if (orchestrator->hasOwner) orchestrator->owner = {o["x"].as<const char*>(), o["y"].as<const char*>()};
    }
    orch::Result r = orchestrator->run({req.color, req.from}, id, runKey);
    statefeed::outcome(r.outcome);
    store::writeFile("/runs/" + id + ".json", r.logCanonical);  // the robot's own memory
    store::writeFile("/runs/" + id + ".sealed.json", r.sealedCanonical);
    {
      JsonDocument e;
      e["episodeId"] = id;
      e["outcome"] = r.outcome;
      e["headHash"] = r.headHash;
      std::string s;
      serializeJson(e, s);
      feed::send("episode", s);
    }
    statefeed::setBusy(false);
    // publish with the robot's own key: 0G Storage, 0G Chain anchor, Arkiv (each result into the meta file)
    std::vector<std::pair<size_t, Bytes>> frames;
    for (const auto& f : r.frames) {
      Bytes b;
      if (store::readBytes("/runs/" + id + "/f" + std::to_string(f.first) + ".lock", b)) frames.push_back({f.first, b});
    }
    JsonDocument meta;
    publish::publishRun(plat, pub, devKey, r, frames, meta, [&](const JsonDocument& m) {
      std::string s = canonical(m.as<JsonVariantConst>());
      store::writeFile("/runs/" + id + ".meta.json", s);
      feed::send("meta", s);
    });
  }
}

static std::vector<std::string> split(const char* csv) {
  std::vector<std::string> v;
  std::string s = csv, cur;
  for (char ch : s) {
    if (ch == ',') {
      if (!cur.empty()) v.push_back(cur);
      cur.clear();
    } else if (ch != ' ') cur.push_back(ch);
  }
  if (!cur.empty()) v.push_back(cur);
  return v;
}

void begin() {
  locallink::begin();
  feed::begin();
  statefeed::begin();
  bool fsOk = store::begin();
  keyOk = fsOk && store::deviceKey(devKey);
  Serial.printf("[pearl] storage %s, robot key %s\n", fsOk ? "ok" : "FAILED", keyOk ? devKey.address.c_str() : "FAILED");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 80 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  Serial.printf("[pearl] Wi-Fi %s %s\n", WiFi.status() == WL_CONNECTED ? "connected," : "NOT connected", WiFi.localIP().toString().c_str());
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");  // UTC

  run::parseArmConfig(ARM_JSON, cfg);
  const char* texts[4] = {PROMPT_PLAN, PROMPT_VERIFY_GRASP, PROMPT_VERIFY_PLACE, PROMPT_INCIDENT};
  for (int i = 0; i < 4; i++) {
    prompts.text[i] = texts[i];
    prompts.hash[i] = sha256Hex(prompts.text[i]);
  }
  plat.cameraUrl = CAMERA_URL;
  pub.anchorAddress = OG_ANCHOR_ADDRESS;
  pub.storageNodes = split(OG_STORAGE_NODES);
  pub.arkivRpc = std::string("https://rpc.rabdi.db-chain.testnet.arkiv.network") + (strlen(ARKIV_ACCESS_KEY) ? std::string("/") + ARKIV_ACCESS_KEY : "");

  orchestrator = new orch::Orchestrator(plat, arm, cfg, prompts, devKey, DEVICE_ID, "arm-1");
  orchestrator->router.baseUrl = OG_BASE_URL;
  orchestrator->router.apiKey = OG_API_KEY;
  orchestrator->router.model = OG_MODEL;
  orchestrator->router.timeoutMs = 30000;
  startQ = xQueueCreate(1, sizeof(StartReq));
  // the run task: 0G calls, TLS and publishing block here, never in loop() where the safety checks run
  xTaskCreatePinnedToCore(worker, "run", 32768, nullptr, 1, nullptr, 0);
  api::begin(8070);
  Serial.printf("[pearl] device ready: http://%s:8070  (DEVICE_URL for the dashboard server)\n", WiFi.localIP().toString().c_str());
}

}  // namespace device
#endif
