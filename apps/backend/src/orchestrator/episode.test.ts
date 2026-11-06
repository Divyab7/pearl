/**
 * End-to-end episodes against the simulated arm. The 0G HTTP call is mocked here only (prompt hard rule 3); everything
 * else (state machine, policy, hash chain) is the real code. A fast arm config keeps the runs short.
 */
import { describe, expect, it } from "vitest";
import { DeviceMonitor } from "../device/monitor.js";
import { Heartbeat } from "../device/heartbeat.js";
import { SimArm } from "../device/SimArm.js";
import { loadArmConfig, parseArmConfig } from "../shared/armConfig.js";
import type { ChainedRecord, DecisionRecord } from "../shared/types.js";
import { Orchestrator } from "./episode.js";
import { verifyChain } from "./log.js";
import { localRoot } from "../og/storage.js";
import { sha256Hex } from "../shared/hash.js";
import { replayPolicy } from "../verify/content.js";

const arm = parseArmConfig({ ...loadArmConfig(), maxDegPerS: 360, handClearMs: 300 });
const task = { task: "pick" as const, color: "red", from: "A2" as const, to: "BIN" as const };

type Answers = Partial<Record<string, unknown[]>>;

/** Fake Router: answers by checkpoint, in order, with documented response fields. */
function fakeRouter(answers: Answers, onCall?: (cp: string) => void): typeof fetch {
  let n = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const cp = JSON.parse(body.messages[1].content[0].text).checkpoint as string;
    onCall?.(cp);
    const next = answers[cp]?.shift();
    if (next === undefined) throw new TypeError("fetch failed");
    const rid = `rid-${++n}-${cp}`;
    return new Response(
      JSON.stringify({
        model: "test-model",
        choices: [{ message: { content: JSON.stringify(next) } }],
        x_0g_trace: { request_id: rid, provider: "0xprov" },
        tee_verified: true,
      }),
      { status: 200, headers: { "x-request-id": rid } },
    );
  }) as typeof fetch;
}

async function setup(fetchImpl: typeof fetch, camera: { kind: "none" | "http" | "file"; capture: (cp: string) => Promise<{ dataUrl: string; bytes: Uint8Array } | null> } = { kind: "none", capture: async () => null }) {
  const sim = new SimArm(arm, { deviceId: "sim-test", tickMs: 10 });
  const monitor = new DeviceMonitor(sim);
  const hb = new Heartbeat(sim, arm.heartbeatIntervalMs);
  const orch = new Orchestrator({
    device: sim, monitor, arm, camera,
    armId: "arm-1", deviceId: "sim-test", writeFiles: false, fetchImpl,
    scene: () => sim.scene.snapshot(),
    routerConfig: () => ({
      baseUrl: "https://router.test/v1", apiKey: "sk-test", model: "test-model", trustMode: "verified",
      timeoutMs: 2000, verifyTee: true, maxTokens: 500,
    }),
  });
  await sim.connect();
  hb.start();
  await new Promise((r) => setTimeout(r, 50));
  return { sim, monitor, hb, orch, teardown: async () => { hb.stop(); await sim.close(); } };
}

const decisions = (rs: readonly ChainedRecord[]) => rs.filter((r): r is ChainedRecord & DecisionRecord => r.kind === "decision");
const evs = (rs: readonly ChainedRecord[]) => rs.filter((r) => r.kind === "event").map((r) => (r as { ev: string }).ev);

const PICK = { action: "PICK", slot: "A2", reason: "red cube visible at A2", confidence: 0.93 };
const GRASPED = { action: "CONTINUE", grasped: true, reason: "cube in claw", confidence: 0.9 };
const PLACED = { action: "DONE", placed: true, reason: "cube in bin", confidence: 0.9 };

describe("episode orchestrator (sim)", () => {
  it("normal episode: PLAN → VERIFY_GRASP → VERIFY_PLACE → DONE, red cube ends in the bin", async () => {
    const t = await setup(fakeRouter({ PLAN: [PICK], VERIFY_GRASP: [GRASPED], VERIFY_PLACE: [PLACED] }));
    const log = await t.orch.start(task).done;
    await t.teardown();
    expect(log.outcome).toBe("DONE");
    const ds = decisions(log.records);
    expect(ds.map((r) => r.checkpoint)).toEqual(["PLAN", "VERIFY_GRASP", "VERIFY_PLACE"]);
    expect(ds.every((r) => r.source === "0g" && r.requestId?.startsWith("rid-"))).toBe(true);
    expect(ds[0]!.commandsSent[0]).toBe("move:[90,100,80,10]");
    expect(t.sim.scene.snapshot().bin).toEqual(["red"]);
    expect(verifyChain(log).ok).toBe(true);
    expect(replayPolicy(log, arm)).toEqual(["PASS", expect.any(String)]);
  }, 30_000);

  it("0G unreachable: PLAN is a failsafe record and the arm goes to the SAFE pose", async () => {
    const t = await setup(fakeRouter({}));
    const log = await t.orch.start(task).done;
    const joints = t.sim.joints();
    await t.teardown();
    expect(log.outcome).toBe("FAILSAFE");
    const [plan] = decisions(log.records);
    expect(plan).toMatchObject({ source: "failsafe", model: null, parsed: null, raw: null, commandsSent: ["safe"] });
    expect(plan!.error).toMatch(/network error/);
    expect(joints).toEqual(arm.safe);
    expect(t.sim.scene.snapshot().slots.A2).toBe("red"); // nothing moved toward the cube
    expect(replayPolicy(log, arm)[0]).toBe("PASS");
  }, 30_000);

  it("hand in zone while carrying: freeze → INCIDENT (after clear) → RESUME → DONE", async () => {
    let injected = false;
    let sim: SimArm | null = null;
    const t = await setup(
      fakeRouter(
        {
          PLAN: [PICK], VERIFY_GRASP: [GRASPED], VERIFY_PLACE: [PLACED],
          INCIDENT: [{ action: "RESUME", severity: 0, file_claim: false, reason: "zone clear", confidence: 0.9 }],
        },
        (cp) => {
          if (cp === "VERIFY_GRASP" && !injected) {
            injected = true;
            // hand appears shortly after the carry starts
            setTimeout(() => sim!.injectHand(250), 150);
          }
        },
      ),
    );
    sim = t.sim;
    const log = await t.orch.start(task).done;
    await t.teardown();
    expect(log.outcome).toBe("DONE");
    expect(evs(log.records)).toEqual(expect.arrayContaining(["hand_in_zone", "hand_clear"]));
    const inc = decisions(log.records).find((r) => r.checkpoint === "INCIDENT")!;
    expect(inc.source).toBe("0g");
    expect(inc.commandsSent[0]).toBe("resume");
    expect(t.sim.scene.snapshot().bin).toEqual(["red"]);
    expect(verifyChain(log).ok).toBe(true);
    expect(replayPolicy(log, arm)).toEqual(["PASS", expect.any(String)]);
  }, 30_000);

  it("bump: TRIPPED, 0G RESUME is overridden, a claim is requested, the arm does not move", async () => {
    let sim: SimArm | null = null;
    const t = await setup(
      fakeRouter(
        {
          PLAN: [PICK],
          INCIDENT: [{ action: "RESUME", severity: 2, file_claim: true, reason: "minor knock", confidence: 0.9 }],
        },
        (cp) => {
          if (cp === "PLAN") setTimeout(() => sim!.injectBump(), 120);
        },
      ),
    );
    sim = t.sim;
    const log = await t.orch.start(task).done;
    const after = t.sim.joints();
    await new Promise((r) => setTimeout(r, 300));
    const later = t.sim.joints();
    await t.teardown();
    expect(log.outcome).toBe("TRIPPED");
    const inc = decisions(log.records).find((r) => r.checkpoint === "INCIDENT")!;
    expect(inc.override).toBe("hard trip: operator reset required");
    expect(inc.commandsSent).toEqual([]);
    expect(evs(log.records)).toEqual(expect.arrayContaining(["trip_bump", "claim_requested"]));
    expect(later).toEqual(after);
    expect(t.sim.getState()).toBe("TRIPPED");
    expect(replayPolicy(log, arm)[0]).toBe("PASS");
  }, 30_000);

  it("with a camera: each decision records the frame hash and its 0G Storage root; a dead camera is a failsafe", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    let calls = 0;
    const cam = { kind: "file" as const, capture: async () => {
      calls++;
      if (calls === 2) throw new Error("camera offline");
      return { bytes: jpeg, dataUrl: "data:image/jpeg;base64,AAAA" };
    } };
    let sentImage = false;
    const router = fakeRouter({ PLAN: [PICK] });
    const spy = (async (u: unknown, init?: RequestInit) => {
      sentImage ||= String(init?.body).includes('"image_url"');
      return router(u as string, init);
    }) as typeof fetch;
    const t = await setup(spy, cam);
    const log = await t.orch.start(task).done;
    await t.teardown();
    const [plan, grasp] = decisions(log.records);
    expect(sentImage).toBe(true);
    // the record keeps the hash of the JPEG and the 0G Storage root of the LOCKED frame (never of the readable JPEG)
    expect(plan).toMatchObject({ source: "0g", frameHash: sha256Hex(jpeg), frameRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect((plan as { frameRoot: string }).frameRoot).not.toBe(await localRoot(jpeg));
    expect(grasp).toMatchObject({ source: "failsafe", frameHash: null, error: "camera: camera offline" });
    expect(log.outcome).toBe("FAILSAFE");
  }, 30_000);
});

