/**
 * Checks that need the UNLOCKED log (owner decision 6 Nov 2026: only the owner, and the insurer for a claimed incident,
 * can unlock). They run in the browser of whoever holds the key, never on the dashboard server, so this file uses no
 * Node API: plain-TS SHA-256, canonical JSON and the pure policy functions.
 *
 *  hash chain     every prevHash/recordHash recomputes and the head equals the head in the sealed file's public header
 *                 (which the public checks tie to the 0G Chain anchor and the robot's signature)
 *  request ids    the 0G request ids in the log hash to the requestIdsHash the robot anchored on 0G Chain
 *  provenance     every source "0g" record has a requestId and a model; every failsafe has model/parsed/raw null
 *  policy replay  replaying the host policy over the recorded decisions reproduces every commandsSent; no RESUME after
 *                 a hard trip; no resume after a hand event without hand_clear
 */
import { canonicalize } from "../shared/canonical.js";
import { sha256HexPure } from "../shared/sha256.js";
import type { ArmConfig } from "../shared/armConfig.js";
import { isHardTrip, type ChainedRecord, type DecisionRecord, type EpisodeLog } from "../shared/types.js";
import type { DecisionCore } from "../orchestrator/decision.js";
import { commandsOf, policyPlan, policyVerifyGrasp, policyVerifyPlace } from "../orchestrator/policy.js";
import { Poses } from "../orchestrator/poses.js";

export type CheckStatus = "PASS" | "FAIL" | "SKIPPED";
export interface CheckResult {
  id: number;
  /** Plain-language name shown to people. */
  name: string;
  status: CheckStatus;
  detail: string;
  /** The technical name, shown small next to the plain one. */
  tech?: string;
  /** For a FAIL: true when something is missing (not stored, not reachable) rather than different from the record. */
  missing?: boolean;
}

const ZERO = "0".repeat(64);
const hashOf = (v: unknown) => sha256HexPure(canonicalize(v));

export function recomputeChain(log: Pick<EpisodeLog, "records" | "headHash" | "episodeId">): { ok: boolean; head: string; reason: string | null } {
  let prev = ZERO;
  for (let i = 0; i < log.records.length; i++) {
    const r = log.records[i]!;
    const fail = (reason: string) => ({ ok: false, head: prev, reason: `record ${i}: ${reason}` });
    if (r.idx !== i) return fail(`idx ${r.idx} at position ${i}`);
    if (r.episodeId !== log.episodeId) return fail("episodeId mismatch");
    if (r.prevHash !== prev) return fail("prevHash does not match the previous record");
    const { recordHash, ...rest } = r;
    const h = hashOf(rest);
    if (h !== recordHash) return fail("recordHash does not match the record's content");
    prev = h;
  }
  if (prev !== log.headHash) return { ok: false, head: prev, reason: "headHash does not match the last record" };
  return { ok: true, head: prev, reason: null };
}

export const requestIdsOfLog = (log: Pick<EpisodeLog, "records">): string[] =>
  log.records.flatMap((r) => (r.kind === "decision" && r.requestId ? [r.requestId] : []));
/** Same value as og/anchor.ts requestIdsHash: 0x + sha256 of the canonical JSON array. */
export const requestIdsHashOf = (ids: string[]) => `0x${hashOf(ids)}`;

const decisionsOf = (rs: readonly ChainedRecord[]) => rs.filter((r): r is ChainedRecord & DecisionRecord => r.kind === "decision");
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface ContentInput {
  /** The head in the sealed file's public header (anchored and signed by the robot). */
  headerHead: string;
  /** requestIdsHash from the 0G Chain anchor, when the public check found one. */
  anchoredRequestIdsHash: string | null;
  arm: ArmConfig;
}

/** Checks 6–9 (the public checks are 1–5, frames are 10). */
export function contentChecks(log: EpisodeLog, x: ContentInput): CheckResult[] {
  const out: CheckResult[] = [];
  const chain = recomputeChain(log);
  const C6 = { id: 6, name: "No records added, removed or changed", tech: "hash chain" };
  if (!chain.ok) out.push({ ...C6, status: "FAIL", detail: chain.reason ?? "broken" });
  else if (chain.head !== x.headerHead) {
    out.push({ ...C6, status: "FAIL", detail: `the records add up to ${chain.head.slice(0, 12)}…, but the robot signed ${x.headerHead.slice(0, 12)}…` });
  } else out.push({ ...C6, status: "PASS", detail: `all ${log.records.length} records link up to the fingerprint the robot signed and recorded` });

  const ids = requestIdsOfLog(log);
  const C7 = { id: 7, name: "Every AI decision is on record", tech: "0G request ids" };
  if (!x.anchoredRequestIdsHash) out.push({ ...C7, status: "SKIPPED", detail: "no 0G Chain record to compare with" });
  else {
    const ok = requestIdsHashOf(ids) === x.anchoredRequestIdsHash;
    out.push({ ...C7, status: ok ? "PASS" : "FAIL", detail: ok ? `${ids.length} 0G request ${ids.length === 1 ? "id matches" : "ids match"} the set recorded on 0G Chain` : "the 0G request ids differ from the set recorded on 0G Chain" });
  }

  const ds = decisionsOf(log.records);
  const bad = ds.filter((d) => (d.source === "0g" ? !d.requestId || !d.model : d.model !== null || d.parsed !== null || d.raw !== null || !d.error));
  const n0g = ds.filter((d) => d.source === "0g").length;
  const nfs = ds.filter((d) => d.source === "failsafe").length;
  out.push({
    id: 8, name: "Decisions came from 0G", tech: "provenance", status: bad.length ? "FAIL" : "PASS",
    detail: bad.length ? `records ${bad.map((d) => d.idx).join(", ")} break the 0G/failsafe rules`
      : [`${n0g} ${n0g === 1 ? "decision" : "decisions"} from 0G, each with its request id`, nfs ? `${nfs} failsafe ${nfs === 1 ? "stop" : "stops"} with no model` : ""].filter(Boolean).join("; "),
  });

  const [st, detail] = replayPolicy(log, x.arm);
  out.push({ id: 9, name: "Every move follows a recorded decision", tech: "policy replay", status: st, detail });
  return out;
}

/** Re-runs the pure host policy over the recorded decisions; returns [status, detail]. */
export function replayPolicy(log: EpisodeLog, arm: ArmConfig): [CheckStatus, string] {
  const start = log.records.find((r) => r.kind === "event" && r.ev === "episode_start");
  const recordedCfg = start && start.kind === "event" ? (start.data as { armConfigHash?: string }).armConfigHash : undefined;
  if (recordedCfg && recordedCfg !== hashOf(arm)) {
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
    const d = r as unknown as DecisionCore;
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
  return problems.length ? ["FAIL", problems.join("; ")] : ["PASS", "replaying the safety policy over the decisions gives exactly the moves the arm made"];
}

/** "Edit 1 byte": flips one character of the first decision's reason in a COPY of an unlocked log. */
export function tamperedCopy(log: EpisodeLog): { copy: EpisodeLog; where: string } {
  const copy = JSON.parse(canonicalize(log)) as EpisodeLog;
  for (const r of copy.records) {
    const reason = r.kind === "decision" ? (r.parsed as { reason?: string } | null)?.reason : undefined;
    if (r.kind === "decision" && typeof reason === "string" && reason.length) {
      const c = reason[0] === "x" ? "y" : "x";
      (r.parsed as { reason: string }).reason = c + reason.slice(1);
      return { copy, where: `1 byte: the first letter of the model's reason in record #${r.idx} (→ "${c}")` };
    }
  }
  const r = copy.records[0]!;
  r.ts = r.ts.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
  return { copy, where: "last digit of the time in record #0" };
}

/** Frames referenced by the log: the locked file's 0G Storage root and the sha256 of the unlocked JPEG. */
export const framesOf = (log: EpisodeLog) =>
  decisionsOf(log.records).flatMap((d) => (d.frameHash ? [{ idx: d.idx, root: d.frameRoot, hash: d.frameHash }] : []));
