import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACR_ORB, basicAuth, validateIdToken, WorldIdGate, type WorldIdConfig } from "./worldid.js";

const ISS = "https://auth.world.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };

const cfg: WorldIdConfig = {
  issuer: ISS, clientId: "client-1", clientSecret: "worldidp_client_secret_x", acr: [ACR_ORB],
  timeoutS: 60, requireProof: true, operators: [],
};

function jwt(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey; alg?: string } = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}

const NOW = 1_800_000_000;
const good = (over: Record<string, unknown> = {}) => ({
  iss: ISS, sub: "pairwise-abc", aud: "client-1", exp: NOW + 300, iat: NOW, jti: "j1",
  auth_time: NOW, acr: ACR_ORB, amr: ["pop"], ...over,
});

describe("World ID ID-token validation", () => {
  it("accepts a fresh, signed Orb proof for this client", () => {
    const v = validateIdToken(jwt(good()), JWKS, cfg, NOW - 5, NOW);
    expect(v).toMatchObject({ ok: true, claims: { sub: "pairwise-abc", acr: ACR_ORB } });
  });

  const bad: [string, string, () => string, Partial<WorldIdConfig>?][] = [
    ["signature by another key", "bad signature", () => jwt(good(), { key: other.privateKey })],
    ["unknown kid", "unknown kid", () => jwt(good(), { kid: "k9" })],
    ["alg none", "not RS256", () => jwt(good(), { alg: "none" })],
    ["another issuer", "iss", () => jwt(good({ iss: "https://evil.test" }))],
    ["another client", "aud", () => jwt(good({ aud: "client-2" }))],
    ["expired", "expired", () => jwt(good({ exp: NOW - 100 }))],
    ["authentication before the request (not fresh)", "not fresh", () => jwt(good({ auth_time: NOW - 600 }))],
    ["no acr (unverified account)", "acr missing", () => jwt(good({ acr: undefined }))],
    ["passkey instead of a World proof", "not a fresh World ID proof", () => jwt(good({ amr: ["pop", "user", "mfa"] }))],
    ["not an enrolled operator", "not an enrolled operator", () => jwt(good()), { operators: ["someone-else"] }],
  ];
  for (const [name, why, make, over] of bad) {
    it(`rejects: ${name}`, () => {
      const v = validateIdToken(make(), JWKS, { ...cfg, ...over }, NOW - 5, NOW);
      expect(v.ok).toBe(false);
      expect(v.ok ? "" : v.reason).toContain(why);
    });
  }

  it("client_secret_basic form-encodes id and secret", () => {
    expect(basicAuth("a b", "c:d")).toBe(`Basic ${Buffer.from("a+b:c%3Ad").toString("base64")}`);
  });
});

/** Fake World IdP: discovery, JWKS, device authorization, and a scripted token endpoint. */
function fakeIdp(script: (n: number) => { status: number; body: Record<string, unknown> }) {
  const calls: { url: string; form: URLSearchParams; auth: string | null }[] = [];
  let polls = 0;
  const f = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const form = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url: u, form, auth: new Headers(init?.headers).get("authorization") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/.well-known/openid-configuration")) {
      return json(200, { issuer: ISS, token_endpoint: `${ISS}/api/v1/token`, device_authorization_endpoint: `${ISS}/api/v1/device_authorization`, jwks_uri: `${ISS}/.well-known/jwks.json` });
    }
    if (u.endsWith("/jwks.json")) return json(200, JWKS);
    if (u.endsWith("/device_authorization")) {
      return json(200, { device_code: "dc-secret", user_code: "WXYZ-1234", verification_uri: `${ISS}/device`, verification_uri_complete: `${ISS}/device?user_code=WXYZ-1234`, expires_in: 1200, interval: 1 });
    }
    if (u.endsWith("/token")) {
      const s = script(++polls);
      return json(s.status, s.body);
    }
    return json(404, {});
  }) as typeof fetch;
  return { f, calls };
}

const run = async (script: Parameters<typeof fakeIdp>[0], over: Partial<WorldIdConfig> = {}, onPrompt = (_p: unknown) => {}) => {
  const idp = fakeIdp(script);
  let now = NOW;
  const gate = new WorldIdGate({ ...cfg, ...over }, idp.f, async (ms) => void (now += Math.ceil(ms / 1000)), () => now);
  const r = await gate.verify({ reason: "sign in" }, (p) => onPrompt(p));
  return { r, idp, gate };
};

describe("World ID device flow gate", () => {
  it("approve: pending, slow_down, then a valid token → passed with the pairwise subject and token hash", async () => {
    const prompts: unknown[] = [];
    const { r, idp } = await run(
      (n) => (n === 1 ? { status: 400, body: { error: "authorization_pending" } }
        : n === 2 ? { status: 400, body: { error: "slow_down" } }
        : { status: 200, body: { id_token: jwt(good({ auth_time: NOW + 3 })), access_token: "at", token_type: "Bearer" } }),
      {},
      (p) => prompts.push(p),
    );
    expect(r).toMatchObject({ ok: true, provider: "World ID", subject: "pairwise-abc", acr: ACR_ORB, issuer: ISS });
    expect(r.ok && r.idTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prompts[0]).toMatchObject({ userCode: "WXYZ-1234", verificationUri: `${ISS}/device?user_code=WXYZ-1234` });
    expect(JSON.stringify(prompts)).not.toContain("dc-secret"); // the device_code never leaves the backend
    const start = idp.calls.find((c) => c.url.endsWith("/device_authorization"))!;
    expect(start.auth).toBe(basicAuth("client-1", cfg.clientSecret));
    expect(JSON.parse(start.form.get("claims")!)).toEqual({ id_token: { acr: { essential: true, values: [ACR_ORB] } } });
    const polls = idp.calls.filter((c) => c.url.endsWith("/token"));
    expect(polls).toHaveLength(3);
    expect(polls[0]!.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("denied in World App → denied, no approval", async () => {
    const { r } = await run(() => ({ status: 400, body: { error: "access_denied" } }));
    expect(r).toMatchObject({ ok: false, reason: "denied", detail: "access_denied" });
  });

  it("World's code expires → expired", async () => {
    const { r } = await run(() => ({ status: 400, body: { error: "expired_token" } }));
    expect(r).toMatchObject({ ok: false, reason: "expired" });
  });

  it("nobody answers before our deadline → expired", async () => {
    const { r } = await run(() => ({ status: 400, body: { error: "authorization_pending" } }), { timeoutS: 10 });
    expect(r).toMatchObject({ ok: false, reason: "expired", detail: "no approval before the deadline" });
  });

  it("a token that fails validation → invalid (never treated as approval)", async () => {
    const { r } = await run(() => ({ status: 200, body: { id_token: jwt(good({ aud: "someone-else" })) } }));
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("World ID unavailable (503) → error", async () => {
    const { r } = await run(() => ({ status: 503, body: {} }));
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });

  it("operator cancels from the dashboard → cancelled", async () => {
    let gateRef: WorldIdGate | null = null;
    let attempt = "";
    const idp = fakeIdp(() => {
      gateRef!.cancel(attempt);
      return { status: 400, body: { error: "authorization_pending" } };
    });
    let now = NOW;
    gateRef = new WorldIdGate(cfg, idp.f, async (ms) => void (now += Math.ceil(ms / 1000)), () => now);
    const r = await gateRef.verify({ reason: "x" }, (p) => (attempt = p.attemptId));
    expect(r).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
