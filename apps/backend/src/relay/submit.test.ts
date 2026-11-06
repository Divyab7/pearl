import { describe, expect, it } from "vitest";
import { buildBundle } from "./bundle.js";
import { FakeNet, FAKE_URLS } from "./fakeNet.js";
import { submitBundle, type Step, type SubmitDeps } from "./submit.js";
import { ANCHOR, newWallet, primedCache, sampleInput } from "./testkit.js";

const depsOf = (net: FakeNet, over: Partial<SubmitDeps> = {}): SubmitDeps => ({
  rpc: net.rpc, rpcUrl: net.rpcUrl, storageNodes: net.storageNodes, sleep: async () => {}, pollMs: 0, receiptTimeoutMs: 50, storageTimeoutMs: 50, ...over,
});

describe("relay submit (spec §2)", async () => {
  const w = newWallet();
  const { bundle } = await buildBundle(w, sampleInput(), primedCache(w.address));

  it("submits every tx in order, reads txSeq, uploads segments, records the Arkiv entity", async () => {
    const net = new FakeNet();
    const seen: string[] = [];
    const r = await submitBundle(bundle, depsOf(net), { onStep: (_s, st) => seen.push(st) });
    expect(r.state).toBe("done");
    expect(r.steps.map((s) => [s.purpose, s.status])).toEqual([
      ["storage:log", "ok"], ["storage:frame:3", "ok"], ["anchor", "ok"], ["arkiv", "ok"],
    ]);
    expect(r.steps[0]).toMatchObject({ txSeq: 1000, finalized: true, txHash: bundle.txs[0]!.hash });
    expect(r.steps[1]).toMatchObject({ txSeq: 1001, finalized: true });
    expect(r.steps[3]!.entityKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(net.files.get(bundle.files[0]!.root.toLowerCase())?.finalized).toBe(true);
    expect(net.files.get(bundle.files[1]!.root.toLowerCase())?.finalized).toBe(true);
    expect(net.nonceOf("0g-galileo", w.address)).toBe(3);
    expect(net.nonceOf("arkiv-rabdi", w.address)).toBe(1);
    expect(seen.at(-1)).toBe("done");
    // a second carrier (or a restart) re-running the same bundle: "already known" / already uploaded → still done
    const again = await submitBundle(bundle, depsOf(net));
    expect(again.state).toBe("done");
    expect(net.nonceOf("0g-galileo", w.address)).toBe(3);
  });

  it("keeps polling when the node answers a receipt lookup with an error (0G RPC quirk seen live)", async () => {
    const net = new FakeNet();
    let flaky = 3;
    const rpc: SubmitDeps["rpc"] = async (url, method, params) => {
      if (method === "eth_getTransactionReceipt" && flaky-- > 0) throw new Error("no matching receipts found: this may indicate potential data corruption");
      return net.rpc(url, method, params);
    };
    const r = await submitBundle(bundle, depsOf(net, { rpc }));
    expect(r.state).toBe("done");
  });

  it("resumes from recorded steps without re-sending finished txs", async () => {
    const net = new FakeNet();
    const first = await submitBundle(bundle, depsOf(net));
    const sends = net.calls.filter((c) => c.method === "eth_sendRawTransaction").length;
    const r = await submitBundle(bundle, depsOf(net), { steps: first.steps });
    expect(r.state).toBe("done");
    expect(net.calls.filter((c) => c.method === "eth_sendRawTransaction").length).toBe(sends);
  });

  it("stale: the nonce was used by a different tx", async () => {
    const net = new FakeNet();
    net.burnNonce("0g-galileo", w.address);
    const r = await submitBundle(bundle, depsOf(net));
    expect(r.state).toBe("stale");
    expect(r.steps[0]).toMatchObject({ status: "stale" });
    expect(r.steps[0]!.error).toMatch(/re-sign/);
    expect(r.steps.slice(1).every((s: Step) => s.status === "pending")).toBe(true);
  });

  it("failed: a reverted tx stops the bundle with the reason", async () => {
    const net = new FakeNet();
    net.revertTo.add(ANCHOR.toLowerCase());
    const r = await submitBundle(bundle, depsOf(net));
    expect(r.state).toBe("failed");
    expect(r.steps[2]).toMatchObject({ purpose: "anchor", status: "failed" });
    expect(r.steps[2]!.error).toMatch(/reverted/);
    expect(r.steps[3]!.status).toBe("pending");
  });

  it("failed: node error (e.g. insufficient funds) is reported, not retried as success", async () => {
    const net = new FakeNet();
    net.failNext["0g-galileo"] = "insufficient funds for gas * price + value";
    const r = await submitBundle(bundle, depsOf(net));
    expect(r.state).toBe("failed");
    expect(r.steps[0]!.error).toMatch(/insufficient funds/);
  });

  it("already-known answer from the node counts as sent", async () => {
    const net = new FakeNet();
    net.failNext["arkiv-rabdi"] = "already known";
    // the fake rejects without mining, so pre-mine the Arkiv tx as another carrier would have
    await net.rpc(FAKE_URLS["arkiv-rabdi"], "eth_sendRawTransaction", [bundle.txs[3]!.raw]).catch(() => {});
    await net.rpc(FAKE_URLS["arkiv-rabdi"], "eth_sendRawTransaction", [bundle.txs[3]!.raw]);
    const r = await submitBundle(bundle, depsOf(net));
    expect(r.state).toBe("done");
  });

  it("no storage nodes: the storage step fails after its tx is in", async () => {
    const net = new FakeNet();
    const r = await submitBundle(bundle, depsOf(net, { storageNodes: async () => [] }));
    expect(r.state).toBe("failed");
    expect(r.steps[0]).toMatchObject({ status: "failed", txSeq: 1000 });
    expect(r.steps[0]!.error).toMatch(/no 0G Storage node/);
  });
});
