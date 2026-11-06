/**
 * Turns one Router call into the 0G-related part of a DecisionRecord. This is the only place a decision is created, and
 * it has exactly two outcomes:
 *  - source "0g": the model answered, the answer parsed as JSON, passed the strict zod schema, and (when TEE
 *    verification was requested) was not reported as tee_verified:false.
 *  - source "failsafe": anything else. model, raw and parsed are null and `error` says why (prompt hard rule 3).
 *    requestId / httpRequestId are kept when 0G did return them: the call was made and billed, and hiding that would
 *    make the record less honest, not more.
 * There is no cache and no default answer. The only retry is the model fallback in decide(): when a model fails on
 * the provider side (no response, 5xx, 429, no provider for the trust mode), the next model in cfg.fallbackModels is
 * asked the same thing, inside the same timeoutMs budget, and every call is kept in `attempts`. As a last resort (when
 * allowed) the same models are asked again in trust mode "standard"; `trustMode` then says the answer is not
 * hardware-verified.
 */
import { callRouter, isProviderFailure, type DecisionRequest, type RouterConfig, type RouterResult, type TrustMode } from "../og/router.js";
import { CheckpointOutputSchemas, formatIssues } from "../shared/schemas.js";
import type { Checkpoint, DecisionRecord, ModelAttempt } from "../shared/types.js";

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
  | "attempts"
  | "trustMode"
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

/** The models to ask, in order: the primary then the fallbacks, without blanks or repeats. */
export function modelsOf(cfg: RouterConfig): string[] {
  const out: string[] = [];
  for (const m of [cfg.model, ...(cfg.fallbackModels ?? [])]) if (m && !out.includes(m)) out.push(m);
  return out.length ? out : [cfg.model];
}

/**
 * Every call to make, in order: each model in trust mode cfg.trustMode, then, only when cfg.trustMode is "verified" and
 * cfg.allowStandardFallback is on (owner decision 7 Nov 2026, last resort), the same models again in "standard" mode
 * (answered by a provider that is not hardware-verified; recorded as such).
 */
export function callsOf(cfg: RouterConfig): { model: string; trustMode: TrustMode }[] {
  const models = modelsOf(cfg);
  const calls = models.map((model) => ({ model, trustMode: cfg.trustMode }));
  if (cfg.trustMode === "verified" && cfg.allowStandardFallback) {
    for (const model of models) calls.push({ model, trustMode: "standard" });
  }
  return calls;
}

export async function decide(
  cfg: RouterConfig,
  req: DecisionRequest,
  fetchImpl?: typeof fetch,
): Promise<DecisionCore> {
  const calls = callsOf(cfg);
  if (calls.length === 1) {
    const r = await callRouter(cfg, req, fetchImpl);
    const d = interpret(req.checkpoint, req.clientRequestId, r);
    return cfg.trustMode === "verified" ? d : { ...d, trustMode: cfg.trustMode };
  }
  // Fallbacks: one time budget (cfg.timeoutMs) shared by every call, so the arm never waits longer than with one model.
  const started = performance.now();
  const attempts: ModelAttempt[] = [];
  let last: RouterResult | null = null;
  let budgetLeft = true;
  for (const { model, trustMode } of calls) {
    const left = Math.floor(cfg.timeoutMs - (performance.now() - started));
    if (left <= 0) {
      budgetLeft = false;
      break;
    }
    const r = await callRouter({ ...cfg, model, trustMode, timeoutMs: left }, req, fetchImpl);
    attempts.push({ model, trustMode, status: r.status, requestId: r.requestId, error: r.ok ? null : r.error, latencyMs: r.latencyMs });
    last = r;
    if (!isProviderFailure(r)) break; // an answer (good or bad) or a fault in our request: never ask another model
  }
  const total = Math.round(performance.now() - started);
  let r: RouterResult = last!;
  const n = attempts.length;
  const lastAttempt = attempts.at(-1)!;
  const unit = (k: number) => (calls.length > modelsOf(cfg).length ? (k === 1 ? "call" : "calls") : k === 1 ? "model" : "models");
  if (!r.ok && (n > 1 || !budgetLeft)) {
    const why = !budgetLeft
      ? `time budget of ${cfg.timeoutMs} ms used up after ${n} ${unit(n)}`
      : isProviderFailure(r)
        ? `all ${n} ${unit(n)} failed`
        : `${unit(1)} ${n} of ${calls.length} refused the request`;
    const mode = lastAttempt.trustMode === "verified" ? "" : `, ${lastAttempt.trustMode}`;
    r = { ...r, error: `${why}; last (${lastAttempt.model}${mode}): ${r.error}` };
  }
  const d = interpret(req.checkpoint, req.clientRequestId, { ...r, latencyMs: total });
  if (n > 1) return { ...d, trustMode: lastAttempt.trustMode, attempts };
  return lastAttempt.trustMode === "verified" ? d : { ...d, trustMode: lastAttempt.trustMode };
}
