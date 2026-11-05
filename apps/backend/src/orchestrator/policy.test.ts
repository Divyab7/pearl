import { describe, expect, it } from "vitest";
import { loadArmConfig } from "../shared/armConfig.js";
import type { DecisionCore } from "./decision.js";
import { policyIncident, policyPlan, policyVerifyGrasp, policyVerifyPlace } from "./policy.js";
import { Poses } from "./poses.js";

const arm = loadArmConfig();
const poses = new Poses(arm);
const task = { task: "pick" as const, color: "red", from: "A2" as const, to: "BIN" as const };

function d(parsed: unknown, source: "0g" | "failsafe" = "0g"): DecisionCore {
  return {
    checkpoint: "PLAN", source, model: source === "0g" ? "m" : null, requestId: "r", httpRequestId: "r",
    clientRequestId: "c", clientRequestIdEchoed: true, provider: null, providerIdentity: null, teeVerified: true,
    cost: null, zgResKey: null, reasoning: null, raw: source === "0g" ? "{}" : null,
    parsed: source === "0g" ? parsed : null, error: source === "0g" ? null : "timeout", latencyMs: 1,
  };
}

describe("host policy", () => {
  it("PLAN: PICK at the task slot expands to the grasp sequence, gripper closed when lifting", () => {
    const p = policyPlan(d({ action: "PICK", slot: "A2", reason: "", confidence: 0.9 }), task, poses);
    expect(p.next).toBe("VERIFY_GRASP");
    expect(p.steps.at(-1)).toEqual({ kind: "move", joints: [90, 100, 80, arm.gripClosed] });
  });

  it("PLAN: failsafe, low confidence, ABORT and a different slot all end with a safe stop", () => {
    expect(policyPlan(d(null, "failsafe"), task, poses)).toMatchObject({ next: "END", outcome: "FAILSAFE", steps: [{ kind: "safe" }] });
    expect(policyPlan(d({ action: "PICK", slot: "A2", reason: "", confidence: 0.59 }), task, poses).outcome).toBe("ABORTED");
    expect(policyPlan(d({ action: "ABORT", slot: null, reason: "", confidence: 0.9 }), task, poses).outcome).toBe("ABORTED");
    const other = policyPlan(d({ action: "PICK", slot: "A3", reason: "", confidence: 0.9 }), task, poses);
    expect(other.outcome).toBe("ABORTED");
    expect(other.override).toMatch(/model chose A3, task says A2/);
  });

  it("VERIFY_GRASP: one retry allowed, then ABORT; CONTINUE with grasped:false is overridden", () => {
    const retry = { action: "RETRY", grasped: false, reason: "", confidence: 0.8 };
    expect(policyVerifyGrasp(d(retry), task, poses, 0).next).toBe("VERIFY_GRASP");
    expect(policyVerifyGrasp(d(retry), task, poses, 1)).toMatchObject({ outcome: "ABORTED", override: "max 1 retry" });
    expect(policyVerifyGrasp(d({ action: "CONTINUE", grasped: false, reason: "", confidence: 0.9 }), task, poses, 0).override).toBe("inconsistent answer");
    expect(policyVerifyGrasp(d({ action: "CONTINUE", grasped: true, reason: "", confidence: 0.9 }), task, poses, 0).next).toBe("VERIFY_PLACE");
  });

  it("VERIFY_PLACE: DONE ends the episode with a resume", () => {
    expect(policyVerifyPlace(d({ action: "DONE", placed: true, reason: "", confidence: 0.9 }), poses, 0)).toMatchObject({
      next: "END", outcome: "DONE", steps: [{ kind: "resume" }],
    });
  });

  it("INCIDENT: RESUME after a hard trip is overridden; a claim is filed on severity ≥ 2", () => {
    const p = policyIncident(d({ action: "RESUME", severity: 2, file_claim: false, reason: "", confidence: 0.9 }), {
      hardTrip: true, frozenHand: false, handClear: false, remaining: [],
    });
    expect(p).toMatchObject({ outcome: "TRIPPED", override: "hard trip: operator reset required", steps: [], fileClaim: true });
  });

  it("INCIDENT: RESUME after hand clear re-sends the interrupted steps", () => {
    const remaining = poses.place();
    const p = policyIncident(d({ action: "RESUME", severity: 0, file_claim: false, reason: "", confidence: 0.9 }), {
      hardTrip: false, frozenHand: true, handClear: true, remaining,
    });
    expect(p.next).toBe("CONTINUE_INTERRUPTED");
    expect(p.steps).toEqual([{ kind: "resume" }, ...remaining]);
    const notClear = policyIncident(d({ action: "RESUME", severity: 0, file_claim: false, reason: "", confidence: 0.9 }), {
      hardTrip: false, frozenHand: true, handClear: false, remaining,
    });
    expect(notClear).toMatchObject({ outcome: "ABORTED", override: "RESUME ignored: hand zone not clear" });
  });
});
