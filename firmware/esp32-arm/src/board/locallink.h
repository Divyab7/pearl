// env:device — the arm and the run task live on the same chip. Commands from the run task go through a queue and are
// executed by loop() (the only task that touches the arm), and every message the arm sends is copied to the run
// task's queue and to the live feed. The safety loop never waits on these queues.
#pragma once
#include <ArduinoJson.h>
#include <stddef.h>

namespace locallink {
void begin();
/** loop() side: runs queued commands through `dispatch`. */
void drainCommands(void (*dispatch)(const char* line, size_t n));
/** loop() side: an arm message (tel, ack, done, nack, event) leaving the arm. */
void fromArm(const char* line, size_t n);
/** run-task side. */
bool toArm(const JsonDocument& cmd);
bool nextFromArm(JsonDocument& msg, uint32_t waitMs);
/** The latest telemetry line (any task), for /api/state. */
size_t lastTelemetry(char* out, size_t cap);
}  // namespace locallink
