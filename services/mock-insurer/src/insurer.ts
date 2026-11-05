/**
 * Deterministic mock insurer (prompt §8.10). POST /assess → APPROVED when the episode verified and severity ≥ 2,
 * otherwise DENIED. Idempotent by claimId: the same claim always gets the same answer; a different body for a known
 * claimId is refused (409).
 */
import express, { type Request, type Response } from "express";
import { z } from "zod";

export const AssessSchema = z.strictObject({
  claimId: z.string().min(1).max(64),
  episodeId: z.string().min(1).max(64),
  severity: z.number().int().min(0).max(3),
  outcome: z.string().min(1).max(16),
  verified: z.boolean(),
});
export type AssessInput = z.infer<typeof AssessSchema>;

export interface Assessment {
  claimId: string;
  status: "APPROVED" | "DENIED";
  amount: number; // payout units, 2 decimals
  reason: string;
}

/** 50.00 payout units per severity level. */
export const UNITS_PER_SEVERITY = 5000;

export function assess(i: AssessInput): Assessment {
  if (!i.verified) return { claimId: i.claimId, status: "DENIED", amount: 0, reason: "episode log did not verify" };
  if (i.severity < 2) return { claimId: i.claimId, status: "DENIED", amount: 0, reason: `severity ${i.severity} below 2` };
  return { claimId: i.claimId, status: "APPROVED", amount: i.severity * UNITS_PER_SEVERITY, reason: `verified incident, severity ${i.severity}` };
}

export function createInsurerApp() {
  const seen = new Map<string, { body: string; result: Assessment }>();
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/assess", (req: Request, res: Response) => {
    const p = AssessSchema.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ error: p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") });
      return;
    }
    const key = JSON.stringify(p.data);
    const prev = seen.get(p.data.claimId);
    if (prev) {
      if (prev.body !== key) {
        res.status(409).json({ error: "claimId already assessed with different details" });
        return;
      }
      res.json({ ...prev.result, idempotent: true });
      return;
    }
    const result = assess(p.data);
    seen.set(p.data.claimId, { body: key, result });
    res.json(result);
  });
  return app;
}
