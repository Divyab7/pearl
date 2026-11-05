/**
 * Watches one ArmDevice: latest telemetry, safety events, and per-command outcomes. Inbound messages from wire devices
 * are validated by the device class; SimArm emits typed objects.
 */
import { isHardTrip, isSafetyEventName, type DeviceMsg, type SafetyEventName } from "../shared/types.js";
import type { ArmDevice, DeviceState } from "./ArmDevice.js";

type Tel = Extract<DeviceMsg, { t: "tel" }>;
type DeviceEvent = Extract<DeviceMsg, { t: "event" }>;
export type SafetyEvent = DeviceEvent & { ev: SafetyEventName };

export const isSafetyEvent = (m: DeviceMsg): m is SafetyEvent => m.t === "event" && isSafetyEventName(m.ev);

export type CmdOutcome = { ok: true } | { ok: false; reason: string } | { ok: false; reason: "interrupted"; event: SafetyEvent };

export class DeviceMonitor {
  lastTel: Tel | null = null;
  /** Wall-clock time the last telemetry line arrived (0 = never). */
  lastTelAt = 0;
  handClear = false;
  hardTrip = false;
  lastSafety: SafetyEvent | null = null;
  private pendingSafety = false;
  private waiters = new Map<string, (o: CmdOutcome) => void>();
  private safetyWaiters = new Set<(e: SafetyEvent) => void>();
  private telWaiters = new Set<() => void>();
  private listeners: ((m: DeviceMsg) => void)[] = [];

  constructor(readonly device: ArmDevice) {
    device.on("msg", (m) => this.onMsg(m));
  }

  onAny(cb: (m: DeviceMsg) => void): void {
    this.listeners.push(cb);
  }

  get state(): DeviceState | "UNKNOWN" {
    return this.lastTel?.state ?? "UNKNOWN";
  }

  /** True once since the last call if a safety event arrived. */
  takeSafety(): boolean {
    const p = this.pendingSafety;
    this.pendingSafety = false;
    return p;
  }
  peekSafety(): boolean {
    return this.pendingSafety;
  }

  /** True while the arm is streaming telemetry (a wire arm that is not connected yet, or has dropped, is not). */
  linkAlive(maxAgeMs = 1000): boolean {
    return this.lastTelAt > 0 && Date.now() - this.lastTelAt <= maxAgeMs;
  }

  /** Called by the operator reset path so a new episode starts with a clean slate. */
  clearTrip(): void {
    this.hardTrip = false;
    this.pendingSafety = false;
    this.lastSafety = null;
  }

  private onMsg(m: DeviceMsg): void {
    if (m.t === "tel") {
      this.lastTel = m;
      this.lastTelAt = Date.now();
      for (const w of [...this.telWaiters]) w();
    } else if (m.t === "event") {
      if (m.ev === "hand_in_zone") this.handClear = false;
      if (m.ev === "hand_clear") this.handClear = true;
      if (isHardTrip(m.ev)) this.hardTrip = true;
      if (m.ev === "reset_done") this.hardTrip = false;
      if (isSafetyEvent(m)) {
        this.lastSafety = m;
        this.pendingSafety = true;
        for (const w of [...this.safetyWaiters]) w(m);
        // a safety event interrupts every command still waiting for done
        for (const [id, w] of this.waiters) {
          this.waiters.delete(id);
          w({ ok: false, reason: "interrupted", event: m });
        }
      }
    } else if (m.t === "done") {
      this.resolve(m.id, { ok: true });
    } else if (m.t === "nack" && m.id) {
      this.resolve(m.id, { ok: false, reason: `nack ${m.reason}` });
    }
    for (const cb of this.listeners) cb(m);
  }

  private resolve(id: string, o: CmdOutcome): void {
    const w = this.waiters.get(id);
    if (w) {
      this.waiters.delete(id);
      w(o);
    }
  }

  /** Resolves every pending command wait (operator stop). */
  cancelAll(reason: string): void {
    for (const [id, w] of this.waiters) {
      this.waiters.delete(id);
      w({ ok: false, reason });
    }
  }

  /** Resolves when the command with this id is done, refused, interrupted by a safety event, or times out. */
  awaitCommand(id: string, timeoutMs: number): Promise<CmdOutcome> {
    return new Promise((res) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        res({ ok: false, reason: `timeout after ${timeoutMs} ms` });
      }, timeoutMs);
      this.waiters.set(id, (o) => {
        clearTimeout(t);
        res(o);
      });
    });
  }

  /** Resolves true when pred(telemetry) holds, false on timeout or (if abortOnSafety) a safety event. */
  waitFor(pred: (t: Tel) => boolean, timeoutMs: number, abortOnSafety = true): Promise<boolean> {
    return new Promise((res) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.telWaiters.delete(check);
        this.safetyWaiters.delete(onSafety);
        res(v);
      };
      const check = () => {
        if (this.lastTel && pred(this.lastTel)) done(true);
      };
      const onSafety = () => {
        if (abortOnSafety) done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.telWaiters.add(check);
      this.safetyWaiters.add(onSafety);
      check();
    });
  }

  /** Waits for hand_clear (true), a hard trip or timeout (false). */
  waitHandClearOrTrip(timeoutMs: number): Promise<boolean> {
    if (this.handClear) return Promise.resolve(true);
    if (this.hardTrip) return Promise.resolve(false);
    return new Promise((res) => {
      const off = (v: boolean) => {
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== l2);
        res(v);
      };
      const l2 = (m: DeviceMsg) => {
        if (m.t !== "event") return;
        if (m.ev === "hand_clear") off(true);
        else if (isHardTrip(m.ev)) off(false);
      };
      const timer = setTimeout(() => off(false), timeoutMs);
      this.listeners.push(l2);
    });
  }
}
