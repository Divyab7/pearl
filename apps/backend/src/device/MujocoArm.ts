/**
 * MuJoCo physics arm (DEVICE=mujoco). The Python bridge in sim/mujoco/ runs the arm in MuJoCo and connects to this
 * backend over WebSocket exactly like the Wi-Fi ESP32 (same lines, same strict parsing), so this is a WsArm plus the
 * bridge's HTTP extras: a fresh camera render per decision, the tabletop read from the physics, and fault injection.
 * Bridge endpoints: GET /frame.jpg, GET /scene, POST /inject/hand?ms=, POST /inject/bump,
 * POST /reset-table (sim/mujoco/README.md).
 */
import type { SceneState } from "./scene.js";
import type { DeviceMsg, HostCmd } from "../shared/types.js";
import type { ArmDevice } from "./ArmDevice.js";
import { WsArm } from "./WsArm.js";

const SCENE_POLL_MS = 250;

export class MujocoArm implements ArmDevice {
  readonly kind = "mujoco" as const;
  private readonly ws: WsArm;
  private lastScene: SceneState | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(
    wsPort: number,
    readonly bridgeUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.ws = new WsArm(wsPort);
  }

  get frameUrl(): string {
    return `${this.bridgeUrl}/frame.jpg`;
  }

  get connected(): boolean {
    return this.ws.connected;
  }

  async connect(): Promise<void> {
    await this.ws.connect();
    this.poll = setInterval(() => void this.refreshScene(), SCENE_POLL_MS);
  }

  async close(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    await this.ws.close();
  }

  send(cmd: HostCmd): void {
    this.ws.send(cmd);
  }

  on(ev: "msg", cb: (m: DeviceMsg) => void): void {
    this.ws.on(ev, cb);
  }

  onParseError(cb: (e: { line: string; error: string }) => void): void {
    this.ws.onParseError(cb);
  }

  /** Last tabletop read from the physics (null until the bridge answers). */
  scene(): SceneState | null {
    return this.lastScene;
  }

  async refreshScene(): Promise<void> {
    try {
      const r = await this.fetchImpl(`${this.bridgeUrl}/scene`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) this.lastScene = (await r.json()) as SceneState;
    } catch {
      this.lastScene = null; // bridge not running: show no scene rather than a stale one
    }
  }

  async injectHand(ms: number): Promise<void> {
    await this.inject(`/inject/hand?ms=${Math.round(ms)}`);
  }

  async injectBump(): Promise<void> {
    await this.inject("/inject/bump");
  }

  /** The operator puts the cubes back on their posts (between demo runs). */
  async resetTable(): Promise<void> {
    await this.inject("/reset-table");
  }

  private async inject(path: string): Promise<void> {
    const r = await this.fetchImpl(`${this.bridgeUrl}${path}`, { method: "POST", signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`MuJoCo bridge HTTP ${r.status}`);
  }
}
