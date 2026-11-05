/**
 * zod schemas (zod 4.6.x). Docs: https://zod.dev/api — strictObject rejects unknown keys
 * (https://zod.dev/api#strictobject), discriminatedUnion (https://zod.dev/api#discriminated-unions),
 * tuple (https://zod.dev/api#tuples).
 *
 * Model outputs are strict: any extra key, wrong enum value or out-of-range number fails validation, and a failed
 * validation becomes a failsafe decision (never repaired, never defaulted).
 */
import { z } from "zod";

export const CheckpointSchema = z.enum(["PLAN", "VERIFY_GRASP", "VERIFY_PLACE", "INCIDENT"]);

const reason = z.string().max(200);
const confidence = z.number().min(0).max(1);

// ---- model outputs, one per checkpoint (prompt §8.3) ----
export const PlanOutputSchema = z.strictObject({
  action: z.enum(["PICK", "ABORT"]),
  slot: z.enum(["A1", "A2", "A3"]).nullable(),
  reason,
  confidence,
});

export const VerifyGraspOutputSchema = z.strictObject({
  action: z.enum(["CONTINUE", "RETRY", "ABORT"]),
  grasped: z.boolean(),
  reason,
  confidence,
});

export const VerifyPlaceOutputSchema = z.strictObject({
  action: z.enum(["DONE", "RETRY", "ABORT"]),
  placed: z.boolean(),
  reason,
  confidence,
});

export const IncidentOutputSchema = z.strictObject({
  action: z.enum(["RESUME", "SAFE_STOP"]),
  severity: z.number().int().min(0).max(3),
  file_claim: z.boolean(),
  reason,
  confidence,
});

export const CheckpointOutputSchemas = {
  PLAN: PlanOutputSchema,
  VERIFY_GRASP: VerifyGraspOutputSchema,
  VERIFY_PLACE: VerifyPlaceOutputSchema,
  INCIDENT: IncidentOutputSchema,
} as const;

export type PlanOutput = z.infer<typeof PlanOutputSchema>;
export type VerifyGraspOutput = z.infer<typeof VerifyGraspOutputSchema>;
export type VerifyPlaceOutput = z.infer<typeof VerifyPlaceOutputSchema>;
export type IncidentOutput = z.infer<typeof IncidentOutputSchema>;

// ---- device protocol (prompt §7.5), newline-delimited JSON, ≤ 512 bytes per line ----
const deg = z.number().int().min(0).max(180);
/** Joint order everywhere: [base, shoulder, elbow, gripper], integer degrees. */
export const JointsSchema = z.tuple([deg, deg, deg, deg]);

export const DeviceStateSchema = z.enum([
  "BOOT",
  "IDLE",
  "MOVING",
  "WAITING",
  "FROZEN_HAND",
  "TRIPPED",
  "SAFE",
]);

export const HostCmdSchema = z.discriminatedUnion("cmd", [
  z.strictObject({ cmd: z.literal("hb"), seq: z.number().int().nonnegative() }),
  z.strictObject({ cmd: z.literal("move"), id: z.string().min(1).max(32), joints: JointsSchema }),
  z.strictObject({ cmd: z.literal("grip"), id: z.string().min(1).max(32), close: z.boolean() }),
  z.strictObject({ cmd: z.literal("hold") }),
  z.strictObject({ cmd: z.literal("resume") }),
  z.strictObject({ cmd: z.literal("safe") }),
  z.strictObject({ cmd: z.literal("reset") }),
  z.strictObject({
    cmd: z.literal("cal"),
    ch: z.number().int().min(0).max(15),
    us: z.number().int().min(500).max(2500),
  }),
  z.strictObject({ cmd: z.literal("i2c_scan") }),
]);

const eventNames = z.enum([
  "hand_in_zone",
  "hand_clear",
  "trip_bump",
  "trip_watchdog",
  "reset_armed",
  "reset_done",
  "sensor_fault",
]);

export const DeviceMsgSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("hello"),
    fw: z.string(),
    deviceId: z.string(),
    joints: JointsSchema,
  }),
  z.strictObject({
    t: z.literal("tel"),
    ms: z.number().int().nonnegative(),
    state: DeviceStateSchema,
    joints: JointsSchema,
    target: JointsSchema,
    tofMm: z.number().int().nonnegative(),
    accG: z.number().nonnegative(),
    hbAgeMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ t: z.literal("ack"), id: z.string() }),
  z.strictObject({ t: z.literal("done"), id: z.string() }),
  z.strictObject({
    t: z.literal("nack"),
    id: z.string().optional(),
    reason: z.enum(["state", "limit", "busy", "parse"]),
  }),
  z.strictObject({
    t: z.literal("event"),
    ev: eventNames,
    tofMm: z.number().int().nonnegative().optional(),
    accG: z.number().nonnegative().optional(),
    hbAgeMs: z.number().int().nonnegative().optional(),
    what: z.string().optional(),
  }),
  z.strictObject({ t: z.literal("i2c"), addrs: z.array(z.string().regex(/^0x[0-9a-f]{2}$/)) }),
]);

export const TaskSpecSchema = z.strictObject({
  task: z.literal("pick"),
  color: z.string().min(1).max(16),
  from: z.enum(["A1", "A2", "A3"]),
  to: z.literal("BIN"),
});

/** Max bytes of one protocol line (prompt §7.5). */
export const MAX_LINE_BYTES = 512;

/** Zod issues as one line: "path: message; path: message". */
export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** A pick task from a request body (task and destination are fixed); the error text when it does not parse. */
export function parseTask(body: unknown): z.infer<typeof TaskSpecSchema> | string {
  const r = TaskSpecSchema.safeParse({ task: "pick", to: "BIN", ...((body ?? {}) as object) });
  return r.success ? r.data : formatIssues(r.error);
}
