import { describe, expect, it } from "vitest";
import { loadArmConfig } from "../shared/armConfig.js";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { episodeBytes } from "../orchestrator/pipeline.js";
import { policyPlan } from "../orchestrator/policy.js";
import { Poses } from "../orchestrator/poses.js";
import type { EpisodeMeta } from "../orchestrator/meta.js";
import type { DecisionCore } from "../orchestrator/decision.js";
import { hashCanonical } from "../shared/hash.js";
import { tamperedCopy, verifyEpisode } from "./verifier.js";
import { OUTCOME_CODE, requestIdsHash } from "../og/anchor.js";
import { ethers } from "ethers";
import { headMessage } from "../shared/deviceKey.js";

const DEVICE = ethers.Wallet.createRandom();
async function signed<T extends { episodeId: string; headHash: string; device?: unknown }>(log: T): Promise<T> {
  log.device = { address: DEVICE.address, signature: await DEVICE.signMessage(headMessage(log.episodeId, log.headHash)) };
  return log;
}

const arm = loadArmConfig();
const task = { task: "pick" as const, color: "red", from: "A2" as const, to: "BIN" as const };

function decision(parsed: unknown, source: "0g" | "failsafe"): DecisionCore {
  return {
    checkpoint: "PLAN", source, model: source === "0g" ? "glm-5.3-flash" : null, requestId: source === "0g" ? "rid-1" : null,
    httpRequestId: null, clientRequestId: "c", clientRequestIdEchoed: true, provider: null, providerIdentity: null,
    teeVerified: true, cost: null, zgResKey: null, reasoning: null, raw: source === "0g" ? JSON.stringify(parsed) : null,
    parsed: source === "0g" ? parsed : null, error: source === "0g" ? null : "timeout", latencyMs: 5,
  };
}

function buildLog(parsed: unknown, source: "0g" | "failsafe" = "0g") {
  const rec = new EpisodeRecorder("ep_v_1", "sim", "arm-1", task);
  rec.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: { armConfigHash: hashCanonical(arm) } });
  const d = decision(parsed, source);
  const p = policyPlan(d, task, new Poses(arm));
  rec.addDecision({
    ...d, ts: "2026-11-05T21:00:01.000Z", promptHash: "a".repeat(64), frameHash: null, frameRoot: null,
    telemetry: { state: "WAITING", joints: [90, 90, 90, 10], tofMm: 600, accG: 1 },
    policy: p.policy, override: p.override, commandsSent: p.steps.map((s) => (s.kind === "safe" ? "safe" : "x")),
  });
  return rec.close(source === "0g" ? "ABORTED" : "FAILSAFE");
}

const okMeta = (log: ReturnType<typeof buildLog>): EpisodeMeta => ({
  episodeId: log.episodeId,
  storage: { status: "ok", rootHash: "0xroot", txHash: "0xtx", txSeq: 1, url: "u", ms: 1 },
});

describe("verifier", () => {
  const PICK_OTHER = { action: "ABORT", slot: null, reason: "no red cube at A2", confidence: 0.9 };

  it("VALID when the chain, the anchor, storage, provenance, policy and device signature all agree", async () => {
    const log = await signed(buildLog(PICK_OTHER));
    const bytes = episodeBytes(log);
    const v = await verifyEpisode(log, okMeta(log), {
      arm,
      downloadStorage: async () => bytes,
      anchorOn: true, anchorAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      readAnchor: async (dev: string) => (dev === DEVICE.address ? { headHash: log.headHash, rootHash: "0xroot", requestIdsHash: requestIdsHash(["rid-1"]), anchoredAt: 1, outcome: OUTCOME_CODE[log.outcome], severity: 0, incident: false } : null),
    });
    expect(v.result).toBe("VALID");
    expect(v.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "SKIPPED", "SKIPPED", "PASS"]);
  });

  it("Edit log: one changed byte → REJECTED on chain, anchor, storage and device signature", async () => {
    const log = await signed(buildLog(PICK_OTHER));
    const bytes = episodeBytes(log);
    const { copy, where } = tamperedCopy(log);
    expect(where).toMatch(/parsed\.reason/);
    const v = await verifyEpisode(copy, okMeta(log), {
      arm,
      downloadStorage: async () => bytes,
      anchorOn: true, anchorAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      readAnchor: async (dev: string) => (dev === DEVICE.address ? { headHash: log.headHash, rootHash: "0xroot", requestIdsHash: requestIdsHash(["rid-1"]), anchoredAt: 1, outcome: OUTCOME_CODE[log.outcome], severity: 0, incident: false } : null),
    });
    expect(v.result).toBe("REJECTED");
    expect(v.failed).toEqual([1, 2, 3, 8]);
  });

  it("no storage root is a FAIL, never a skip; anchor off is a SKIP", async () => {
    const log = buildLog(PICK_OTHER, "failsafe");
    const v = await verifyEpisode(log, { episodeId: log.episodeId, storage: { status: "not_configured", missing: "OG_STORAGE_PRIVATE_KEY" } }, {
      arm, anchorOn: false,
    });
    expect(v.result).toBe("REJECTED");
    expect(v.checks.find((c) => c.id === 3)).toMatchObject({ status: "FAIL" });
    expect(v.checks.find((c) => c.id === 2)).toMatchObject({ status: "SKIPPED", detail: "OG_CHAIN_ANCHOR=off" });
  });

  it("a command that does not follow from the decision fails policy replay", async () => {
    const log = buildLog(PICK_OTHER);
    const d = log.records[1] as { commandsSent: string[] };
    d.commandsSent = ["move:[90,100,80,10]"]; // forged (chain will also break; check 5 must fail on its own)
    const v = await verifyEpisode(log, okMeta(log), { arm, anchorOn: false, downloadStorage: async () => new Uint8Array() });
    expect(v.checks.find((c) => c.id === 5)).toMatchObject({ status: "FAIL" });
  });

  it("a failsafe record carrying a model is a provenance failure", async () => {
    const log = buildLog(PICK_OTHER, "failsafe");
    (log.records[1] as { model: string | null }).model = "fake-model";
    const v = await verifyEpisode(log, okMeta(log), { arm, anchorOn: false, downloadStorage: async () => episodeBytes(log) });
    expect(v.checks.find((c) => c.id === 4)).toMatchObject({ status: "FAIL" });
  });

  it("device signature: a signed log passes check 8; a wrong device or an edited head fails", async () => {
    const { ethers } = await import("ethers");
    const { headMessage } = await import("../shared/deviceKey.js");
    const log = buildLog({ action: "ABORT", slot: null, reason: "no red cube at A2", confidence: 0.9 });
    const dev = ethers.Wallet.createRandom();
    log.device = { address: dev.address, signature: await dev.signMessage(headMessage(log.episodeId, log.headHash)) };
    const meta = okMeta(log);
    const bytes = episodeBytes(log);
    const base = { arm, anchorOn: false, downloadStorage: async () => bytes };
    const ok = await verifyEpisode(log, meta, { ...base, expectedDevice: dev.address });
    expect(ok.checks.find((c) => c.id === 8)).toMatchObject({ status: "PASS" });
    const other = await verifyEpisode(log, meta, { ...base, expectedDevice: ethers.Wallet.createRandom().address });
    expect(other.checks.find((c) => c.id === 8)).toMatchObject({ status: "FAIL" });
    const { copy } = tamperedCopy(log);
    const edited = await verifyEpisode(copy, meta, base);
    expect(edited.checks.find((c) => c.id === 8)).toMatchObject({ status: "FAIL" });
    const unsigned = await verifyEpisode({ ...log, device: undefined }, meta, { ...base, requireDeviceSignature: true });
    expect(unsigned.checks.find((c) => c.id === 8)).toMatchObject({ status: "FAIL" });
  });
});
