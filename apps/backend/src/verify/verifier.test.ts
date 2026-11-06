import { describe, expect, it } from "vitest";
import { loadArmConfig } from "../shared/armConfig.js";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { policyPlan } from "../orchestrator/policy.js";
import { Poses } from "../orchestrator/poses.js";
import type { DecisionCore } from "../orchestrator/decision.js";
import { hashCanonical } from "../shared/hash.js";
import { editedSealedCopy, verifyPublic, type PublicVerifyDeps } from "./verifier.js";
import { contentChecks, tamperedCopy } from "./content.js";
import { newRunKey, openEpisode, sealEpisode, sealedBytes, type SealedEpisode } from "../shared/seal.js";
import { sha256Hex } from "../shared/hash.js";
import type { EpisodeLog } from "../shared/types.js";
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

const ANCHOR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ROOT = `0x${"ab".repeat(32)}`;
/** Stand-in for the 0G Storage root: sha256 of the exact bytes (the real one is a Merkle root; same property). */
const rootOf = async (b: Uint8Array) => `0x${sha256Hex(b)}`;

async function sealedRun(log: EpisodeLog) {
  const key = newRunKey();
  const sealed = await sealEpisode(log, key, { incident: false, severity: 0, origin: null });
  const bytes = sealedBytes(sealed);
  const root = await rootOf(bytes);
  const anchor = {
    headHash: log.headHash, rootHash: root, requestIdsHash: requestIdsHash(["rid-1"]), anchoredAt: 1_762_380_000,
    outcome: OUTCOME_CODE[log.outcome], severity: 0, incident: false,
  };
  const deps: PublicVerifyDeps = {
    device: DEVICE.address, anchorOn: true, anchorAddress: ANCHOR, rootOf, zerobotOn: false,
    readAnchor: async () => anchor, downloadStorage: async (r) => (r === root ? bytes : Promise.reject(new Error("no such root"))),
  };
  return { key, sealed, bytes, root, anchor, deps };
}

describe("public check (no key)", () => {
  const ABORT = { action: "ABORT", slot: null, reason: "no red cube at A2", confidence: 0.9 };

  it("VALID when the anchor, the locked file on 0G Storage, its header and the robot's signature agree", async () => {
    const log = await signed(buildLog(ABORT));
    const { deps, root } = await sealedRun(log);
    const v = await verifyPublic(log.episodeId, deps);
    expect(v.result).toBe("VALID");
    expect(v.rootHash).toBe(root);
    expect(v.source).toBe("0g-storage");
    expect(v.checks.map((c) => [c.id, c.status])).toEqual([[1, "PASS"], [2, "PASS"], [3, "PASS"], [4, "PASS"], [5, "SKIPPED"]]);
  });

  it("the locked file never contains the readable log", async () => {
    const log = await signed(buildLog(ABORT));
    const { bytes } = await sealedRun(log);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("no red cube");
    expect(text).not.toContain("glm-5.3-flash");
    expect(text).toContain(log.headHash); // the public fingerprint stays readable
  });

  it("Edit 1 byte of the locked file → its root changes → REJECTED", async () => {
    const log = await signed(buildLog(ABORT));
    const { deps, sealed } = await sealedRun(log);
    const v = await verifyPublic(log.episodeId, { ...deps, editedCopy: editedSealedCopy(sealed) });
    expect(v.result).toBe("REJECTED");
    expect(v.checks.find((c) => c.id === 2)).toMatchObject({ status: "FAIL" });
    expect(v.tampered).toMatch(/locked data/);
  });

  it("a header that disagrees with the anchor, a wrong robot or a missing anchor fails", async () => {
    const log = await signed(buildLog(ABORT));
    const { deps, anchor } = await sealedRun(log);
    const sev = await verifyPublic(log.episodeId, { ...deps, readAnchor: async () => ({ ...anchor, severity: 3, incident: true }) });
    expect(sev.checks.find((c) => c.id === 3)).toMatchObject({ status: "FAIL" });
    const other = await verifyPublic(log.episodeId, { ...deps, device: ethers.Wallet.createRandom().address });
    expect(other.checks.find((c) => c.id === 4)).toMatchObject({ status: "FAIL" });
    const none = await verifyPublic(log.episodeId, { ...deps, readAnchor: async () => null });
    expect(none.checks.find((c) => c.id === 1)).toMatchObject({ status: "FAIL" });
    expect(none.result).toBe("REJECTED");
  });

  it("no storage root is a FAIL, never a skip; anchor off is a SKIP; the robot's copy is labelled", async () => {
    const log = await signed(buildLog(ABORT));
    const { deps, sealed } = await sealedRun(log);
    const v = await verifyPublic(log.episodeId, { ...deps, anchorOn: false, robotCopy: async () => sealed });
    expect(v.checks.find((c) => c.id === 1)).toMatchObject({ status: "SKIPPED" });
    expect(v.checks.find((c) => c.id === 2)).toMatchObject({ status: "FAIL" });
    expect(v.source).toBe("robot");
    expect(v.result).toBe("REJECTED");
  });

  it("a forged signature in the header fails check 4 even though the file is stored", async () => {
    const log = await signed(buildLog(ABORT));
    const forged = { ...log, device: { address: DEVICE.address, signature: await ethers.Wallet.createRandom().signMessage(headMessage(log.episodeId, log.headHash)) } };
    const { deps } = await sealedRun(forged);
    const v = await verifyPublic(log.episodeId, deps);
    expect(v.checks.find((c) => c.id === 4)).toMatchObject({ status: "FAIL" });
  });
});

describe("full check (key holder's browser)", () => {
  const ABORT = { action: "ABORT", slot: null, reason: "no red cube at A2", confidence: 0.9 };
  const unlock = async (sealed: SealedEpisode, key: Uint8Array) => openEpisode<EpisodeLog>(sealed, key);

  it("unlocks with the run key and every content check passes", async () => {
    const log = await signed(buildLog(ABORT));
    const { sealed, key, anchor } = await sealedRun(log);
    const plain = await unlock(sealed, key);
    const cs = contentChecks(plain, { headerHead: sealed.headHash, anchoredRequestIdsHash: anchor.requestIdsHash, arm });
    expect(cs.map((c) => [c.id, c.status])).toEqual([[6, "PASS"], [7, "PASS"], [8, "PASS"], [9, "PASS"]]);
  });

  it("a wrong key or an edited header cannot unlock", async () => {
    const log = await signed(buildLog(ABORT));
    const { sealed, key } = await sealedRun(log);
    expect((await unlock(sealed, key)).episodeId).toBe(log.episodeId); // the right key and header work
    await expect(unlock(sealed, newRunKey())).rejects.toThrow(/cannot unlock/);
    await expect(unlock({ ...sealed, severity: 3 }, key)).rejects.toThrow(/cannot unlock/); // header is bound to the data
  });

  it("Edit 1 byte of the unlocked log → the chain no longer reaches the signed head", async () => {
    const log = await signed(buildLog(ABORT));
    const { sealed, key, anchor } = await sealedRun(log);
    const { copy } = tamperedCopy(await unlock(sealed, key));
    const cs = contentChecks(copy, { headerHead: sealed.headHash, anchoredRequestIdsHash: anchor.requestIdsHash, arm });
    expect(cs.find((c) => c.id === 6)).toMatchObject({ status: "FAIL" });
  });

  it("a command that does not follow from the decision fails policy replay", async () => {
    const log = buildLog({ action: "PICK", slot: "A2", reason: "red cube at A2", confidence: 0.9 });
    const d = log.records[1] as { commandsSent: string[] };
    d.commandsSent = ["move:[90,100,80,10]"];
    const cs = contentChecks(log, { headerHead: log.headHash, anchoredRequestIdsHash: null, arm });
    expect(cs.find((c) => c.id === 9)).toMatchObject({ status: "FAIL" });
    expect(cs.find((c) => c.id === 7)).toMatchObject({ status: "SKIPPED" });
  });

  it("a failsafe record carrying a model is a provenance failure", () => {
    const log = buildLog(ABORT, "failsafe");
    (log.records[1] as { model: string | null }).model = "fake-model";
    const cs = contentChecks(log, { headerHead: log.headHash, anchoredRequestIdsHash: null, arm });
    expect(cs.find((c) => c.id === 8)).toMatchObject({ status: "FAIL" });
  });
});
