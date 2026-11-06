#ifdef PEARL_DEVICE
#include "ble.h"
#include <Arduino.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <host/ble_att.h>
#include <algorithm>
#include <atomic>
#include <map>
#include "board/outbox.h"
#include "config.h"
#include "pearl/bundle.h"
#include "pearl/mesh.h"
#include "secrets.h"

#ifndef PEARL_MESH
#define PEARL_MESH 1  // the central pull cycle (spec §7); 0 = peripheral only
#endif
#ifndef PEARL_MESH_PERIOD_MS
#define PEARL_MESH_PERIOD_MS 30000
#endif

using namespace pearl;

namespace ble {

#define UUID(n) "5b0e000" #n "-7c2a-4f8e-9a51-70ea21c0b10c"
static const char* SVC = UUID(1);
static const char* C_INFO = UUID(2);
static const char* C_PING = UUID(3);
static const char* C_SELECT = UUID(4);
static const char* C_DATA = UUID(5);
static const char* C_ACK = UUID(6);
static const char* C_PINGS = UUID(7);

static BLEServer* server;
static BLECharacteristic *chInfo, *chPing, *chSelect, *chData, *chAck, *chPings;
static std::string devName;
static std::atomic<bool> up{false};
static QueueHandle_t ackQ;
static SemaphoreHandle_t curMu;
static std::map<uint16_t, bundle::Cursor> cursors;  // one per connection (a courier and a peer robot may both be in)

struct AckMsg {
  char text[512];
};

/** The bundle bytes and the listings, for the cursor (file reads are small and bounded: ≤ 512 B per read). */
struct OutboxSource : bundle::Source {
  size_t read(const std::string& id, size_t off, uint8_t* out, size_t n) override { return outbox::read(id, off, out, n); }
  std::string listing(const std::string& what) override { return outbox::listing(what); }
};
static OutboxSource source;

// ---------------------------------------------------------------- peripheral
struct ServerCb : BLEServerCallbacks {
  void onConnect(BLEServer* s, ble_gap_conn_desc* desc) override {
    xSemaphoreTake(curMu, portMAX_DELAY);
    cursors[desc->conn_handle] = bundle::Cursor();
    xSemaphoreGive(curMu);
    BLEDevice::startAdvertising();  // stay discoverable for other couriers / peers
  }
  void onDisconnect(BLEServer* s, ble_gap_conn_desc* desc) override {
    xSemaphoreTake(curMu, portMAX_DELAY);
    cursors.erase(desc->conn_handle);
    xSemaphoreGive(curMu);
    BLEDevice::startAdvertising();
  }
};

struct InfoCb : BLECharacteristicCallbacks {
  void onRead(BLECharacteristic* c, ble_gap_conn_desc*) override { c->setValue(String(outbox::info().c_str())); }
};
struct PingsCb : BLECharacteristicCallbacks {
  void onRead(BLECharacteristic* c, ble_gap_conn_desc*) override { c->setValue(String(outbox::pingsJson(512).c_str())); }
};
struct SelectCb : BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c, ble_gap_conn_desc* desc) override {
    String v = c->getValue();
    xSemaphoreTake(curMu, portMAX_DELAY);
    cursors[desc->conn_handle].select(std::string(v.c_str(), v.length()), source);
    xSemaphoreGive(curMu);
  }
};
struct DataCb : BLECharacteristicCallbacks {
  void onRead(BLECharacteristic* c, ble_gap_conn_desc* desc) override {
    // never more than fits one ATT response: no Read Blob follow-ups, so one read = one advance, per connection
    uint16_t mtu = ble_att_mtu(desc->conn_handle);
    size_t max = std::min<size_t>(bundle::CHUNK_MAX, mtu > 1 ? mtu - 1 : 22);
    static uint8_t buf[bundle::CHUNK_MAX];  // the host task is single-threaded
    xSemaphoreTake(curMu, portMAX_DELAY);
    size_t n = cursors[desc->conn_handle].next(source, buf, max);
    xSemaphoreGive(curMu);
    c->setValue(buf, n);
  }
};
struct AckCb : BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c, ble_gap_conn_desc*) override {
    AckMsg m = {};
    String v = c->getValue();
    strncpy(m.text, v.c_str(), sizeof m.text - 1);
    xQueueSend(ackQ, &m, 0);  // handled in the mesh task
  }
};

static void advertise() {
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->stop();
  // 31-byte budget: flags (3) + 128-bit service (18) here; name + manufacturer data in the scan response
  BLEAdvertisementData ad;
  ad.setFlags(0x06);
  ad.setCompleteServices(BLEUUID(SVC));
  adv->setAdvertisementData(ad);
  BLEAdvertisementData sr;
  sr.setName(String(devName.c_str()));
  char m[5] = {static_cast<char>(0xFF), static_cast<char>(0xFF), 1, static_cast<char>(outbox::advPending()), static_cast<char>(outbox::advMaxSeverity())};
  sr.setManufacturerData(String(m, 5));
  adv->setScanResponseData(sr);
  adv->setMinInterval(0x140);  // 200–300 ms: easy on the radio Wi-Fi shares
  adv->setMaxInterval(0x1E0);
  adv->start();
}

// ---------------------------------------------------------------- central: the pull cycle
struct Peer {
  uint32_t lastVisit = 0, backoffUntil = 0;
  int fails = 0;
};
static std::map<std::string, Peer> peers;
static BLEClient* client;

static bool readAll(BLERemoteCharacteristic* sel, BLERemoteCharacteristic* data, const std::string& what, size_t cap, std::string& out) {
  out.clear();
  if (!sel->writeValue(reinterpret_cast<uint8_t*>(const_cast<char*>(what.data())), what.size(), true)) return false;
  for (int guard = 0; guard < 20000; guard++) {
    if (!client->isConnected()) return false;
    String v = data->readValue();
    if (v.length() == 0) return true;
    out.append(v.c_str(), v.length());
    if (out.size() > cap) return false;
  }
  return false;
}

static bool pull(BLEAdvertisedDevice& dev) {
  if (!client) client = BLEDevice::createClient();
  if (!client->connectTimeout(&dev, 5000)) return false;
  client->setMTU(517);
  bool ok = false;
  do {
    BLERemoteService* s = client->getService(BLEUUID(SVC));
    if (!s) break;
    BLERemoteCharacteristic *sel = s->getCharacteristic(BLEUUID(C_SELECT)), *data = s->getCharacteristic(BLEUUID(C_DATA));
    if (!sel || !data) break;
    std::string text;
    std::vector<mesh::ListItem> items;
    if (!readAll(sel, data, "LIST 0", 64 * 1024, text) || !mesh::parseList(text, items)) break;
    std::stable_sort(items.begin(), items.end(), [](const mesh::ListItem& a, const mesh::ListItem& b) { return a.severity > b.severity; });
    int pulled = 0;
    for (const mesh::ListItem& li : items) {
      if (pulled >= 4 || !client->isConnected()) break;  // keep visits short: the radio is shared with Wi-Fi
      if (li.size == 0 || li.size > (1u << 20) || !outbox::wantsCarry(li)) continue;
      std::string json;
      if (!readAll(sel, data, li.bundleId + " 0", li.size + 16, json) || json.size() != li.size) continue;
      std::string why;
      mesh::Admit a = outbox::offerCarry(json, li.hops + 1, why);
      Serial.printf("[pearl] mesh: %s from %s: %s\n", li.bundleId.substr(0, 10).c_str(), dev.getAddress().toString().c_str(), a == mesh::Admit::OK ? "carrying" : why.c_str());
      pulled++;
    }
    std::vector<mesh::Receipt> rs;
    if (readAll(sel, data, "RECEIPTS 0", 64 * 1024, text) && mesh::parseReceipts(text, rs))
      for (const auto& r : rs) outbox::unverifiedDone(r.bundleId);  // stop forwarding; verified on-chain later
    BLERemoteCharacteristic* pc = s->getCharacteristic(BLEUUID(C_PINGS));
    if (pc) {
      String v = pc->readValue();
      JsonDocument d;
      if (!deserializeJson(d, v.c_str()))
        for (JsonVariantConst p : d.as<JsonArrayConst>()) {
          std::string one;
          serializeJson(p, one);
          outbox::addPing(one);  // verified inside
        }
    }
    ok = true;
  } while (false);
  client->disconnect();
  return ok;
}

static void scanAndPull() {
  BLEScan* scan = BLEDevice::getScan();
  scan->setActiveScan(true);  // the scan response holds the counts
  scan->setInterval(100);
  scan->setWindow(30);
  BLEScanResults* res = scan->start(5, false);
  std::vector<BLEAdvertisedDevice> todo;
  uint32_t now = millis();
  for (int i = 0; res && i < res->getCount(); i++) {
    BLEAdvertisedDevice d = res->getDevice(i);
    if (!d.isAdvertisingService(BLEUUID(SVC)) || !d.haveManufacturerData()) continue;
    String m = d.getManufacturerData();
    if (m.length() < 5 || static_cast<uint8_t>(m[2]) != 1 || static_cast<uint8_t>(m[3]) == 0) continue;  // nothing to carry
    Peer& p = peers[d.getAddress().toString().c_str()];
    if ((p.lastVisit && now - p.lastVisit < 60000) || static_cast<int32_t>(p.backoffUntil - now) > 0) continue;
    todo.push_back(d);
  }
  scan->clearResults();
  for (BLEAdvertisedDevice& d : todo) {
    Peer& p = peers[d.getAddress().toString().c_str()];
    p.lastVisit = millis();
    if (pull(d)) p.fails = 0;
    else {
      p.fails = std::min(p.fails + 1, 6);
      p.backoffUntil = millis() + (30000u << p.fails);  // 1 min … 32 min
    }
  }
}

static void handleAck(const char* text) {
  JsonDocument d;
  if (deserializeJson(d, text)) return;
  std::string id = bundle::hex0x(d["bundleId"] | "");
  std::string state = d["state"] | "";
  if (!bundle::validId(id)) return;
  // a courier or peer says "done": unverified, so own bundles become "relayed" and carried ones stop being
  // forwarded; both are dropped only after the robot sees the anchor on-chain itself
  if (state == "done") outbox::unverifiedDone(id);
}

static void meshTask(void*) {
  uint32_t seen = 0, lastScan = millis(), lastExpire = 0;
  for (;;) {
    AckMsg m;
    while (xQueueReceive(ackQ, &m, 0) == pdTRUE) handleAck(m.text);
    if (outbox::version() != seen) {
      seen = outbox::version();
      advertise();
    }
    if (millis() - lastExpire > 60000) {
      lastExpire = millis();
      outbox::expire();
    }
#if PEARL_MESH
    if (millis() - lastScan > PEARL_MESH_PERIOD_MS) {
      scanAndPull();
      lastScan = millis();
    }
#endif
    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

void begin(const std::string& name) {
  devName = name;
  ackQ = xQueueCreate(4, sizeof(AckMsg));
  curMu = xSemaphoreCreateMutex();
  BLEDevice::init(String(name.c_str()));
  BLEDevice::setMTU(517);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService* s = server->createService(BLEUUID(SVC), 20);
  chInfo = s->createCharacteristic(C_INFO, BLECharacteristic::PROPERTY_READ);
  chInfo->setCallbacks(new InfoCb());
  chPing = s->createCharacteristic(C_PING, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chPing->setValue(String("{}"));
  chSelect = s->createCharacteristic(C_SELECT, BLECharacteristic::PROPERTY_WRITE);
  chSelect->setCallbacks(new SelectCb());
  chData = s->createCharacteristic(C_DATA, BLECharacteristic::PROPERTY_READ);
  chData->setCallbacks(new DataCb());
  chAck = s->createCharacteristic(C_ACK, BLECharacteristic::PROPERTY_WRITE);
  chAck->setCallbacks(new AckCb());
  chPings = s->createCharacteristic(C_PINGS, BLECharacteristic::PROPERTY_READ);
  chPings->setCallbacks(new PingsCb());
  s->start();
  advertise();
  up = true;
  // low priority, core 0 (the run task's core; loop() runs on core 1)
  xTaskCreatePinnedToCore(meshTask, "mesh", 16384, nullptr, 1, nullptr, 0);
  Serial.printf("[pearl] BLE advertising as %s (mesh %s)\n", name.c_str(), PEARL_MESH ? "on" : "off");
}

void setPing(const std::string& json) {
  outbox::addPing(json);
  if (!up) return;
  chPing->setValue(String(json.c_str()));
  chPing->notify();
}

bool started() { return up; }

}  // namespace ble
#endif
