#ifdef PEARL_DEVICE
#include "outbox.h"
#include <Arduino.h>
#include <LittleFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <sys/time.h>
#include <atomic>
#include "board/platform.h"
#include "board/store.h"
#include "config.h"
#include "pearl/json.h"
#include "secrets.h"

#ifndef PEARL_OUTBOX_CAP
#define PEARL_OUTBOX_CAP (2u << 20)  // the LittleFS partition is 3.4 MB (default_16MB.csv) and runs live there too
#endif
#ifndef PEARL_CARRY_CAP
#define PEARL_CARRY_CAP (1u << 20)  // spec: 4 MB; capped by the same partition (override in secrets.h)
#endif

using namespace pearl;

namespace outbox {

static SemaphoreHandle_t mu;
static bundle::Index ownIx;
static mesh::Carry carry;
static mesh::Pings pings;
static std::string self, selfLower, devId;
static std::atomic<uint32_t> ver{1};

struct Lock {
  Lock() { xSemaphoreTake(mu, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(mu); }
};

static uint64_t nowMs() {
  if (!clockReady()) return 0;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return static_cast<uint64_t>(tv.tv_sec) * 1000 + tv.tv_usec / 1000;
}

static std::string ownPath(const std::string& id, const char* ext) { return "/outbox/" + id + ext; }
static std::string carryPath(const std::string& id, const char* ext) { return "/carry/" + id + ext; }

static void saveReceipts() {
  std::string s;
  {
    Lock l;
    JsonDocument d;
    JsonArray a = d.to<JsonArray>();
    for (const auto& r : carry.receipts) {
      JsonObject o = a.add<JsonObject>();
      o["bundleId"] = r.bundleId;
      o["anchorTx"] = r.anchorTx;
      o["chainId"] = r.chainId;
      o["atMs"] = r.atMs;
    }
    serializeJson(d, s);
  }
  store::writeFile("/carry/receipts.json", s);
}

bool begin(const std::string& selfAddress, const std::string& deviceId) {
  mu = xSemaphoreCreateMutex();
  self = selfAddress;
  selfLower = bundle::hex0x(selfAddress);
  devId = deviceId;
  carry.pol.cap = PEARL_CARRY_CAP;
  if (!LittleFS.exists("/outbox")) LittleFS.mkdir("/outbox");
  if (!LittleFS.exists("/carry")) LittleFS.mkdir("/carry");
  for (const std::string& n : store::listDir("/outbox")) {
    if (n.size() < 4 || n.compare(n.size() - 3, 3, ".st") != 0) continue;
    std::string s;
    bundle::Entry e;
    if (store::readFile("/outbox/" + n, s) && bundle::parseEntry(s, e) && LittleFS.exists(ownPath(e.bundleId, ".json").c_str())) ownIx.add(e);
  }
  for (const std::string& n : store::listDir("/carry")) {
    if (n.size() < 4 || n.compare(n.size() - 3, 3, ".st") != 0) continue;
    std::string s;
    mesh::Carried c;
    if (store::readFile("/carry/" + n, s) && mesh::parseCarried(s, c) && LittleFS.exists(carryPath(c.bundleId, ".json").c_str())) carry.add(c);
  }
  std::string r;
  JsonDocument d;
  if (store::readFile("/carry/receipts.json", r) && !deserializeJson(d, r))
    for (JsonObjectConst o : d.as<JsonArrayConst>()) carry.receipts.push_back({o["bundleId"] | "", o["anchorTx"] | "", o["chainId"] | 0ULL, o["atMs"] | 0ULL});
  Serial.printf("[pearl] outbox: %u own bundle(s), carrying %u, %u receipt(s)\n", static_cast<unsigned>(ownIx.list.size()), static_cast<unsigned>(carry.items.size()),
                static_cast<unsigned>(carry.receipts.size()));
  return true;
}

// ---------------------------------------------------------------- cache
bundle::Cache cache() {
  bundle::Cache c;
  bundle::parseCache(store::getStr("nfcache"), c);
  return c;
}
void saveCache(const bundle::Cache& c) { store::putStr("nfcache", bundle::cacheJson(c)); }

// ---------------------------------------------------------------- own
bool addOwn(const bundle::Built& b, const std::string& episodeId, const std::string& outcome, int severity, std::string& err) {
  {
    Lock l;
    if (!ownIx.fits(b.json.size(), PEARL_OUTBOX_CAP)) {
      err = "outbox full (" + std::to_string(ownIx.bytes()) + " B)";
      return false;
    }
  }
  if (store::freeBytes() < b.json.size() + 64 * 1024) {
    err = "flash full";
    return false;
  }
  bundle::Entry e;
  e.bundleId = b.bundleId;
  e.episodeId = episodeId;
  e.outcome = outcome;
  e.severity = severity;
  e.size = b.json.size();
  e.seq = store::nextSeq();
  e.ogNext = b.ogNext;
  e.arkivNext = b.arkivNext;
  if (!store::writeFile(ownPath(b.bundleId, ".json"), b.json) || !store::writeFile(ownPath(b.bundleId, ".st"), bundle::entryJson(e))) {
    store::removeFile(ownPath(b.bundleId, ".json"));
    err = "write failed";
    return false;
  }
  Lock l;
  ownIx.add(e);
  ver++;
  return true;
}

std::vector<bundle::Entry> own() {
  Lock l;
  return ownIx.ordered();
}

bool hasOwn(const std::string& id) {
  Lock l;
  return ownIx.find(id) != nullptr;
}

bool loadJson(const std::string& id, std::string& json) {
  if (!bundle::validId(id)) return false;
  return store::readFile(ownPath(id, ".json"), json) || store::readFile(carryPath(id, ".json"), json);
}

void removeOwn(const std::string& id) {
  {
    Lock l;
    if (!ownIx.remove(id)) return;
  }
  store::removeFile(ownPath(id, ".json"));
  store::removeFile(ownPath(id, ".st"));
  ver++;
}

void setOwnState(const std::string& id, const std::string& state, const std::string& relay) {
  std::string st;
  {
    Lock l;
    bundle::Entry* e = ownIx.find(id);
    if (!e) return;
    e->state = state;
    if (!relay.empty()) e->relay = relay;
    st = bundle::entryJson(*e);
  }
  store::writeFile(ownPath(id, ".st"), st);
  ver++;
}

uint64_t nextOg() {
  Lock l;
  return ownIx.nextOg();
}
uint64_t nextArkiv() {
  Lock l;
  return ownIx.nextArkiv();
}

// ---------------------------------------------------------------- carried
mesh::Admit offerCarry(const std::string& json, int hops, std::string& why) {
  mesh::Verified v;
  {
    JsonDocument d;  // big strings land in PSRAM (malloc > 4 KB goes there on this core)
    if (deserializeJson(d, json)) {
      why = "not JSON";
      return mesh::Admit::INVALID;
    }
    if (!mesh::verify(d.as<JsonVariantConst>(), mesh::Chains{}, v, why)) return mesh::Admit::INVALID;
  }
  mesh::Carried c;
  c.bundleId = v.bundleId;
  c.origin = bundle::hex0x(v.device);
  c.episodeId = v.episodeId;
  c.outcome = v.outcome;
  c.severity = v.severity;
  c.size = json.size();
  c.createdAtMs = v.createdAtMs;
  c.receivedAtMs = nowMs();
  c.hops = hops;
  c.proofTx = v.anchorTx.empty() ? v.lastTx : v.anchorTx;
  c.proofChainId = v.anchorTx.empty() ? v.lastChainId : v.anchorChainId;
  std::vector<std::string> evict;
  mesh::Admit a;
  {
    Lock l;
    a = carry.admit(c, nowMs() ? nowMs() : c.createdAtMs, self, evict);
  }
  if (a != mesh::Admit::OK) {
    why = mesh::admitName(a);
    return a;
  }
  for (const std::string& id : evict) dropCarried(id);
  if (store::freeBytes() < json.size() + 64 * 1024) {
    why = "flash full";
    return mesh::Admit::NO_ROOM;
  }
  if (!store::writeFile(carryPath(c.bundleId, ".json"), json) || !store::writeFile(carryPath(c.bundleId, ".st"), mesh::carriedJson(c))) {
    store::removeFile(carryPath(c.bundleId, ".json"));
    why = "write failed";
    return mesh::Admit::NO_ROOM;
  }
  Lock l;
  carry.add(c);
  ver++;
  return mesh::Admit::OK;
}

bool wantsCarry(const mesh::ListItem& li) {
  mesh::Carried c;
  c.bundleId = li.bundleId;
  c.origin = li.origin;
  c.severity = li.severity;
  c.size = li.size;
  c.hops = li.hops + 1;
  uint64_t now = nowMs();
  c.createdAtMs = now ? now : 1;  // unknown until downloaded: TTL is checked after verification
  std::vector<std::string> evict;
  Lock l;
  if (ownIx.find(li.bundleId)) return false;
  return carry.admit(c, now ? now : 1, self, evict) == mesh::Admit::OK;
}

std::vector<mesh::Carried> carried() {
  Lock l;
  return carry.ordered();
}

void dropCarried(const std::string& id) {
  {
    Lock l;
    if (!carry.remove(id)) return;
  }
  store::removeFile(carryPath(id, ".json"));
  store::removeFile(carryPath(id, ".st"));
  ver++;
}

void deliveredCarried(const std::string& id, const std::string& anchorTx, uint64_t chainId) {
  {
    Lock l;
    carry.delivered(id, anchorTx, chainId, nowMs());
  }
  store::removeFile(carryPath(id, ".json"));
  store::removeFile(carryPath(id, ".st"));
  saveReceipts();
  ver++;
}

void unverifiedDone(const std::string& id) {
  bool ownHit;
  {
    Lock l;
    ownHit = ownIx.find(id) != nullptr;
  }
  if (ownHit) {
    setOwnState(id, "relayed");
    return;
  }
  std::string st;
  {
    Lock l;
    if (!carry.stopForward(id)) return;
    st = mesh::carriedJson(*carry.find(id));
  }
  store::writeFile(carryPath(id, ".st"), st);
  ver++;
}

void expire() {
  uint64_t now = nowMs();
  if (!now) return;
  std::vector<std::string> gone;
  size_t before;
  {
    Lock l;
    before = carry.receipts.size();
    gone = carry.expire(now);
  }
  for (const std::string& id : gone) {
    store::removeFile(carryPath(id, ".json"));
    store::removeFile(carryPath(id, ".st"));
  }
  if (!gone.empty() || carry.receipts.size() != before) {
    saveReceipts();
    ver++;
  }
}

// ---------------------------------------------------------------- pings
void addPing(const std::string& json) {
  Lock l;
  if (pings.add(json)) ver++;
}
std::string pingsJson(size_t maxBytes) {
  Lock l;
  return pings.json(maxBytes);
}

// ---------------------------------------------------------------- BLE view
std::string info() {
  Lock l;
  return ownIx.infoJson(self, devId, carry.forwardable(), carry.receipts.size());
}

std::string listing(const std::string& what) {
  Lock l;
  if (what == "LIST") return mesh::listJson(ownIx, self, carry);
  if (what == "RECEIPTS") return mesh::receiptsJson(carry);
  if (what == "PINGS") return pings.json();
  return "[]";
}

size_t read(const std::string& id, size_t off, uint8_t* out, size_t n) {
  if (!bundle::validId(id)) return 0;
  File f = LittleFS.open(ownPath(id, ".json").c_str(), "r");
  if (!f) f = LittleFS.open(carryPath(id, ".json").c_str(), "r");
  if (!f) return 0;
  size_t got = 0;
  if (off < f.size() && f.seek(off)) got = f.read(out, n);
  f.close();
  return got;
}

uint8_t advPending() {
  Lock l;
  size_t n = ownIx.list.size() + carry.forwardable();
  return static_cast<uint8_t>(n > 255 ? 255 : n);
}
uint8_t advMaxSeverity() {
  Lock l;
  return std::max(ownIx.maxSeverity(), carry.maxSeverity());
}
uint32_t version() { return ver; }

std::string statusJson() {
  JsonDocument d;
  Lock l;
  JsonArray o = d["own"].to<JsonArray>();
  for (const auto& e : ownIx.ordered()) {
    JsonDocument x;
    deserializeJson(x, bundle::entryJson(e));
    o.add(x.as<JsonVariantConst>());
  }
  JsonArray c = d["carrying"].to<JsonArray>();
  for (const auto& e : carry.ordered()) {
    JsonDocument x;
    deserializeJson(x, mesh::carriedJson(e));
    c.add(x.as<JsonVariantConst>());
  }
  d["receipts"] = carry.receipts.size();
  d["pings"] = pings.list.size();
  d["ownBytes"] = ownIx.bytes();
  d["carryBytes"] = carry.bytes();
  std::string s;
  serializeJson(d, s);
  return s;
}

}  // namespace outbox
#endif
