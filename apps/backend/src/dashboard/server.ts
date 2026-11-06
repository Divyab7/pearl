/**
 * The DASHBOARD server (rev 5, device-first). It runs on the laptop and only shows things and handles people:
 *  - passes operator requests (start, stop, safe, reset, Cut 0G, sim faults) to the device, which may refuse them;
 *  - reads the device's public record: the episode list from Arkiv (entities owned by the device's address), logs from
 *    the device or from 0G Storage, the device's own anchor on 0G Chain;
 *  - checks episodes publicly (anchor, locked file on 0G Storage, header, robot signature) — it cannot read them:
 *    runs are locked on the robot, and only the owner (and the insurer, for a claimed incident) can unlock them, in
 *    their own browser (owner decisions 5–6 Nov 2026);
 *  - accounts, robot linking and reward claims (World ID Agent Pass + IDKit), the insurer's review (wallet sign-in,
 *    Approve/Deny) and the RewardPool payout after Approve.
 * It never makes a decision, never signs device data, never holds an unlock key and never sends a motor command itself.
 * Express 5: https://expressjs.com/en/5x/api.html · fetch streaming: https://nodejs.org/api/globals.html#fetch
 */
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { arkivConfigFromEnv, arkivReaderConfigured, judgeCurl, listIndex, SCHEMA_NAME } from "../index/arkiv.js";
import { galileoExplorer } from "../og/config.js";
import { storageConfigFromEnv, storageConfigured, uploadWithRetry } from "../og/storage.js";
import { loadArmConfig, type ArmConfig } from "../shared/armConfig.js";
import { envFlag, loadEnv, REPO_ROOT } from "../shared/env.js";
import type { EpisodeMeta } from "../orchestrator/meta.js";
import { editedSealedCopy, verifyPublic, type PublicVerifyDeps } from "../verify/verifier.js";
import { isPublicJwk, keyId, parseSealed, type PublicJwk, type SealedEpisode, type WrappedKey } from "../shared/seal.js";
import { readAnchor, anchorConfigFromEnv } from "../og/anchor.js";
import { resolve } from "node:path";
import { readJson, writeJson } from "../shared/util.js";
import { readRelay, relayEpisode } from "./relay.js";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { AccountStore, Sessions, cookieValue, type Account } from "./accounts.js";
import { RewardDesk, type IdkitConfig, type RewardDeps } from "./rewards.js";
import { WorldIdGate, worldIdConfigFromEnv, worldIdConfigured } from "../human/worldid.js";
import type { HumanCheckResult, HumanGate } from "../human/gate.js";
import { payReward, poolConfigFromEnv, poolConfigured } from "../og/anchor.js";
import { zerobotFromEnv } from "../zerobot/zerobot.js";
import { errMsg } from "../shared/util.js";

export interface DashboardOptions {
  deviceUrl?: string;
  arm?: ArmConfig;
  fetchImpl?: typeof fetch;
  /** Overrides for the public check's networked lookups (tests). */
  verifyDeps?: Partial<PublicVerifyDeps>;
  /** Overrides for the reward-claim services (tests). */
  rewardDeps?: Partial<RewardDeps>;
  /** World ID Agent Pass gate override (tests); default: WorldIdGate when configured. */
  agentPass?: HumanGate | null;
  /** Overrides the relay's 0G Storage upload (tests). */
  relayUpload?: (bytes: Uint8Array) => Promise<import("../og/storage.js").UploadReceipt>;
}

export function createDashboard(opts: DashboardOptions = {}) {
  loadEnv();
  const deviceUrl = (opts.deviceUrl ?? process.env.DEVICE_URL ?? "http://localhost:8070").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const postJson = (url: string, body: unknown, timeoutMs: number) =>
    f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const arm = opts.arm ?? loadArmConfig();
  const zbChain = zerobotFromEnv();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "64kb" }));

  const device = async <T>(path: string): Promise<T> => {
    const r = await f(`${deviceUrl}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Object.assign(new Error(`device ${r.status}`), { status: r.status });
    return (await r.json()) as T;
  };
  const deviceAddress = async (): Promise<string> => (await device<{ deviceAddress: string }>("/api/state")).deviceAddress;

  // ---------------------------------------------------------------- pass-through to the device
  async function forward(req: Request, res: Response) {
    try {
      const init: RequestInit = { method: req.method, signal: AbortSignal.timeout(15_000) };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(req.body ?? {});
      }
      const r = await f(`${deviceUrl}${req.originalUrl}`, init);
      res.status(r.status);
      for (const h of ["content-type", "x-frame-source", "cache-control"]) {
        const v = r.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: `device unreachable at ${deviceUrl}: ${errMsg(e)}` });
    }
  }
  const passthrough = (req: Request, res: Response, _next: NextFunction) => void forward(req, res);
  app.get("/api/state", passthrough);
  app.post("/api/episode/start", passthrough);
  app.use("/api/control", passthrough);
  app.use("/api/sim", passthrough);
  app.use("/api/zerobot", passthrough);
  app.use("/api/camera", passthrough);
  app.use("/api/frames", passthrough);
  app.get("/api/episodes/:id", passthrough); // the robot's LOCKED copy (public header + locked data)
  app.get("/api/episodes/:id/meta", passthrough);
  // arm calibration (not secret): the key holder's browser needs it to replay the policy over an unlocked log
  app.get("/api/arm", (_req, res) => {
    res.json(arm);
  });
  // public links for the pages: explorer, storage indexer, contract addresses (nothing secret)
  app.get("/api/config", (_req, res) => {
    const sc = storageConfigFromEnv();
    res.json({
      explorer: galileoExplorer(),
      storageIndexer: sc.indexerUrl,
      anchorAddress: process.env.OG_ANCHOR_ADDRESS ?? null,
      poolAddress: process.env.OG_REWARD_POOL_ADDRESS ?? null,
      arkivSchema: SCHEMA_NAME,
    });
  });

  // live stream: piped from the device's own feed
  app.get("/api/stream", async (req, res) => {
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    try {
      const r = await f(`${deviceUrl}/api/stream`, { signal: ac.signal });
      if (!r.ok || !r.body) throw new Error(`device ${r.status}`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `device stream unavailable: ${errMsg(e)}` });
      else res.end();
    }
  });

  // ---------------------------------------------------------------- the device's public record
  // Episode list from Arkiv: the entities the DEVICE wrote with its own key (owner = device address).
  app.get("/api/episodes", async (req, res) => {
    const q = req.query as { armId?: string; kind?: string; outcome?: string };
    const filter = {
      ...(typeof q.armId === "string" && q.armId ? { armId: q.armId } : {}),
      ...(typeof q.kind === "string" && q.kind ? { kind: q.kind } : {}),
      ...(typeof q.outcome === "string" && q.outcome ? { outcome: q.outcome } : {}),
    };
    const deviceEpisodesPath = `/api/episodes${req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : ""}`;
    let addr = "";
    try {
      addr = await deviceAddress();
    } catch {
      // device offline: the Arkiv index is still readable if we know the address from the environment
      addr = process.env.DEVICE_ADDRESS ?? "";
    }
    const kc = { ...arkivConfigFromEnv(), writer: addr };
    if (envFlag("INDEX_ARKIV", "on") && arkivReaderConfigured(kc)) {
      try {
        const r = await listIndex(kc, filter);
        res.json({
          source: "arkiv",
          device: addr,
          query: r.query,
          blockNumber: r.blockNumber,
          curl: judgeCurl(kc, filter.armId ?? "arm-1"),
          items: r.rows.map((x) => ({ ...x, locked: true })),
        });
        return;
      } catch (e) {
        const note = `Arkiv read failed: ${errMsg(e)}`;
        try {
          const d = await device<{ items: unknown[] }>(deviceEpisodesPath);
          res.json({ source: "device", note, items: d.items });
        } catch {
          res.json({ source: "none", note: `${note}; device unreachable`, items: [] });
        }
        return;
      }
    }
    try {
      const d = await device<{ items: unknown[] }>(deviceEpisodesPath);
      res.json({ source: "device", note: envFlag("INDEX_ARKIV", "on") ? "device address unknown" : "INDEX_ARKIV=off", items: d.items });
    } catch {
      res.json({ source: "none", note: "device unreachable and no Arkiv index", items: [] });
    }
  });

  // ---------------------------------------------------------------- public check (independent of the device)
  const robotAddress = async (): Promise<string> => {
    try {
      return await deviceAddress();
    } catch {
      return process.env.DEVICE_ADDRESS ?? "";
    }
  };
  const robotCopy = (id: string) => () => device<SealedEpisode>(`/api/episodes/${encodeURIComponent(id)}`).then((x) => parseSealed(JSON.stringify(x)));
  const publicDeps = async (id: string, dev?: string): Promise<PublicVerifyDeps> => {
    const meta = await device<EpisodeMeta>(`/api/episodes/${encodeURIComponent(id)}/meta`).catch(() => null);
    const own = meta?.storage?.status === "ok" ? meta.storage.rootHash : null;
    return {
      device: dev ?? (await robotAddress()),
      fallbackRoot: own ?? readRelay(id)?.rootHash ?? null,
      robotCopy: robotCopy(id),
      ...(zbChain ? { readZerobotReceipt: (n: number) => zbChain.receipt(n) } : {}),
      ...opts.verifyDeps,
    };
  };
  const relayUpload = opts.relayUpload ?? ((bytes: Uint8Array) => {
    const sc = storageConfigFromEnv(process.env.OG_OPERATOR_PRIVATE_KEY ?? "");
    if (!storageConfigured(sc)) throw new Error("no operator key for the relay (OG_OPERATOR_PRIVATE_KEY)");
    return uploadWithRetry(sc, bytes);
  });
  const validId = (id: string) => /^ep_[A-Za-z0-9_-]+$/.test(id);

  // the public check: anyone can confirm a run is untouched; the response carries the locked file (useless without a key)
  app.get("/api/verify/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) {
      res.status(400).json({ error: "not a run id" });
      return;
    }
    try {
      res.json(await verifyPublic(id, await publicDeps(id)));
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  // "Edit 1 byte": check a COPY of the locked file with one changed character
  app.post("/api/verify/:id/tamper", async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) {
      res.status(400).json({ error: "not a run id" });
      return;
    }
    try {
      const deps = await publicDeps(id);
      const real = await verifyPublic(id, deps);
      if (!real.sealed) throw new Error("no locked file to edit");
      res.json(await verifyPublic(id, { ...deps, editedCopy: editedSealedCopy(real.sealed) }));
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  // ---------------------------------------------------------------- storage backup (R5)
  const relay = async (episodeId: string) => {
    const meta = await device<EpisodeMeta>(`/api/episodes/${encodeURIComponent(episodeId)}/meta`);
    if (meta.storage?.status === "ok") return { status: "not needed: the device uploaded it", rootHash: meta.storage.rootHash };
    const sealed = await robotCopy(episodeId)();
    const rec = await relayEpisode(sealed, await deviceAddress(), relayUpload);
    return { status: "relayed", ...rec };
  };
  app.post("/api/episodes/:id/relay", async (req, res) => {
    try {
      res.json(await relay(String(req.params.id)));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });
  app.get("/api/episodes/:id/relay", (req, res) => {
    res.json(readRelay(String(req.params.id)) ?? { status: "none" });
  });

  // ---------------------------------------------------------------- accounts: Sign in with World ID (Agent Pass)
  const accounts = new AccountStore();
  const sessions = new Sessions();
  const widCfg = worldIdConfigFromEnv();
  const agentPass: HumanGate | null = opts.agentPass !== undefined ? opts.agentPass : worldIdConfigured(widCfg) ? new WorldIdGate(widCfg) : null;
  const COOKIE = "pearl_session";
  const accountOf = (req: Request): Account | null => {
    const id = sessions.get(cookieValue(req.headers.cookie, COOKIE));
    return id ? (accounts.get(id) ?? null) : null;
  };
  const requireAccount = (req: Request, res: Response): Account | null => {
    const a = accountOf(req);
    if (!a) res.status(401).json({ error: "sign in with World ID first" });
    return a;
  };

  const signIns = new Map<string, { result: HumanCheckResult | null; prompt: unknown }>();
  app.post("/api/auth/start", async (_req, res) => {
    if (!agentPass) {
      res.status(503).json({ error: "World ID Agent Pass is not configured (WORLDID_CLIENT_ID / WORLDID_CLIENT_SECRET)" });
      return;
    }
    let resolvePrompt!: (p: unknown) => void;
    const prompt = new Promise((r) => (resolvePrompt = r));
    let attempt = "";
    void agentPass
      .verify({ reason: "Sign in to Pearl" }, (p) => {
        attempt = p.attemptId;
        signIns.set(p.attemptId, { result: null, prompt: p });
        resolvePrompt(p);
      })
      .then((r) => {
        signIns.set(r.attemptId, { result: r, prompt: null });
        resolvePrompt(null);
      });
    const p = await Promise.race([prompt, new Promise((r) => setTimeout(() => r(null), 10_000))]);
    if (!p) {
      const r = attempt ? signIns.get(attempt)?.result : null;
      res.status(502).json({ error: r && !r.ok ? `${r.reason}: ${r.detail}` : "World ID did not respond" });
      return;
    }
    res.json(p);
  });
  app.get("/api/auth/status/:attemptId", (req, res) => {
    const s = signIns.get(String(req.params.attemptId));
    if (!s) {
      res.status(404).json({ error: "unknown sign-in attempt" });
      return;
    }
    if (!s.result) {
      res.json({ status: "pending" });
      return;
    }
    const r = s.result;
    if (!r.ok) {
      res.json({ status: "failed", reason: r.reason, detail: r.detail });
      return;
    }
    signIns.delete(String(req.params.attemptId)); // one session per validated token
    const account = accounts.upsertFromIdentity(r.issuer, r.subject);
    const token = sessions.create(account.accountId);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", maxAge: 12 * 3600_000 });
    res.json({ status: "ok", account });
  });
  app.post("/api/auth/cancel/:attemptId", (req, res) => {
    res.json({ cancelled: agentPass?.cancel(String(req.params.attemptId)) ?? false });
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.end(cookieValue(req.headers.cookie, COOKIE));
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });
  app.get("/api/account", (req, res) => {
    const a = requireAccount(req, res);
    if (a) res.json(a);
  });
  app.post("/api/account/wallet", (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    try {
      res.json(accounts.setWallet(a.accountId, String((req.body as { address?: unknown })?.address ?? "")));
    } catch (e) {
      res.status(400).json({ error: errMsg(e) });
    }
  });

  // the owner's PUBLIC unlock key (created in their browser; the private half stays there and in their backup file)
  app.post("/api/account/key", (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const jwk = (req.body as { publicJwk?: unknown })?.publicJwk;
    if (!isPublicJwk(jwk)) {
      res.status(400).json({ error: "publicJwk must be a P-256 public key" });
      return;
    }
    res.json(accounts.setKey(a.accountId, { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }));
  });

  // link the robot this dashboard is connected to: the DEVICE signs the link message (naming the owner key) itself
  app.post("/api/robots/link", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    if (!a.key) {
      res.status(409).json({ error: "set up your unlock key first: the robot locks every run for it" });
      return;
    }
    try {
      const nonce = randomBytes(16).toString("hex");
      const r = await postJson(`${deviceUrl}/api/link`, { accountId: a.accountId, nonce, ownerKey: a.key.publicJwk }, 35_000);
      const d = (await r.json()) as { address?: string; deviceId?: string; signature?: string; ownerKid?: string; error?: string };
      if (!r.ok || !d.address || !d.signature) throw new Error(d.error ?? `device ${r.status}`);
      if (d.ownerKid !== a.key.kid) throw new Error("the robot linked a different owner key");
      res.json(accounts.linkRobot(a.accountId, { address: d.address, deviceId: d.deviceId ?? "", deviceUrl, linkSignature: d.signature, ownerKid: d.ownerKid }, nonce));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  // this run's key, locked by the robot for the signed-in owner's key; only their browser can open it
  app.get("/api/episodes/:id/key", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const id = String(req.params.id);
    try {
      const dev = await deviceAddress();
      if (!a.robots.some((r) => r.address.toLowerCase() === dev.toLowerCase())) {
        res.status(403).json({ error: "this robot is not linked to your account" });
        return;
      }
      const w = await device<WrappedKey>(`/api/episodes/${encodeURIComponent(id)}/key`);
      if (!a.key || w.kid !== a.key.kid) {
        res.status(409).json({ error: "the robot locks runs for a different key than your current one: link the robot again" });
        return;
      }
      res.json(w);
    } catch (e) {
      res.status((e as { status?: number }).status === 404 ? 404 : 502).json({ error: errMsg(e) });
    }
  });

  // ---------------------------------------------------------------- reward claims (World ID Agent Pass + IDKit)
  const idkit: IdkitConfig | null = process.env.WORLD_APP_ID && process.env.WORLD_RP_ID && process.env.WORLD_RP_SIGNING_KEY
    ? { appId: process.env.WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, environment: (process.env.WORLD_ENV ?? "production") as IdkitConfig["environment"] }
    : null;
  const poolCfg = poolConfigFromEnv();
  const perSeverity = ethers.parseEther(process.env.REWARD_PER_SEVERITY_0G ?? "0.01");
  const maxReward = ethers.parseEther(process.env.REWARD_MAX_0G ?? "0.05");
  // ---------------------------------------------------------------- the insurer: wallet sign-in and receiving key
  // The insurance company's wallet (INSURER_ADDRESS, default: the RewardPool operator wallet) signs in by signing a
  // one-time message; it moves no money. Its receiving key (public half) is what owners lock incident keys for.
  const insurerAddress = (() => {
    const env = process.env.INSURER_ADDRESS ?? "";
    if (ethers.isAddress(env)) return ethers.getAddress(env);
    try {
      return poolCfg.operatorKey ? new ethers.Wallet(poolCfg.operatorKey).address : "";
    } catch {
      return "";
    }
  })();
  const insurerKeyPath = process.env.INSURER_KEY_FILE ?? resolve(REPO_ROOT, "data", "insurer-key.json");
  type InsurerKey = { publicJwk: PublicJwk; kid: string; setAt: string; by: string };
  const insurerKey = () => readJson<InsurerKey | null>(insurerKeyPath, null);
  const insurerSessions = new Sessions(8 * 3600_000);
  const INSURER_COOKIE = "pearl_insurer";
  const challenges = new Map<string, { message: string; expires: number }>();
  const insurerOf = (req: Request): string | null => (insurerSessions.get(cookieValue(req.headers.cookie, INSURER_COOKIE)) ? insurerAddress : null);
  const requireInsurer = (req: Request, res: Response): string | null => {
    const who = insurerOf(req);
    if (!who) res.status(401).json({ error: "sign in with the insurer wallet first" });
    return who;
  };

  app.get("/api/insurer", (req, res) => {
    const k = insurerKey();
    res.json({
      configured: !!insurerAddress,
      address: insurerAddress || null,
      signedIn: !!insurerOf(req),
      key: k ? { publicJwk: k.publicJwk, kid: k.kid, setAt: k.setAt } : null,
    });
  });
  app.post("/api/insurer/challenge", (_req, res) => {
    if (!insurerAddress) {
      res.status(503).json({ error: "no insurer wallet configured (INSURER_ADDRESS or OG_OPERATOR_PRIVATE_KEY)" });
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    const message = `Pearl insurer sign-in\nWallet: ${insurerAddress}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}\nThis signature only signs you in. It moves no funds.`;
    challenges.set(nonce, { message, expires: Date.now() + 5 * 60_000 });
    res.json({ nonce, message, address: insurerAddress });
  });
  app.post("/api/insurer/signin", (req, res) => {
    const b = (req.body ?? {}) as { nonce?: unknown; signature?: unknown };
    const ch = typeof b.nonce === "string" ? challenges.get(b.nonce) : undefined;
    if (!ch || ch.expires < Date.now() || typeof b.signature !== "string") {
      res.status(400).json({ error: "sign-in request expired; try again" });
      return;
    }
    challenges.delete(b.nonce as string); // one use
    let who: string | null = null;
    try {
      who = ethers.verifyMessage(ch.message, b.signature);
    } catch {
      who = null;
    }
    if (!who || who.toLowerCase() !== insurerAddress.toLowerCase()) {
      res.status(403).json({ error: `signed by ${who ?? "an invalid signature"}, not the insurer wallet ${insurerAddress}` });
      return;
    }
    res.cookie(INSURER_COOKIE, insurerSessions.create(insurerAddress), { httpOnly: true, sameSite: "lax", maxAge: 8 * 3600_000 });
    res.json({ ok: true, address: insurerAddress });
  });
  app.post("/api/insurer/logout", (req, res) => {
    insurerSessions.end(cookieValue(req.headers.cookie, INSURER_COOKIE));
    res.clearCookie(INSURER_COOKIE);
    res.json({ ok: true });
  });
  app.post("/api/insurer/key", (req, res) => {
    const who = requireInsurer(req, res);
    if (!who) return;
    const jwk = (req.body as { publicJwk?: unknown })?.publicJwk;
    if (!isPublicJwk(jwk)) {
      res.status(400).json({ error: "publicJwk must be a P-256 public key" });
      return;
    }
    const pub: PublicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
    const k: InsurerKey = { publicJwk: pub, kid: keyId(pub), setAt: new Date().toISOString(), by: who };
    writeJson(insurerKeyPath, k);
    res.json({ publicJwk: k.publicJwk, kid: k.kid, setAt: k.setAt });
  });

  // ---------------------------------------------------------------- reward claims
  const anchorCfg = anchorConfigFromEnv();
  const rewardDeps: RewardDeps = {
    verify: async (episodeId, dev) => {
      const v = await verifyPublic(episodeId, await publicDeps(episodeId, dev));
      return { result: v.result, failed: v.failed };
    },
    // incident facts come from the robot's own record on 0G Chain; the locked file's header only names the robot
    incident: async (episodeId) => {
      const sealed = await robotCopy(episodeId)();
      const dev = sealed.device.address;
      if (opts.verifyDeps?.readAnchor || ethers.isAddress(anchorCfg.address)) {
        const read = opts.verifyDeps?.readAnchor ?? ((d: string, id: string) => readAnchor(anchorCfg, d, id));
        const a = await read(dev, episodeId);
        if (!a) throw new Error("this run is not recorded on 0G Chain, so it cannot be claimed");
        const outcome = (["DONE", "ABORTED", "FAILSAFE", "TRIPPED"][a.outcome] ?? "UNKNOWN") as string;
        return { device: dev, incident: a.incident, severity: a.severity, outcome };
      }
      return { device: dev, incident: sealed.incident, severity: sealed.severity, outcome: sealed.outcome };
    },
    insurerKid: () => insurerKey()?.kid ?? null,
    agentPass: () => agentPass,
    idkit,
    signRequest: (action) => signRequest({ signingKeyHex: process.env.WORLD_RP_SIGNING_KEY ?? "", action }),
    hashSignal: (s) => hashSignal(s),
    verifyProof: async (rpId, result) => {
      // forward the IDKit result unchanged (docs.world.org/world-id/idkit/integrate, Step 5)
      const r = await postJson(`https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`, result, 20_000);
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    },
    pay: async (p) => {
      if (!poolConfigured(poolCfg)) throw new Error("RewardPool not configured (OG_REWARD_POOL_ADDRESS, OG_OPERATOR_PRIVATE_KEY)");
      return payReward(poolCfg, p);
    },
    amountWeiFor: (sev) => (perSeverity * BigInt(sev) > maxReward ? maxReward : perSeverity * BigInt(sev)),
    requireValid: envFlag("CLAIMS_REQUIRE_VALID", "on"),
    ...opts.rewardDeps,
  };
  const desk = new RewardDesk(rewardDeps);
  const claimsOn = envFlag("CLAIMS_WORLDID", "on");

  // incidents on my robots that could be claimed (labels from the robot's list; the anchor is checked when claiming)
  app.get("/api/claimable", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const mine = new Set(a.robots.map((r) => r.address.toLowerCase()));
    const out: unknown[] = [];
    if (mine.size) {
      try {
        const list = await device<{ items: { episodeId: string; locked?: boolean; kind?: string; severity?: number; outcome?: string; device?: string; ts?: number }[] }>("/api/episodes");
        for (const it of list.items) {
          if (!it.locked || it.kind !== "incident" || !it.device || !mine.has(it.device.toLowerCase())) continue;
          out.push({ episodeId: it.episodeId, device: it.device, severity: it.severity ?? 0, outcome: it.outcome, ts: it.ts, claimable: (it.severity ?? 0) >= 2 });
        }
      } catch {
        // robot offline: nothing listed
      }
    }
    res.json({ items: out, amounts: { perSeverityWei: perSeverity.toString(), maxWei: maxReward.toString() } });
  });

  app.get("/api/claims", (req, res) => {
    const a = requireAccount(req, res);
    if (a) res.json(desk.list(a.accountId));
  });
  app.post("/api/claims", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    if (!claimsOn) {
      res.status(503).json({ error: "CLAIMS_WORLDID=off: claims are disabled" });
      return;
    }
    try {
      const b = (req.body ?? {}) as { episodeId?: unknown; insurerKey?: unknown };
      res.json(await desk.start(a, String(b.episodeId ?? ""), b.insurerKey as WrappedKey));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });
  app.get("/api/claims/:id", (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const c = desk.get(String(req.params.id), a.accountId);
    if (c) res.json(c);
    else res.status(404).json({ error: "not found" });
  });
  app.post("/api/claims/:id/cancel", (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    try {
      res.json(desk.cancel(String(req.params.id), a.accountId));
    } catch (e) {
      res.status(404).json({ error: errMsg(e) });
    }
  });
  app.get("/api/claims/:id/idkit", (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    try {
      res.json(desk.idkitRequest(String(req.params.id), a.accountId));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });
  app.post("/api/claims/:id/idkit", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    try {
      res.json(await desk.idkitResult(String(req.params.id), a.accountId, (req.body ?? {}) as { error?: string; result?: Record<string, unknown> }));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  // ---------------------------------------------------------------- the insurer's review queue
  app.get("/api/insurer/claims", (req, res) => {
    if (requireInsurer(req, res)) res.json(desk.listForInsurer());
  });
  app.get("/api/insurer/claims/:id", (req, res) => {
    if (!requireInsurer(req, res)) return;
    const c = desk.getForInsurer(String(req.params.id));
    if (c) res.json(c);
    else res.status(404).json({ error: "not found" });
  });
  app.post("/api/insurer/claims/:id/decision", async (req, res) => {
    const who = requireInsurer(req, res);
    if (!who) return;
    const b = (req.body ?? {}) as { approve?: unknown; reason?: unknown };
    if (typeof b.approve !== "boolean" || typeof b.reason !== "string") {
      res.status(400).json({ error: "body must be {approve: true|false, reason: text}" });
      return;
    }
    try {
      res.json(await desk.decide(String(req.params.id), { approve: b.approve, reason: b.reason, by: who }));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  /**
   * With STORAGE_RELAY=on the dashboard watches the device's feed and relays any log whose own upload failed.
   * Returns a stop function. Off by default: the operator can still press "relay" per episode.
   */
  function watchForRelays(onResult: (r: unknown) => void = (r) => console.log("relay:", r)): () => void {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await f(`${deviceUrl}/api/stream`, { signal: ac.signal });
        if (!r.body) return;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!frame.startsWith("event: meta")) continue;
            const meta = JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as EpisodeMeta;
            const done = meta.storage && meta.storage.status !== "ok" && meta.anchor !== undefined; // pipeline finished storage
            if (done) relay(meta.episodeId).then(onResult, (e) => onResult({ episodeId: meta.episodeId, error: String(e) }));
          }
        }
      } catch {
        // stream closed
      }
    })();
    return () => ac.abort();
  }

  return { app, deviceUrl, watchForRelays };
}
