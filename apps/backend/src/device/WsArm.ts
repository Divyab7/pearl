/**
 * ESP32-S3 over Wi-Fi (DEVICE=ws, milestone H7): the backend runs a WebSocket server on WS_PORT and the ESP32 connects
 * as a client over the phone hotspot; each text frame is one protocol line. ws 8 API: https://github.com/websockets/ws
 * Only one arm connection at a time; a new connection replaces the old one.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { DeviceMsg, HostCmd } from "../shared/types.js";
import type { ArmDevice } from "./ArmDevice.js";
import { encodeCmd, LineHub } from "./lineProtocol.js";

export class WsArm implements ArmDevice {
  readonly kind = "ws" as const;
  private wss: WebSocketServer | null = null;
  private sock: WebSocket | null = null;
  private hub = new LineHub();

  constructor(private readonly port: number) {}

  async connect(): Promise<void> {
    this.wss = new WebSocketServer({ port: this.port });
    await new Promise<void>((res) => this.wss!.once("listening", () => res()));
    this.wss.on("connection", (ws) => {
      this.sock?.close();
      this.sock = ws;
      ws.on("message", (data) => {
        for (const line of data.toString("utf8").split("\n")) this.hub.receive(line);
      });
      ws.on("close", () => {
        if (this.sock === ws) this.sock = null;
      });
    });
  }

  get connected(): boolean {
    return this.sock !== null;
  }

  send(cmd: HostCmd): void {
    this.sock?.send(encodeCmd(cmd).trimEnd());
  }

  on(_ev: "msg", cb: (m: DeviceMsg) => void): void {
    this.hub.onMsg(cb);
  }

  onParseError(cb: (e: { line: string; error: string }) => void): void {
    this.hub.onError(cb);
  }

  async close(): Promise<void> {
    this.sock?.close();
    await new Promise<void>((res) => (this.wss ? this.wss.close(() => res()) : res()));
    this.wss = null;
  }
}
