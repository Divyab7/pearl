#ifdef PEARL_DEVICE
#include "platform.h"
#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <esp_random.h>
#include <sys/time.h>
#include "board/feed.h"
#include "board/state_feed.h"
#include "board/store.h"

namespace pearl {
void randomFill(uint8_t* out, size_t n) { esp_fill_random(out, n); }
}  // namespace pearl

bool clockReady() {
  time_t now = time(nullptr);
  return now > 1700000000;  // after Nov 2023: NTP has answered
}

uint32_t Esp32Platform::millis() { return ::millis(); }
void Esp32Platform::sleep(uint32_t ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }

std::string Esp32Platform::nowIso() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm g;
  gmtime_r(&tv.tv_sec, &g);
  char b[32];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", g.tm_year + 1900, g.tm_mon + 1, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec,
           static_cast<int>(tv.tv_usec / 1000));
  return b;
}

static const char* WANT_HEADERS[] = {"x-request-id", "x-client-request-id", "zg-res-key"};

pearl::run::HttpResult Esp32Platform::post(const std::string& url, const pearl::orch::Headers& headers, const std::string& body, uint32_t timeoutMs) {
  pearl::run::HttpResult r;
  uint32_t t0 = ::millis();
  bool tls = url.rfind("https://", 0) == 0;
  NetworkClientSecure secure;
  NetworkClient plain;
  if (tls) secure.useBuiltinCACertBundle();  // verified TLS 1.2; no setInsecure anywhere
  HTTPClient http;
  http.setConnectTimeout(timeoutMs < 10000 ? timeoutMs : 10000);
  http.setTimeout(timeoutMs);
  http.setReuse(false);
  if (!(tls ? http.begin(secure, url.c_str()) : http.begin(plain, url.c_str()))) {
    r.error = "network error: bad URL";
    return r;
  }
  for (const auto& h : headers) http.addHeader(h.first.c_str(), h.second.c_str());
  http.collectHeaders(WANT_HEADERS, 3);
  int code = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(body.data())), body.size());
  r.latencyMs = ::millis() - t0;
  if (code <= 0) {
    std::string e = HTTPClient::errorToString(code).c_str();
    r.error = (code == HTTPC_ERROR_READ_TIMEOUT || r.latencyMs >= timeoutMs) ? "timeout after " + std::to_string(timeoutMs) + " ms" : "network error: " + e;
    http.end();
    return r;
  }
  r.status = code;
  r.body = http.getString().c_str();
  if (http.hasHeader("x-request-id")) r.xRequestId = http.header("x-request-id").c_str();
  if (http.hasHeader("x-client-request-id")) {
    r.xClientRequestId = http.header("x-client-request-id").c_str();
    r.hasXClientRequestId = true;
  }
  if (http.hasHeader("zg-res-key")) {
    r.zgResKey = http.header("zg-res-key").c_str();
    r.hasZgResKey = true;
  }
  r.latencyMs = ::millis() - t0;
  http.end();
  return r;
}

bool Esp32Platform::get(const std::string& url, pearl::Bytes& out, std::string& err, uint32_t timeoutMs) {
  bool tls = url.rfind("https://", 0) == 0;
  NetworkClientSecure secure;
  NetworkClient plain;
  if (tls) secure.useBuiltinCACertBundle();
  HTTPClient http;
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  if (!(tls ? http.begin(secure, url.c_str()) : http.begin(plain, url.c_str()))) {
    err = "bad URL";
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    err = code <= 0 ? std::string(HTTPClient::errorToString(code).c_str()) : "HTTP " + std::to_string(code);
    http.end();
    return false;
  }
  int len = http.getSize();
  NetworkClient* s = http.getStreamPtr();
  out.clear();
  if (len > 0) out.reserve(len);
  uint8_t buf[1024];
  uint32_t until = ::millis() + timeoutMs;
  while (http.connected() && (len < 0 || static_cast<int>(out.size()) < len) && static_cast<int32_t>(until - ::millis()) > 0) {
    size_t avail = s->available();
    if (!avail) {
      delay(2);
      continue;
    }
    int n = s->readBytes(buf, avail > sizeof buf ? sizeof buf : avail);
    out.insert(out.end(), buf, buf + n);
    if (out.size() > 400 * 1024) break;  // a JPEG snapshot, not a stream
  }
  http.end();
  if (out.empty()) err = "empty response";
  return !out.empty();
}

bool Esp32Platform::camera(pearl::Bytes& jpeg, std::string& err) {
  if (cameraUrl.empty()) return false;
  if (!get(cameraUrl, jpeg, err)) return false;
  if (jpeg.size() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8) {
    err = "not a JPEG";
    return false;
  }
  return true;
}

void Esp32Platform::saveFrame(const std::string& episodeId, size_t idx, const pearl::Bytes& locked) {
  store::writeBytes("/runs/" + episodeId + "/f" + std::to_string(idx) + ".lock", locked);
}

void Esp32Platform::onRecord(const std::string& recordJson) { feed::send("record", recordJson); }

void Esp32Platform::onPhase(const std::string& phase, const std::string& episodeId) { statefeed::phase(phase, episodeId); }
#endif
