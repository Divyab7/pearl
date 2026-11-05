/**
 * Mocks of the 0G HTTP call live only in this test file (prompt hard rule 3). Response shapes follow the 0G docs:
 * x_0g_trace { request_id, provider, billing }, tee_verified, X-Request-ID / X-Client-Request-Id / ZG-Res-Key headers,
 * error body { error: { message, type, code }, request_id }.
 */
import { describe, expect, it } from "vitest";
import { buildBody, pickHttpRequestId, thinkingOffParams, type RouterConfig } from "../og/router.js";
import { decide, stripFence } from "./decision.js";

const cfg: RouterConfig = {
  baseUrl: "https://router.test/v1",
  apiKey: "sk-test",
  model: "glm-5.3-flash",
  trustMode: "verified",
  timeoutMs: 200,
  verifyTee: true,
  maxTokens: 1000,
};
const req = {
  checkpoint: "PLAN" as const,
  systemPrompt: "sys",
  context: { task: { color: "red" } },
  imageDataUrl: null,
  clientRequestId: "ep_1:0:PLAN",
};
const RID = "0852f405-6c56-40c2-a800-e6fd70785065";

function okBody(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: "glm-5.3-flash",
    choices: [{ message: { role: "assistant", content, reasoning_content: "thinking..." } }],
    x_0g_trace: {
      request_id: RID,
      provider: "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",
      provider_identity: "baidu",
      billing: { input_cost: "1", output_cost: "2", total_cost: "3" },
    },
    tee_verified: true,
    ...extra,
  };
}

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const sent = new Headers(init?.headers);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": `70d8ec3d21ba9db5, ${RID}`,
        "x-client-request-id": sent.get("x-client-request-id") ?? "",
        "zg-res-key": "chat-abc",
        ...headers,
      },
    });
  }) as typeof fetch;
}

const GOOD = JSON.stringify({ action: "PICK", slot: "A2", reason: "red cube at A2", confidence: 0.92 });

function expectFailsafe(d: Awaited<ReturnType<typeof decide>>) {
  expect(d.source).toBe("failsafe");
  expect(d.model).toBeNull();
  expect(d.parsed).toBeNull();
  expect(d.raw).toBeNull();
  expect(typeof d.error).toBe("string");
  expect(d.error!.length).toBeGreaterThan(0);
}

describe("decide: the 0G path", () => {
  it("records every id from a good answer", async () => {
    const d = await decide(cfg, req, fakeFetch(200, okBody(GOOD)));
    expect(d.source).toBe("0g");
    expect(d.model).toBe("glm-5.3-flash");
    expect(d.requestId).toBe(RID);
    expect(d.httpRequestId).toBe(RID); // picked from the two joined X-Request-Id headers
    expect(d.clientRequestIdEchoed).toBe(true);
    expect(d.teeVerified).toBe(true);
    expect(d.cost).toBe("3");
    expect(d.providerIdentity).toBe("baidu");
    expect(d.zgResKey).toBe("chat-abc");
    expect(d.reasoning).toBe("thinking...");
    expect(d.parsed).toEqual(JSON.parse(GOOD));
    expect(d.error).toBeNull();
  });

  it("accepts an answer wrapped in a ```json fence (the only repair)", async () => {
    const d = await decide(cfg, req, fakeFetch(200, okBody("```json\n" + GOOD + "\n```")));
    expect(d.source).toBe("0g");
  });

  it("treats a missing billing block as null cost, not an error", async () => {
    const body = okBody(GOOD);
    delete (body.x_0g_trace as Record<string, unknown>).billing;
    const d = await decide(cfg, req, fakeFetch(200, body));
    expect(d.source).toBe("0g");
    expect(d.cost).toBeNull();
  });
});

describe("decide: failsafe on every failure", () => {
  it("timeout", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const d = await decide({ ...cfg, timeoutMs: 30 }, req, hang);
    expectFailsafe(d);
    expect(d.error).toMatch(/timeout after 30 ms/);
  });

  it("network error (unreachable / Cut-0G)", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch;
    const d = await decide(cfg, req, down);
    expectFailsafe(d);
    expect(d.error).toMatch(/network error: fetch failed \(connect ECONNREFUSED\)/);
  });

  it("HTTP error: 402 insufficient balance keeps the request id", async () => {
    const body = {
      error: { message: "Insufficient balance to process request", type: "payment_error", code: "insufficient_balance" },
      request_id: RID,
    };
    const d = await decide(cfg, req, fakeFetch(402, body));
    expectFailsafe(d);
    expect(d.error).toBe("HTTP 402 insufficient_balance: Insufficient balance to process request");
    expect(d.requestId).toBe(RID);
  });

  it("HTTP error: gateway 401 without a code", async () => {
    const d = await decide(cfg, req, fakeFetch(401, { _0g: { source: "gateway" }, error: { message: "missing API key", type: "gateway_error" } }));
    expectFailsafe(d);
    expect(d.error).toBe("HTTP 401 gateway_error: missing API key");
  });

  it("bad JSON", async () => {
    const d = await decide(cfg, req, fakeFetch(200, okBody("Sure! I think you should pick A2.")));
    expectFailsafe(d);
    expect(d.error).toMatch(/^invalid JSON from model/);
    expect(d.requestId).toBe(RID);
  });

  it("schema failure (extra key, raw angles)", async () => {
    const bad = JSON.stringify({ action: "PICK", slot: "A2", reason: "x", confidence: 0.9, joints: [1, 2, 3, 4] });
    const d = await decide(cfg, req, fakeFetch(200, okBody(bad)));
    expectFailsafe(d);
    expect(d.error).toMatch(/^schema check failed/);
  });

  it("tee_verified:false", async () => {
    const d = await decide(cfg, req, fakeFetch(200, okBody(GOOD, { tee_verified: false })));
    expectFailsafe(d);
    expect(d.error).toMatch(/tee_verified:false/);
  });

  it("empty content", async () => {
    const d = await decide(cfg, req, fakeFetch(200, okBody("")));
    expectFailsafe(d);
  });

  it("non-JSON error page", async () => {
    const d = await decide(cfg, req, fakeFetch(503, "<html>bad gateway</html>", { "content-type": "text/html" }));
    expectFailsafe(d);
    expect(d.error).toMatch(/^HTTP 503 unknown: <html>/);
  });
});

describe("request building", () => {
  it("sends the documented fields and headers", async () => {
    let seenUrl = "";
    let seenHeaders = new Headers();
    let seenBody: any = null;
    const spy = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = new Headers(init?.headers);
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(okBody(GOOD)), { status: 200 });
    }) as typeof fetch;
    await decide({ ...cfg, model: "0gm-1.0-35b-a3b", trustMode: "private" }, { ...req, imageDataUrl: "data:image/jpeg;base64,AAAA" }, spy);
    expect(seenUrl).toBe("https://router.test/v1/chat/completions");
    expect(seenHeaders.get("authorization")).toBe("Bearer sk-test");
    expect(seenHeaders.get("x-client-request-id")).toBe("ep_1:0:PLAN");
    expect(seenHeaders.get("x-0g-provider-trust-mode")).toBe("private");
    expect(seenBody.temperature).toBe(0);
    expect(seenBody.verify_tee).toBe(true);
    expect(seenBody.response_format).toEqual({ type: "json_object" });
    expect(seenBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seenBody.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
  });

  it("only adds thinking switches the model card lists", () => {
    expect(thinkingOffParams("glm-5.3-flash")).toEqual({});
    expect(thinkingOffParams("qwen3.8-flash")).toEqual({ enable_thinking: false });
    expect(buildBody({ ...cfg, verifyTee: false }, req)).not.toHaveProperty("verify_tee");
  });

  it("helpers", () => {
    expect(stripFence("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripFence(' {"a":1} ')).toBe('{"a":1}');
    expect(pickHttpRequestId("aaa, bbb", "aaa")).toBe("aaa");
    expect(pickHttpRequestId("aaa, bbb", null)).toBe("bbb");
    expect(pickHttpRequestId(null, "x")).toBeNull();
  });
});
