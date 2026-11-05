/**
 * Deterministic host policy (prompt §8.3). Pure functions: the verifier replays them over the recorded decisions and
 * events and must reproduce every record's commandsSent (check 5), so nothing here may read clocks, randomness or I/O.
 *
 * Rules:
 *  - source "failsafe" → safe stop, outcome FAILSAFE (or TRIPPED when the device is already hard-tripped).
 *  - confidence < 0.6 → treated as ABORT / SAFE_STOP.
 *  - PLAN must name the task's slot; another slot is overridden to ABORT (the model may confirm, not redirect).
 *  - CONTINUE/DONE that contradict grasped/placed are overridden to ABORT.
 *  - at most 1 RETRY per verify checkpoint; more is overridden to ABORT.
 *  - RESUME only from FROZEN_HAND after hand_clear; after a hard trip (bump, watchdog, sensor fault) RESUME is
 *    ignored and logged as override "hard trip: operator reset required" (rule 6).
 *  - a claim is filed when file_claim is true or severity ≥ 2.
 */
import type { DecisionCore } from "./decision.js";
import { fmtStep, type Poses, type Step } from "./poses.js";
import type {
  IncidentOutput,
  PlanOutput,
  VerifyGraspOutput,
  VerifyPlaceOutput,
} from "../shared/schemas.js";
import type { EpisodeOutcome, TaskSpec } from "../shared/types.js";

export const MIN_CONFIDENCE = 0.6;
export const MAX_RETRIES = 1;

export type Next = "VERIFY_GRASP" | "VERIFY_PLACE" | "END" | "CONTINUE_INTERRUPTED";

export interface PolicyResult {
  policy: string;
  override: string | null;
  steps: Step[];
  next: Next;
  outcome: EpisodeOutcome | null; // set when next === "END"
  fileClaim: boolean;
}

export const commandsOf = (steps: Step[]): string[] => steps.map(fmtStep);

const SAFE: Step[] = [{ kind: "safe" }];

function end(policy: string, outcome: EpisodeOutcome, override: string | null = null, steps = SAFE): PolicyResult {
  return { policy, override, steps, next: "END", outcome, fileClaim: false };
}

function lowConfidence(d: DecisionCore): number | null {
  const c = (d.parsed as { confidence?: number } | null)?.confidence;
  return typeof c === "number" && c < MIN_CONFIDENCE ? c : null;
}

export function policyPlan(d: DecisionCore, task: TaskSpec, poses: Poses): PolicyResult {
  if (d.source === "failsafe") return end(`failsafe (${d.error}) → safe stop`, "FAILSAFE");
  const p = d.parsed as PlanOutput;
  const lc = lowConfidence(d);
  if (lc !== null) return end(`confidence ${lc} < ${MIN_CONFIDENCE} → ABORT`, "ABORTED");
  if (p.action === "ABORT") return end("model ABORT → safe stop", "ABORTED");
  if (p.slot !== task.from) {
    return end("PICK at a slot other than the task's → ABORT", "ABORTED", `model chose ${p.slot}, task says ${task.from}`);
  }
  return { policy: `PICK ${p.slot}`, override: null, steps: poses.grasp(task.from), next: "VERIFY_GRASP", outcome: null, fileClaim: false };
}

export function policyVerifyGrasp(d: DecisionCore, task: TaskSpec, poses: Poses, retriesUsed: number): PolicyResult {
  if (d.source === "failsafe") return end(`failsafe (${d.error}) → safe stop`, "FAILSAFE");
  const p = d.parsed as VerifyGraspOutput;
  const lc = lowConfidence(d);
  if (lc !== null) return end(`confidence ${lc} < ${MIN_CONFIDENCE} → ABORT`, "ABORTED");
  if (p.action === "ABORT") return end("model ABORT → safe stop", "ABORTED");
  if (p.action === "RETRY") {
    if (retriesUsed >= MAX_RETRIES) return end("RETRY limit reached → ABORT", "ABORTED", `max ${MAX_RETRIES} retry`);
    return { policy: `RETRY grasp at ${task.from}`, override: null, steps: poses.regrasp(task.from), next: "VERIFY_GRASP", outcome: null, fileClaim: false };
  }
  if (!p.grasped) return end("CONTINUE with grasped:false → ABORT", "ABORTED", "inconsistent answer");
  return { policy: "CONTINUE → carry to BIN", override: null, steps: poses.place(), next: "VERIFY_PLACE", outcome: null, fileClaim: false };
}

/**
 * VERIFY_PLACE RETRY repeats the release over the bin (carry pose, open, lift). The spec names RETRY without defining
 * the motion; this is the conservative reading and is listed as a question in the plan.
 */
export function policyVerifyPlace(d: DecisionCore, poses: Poses, retriesUsed: number): PolicyResult {
  if (d.source === "failsafe") return end(`failsafe (${d.error}) → safe stop`, "FAILSAFE");
  const p = d.parsed as VerifyPlaceOutput;
  const lc = lowConfidence(d);
  if (lc !== null) return end(`confidence ${lc} < ${MIN_CONFIDENCE} → ABORT`, "ABORTED");
  if (p.action === "ABORT") return end("model ABORT → safe stop", "ABORTED");
  if (p.action === "RETRY") {
    if (retriesUsed >= MAX_RETRIES) return end("RETRY limit reached → ABORT", "ABORTED", `max ${MAX_RETRIES} retry`);
    return { policy: "RETRY release over BIN", override: null, steps: poses.place(), next: "VERIFY_PLACE", outcome: null, fileClaim: false };
  }
  if (!p.placed) return end("DONE with placed:false → ABORT", "ABORTED", "inconsistent answer");
  return { policy: "DONE", override: null, steps: [{ kind: "resume" }], next: "END", outcome: "DONE", fileClaim: false };
}

export interface IncidentContext {
  hardTrip: boolean; // trip_bump, trip_watchdog or sensor_fault seen
  frozenHand: boolean; // device in FROZEN_HAND
  handClear: boolean; // hand_clear seen after the last hand_in_zone
  remaining: Step[]; // steps interrupted by the incident, re-sent on RESUME
}

export function policyIncident(d: DecisionCore, ctx: IncidentContext): PolicyResult {
  const p = d.source === "0g" ? (d.parsed as IncidentOutput) : null;
  const fileClaim = !!p && (p.file_claim || p.severity >= 2);
  const claimNote = fileClaim ? "; claim filed" : "";

  if (ctx.hardTrip) {
    const override = p?.action === "RESUME" ? "hard trip: operator reset required" : null;
    const why = d.source === "failsafe" ? `failsafe (${d.error})` : `model ${p!.action}`;
    // the device is tripped: it accepts no motion, so the host sends nothing
    return { policy: `${why}; hard trip → stay tripped${claimNote}`, override, steps: [], next: "END", outcome: "TRIPPED", fileClaim };
  }
  if (d.source === "failsafe") return { ...end(`failsafe (${d.error}) → safe stop`, "FAILSAFE"), fileClaim: false };
  const lc = lowConfidence(d);
  if (lc !== null) return { ...end(`confidence ${lc} < ${MIN_CONFIDENCE} → SAFE_STOP${claimNote}`, "ABORTED"), fileClaim };
  if (p!.action === "SAFE_STOP") return { ...end(`model SAFE_STOP → safe stop${claimNote}`, "ABORTED"), fileClaim };
  if (!ctx.frozenHand || !ctx.handClear) {
    const why = !ctx.frozenHand ? "device not in FROZEN_HAND" : "hand zone not clear";
    return { ...end(`RESUME refused (${why}) → safe stop${claimNote}`, "ABORTED", `RESUME ignored: ${why}`), fileClaim };
  }
  return {
    policy: `RESUME after hand clear${claimNote}`,
    override: null,
    steps: [{ kind: "resume" }, ...ctx.remaining],
    next: "CONTINUE_INTERRUPTED",
    outcome: null,
    fileClaim,
  };
}
