/**
 * Loads and validates config/arm.json, the single source of truth for joint limits, poses and safety thresholds.
 * SimArm and the orchestrator import from here; firmware config.h must carry the same numbers (a later test parses its
 * #defines and compares). Validation fails loudly at startup instead of letting a bad pose reach a servo.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JointsSchema } from "./schemas.js";

const SlotSchema = z.strictObject({ above: JointsSchema, down: JointsSchema });

export const ArmConfigSchema = z
  .strictObject({
    v: z.literal(1),
    comment: z.string().optional(),
    joints: z.tuple([
      z.literal("base"),
      z.literal("shoulder"),
      z.literal("elbow"),
      z.literal("gripper"),
    ]),
    channels: z.tuple([
      z.number().int().min(0).max(15),
      z.number().int().min(0).max(15),
      z.number().int().min(0).max(15),
      z.number().int().min(0).max(15),
    ]),
    servoMinUs: z.number().int().min(400).max(1500),
    servoMaxUs: z.number().int().min(1500).max(2600),
    jointMinDeg: JointsSchema,
    jointMaxDeg: JointsSchema,
    home: JointsSchema,
    safe: JointsSchema,
    gripOpen: z.number().int(),
    gripClosed: z.number().int(),
    maxDegPerS: z.number().positive().max(360),
    handZoneMm: z.number().int().positive(),
    handClearMs: z.number().int().positive(),
    bumpG: z.number().positive(),
    heartbeatIntervalMs: z.number().int().positive(),
    heartbeatTimeoutMs: z.number().int().positive(),
    telemetryHz: z.number().positive(),
    slots: z.strictObject({ A1: SlotSchema, A2: SlotSchema, A3: SlotSchema, BIN: SlotSchema }),
  })
  .superRefine((c, ctx) => {
    const inLimits = (pose: readonly number[], label: string) => {
      pose.forEach((d, i) => {
        const lo = c.jointMinDeg[i]!;
        const hi = c.jointMaxDeg[i]!;
        if (d < lo || d > hi) {
          ctx.addIssue({
            code: "custom",
            message: `${label}: ${c.joints[i]} ${d}° outside [${lo}, ${hi}]`,
          });
        }
      });
    };
    c.jointMinDeg.forEach((lo, i) => {
      if (lo >= c.jointMaxDeg[i]!) {
        ctx.addIssue({ code: "custom", message: `jointMinDeg[${i}] must be < jointMaxDeg[${i}]` });
      }
    });
    if (new Set(c.channels).size !== 4) {
      ctx.addIssue({ code: "custom", message: "channels must be 4 distinct PCA9685 channels" });
    }
    if (c.servoMinUs >= c.servoMaxUs) {
      ctx.addIssue({ code: "custom", message: "servoMinUs must be < servoMaxUs" });
    }
    if (c.heartbeatIntervalMs >= c.heartbeatTimeoutMs) {
      ctx.addIssue({ code: "custom", message: "heartbeatIntervalMs must be < heartbeatTimeoutMs" });
    }
    inLimits(c.home, "home");
    inLimits(c.safe, "safe");
    for (const [name, slot] of Object.entries(c.slots)) {
      inLimits(slot.above, `${name}.above`);
      inLimits(slot.down, `${name}.down`);
    }
    for (const [label, g] of [
      ["gripOpen", c.gripOpen],
      ["gripClosed", c.gripClosed],
    ] as const) {
      if (g < c.jointMinDeg[3] || g > c.jointMaxDeg[3]) {
        ctx.addIssue({ code: "custom", message: `${label} ${g}° outside gripper limits` });
      }
    }
  });

export type ArmConfig = z.infer<typeof ArmConfigSchema>;
export type SlotName = keyof ArmConfig["slots"];

/** Repo root, resolved from this file's location (works from src/ under tsx and from dist/ after build). */
function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/backend/{src,dist}/shared
  return resolve(here, "../../../../config/arm.json");
}

export function parseArmConfig(raw: unknown): ArmConfig {
  return ArmConfigSchema.parse(raw);
}

export function loadArmConfig(path = process.env.ARM_CONFIG_PATH ?? defaultConfigPath()): ArmConfig {
  const text = readFileSync(path, "utf8");
  return parseArmConfig(JSON.parse(text));
}
