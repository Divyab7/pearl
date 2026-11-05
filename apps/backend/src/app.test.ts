import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { SimArm } from "./device/SimArm.js";
import { loadArmConfig, parseArmConfig } from "./shared/armConfig.js";

describe("Cut 0G", () => {
  it("sends checkpoint calls to the blackhole URL and records an honest failsafe", async () => {
    process.env.OG_BLACKHOLE_URL = "http://10.255.255.1";
    process.env.OG_API_KEY = "sk-test";
    process.env.OG_MODEL = "test-model";
    const urls: string[] = [];
    const arm = parseArmConfig({ ...loadArmConfig(), maxDegPerS: 360 });
    const ctx = await createApp({
      arm,
      device: new SimArm(arm, { tickMs: 10 }),
      writeFiles: false,
      publish: false,
      // the blackhole never answers; simulate the network failure it causes, and record where the call went
      fetchImpl: (async (url: unknown) => {
        urls.push(String(url));
        throw new TypeError("fetch failed", { cause: new Error("connect ETIMEDOUT 10.255.255.1:80") });
      }) as typeof fetch,
    });
    await ctx.startDevice();
    ctx.setCut0g(true);
    const log = await ctx.orch.start({ task: "pick", color: "red", from: "A2", to: "BIN" }).done;
    const joints = ctx.sim!.joints();
    await ctx.stop();
    expect(urls).toEqual(["http://10.255.255.1/chat/completions"]);
    expect(log.outcome).toBe("FAILSAFE");
    const plan = log.records.find((r) => r.kind === "decision");
    expect(plan).toMatchObject({ source: "failsafe", model: null, parsed: null, commandsSent: ["safe"] });
    expect(joints).toEqual(arm.safe);
  }, 30_000);
});

describe("zerobot command → episode → receipt → verifier", () => {
  it("an on-chain RUN_EPISODE runs the arm, the receipt carries the head, and the receipt check holds (and catches a forged receipt)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fakeChain } = await import("./zerobot/testing.js");
    const { verifyEpisode } = await import("./verify/verifier.js");
    const { readMeta } = await import("./orchestrator/meta.js");
    process.env.EPISODES_DIR = mkdtempSync(join(tmpdir(), "pearl-zb-"));
    Object.assign(process.env, { INDEX_ARKIV: "off", OG_CHAIN_ANCHOR: "off", ROBOT_ZEROBOT: "on", CAMERA_SOURCE: "none" });
    process.env.OG_API_KEY = "sk-test";
    process.env.OG_MODEL = "test-model";
    const answers: Record<string, unknown> = {
      PLAN: { action: "PICK", slot: "A2", reason: "red at A2", confidence: 0.9 },
      VERIFY_GRASP: { action: "CONTINUE", grasped: true, reason: "held", confidence: 0.9 },
      VERIFY_PLACE: { action: "DONE", placed: true, reason: "in bin", confidence: 0.9 },
    };
    let n = 0;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const cp = JSON.parse(body.messages[1].content[0].text).checkpoint as string;
      const rid = `rid-${++n}`;
      return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: JSON.stringify(answers[cp]) } }], x_0g_trace: { request_id: rid } }), { headers: { "x-request-id": rid } });
    }) as typeof fetch;
    const chain = fakeChain();
    const arm = parseArmConfig({ ...loadArmConfig(), maxDegPerS: 360 });
    let closed: (l: import("./shared/types.js").EpisodeLog) => void;
    const episode = new Promise<import("./shared/types.js").EpisodeLog>((r) => (closed = r));
    const ctx = await createApp({ arm, device: new SimArm(arm, { tickMs: 10 }), zerobot: chain, fetchImpl, skipStorage: true, onEpisodeClosed: (l) => closed(l) });
    await ctx.startDevice();
    await new Promise((r) => setTimeout(r, 100));
    await chain.dispatch(1, JSON.stringify({ color: "red", from: "A2" }), "pick red A2");
    await ctx.zerobot!.poll();
    const log = await episode;
    for (let i = 0; i < 50 && !chain.receipts.has(0); i++) await new Promise((r) => setTimeout(r, 100));
    await ctx.stop();

    expect(log.outcome).toBe("DONE");
    const start = log.records.find((r) => r.kind === "event" && r.ev === "episode_start") as { data: { origin?: unknown } };
    expect(start.data.origin).toMatchObject({ kind: "zerobot", nonce: 0, robotId: chain.robotId });
    const rc = chain.receipts.get(0)!;
    expect(rc.success).toBe(true);
    expect(JSON.parse(rc.resultData)).toMatchObject({ episodeId: log.episodeId, headHash: log.headHash, outcome: "DONE" });
    expect(readMeta(log.episodeId).zerobot).toMatchObject({ status: "ok", nonce: 0, receiptTx: "0xreceipt0" });

    const deps = { arm, anchorOn: false, readZerobotReceipt: (k: number) => chain.receipt(k) };
    const v = await verifyEpisode(log, readMeta(log.episodeId), deps);
    expect(v.checks.find((c) => c.id === 7)).toMatchObject({ status: "PASS" });
    chain.receipts.set(0, { ...rc, resultData: rc.resultData.replace(log.headHash, "0".repeat(64)) });
    const v2 = await verifyEpisode(log, readMeta(log.episodeId), deps);
    expect(v2.checks.find((c) => c.id === 7)).toMatchObject({ status: "FAIL" });
    expect(v2.result).toBe("REJECTED");
  }, 30_000);
});
