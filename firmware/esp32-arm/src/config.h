// Pearl arm firmware configuration (build spec §7.2).
// Starting values; recalibrated in bring-up step B9. Every number shared with config/arm.json must match it:
// `pnpm test` parses this file and compares (apps/backend/src/shared/firmwareConfig.test.ts).
#pragma once

#define PIN_SDA 8
#define PIN_SCL 9
#define PIN_RING 13
#define PIN_BUZZER 21
#define PIN_TOF_XSHUT 14
#define PIN_RESET_BTN 0          // BOOT button, active LOW, read after boot only
#define BUZZER_ACTIVE_HIGH 1     // via NPN low-side switch
#define RING_LEDS 12             // WCMCU-2812B-12, data to DI
#define RING_MAX_BRIGHTNESS 48
#define SERVO_HZ 50
#define PCA_OSC_HZ 27000000

// PCA9685 channels, order: base, shoulder, elbow, gripper
#define CH_BASE 0
#define CH_SHOULDER 1
#define CH_ELBOW 2
#define CH_GRIPPER 3
#define SERVO_MIN_US 600
#define SERVO_MAX_US 2400
#define JOINT_MIN_DEG { 10, 30, 20, 10 }
#define JOINT_MAX_DEG { 170, 150, 160, 80 }   // gripper: 10 = open, 80 = closed (calibrate)
#define HOME_DEG { 90, 90, 90, 10 }
#define SAFE_DEG { 90, 120, 60, 10 }          // folded up, claw open
#define GRIP_OPEN_DEG 10
#define GRIP_CLOSED_DEG 80
#define MAX_DEG_PER_S 60
#define HAND_ZONE_MM 120         // VL53L0X reading below this = hand in zone
#define HAND_CLEAR_MS 1000       // must be clear this long to count as clear
#define BUMP_G 1.8               // |accel| deviation from 1 g that counts as a bump
#define HEARTBEAT_TIMEOUT_MS 3000
#define TELEMETRY_HZ 20

// firmware-only settings
#define RESET_WINDOW_MS 10000    // BOOT button must be pressed within this time after `reset`
#define TOF_FAULT_COUNT 10       // consecutive ToF timeouts that count as a sensor fault
#define MAX_LINE_BYTES 512
#define FW_VERSION "pearl-arm-0.2"
#define DEVICE_ID "esp32-s3-01"
