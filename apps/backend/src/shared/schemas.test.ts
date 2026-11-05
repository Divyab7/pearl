import { describe, expect, it } from "vitest";
import {
  CheckpointOutputSchemas,
  DeviceMsgSchema,
  HostCmdSchema,
  IncidentOutputSchema,
  PlanOutputSchema,
} from "./schemas.js";

describe("checkpoint output schemas", () => {
  it("accepts a valid PLAN answer", () => {
    const ok = { action: "PICK", slot: "A2", reason: "red cube visible at A2", confidence: 0.9 };
    expect(PlanOutputSchema.parse(ok)).toEqual(ok);
  });

  it("rejects extra keys (strict)", () => {
    const r = PlanOutputSchema.safeParse({
      action: "PICK",
      slot: "A2",
      reason: "x",
      confidence: 0.9,
      joints: [1, 2, 3, 4],
    });
    expect(r.success).toBe(false);
  });

  it("rejects out-of-range confidence, unknown actions and long reasons", () => {
    expect(PlanOutputSchema.safeParse({ action: "PICK", slot: "A1", reason: "", confidence: 1.2 }).success).toBe(false);
    expect(PlanOutputSchema.safeParse({ action: "GO", slot: "A1", reason: "", confidence: 0.5 }).success).toBe(false);
    expect(
      PlanOutputSchema.safeParse({ action: "ABORT", slot: null, reason: "x".repeat(201), confidence: 0.5 }).success,
    ).toBe(false);
  });

  it("INCIDENT severity must be an integer 0..3", () => {
    const base = { action: "SAFE_STOP", file_claim: true, reason: "bump", confidence: 0.8 };
    expect(IncidentOutputSchema.safeParse({ ...base, severity: 2 }).success).toBe(true);
    expect(IncidentOutputSchema.safeParse({ ...base, severity: 4 }).success).toBe(false);
    expect(IncidentOutputSchema.safeParse({ ...base, severity: 1.5 }).success).toBe(false);
  });

  it("has one schema per checkpoint", () => {
    expect(Object.keys(CheckpointOutputSchemas).sort()).toEqual(
      ["INCIDENT", "PLAN", "VERIFY_GRASP", "VERIFY_PLACE"],
    );
  });
});

describe("device protocol schemas", () => {
  it("accepts host commands and rejects malformed ones", () => {
    expect(HostCmdSchema.safeParse({ cmd: "move", id: "m17", joints: [90, 110, 70, 10] }).success).toBe(true);
    expect(HostCmdSchema.safeParse({ cmd: "move", id: "m17", joints: [90, 110, 70] }).success).toBe(false);
    expect(HostCmdSchema.safeParse({ cmd: "move", id: "m17", joints: [90, 110, 70, 10.5] }).success).toBe(false);
    expect(HostCmdSchema.safeParse({ cmd: "hb", seq: 1, extra: true }).success).toBe(false);
    expect(HostCmdSchema.safeParse({ cmd: "fly" }).success).toBe(false);
  });

  it("accepts the spec's example device messages", () => {
    const lines = [
      { t: "hello", fw: "pearl-arm-0.2", deviceId: "esp32-s3-01", joints: [90, 90, 90, 10] },
      {
        t: "tel", ms: 123456, state: "MOVING", joints: [88, 104, 74, 10], target: [90, 110, 70, 10],
        tofMm: 312, accG: 1.02, hbAgeMs: 120,
      },
      { t: "ack", id: "m17" },
      { t: "done", id: "m17" },
      { t: "nack", id: "m17", reason: "limit" },
      { t: "event", ev: "hand_in_zone", tofMm: 84 },
      { t: "event", ev: "trip_bump", accG: 2.4 },
      { t: "event", ev: "trip_watchdog", hbAgeMs: 3001 },
      { t: "event", ev: "sensor_fault", what: "tof" },
      { t: "i2c", addrs: ["0x29", "0x40", "0x68"] },
    ];
    for (const l of lines) expect(DeviceMsgSchema.safeParse(l).success, JSON.stringify(l)).toBe(true);
  });

  it("rejects unknown states and events", () => {
    expect(
      DeviceMsgSchema.safeParse({
        t: "tel", ms: 1, state: "DANCING", joints: [90, 90, 90, 10], target: [90, 90, 90, 10],
        tofMm: 1, accG: 1, hbAgeMs: 1,
      }).success,
    ).toBe(false);
    expect(DeviceMsgSchema.safeParse({ t: "event", ev: "explode" }).success).toBe(false);
  });
});
