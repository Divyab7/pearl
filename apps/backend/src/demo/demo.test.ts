import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboard } from "../dashboard/server.js";
import { contentChecks } from "../verify/content.js";
import { loadArmConfig } from "../shared/armConfig.js";
import type { EpisodeLog } from "../orchestrator/log.js";
import { openEpisode, parseSealed, runContext, unwrapRunKey, wrapRunKey, newRunKey, type WrappedKey } from "../shared/seal.js";
import { mountDemo, type DemoInstance } from "./mount.js";
import { DEMO_ACTIONS_OFF } from "./world.js";

process.env.CLAIMS_ARKIV = "off";
process.env.VERIFY_WARMUP = "off";

// the "real" instance: its own temp files and a robot that is offline (no network anywhere)
const realDir = mkdtempSync(join(tmpdir(), "pearl-demo-test-real-"));
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;
const real = createDashboard({
  fetchImpl: offline, accountsFile: join(realDir, "a.json"), claimsFile: join(realDir, "c.json"), insurerKeyFile: join(realDir, "k.json"),
  claimLedgerFile: join(realDir, "l.json"), relayDir: join(realDir, "relay"), relayBundlesDir: join(realDir, "b"),
  insurerAddress: "0x000000000000000000000000000000000000dEaD", readPool: async () => ({ address: "0x0", balanceWei: "0", maxPayoutWei: "0", paid: [] }),
});

let base = "";
let close = () => {};
let demo: DemoInstance;
beforeAll(async () => {
  demo = await mountDemo(real.app);
  const s = real.app.listen(0);
  await new Promise((r) => s.once("listening", r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => s.close();
}, 30_000);
afterAll(() => close());

const enter = async (role: string) => {
  const r = await fetch(`${base}/demo-api/demo/enter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
  const setCookie = r.headers.get("set-cookie") ?? "";
  return { status: r.status, body: (await r.json()) as Record<string, any>, setCookie, cookie: setCookie.split(";")[0]! };
};
const get = (path: string, cookie = "") => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, body: unknown, cookie = "") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

describe("demo workspace at /demo-api", () => {
  it("info", async () => {
    expect(await (await get("/demo-api/demo/info")).json()).toEqual({ available: true, label: "Demo data", resetsOn: "server restart" });
  });

  it("owner: sample runs, own claims, and the key record unlocks a sample run", async () => {
    const e = await enter("owner");
    expect(e.status).toBe(200);
    expect(e.setCookie).toMatch(/^pearl_demo_session=/);
    expect(e.setCookie).toMatch(/Path=\/demo-api/);
    expect(e.setCookie).toMatch(/HttpOnly/);
    const kr = e.body.owner.keyRecord;
    expect(e.body).toMatchObject({ role: "owner", label: "Demo data", owner: { accountId: demo.world.accountId } });
    expect(kr).toMatchObject({ type: "pearl-unlock-key", v: 1, role: "owner", who: demo.world.accountId });
    expect(kr.privateJwk.d).toBeTruthy();

    const eps = (await (await get("/demo-api/episodes", e.cookie)).json()) as { items: { episodeId: string; kind: string; severity: number; outcome: string }[] };
    expect(eps.items).toHaveLength(5);
    expect(eps.items.some((x) => x.kind === "incident" && x.severity === 3)).toBe(true);

    const claims = (await (await get("/demo-api/claims", e.cookie)).json()) as { status: string }[];
    expect(claims.map((c) => c.status).sort()).toEqual(["INSURER_REVIEW", "PAID"]);

    const id = eps.items.find((x) => x.kind === "episode" && x.outcome === "DONE")!.episodeId;
    const w = (await (await get(`/demo-api/episodes/${id}/key`, e.cookie)).json()) as WrappedKey;
    const runKey = await unwrapRunKey(w, kr.privateJwk, runContext(demo.world.device.address, id));
    const sealed = parseSealed(JSON.stringify(await (await get(`/demo-api/episodes/${id}`)).json()));
    const log = await openEpisode<{ episodeId: string; records: unknown[] }>(sealed, runKey);
    expect(log.episodeId).toBe(id);
    expect(log.records.length).toBeGreaterThan(0);

    const v = (await (await get(`/demo-api/verify/${id}`)).json()) as { result: string };
    expect(v.result).toBe("VALID");
    // every sample run's contents pass the same checks the insurer's browser runs after unlocking (6–9)
    for (const it of eps.items) {
      const wk = (await (await get(`/demo-api/episodes/${it.episodeId}/key`, e.cookie)).json()) as WrappedKey;
      const rk = await unwrapRunKey(wk, kr.privateJwk, runContext(demo.world.device.address, it.episodeId));
      const sl = parseSealed(JSON.stringify(await (await get(`/demo-api/episodes/${it.episodeId}`)).json()));
      const lg = await openEpisode<EpisodeLog>(sl, rk);
      const pv = (await (await get(`/demo-api/verify/${it.episodeId}`)).json()) as { anchor?: { requestIdsHash?: string } | null };
      const failed = contentChecks(lg, { headerHead: sl.headHash, anchoredRequestIdsHash: pv.anchor?.requestIdsHash ?? null, arm: loadArmConfig() }).filter((c) => c.status === "FAIL");
      expect(failed.map((c) => `${it.episodeId}: ${c.name} — ${c.detail}`)).toEqual([]);
    }
    // the run whose 0G Storage upload failed is shown honestly
    const failed = eps.items.find((x) => x.outcome === "FAILSAFE")!.episodeId;
    expect(((await (await get(`/demo-api/verify/${failed}`)).json()) as { result: string }).result).toBe("REJECTED");
  });

  it("robot: state and stream work; actions are refused with the demo message", async () => {
    const st = (await (await get("/demo-api/state")).json()) as { deviceAddress: string; orchestrator: { phase: string } };
    expect(st.deviceAddress).toBe(demo.world.device.address);
    const ac = new AbortController();
    const s = await fetch(`${base}/demo-api/stream`, { signal: ac.signal });
    expect(s.headers.get("content-type")).toMatch(/event-stream/);
    const first = await s.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("demo robot");
    ac.abort();
    const owner = await enter("owner");
    for (const p of ["/demo-api/episode/start", "/demo-api/control/stop", "/demo-api/sim/bump", "/demo-api/relay/bundle"]) {
      const r = await post(p, {}, owner.cookie);
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe(DEMO_ACTIONS_OFF);
    }
  });

  it("insurer: sees the waiting claim, approves it, the fake pool pays", async () => {
    const e = await enter("insurer");
    expect(e.setCookie).toMatch(/^pearl_demo_insurer=.*Path=\/demo-api/);
    expect(e.body.insurer.address).toBe(demo.world.insurerWallet.address);
    expect(e.body.insurer.keyRecord).toMatchObject({ type: "pearl-unlock-key", role: "insurer", who: demo.world.insurerWallet.address });
    const list = (await (await get("/demo-api/insurer/claims", e.cookie)).json()) as { claimId: string; status: string; episodeId: string; device: string; insurerKey: WrappedKey }[];
    const waiting = list.find((c) => c.status === "INSURER_REVIEW")!;
    expect(waiting).toBeTruthy();
    // the insurer's key record opens the incident key the owner shared
    await unwrapRunKey(waiting.insurerKey, e.body.insurer.keyRecord.privateJwk, runContext(waiting.device, waiting.episodeId));
    const before = (await (await get("/demo-api/pool")).json()) as { paid: unknown[] };
    const d = (await (await post(`/demo-api/insurer/claims/${waiting.claimId}/decision`, { approve: true, reason: "Matches the robot's record." }, e.cookie)).json()) as { status: string; payout: { txHash: string } };
    expect(d.status).toBe("PAID");
    expect(d.payout.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const after = (await (await get("/demo-api/pool")).json()) as { paid: unknown[] };
    expect(after.paid.length).toBe(before.paid.length + 1);
    const ark = (await (await get(`/demo-api/arkiv/claims?episodeId=${waiting.episodeId}`)).json()) as { items: { status: string }[] };
    expect(ark.items[0]!.status).toBe("PAID");
  });

  it("owner can file a new demo claim; it reaches the insurer on its own", async () => {
    const o = await enter("owner");
    const claimable = (await (await get("/demo-api/claimable", o.cookie)).json()) as { items: { episodeId: string; device: string; claimable: boolean }[] };
    const claimed = new Set(((await (await get("/demo-api/claims", o.cookie)).json()) as { episodeId: string }[]).map((c) => c.episodeId));
    const inc = claimable.items.find((x) => x.claimable && !claimed.has(x.episodeId))!;
    expect(inc).toBeTruthy();
    const ins = (await (await get("/demo-api/insurer")).json()) as { key: { publicJwk: never } };
    const share = await wrapRunKey(newRunKey(), ins.key.publicJwk, runContext(inc.device, inc.episodeId));
    const c = (await (await post("/demo-api/claims", { episodeId: inc.episodeId, insurerKey: share }, o.cookie)).json()) as { claimId: string };
    expect(c.claimId).toMatch(/^rc_/);
    let status = "";
    for (let i = 0; i < 40 && status !== "INSURER_REVIEW"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      status = ((await (await get(`/demo-api/claims/${c.claimId}`, o.cookie)).json()) as { status: string }).status;
    }
    expect(status).toBe("INSURER_REVIEW");
  }, 15_000);

  it("demo cookies do not reach the real /api, and exit clears them", async () => {
    const o = await enter("owner");
    const i = await enter("insurer");
    const both = `${o.cookie}; ${i.cookie}`;
    expect((await get("/api/account", both)).status).toBe(401);
    expect((await get("/api/insurer/claims", both)).status).toBe(401);
    // a real cookie name with a demo token is not accepted either
    expect((await get("/api/account", o.cookie.replace("pearl_demo_session", "pearl_session"))).status).toBe(401);
    expect((await get("/demo-api/account", both)).status).toBe(200);

    const x = await fetch(`${base}/demo-api/demo/exit`, { method: "POST", headers: { cookie: both } });
    const cleared = x.headers.getSetCookie();
    expect(cleared.some((c) => /^pearl_demo_session=;.*Path=\/demo-api/.test(c))).toBe(true);
    expect(cleared.some((c) => /^pearl_demo_insurer=;.*Path=\/demo-api/.test(c))).toBe(true);
    expect((await get("/demo-api/account", both)).status).toBe(401);
    expect((await get("/demo-api/insurer/claims", both)).status).toBe(401);
  });

  it("the demo files live in a temp dir, not data/", () => {
    expect(demo.world.dir.startsWith(tmpdir())).toBe(true);
    expect(JSON.stringify(demo.world.options)).not.toContain("/data/");
  });
});
