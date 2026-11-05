// Ramped motion, one joint at a time, clamped to limits; "freeze" = stop changing targets, keep holding PWM.
#pragma once
#include <Arduino.h>

namespace motion {
bool begin();                       // PCA9685 at 50 Hz; false if the driver does not answer
void tick(uint32_t dtMs);           // advance toward target; never moves when frozen
bool withinLimits(const int j[4]);
void setTarget(const int j[4]);
void setTargetSafe();
void freeze();                      // target := current position
bool atTarget();
void writeRawUs(uint8_t ch, uint16_t us);   // bring-up `cal` only
extern const int MIN_DEG[4], MAX_DEG[4], HOME[4], SAFE[4];
}  // namespace motion
