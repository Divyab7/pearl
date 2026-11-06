/**
 * End to end, no network: robot offline → sealed bundle → laptop relay endpoint (real HTTP on localhost) → fake
 * chains/storage → done → robot outbox cleared and the run's meta shows "sent via relay". Plus the robot's own
 * flush on reconnect, stale re-signing, and the relay API's validation.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { readMeta } from "../orchestrator/meta.js";
import { publishEpisode } from "../orchestrator/pipeline.js";
import { headMessage } from "../shared/deviceKey.js";
import { newRunKey, sealEpisode } from "../shared/seal.js";
import { buildBundle } from "./bundle.js";
import { saveCache } from "./cache.js";
import { FakeNet } from "./fakeNet.js";
import { Outbox, RobotRelay } from "./robot.js";
import { submitBundle, type SubmitDeps } from "./submit.js";
import { ANCHOR, newWallet, primedCache, sampleInput } from "./testkit.js";
import { createDashboard } from "../dashboard/server.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `pearl-${p}-`));
process.env.CLAIMS_ARKIV = "off";
process.env.CLAIM_LEDGER_FILE = join(tmp("ledger"), "ledger.json");
process.env.EPISODES_DIR = tmp("episodes");
process.env.OG_ANCHOR_ADDRESS = ANCHOR;
process.env.OG_CHAIN_ANCHOR = "on";
process.env.INDEX_ARKIV = "on";

const fakeDeps = (net: FakeNet): SubmitDeps => ({
  rpc: net.rpc, rpcUrl: net.rpcUrl, storageNodes: net.storageNodes, sleep: async () => {}, pollMs: 0, receiptTimeoutMs: 50, storageTimeoutMs: 50,
});

async function closedRun(wallet: ethers.Wallet, id: string) {
  const rec = new EpisodeRecorder(id, "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  rec.addEvent({ ts: "2026-11-06T09:00:00.000Z", ev: "episode_start", data: {} });
  rec.addEvent({ ts: "2026-11-06T09:00:01.000Z", ev: "estop_tripped", data: {} });
  const log = rec.close("TRIPPED");
  log.device = { address: wallet.address, signature: await wallet.signMessage(headMessage(log.episodeId, log.headHash)) };
  const sealed = await sealEpisode(log, newRunKey(), { incident: true, severity: 2, origin: null });
  return { log, sealed };
}

describe("offline relay end to end", () => {
  const net = new FakeNet();
  let base = "";
  let close = () => {};
  let dash: ReturnType<typeof createDashboard>;

  beforeAll(async () => {
    dash = createDashboard({
      deviceUrl: "http://127.0.0.1:9", relayBundlesDir: tmp("relay-bundles"),
      relaySubmit: (b, steps, onStep) => submitBundle(b, fakeDeps(net), { steps, onStep }),
    });
    const s = dash.app.listen(0);
    await new Promise((r) => s.once("listening", r));
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    close = () => s.close();
  });
  afterAll(() => close());

  const robot = (wallet: ethers.Wallet, online: { v: boolean }, discover: () => Promise<string | null>) => {
    const cacheDir = tmp("presign");
    saveCache(primedCache(wallet.address, { g: net.nonceOf("0g-galileo", wallet.address), a: net.nonceOf("arkiv-rabdi", wallet.address) }), cacheDir);
    return new RobotRelay({
      wallet, online: async () => online.v, discover, rpc: net.rpc, submitDeps: fakeDeps(net), outbox: new Outbox(tmp("outbox")), cacheDir,
      pollMs: 5, pollTimeoutMs: 5000,
    });
  };

  it("robot offline → bundle → laptop relay → chains → done → outbox cleared, meta says sent via relay", async () => {
    const wallet = newWallet();
    const relay = robot(wallet, { v: false }, async () => `${base}/api/relay`);
    const { log, sealed } = await closedRun(wallet, "ep_20261106090000_e2e1");
    const metas: string[] = [];
    const m = await publishEpisode(log, sealed, (x) => metas.push(x.relay?.state ?? "-"), undefined, { devicePrivateKey: wallet.privateKey, relay });
    expect(m.relay).toMatchObject({ state: "queued", via: null });
    expect(m.storage).toBeUndefined(); // nothing direct was attempted
    await relay.deliver(); // waits behind the background delivery the pack started
    expect(relay.pending()).toBe(0);
    const meta = readMeta(log.episodeId);
    expect(meta.relay).toMatchObject({ state: "done", via: "laptop", relayUrl: `${base}/api/relay` });
    expect(meta.storage).toMatchObject({ status: "ok", txSeq: 1000 });
    expect(meta.anchor).toMatchObject({ status: "ok", address: ANCHOR });
    expect(meta.arkiv).toMatchObject({ status: "ok" });
    // on-chain: the ROBOT's nonces were used (its own signed txs), the relay paid nothing
    expect(net.nonceOf("0g-galileo", wallet.address)).toBe(2);
    expect(net.nonceOf("arkiv-rabdi", wallet.address)).toBe(1);
    // the relay's view
    const id = meta.relay!.bundleId;
    const st = (await (await fetch(`${base}/api/relay/bundles/${id}`)).json()) as { bundleId: string; state: string; steps: unknown[]; episodeId: string; device: string; updatedAt: string };
    expect(st).toMatchObject({ bundleId: id, state: "done", episodeId: log.episodeId, device: wallet.address });
    expect(st.steps).toHaveLength(3);
    const list = (await (await fetch(`${base}/api/relay/bundles`)).json()) as { items: { bundleId: string }[] };
    expect(list.items.some((i) => i.bundleId === id)).toBe(true);
  });

  it("no relay found: the bundle waits; on reconnect the robot flushes it itself, in order", async () => {
    const wallet = newWallet();
    const online = { v: false };
    const relay = robot(wallet, online, async () => null);
    const a = await closedRun(wallet, "ep_20261106090100_e2e2");
    const b = await closedRun(wallet, "ep_20261106090200_e2e3");
    await publishEpisode(a.log, a.sealed, () => {}, undefined, { devicePrivateKey: wallet.privateKey, relay });
    await publishEpisode(b.log, b.sealed, () => {}, undefined, { devicePrivateKey: wallet.privateKey, relay });
    await relay.deliver();
    expect(relay.pending()).toBe(2);
    expect(readMeta(a.log.episodeId).relay?.state).toBe("queued");
    online.v = true;
    await relay.flush();
    expect(relay.pending()).toBe(0);
    expect(readMeta(a.log.episodeId).relay).toMatchObject({ state: "done", via: "self" });
    expect(readMeta(b.log.episodeId).relay).toMatchObject({ state: "done", via: "self" });
    expect(net.nonceOf("0g-galileo", wallet.address)).toBe(4);
  });

  it("stale: another tx took the nonce → the robot re-signs with fresh nonces and delivers", async () => {
    const wallet = newWallet();
    const online = { v: false };
    const relay = robot(wallet, online, async () => null);
    const r = await closedRun(wallet, "ep_20261106090300_e2e4");
    await publishEpisode(r.log, r.sealed, () => {}, undefined, { devicePrivateKey: wallet.privateKey, relay });
    const before = readMeta(r.log.episodeId).relay!.bundleId;
    net.burnNonce("0g-galileo", wallet.address); // e.g. a direct tx from the same key elsewhere
    online.v = true;
    await relay.flush();
    const meta = readMeta(r.log.episodeId);
    expect(meta.relay).toMatchObject({ state: "done", via: "self" });
    expect(meta.relay!.bundleId).not.toBe(before);
    expect(net.nonceOf("0g-galileo", wallet.address)).toBe(3);
  });

  it("relay API: 400 on invalid bundles, 413 above 2 MB, idempotent by bundleId, 404 unknown", async () => {
    const w = newWallet();
    const post = (body: string) => fetch(`${base}/api/relay/bundle`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post("{not json")).status).toBe(400);
    const bad = await post(JSON.stringify({ v: 1, type: "pearl.bundle" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/episodeId/);
    expect((await post(JSON.stringify({ pad: "x".repeat(2_200_000) }))).status).toBe(413);
    // a 300 kB bundle passes the route's own limit (the global one is 64 kB)
    const { bundle } = await buildBundle(w, sampleInput({ frames: [{ idx: 1, bytes: new Uint8Array(200_000).fill(7) }], episodeId: "ep_20261106090400_e2e5" }), primedCache(w.address));
    const ok = await post(JSON.stringify(bundle));
    expect(ok.status).toBe(202);
    const okBody = (await ok.json()) as { bundleId: string; state: string };
    expect(okBody.state).toBe("received");
    const again = await post(JSON.stringify(bundle));
    expect(again.status).toBe(202);
    expect(((await again.json()) as { bundleId: string }).bundleId).toBe(okBody.bundleId);
    await dash.relayQueue.idle();
    const tampered = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    tampered.summary.severity = 0;
    expect((await post(JSON.stringify(tampered))).status).toBe(400);
    expect((await fetch(`${base}/api/relay/bundles/0x${"0".repeat(64)}`)).status).toBe(404);
  });

  it("GET /api/mesh/sim returns the demo shape; unknown scenarios are 400", async () => {
    const r = await fetch(`${base}/api/mesh/sim?scenario=tamperer&seed=2`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { nodes: unknown[]; events: { t: number; type: string }[]; bundles: { valid: boolean }[]; result: { delivered: number; total: number; refused: number } };
    expect(body.nodes).toHaveLength(3);
    expect(body.result.delivered).toBe(body.result.total);
    expect(body.result.refused).toBeGreaterThan(0);
    expect(body.bundles.some((b) => !b.valid)).toBe(true);
    expect((await fetch(`${base}/api/mesh/sim?scenario=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/mesh/sim?scenario=tamperer&seed=x`)).status).toBe(400);
  }, 60_000);
});
