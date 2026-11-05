#include "safety.h"
#include <Adafruit_MPU6050.h>
#include <VL53L0X.h>
#include <Wire.h>
#include "config.h"
#include "link.h"
#include "motion.h"
#include "state.h"

namespace safety {

static VL53L0X tof;
static Adafruit_MPU6050 mpu;
static int tofTimeouts = 0;
static uint32_t lastImuMs = 0;

static void tripTo(TripReason r) {
  dev.pendingId[0] = 0;
  dev.trip = r;
  dev.state = DevState::TRIPPED;
}

bool begin(const char** failed) {
  pinMode(PIN_TOF_XSHUT, OUTPUT);
  digitalWrite(PIN_TOF_XSHUT, HIGH);
  delay(5);  // setup() only: sensor power-up
  tof.setBus(&Wire);
  tof.setTimeout(30);
  if (!tof.init()) {
    *failed = "tof";
    return false;
  }
  tof.startContinuous(0);  // back-to-back ranging
  if (!mpu.begin(0x68, &Wire)) {
    *failed = "mpu";
    return false;
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);
  return true;
}

static void readSensors(uint32_t now) {
  // ToF: read only when a measurement is ready, so the loop never blocks (~33 ms per measurement otherwise)
  if (tof.readReg(VL53L0X::RESULT_INTERRUPT_STATUS) & 0x07) {
    uint16_t mm = tof.readRangeContinuousMillimeters();
    if (tof.timeoutOccurred() || mm == 65535) tofTimeouts++;
    else {
      tofTimeouts = 0;
      dev.tofMm = mm;
    }
  }
  if (now - lastImuMs >= 10) {  // 100 Hz
    lastImuMs = now;
    sensors_event_t a, g, t;
    if (mpu.getEvent(&a, &g, &t)) {
      float m = sqrtf(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y +
                      a.acceleration.z * a.acceleration.z);
      dev.accG = m / 9.80665f;
    }
  }
}

void tick(uint32_t now) {
  if (dev.state == DevState::BOOT) return;
  readSensors(now);

  if (tofTimeouts >= TOF_FAULT_COUNT && dev.state != DevState::TRIPPED) {
    motion::freeze();
    tripTo(TripReason::SENSOR);
    hostlink::eventStr("sensor_fault", "what", "tof");
    return;
  }

  // bump: freeze in place, even if already tripped by the watchdog
  if (fabsf(dev.accG - 1.0f) > BUMP_G && dev.trip != TripReason::BUMP) {
    motion::freeze();
    tripTo(TripReason::BUMP);
    hostlink::eventFloat("trip_bump", "accG", dev.accG);
    return;
  }

  // heartbeat watchdog: trip and ramp to SAFE (unless a collision already froze the arm)
  uint32_t hbAge = now - dev.lastHbMs;
  if (hbAge > HEARTBEAT_TIMEOUT_MS && dev.state != DevState::TRIPPED) {
    tripTo(TripReason::WATCHDOG);
    motion::setTargetSafe();
    hostlink::eventInt("trip_watchdog", "hbAgeMs", static_cast<long>(hbAge));
    return;
  }

  bool inZone = dev.tofMm > 0 && dev.tofMm < HAND_ZONE_MM;
  if (dev.state == DevState::MOVING || dev.state == DevState::WAITING) {
    if (inZone) {
      motion::freeze();
      dev.pendingId[0] = 0;
      dev.state = DevState::FROZEN_HAND;
      dev.clearSinceMs = 0;
      dev.handClear = false;
      hostlink::eventInt("hand_in_zone", "tofMm", dev.tofMm);
    }
  } else if (dev.state == DevState::FROZEN_HAND) {
    if (inZone) {
      if (dev.clearSinceMs != 0) hostlink::eventInt("hand_in_zone", "tofMm", dev.tofMm);
      dev.clearSinceMs = 0;
      dev.handClear = false;
    } else {
      if (dev.clearSinceMs == 0) dev.clearSinceMs = now;
      if (!dev.handClear && now - dev.clearSinceMs >= HAND_CLEAR_MS) {
        dev.handClear = true;
        hostlink::event("hand_clear");
      }
    }
  }
}

void checkResetButton(uint32_t now) {
  if (dev.state != DevState::TRIPPED || dev.resetArmedUntil == 0) return;
  if (now > dev.resetArmedUntil) {
    dev.resetArmedUntil = 0;
    return;
  }
  if (digitalRead(PIN_RESET_BTN) == LOW) {
    dev.resetArmedUntil = 0;
    dev.trip = TripReason::NONE;
    dev.lastHbMs = now;
    hostlink::event("reset_done");
    dev.pendingId[0] = 0;
    dev.state = DevState::SAFE;
    motion::setTargetSafe();
  }
}

}  // namespace safety
