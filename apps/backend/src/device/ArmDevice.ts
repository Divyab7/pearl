import type { DeviceMsg, HostCmd } from "../shared/types.js";

/**
 * One interface for the simulated arm, the MuJoCo physics arm, the USB-serial ESP32 and the Wi-Fi ESP32 (prompt §8.1). All three speak the same
 * newline-delimited JSON protocol (prompt §7.5). The laptop can only *request* motion; the device may refuse (nack).
 */
export interface ArmDevice {
  readonly kind: "sim" | "serial" | "ws" | "mujoco";
  connect(): Promise<void>;
  send(cmd: HostCmd): void;
  on(ev: "msg", cb: (m: DeviceMsg) => void): void;
  close(): Promise<void>;
  /** Wire devices report lines they could not parse; they are dropped and logged as parse_error events. */
  onParseError?(cb: (e: { line: string; error: string }) => void): void;
}

export type DeviceState = "BOOT" | "IDLE" | "MOVING" | "WAITING" | "FROZEN_HAND" | "TRIPPED" | "SAFE";

/** Ring colour and buzzer pattern per state (prompt §7.4), mirrored on the dashboard. */
export const STATUS_TABLE: Record<DeviceState, { ring: string; buzzer: string }> = {
  BOOT: { ring: "white spin", buzzer: "1 short beep" },
  IDLE: { ring: "dim green", buzzer: "none" },
  MOVING: { ring: "blue spin", buzzer: "none" },
  WAITING: { ring: "cyan pulse", buzzer: "none" },
  FROZEN_HAND: { ring: "amber solid", buzzer: "2 beeps" },
  TRIPPED: { ring: "red flash", buzzer: "continuous 1 Hz" },
  SAFE: { ring: "red solid", buzzer: "1 long beep" },
};
