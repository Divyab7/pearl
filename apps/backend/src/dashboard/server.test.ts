import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { headMessage, linkMessage } from "../shared/deviceKey.js";
import { sha256Hex } from "../shared/hash.js";
import { keyId, newRecipientKey, newRunKey, openEpisode, runContext, sealEpisode, sealedBytes, unwrapRunKey, wrapRunKey, type PublicJwk, type SealedEpisode, type WrappedKey } from "../shared/seal.js";
import { createDashboard } from "./server.js";

/** A fake device program: answers the device routes the dashboard reads, serving only the LOCKED run. */
async function fakeDevice() {
  const wallet = ethers.Wallet.createRandom();
  const rec = new EpisodeRecorder("ep_dash_1", "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  rec.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: { secret: "kitchen-camera-note" } });
  const log = rec.close("ABORTED");
  log.device = { address: wallet.address, signature: await wallet.signMessage(headMessage(log.episodeId, log.headHash)) };
  const runKey = newRunKey();
  const sealed = await sealEpisode(log, runKey, { incident: false, severity: 0, origin: null });
  const bytes = sealedBytes(sealed);
  const root = `0x${sha256Hex(bytes)}`;
  const meta = { episodeId: log.episodeId, storage: { status: "ok", rootHash: root, txHash: "0xtx", txSeq: 1, url: "u", ms: 1 } };
  const anchor = { headHash: log.headHash, rootHash: root, requestIdsHash: "0x", anchoredAt: 1_762_380_000, outcome: 1, severity: 0, incident: false };
  let ownerKey: PublicJwk | null = null;
  const posts: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST" && path === "/api/link") {
      const b = JSON.parse(String(init.body)) as { accountId: string; nonce: string; ownerKey: PublicJwk };
      ownerKey = b.ownerKey;
      const kid = keyId(b.ownerKey);
      return Response.json({ address: wallet.address, deviceId: "sim-arm-01", ownerKid: kid, signature: await wallet.signMessage(linkMessage(b.accountId, b.nonce, kid)) });
    }
    if (init?.method === "POST") {
      posts.push(path);
      return Response.json({ ok: true, via: "device" });
    }
    if (path === "/api/state") return Response.json({ deviceAddress: wallet.address, deviceKind: "sim" });
    if (path === "/api/episodes") return Response.json({ source: "device", items: [{ episodeId: log.episodeId, locked: true, kind: "episode", severity: 0, device: wallet.address }] });
    if (path === `/api/episodes/${log.episodeId}`) return Response.json(sealed);
    if (path === `/api/episodes/${log.episodeId}/meta`) return Response.json(meta);
    if (path === `/api/episodes/${log.episodeId}/key`) {
      if (!ownerKey) return Response.json({ error: "no owner" }, { status: 409 });
      return Response.json(await wrapRunKey(runKey, ownerKey, runContext(wallet.address, log.episodeId)));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const verifyDeps = {
    anchorOn: true, anchorAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", zerobotOn: false,
    readAnchor: async () => anchor, downloadStorage: async () => bytes, rootOf: async (b: Uint8Array) => `0x${sha256Hex(b)}`,
  };
  return { wallet, log, sealed, f, posts, verifyDeps };
}

async function serve(app: ReturnType<typeof createDashboard>["app"]) {
  const s = app.listen(0);
  await new Promise((r) => s.once("listening", r));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

describe("dashboard server (rev 5)", () => {
  it("passes operator requests to the device and lists episodes from the device when Arkiv is off", async () => {
    process.env.INDEX_ARKIV = "off";
    const d = await fakeDevice();
    const { app } = createDashboard({ deviceUrl: "http://device.test", fetchImpl: d.f });
    const s = await serve(app);
    const start = await (await fetch(`${s.base}/api/episode/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    expect(start).toMatchObject({ via: "device" });
    await fetch(`${s.base}/api/control/safe`, { method: "POST" });
    expect(d.posts).toEqual(["/api/episode/start", "/api/control/safe"]);
    const list = await (await fetch(`${s.base}/api/episodes`)).json();
    expect(list).toMatchObject({ source: "device", note: "INDEX_ARKIV=off" });
    s.close();
  });

  it("checks a locked run publicly, never returns its readable content, and Edit 1 byte is REJECTED", async () => {
    const d = await fakeDevice();
    const { app } = createDashboard({ deviceUrl: "http://device.test", fetchImpl: d.f, verifyDeps: d.verifyDeps });
    const s = await serve(app);
    const r = await fetch(`${s.base}/api/verify/${d.log.episodeId}`);
    const text = await r.text();
    const v = JSON.parse(text);
    expect(v.result).toBe("VALID");
    expect(v.checks.map((c: { status: string }) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "SKIPPED"]);
    expect(text).not.toContain("kitchen-camera-note");
    const t = await (await fetch(`${s.base}/api/verify/${d.log.episodeId}/tamper`, { method: "POST" })).json();
    expect(t).toMatchObject({ result: "REJECTED", tampered: expect.stringMatching(/locked data/) });
    expect((await fetch(`${s.base}/api/verify/not-a-run`)).status).toBe(400);
    s.close();
  });

  it("sign in with World ID (Agent Pass), set a wallet, link the robot with the device's own signature", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.ACCOUNTS_FILE = join(mkdtempSync(join(tmpdir(), "pearl-acc-")), "a.json");
    const d = await fakeDevice();
    const gate = {
      provider: "World ID",
      cancel: () => true,
      verify: async (_r: unknown, onPrompt: (p: never) => void) => {
        onPrompt({ attemptId: "att-1", provider: "World ID", verificationUri: "https://world.example", userCode: "WXYZ", expiresAt: "t" } as never);
        return { ok: true, attemptId: "att-1", provider: "World ID", issuer: "https://auth.world.org", subject: "sub-1", acr: null, amr: ["pop"], authTime: 1, idTokenSha256: "h" } as never;
      },
    };
    const { app } = createDashboard({ deviceUrl: "http://device.test", fetchImpl: d.f, agentPass: gate as never });
    const s = await serve(app);
    expect((await fetch(`${s.base}/api/account`)).status).toBe(401);
    const start = await (await fetch(`${s.base}/api/auth/start`, { method: "POST" })).json();
    expect(start).toMatchObject({ userCode: "WXYZ" });
    await new Promise((r) => setTimeout(r, 20));
    const st = await fetch(`${s.base}/api/auth/status/att-1`);
    const body = await st.json();
    expect(body).toMatchObject({ status: "ok", account: { subject: "sub-1" } });
    const cookie = st.headers.get("set-cookie")!.split(";")[0]!;
    const H = { cookie, "content-type": "application/json" };
    expect((await fetch(`${s.base}/api/account/wallet`, { method: "POST", headers: H, body: JSON.stringify({ address: "nope" }) })).status).toBe(400);
    const w = ethers.Wallet.createRandom().address;
    expect(await (await fetch(`${s.base}/api/account/wallet`, { method: "POST", headers: H, body: JSON.stringify({ address: w }) })).json()).toMatchObject({ wallet: w });
    const noKey = await fetch(`${s.base}/api/robots/link`, { method: "POST", headers: H });
    expect(noKey.status).toBe(409);
    expect((await noKey.json()).error).toMatch(/unlock key/);
    // the owner's browser creates the key; only the public half reaches the server
    const owner = await newRecipientKey();
    const acc = await (await fetch(`${s.base}/api/account/key`, { method: "POST", headers: H, body: JSON.stringify({ publicJwk: owner.publicJwk }) })).json();
    expect(acc.key).toMatchObject({ kid: owner.kid });
    expect(JSON.stringify(acc)).not.toContain(owner.privateJwk.d);
    const linked = await (await fetch(`${s.base}/api/robots/link`, { method: "POST", headers: H })).json();
    expect(linked.robots[0]).toMatchObject({ address: d.wallet.address, deviceId: "sim-arm-01", ownerKid: owner.kid });
    // the robot locks this run's key for the owner; the owner's browser unlocks the run
    const wrapped = (await (await fetch(`${s.base}/api/episodes/${d.log.episodeId}/key`, { headers: H })).json()) as WrappedKey;
    const runKey = await unwrapRunKey(wrapped, owner.privateJwk, runContext(d.wallet.address, d.log.episodeId));
    const sealed = (await (await fetch(`${s.base}/api/episodes/${d.log.episodeId}`)).json()) as SealedEpisode;
    const plain = await openEpisode<typeof d.log>(sealed, runKey);
    expect(plain.headHash).toBe(d.log.headHash);
    expect((await fetch(`${s.base}/api/episodes/${d.log.episodeId}/key`)).status).toBe(401); // signed-out: no key
    s.close();
  });

  it("a robot link not signed by the device is refused", async () => {
    const { AccountStore } = await import("./accounts.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new AccountStore(join(mkdtempSync(join(tmpdir(), "pearl-acc-")), "a.json"));
    const acc = store.upsertFromIdentity("https://auth.world.org", "sub-2");
    const device = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const sig = await impostor.signMessage(linkMessage(acc.accountId, "ab".repeat(16), "k1"));
    expect(() => store.linkRobot(acc.accountId, { address: device.address, deviceId: "x", deviceUrl: "u", linkSignature: sig, ownerKid: "k1" }, "ab".repeat(16))).toThrow(/did not sign/);
    // a real device signature for another owner key does not link this one
    const real = await device.signMessage(linkMessage(acc.accountId, "ab".repeat(16), "k1"));
    expect(() => store.linkRobot(acc.accountId, { address: device.address, deviceId: "x", deviceUrl: "u", linkSignature: real, ownerKid: "k2" }, "ab".repeat(16))).toThrow(/did not sign/);
  });

  it("insurer: wallet sign-in (one-time message), receiving key, review queue; strangers are refused", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pearl-ins-"));
    process.env.INSURER_KEY_FILE = join(dir, "k.json");
    process.env.REWARD_CLAIMS_FILE = join(dir, "c.json");
    const insurer = ethers.Wallet.createRandom();
    process.env.INSURER_ADDRESS = insurer.address;
    const d = await fakeDevice();
    const { app } = createDashboard({ deviceUrl: "http://device.test", fetchImpl: d.f });
    const s = await serve(app);
    expect(await (await fetch(`${s.base}/api/insurer`)).json()).toMatchObject({ configured: true, address: insurer.address, signedIn: false, key: null });
    expect((await fetch(`${s.base}/api/insurer/claims`)).status).toBe(401);
    const json = { "content-type": "application/json" };
    // a stranger's signature is refused
    const ch1 = await (await fetch(`${s.base}/api/insurer/challenge`, { method: "POST" })).json();
    expect(ch1.message).toMatch(/moves no funds/);
    const bad = await fetch(`${s.base}/api/insurer/signin`, { method: "POST", headers: json, body: JSON.stringify({ nonce: ch1.nonce, signature: await ethers.Wallet.createRandom().signMessage(ch1.message) }) });
    expect(bad.status).toBe(403);
    // the challenge is single-use
    const reuse = await fetch(`${s.base}/api/insurer/signin`, { method: "POST", headers: json, body: JSON.stringify({ nonce: ch1.nonce, signature: await insurer.signMessage(ch1.message) }) });
    expect(reuse.status).toBe(400);
    const ch2 = await (await fetch(`${s.base}/api/insurer/challenge`, { method: "POST" })).json();
    const ok = await fetch(`${s.base}/api/insurer/signin`, { method: "POST", headers: json, body: JSON.stringify({ nonce: ch2.nonce, signature: await insurer.signMessage(ch2.message) }) });
    expect(ok.status).toBe(200);
    const H = { ...json, cookie: ok.headers.get("set-cookie")!.split(";")[0]! };
    const k = await newRecipientKey();
    expect(await (await fetch(`${s.base}/api/insurer/key`, { method: "POST", headers: H, body: JSON.stringify({ publicJwk: k.publicJwk }) })).json()).toMatchObject({ kid: k.kid });
    expect(await (await fetch(`${s.base}/api/insurer`)).json()).toMatchObject({ key: { kid: k.kid } }); // public: owners lock for it
    expect(await (await fetch(`${s.base}/api/insurer/claims`, { headers: H })).json()).toEqual([]);
    const dec = await fetch(`${s.base}/api/insurer/claims/rc_x/decision`, { method: "POST", headers: H, body: JSON.stringify({ approve: true, reason: "ok" }) });
    expect(dec.status).toBe(409);
    delete process.env.INSURER_ADDRESS;
    s.close();
  });
});
