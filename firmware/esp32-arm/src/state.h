// Shared device state (build spec §7.4). One instance, owned by main.cpp.
#pragma once
#include <Arduino.h>

enum class DevState : uint8_t { BOOT, IDLE, MOVING, WAITING, FROZEN_HAND, TRIPPED, SAFE };
enum class TripReason : uint8_t { NONE, BUMP, WATCHDOG, SENSOR };

const char* stateName(DevState s);

struct Device {
  DevState state = DevState::BOOT;
  TripReason trip = TripReason::NONE;
  float pos[4];
  float target[4];
  char pendingId[33] = {0};    // move/grip id waiting for "done"
  uint32_t lastHbMs = 0;
  int tofMm = 8190;
  float accG = 1.0f;
  bool handClear = false;
  uint32_t clearSinceMs = 0;   // 0 = not clear
  uint32_t resetArmedUntil = 0;
};

extern Device dev;
