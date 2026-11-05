/**
 * Shared newline-JSON handling for the wire devices (prompt §7.5): one JSON object per line, ≤ 512 bytes.
 * Every inbound line is validated with the strict DeviceMsg schema; anything else is dropped and reported.
 */
import { DeviceMsgSchema, formatIssues, MAX_LINE_BYTES } from "../shared/schemas.js";
import type { DeviceMsg, HostCmd } from "../shared/types.js";

export class LineHub {
  private msgCbs: ((m: DeviceMsg) => void)[] = [];
  private errCbs: ((e: { line: string; error: string }) => void)[] = [];

  onMsg(cb: (m: DeviceMsg) => void): void {
    this.msgCbs.push(cb);
  }
  onError(cb: (e: { line: string; error: string }) => void): void {
    this.errCbs.push(cb);
  }

  /** Feed one received line (without the newline). */
  receive(raw: string): void {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return this.fail(line, "line longer than 512 bytes");
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return this.fail(line, "not JSON");
    }
    const r = DeviceMsgSchema.safeParse(json);
    if (!r.success) return this.fail(line, formatIssues(r.error));
    for (const cb of this.msgCbs) cb(r.data);
  }

  private fail(line: string, error: string): void {
    for (const cb of this.errCbs) cb({ line: line.slice(0, 200), error });
  }
}

export function encodeCmd(cmd: HostCmd): string {
  const s = JSON.stringify(cmd);
  if (Buffer.byteLength(s, "utf8") > MAX_LINE_BYTES) throw new Error("command line over 512 bytes");
  return `${s}\n`;
}
