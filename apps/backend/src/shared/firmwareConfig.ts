/**
 * Parses the #defines of firmware/esp32-arm/src/config.h so a test can prove the ESP32 and SimArm use the same
 * numbers as config/arm.json (build spec §8.1: "firmware config.h must match; a unit test compares them").
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArmConfig } from "./armConfig.js";
import { REPO_ROOT } from "./env.js";

export function parseDefines(header: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of header.split("\n")) {
    const d = line.match(/^\s*#define\s+([A-Z0-9_]+)\s+(.+?)\s*(\/\/.*)?$/);
    if (d) m.set(d[1]!, d[2]!.trim());
  }
  return m;
}

const num = (v: string | undefined) => (v === undefined ? NaN : Number(v));
const arr = (v: string | undefined) =>
  v === undefined ? [] : v.replace(/[{}]/g, "").split(",").map((s) => Number(s.trim()));

/** Returns one line per mismatch; empty means the firmware and arm.json agree. */
export function compareFirmwareConfig(cfg: ArmConfig, header: string): string[] {
  const d = parseDefines(header);
  const out: string[] = [];
  const same = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${name}: config.h ${JSON.stringify(got)} ≠ arm.json ${JSON.stringify(want)}`);
  };
  same("channels", ["CH_BASE", "CH_SHOULDER", "CH_ELBOW", "CH_GRIPPER"].map((k) => num(d.get(k))), cfg.channels);
  same("SERVO_MIN_US", num(d.get("SERVO_MIN_US")), cfg.servoMinUs);
  same("SERVO_MAX_US", num(d.get("SERVO_MAX_US")), cfg.servoMaxUs);
  same("JOINT_MIN_DEG", arr(d.get("JOINT_MIN_DEG")), cfg.jointMinDeg);
  same("JOINT_MAX_DEG", arr(d.get("JOINT_MAX_DEG")), cfg.jointMaxDeg);
  same("HOME_DEG", arr(d.get("HOME_DEG")), cfg.home);
  same("SAFE_DEG", arr(d.get("SAFE_DEG")), cfg.safe);
  same("GRIP_OPEN_DEG", num(d.get("GRIP_OPEN_DEG")), cfg.gripOpen);
  same("GRIP_CLOSED_DEG", num(d.get("GRIP_CLOSED_DEG")), cfg.gripClosed);
  same("MAX_DEG_PER_S", num(d.get("MAX_DEG_PER_S")), cfg.maxDegPerS);
  same("HAND_ZONE_MM", num(d.get("HAND_ZONE_MM")), cfg.handZoneMm);
  same("HAND_CLEAR_MS", num(d.get("HAND_CLEAR_MS")), cfg.handClearMs);
  same("BUMP_G", num(d.get("BUMP_G")), cfg.bumpG);
  same("HEARTBEAT_TIMEOUT_MS", num(d.get("HEARTBEAT_TIMEOUT_MS")), cfg.heartbeatTimeoutMs);
  same("TELEMETRY_HZ", num(d.get("TELEMETRY_HZ")), cfg.telemetryHz);
  return out;
}

export function readFirmwareHeader(): string {
  return readFileSync(resolve(REPO_ROOT, "firmware/esp32-arm/src/config.h"), "utf8");
}
