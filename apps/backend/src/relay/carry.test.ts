import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { buildBundle, type Bundle } from "./bundle.js";
import { CarryStore, bundleSize, CARRY_LIMITS } from "./carry.js";
import { newWallet, primedCache, sampleInput } from "./testkit.js";

const T0 = Date.parse("2026-11-06T09:00:00.000Z");

async function make(w: ethers.Wallet, n: number, o: { severity: number; incident: boolean; minutes: number; size?: number }): Promise<Bundle> {
  const { bundle } = await buildBundle(
    w,
    sampleInput({
      episodeId: `ep_20261106090000_c${n}`, severity: o.severity, incident: o.incident, outcome: o.incident ? "TRIPPED" : "DONE",
      frames: [], log: new Uint8Array(o.size ?? 2000).fill(n), arkivSalt: BigInt(n),
    }),
    primedCache(w.address, { g: n * 10, a: n }),
    new Date(T0 + o.minutes * 60_000),
  );
  return bundle;
}

describe("carry store (spec §7)", async () => {
  const me = newWallet();
  const x = newWallet();
  const y = newWallet();
  const xIncident3 = await make(x, 1, { severity: 3, incident: true, minutes: 10 });
  const xDone = await make(x, 2, { severity: 0, incident: false, minutes: 1 });
  const xIncident1 = await make(x, 3, { severity: 1, incident: true, minutes: 5 });
  const yDoneOld = await make(y, 4, { severity: 0, incident: false, minutes: 0 });
  const mine = await make(me, 5, { severity: 3, incident: true, minutes: 0 });
  let clock = T0 + 3600_000;
  const now = () => clock;

  it("accepts only valid bundles, dedupes, never carries its own", async () => {
    const s = new CarryStore(me.address, now);
    const bad = JSON.parse(JSON.stringify(xDone)) as Bundle;
    bad.summary.severity = 3;
    expect(await s.offer(bad, 0)).toMatchObject({ accepted: false, reason: "invalid" });
    expect(await s.offer(mine, 0)).toMatchObject({ accepted: false, reason: "own" });
    expect(await s.offer(xDone, 0)).toMatchObject({ accepted: true });
    expect(await s.offer(xDone, 3)).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(s.get((await s.toSubmit())[0]!.bundleId)?.hops).toBe(1);
  });

  it("serves incidents first (severity desc), then oldest first", async () => {
    const s = new CarryStore(me.address, now);
    for (const b of [xDone, yDoneOld, xIncident1, xIncident3]) expect((await s.offer(b, 0)).accepted).toBe(true);
    expect(s.serveList().map((i) => i.episodeId)).toEqual([xIncident3, xIncident1, yDoneOld, xDone].map((b) => b.episodeId));
    expect(s.serveList().every((i) => i.own === false && i.hops === 1)).toBe(true);
  });

  it("TTL 7 days from createdAt and max 8 hops", async () => {
    const s = new CarryStore(me.address, now);
    expect(await s.offer(xDone, 7)).toMatchObject({ accepted: true }); // arrives with 8 hops: kept, not forwarded
    expect(s.serveList()).toHaveLength(0);
    expect(await s.offer(yDoneOld, 8)).toMatchObject({ accepted: false, reason: "hops" });
    clock = T0 + CARRY_LIMITS.ttlMs + 20 * 60_000;
    expect(s.expire()).toHaveLength(1);
    expect(await s.offer(xIncident3, 0)).toMatchObject({ accepted: false, reason: "expired" });
    clock = T0 + 3600_000;
  });

  it("per-origin cap: a lower-priority bundle is refused, a higher one evicts", async () => {
    const one = bundleSize(xDone);
    const s = new CarryStore(me.address, now, { perOriginBytes: Math.ceil(one * 1.5) });
    expect((await s.offer(xDone, 0)).accepted).toBe(true);
    const r = await s.offer(xIncident3, 0);
    expect(r).toMatchObject({ accepted: true, evicted: [expect.any(String)] });
    expect(await s.offer(xDone, 0)).toMatchObject({ accepted: false, reason: "full" });
    expect((await s.offer(yDoneOld, 0)).accepted).toBe(true); // another origin has its own budget
    expect(s.bytes(x.address)).toBeLessThanOrEqual(Math.ceil(one * 1.5));
  });

  it("total cap: evicts the lowest-priority bundle of any origin", async () => {
    const one = bundleSize(xDone);
    const s = new CarryStore(me.address, now, { totalBytes: Math.ceil(one * 2.5) });
    expect((await s.offer(xDone, 0)).accepted).toBe(true);
    expect((await s.offer(yDoneOld, 0)).accepted).toBe(true);
    const r = await s.offer(xIncident3, 0);
    expect(r.accepted).toBe(true);
    // xDone (newer than yDoneOld) is the lowest priority
    expect(s.serveList().map((i) => i.episodeId)).toEqual([xIncident3.episodeId, yDoneOld.episodeId]);
    expect(s.bytes()).toBeLessThanOrEqual(Math.ceil(one * 2.5));
  });

  it("unverified ack stops forwarding but keeps the bundle; a verified delivery drops it and keeps a receipt", async () => {
    const s = new CarryStore(me.address, now);
    const r = await s.offer(xIncident3, 0);
    const id = r.bundleId!;
    expect(s.ackUnverified(id, "0xfake", 16602)).toBe(true);
    expect(s.serveList()).toHaveLength(0);
    expect(s.get(id)).toBeDefined();
    expect(s.toSubmit()).toHaveLength(1); // an online node still checks it
    s.clearAck(id);
    expect(s.serveList()).toHaveLength(1);
    s.markDelivered(id, "0xanchor", 16602);
    expect(s.get(id)).toBeUndefined();
    expect(s.receiptList()).toEqual([{ bundleId: id, anchorTx: "0xanchor", chainId: 16602, atMs: clock }]);
    expect(await s.offer(xIncident3, 0)).toMatchObject({ accepted: false, reason: "delivered" });
  });
});
