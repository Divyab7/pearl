/**
 * In-process simulated arm. It runs the same state machine and thresholds as the ESP32 firmware (prompt §7.4), all
 * taken from config/arm.json, so the safety behaviour shown in sim is the behaviour the hardware must reproduce:
 *  - hand in the ToF zone while MOVING/WAITING → FROZEN_HAND (hold position); leaves only when the zone has been clear
 *    for handClearMs AND the host sends `resume`;
 *  - |accel − 1 g| > bumpG → TRIPPED, frozen in place (never move after a collision);
 *  - no heartbeat for heartbeatTimeoutMs (any state but BOOT) → TRIPPED and ramp to the SAFE pose;
 *  - TRIPPED clears only on `reset` + the physical reset button (in sim the button press is automatic, PLAN §4.3);
 *  - `move` is refused in FROZEN_HAND / TRIPPED / SAFE (`nack state`), while MOVING (`nack busy`), and outside joint
 *    limits (`nack limit`, no motion at all).
 * Motion ramps at maxDegPerS, one joint at a time in [base, shoulder, elbow, gripper] order.
 *
 * Time is simulated: `tick(dtMs)` advances the clock. `connect()` drives it from a real 50 Hz interval unless the arm
 * was built with `manualClock: true` (tests).
 */
import type { ArmConfig } from "../shared/armConfig.js";
import { HostCmdSchema, MAX_LINE_BYTES } from "../shared/schemas.js";
import type { DeviceMsg, HostCmd, Joints } from "../shared/types.js";
import type { ArmDevice, DeviceState } from "./ArmDevice.js";
import { Scene, type SceneState } from "./scene.js";

export interface SimArmOptions {
  manualClock?: boolean;
  tickMs?: number;
  deviceId?: string;
  scene?: SceneState;
  graspFailRate?: number;
  rng?: () => number;
  /** In sim the operator's physical button press is implied by the Reset command (PLAN §4.3). */
  autoResetButton?: boolean;
}

const CLEAR_TOF_MM = 600;
const HAND_TOF_MM = 80;
const BUMP_ACC_G = 2.9;
const RESET_WINDOW_MS = 10_000;

export class SimArm implements ArmDevice {
  readonly kind = "sim" as const;
  private listeners: ((m: DeviceMsg) => void)[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastReal = 0;

  private now = 0;
  private state: DeviceState = "BOOT";
  private pos: number[];
  private target: number[];
  private pendingId: string | null = null;

  private lastHbAt = 0;
  private hbBlocked = false;
  private handUntil = -1;
  private bumpAt = -1;
  private clearSince: number | null = null;
  private handClear = false;
  private tripReason: "bump" | "watchdog" | "sensor" | null = null;
  private resetArmedUntil = -1;
  private nextTelAt = 0;

  readonly scene: Scene;
  private readonly opts: Required<Omit<SimArmOptions, "scene" | "rng">>;

  constructor(private readonly cfg: ArmConfig, options: SimArmOptions = {}) {
    this.opts = {
      manualClock: options.manualClock ?? false,
      tickMs: options.tickMs ?? 20,
      deviceId: options.deviceId ?? "sim-arm-01",
      graspFailRate: options.graspFailRate ?? 0,
      autoResetButton: options.autoResetButton ?? true,
    };
    this.pos = [...cfg.home];
    this.target = [...cfg.home];
    this.scene = new Scene(cfg, options.scene, this.opts.graspFailRate, options.rng ?? Math.random);
  }

  // ---------------- ArmDevice ----------------
  async connect(): Promise<void> {
    this.emit({ t: "hello", fw: "pearl-sim-0.2", deviceId: this.opts.deviceId, joints: this.joints() });
    this.lastHbAt = this.now;
    this.state = "IDLE"; // sim sensors always initialise
    if (!this.opts.manualClock) {
      this.lastReal = performance.now();
      this.interval = setInterval(() => {
        const t = performance.now();
        this.tick(t - this.lastReal);
        this.lastReal = t;
      }, this.opts.tickMs);
    }
  }

  async close(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  on(_ev: "msg", cb: (m: DeviceMsg) => void): void {
    this.listeners.push(cb);
  }

  send(cmd: HostCmd): void {
    this.sendLine(JSON.stringify(cmd));
  }

  /** Raw protocol entry point, as the firmware's line reader would see it. */
  sendLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return this.emit({ t: "nack", reason: "parse" });
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return this.emit({ t: "nack", reason: "parse" });
    }
    const r = HostCmdSchema.safeParse(json);
    if (!r.success) {
      const id = (json as { id?: unknown })?.id;
      return this.emit(typeof id === "string" ? { t: "nack", id, reason: "parse" } : { t: "nack", reason: "parse" });
    }
    this.handle(r.data);
  }

  // ---------------- fault injection (sim only) ----------------
  injectHand(ms: number): void {
    this.handUntil = this.now + ms;
  }
  injectBump(): void {
    this.bumpAt = this.now;
  }
  /** Simulates the laptop link dying: incoming heartbeats are no longer seen by the device. */
  stopHeartbeatReply(): void {
    this.hbBlocked = true;
  }
  restoreHeartbeat(): void {
    this.hbBlocked = false;
  }
  /** The physical reset button (BOOT button on the DevKit). */
  pressResetButton(): void {
    if (this.state !== "TRIPPED" || this.now > this.resetArmedUntil) return;
    this.resetArmedUntil = -1;
    this.tripReason = null;
    this.lastHbAt = this.now;
    this.emit({ t: "event", ev: "reset_done" });
    this.enterSafe();
  }

  // ---------------- introspection ----------------
  getState(): DeviceState {
    return this.state;
  }
  joints(): Joints {
    return this.pos.map((d) => Math.round(d)) as Joints;
  }
  tofMm(): number {
    return this.now < this.handUntil ? HAND_TOF_MM : CLEAR_TOF_MM;
  }
  accG(): number {
    return this.bumpAt >= 0 && this.now - this.bumpAt < this.opts.tickMs * 2 ? BUMP_ACC_G : 1.0;
  }
  hbAgeMs(): number {
    return Math.max(0, Math.round(this.now - this.lastHbAt));
  }
  clockMs(): number {
    return this.now;
  }

  // ---------------- simulation step ----------------
  tick(dtMs: number): void {
    this.now += dtMs;
    this.safety();
    this.motion(dtMs);
    this.scene.update(this.joints());
    if (this.now >= this.nextTelAt) {
      // keep a fixed phase so the average rate is exactly telemetryHz regardless of tick length
      const period = 1000 / this.cfg.telemetryHz;
      this.nextTelAt += period;
      if (this.nextTelAt <= this.now) this.nextTelAt = this.now + period;
      this.emit({
        t: "tel",
        ms: Math.round(this.now),
        state: this.state,
        joints: this.joints(),
        target: this.target.map((d) => Math.round(d)) as Joints,
        tofMm: this.tofMm(),
        accG: this.accG(),
        hbAgeMs: this.hbAgeMs(),
      });
    }
  }

  /** Runs every tick before motion; never waits for the host. */
  private safety(): void {
    if (this.state === "BOOT") return;

    // bump: freeze in place, even if already tripped by the watchdog
    const acc = this.accG();
    if (Math.abs(acc - 1) > this.cfg.bumpG && this.tripReason !== "bump") {
      this.freeze();
      this.tripReason = "bump";
      this.state = "TRIPPED";
      this.emit({ t: "event", ev: "trip_bump", accG: acc });
      return;
    }

    // heartbeat watchdog: trip and ramp to SAFE (unless a collision already froze the arm)
    if (this.hbAgeMs() > this.cfg.heartbeatTimeoutMs && this.state !== "TRIPPED") {
      this.pendingId = null;
      this.tripReason = "watchdog";
      this.state = "TRIPPED";
      this.target = [...this.cfg.safe];
      this.emit({ t: "event", ev: "trip_watchdog", hbAgeMs: this.hbAgeMs() });
      return;
    }

    // hand in zone
    const tof = this.tofMm();
    const inZone = tof < this.cfg.handZoneMm;
    if (this.state === "MOVING" || this.state === "WAITING") {
      if (inZone) {
        this.freeze();
        this.state = "FROZEN_HAND";
        this.clearSince = null;
        this.handClear = false;
        this.emit({ t: "event", ev: "hand_in_zone", tofMm: tof });
      }
    } else if (this.state === "FROZEN_HAND") {
      if (inZone) {
        if (this.clearSince !== null) this.emit({ t: "event", ev: "hand_in_zone", tofMm: tof });
        this.clearSince = null;
        this.handClear = false;
      } else {
        if (this.clearSince === null) this.clearSince = this.now;
        if (!this.handClear && this.now - this.clearSince >= this.cfg.handClearMs) {
          this.handClear = true;
          this.emit({ t: "event", ev: "hand_clear" });
        }
      }
    }
  }

  private motion(dtMs: number): void {
    if (this.state === "FROZEN_HAND" || (this.state === "TRIPPED" && this.tripReason === "bump")) return;
    let budget = (this.cfg.maxDegPerS * dtMs) / 1000;
    for (let i = 0; i < 4 && budget > 0; i++) {
      const d = this.target[i]! - this.pos[i]!;
      if (d === 0) continue;
      const step = Math.min(Math.abs(d), budget);
      this.pos[i] = this.pos[i]! + Math.sign(d) * step;
      budget -= step;
      if (Math.abs(this.target[i]! - this.pos[i]!) > 1e-9) break; // one joint at a time
      this.pos[i] = this.target[i]!;
    }
    if (this.state === "MOVING" && this.atTarget()) {
      this.state = "IDLE";
      const id = this.pendingId;
      this.pendingId = null;
      if (id) this.emit({ t: "done", id });
    }
  }

  // ---------------- command handling ----------------
  private handle(cmd: HostCmd): void {
    switch (cmd.cmd) {
      case "hb":
        if (!this.hbBlocked) this.lastHbAt = this.now;
        return;
      case "i2c_scan":
        return this.emit({ t: "i2c", addrs: ["0x29", "0x40", "0x68"] });
      case "move":
        return this.startMove(cmd.id, cmd.joints);
      case "grip": {
        const g = cmd.close ? this.cfg.gripClosed : this.cfg.gripOpen;
        const j = this.joints();
        return this.startMove(cmd.id, [j[0], j[1], j[2], g]);
      }
      case "hold":
        if (this.state === "IDLE" || this.state === "MOVING") {
          this.freeze();
          this.state = "WAITING";
        } else if (this.state !== "WAITING") {
          this.emit({ t: "nack", reason: "state" });
        }
        return;
      case "resume":
        return this.resume();
      case "safe":
        if (this.state === "TRIPPED") return this.emit({ t: "nack", reason: "state" });
        return this.enterSafe();
      case "reset":
        if (this.state !== "TRIPPED") return this.emit({ t: "nack", reason: "state" });
        this.resetArmedUntil = this.now + RESET_WINDOW_MS;
        this.emit({ t: "event", ev: "reset_armed" });
        if (this.opts.autoResetButton) this.pressResetButton();
        return;
      case "cal":
        if (this.state !== "IDLE") this.emit({ t: "nack", reason: "state" });
        return; // no servos to drive in sim
    }
  }

  private startMove(id: string, joints: readonly number[]): void {
    if (this.state === "MOVING") return this.emit({ t: "nack", id, reason: "busy" });
    if (this.state !== "IDLE" && this.state !== "WAITING") return this.emit({ t: "nack", id, reason: "state" });
    for (let i = 0; i < 4; i++) {
      if (joints[i]! < this.cfg.jointMinDeg[i]! || joints[i]! > this.cfg.jointMaxDeg[i]!) {
        return this.emit({ t: "nack", id, reason: "limit" });
      }
    }
    this.target = [...joints];
    this.pendingId = id;
    this.state = "MOVING";
    this.emit({ t: "ack", id });
    if (this.atTarget()) this.motion(0);
  }

  private resume(): void {
    switch (this.state) {
      case "FROZEN_HAND":
        if (!this.handClear) return this.emit({ t: "nack", reason: "state" });
        this.state = "IDLE";
        return;
      case "WAITING":
        this.state = "IDLE";
        return;
      case "SAFE":
        if (!this.atTarget()) return this.emit({ t: "nack", reason: "busy" });
        this.state = "IDLE";
        return;
      default:
        return this.emit({ t: "nack", reason: "state" });
    }
  }

  private enterSafe(): void {
    this.pendingId = null;
    this.state = "SAFE";
    this.target = [...this.cfg.safe];
  }

  private freeze(): void {
    this.pendingId = null;
    this.target = [...this.pos];
  }

  private atTarget(): boolean {
    return this.target.every((t, i) => Math.abs(t - this.pos[i]!) < 1e-9);
  }

  private emit(m: DeviceMsg): void {
    for (const cb of this.listeners) cb(m);
  }
}
