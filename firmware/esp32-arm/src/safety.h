// Local safety loop: hand zone, bump, heartbeat watchdog, sensor faults. Runs every loop, before motion,
// and never waits for the laptop (build spec §7.3–§7.4).
#pragma once
#include <Arduino.h>

namespace safety {
bool begin(const char** failed);   // sensors; on failure *failed names the part
void tick(uint32_t nowMs);
void checkResetButton(uint32_t nowMs);
}  // namespace safety
