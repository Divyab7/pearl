// env:device — the laptop relay on the local network (spec v1 §3): found with mDNS (_pearl-relay._tcp, TXT path),
// or PEARL_RELAY_URL from secrets.h. POST the sealed bundle, then poll its state until done.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include "board/platform.h"

namespace relay {
void begin(const std::string& hostname);
/** "http://<ip>:<port>/api/relay" or "" (cached for 5 min). */
std::string find();
void forget();
/** POST <base>/bundle; true on 200/202 (idempotent by bundleId). */
bool post(Esp32Platform& p, const std::string& base, const std::string& json, std::string& err);
/** GET <base>/bundles/<id> → {state, steps[]}; false (+ err "404") if the relay does not know it. */
bool status(Esp32Platform& p, const std::string& base, const std::string& id, JsonDocument& out, std::string& err);
}  // namespace relay
