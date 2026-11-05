import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts keys and removes whitespace", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively, including inside arrays", () => {
    const v = { z: { y: 1, x: [{ d: 1, c: 2 }] }, a: null };
    expect(canonicalize(v)).toBe('{"a":null,"z":{"x":[{"c":2,"d":1}],"y":1}}');
  });

  it("gives the same output regardless of insertion order", () => {
    const a = { one: 1, two: { b: true, a: "x" } };
    const b = { two: { a: "x", b: true }, one: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("keeps array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles unicode and escapes like JSON", () => {
    expect(canonicalize({ s: 'café 🤖 "q"\n' })).toBe('{"s":"café 🤖 \\"q\\"\\n"}');
  });

  it("orders unicode keys by UTF-16 code units", () => {
    expect(canonicalize({ "é": 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
  });

  it("omits undefined properties so it round-trips through a JSON file", () => {
    const v = { a: 1, b: undefined };
    expect(canonicalize(v)).toBe('{"a":1}');
    expect(canonicalize(JSON.parse(JSON.stringify(v)))).toBe(canonicalize(v));
  });

  it("rejects values with no unambiguous JSON form", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
    expect(() => canonicalize([1, undefined])).toThrow(/undefined in array at \[1\]/);
    expect(() => canonicalize({ b: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ d: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalize({ f: () => 1 })).toThrow(CanonicalJsonError);
  });

  it("reports the path of the bad value", () => {
    expect(() => canonicalize({ a: { b: [0, Number.NaN] } })).toThrow(/at a\.b\[1\]/);
  });
});
