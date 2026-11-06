/**
 * Model fallback (owner request 7 Nov 2026): the primary 0G model failing on the provider side hands the same request to
 * the next model, inside the one time budget; every call is recorded; nothing is ever made up.
 * Mocks of the 0G HTTP call live only in test files (prompt hard rule 3).
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { isProviderFailure, type RouterConfig } from "../og/router.js";
import { DEFAULT_FALLBACK_MODELS, parseFallbacks } from "../og/config.js";
import { decide, modelsOf, type DecisionCore } from "./decision.js";
import { EpisodeRecorder } from "./log.js";
import { policyPlan, commandsOf } from "./policy.js";
import { Poses } from "./poses.js";
import { loadArmConfig } from "../shared/armConfig.js";
import { hashCanonical } from "../shared/hash.js";
import { headMessage } from "../shared/deviceKey.js";
import { contentChecks, recomputeChain, requestIdsHashOf, requestIdsOfLog } from "../verify/content.js";

const cfg: RouterConfig = {
  baseUrl: "https://router.test/v1",
  apiKey: "sk-test",
  model: "0gm-1.0-35b-a3b",
  fallbackModels: ["qwen2.5-vl-72b-instruct", "gemini-2.5-flash-lite"],
  trustMode: "verified",
  timeoutMs: 300,
  verifyTee: true,
  maxTokens: 1000,
};
const req = {
  checkpoint: "PLAN" as const,
  systemPrompt: "sys",
  context: { task: { color: "red" } },
  imageDataUrl: "data:image/jpeg;base64,AAAA",
  clientRequestId: "ep_f:0:PLAN",
};
const GOOD = JSON.stringify({ action: "PICK", slot: "A2", reason: "red cube at A2", confidence: 0.92 });

type Reply = { status: number; body: unknown } | "hang" | "down";
interface Seen { model: string; trust: string | null; image: unknown; system: unknown }

/** A fake router: replies per model name, records what each call sent. */
function router(replies: Record<string, Reply>) {
  const seen: Seen[] = [];
  const f = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const h = new Headers(init?.headers);
    seen.push({ model: body.model, trust: h.get("x-0g-provider-trust-mode"), image: body.messages[1].content[1], system: body.messages[0].content });
    const r = replies[body.model] ?? { status: 500, body: { error: { message: "no reply set", code: "x" } } };
    if (r === "down") throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    if (r === "hang") {
      return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "x-client-request-id": h.get("x-client-request-id") ?? "" } });
  }) as typeof fetch;
  return { f, seen };
}
const answer = (model: string, rid: string, content = GOOD) => ({
  status: 200,
  body: { model, choices: [{ message: { role: "assistant", content } }], x_0g_trace: { request_id: rid, provider: "0xabc" }, tee_verified: true },
});
const err = (status: number, code: string, message: string, rid: string | null = null) => ({
  status, body: { error: { message, type: "server_error", code }, ...(rid ? { request_id: rid } : {}) },
});
const E502 = err(502, "provider_error", "fetch provider quote: EOF", "rid-primary");
const E503 = err(503, "no_provider_for_trust_mode", "no provider available for the requested trust mode: tier=verified", "rid-q");

function expectFailsafe(d: DecisionCore) {
  expect(d.source).toBe("failsafe");
  expect(d.model).toBeNull();
  expect(d.parsed).toBeNull();
  expect(d.raw).toBeNull();
  expect(d.error).toBeTruthy();
}

describe("config", () => {
  it("OG_MODEL_FALLBACKS: unset → default list, empty → none, comma list trimmed", () => {
    expect(parseFallbacks(undefined)).toEqual(DEFAULT_FALLBACK_MODELS);
    expect(parseFallbacks("")).toEqual([]);
    expect(parseFallbacks(" a , b,,a ")).toEqual(["a", "b", "a"]);
    expect(modelsOf({ ...cfg, fallbackModels: ["0gm-1.0-35b-a3b", "a", "", "a"] })).toEqual(["0gm-1.0-35b-a3b", "a"]);
  });

  it("which failures are on the provider side", () => {
    const f = (status: number | null, errorCode: string | null) =>
      isProviderFailure({ ok: false, error: "e", errorCode, status, latencyMs: 1, model: null, requestId: null, httpRequestId: null, clientRequestIdEchoed: null, provider: null, providerIdentity: null, teeVerified: null, cost: null, zgResKey: null, reasoning: null });
    expect([f(null, null), f(502, "x"), f(503, "no_provider_for_trust_mode"), f(500, null), f(429, "rate_limited")]).toEqual([true, true, true, true, true]);
    expect([f(400, "invalid_request"), f(401, null), f(402, "insufficient_balance"), f(403, null), f(404, "model_not_found")]).toEqual([false, false, false, false, false]);
    expect(f(400, "no_available_provider")).toBe(true);
  });
});

describe("decide with fallbacks", () => {
  it("primary 502 → the first fallback answers; the decision is from it and every call is recorded", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": E502, "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    const d = await decide(cfg, req, f);
    expect(d.source).toBe("0g");
    expect(d.model).toBe("qwen2.5-vl-72b-instruct");
    expect(d.requestId).toBe("rid-fb");
    expect(d.parsed).toEqual(JSON.parse(GOOD));
    expect(d.error).toBeNull();
    expect(d.attempts!.map((a) => [a.model, a.status, a.requestId, a.error === null])).toEqual([
      ["0gm-1.0-35b-a3b", 502, "rid-primary", false],
      ["qwen2.5-vl-72b-instruct", 200, "rid-fb", true],
    ]);
    expect(d.attempts![0]!.error).toMatch(/^HTTP 502 provider_error: fetch provider quote: EOF/);
    // same prompt, same image, same trust mode on every call
    expect(seen.map((s) => s.model)).toEqual(["0gm-1.0-35b-a3b", "qwen2.5-vl-72b-instruct"]);
    expect(new Set(seen.map((s) => JSON.stringify([s.trust, s.image, s.system]))).size).toBe(1);
    expect(seen[0]!.trust).toBe("verified");
  });

  it("network error and no_provider_for_trust_mode both move on to the next model", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": "down", "qwen2.5-vl-72b-instruct": E503, "gemini-2.5-flash-lite": answer("gemini-2.5-flash-lite", "rid-g") });
    const d = await decide(cfg, req, f);
    expect(d.source).toBe("0g");
    expect(d.model).toBe("gemini-2.5-flash-lite");
    expect(seen).toHaveLength(3);
    expect(d.attempts![0]!.status).toBeNull();
  });

  it("every model fails → FAILSAFE, with every call recorded and no invented answer", async () => {
    const { f } = router({ "0gm-1.0-35b-a3b": E502, "qwen2.5-vl-72b-instruct": E503, "gemini-2.5-flash-lite": err(429, "rate_limited", "slow down") });
    const d = await decide(cfg, req, f);
    expectFailsafe(d);
    expect(d.attempts).toHaveLength(3);
    expect(d.error).toMatch(/^all 3 models failed; last \(gemini-2.5-flash-lite\): HTTP 429 rate_limited/);
    const p = policyPlan(d, { task: "pick", color: "red", from: "A2", to: "BIN" }, new Poses(loadArmConfig()));
    expect(p.outcome).toBe("FAILSAFE");
    expect(commandsOf(p.steps)).toEqual(["safe"]);
  });

  it("400 from the primary → no fallback (a fault in our request)", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": err(400, "invalid_request", "bad image"), "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    const d = await decide(cfg, req, f);
    expectFailsafe(d);
    expect(seen).toHaveLength(1);
    expect(d.attempts).toBeUndefined();
    expect(d.error).toBe("HTTP 400 invalid_request: bad image");
  });

  it("402 from the primary → no fallback", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": err(402, "insufficient_balance", "top up"), "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    expectFailsafe(await decide(cfg, req, f));
    expect(seen).toHaveLength(1);
  });

  it("an invalid answer from the primary → no fallback (never shop for a better answer)", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": answer("0gm-1.0-35b-a3b", "rid-p", "Sure, pick A2"), "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    const d = await decide(cfg, req, f);
    expectFailsafe(d);
    expect(d.error).toMatch(/^invalid JSON from model/);
    expect(seen).toHaveLength(1);
  });

  it("an invalid answer from a fallback → FAILSAFE, the calls still recorded", async () => {
    const bad = JSON.stringify({ action: "PICK", slot: "A2", reason: "x", confidence: 0.9, joints: [1, 2, 3, 4] });
    const { f } = router({ "0gm-1.0-35b-a3b": E502, "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb", bad) });
    const d = await decide(cfg, req, f);
    expectFailsafe(d);
    expect(d.error).toMatch(/^schema check failed/);
    expect(d.requestId).toBe("rid-fb");
    expect(d.attempts).toHaveLength(2);
  });

  it("primary hangs → the budget is used up → FAILSAFE without asking another model", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": "hang", "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    const t0 = performance.now();
    const d = await decide({ ...cfg, timeoutMs: 60 }, req, f);
    expect(performance.now() - t0).toBeLessThan(60 + 100);
    expectFailsafe(d);
    expect(seen).toHaveLength(1);
    expect(d.error).toMatch(/^time budget of 60 ms used up after 1 model; last \(0gm-1.0-35b-a3b\): timeout after/);
  });

  it("a fallback gets only what is left of the budget", async () => {
    let n = 0;
    const slow502 = (async (_u: unknown, init?: RequestInit) => {
      n++;
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify(E502.body), { status: 502 });
      }
      return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    }) as typeof fetch;
    const t0 = performance.now();
    const d = await decide({ ...cfg, timeoutMs: 120 }, req, slow502);
    const took = performance.now() - t0;
    expect(took).toBeLessThan(120 + 60);
    expectFailsafe(d);
    expect(d.error).toMatch(/^time budget of 120 ms used up after 2 models/);
    expect(d.attempts).toHaveLength(2);
    expect(n).toBe(2);
  });

  it("no fallbacks configured → exactly today's behaviour (one call, no attempts field)", async () => {
    const { f, seen } = router({ "0gm-1.0-35b-a3b": E502 });
    const d = await decide({ ...cfg, fallbackModels: [] }, req, f);
    expectFailsafe(d);
    expect(seen).toHaveLength(1);
    expect(d.attempts).toBeUndefined();
    expect(d.error).toBe("HTTP 502 provider_error: fetch provider quote: EOF");
  });
});

describe("a fallback decision in the signed log", () => {
  it("hash chain, robot signature, request ids, provenance and policy replay all pass", async () => {
    const arm = loadArmConfig();
    const task = { task: "pick" as const, color: "red", from: "A2" as const, to: "BIN" as const };
    const { f } = router({ "0gm-1.0-35b-a3b": E502, "qwen2.5-vl-72b-instruct": answer("qwen2.5-vl-72b-instruct", "rid-fb") });
    const allFail = router({ "0gm-1.0-35b-a3b": E502, "qwen2.5-vl-72b-instruct": E503, "gemini-2.5-flash-lite": E503 });
    const rec = new EpisodeRecorder("ep_fb_1", "sim", "arm-1", task);
    rec.addEvent({ ts: "2026-11-07T00:00:00.000Z", ev: "episode_start", data: { armConfigHash: hashCanonical(arm) } });
    const poses = new Poses(arm);
    for (const fetchImpl of [f, allFail.f]) {
      const d = await decide(cfg, req, fetchImpl);
      const p = policyPlan(d, task, poses);
      rec.addDecision({
        ...d, ts: "2026-11-07T00:00:01.000Z", promptHash: "a".repeat(64), frameHash: null, frameRoot: null,
        telemetry: { state: "WAITING", joints: [90, 90, 90, 10], tofMm: 600, accG: 1 },
        policy: p.policy, override: p.override, commandsSent: commandsOf(p.steps),
      });
    }
    const log = rec.close("FAILSAFE");
    const wallet = ethers.Wallet.createRandom();
    const sig = await wallet.signMessage(headMessage(log.episodeId, log.headHash));
    expect(ethers.verifyMessage(headMessage(log.episodeId, log.headHash), sig)).toBe(wallet.address);

    // the record went through canonical JSON with its attempts intact
    const r1 = log.records[1] as unknown as DecisionCore;
    expect(r1.attempts!.map((a) => a.model)).toEqual(["0gm-1.0-35b-a3b", "qwen2.5-vl-72b-instruct"]);
    expect(recomputeChain(JSON.parse(JSON.stringify(log))).ok).toBe(true);
    // the anchored request ids are the decisions' ids (as before); a failed attempt's id stays in attempts only
    const ids = requestIdsOfLog(log);
    expect(ids).toEqual(["rid-fb", "rid-q"]);
    const cs = contentChecks(log, { headerHead: log.headHash, anchoredRequestIdsHash: requestIdsHashOf(ids), arm });
    expect(cs.map((c) => [c.id, c.status])).toEqual([[6, "PASS"], [7, "PASS"], [8, "PASS"], [9, "PASS"]]);
  });
});
