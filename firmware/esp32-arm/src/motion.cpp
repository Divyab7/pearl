#include "motion.h"
#include <Adafruit_PWMServoDriver.h>
#include <Wire.h>
#include "config.h"
#include "state.h"

namespace motion {

const int MIN_DEG[4] = JOINT_MIN_DEG;
const int MAX_DEG[4] = JOINT_MAX_DEG;
const int HOME[4] = HOME_DEG;
const int SAFE[4] = SAFE_DEG;
static const uint8_t CH[4] = {CH_BASE, CH_SHOULDER, CH_ELBOW, CH_GRIPPER};

static Adafruit_PWMServoDriver pca(0x40, Wire);
static int lastUs[4] = {-1, -1, -1, -1};

static uint16_t degToUs(float d) {
  return static_cast<uint16_t>(SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) * (d / 180.0f) + 0.5f);
}

static void write(int i) {
  uint16_t us = degToUs(dev.pos[i]);
  if (us != lastUs[i]) {
    pca.writeMicroseconds(CH[i], us);
    lastUs[i] = us;
  }
}

bool begin() {
  if (!pca.begin()) return false;
  pca.setOscillatorFrequency(PCA_OSC_HZ);
  pca.setPWMFreq(SERVO_HZ);
  for (int i = 0; i < 4; i++) {
    dev.pos[i] = HOME[i];
    dev.target[i] = HOME[i];
    write(i);
  }
  return true;
}

bool withinLimits(const int j[4]) {
  for (int i = 0; i < 4; i++)
    if (j[i] < MIN_DEG[i] || j[i] > MAX_DEG[i]) return false;
  return true;
}

void setTarget(const int j[4]) {
  for (int i = 0; i < 4; i++) dev.target[i] = j[i];
}
void setTargetSafe() { setTarget(SAFE); }
void freeze() {
  for (int i = 0; i < 4; i++) dev.target[i] = dev.pos[i];
}
bool atTarget() {
  for (int i = 0; i < 4; i++)
    if (fabsf(dev.target[i] - dev.pos[i]) > 1e-3f) return false;
  return true;
}

void tick(uint32_t dtMs) {
  if (dev.state == DevState::FROZEN_HAND) return;
  if (dev.state == DevState::TRIPPED && dev.trip == TripReason::BUMP) return;  // never move after a collision
  float budget = MAX_DEG_PER_S * (dtMs / 1000.0f);
  for (int i = 0; i < 4 && budget > 0; i++) {
    float d = dev.target[i] - dev.pos[i];
    if (fabsf(d) < 1e-3f) continue;
    float step = fminf(fabsf(d), budget);
    dev.pos[i] += (d > 0 ? step : -step);
    budget -= step;
    write(i);
    if (fabsf(dev.target[i] - dev.pos[i]) > 1e-3f) break;  // one joint at a time
    dev.pos[i] = dev.target[i];
  }
}

void writeRawUs(uint8_t ch, uint16_t us) { pca.writeMicroseconds(ch, us); }

}  // namespace motion
