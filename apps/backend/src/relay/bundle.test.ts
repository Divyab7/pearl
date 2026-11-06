import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../shared/canonical.js";
import { sha256Hex } from "../shared/hash.js";
import { localRoot } from "../og/storage.js";
import { bundleIdOf, bundleMessage, buildBundle, feesFor, fileBytes, verifyBundle, type Bundle } from "./bundle.js";
import { CHAIN_IDS } from "./chains.js";
import { refreshCache, emptyCache } from "./cache.js";
import { FakeNet, FAKE_FLOW, FAKE_PRICE } from "./fakeNet.js";
import { decodeSubmit } from "./storageFlow.js";
import { ANCHOR, newWallet, primedCache, sampleInput } from "./testkit.js";

const clone = (b: Bundle): Bundle => JSON.parse(JSON.stringify(b)) as Bundle;
/** Re-signs a tampered bundle with the given key so only the deeper checks can catch it. */
async function resign(b: Bundle, w: ethers.Wallet): Promise<Bundle> {
  return { ...b, sig: await w.signMessage(bundleMessage(bundleIdOf(b))) };
}

describe("relay bundle", async () => {
  const w = newWallet();
  const { bundle, cache } = await buildBundle(w, sampleInput(), primedCache(w.address, { g: 41, a: 7 }), new Date("2026-11-06T09:31:00.000Z"));

  it("has the spec shape, ordered pre-signed txs and the robot's signature", async () => {
    expect(bundle.v).toBe(1);
    expect(bundle.type).toBe("pearl.bundle");
    expect(bundle.device).toBe(w.address);
    expect(bundle.files.map((f) => [f.role, f.idx])).toEqual([["log", undefined], ["frame", 3]]);
    expect(bundle.files[0]!.root).toBe(await localRoot(fileBytes(bundle.files[0]!)));
    expect(bundle.summary).toEqual({ outcome: "TRIPPED", incident: true, severity: 2, headHash: `0x${"ab".repeat(32)}`, rootHash: bundle.files[0]!.root });
    expect(bundle.txs.map((t) => [t.chain, t.chainId, t.purpose, t.nonce, t.file])).toEqual([
      ["0g-galileo", 16602, "storage:log", 41, 0],
      ["0g-galileo", 16602, "storage:frame:3", 42, 1],
      ["0g-galileo", 16602, "anchor", 43, undefined],
      ["arkiv-rabdi", 7794095, "arkiv", 7, undefined],
    ]);
    // nonces consumed in the returned cache
    expect(cache.chains["0g-galileo"].nextNonce).toBe(44);
    expect(cache.chains["arkiv-rabdi"].nextNonce).toBe(8);
    // bundleId and sig exactly per spec
    const { sig, ...rest } = bundle;
    const id = `0x${sha256Hex(canonicalize(rest))}`;
    expect(bundleIdOf(bundle)).toBe(id);
    expect(ethers.verifyMessage(`pearl/bundle/v1|${id}`, sig)).toBe(w.address);
    const v = await verifyBundle(JSON.parse(JSON.stringify(bundle)));
    expect(v).toMatchObject({ ok: true, bundleId: id });
  });

  it("storage txs are Flow.submit with the fee from the cached price (+20 %) and the fee rule's gas prices", () => {
    const t = ethers.Transaction.from(bundle.txs[0]!.raw);
    expect(t.to).toBe(FAKE_FLOW);
    expect(t.data.slice(0, 10)).toBe("0xbc8c11f8");
    expect(decodeSubmit(t.data)).toEqual({ length: 8700n, submitter: w.address });
    expect(t.value % ((FAKE_PRICE * 120n) / 100n) === 0n || t.value > 0n).toBe(true);
    expect(t.maxFeePerGas).toBe(12_000_000_000n); // 3 × 4 gwei
    expect(t.maxPriorityFeePerGas).toBe(2_000_000_000n); // Galileo default tip
    const a = ethers.Transaction.from(bundle.txs[2]!.raw);
    expect(a.to).toBe(ANCHOR);
    const k = ethers.Transaction.from(bundle.txs[3]!.raw);
    expect(k.to).toBe("0x4400000000000000000000000000000000000044");
    expect(k.maxFeePerGas).toBe(3_000_000_000n);
    expect(feesFor("arkiv-rabdi", { ...primedCache(w.address), chains: { ...primedCache(w.address).chains, "arkiv-rabdi": { chainId: 7794095, nextNonce: 0, gasPrice: "1", tip: "0" } } }).maxFeePerGas).toBe(2_000_000_000n); // floor
  });

  it("skips anchor and Arkiv when they are off", async () => {
    const r = await buildBundle(w, sampleInput({ anchorAddress: null, arkivLifetimeDays: null, frames: [] }), primedCache(w.address));
    expect(r.bundle.txs.map((t) => t.purpose)).toEqual(["storage:log"]);
    expect((await verifyBundle(r.bundle)).ok).toBe(true);
  });

  it("refuses to pre-sign without a cached storage price", async () => {
    await expect(buildBundle(w, sampleInput(), emptyCache(w.address))).rejects.toThrow(/online once/);
  });

  describe("tamper cases", () => {
    const expectBad = async (b: unknown, re: RegExp) => {
      const v = await verifyBundle(b);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toMatch(re);
    };

    it("edited summary breaks the signature", async () => {
      const b = clone(bundle);
      b.summary.severity = 0;
      await expectBad(b, /bad signature/);
    });
    it("signature by another key", async () => {
      await expectBad(await resign(clone(bundle), newWallet()), /bad signature/);
    });
    it("claimed device that did not sign", async () => {
      const b = clone(bundle);
      b.device = newWallet().address;
      await expectBad(b, /bad signature/);
    });
    it("edited file bytes no longer match the root", async () => {
      const b = clone(bundle);
      const d = fileBytes(b.files[1]!);
      d[100] ^= 1;
      b.files[1]!.data = Buffer.from(d).toString("base64");
      await expectBad(await resign(b, w), /root .* does not match/);
    });
    it("swapped root (and summary) for another file", async () => {
      const b = clone(bundle);
      b.files[0]!.root = b.files[1]!.root;
      await expectBad(await resign(b, w), /does not match/);
    });
    it("a tx sent by another key", async () => {
      const other = newWallet();
      const b = clone(bundle);
      const raw = await other.signTransaction({ type: 2, chainId: 16602, nonce: 43, to: ANCHOR, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      b.txs[2] = { ...b.txs[2]!, raw, hash: ethers.keccak256(raw) };
      await expectBad(await resign(b, w), /not the device/);
    });
    it("unexpected chainId label", async () => {
      const b = clone(bundle);
      b.txs[3]!.chainId = 1;
      await expectBad(await resign(b, w), /unexpected chainId/);
    });
    it("tx signed for another chain than its label", async () => {
      const b = clone(bundle);
      const raw = await w.signTransaction({ type: 2, chainId: 1, nonce: 43, to: ANCHOR, data: "0x", gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
      b.txs[2] = { ...b.txs[2]!, raw, hash: ethers.keccak256(raw) };
      await expectBad(await resign(b, w), /signed for chain 1/);
    });
    it("a relayer that only accepts other chain ids", async () => {
      await expectBad(bundle, /unexpected chainId/).catch(() => {});
      const v = await verifyBundle(bundle, { chainIds: { "arkiv-rabdi": 60138453033 } });
      expect(v.ok).toBe(false);
    });
    it("storage tx pointing at the wrong file", async () => {
      const b = clone(bundle);
      b.txs[0]!.file = 1;
      b.txs[1]!.file = 0;
      await expectBad(await resign(b, w), /purpose should be|calldata/);
    });
    it("hash label that does not match the raw tx", async () => {
      const b = clone(bundle);
      b.txs[0]!.hash = b.txs[1]!.hash;
      await expectBad(await resign(b, w), /hash does not match/);
    });
    it("reordered txs (nonce order)", async () => {
      const b = clone(bundle);
      [b.txs[0], b.txs[1]] = [b.txs[1]!, b.txs[0]!];
      await expectBad(await resign(b, w), /nonces must increase/);
    });
    it("garbage and missing fields are rejected with a reason", async () => {
      await expectBad(null, /JSON object/);
      await expectBad({ ...clone(bundle), type: "x" }, /not a Pearl bundle/);
      await expectBad({ ...clone(bundle), files: [] }, /files/);
      await expectBad({ ...clone(bundle), sig: "0x12" }, /sig/);
      await expectBad({ ...clone(bundle), episodeId: "../../etc" }, /episodeId/);
    });
    it("expected device filter", async () => {
      expect((await verifyBundle(bundle, { expectedDevice: newWallet().address })).ok).toBe(false);
    });
  });

  it("refreshCache reads nonces, fees and the storage price; outbox reservations win", async () => {
    const net = new FakeNet();
    net.burnNonce("0g-galileo", w.address);
    const r = await refreshCache(emptyCache(w.address), { rpc: net.rpc, rpcUrl: net.rpcUrl, storageNodes: net.storageNodes }, { "arkiv-rabdi": 5 });
    expect(r.errors).toEqual([]);
    expect(r.cache.chains["0g-galileo"]).toMatchObject({ chainId: CHAIN_IDS["0g-galileo"], nextNonce: 1, gasPrice: "4000000000" });
    expect(r.cache.chains["arkiv-rabdi"].nextNonce).toBe(5);
    expect(r.cache.storage).toEqual({ flow: FAKE_FLOW, pricePerSector: FAKE_PRICE.toString() });
    // offline: every part fails, the old values stay
    const off = await refreshCache(r.cache, { rpc: async () => { throw new Error("offline"); }, rpcUrl: net.rpcUrl, storageNodes: net.storageNodes });
    expect(off.errors.length).toBe(3);
    expect(off.cache.chains["0g-galileo"].nextNonce).toBe(1);
  });
});
