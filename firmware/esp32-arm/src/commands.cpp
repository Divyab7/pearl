// Host → device commands (build spec §7.5). The device refuses anything its state does not allow.
#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include "config.h"
#include "link.h"
#include "motion.h"
#include "state.h"

namespace commands {

static bool readJoints(JsonVariantConst v, int out[4]) {
  JsonArrayConst a = v.as<JsonArrayConst>();
  if (a.isNull() || a.size() != 4) return false;
  for (int i = 0; i < 4; i++) {
    if (!a[i].is<int>()) return false;
    int d = a[i].as<int>();
    if (d < 0 || d > 180) return false;
    out[i] = d;
  }
  return true;
}

static void ack(const char* id) {
  JsonDocument d;
  d["t"] = "ack";
  d["id"] = id;
  hostlink::send(d);
}

static void startMove(const char* id, const int j[4]) {
  if (dev.state == DevState::MOVING) return hostlink::nack(id, "busy");
  if (dev.state != DevState::IDLE && dev.state != DevState::WAITING) return hostlink::nack(id, "state");
  if (!motion::withinLimits(j)) return hostlink::nack(id, "limit");
  motion::setTarget(j);
  strncpy(dev.pendingId, id, sizeof(dev.pendingId) - 1);
  dev.pendingId[sizeof(dev.pendingId) - 1] = 0;
  dev.state = DevState::MOVING;
  ack(id);
}

static void enterSafe() {
  dev.pendingId[0] = 0;
  dev.state = DevState::SAFE;
  motion::setTargetSafe();
}

void handle(JsonDocument& doc) {
  const char* cmd = doc["cmd"] | "";
  const char* id = doc["id"] | "";
  uint32_t now = millis();

  if (!strcmp(cmd, "hb")) {
    dev.lastHbMs = now;
  } else if (!strcmp(cmd, "move")) {
    int j[4];
    if (!id[0] || strlen(id) > 32 || !readJoints(doc["joints"], j)) return hostlink::nack(id, "parse");
    startMove(id, j);
  } else if (!strcmp(cmd, "grip")) {
    if (!id[0] || strlen(id) > 32 || !doc["close"].is<bool>()) return hostlink::nack(id, "parse");
    int j[4] = {static_cast<int>(lroundf(dev.pos[0])), static_cast<int>(lroundf(dev.pos[1])),
                static_cast<int>(lroundf(dev.pos[2])), doc["close"].as<bool>() ? GRIP_CLOSED_DEG : GRIP_OPEN_DEG};
    startMove(id, j);
  } else if (!strcmp(cmd, "hold")) {
    if (dev.state == DevState::IDLE || dev.state == DevState::MOVING) {
      motion::freeze();
      dev.pendingId[0] = 0;
      dev.state = DevState::WAITING;
    } else if (dev.state != DevState::WAITING) {
      hostlink::nack(nullptr, "state");
    }
  } else if (!strcmp(cmd, "resume")) {
    switch (dev.state) {
      case DevState::FROZEN_HAND:
        if (!dev.handClear) return hostlink::nack(nullptr, "state");
        dev.state = DevState::IDLE;
        break;
      case DevState::WAITING: dev.state = DevState::IDLE; break;
      case DevState::SAFE:
        if (!motion::atTarget()) return hostlink::nack(nullptr, "busy");
        dev.state = DevState::IDLE;
        break;
      default: hostlink::nack(nullptr, "state");
    }
  } else if (!strcmp(cmd, "safe")) {
    if (dev.state == DevState::TRIPPED) return hostlink::nack(nullptr, "state");
    enterSafe();
  } else if (!strcmp(cmd, "reset")) {
    if (dev.state != DevState::TRIPPED) return hostlink::nack(nullptr, "state");
    dev.resetArmedUntil = now + RESET_WINDOW_MS;  // the operator must press BOOT within the window
    hostlink::event("reset_armed");
  } else if (!strcmp(cmd, "cal")) {
    if (dev.state != DevState::IDLE) return hostlink::nack(nullptr, "state");
    int ch = doc["ch"] | -1;
    int us = doc["us"] | -1;
    if (ch < 0 || ch > 15 || us < 500 || us > 2500) return hostlink::nack(nullptr, "parse");
    motion::writeRawUs(static_cast<uint8_t>(ch), static_cast<uint16_t>(us));
  } else if (!strcmp(cmd, "i2c_scan")) {
    JsonDocument d;
    d["t"] = "i2c";
    JsonArray a = d["addrs"].to<JsonArray>();
    for (uint8_t addr = 1; addr < 127; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission() == 0) {
        char s[5];
        snprintf(s, sizeof(s), "0x%02x", addr);
        a.add(s);
      }
    }
    hostlink::send(d);
  } else {
    hostlink::nack(id, "parse");
  }
}

}  // namespace commands
