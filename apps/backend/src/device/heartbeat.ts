import type { ArmDevice } from "./ArmDevice.js";

/** host → device heartbeat every intervalMs. Never paused, including while a 0G call is in flight (prompt §8.1). */
export class Heartbeat {
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  constructor(private readonly device: ArmDevice, private readonly intervalMs: number) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.paused) this.device.send({ cmd: "hb", seq: this.seq++ });
    }, this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  /** Sim fault injection only: stop sending, to demonstrate the device watchdog. */
  setPaused(p: boolean): void {
    this.paused = p;
  }
  get isPaused(): boolean {
    return this.paused;
  }
}
