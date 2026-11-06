import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./hash.js";
import { sha256HexPure } from "./sha256.js";
import { keyId, lockFrame, newRecipientKey, newRunKey, runContext, unlockFrame, unwrapRunKey, wrapRunKey } from "./seal.js";
import { RobotKeys } from "./runKeys.js";

const ROBOT = "0x1111111111111111111111111111111111111111";

describe("plain-TS sha256 (browser) equals node:crypto", () => {
  it("for empty, block-boundary, multi-block and UTF-8 input", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
      const b = new Uint8Array(randomBytes(n));
      expect(sha256HexPure(b)).toBe(sha256Hex(b));
    }
    expect(sha256HexPure("Pearl ✓ ロボット")).toBe(sha256Hex("Pearl ✓ ロボット"));
  });
});

describe("run keys: owner → insurer handover", () => {
  it("the robot locks a run key for the owner; the owner re-locks it for the insurer; only they can open it", async () => {
    const owner = await newRecipientKey();
    const insurer = await newRecipientKey();
    const stranger = await newRecipientKey();
    const runKey = newRunKey();
    const ctx = runContext(ROBOT, "ep_1");

    const forOwner = await wrapRunKey(runKey, owner.publicJwk, ctx);
    expect(forOwner.kid).toBe(owner.kid);
    const k1 = await unwrapRunKey(forOwner, owner.privateJwk, ctx);
    expect(Buffer.from(k1).equals(Buffer.from(runKey))).toBe(true);

    const forInsurer = await wrapRunKey(k1, insurer.publicJwk, ctx); // in the owner's browser, at claim time
    const k2 = await unwrapRunKey(forInsurer, insurer.privateJwk, ctx);
    expect(Buffer.from(k2).equals(Buffer.from(runKey))).toBe(true);

    await expect(unwrapRunKey(forInsurer, stranger.privateJwk, ctx)).rejects.toThrow(/different key/);
    await expect(unwrapRunKey(forInsurer, insurer.privateJwk, runContext(ROBOT, "ep_2"))).rejects.toThrow(/different robot or run/);
    // a wrap moved to another run's context cannot be opened either (the context is bound into the key derivation)
    await expect(unwrapRunKey({ ...forInsurer, context: runContext(ROBOT, "ep_2") }, insurer.privateJwk, runContext(ROBOT, "ep_2"))).rejects.toThrow(/cannot unlock/);
  });

  it("the wrapped key and the locked frame reveal nothing readable", async () => {
    const owner = await newRecipientKey();
    const runKey = newRunKey();
    const w = await wrapRunKey(runKey, owner.publicJwk, runContext(ROBOT, "ep_1"));
    expect(JSON.stringify(w)).not.toContain(Buffer.from(runKey).toString("base64"));
    const jpeg = new TextEncoder().encode("JPEG-BYTES-with-a-face");
    const locked = await lockFrame(runKey, jpeg);
    expect(Buffer.from(locked).includes(Buffer.from("with-a-face"))).toBe(false);
    expect(new TextDecoder().decode(await unlockFrame(runKey, locked))).toBe("JPEG-BYTES-with-a-face");
    await expect(unlockFrame(newRunKey(), locked)).rejects.toThrow(/cannot unlock/);
  });

  it("the robot keeps each run key and locks it for whoever is the linked owner now", async () => {
    const keys = new RobotKeys("sim-x", false);
    const k = keys.createRunKey("ep_9");
    expect(await keys.wrapForOwner(ROBOT, "ep_9")).toBeNull(); // no owner yet
    const first = await newRecipientKey();
    keys.setOwner("a".repeat(32), first.publicJwk);
    const w1 = (await keys.wrapForOwner(ROBOT, "ep_9"))!;
    expect(Buffer.from(await unwrapRunKey(w1, first.privateJwk, runContext(ROBOT, "ep_9"))).equals(Buffer.from(k))).toBe(true);
    // the owner lost their key and linked again with a new one: past runs open with the new key
    const second = await newRecipientKey();
    keys.setOwner("a".repeat(32), second.publicJwk);
    const w2 = (await keys.wrapForOwner(ROBOT, "ep_9"))!;
    expect(w2.kid).toBe(keyId(second.publicJwk));
    expect(Buffer.from(await unwrapRunKey(w2, second.privateJwk, runContext(ROBOT, "ep_9"))).equals(Buffer.from(k))).toBe(true);
    await expect(unwrapRunKey(w2, first.privateJwk, runContext(ROBOT, "ep_9"))).rejects.toThrow();
  });
});
