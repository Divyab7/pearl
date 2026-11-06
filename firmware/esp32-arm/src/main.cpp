// Pearl arm firmware (build spec §7). Non-blocking loop: link → safety → motion → status → telemetry.
// The laptop can only request motion; the safety loop here never waits for it.
#include <Arduino.h>
#include <Wire.h>
#include "config.h"
#include "link.h"
#include "motion.h"
#include "safety.h"
#include "state.h"
#include "status.h"
#ifdef PEARL_DEVICE
#include "board/device.h"
#endif

Device dev;

const char* stateName(DevState s) {
  switch (s) {
    case DevState::BOOT: return "BOOT";
    case DevState::IDLE: return "IDLE";
    case DevState::MOVING: return "MOVING";
    case DevState::WAITING: return "WAITING";
    case DevState::FROZEN_HAND: return "FROZEN_HAND";
    case DevState::TRIPPED: return "TRIPPED";
    case DevState::SAFE: return "SAFE";
  }
  return "BOOT";
}

static void joints(JsonArray a, const float* v) {
  for (int i = 0; i < 4; i++) a.add(static_cast<int>(lroundf(v[i])));
}

static void hello() {
  JsonDocument d;
  d["t"] = "hello";
  d["fw"] = FW_VERSION;
  d["deviceId"] = DEVICE_ID;
  joints(d["joints"].to<JsonArray>(), dev.pos);
  hostlink::send(d);
}

// start-up trace on the USB serial (one plain line per step, ignored by the host's JSON reader): shows where a board
// that never says hello got stuck (a missing I2C chip, a held bus, power)
#define BOOT_STEP(s) do { Serial.println("[boot] " s); Serial.flush(); } while (0)

void setup() {
  hostlink::begin();
  delay(1500);  // let the USB serial come up so the first lines aren't lost
  BOOT_STEP("serial up");
  status::begin();
  BOOT_STEP("status ok (ring, buzzer)");
  Wire.begin(PIN_SDA, PIN_SCL, 400000);
  Wire.setTimeOut(50);
  BOOT_STEP("i2c bus up");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf("[boot] i2c device at 0x%02x\n", a);
  }
  BOOT_STEP("i2c scan done");
  {  // which motion chip answers at 0x68: WHO_AM_I (0x75) is 0x68 on a real MPU6050, other values on clones/siblings
    Wire.beginTransmission(0x68);
    Wire.write(0x75);
    Wire.endTransmission(false);
    if (Wire.requestFrom(0x68, 1) == 1) Serial.printf("[boot] imu WHO_AM_I = 0x%02x\n", Wire.read());
  }
  const char* failed = nullptr;
  bool ok = motion::begin();
  BOOT_STEP("servo driver begin returned");
  if (!ok) failed = "pca";
  if (ok) ok = safety::begin(&failed);
  BOOT_STEP("sensors begin returned");
  status::beepShort(millis());
#ifdef PEARL_DEVICE
  device::begin();  // Wi-Fi, keys, run task, API (the safety loop below keeps running regardless)
#endif
  hello();
  dev.lastHbMs = millis();
  if (ok) dev.state = DevState::IDLE;
  else {
    dev.trip = TripReason::SENSOR;
    dev.state = DevState::TRIPPED;
    hostlink::eventStr("sensor_fault", "what", failed ? failed : "unknown");
  }
}

static uint32_t lastTick = 0;
static uint32_t lastTel = 0;

void loop() {
  uint32_t now = millis();
  uint32_t dt = now - lastTick;
  lastTick = now;

  hostlink::poll();
  safety::tick(now);
  safety::checkResetButton(now);
  motion::tick(dt);
  if (dev.state == DevState::MOVING && motion::atTarget()) {
    dev.state = DevState::IDLE;
    if (dev.pendingId[0]) {
      JsonDocument d;
      d["t"] = "done";
      d["id"] = dev.pendingId;
      dev.pendingId[0] = 0;
      hostlink::send(d);
    }
  }
  status::tick(now);

  if (now - lastTel >= 1000 / TELEMETRY_HZ) {
    lastTel = now;
    JsonDocument d;
    d["t"] = "tel";
    d["ms"] = now;
    d["state"] = stateName(dev.state);
    joints(d["joints"].to<JsonArray>(), dev.pos);
    joints(d["target"].to<JsonArray>(), dev.target);
    d["tofMm"] = dev.tofMm;
    d["accG"] = dev.accG;
    d["hbAgeMs"] = now - dev.lastHbMs;
    hostlink::send(d);
  }
}
