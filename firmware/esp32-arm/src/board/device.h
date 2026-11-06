// env:device (F1–F7): the robot runs everything itself — 0G decisions, the hash-chained log, locking, its own key,
// 0G Storage, the 0G Chain anchor, Arkiv — and serves the dashboard on http://<board-ip>:8070.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include "pearl/eth.h"

namespace device {
void begin();
/** API side. */
bool requestStart(const std::string& color, const std::string& from, std::string& episodeIdOut, std::string& why);
void requestStop();
void requestResetClear();
void setCut0g(bool on);
bool cut0g();
const pearl::eth::Key& key();
const char* deviceId();
std::string modulesJson();
bool cameraConfigured();
bool cameraJpeg(pearl::Bytes& out, std::string& err);
}  // namespace device
