/**
 * ESP32-S3 over native USB serial (DEVICE=serial). serialport 13 + @serialport/parser-readline:
 *   new SerialPort({ path, baudRate, autoOpen }) · port.pipe(new ReadlineParser({ delimiter: "\n" }))
 * Docs: https://serialport.io/docs/api-serialport and https://serialport.io/docs/api-parser-readline
 * (signatures checked in node_modules/serialport/dist/serialport.d.ts and @serialport/parser-readline/dist/index.d.ts).
 * The ESP32's own safety loop never depends on this link: if the laptop dies, its watchdog trips in 3 s.
 */
import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPort } from "serialport";
import type { DeviceMsg, HostCmd } from "../shared/types.js";
import type { ArmDevice } from "./ArmDevice.js";
import { encodeCmd, LineHub } from "./lineProtocol.js";

export class SerialArm implements ArmDevice {
  readonly kind = "serial" as const;
  private port: SerialPort | null = null;
  private hub = new LineHub();

  constructor(private readonly path: string, private readonly baudRate = 115200) {}

  async connect(): Promise<void> {
    const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
    await new Promise<void>((res, rej) => port.open((err) => (err ? rej(new Error(`serial ${this.path}: ${err.message}`)) : res())));
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (line: string) => this.hub.receive(line));
    port.on("error", (e) => console.error(`serial error: ${e.message}`));
    this.port = port;
  }

  send(cmd: HostCmd): void {
    this.port?.write(encodeCmd(cmd));
  }

  on(_ev: "msg", cb: (m: DeviceMsg) => void): void {
    this.hub.onMsg(cb);
  }

  onParseError(cb: (e: { line: string; error: string }) => void): void {
    this.hub.onError(cb);
  }

  async close(): Promise<void> {
    const p = this.port;
    this.port = null;
    if (p?.isOpen) await new Promise<void>((res) => p.close(() => res()));
  }
}
