#ifdef PEARL_DEVICE
#include "relay.h"
#include <Arduino.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include "secrets.h"

#ifndef PEARL_RELAY_URL
#define PEARL_RELAY_URL ""  // e.g. "http://192.168.43.10:8080/api/relay" when mDNS is blocked on the hotspot
#endif

namespace relay {

static bool mdnsUp = false;
static std::string cached;
static uint32_t cachedAt = 0;
static std::string host;

void begin(const std::string& hostname) {
  host = hostname;
  mdnsUp = MDNS.begin(hostname.c_str());
}

void forget() { cached.clear(); }

std::string find() {
  if (!cached.empty() && millis() - cachedAt < 300000) return cached;
  cached.clear();
  if (WiFi.status() == WL_CONNECTED) {
    if (!mdnsUp) mdnsUp = MDNS.begin(host.c_str());
    int n = mdnsUp ? MDNS.queryService("pearl-relay", "tcp") : 0;  // blocks ~3 s (run task only)
    for (int i = 0; i < n && cached.empty(); i++) {
      IPAddress ip = MDNS.address(i);
      if (ip == IPAddress(0, 0, 0, 0)) continue;
      String path = MDNS.hasTxt(i, "path") ? MDNS.txt(i, "path") : String("/api/relay");
      cached = "http://" + std::string(ip.toString().c_str()) + ":" + std::to_string(MDNS.port(i)) + path.c_str();
    }
  }
  if (cached.empty() && strlen(PEARL_RELAY_URL)) cached = PEARL_RELAY_URL;
  if (!cached.empty()) cachedAt = millis();
  return cached;
}

bool post(Esp32Platform& p, const std::string& base, const std::string& json, std::string& err) {
  pearl::run::HttpResult r = p.post(base + "/bundle", {{"Content-Type", "application/json"}}, json, 30000);
  if (r.status == 200 || r.status == 202) return true;
  err = r.status ? "HTTP " + std::to_string(r.status) + " " + r.body.substr(0, 160) : r.error;
  return false;
}

bool status(Esp32Platform& p, const std::string& base, const std::string& id, JsonDocument& out, std::string& err) {
  pearl::Bytes body;
  if (!p.get(base + "/bundles/" + id, body, err, 8000)) return false;
  if (deserializeJson(out, reinterpret_cast<const char*>(body.data()), body.size())) {
    err = "relay: not JSON";
    return false;
  }
  return true;
}

}  // namespace relay
#endif
