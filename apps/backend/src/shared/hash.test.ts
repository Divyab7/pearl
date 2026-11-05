import { describe, expect, it } from "vitest";
import { ZERO_HASH, hashCanonical, isHex64, sha256Hex } from "./hash.js";

describe("hash", () => {
  it("matches the known sha256 test vector", () => {
    // FIPS 180-2 example: sha256("abc")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes strings as UTF-8", () => {
    expect(sha256Hex("é")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });

  it("hashCanonical ignores key order", () => {
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });

  it("ZERO_HASH is 64 zeros and a valid hex64", () => {
    expect(ZERO_HASH).toHaveLength(64);
    expect(isHex64(ZERO_HASH)).toBe(true);
    expect(isHex64(sha256Hex("x"))).toBe(true);
    expect(isHex64("ABC")).toBe(false);
  });
});
