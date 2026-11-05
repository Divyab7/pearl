/**
 * Turns one Router call into the 0G-related part of a DecisionRecord. This is the only place a decision is created, and
 * it has exactly two outcomes:
 *  - source "0g": the model answered, the answer parsed as JSON, passed the strict zod schema, and (when TEE
 *    verification was requested) was not reported as tee_verified:false.
 *  - source "failsafe": anything else. model, raw and parsed are null and `error` says why (prompt hard rule 3).
 *    requestId / httpRequestId are kept when 0G did return them: the call was made and billed, and hiding that would
 *    make the record less honest, not more.
 * There is no retry, no cache and no default answer.
 */
import { callRouter, type DecisionRequest, type RouterConfig, type RouterResult } from "../og/router.js";
import { CheckpointOutputSchemas, formatIssues } from "../shared/schemas.js";
import type { Checkpoint, DecisionRecord } from "../shared/types.js";

export type DecisionCore = Pick<
  DecisionRecord,
  | "checkpoint"
  | "source"
  | "model"
  | "requestId"
  | "httpRequestId"
  | "clientRequestId"
  | "clientRequestIdEchoed"
  | "provider"
  | "providerIdentity"
  | "teeVerified"
  | "cost"
  | "zgResKey"
  | "reasoning"
  | "raw"
  | "parsed"
  | "error"
  | "latencyMs"
>;

/** Remove one surrounding ```json … ``` fence, the only repair allowed (prompt §8.3). */
export function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return m ? m[1]!.trim() : s.trim();
}

/** A failsafe decision made without asking 0G (e.g. the camera gave no frame): every model field is null. */
export function failsafeDecision(checkpoint: Checkpoint, clientRequestId: string, error: string): DecisionCore {
  return {
    checkpoint, source: "failsafe", model: null, requestId: null, httpRequestId: null, clientRequestId,
    clientRequestIdEchoed: null, provider: null, providerIdentity: null, teeVerified: null, cost: null,
    zgResKey: null, reasoning: null, raw: null, parsed: null, error, latencyMs: 0,
  };
}

export function interpret(checkpoint: Checkpoint, clientRequestId: string, r: RouterResult): DecisionCore {
  const base = {
    checkpoint,
    clientRequestId,
    requestId: r.requestId,
    httpRequestId: r.httpRequestId,
    clientRequestIdEchoed: r.clientRequestIdEchoed,
    latencyMs: r.latencyMs,
  };
  const failsafe = (error: string): DecisionCore => ({
    ...base,
    source: "failsafe",
    model: null,
    provider: null,
    providerIdentity: null,
    teeVerified: r.teeVerified,
    cost: r.cost,
    zgResKey: null,
    reasoning: null,
    raw: null,
    parsed: null,
    error,
  });

  if (!r.ok) return failsafe(r.error);

  let json: unknown;
  try {
    json = JSON.parse(stripFence(r.content));
  } catch {
    return failsafe(`invalid JSON from model: ${r.content.slice(0, 120)}`);
  }
  const parsed = CheckpointOutputSchemas[checkpoint].safeParse(json);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    return failsafe(`schema check failed: ${issues}`);
  }
  if (r.teeVerified === false) {
    return failsafe("tee_verified:false (TEE signature present but did not verify)");
  }
  return {
    ...base,
    source: "0g",
    model: r.model,
    provider: r.provider,
    providerIdentity: r.providerIdentity,
    teeVerified: r.teeVerified,
    cost: r.cost,
    zgResKey: r.zgResKey,
    reasoning: r.reasoning,
    raw: r.content,
    parsed: parsed.data,
    error: null,
  };
}

export async function decide(
  cfg: RouterConfig,
  req: DecisionRequest,
  fetchImpl?: typeof fetch,
): Promise<DecisionCore> {
  const r = await callRouter(cfg, req, fetchImpl);
  return interpret(req.checkpoint, req.clientRequestId, r);
}
