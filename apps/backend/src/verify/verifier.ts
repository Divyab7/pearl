/**
 * Episode verifier (prompt §8.8, PLAN §4.4 S10). Result VALID only if every check that ran passed; a check whose module
 * is off or not configured is SKIPPED and says why. A SKIPPED check never counts as a pass for a module that is on:
 * storage is never optional (0G is the main track), so a missing storage root is a FAIL.
 *
 *  1 chain        every prevHash/recordHash and the headHash recompute
 *  2 anchor       the headHash in the device's 0G Chain EpisodeAnchor record equals the recomputed head
 *  3 storage      the copy downloaded from 0G Storage by root equals this copy byte-for-byte (canonical JSON)
 *  4 provenance   every source "0g" record has a requestId and a model; every failsafe has model/parsed/raw null
 *  5 policy       replaying the host policy over the recorded decisions reproduces every commandsSent; no RESUME after a
 *                 hard trip; no resume after a hand event without hand_clear
 *  6 frames       every frameHash matches its frame downloaded by frameRoot (SKIPPED when no frames were taken)
 *  7 zerobot      for an episode started by a zerobot command: the command's on-chain receipt carries this episode's
 *                 id and recomputed head, and its success flag matches the outcome (SKIPPED for local starts)
 *  8 device       the log head is signed by the device key (EIP-191); with expectedDevice, by that device
 */
import { canonicalize } from "../shared/canonical.js";
import { envFlag } from "../shared/env.js";
import { hashCanonical, sha256Hex } from "../shared/hash.js";
import type { ArmConfig } from "../shared/armConfig.js";
import { isHardTrip, type ChainedRecord, type DecisionRecord, type EpisodeLog } from "../shared/types.js";
import { downloadBytes, storageConfigFromEnv } from "../og/storage.js";
import { anchorConfigFromEnv, OUTCOME_CODE, readAnchor, requestIdsHash, type OnChainAnchor } from "../og/anchor.js";
import { ethers } from "ethers";
import type { DecisionCore } from "../orchestrator/decision.js";
import { requestIdsOf, verifyChain } from "../orchestrator/log.js";
import { headMessage, recoverDevice } from "../shared/deviceKey.js";
import type { EpisodeMeta } from "../orchestrator/meta.js";
import { episodeBytes, zerobotOriginOf } from "../orchestrator/pipeline.js";
import { commandsOf, policyPlan, policyVerifyGrasp, policyVerifyPlace } from "../orchestrator/policy.js";
import { Poses } from "../orchestrator/poses.js";
import { decodeResult, ethersZerobot, ZEROBOT_MISSING, zerobotConfigFromEnv, zerobotConfigured } from "../zerobot/zerobot.js";
import { errMsg } from "../shared/util.js";

export type CheckStatus = "PASS" | "FAIL" | "SKIPPED";
export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface VerifyResult {
  episodeId: string;
  result: "VALID" | "REJECTED";
  failed: number[];
  recomputedHead: string;
  checks: CheckResult[];
}

export interface VerifyDeps {
  arm: ArmConfig;
  /** Device-first logs must be signed by the device (FAIL instead of SKIPPED when the signature is missing). */
  requireDeviceSignature?: boolean;
  /** The device address this log must come from (e.g. the robot linked to the user's account). */
  expectedDevice?: string;
  /** R5 backup: a root the dashboard uploaded for a device-signed log whose own upload failed. */
  relayedRoot?: string | null;
  /** Override the networked lookups (tests, and the dashboard's Edit-log which reuses the real ones). */
  downloadStorage?: (rootHash: string) => Promise<Uint8Array>;
  anchorOn?: boolean;
  anchorAddress?: string;
  readAnchor?: (device: string, episodeId: string) => Promise<OnChainAnchor | null>;
  zerobotOn?: boolean;
  readZerobotReceipt?: (nonce: number) => Promise<{ success: boolean; resultData: string; txHash: string } | null>;
}

const decisionsOf = (rs: readonly ChainedRecord[]) =>
  rs.filter((r): r is ChainedRecord & DecisionRecord => r.kind === "decision");
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function verifyEpisode(log: EpisodeLog, meta: EpisodeMeta, deps: VerifyDeps): Promise<VerifyResult> {
  const checks: CheckResult[] = [];
  const add = (id: number, name: string, status: CheckStatus, detail: string) => checks.push({ id, name, status, detail });

  // 1 chain
  const chain = verifyChain(log);
  add(1, "Hash chain", chain.ok ? "PASS" : "FAIL",
    chain.ok ? `${log.records.length} records link; head ${chain.recomputedHead.slice(0, 12)}…`
      : `record ${chain.badIdx ?? "head"}: ${chain.reason}`);
  const head = chain.recomputedHead;

  // 2 0G Chain anchor
  const anchorOn = deps.anchorOn ?? envFlag("OG_CHAIN_ANCHOR", "on");
  const ac = anchorConfigFromEnv();
  const anchorAddr = deps.anchorAddress ?? ac.address;
  if (!anchorOn) add(2, "0G Chain anchor", "SKIPPED", "OG_CHAIN_ANCHOR=off");
  else if (!ethers.isAddress(anchorAddr)) add(2, "0G Chain anchor", "FAIL", "OG_CHAIN_ANCHOR=on but no contract address (pnpm anchor:deploy)");
  else if (!log.device) add(2, "0G Chain anchor", "FAIL", "log is not device-signed, so its device record cannot be located (rev 5 anchors are per device)");
  else {
    try {
      const read = deps.readAnchor ?? ((dev: string, id: string) => readAnchor({ rpcUrl: ac.rpcUrl, address: anchorAddr }, dev, id));
      const a = await read(log.device.address, log.episodeId);
      const reqs = requestIdsHash(requestIdsOf(log));
      if (!a) add(2, "0G Chain anchor", "FAIL", "episode not anchored in the contract");
      else if (a.headHash !== head) add(2, "0G Chain anchor", "FAIL", `on-chain head ${a.headHash.slice(0, 12)}… ≠ recomputed ${head.slice(0, 12)}…`);
      else if (a.requestIdsHash !== reqs) add(2, "0G Chain anchor", "FAIL", "request ids differ from the anchored set");
      else if (a.outcome !== OUTCOME_CODE[log.outcome]) add(2, "0G Chain anchor", "FAIL", "anchored outcome differs from the log");
      else add(2, "0G Chain anchor", "PASS", `device ${log.device.address.slice(0, 10)}… anchored this head and request ids`);
    } catch (err) {
      add(2, "0G Chain anchor", "FAIL", `contract read failed: ${errMsg(err)}`);
    }
  }

  // 3 storage
  const st = meta.storage;
  const ownRoot = st?.status === "ok" ? st.rootHash : null;
  const root = ownRoot ?? deps.relayedRoot ?? null;
  if (!root) {
    const why = !st ? "no upload recorded" : st.status === "failed" ? `upload failed: ${st.error}` : st.status === "not_configured" ? `not configured (${st.missing})` : "off";
    add(3, "0G Storage match", "FAIL", why);
  } else {
    try {
      const dl = deps.downloadStorage ?? ((r: string) => downloadBytes(storageConfigFromEnv(), r));
      const got = Buffer.from(await dl(root));
      const mine = Buffer.from(episodeBytes(log));
      const how = ownRoot ? "uploaded by the device" : "relayed by the dashboard (device-signed log)";
      add(3, "0G Storage match", got.equals(mine) ? "PASS" : "FAIL",
        got.equals(mine) ? `root ${root.slice(0, 14)}… ${how}, downloaded with proof, ${got.length} bytes identical`
          : `downloaded copy differs from this copy (${got.length} vs ${mine.length} bytes)`);
    } catch (err) {
      add(3, "0G Storage match", "FAIL", `download failed: ${errMsg(err)}`);
    }
  }

  // 4 provenance
  const ds = decisionsOf(log.records);
  const bad = ds.filter((d) =>
    d.source === "0g" ? !d.requestId || !d.model : d.model !== null || d.parsed !== null || d.raw !== null || !d.error,
  );
  add(4, "0G provenance", bad.length ? "FAIL" : "PASS",
    bad.length ? `records ${bad.map((d) => d.idx).join(", ")} break the 0G/failsafe rules`
      : `${ds.filter((d) => d.source === "0g").length} 0G decisions with request ids, ${ds.filter((d) => d.source === "failsafe").length} failsafe`);

  // 5 policy replay
  add(5, "Policy replay", ...replayPolicy(log, deps.arm));

  // 6 frames: download each frame by its recorded root and compare its sha256 with the recorded frameHash
  const framed = ds.filter((d) => d.frameHash !== null);
  if (!framed.length) add(6, "Frames", "SKIPPED", "no camera frames in this episode (CAMERA_SOURCE=none)");
  else {
    const dl = deps.downloadStorage ?? ((root: string) => downloadBytes(storageConfigFromEnv(), root));
    const bad: string[] = [];
    for (const d of framed) {
      if (!d.frameRoot) {
        bad.push(`#${d.idx} no frameRoot`);
        continue;
      }
      try {
        if (sha256Hex(await dl(d.frameRoot)) !== d.frameHash) bad.push(`#${d.idx} hash differs`);
      } catch (err) {
        bad.push(`#${d.idx} ${errMsg(err)}`);
      }
    }
    add(6, "Frames", bad.length ? "FAIL" : "PASS",
      bad.length ? bad.join("; ") : `${framed.length} frames downloaded from 0G Storage, hashes match`);
  }

  // 7 zerobot receipt
  const origin = zerobotOriginOf(log);
  const zbOn = deps.zerobotOn ?? envFlag("ROBOT_ZEROBOT", "on");
  if (!origin) add(7, "zerobot receipt", "SKIPPED", "started locally, not by a zerobot command");
  else if (!zbOn) add(7, "zerobot receipt", "SKIPPED", "ROBOT_ZEROBOT=off");
  else {
    try {
      const read = deps.readZerobotReceipt ?? (() => {
        const zc = zerobotConfigFromEnv();
        if (!zerobotConfigured(zc)) throw new Error(`ROBOT_ZEROBOT=on but not configured: ${ZEROBOT_MISSING}`);
        return (n: number) => ethersZerobot(zc).receipt(n);
      })();
      const rc = await read(origin.nonce);
      const res = rc ? decodeResult(rc.resultData) : null;
      if (!rc) add(7, "zerobot receipt", "FAIL", `no receipt for command #${origin.nonce}`);
      else if (!res) add(7, "zerobot receipt", "FAIL", `receipt for #${origin.nonce} has no Pearl result`);
      else if (res.episodeId !== log.episodeId || res.headHash !== head) {
        add(7, "zerobot receipt", "FAIL", `receipt #${origin.nonce} names ${res.episodeId} / head ${res.headHash.slice(0, 12)}…, recomputed ${head.slice(0, 12)}…`);
      } else if (rc.success !== (log.outcome === "DONE")) {
        add(7, "zerobot receipt", "FAIL", `receipt success=${rc.success} but outcome ${log.outcome}`);
      } else add(7, "zerobot receipt", "PASS", `command #${origin.nonce} receipt ${rc.txHash.slice(0, 12)}… carries this head`);
    } catch (e) {
      add(7, "zerobot receipt", "FAIL", errMsg(e));
    }
  }

  // 8 device signature: the device's own key signed this log's head (rev 5, device-first)
  if (!log.device) add(8, "Device signature", deps.requireDeviceSignature ? "FAIL" : "SKIPPED", "log carries no device signature");
  else {
    const who = recoverDevice(headMessage(log.episodeId, head), log.device.signature);
    const expected = deps.expectedDevice ?? log.device.address;
    if (!who) add(8, "Device signature", "FAIL", "signature is malformed");
    else if (who.toLowerCase() !== log.device.address.toLowerCase()) add(8, "Device signature", "FAIL", `signed by ${who}, log names ${log.device.address}`);
    else if (who.toLowerCase() !== expected.toLowerCase()) add(8, "Device signature", "FAIL", `signed by ${who}, expected device ${expected}`);
    else add(8, "Device signature", "PASS", `head signed by device ${who}`);
  }

  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  return { episodeId: log.episodeId, result: failed.length ? "REJECTED" : "VALID", failed, recomputedHead: head, checks };
}

function core(d: DecisionRecord): DecisionCore {
  return d as unknown as DecisionCore;
}

/** Re-runs the pure host policy over the recorded decisions; returns [status, detail]. */
export function replayPolicy(log: EpisodeLog, arm: ArmConfig): [CheckStatus, string] {
  const start = log.records.find((r) => r.kind === "event" && r.ev === "episode_start");
  const recordedCfg = start && start.kind === "event" ? (start.data as { armConfigHash?: string }).armConfigHash : undefined;
  if (recordedCfg && recordedCfg !== hashCanonical(arm)) {
    return ["SKIPPED", "arm calibration changed since this episode; replay needs the original config"];
  }
  const poses = new Poses(arm);
  let graspRetries = 0;
  let placeRetries = 0;
  let hardTrip = false;
  let handClear = true;
  const problems: string[] = [];
  for (const r of log.records) {
    if (r.kind === "event") {
      if (isHardTrip(r.ev)) hardTrip = true;
      if (r.ev === "reset_done") hardTrip = false;
      if (r.ev === "hand_in_zone") handClear = false;
      if (r.ev === "hand_clear") handClear = true;
      continue;
    }
    const d = core(r);
    let expected: { commands: string[]; policy: string; override: string | null } | null = null;
    if (r.checkpoint === "PLAN") {
      const p = policyPlan(d, log.task, poses);
      expected = { commands: commandsOf(p.steps), policy: p.policy, override: p.override };
    } else if (r.checkpoint === "VERIFY_GRASP") {
      const p = policyVerifyGrasp(d, log.task, poses, graspRetries);
      if (p.next === "VERIFY_GRASP") graspRetries++;
      expected = { commands: commandsOf(p.steps), policy: p.policy, override: p.override };
    } else if (r.checkpoint === "VERIFY_PLACE") {
      const p = policyVerifyPlace(d, poses, placeRetries);
      if (p.next === "VERIFY_PLACE") placeRetries++;
      expected = { commands: commandsOf(p.steps), policy: p.policy, override: p.override };
    } else {
      // INCIDENT: the interrupted steps depend on timing, so check the safety invariants instead of exact commands
      const resumes = r.commandsSent[0] === "resume";
      if (hardTrip && r.commandsSent.length) problems.push(`#${r.idx}: commands sent after a hard trip`);
      if (hardTrip && (r.parsed as { action?: string } | null)?.action === "RESUME" && r.override !== "hard trip: operator reset required") {
        problems.push(`#${r.idx}: RESUME after a hard trip not overridden`);
      }
      if (resumes && (!handClear || r.source !== "0g")) problems.push(`#${r.idx}: resume without hand_clear or without a 0G decision`);
    }
    if (expected) {
      if (!same(expected.commands, r.commandsSent)) problems.push(`#${r.idx} ${r.checkpoint}: commands differ from policy`);
      if (expected.policy !== r.policy) problems.push(`#${r.idx} ${r.checkpoint}: policy text differs`);
      if (expected.override !== r.override) problems.push(`#${r.idx} ${r.checkpoint}: override differs`);
    }
  }
  return problems.length ? ["FAIL", problems.join("; ")] : ["PASS", "every command follows from a recorded decision"];
}

/** Dashboard "Edit log": flips one character of the first decision's reason in a COPY and re-verifies. */
export function tamperedCopy(log: EpisodeLog): { copy: EpisodeLog; where: string } {
  const copy = JSON.parse(canonicalize(log)) as EpisodeLog;
  for (const r of copy.records) {
    const reason = (r.kind === "decision" ? (r.parsed as { reason?: string } | null)?.reason : undefined);
    if (r.kind === "decision" && typeof reason === "string" && reason.length) {
      const c = reason[0] === "x" ? "y" : "x";
      (r.parsed as { reason: string }).reason = c + reason.slice(1);
      return { copy, where: `record ${r.idx} parsed.reason[0] → "${c}"` };
    }
  }
  const r = copy.records[0]!;
  r.ts = r.ts.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
  return { copy, where: `record 0 ts last character changed` };
}
