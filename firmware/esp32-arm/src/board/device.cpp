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
#include "board/ble.h"
#include "board/outbox.h"
#include "board/relay.h"
#include "board/feed.h"
#include "board/locallink.h"
#include "board/platform.h"
#include "board/state_feed.h"
#include "board/store.h"
#include "config.h"
#include "state.h"
#include "pearl/json.h"
#include "pearl/orch.h"
#include "pearl/bundle.h"
#include "pearl/publish.h"
#include "secrets.h"

#ifndef PEARL_BLE
#define PEARL_BLE 1  // offline relay over Bluetooth LE + the mesh (spec v1 §4, §7)
#endif
#ifndef PEARL_SERVICE_MS
#define PEARL_SERVICE_MS 30000  // how often the run task retries the outbox / carried bundles when idle
#endif

// secrets.h may predate env:device: every device setting has a safe "not configured" default
#ifndef OG_API_KEY
#define OG_API_KEY ""
#endif
#ifndef OG_MODEL
#define OG_MODEL ""
#endif
#ifndef OG_MODEL_FALLBACKS
// tried in order only when OG_MODEL fails on the provider side (same list as apps/backend og/config.ts); "" = none
#define OG_MODEL_FALLBACKS "qwen2.5-vl-72b-instruct,gemini-2.5-flash-lite"
#endif
#ifndef OG_ALLOW_STANDARD_FALLBACK
// 1 = last resort: after every verified call failed on the provider side, the same models in trust mode "standard"
#define OG_ALLOW_STANDARD_FALLBACK 1
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


// ---------------------------------------------------------------- getting runs out (offline relay, spec v1)
// online → flush the outbox (nonce order) and carried bundles, then publish directly; Wi-Fi without internet → the
// laptop relay (mDNS); no Wi-Fi → BLE serves the outbox (always advertising). A bundle is deleted only when it is
// confirmed: the robot's own receipts, or "done" from the laptop relay.
static bundle::Cache nfCache;
static bool catchup = true;  // look for queued runs without a bundle (outbox was full, or a bundle went stale)
static uint32_t lastService = 0;

static void writeMeta(const std::string& id, const JsonDocument& m) {
  std::string s = canonical(m.as<JsonVariantConst>());
  store::writeFile("/runs/" + id + ".meta.json", s);
  feed::send("meta", s);
}

/** What a later direct publish needs, for runs that leave as a bundle (or could not). */
static void saveResult(const orch::Result& r) {
  JsonDocument d;
  d["episodeId"] = r.episodeId;
  d["outcome"] = r.outcome;
  d["headHash"] = r.headHash;
  d["startedAt"] = r.startedAt;
  d["endedAt"] = r.endedAt;
  d["incident"] = r.incident;
  d["severity"] = r.severity;
  JsonArray q = d["requestIds"].to<JsonArray>();
  for (const auto& x : r.requestIds) q.add(x);
  JsonArray f = d["frames"].to<JsonArray>();
  for (const auto& x : r.frames) {
    JsonObject o = f.add<JsonObject>();
    o["idx"] = x.first;
    o["root"] = x.second;
  }
  std::string s;
  serializeJson(d, s);
  store::writeFile("/runs/" + r.episodeId + ".res.json", s);
}

static bool loadResult(const std::string& id, orch::Result& r) {
  std::string s;
  JsonDocument d;
  if (!store::readFile("/runs/" + id + ".res.json", s) || deserializeJson(d, s)) return false;
  if (!store::readFile("/runs/" + id + ".sealed.json", r.sealedCanonical)) return false;
  r.episodeId = id;
  r.outcome = d["outcome"] | "";
  r.headHash = d["headHash"] | "";
  r.startedAt = d["startedAt"] | "";
  r.endedAt = d["endedAt"] | "";
  r.incident = d["incident"] | false;
  r.severity = d["severity"] | 0;
  for (JsonVariantConst x : d["requestIds"].as<JsonArrayConst>()) r.requestIds.push_back(x.as<std::string>());
  for (JsonVariantConst x : d["frames"].as<JsonArrayConst>()) r.frames.push_back({x["idx"] | 0u, x["root"] | ""});
  return true;
}

static std::vector<std::pair<size_t, Bytes>> loadFrames(const orch::Result& r) {
  std::vector<std::pair<size_t, Bytes>> frames;
  for (const auto& f : r.frames) {
    Bytes b;
    if (store::readBytes("/runs/" + r.episodeId + "/f" + std::to_string(f.first) + ".lock", b)) frames.push_back({f.first, b});
  }
  return frames;
}

/** Online = the 0G Chain RPC answers; refreshes the nonce/fee cache on the way (never below the outbox's nonces). */
static bool online(std::string& err) {
  if (WiFi.status() != WL_CONNECTED) {
    err = "no Wi-Fi";
    return false;
  }
  bundle::Cache c = nfCache;
  if (!bundle::refreshCache(plat, pub, devKey, c, err, outbox::nextOg(), outbox::nextArkiv())) return false;
  nfCache = c;
  outbox::saveCache(c);
  return true;
}

static void directPublish(const orch::Result& r, const std::vector<std::pair<size_t, Bytes>>& frames) {
  JsonDocument meta;
  publish::publishRun(plat, pub, devKey, r, frames, meta, [&](const JsonDocument& m) { writeMeta(r.episodeId, m); });
  store::removeFile("/runs/" + r.episodeId + ".res.json");
}

/** Sends own bundles (oldest first) and carried bundles; false when something must wait (keeps nonce order). */
static bool flush() {
  bool clear = true;
  for (const bundle::Entry& e : outbox::own()) {
    std::string json;
    if (!outbox::loadJson(e.bundleId, json)) {
      outbox::removeOwn(e.bundleId);
      continue;
    }
    JsonDocument b, meta;
    if (deserializeJson(b, json)) {
      outbox::removeOwn(e.bundleId);
      continue;
    }
    json.clear();
    json.shrink_to_fit();
    bundle::Submitted s = bundle::submit(plat, pub, b.as<JsonVariantConst>(), meta);
    meta["outbox"]["state"] = s.state;
    writeMeta(e.episodeId, meta);
    Serial.printf("[pearl] outbox %s (%s): %s\n", e.bundleId.substr(0, 10).c_str(), e.episodeId.c_str(), s.state.c_str());
    if (s.state == "retry") {
      clear = false;
      break;  // later bundles have later nonces
    }
    outbox::removeOwn(e.bundleId);
    if (s.state == "stale") catchup = true;  // nonce taken: publish that run directly instead
    else store::removeFile("/runs/" + e.episodeId + ".res.json");
  }
  for (const auto& c : outbox::carried()) {
    std::string json;
    JsonDocument b, meta;
    if (!outbox::loadJson(c.bundleId, json) || deserializeJson(b, json)) {
      outbox::dropCarried(c.bundleId);
      continue;
    }
    json.clear();
    json.shrink_to_fit();
    bundle::Submitted s = bundle::submit(plat, pub, b.as<JsonVariantConst>(), meta);
    Serial.printf("[pearl] carried %s for %s: %s\n", c.bundleId.substr(0, 10).c_str(), c.origin.c_str(), s.state.c_str());
    if (s.state == "done") outbox::deliveredCarried(c.bundleId, c.proofTx, c.proofChainId);  // receipts seen: verified
    else if (s.state == "retry") clear = false;
    else outbox::dropCarried(c.bundleId);  // stale / reverted: only its owner can re-sign
  }
  return clear;
}

/** Runs marked queued/stale that have no bundle left: publish them directly now. */
static void catchUp() {
  bool all = true;
  for (const std::string& id : store::runIds(30)) {
    std::string ms;
    JsonDocument m;
    if (!store::readFile("/runs/" + id + ".meta.json", ms) || deserializeJson(m, ms)) continue;
    std::string st = m["storage"]["status"] | "", an = m["anchor"]["status"] | "";
    if (st != "queued" && st != "stale" && an != "queued" && an != "stale") continue;
    if (outbox::hasOwn(m["bundleId"] | "")) continue;
    orch::Result r;
    if (!loadResult(id, r)) continue;
    std::string err;
    if (!online(err)) {
      all = false;
      break;
    }
    directPublish(r, loadFrames(r));
  }
  catchup = !all;
}

static void stepsToMeta(JsonVariantConst steps, JsonDocument& meta) {
  for (JsonVariantConst st : steps.as<JsonArrayConst>()) {
    std::string p = st["purpose"] | "";
    JsonObject o;
    if (p == "storage:log") o = meta["storage"].to<JsonObject>();
    else if (p == "anchor") o = meta["anchor"].to<JsonObject>();
    else if (p == "arkiv") o = meta["arkiv"].to<JsonObject>();
    else continue;
    std::string status = st["status"] | "failed";
    o["status"] = status;
    o["txHash"] = st["txHash"] | "";
    o["via"] = "relay";
    if (st["error"].is<const char*>()) o["error"] = st["error"];
  }
}

/** Wi-Fi but no internet: hand bundles to the laptop relay and follow them until done. */
static void relayService() {
  std::string base = relay::find();
  if (base.empty()) return;
  for (const bundle::Entry& e : outbox::own()) {
    JsonDocument st;
    std::string err;
    bool known = relay::status(plat, base, e.bundleId, st, err);
    if (!known && err.find("404") == std::string::npos) {
      relay::forget();  // relay gone
      return;
    }
    if (!known) {
      std::string json;
      if (!outbox::loadJson(e.bundleId, json) || !relay::post(plat, base, json, err)) {
        Serial.printf("[pearl] relay post %s: %s\n", e.bundleId.substr(0, 10).c_str(), err.c_str());
        return;
      }
      outbox::setOwnState(e.bundleId, "posted", base);
      continue;
    }
    std::string state = st["state"] | "";
    if (state == "done" || state == "stale" || state == "failed") {
      JsonDocument meta;
      std::string old;
      if (store::readFile("/runs/" + e.episodeId + ".meta.json", old)) deserializeJson(meta, old);
      meta["episodeId"] = e.episodeId;
      stepsToMeta(st["steps"], meta);
      meta["outbox"]["state"] = state;
      meta["outbox"]["via"] = "relay";
      writeMeta(e.episodeId, meta);
    }
    if (state == "done") {
      outbox::removeOwn(e.bundleId);
      store::removeFile("/runs/" + e.episodeId + ".res.json");
    } else if (state == "stale") {
      outbox::removeOwn(e.bundleId);
      catchup = true;
    } else if (state == "failed")
      outbox::setOwnState(e.bundleId, "queued");
  }
  for (const auto& c : outbox::carried()) {
    JsonDocument st;
    std::string err;
    if (!relay::status(plat, base, c.bundleId, st, err)) {
      std::string json;
      if (err.find("404") != std::string::npos && outbox::loadJson(c.bundleId, json)) relay::post(plat, base, json, err);
      continue;
    }
    std::string state = st["state"] | "";
    // the laptop relay delivered it: drop it, but no receipt (receipts only for what this robot verified on-chain)
    if (state == "done") outbox::dropCarried(c.bundleId);
    else if (state == "stale" || state == "failed") outbox::dropCarried(c.bundleId);
  }
}

/** Packs the run into a pre-signed bundle in the outbox (BLE serves it; the relay or the robot sends it later). */
static void queue(const orch::Result& r, const std::vector<std::pair<size_t, Bytes>>& frames, const std::string& why) {
  saveResult(r);
  JsonDocument meta;
  meta["episodeId"] = r.episodeId;
  for (const char* part : {"storage", "anchor", "arkiv"}) meta[part]["status"] = "queued";
  bundle::Cache c = nfCache;
  bundle::Built b;
  std::string err;
  if (bundle::build(pub, devKey, r, frames, plat.nowIso(), randomBytes(16), c, bundle::Limits{}, b, err) &&
      outbox::addOwn(b, r.episodeId, r.outcome, r.severity, err)) {
    nfCache = c;
    outbox::saveCache(c);
    meta["bundleId"] = b.bundleId;
    meta["outbox"]["state"] = "queued";
    meta["outbox"]["reason"] = why;
    Serial.printf("[pearl] offline (%s): run %s packed as bundle %s (%u B, %u txs)\n", why.c_str(), r.episodeId.c_str(), b.bundleId.substr(0, 10).c_str(),
                  static_cast<unsigned>(b.json.size()), static_cast<unsigned>(b.txs));
  } else {
    meta["outbox"]["state"] = "waiting";
    meta["outbox"]["error"] = err;
    catchup = true;
    Serial.printf("[pearl] offline (%s): run %s kept on the robot (%s)\n", why.c_str(), r.episodeId.c_str(), err.c_str());
  }
  writeMeta(r.episodeId, meta);
}

static void publishOrQueue(const orch::Result& r, const std::vector<std::pair<size_t, Bytes>>& frames) {
  std::string err;
  if (online(err)) {
    bool clear = flush();
    if (catchup) catchUp();
    if (clear) {
      directPublish(r, frames);
      online(err);  // nonces after this run's txs, for the next offline bundle
      return;
    }
    err = "older bundles still waiting";
  }
  queue(r, frames, err);
  if (WiFi.status() == WL_CONNECTED) relayService();
}

/** Idle: retry the outbox and carried bundles. */
static void service() {
  if (!clockReady()) return;
  bool work = catchup || !outbox::own().empty() || !outbox::carried().empty();
  if (!work) return;
  std::string err;
  if (online(err)) {
    flush();
    if (catchup) catchUp();
  } else if (WiFi.status() == WL_CONNECTED)
    relayService();
}

static void worker(void*) {
  for (;;) {
    StartReq req;
    if (xQueueReceive(startQ, &req, pdMS_TO_TICKS(50)) != pdTRUE) {
      // idle: keep the monitor current (telemetry, trips) and apply an operator reset
      orchestrator->monitor().pump(50);
      if (resetClear.exchange(false)) orchestrator->monitor().clearTrip();
      if (millis() - lastService > PEARL_SERVICE_MS) {
        lastService = millis();
        service();
      }
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
    // tell the neighbourhood (BLE ping, gossiped by the mesh), then get the run out by the best way available
    ble::setPing(bundle::pingJson(devKey, id, r.outcome, r.severity, r.headHash, isoToEpochMs(r.endedAt)));
    std::vector<std::pair<size_t, Bytes>> frames;
    for (const auto& f : r.frames) {
      Bytes b;
      if (store::readBytes("/runs/" + id + "/f" + std::to_string(f.first) + ".lock", b)) frames.push_back({f.first, b});
    }
    publishOrQueue(r, frames);
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

  outbox::begin(keyOk ? devKey.address : "", DEVICE_ID);
  nfCache = outbox::cache();
  WiFi.mode(WIFI_STA);
  // Wi-Fi and BLE share the S3's radio: coexistence needs Wi-Fi modem sleep when BLE is on
  WiFi.setSleep(PEARL_BLE ? true : false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 80 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  Serial.printf("[pearl] Wi-Fi %s %s\n", WiFi.status() == WL_CONNECTED ? "connected," : "NOT connected", WiFi.localIP().toString().c_str());
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");  // UTC
  std::string last4 = keyOk ? devKey.address.substr(devKey.address.size() - 4) : "0000";
  for (char& ch : last4) ch = static_cast<char>(tolower(static_cast<unsigned char>(ch)));
  relay::begin("pearl-" + last4);
#if PEARL_BLE
  if (keyOk) ble::begin("Pearl-" + last4);
#endif

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
  orchestrator->router.fallbackModels = split(OG_MODEL_FALLBACKS);
  orchestrator->router.allowStandardFallback = OG_ALLOW_STANDARD_FALLBACK != 0;
  orchestrator->router.timeoutMs = 30000;
  startQ = xQueueCreate(1, sizeof(StartReq));
  // the run task: 0G calls, TLS and publishing block here, never in loop() where the safety checks run
  xTaskCreatePinnedToCore(worker, "run", 32768, nullptr, 1, nullptr, 0);
  api::begin(8070);
  Serial.printf("[pearl] device ready: http://%s:8070  (DEVICE_URL for the dashboard server)\n", WiFi.localIP().toString().c_str());
}

}  // namespace device
#endif
