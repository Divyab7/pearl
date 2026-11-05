// Ring colours and buzzer patterns per state (build spec §7.4), non-blocking.
#pragma once
#include <Arduino.h>

namespace status {
void begin();
void tick(uint32_t nowMs);
void beepShort(uint32_t nowMs);
}  // namespace status
