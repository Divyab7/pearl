/**
 * 0G Compute Router client (native fetch, no OpenAI SDK).
 *
 * Every field below was checked against the 0G docs on 4 Nov 2026 (summary with quotes: docs/TRACK-DOCS.md §2.B):
 * - Endpoint + auth: POST {base}/chat/completions, `Authorization: Bearer sk-…`
 *   https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart
 * - `x_0g_trace` { request_id, provider, provider_identity?, billing? } is always present; `billing` may be omitted;
 *   `tee_verified` only when `verify_tee: true` was sent.
 *   https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions
 *   https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution
 * - `X-Request-ID` response header = x_0g_trace.request_id; `X-Client-Request-Id` request header (printable ASCII,
 *   ≤ 512 chars) is echoed back (beta); `X-0G-Provider-Trust-Mode: standard|verified|private`.
 *   https://0gfoundation.github.io/0g-router/ (API reference) and …/router/privacy
 * - `ZG-Res-Key` response header carries the chatID for independent TEE signature checks (verifiable-execution page).
 * - Thinking: `reasoning_content` on the message; `chat_template_kwargs: {enable_thinking:false}` for models that list
 *   `chat_template_kwargs` (0gm-1.0-35b-a3b); top-level `enable_thinking:false` for Qwen models that list it; glm-5.3-flash
 *   cannot disable thinking. Source: live GET /v1/models `supported_parameters`, 3 Nov 2026.
 *
 * This module never invents an answer: any failure is returned as `ok:false` with an error string, and the caller turns
 * it into a failsafe decision.
 */
import type { Checkpoint } from "../shared/types.js";

export type TrustMode = "standard" | "verified" | "private";

export interface RouterConfig {
  baseUrl: string; // e.g. https://router-api.0g.ai/v1 ; the Cut-0G switch replaces it with the blackhole URL
  apiKey: string;
  model: string;
  trustMode: TrustMode;
  timeoutMs: number;
  verifyTee: boolean;
  maxTokens: number;
}

export interface DecisionRequest {
  checkpoint: Checkpoint;
  systemPrompt: string;
  /** JSON-serialisable context: task, telemetry, scene (sim) or event (incident). */
  context: unknown;
  /** JPEG bytes as a data URL, or null when CAMERA_SOURCE=none. */
  imageDataUrl: string | null;
  clientRequestId: string;
}

export interface RouterTrace {
  model: string | null;
  requestId: string | null;
  httpRequestId: string | null;
  clientRequestIdEchoed: boolean | null;
  provider: string | null;
  providerIdentity: string | null;
  teeVerified: boolean | null;
  cost: string | null;
  zgResKey: string | null;
  reasoning: string | null;
}

export type RouterResult =
  | ({ ok: true; content: string; latencyMs: number; status: number } & RouterTrace)
  | ({ ok: false; error: string; latencyMs: number; status: number | null } & RouterTrace);

const EMPTY_TRACE: RouterTrace = {
  model: null,
  requestId: null,
  httpRequestId: null,
  clientRequestIdEchoed: null,
  provider: null,
  providerIdentity: null,
  teeVerified: null,
  cost: null,
  zgResKey: null,
  reasoning: null,
};

const REASONING_MAX = 2000;

/** Model-specific switches to turn thinking off, only where the live model card lists the parameter. */
export function thinkingOffParams(model: string): Record<string, unknown> {
  if (model.startsWith("0gm-")) return { chat_template_kwargs: { enable_thinking: false } };
  if (model.startsWith("qwen3")) return { enable_thinking: false };
  return {};
}

export function buildBody(cfg: RouterConfig, req: DecisionRequest): Record<string, unknown> {
  const userText = JSON.stringify({ checkpoint: req.checkpoint, ...asObject(req.context) });
  const content: unknown[] = [{ type: "text", text: userText }];
  if (req.imageDataUrl) content.push({ type: "image_url", image_url: { url: req.imageDataUrl } });
  return {
    model: cfg.model,
    messages: [
      { role: "system", content: req.systemPrompt },
      { role: "user", content },
    ],
    temperature: 0,
    max_tokens: cfg.maxTokens,
    response_format: { type: "json_object" },
    ...(cfg.verifyTee ? { verify_tee: true } : {}),
    ...thinkingOffParams(cfg.model),
  };
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { context: v };
}

/**
 * The gateway can return two X-Request-Id headers (gateway hex + router UUID); fetch joins them with ", ".
 * Prefer the one equal to the body's request_id, else the last one.
 */
export function pickHttpRequestId(header: string | null, bodyId: string | null): string | null {
  if (!header) return null;
  const parts = header.split(",").map((s) => s.trim()).filter(Boolean);
  if (bodyId && parts.includes(bodyId)) return bodyId;
  return parts.at(-1) ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function extractTrace(body: unknown, headers: Headers, sentClientId: string): RouterTrace {
  const b = (body ?? {}) as Record<string, any>;
  const trace = (b.x_0g_trace ?? {}) as Record<string, any>;
  const msg = (b.choices?.[0]?.message ?? {}) as Record<string, any>;
  const requestId = str(trace.request_id) ?? str(b.request_id);
  const echoed = headers.get("x-client-request-id");
  const reasoning =
    str(msg.reasoning_content) ?? str(msg.provider_specific_fields?.reasoning_content);
  const tee = b.tee_verified ?? trace.tee_verified;
  return {
    model: str(b.model),
    requestId,
    httpRequestId: pickHttpRequestId(headers.get("x-request-id"), requestId),
    clientRequestIdEchoed: echoed === null ? false : echoed === sentClientId,
    provider: str(trace.provider),
    providerIdentity: str(trace.provider_identity),
    teeVerified: typeof tee === "boolean" ? tee : null,
    cost: trace.billing?.total_cost != null ? String(trace.billing.total_cost) : null,
    zgResKey: headers.get("zg-res-key"),
    reasoning: reasoning ? reasoning.slice(0, REASONING_MAX) : null,
  };
}

export async function callRouter(
  cfg: RouterConfig,
  req: DecisionRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RouterResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": req.clientRequestId,
        "X-0G-Provider-Trust-Mode": cfg.trustMode,
      },
      body: JSON.stringify(buildBody(cfg, req)),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = ac.signal.aborted;
    return {
      ok: false,
      error: aborted ? `timeout after ${cfg.timeoutMs} ms` : `network error: ${errMsg(e)}`,
      latencyMs: ms(),
      status: null,
      ...EMPTY_TRACE,
    };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    const aborted = ac.signal.aborted;
    return {
      ok: false,
      error: aborted ? `timeout after ${cfg.timeoutMs} ms (reading body)` : `body read error: ${errMsg(e)}`,
      latencyMs: ms(),
      status: res.status,
      ...extractTrace(null, res.headers, req.clientRequestId),
    };
  }
  clearTimeout(timer);

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body (gateway HTML, empty): handled below
  }
  const trace = extractTrace(body, res.headers, req.clientRequestId);

  if (!res.ok) {
    const err = (body as any)?.error;
    const code = str(err?.code) ?? str(err?.type) ?? "unknown";
    const message = str(err?.message) ?? text.slice(0, 200);
    return { ok: false, error: `HTTP ${res.status} ${code}: ${message}`, latencyMs: ms(), status: res.status, ...trace };
  }
  const content = (body as any)?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "response has no message content", latencyMs: ms(), status: res.status, ...trace };
  }
  return { ok: true, content, latencyMs: ms(), status: res.status, ...trace };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
  }
  return String(e);
}
