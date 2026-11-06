#ifdef PEARL_DEVICE
// env:device (F7): the robot's HTTP API, the same routes as apps/backend/src/app.ts, so the dashboard server needs no
// change: DEVICE_URL=http://<board-ip>:8070. Plain HTTP on the local network; everything readable stays locked.
#include "api.h"
#include <Arduino.h>
#include <Network.h>
#include <NetworkServer.h>
#include "board/device.h"
#include "board/feed.h"
#include "board/locallink.h"
#include "board/outbox.h"
#include "board/state_feed.h"
#include "board/store.h"
#include "pearl/json.h"
#include "pearl/run.h"
#include "pearl/seal.h"
#include "config.h"
#include "state.h"

namespace api {

static NetworkServer* server;

struct Req {
  std::string method, path, query, body;
};

static bool readRequest(NetworkClient& c, Req& r) {
  c.setTimeout(3);
  String line = c.readStringUntil('\n');
  int sp1 = line.indexOf(' '), sp2 = line.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) return false;
  r.method = line.substring(0, sp1).c_str();
  std::string target = line.substring(sp1 + 1, sp2).c_str();
  size_t q = target.find('?');
  r.path = target.substr(0, q);
  if (q != std::string::npos) r.query = target.substr(q + 1);
  size_t len = 0;
  for (;;) {
    String h = c.readStringUntil('\n');
    h.trim();
    if (h.length() == 0) break;
    if (h.startsWith("Content-Length:") || h.startsWith("content-length:")) len = h.substring(15).toInt();
  }
  if (len > 16384) return false;
  r.body.resize(len);
  size_t got = 0;
  uint32_t until = millis() + 3000;
  while (got < len && static_cast<int32_t>(until - millis()) > 0) {
    int n = c.read(reinterpret_cast<uint8_t*>(&r.body[got]), len - got);
    if (n > 0) got += n;
    else delay(1);
  }
  r.body.resize(got);
  return true;
}

static void reply(NetworkClient& c, int code, const std::string& body, const char* type = "application/json") {
  const char* text = code == 200 ? "OK" : code == 202 ? "Accepted" : code == 400 ? "Bad Request" : code == 404 ? "Not Found" : code == 409 ? "Conflict" : code == 502 ? "Bad Gateway" : "Error";
  c.printf("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", code, text, type,
           static_cast<unsigned>(body.size()));
  c.write(reinterpret_cast<const uint8_t*>(body.data()), body.size());
}
static void replyBytes(NetworkClient& c, const pearl::Bytes& b, const char* type, const char* extraHeader = "") {
  c.printf("HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %u\r\nAccess-Control-Allow-Origin: *\r\n%sConnection: close\r\n\r\n", type, static_cast<unsigned>(b.size()), extraHeader);
  c.write(b.data(), b.size());
}
static void error(NetworkClient& c, int code, const std::string& msg) {
  JsonDocument d;
  d["error"] = msg;
  std::string s;
  serializeJson(d, s);
  reply(c, code, s);
}

static std::string stateJson() {
  JsonDocument d;
  d["deviceId"] = device::deviceId();
  d["deviceAddress"] = device::key().address;
  char tel[MAX_LINE_BYTES + 1];
  if (locallink::lastTelemetry(tel, sizeof tel)) {
    JsonDocument t;
    deserializeJson(t, tel);
    d["device"] = t;
  } else {
    d["device"] = nullptr;
  }
  d["deviceKind"] = "esp32";
  d["status"] = nullptr;
  d["handClear"] = dev.handClear;
  d["hardTrip"] = dev.state == DevState::TRIPPED;
  JsonDocument o;
  deserializeJson(o, statefeed::json());
  d["orchestrator"] = o;
  d["scene"] = nullptr;
  d["cameraKind"] = device::cameraConfigured() ? "http" : "none";
  d["cut0g"] = device::cut0g();
  d["heartbeatPaused"] = false;
  JsonDocument m;
  deserializeJson(m, device::modulesJson());
  d["modules"] = m;
  std::string s;
  serializeJson(d, s);
  return s;
}

static std::string episodesJson() {
  JsonDocument d;
  d["source"] = "device";
  JsonArray items = d["items"].to<JsonArray>();
  for (const std::string& id : store::runIds()) {
    std::string sealed;
    JsonDocument s;
    if (!store::readFile("/runs/" + id + ".sealed.json", sealed) || deserializeJson(s, sealed)) continue;
    JsonObject it = items.add<JsonObject>();
    it["episodeId"] = id;
    it["locked"] = true;
    it["armId"] = s["armId"];
    it["kind"] = (s["incident"] | false) ? "incident" : "episode";
    it["outcome"] = s["outcome"];
    it["severity"] = s["severity"];
    it["headHash"] = s["headHash"];
    it["device"] = s["device"]["address"];
    it["ts"] = pearl::isoToEpochMs(s["endedAt"] | "");
  }
  std::string out;
  serializeJson(d, out);
  return out;
}

static bool hex32(const char* s) {
  if (!s || strlen(s) != 32) return false;
  for (const char* p = s; *p; p++)
    if (!isxdigit(static_cast<unsigned char>(*p)) || isupper(static_cast<unsigned char>(*p))) return false;
  return true;
}

static void handle(NetworkClient& c, Req& r) {
  const std::string& p = r.path;
  if (r.method == "OPTIONS") {
    c.print("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: GET, POST\r\nConnection: close\r\n\r\n");
    return;
  }
  if (r.method == "GET" && p == "/api/state") return reply(c, 200, stateJson());
  if (r.method == "POST" && p == "/api/episode/start") {
    JsonDocument b;
    deserializeJson(b, r.body);
    std::string color = b["color"] | "", from = b["from"] | "";
    if (color.empty() || color.size() > 16 || (from != "A1" && from != "A2" && from != "A3")) return error(c, 400, "body must be {color, from: A1|A2|A3}");
    std::string id, why;
    if (!device::requestStart(color, from, id, why)) return error(c, 409, why);
    return reply(c, 202, "{\"episodeId\":\"" + id + "\"}");
  }
  if (r.method == "POST" && p.rfind("/api/control/", 0) == 0) {
    std::string what = p.substr(13);
    JsonDocument cmd;
    if (what == "stop") device::requestStop();
    else if (what == "safe") {
      cmd["cmd"] = "safe";
      locallink::toArm(cmd);
    } else if (what == "reset") {
      cmd["cmd"] = "reset";
      locallink::toArm(cmd);
      device::requestResetClear();
      return reply(c, 200, "{\"ok\":true,\"note\":\"press the BOOT button on the arm within 10 s\"}");
    } else if (what == "cut0g") {
      JsonDocument b;
      if (deserializeJson(b, r.body) || !b["on"].is<bool>()) return error(c, 400, "body must be {on: true|false}");
      device::setCut0g(b["on"]);
      feed::send("cut0g", std::string("{\"on\":") + (b["on"].as<bool>() ? "true" : "false") + "}");
      return reply(c, 200, std::string("{\"ok\":true,\"cut0g\":") + (b["on"].as<bool>() ? "true" : "false") + "}");
    } else return error(c, 404, "unknown control");
    return reply(c, 200, "{\"ok\":true}");
  }
  if (p.rfind("/api/sim/", 0) == 0) return error(c, 404, "fault injection exists only in the simulator");
  if (r.method == "GET" && p == "/api/zerobot") return reply(c, 200, "{\"status\":\"off\",\"missing\":\"zerobot runs from the laptop program\"}");
  if (r.method == "GET" && p == "/api/camera/live.jpg") {
    if (!device::cameraConfigured()) return error(c, 404, "no camera (CAMERA_URL is empty)");
    pearl::Bytes jpg;
    std::string err;
    if (!device::cameraJpeg(jpg, err)) return error(c, 502, err);
    return replyBytes(c, jpg, "image/jpeg", "Cache-Control: no-store\r\n");
  }
  if (r.method == "POST" && p == "/api/link") {
    JsonDocument b;
    deserializeJson(b, r.body);
    const char* acc = b["accountId"] | "";
    const char* nonce = b["nonce"] | "";
    if (!hex32(acc) || !hex32(nonce)) return error(c, 400, "body must be {accountId: 32 hex, nonce: 32 hex, ownerKey: P-256 public JWK}");
    JsonObjectConst k = b["ownerKey"];
    if (std::string(k["kty"] | "") != "EC" || std::string(k["crv"] | "") != "P-256" || !k["x"].is<const char*>() || !k["y"].is<const char*>())
      return error(c, 400, "ownerKey must be the owner's P-256 public key (JWK)");
    pearl::seal::PublicJwk jwk{k["x"].as<const char*>(), k["y"].as<const char*>()};
    std::string kid = pearl::seal::keyId(jwk);
    std::string sig = pearl::eth::personalSign(device::key(), pearl::run::linkMessage(acc, nonce, kid));
    JsonDocument owner;
    owner["accountId"] = acc;
    owner["x"] = jwk.x;
    owner["y"] = jwk.y;
    owner["kid"] = kid;
    std::string os;
    serializeJson(owner, os);
    store::saveOwner(os);
    JsonDocument out;
    out["address"] = device::key().address;
    out["deviceId"] = device::deviceId();
    out["ownerKid"] = kid;
    out["signature"] = sig;
    std::string s;
    serializeJson(out, s);
    return reply(c, 200, s);
  }
  if (r.method == "GET" && p == "/api/episodes") return reply(c, 200, episodesJson());
  if (r.method == "GET" && p == "/api/outbox") return reply(c, 200, outbox::statusJson());  // offline relay + mesh state
  if (r.method == "GET" && p.rfind("/api/episodes/", 0) == 0) {
    std::string rest = p.substr(14);
    std::string id = rest.substr(0, rest.find('/'));
    std::string sub = rest.size() > id.size() ? rest.substr(id.size()) : "";
    if (!store::validRunId(id)) return error(c, 404, "not found");
    std::string body;
    if (sub.empty()) {
      if (!store::readFile("/runs/" + id + ".sealed.json", body)) return error(c, 404, "no locked copy of this run on the robot");
      return reply(c, 200, body);
    }
    if (sub == "/meta") {
      if (!store::readFile("/runs/" + id + ".meta.json", body)) body = "{\"episodeId\":\"" + id + "\"}";
      return reply(c, 200, body);
    }
    if (sub == "/key") {
      std::string ownerJson;
      if (!store::loadOwner(ownerJson)) return error(c, 409, "no owner linked yet: link the robot to your account first");
      JsonDocument o;
      deserializeJson(o, ownerJson);
      pearl::Bytes runKey;
      if (!store::loadRunKey(id, runKey)) return error(c, 404, "the robot has no key for this run");
      JsonDocument w;
      pearl::seal::PublicJwk jwk{o["x"] | "", o["y"] | ""};
      if (!pearl::seal::wrapRunKey(runKey, jwk, pearl::seal::runContext(device::key().address, id), w.to<JsonObject>())) return error(c, 500, "wrap failed");
      std::string s;
      serializeJson(w, s);
      return reply(c, 200, s);
    }
    return error(c, 404, "not found");
  }
  if (r.method == "GET" && p.rfind("/api/frames/", 0) == 0) {
    std::string rest = p.substr(12);
    size_t slash = rest.find('/');
    std::string id = rest.substr(0, slash);
    std::string idx = slash == std::string::npos ? "" : rest.substr(slash + 1);
    if (!store::validRunId(id) || idx.empty() || idx.find_first_not_of("0123456789") != std::string::npos) return error(c, 404, "frame not available");
    pearl::Bytes b;
    if (!store::readBytes("/runs/" + id + "/f" + idx + ".lock", b)) return error(c, 404, "frame not available");
    return replyBytes(c, b, "application/octet-stream", "X-Frame-Source: robot\r\n");
  }
  error(c, 404, "not found");
}

static void serve(void*) {
  for (;;) {
    NetworkClient c = server->accept();
    if (!c) {
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    Req r;
    if (!readRequest(c, r)) {
      c.stop();
      continue;
    }
    if (r.method == "GET" && r.path == "/api/stream") {
      feed::addClient(c);  // kept open; the feed writes to it
      continue;
    }
    handle(c, r);
    c.flush();
    c.stop();
  }
}

void begin(uint16_t port) {
  server = new NetworkServer(port);
  server->begin();
  xTaskCreatePinnedToCore(serve, "api", 16384, nullptr, 1, nullptr, 0);
}

}  // namespace api
#endif
