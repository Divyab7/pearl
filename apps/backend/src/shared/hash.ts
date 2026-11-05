// https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";

/** 64 zeros: the prevHash of the first record in every episode. */
export const ZERO_HASH = "0".repeat(64);

/** sha256 over UTF-8 bytes (strings) or raw bytes, lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return h.digest("hex");
}

/** sha256 of the canonical JSON form of a value. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function isHex64(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}
