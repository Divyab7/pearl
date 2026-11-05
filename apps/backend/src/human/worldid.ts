/**
 * World ID Agent Pass (World IdP, OpenID Connect): dashboard sign-in and the fresh check before a reward claim (rev 5).
 * Docs: https://auth.world.org/docs (guides: oidc → Device Authorization Grant, step-up, id-token),
 * discovery https://auth.world.org/.well-known/openid-configuration (read 4 Nov 2026).
 *
 * Flow: OAuth 2.0 Device Authorization Grant (RFC 8628), because the robot's dashboard runs on localhost and World IdP
 * does not accept http://localhost callbacks; the device grant needs no callback and "fresh authentication is required
 * regardless" (oidc guide). The backend is a confidential client (client_secret_basic):
 *   1. POST device_authorization  scope=openid, claims={"id_token":{"acr":{"essential":true,"values":[...]}}}
 *   2. the dashboard shows verification_uri_complete + user_code; the person approves in World App
 *   3. the backend polls the token endpoint every `interval` s (+5 s on slow_down) until tokens, an error, or expiry
 *   4. the ID token is validated here: RS256 signature against the JWKS (kid), iss, aud, exp/iat, auth_time after the
 *      attempt started (fresh), acr among the requested classes, amr carrying a World proof ("pop"), optional
 *      operator allowlist on the pairwise sub. The device ID token has no nonce (documented).
 * Anything else — access_denied, expired_token, invalid_grant, 429/503, a bad token, operator cancel, our timeout — is
 * a failure: the sign-in or the claim does not go ahead. Secrets, device_code and tokens are never logged or sent to the dashboard.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { envFlag, loadEnv } from "../shared/env.js";
import type { HumanCheckFailure, HumanCheckPrompt, HumanCheckRequest, HumanCheckResult, HumanGate } from "./gate.js";
import { errMsg } from "../shared/util.js";

export const ACR_ORB = "https://world.org/oidc/acr/orb";
export const ACR_SELFIE = "https://world.org/oidc/acr/selfie";
const SKEW_S = 30;

export interface WorldIdConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  acr: string[];
  /** Our own cap on how long the person has (World's device code lives 20 min). */
  timeoutS: number;
  /** Require a World ID proof in amr ("pop", and not a passkey-only login). */
  requireProof: boolean;
  /** If non-empty, only these pairwise subjects may approve (enrolled operators). */
  operators: string[];
}

export function worldIdConfigFromEnv(): WorldIdConfig {
  loadEnv();
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    issuer: process.env.WORLDID_ISSUER ?? "https://auth.world.org",
    clientId: process.env.WORLDID_CLIENT_ID ?? "",
    clientSecret: process.env.WORLDID_CLIENT_SECRET ?? "",
    acr: list(process.env.WORLDID_ACR).length ? list(process.env.WORLDID_ACR) : [ACR_ORB, ACR_SELFIE],
    timeoutS: Math.min(1200, Number(process.env.WORLDID_TIMEOUT_S ?? 180)),
    requireProof: envFlag("WORLDID_REQUIRE_PROOF", "on"),
    operators: list(process.env.WORLDID_OPERATOR_SUBS),
  };
}

export const worldIdConfigured = (c: WorldIdConfig) => c.clientId.length > 0 && c.clientSecret.length > 0;

interface Discovery {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  jwks_uri: string;
}

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** RFC 6749 §2.3.1: client id and secret are form-urlencoded before Basic encoding. */
export function basicAuth(id: string, secret: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${enc(id)}:${enc(secret)}`).toString("base64")}`;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  auth_time?: number;
  acr?: string;
  amr?: string[];
  nonce?: string;
  jti?: string;
}

/** Validates a World ID ID token. Returns the claims or a reason (never throws for a bad token). */
export function validateIdToken(
  token: string,
  jwks: { keys: (JsonWebKey & { kid?: string })[] },
  c: Pick<WorldIdConfig, "issuer" | "clientId" | "acr" | "requireProof" | "operators">,
  attemptStartS: number,
  nowS: number,
): { ok: true; claims: IdTokenClaims } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a compact JWT" };
  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(fromB64url(parts[0]!).toString("utf8"));
    claims = JSON.parse(fromB64url(parts[1]!).toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable JWT" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: `alg ${header.alg} is not RS256` };
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? (header.kid === undefined && jwks.keys.length === 1 ? jwks.keys[0] : undefined);
  if (!jwk) return { ok: false, reason: `unknown kid ${header.kid}` };
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!cryptoVerify("RSA-SHA256", signed, key, fromB64url(parts[2]!))) return { ok: false, reason: "bad signature" };
  if (claims.iss !== c.issuer) return { ok: false, reason: `iss ${claims.iss}` };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.clientId)) return { ok: false, reason: "aud is not this client" };
  if (typeof claims.exp !== "number" || claims.exp <= nowS - SKEW_S) return { ok: false, reason: "expired ID token" };
  if (typeof claims.iat !== "number" || claims.iat > nowS + SKEW_S) return { ok: false, reason: "iat in the future" };
  if (typeof claims.auth_time !== "number") return { ok: false, reason: "no auth_time" };
  if (claims.auth_time < attemptStartS - SKEW_S) return { ok: false, reason: "authentication is older than this request (not fresh)" };
  if (claims.auth_time > nowS + SKEW_S) return { ok: false, reason: "auth_time in the future" };
  if (!claims.acr || !c.acr.includes(claims.acr)) return { ok: false, reason: `acr ${claims.acr ?? "missing"} not accepted` };
  if (c.requireProof) {
    const amr = claims.amr ?? [];
    // ["pop"] / ["pop","face","user"] = World ID proof; ["pop","user","mfa"] = passkey, not a fresh proof (id-token guide)
    if (!amr.includes("pop") || (amr.includes("mfa") && !amr.includes("face"))) {
      return { ok: false, reason: `amr ${JSON.stringify(amr)} is not a fresh World ID proof` };
    }
  }
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "no sub" };
  if (c.operators.length && !c.operators.includes(claims.sub)) return { ok: false, reason: "this World ID is not an enrolled operator" };
  return { ok: true, claims };
}

const FAIL_OF: Record<string, HumanCheckFailure> = {
  access_denied: "denied",
  expired_token: "expired",
  invalid_grant: "expired",
};

export class WorldIdGate implements HumanGate {
  readonly provider = "World ID";
  private discovery: Discovery | null = null;
  private jwks: { keys: (JsonWebKey & { kid?: string })[] } | null = null;
  private cancelled = new Set<string>();

  constructor(
    private readonly c: WorldIdConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly nowS: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  cancel(attemptId: string): boolean {
    this.cancelled.add(attemptId);
    return true;
  }

  private async disco(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const r = await this.fetchImpl(`${this.c.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`discovery HTTP ${r.status}`);
    const d = (await r.json()) as Discovery;
    if (d.issuer !== this.c.issuer) throw new Error(`discovery issuer ${d.issuer} ≠ ${this.c.issuer}`);
    if (!d.device_authorization_endpoint) throw new Error("issuer has no device_authorization_endpoint");
    this.discovery = d;
    return d;
  }

  private async keys(refresh = false): Promise<{ keys: (JsonWebKey & { kid?: string })[] }> {
    if (this.jwks && !refresh) return this.jwks;
    const r = await this.fetchImpl((await this.disco()).jwks_uri, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`JWKS HTTP ${r.status}`);
    this.jwks = (await r.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    return this.jwks;
  }

  private post(url: string, form: Record<string, string>): Promise<Response> {
    return this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(this.c.clientId, this.c.clientSecret), accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async verify(_req: HumanCheckRequest, onPrompt: (p: HumanCheckPrompt) => void): Promise<HumanCheckResult> {
    const attemptId = `wid_${b64url(randomBytes(9))}`;
    const fail = (reason: HumanCheckFailure, detail: string): HumanCheckResult => ({ ok: false, attemptId, provider: this.provider, reason, detail });
    const startedS = this.nowS();
    let d: Discovery;
    let start: { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number };
    try {
      d = await this.disco();
      const claims = JSON.stringify({ id_token: { acr: { essential: true, values: this.c.acr } } });
      const r = await this.post(d.device_authorization_endpoint, { scope: "openid", claims });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        return fail("error", `device authorization HTTP ${r.status}${e.error ? ` ${e.error}` : ""}`);
      }
      start = (await r.json()) as typeof start;
    } catch (e) {
      return fail("error", `World ID unreachable: ${errMsg(e)}`);
    }
    const deadlineS = startedS + Math.min(this.c.timeoutS, start.expires_in);
    onPrompt({
      attemptId,
      provider: this.provider,
      verificationUri: start.verification_uri_complete ?? start.verification_uri,
      userCode: start.user_code,
      expiresAt: new Date(deadlineS * 1000).toISOString(),
    });

    let interval = Math.max(1, start.interval ?? 5);
    for (;;) {
      await this.sleep(interval * 1000);
      if (this.cancelled.delete(attemptId)) return fail("cancelled", "cancelled by the operator");
      if (this.nowS() >= deadlineS) return fail("expired", "no approval before the deadline");
      let r: Response;
      try {
        r = await this.post(d.token_endpoint, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code });
      } catch {
        interval += 5; // connection timeout: back off and keep polling until the deadline
        continue;
      }
      if (r.status === 503 || r.status === 429) return fail("error", `token endpoint HTTP ${r.status}`);
      const body = (await r.json().catch(() => ({}))) as { error?: string; id_token?: string };
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (body.error) return fail(FAIL_OF[body.error] ?? "error", body.error);
      if (!r.ok || !body.id_token) return fail("error", `token endpoint HTTP ${r.status} without an ID token`);

      let jwks = await this.keys().catch(() => null);
      let v = jwks ? validateIdToken(body.id_token, jwks, this.c, startedS, this.nowS()) : { ok: false as const, reason: "JWKS unavailable" };
      if (!v.ok && v.reason.startsWith("unknown kid")) {
        jwks = await this.keys(true).catch(() => null); // key rotation: one bounded refresh
        if (jwks) v = validateIdToken(body.id_token, jwks, this.c, startedS, this.nowS());
      }
      if (!v.ok) return fail("invalid", v.reason);
      if (this.cancelled.delete(attemptId)) return fail("cancelled", "cancelled by the operator");
      const cl = v.claims;
      return {
        ok: true,
        attemptId,
        provider: this.provider,
        issuer: cl.iss,
        subject: cl.sub,
        acr: cl.acr ?? null,
        amr: cl.amr ?? null,
        authTime: cl.auth_time!,
        idTokenSha256: createHash("sha256").update(body.id_token).digest("hex"),
      };
    }
  }
}
