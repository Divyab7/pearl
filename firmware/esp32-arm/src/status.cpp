#include "status.h"
#include <Adafruit_NeoPixel.h>
#include "config.h"
#include "state.h"

namespace status {

static Adafruit_NeoPixel ring(RING_LEDS, PIN_RING, NEO_GRB + NEO_KHZ800);
static uint32_t lastFrame = 0;
static DevState shown = DevState::BOOT;
static uint32_t enteredMs = 0;
static uint32_t oneShotUntil = 0;

static void buzzer(bool on) {
  // PWM at BUZZER_LEVEL instead of full on: same sound, quieter (owner request)
  uint32_t duty = on ? BUZZER_LEVEL : 0;
  ledcWrite(PIN_BUZZER, BUZZER_ACTIVE_HIGH == 1 ? duty : 255 - duty);
}

void begin() {
  ledcAttach(PIN_BUZZER, BUZZER_PWM_HZ, 8);
  buzzer(false);
  ring.begin();
  ring.setBrightness(RING_MAX_BRIGHTNESS);
  ring.clear();
  ring.show();
}

void beepShort(uint32_t now) { oneShotUntil = now + 120; }

static void fill(uint32_t c) {
  for (int i = 0; i < RING_LEDS; i++) ring.setPixelColor(i, c);
}
static void spin(uint32_t c, uint32_t now) {
  ring.clear();
  int head = (now / 80) % RING_LEDS;
  ring.setPixelColor(head, c);
  ring.setPixelColor((head + RING_LEDS - 1) % RING_LEDS, c);
}

void tick(uint32_t now) {
  if (dev.state != shown) {
    shown = dev.state;
    enteredMs = now;
  }
  uint32_t t = now - enteredMs;
  // buzzer: patterns per state, plus one-shot beeps
  bool b = now < oneShotUntil;
  switch (dev.state) {
    case DevState::FROZEN_HAND: b = b || (t < 120) || (t > 240 && t < 360); break;  // 2 beeps
    case DevState::TRIPPED: b = b || ((now / 500) % 2 == 0); break;                 // continuous 1 Hz
    case DevState::SAFE: b = b || (t < 700); break;                                 // 1 long beep
    default: break;
  }
  buzzer(b);

  if (now - lastFrame < 30) return;  // ~33 fps ring, show() is short for 12 LEDs
  lastFrame = now;
  switch (dev.state) {
    case DevState::BOOT: spin(ring.Color(255, 255, 255), now); break;
    case DevState::IDLE: fill(ring.Color(0, 40, 0)); break;
    case DevState::MOVING: spin(ring.Color(0, 0, 255), now); break;
    case DevState::WAITING: {
      uint8_t v = static_cast<uint8_t>(60 + 60 * sinf(now / 300.0f));
      fill(ring.Color(0, v, v));
      break;
    }
    case DevState::FROZEN_HAND: fill(ring.Color(255, 120, 0)); break;
    case DevState::TRIPPED: fill((now / 250) % 2 ? ring.Color(255, 0, 0) : 0); break;
    case DevState::SAFE: fill(ring.Color(255, 0, 0)); break;
  }
  ring.show();
}

}  // namespace status
