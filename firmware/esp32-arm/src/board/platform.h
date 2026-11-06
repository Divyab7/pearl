// env:device — the orchestrator's and publisher's view of the board (F1): HTTPS with certificate checks (the core's
// built-in Mozilla bundle), NTP time, the phone camera over HTTP, LittleFS for locked frames, the live feed.
#pragma once
#include <string>
#include "pearl/orch.h"

class Esp32Platform : public pearl::orch::Platform {
 public:
  std::string cameraUrl;
  uint32_t millis() override;
  void sleep(uint32_t ms) override;
  std::string nowIso() override;
  pearl::run::HttpResult post(const std::string& url, const pearl::orch::Headers& headers, const std::string& body, uint32_t timeoutMs) override;
  bool camera(pearl::Bytes& jpeg, std::string& err) override;
  void saveFrame(const std::string& episodeId, size_t idx, const pearl::Bytes& locked) override;
  void onRecord(const std::string& recordJson) override;
  void onPhase(const std::string& phase, const std::string& episodeId) override;
  bool get(const std::string& url, pearl::Bytes& out, std::string& err, uint32_t timeoutMs = 8000);
};

/** true once NTP has set the clock (runs need real timestamps). */
bool clockReady();
