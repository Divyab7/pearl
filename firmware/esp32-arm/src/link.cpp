#include "link.h"
#include <Arduino.h>
#include "config.h"

#ifdef LINK_WS
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "secrets.h"
static WebSocketsClient ws;
#endif

namespace hostlink {

static char buf[MAX_LINE_BYTES + 1];
static size_t len = 0;
static bool overflow = false;

static void dispatch(const char* line, size_t n) {
  JsonDocument doc;  // ArduinoJson 7
  DeserializationError err = deserializeJson(doc, line, n);
  if (err) {
    nack(nullptr, "parse");
    return;
  }
  commands::handle(doc);
}

#ifdef LINK_WS
static void onWs(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_TEXT) dispatch(reinterpret_cast<const char*>(payload), length);
}
#endif

void begin() {
  Serial.begin(115200);
#ifdef LINK_WS
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  ws.begin(WS_HOST, WS_PORT, "/");
  ws.onEvent(onWs);
  ws.setReconnectInterval(1000);
#endif
}

void poll() {
#ifdef LINK_WS
  ws.loop();
#endif
  // non-blocking: only bytes already received
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      if (overflow) nack(nullptr, "parse");
      else if (len > 0) dispatch(buf, len);
      len = 0;
      overflow = false;
    } else if (c != '\r') {
      if (len < MAX_LINE_BYTES) buf[len++] = c;
      else overflow = true;
    }
  }
}

void send(const JsonDocument& doc) {
  char out[MAX_LINE_BYTES + 2];
  size_t n = serializeJson(doc, out, MAX_LINE_BYTES);
  out[n] = '\0';
#ifdef LINK_WS
  ws.sendTXT(out, n);
#endif
  out[n] = '\n';
  Serial.write(reinterpret_cast<const uint8_t*>(out), n + 1);
}

void nack(const char* id, const char* reason) {
  JsonDocument d;
  d["t"] = "nack";
  if (id && id[0]) d["id"] = id;
  d["reason"] = reason;
  send(d);
}

void event(const char* ev) {
  JsonDocument d;
  d["t"] = "event";
  d["ev"] = ev;
  send(d);
}
void eventInt(const char* ev, const char* key, long v) {
  JsonDocument d;
  d["t"] = "event";
  d["ev"] = ev;
  d[key] = v;
  send(d);
}
void eventFloat(const char* ev, const char* key, float v) {
  JsonDocument d;
  d["t"] = "event";
  d["ev"] = ev;
  d[key] = v;
  send(d);
}
void eventStr(const char* ev, const char* key, const char* v) {
  JsonDocument d;
  d["t"] = "event";
  d["ev"] = ev;
  d[key] = v;
  send(d);
}

}  // namespace hostlink
