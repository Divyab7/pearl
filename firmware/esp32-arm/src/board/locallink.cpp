#ifdef PEARL_DEVICE
#include "locallink.h"
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <string.h>
#include "config.h"
#include "feed.h"

namespace locallink {

struct Line {
  uint16_t n;
  char s[MAX_LINE_BYTES + 1];
};
static QueueHandle_t toArmQ, fromArmQ;
static SemaphoreHandle_t telLock;
static Line lastTel;

void begin() {
  toArmQ = xQueueCreate(16, sizeof(Line));
  fromArmQ = xQueueCreate(48, sizeof(Line));
  telLock = xSemaphoreCreateMutex();
  lastTel.n = 0;
}

void drainCommands(void (*dispatch)(const char*, size_t)) {
  Line l;
  while (xQueueReceive(toArmQ, &l, 0) == pdTRUE) dispatch(l.s, l.n);
}

void fromArm(const char* line, size_t n) {
  if (n > MAX_LINE_BYTES) return;
  Line l;
  l.n = n;
  memcpy(l.s, line, n);
  l.s[n] = 0;
  bool tel = strncmp(line, "{\"t\":\"tel\"", 10) == 0;
  if (tel) {
    xSemaphoreTake(telLock, portMAX_DELAY);
    lastTel = l;
    xSemaphoreGive(telLock);
    // telemetry is plentiful (20 Hz): drop it rather than block the safety loop when the run task is busy
    xQueueSend(fromArmQ, &l, 0);
  } else {
    // done / nack / events matter: wait briefly for room
    if (xQueueSend(fromArmQ, &l, pdMS_TO_TICKS(5)) != pdTRUE) {
      Line drop;
      xQueueReceive(fromArmQ, &drop, 0);  // make room by dropping the oldest (telemetry first in practice)
      xQueueSend(fromArmQ, &l, 0);
    }
  }
  feed::fromArm(line, n, tel);
}

bool toArm(const JsonDocument& cmd) {
  Line l;
  l.n = serializeJson(cmd, l.s, MAX_LINE_BYTES);
  l.s[l.n] = 0;
  return xQueueSend(toArmQ, &l, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool nextFromArm(JsonDocument& msg, uint32_t waitMs) {
  Line l;
  if (xQueueReceive(fromArmQ, &l, pdMS_TO_TICKS(waitMs)) != pdTRUE) return false;
  return deserializeJson(msg, l.s, l.n) == DeserializationError::Ok;
}

size_t lastTelemetry(char* out, size_t cap) {
  xSemaphoreTake(telLock, portMAX_DELAY);
  size_t n = lastTel.n < cap - 1 ? lastTel.n : cap - 1;
  memcpy(out, lastTel.s, n);
  out[n] = 0;
  xSemaphoreGive(telLock);
  return n;
}

}  // namespace locallink
#endif
