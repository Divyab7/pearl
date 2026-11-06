/** Small helpers shared by the device program, the dashboard server and the scripts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The message of a thrown value, whatever was thrown. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 0x + 64 hex digits: the shape of an EVM private key. */
export function isPrivateKey(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** A string made safe for use as a file name (letters, digits, _ and - kept, everything else becomes _). */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Parsed JSON from a file, or `dflt` when the file does not exist. */
export function readJson<T>(path: string, dflt: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : dflt;
}

/** Writes pretty JSON, creating the folder first. */
export function writeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
}
