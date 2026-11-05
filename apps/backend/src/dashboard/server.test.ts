import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { episodeBytes } from "../orchestrator/pipeline.js";
import { headMessage } from "../shared/deviceKey.js";
import { createDashboard } from "./server.js";

/** A fake device program: answers the device routes the dashboard reads. */
async function fakeDevice() {
  const wallet = ethers.Wallet.createRandom();
  const rec = new EpisodeRecorder("ep_dash_1", "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  rec.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: {} });
  const log = rec.close("ABORTED");
  log.device = { address: wallet.address, signature: await wallet.signMessage(headMessage(log.episodeId, log.headHash)) };
  const meta = { episodeId: log.episodeId, storage: { status: "ok", rootHash: "0xroot", txHash: "0xtx", txSeq: 1, url: "u", ms: 1 } };
  const posts: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST" && path === "/api/link") {
      const b = JSON.parse(String(init.body)) as { accountId: string; nonce: string };
      const { linkMessage } = await import("../shared/deviceKey.js");
      return Response.json({ address: wallet.address, deviceId: "sim-arm-01", signature: await wallet.signMessage(linkMessage(b.accountId, b.nonce)) });
    }
    if (init?.method === "POST") {
      posts.push(path);
      return Response.json({ ok: true, via: "device" });
    }
    if (path === "/api/state") return Response.json({ deviceAddress: wallet.address, deviceKind: "sim" });
    if (path === "/api/episodes") return Response.json({ source: "device", items: [{ episodeId: log.episodeId }] });
    if (path === `/api/episodes/${log.episodeId}`) return Response.json(log);
    if (path === `/api/episodes/${log.episodeId}/meta`) return Response.json(meta);
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { wallet, log, f, posts };
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

  it("verifies a device-signed log against the device's address", async () => {
    const d = await fakeDevice();
    const { app } = createDashboard({
      deviceUrl: "http://device.test",
      fetchImpl: d.f,
      verifyDeps: { anchorOn: false, downloadStorage: async () => episodeBytes(d.log) },
    });
    const s = await serve(app);
    const v = await (await fetch(`${s.base}/api/verify/${d.log.episodeId}`)).json();
    expect(v.checks.find((c: { id: number }) => c.id === 8)).toMatchObject({ status: "PASS" });
    const t = await (await fetch(`${s.base}/api/verify/${d.log.episodeId}/tamper`, { method: "POST" })).json();
    expect(t.result).toBe("REJECTED");
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
    const linked = await (await fetch(`${s.base}/api/robots/link`, { method: "POST", headers: H })).json();
    expect(linked.robots[0]).toMatchObject({ address: d.wallet.address, deviceId: "sim-arm-01" });
    s.close();
  });

  it("a robot link not signed by the device is refused", async () => {
    const { AccountStore } = await import("./accounts.js");
    const { linkMessage } = await import("../shared/deviceKey.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new AccountStore(join(mkdtempSync(join(tmpdir(), "pearl-acc-")), "a.json"));
    const acc = store.upsertFromIdentity("https://auth.world.org", "sub-2");
    const device = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const sig = await impostor.signMessage(linkMessage(acc.accountId, "ab".repeat(16)));
    expect(() => store.linkRobot(acc.accountId, { address: device.address, deviceId: "x", deviceUrl: "u", linkSignature: sig }, "ab".repeat(16))).toThrow(/did not sign/);
  });
});
