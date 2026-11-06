#include "safety.h"
#include <VL53L0X.h>
#include <Wire.h>
#include "config.h"
#include "link.h"
#include "motion.h"
#include "state.h"

namespace safety {

static VL53L0X tof;
// Motion sensor: a small direct driver instead of the Adafruit MPU6050 library, which rejects anything whose
// WHO_AM_I isn't 0x68 — the real board carries an MPU6500 (0x70). The accelerometer registers are the same across the
// family (MPU6050 0x68, MPU6500 0x70, MPU9250 0x71, MPU9255 0x73, common clones 0x98/0x72), and acceleration is all
// the safety loop needs (bump detection).
namespace imu {
constexpr uint8_t ADDR = 0x68;
static bool wr(uint8_t reg, uint8_t v) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}
static int rd(uint8_t reg, uint8_t* out, uint8_t n) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return 0;
  int got = Wire.requestFrom(ADDR, n);
  for (int i = 0; i < got; i++) out[i] = Wire.read();
  return got;
}
static uint8_t whoAmI = 0;
static bool begin() {
  uint8_t w = 0;
  if (rd(0x75, &w, 1) != 1) return false;
  whoAmI = w;
  if (w != 0x68 && w != 0x70 && w != 0x71 && w != 0x73 && w != 0x98 && w != 0x72) return false;
  if (!wr(0x6B, 0x00)) return false;  // PWR_MGMT_1: wake up, internal clock
  delay(10);                           // setup() only
  wr(0x1C, 0x08);                      // ACCEL_CONFIG: ±4 g (8192 LSB/g)
  wr(0x1A, 0x04);                      // CONFIG: low-pass ~20 Hz
  return true;
}
/** Acceleration magnitude in g; false when the read failed. */
static bool readG(float& g) {
  uint8_t b[6];
  if (rd(0x3B, b, 6) != 6) return false;
  float x = int16_t(b[0] << 8 | b[1]) / 8192.0f, y = int16_t(b[2] << 8 | b[3]) / 8192.0f, z = int16_t(b[4] << 8 | b[5]) / 8192.0f;
  g = sqrtf(x * x + y * y + z * z);
  return true;
}
}  // namespace imu
static int tofTimeouts = 0;
static uint32_t lastImuMs = 0;
// a sensor that failed to start is never read (reading an absent MPU6050 crashed the board): the device stays in a
// safe sensor-fault state instead, and the I2C scan still works so the wiring can be checked
static bool tofOk = false, mpuOk = false;

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
  pinMode(PIN_RESET_BTN, INPUT_PULLUP);
  // the VL53L0X can come up stuck after a brown-out or reboot loop: pulse XSHUT (if wired) and retry a few times
  for (int i = 0; i < 4 && !tofOk; i++) {
    if (i) {
      digitalWrite(PIN_TOF_XSHUT, LOW);
      delay(10);  // setup() only
      digitalWrite(PIN_TOF_XSHUT, HIGH);
      delay(20);
    }
    tofOk = tof.init();
  }
  if (tofOk) tof.startContinuous(0);  // back-to-back ranging
  mpuOk = imu::begin();
  if (!tofOk) *failed = mpuOk ? "tof" : "tof+mpu";
  else if (!mpuOk) *failed = "mpu";
  return tofOk && mpuOk;
}

static void readSensors(uint32_t now) {
  // ToF: read only when a measurement is ready, so the loop never blocks (~33 ms per measurement otherwise)
  if (tofOk && (tof.readReg(VL53L0X::RESULT_INTERRUPT_STATUS) & 0x07)) {
    uint16_t mm = tof.readRangeContinuousMillimeters();
    if (tof.timeoutOccurred() || mm == 65535) tofTimeouts++;
    else {
      tofTimeouts = 0;
      dev.tofMm = mm;
    }
  }
  if (mpuOk && now - lastImuMs >= 10) {  // 100 Hz
    lastImuMs = now;
    float g;
    if (imu::readG(g)) dev.accG = g;
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
