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
import express, { type NextFunction, type Request, type Response } from "express";
import { arkivConfigFromEnv, arkivReaderConfigured, judgeCurl, listIndex, SCHEMA_NAME } from "../index/arkiv.js";
import { galileoExplorer } from "../og/config.js";
import { downloadBytes, storageConfigFromEnv, storageConfigured, uploadWithRetry } from "../og/storage.js";
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
import { payReward, poolConfigFromEnv, poolConfigured, readPool } from "../og/anchor.js";
import { zerobotFromEnv } from "../zerobot/zerobot.js";
import { errMsg } from "../shared/util.js";
import { CLAIM_SCHEMA, claimArkivConfigFromEnv, claimReaderConfigured, claimWriterConfigured, createClaimRecord, listClaimRecords, patchClaimRecord } from "../index/arkivClaims.js";
import { ClaimLedger, type LedgerWriter } from "./claimLedger.js";
import { RelayQueue, type BundleSubmitter } from "../relay/queue.js";
import { submitBundle } from "../relay/submit.js";
import { httpJsonRpc } from "../relay/rpc.js";
import { meshSimView, SCENARIOS } from "../relay/meshsim.js";

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
  /** Overrides the RewardPool read (tests). */
  readPool?: () => Promise<import("../og/anchor.js").PoolInfo>;
  /** Overrides the relay's 0G Storage upload (tests). */
  relayUpload?: (bytes: Uint8Array) => Promise<import("../og/storage.js").UploadReceipt>;
  /** Overrides the Arkiv index read (tests). */
  listIndex?: typeof listIndex;
  /** Overrides the Arkiv claim-record writer (tests); null = off. */
  claimWriter?: LedgerWriter | null;
  /** Overrides the Arkiv claim-record read (tests). */
  listClaimRecords?: typeof listClaimRecords;
  claimLedgerFile?: string;
  /** Overrides the bundle relay's submitter (tests: fake chains); default: the §2 relayer against the real RPCs. */
  relaySubmit?: BundleSubmitter;
  /** Where relayed bundles are kept (default data/relay-bundles, or RELAY_BUNDLES_DIR). */
  relayBundlesDir?: string;
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

  // ---------------------------------------------------------------- offline bundle relay (relay spec §3)
  // A robot without internet (or a courier page carrying its bundles) POSTs a sealed bundle; the laptop submits the
  // robot's own pre-signed txs and uploads the locked files. No key, no funds, no trust: the bundle verifies itself.
  // Registered before the global 64 kB JSON parser: bundles carry the locked files, so this one route takes 2 MB.
  const relaySubmit: BundleSubmitter = opts.relaySubmit ?? ((b, steps, onStep) => submitBundle(b, { rpc: httpJsonRpc(f) }, { steps, onStep }));
  const relayQueue = new RelayQueue(relaySubmit, opts.relayBundlesDir);
  const bundleParser = express.json({ limit: "2mb" });
  app.post(
    "/api/relay/bundle",
    (req: Request, res: Response, next: NextFunction) =>
      bundleParser(req, res, (err?: unknown) => {
        if (!err) return next();
        const e = err as { status?: number; message?: string };
        res.status(e.status === 413 ? 413 : 400).json({ error: e.status === 413 ? "bundle larger than 2 MB" : `body is not JSON: ${e.message ?? ""}` });
      }),
    async (req: Request, res: Response) => {
      try {
        const r = await relayQueue.accept(req.body);
        res.status(r.status).json(r.body);
      } catch (e) {
        res.status(400).json({ error: errMsg(e) });
      }
    },
  );
  app.get("/api/relay/bundles", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    res.json({ items: relayQueue.list(limit) });
  });
  app.get("/api/relay/bundles/:bundleId", (req, res) => {
    const s = relayQueue.get(String(req.params.bundleId).toLowerCase());
    if (!s) {
      res.status(404).json({ error: "unknown bundle" });
      return;
    }
    res.json(s);
  });

  // mesh demo (relay spec §7): a deterministic simulation of robots carrying each other's bundles (fake chains only)
  app.get("/api/mesh/sim", async (req, res) => {
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : "three-owners";
    const seed = Number(req.query.seed ?? 1);
    if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000) {
      res.status(400).json({ error: "seed must be an integer 0..1000000" });
      return;
    }
    const p = meshSimView(scenario, seed);
    if (!p) {
      res.status(400).json({ error: `unknown scenario; one of: ${Object.keys(SCENARIOS).join(", ")}` });
      return;
    }
    try {
      res.json(await p);
    } catch (e) {
      res.status(500).json({ error: errMsg(e) });
    }
  });

  // no CORS: the dashboard page is served same-origin (Vite proxy in development); other origins get nothing
  app.use(express.json({ limit: "64kb" }));

  const device = async <T>(path: string): Promise<T> => {
    const r = await f(`${deviceUrl}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Object.assign(new Error(`device ${r.status}`), { status: r.status });
    return (await r.json()) as T;
  };
  // the last robot address seen, so its public record (Arkiv, 0G Chain, 0G Storage) stays readable if it goes offline
  let lastAddress = "";
  const deviceAddress = async (): Promise<string> => {
    const a = (await device<{ deviceAddress: string }>("/api/state")).deviceAddress;
    if (ethers.isAddress(a)) lastAddress = a;
    return a;
  };

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
  // ---------------------------------------------------------------- who may operate the robot (owner decision 3)
  // The robot's linked owner (signed in with World ID) may always operate it; anyone at the robot's site (a loopback
  // or private-network address) may too, unless READ_ONLY=on, which a public deployment sets so that only the owner
  // can. The robot itself can still refuse anything that is not safe.
  const readOnly = envFlag("READ_ONLY", "off");
  const isLocal = (req: Request) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    return ip === "127.0.0.1" || ip === "::1" || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  };
  const controlAccess = async (req: Request): Promise<{ allowed: boolean; as: "owner" | "site" | null; why: string | null; readOnly: boolean }> => {
    const a = accountOf(req);
    if (a && a.robots.length) {
      const addr = await deviceAddress().catch(() => process.env.DEVICE_ADDRESS ?? "");
      if (addr && a.robots.some((r) => r.address.toLowerCase() === addr.toLowerCase())) return { allowed: true, as: "owner", why: null, readOnly };
    }
    if (!readOnly && isLocal(req)) return { allowed: true, as: "site", why: null, readOnly };
    return {
      allowed: false, as: null, readOnly,
      why: readOnly ? "This dashboard is read-only: only the robot's signed-in owner can operate it." : "Operating the robot needs its signed-in owner, or a connection from the robot's site.",
    };
  };
  const gate = (req: Request, res: Response, next: NextFunction) => {
    void controlAccess(req).then((a) => (a.allowed ? next() : res.status(403).json({ error: a.why })));
  };
  app.get("/api/access", async (req, res) => {
    res.json(await controlAccess(req));
  });

  app.get("/api/state", passthrough);
  app.post("/api/episode/start", gate, passthrough);
  app.use("/api/control", gate, passthrough);
  app.use("/api/sim", gate, passthrough);
  app.get("/api/outbox", passthrough); // the robot outbox: offline-relay bundles waiting for a carrier
  app.post("/api/zerobot/dispatch", gate, passthrough);
  app.use("/api/zerobot", passthrough);
  app.use("/api/camera", passthrough);
  // a LOCKED camera photo: from 0G Storage by the root recorded in the log (works with the robot offline), else the robot
  const download = opts.verifyDeps?.downloadStorage ?? ((root: string) => downloadBytes(storageConfigFromEnv(), root));
  const dlCache = new Map<string, Promise<Uint8Array>>();
  const fromStorage = (root: string) => {
    let p = dlCache.get(root);
    if (!p) {
      p = download(root);
      p.catch(() => dlCache.delete(root));
      dlCache.set(root, p);
      if (dlCache.size > 64) dlCache.delete(dlCache.keys().next().value!);
    }
    return p;
  };
  const isRoot = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
  app.get("/api/frames/:id/:idx", async (req, res) => {
    if (isRoot(req.query.root)) {
      try {
        const bytes = await fromStorage(req.query.root.toLowerCase());
        res.setHeader("X-Frame-Source", "0g-storage");
        res.type("application/octet-stream").send(Buffer.from(bytes));
        return;
      } catch {
        // not on 0G Storage (yet): the robot's copy
      }
    }
    void forward(req, res);
  });
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
      claimSchema: CLAIM_SCHEMA,
      claimWriter: claimArkivConfigFromEnv().writer || null,
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
      // robot offline: its Arkiv index is still readable: the signed-in owner's linked robot, else DEVICE_ADDRESS
      const want = typeof (req.query as { device?: unknown }).device === "string" ? String((req.query as { device?: unknown }).device).toLowerCase() : "";
      const robots = accountOf(req)?.robots ?? [];
      addr = (robots.find((r) => r.address.toLowerCase() === want) ?? robots[0])?.address || lastAddress || process.env.DEVICE_ADDRESS || "";
    }
    const kc = { ...arkivConfigFromEnv(), writer: addr };
    if (envFlag("INDEX_ARKIV", "on") && arkivReaderConfigured(kc)) {
      try {
        const r = await (opts.listIndex ?? listIndex)(kc, filter);
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
      return lastAddress || (process.env.DEVICE_ADDRESS ?? "");
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
      downloadStorage: fromStorage,
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
  // ?device=0x… names the robot whose record to check, so a run can be checked while that robot is offline
  const devParam = (req: Request) => {
    const d = (req.query as { device?: unknown }).device;
    return typeof d === "string" && ethers.isAddress(d) ? ethers.getAddress(d) : undefined;
  };

  // the public check: anyone can confirm a run is untouched; the response carries the locked file (useless without a key)
  app.get("/api/verify/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!validId(id)) {
      res.status(400).json({ error: "not a run id" });
      return;
    }
    try {
      res.json(await verifyPublic(id, await publicDeps(id, devParam(req))));
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
      const deps = await publicDeps(id, devParam(req));
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
  app.post("/api/episodes/:id/relay", gate, async (req, res) => {
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
    if (!validId(id)) {
      res.status(400).json({ error: "not a run id" });
      return;
    }
    if (!a.key) {
      res.status(409).json({ error: "set up your unlock key first" });
      return;
    }
    const mine = (addr: string) => a.robots.some((r) => r.address.toLowerCase() === addr.toLowerCase());
    // 1) the robot, if it is up and linked to this account
    let robotErr: unknown = null;
    try {
      const dev = await deviceAddress();
      if (mine(dev)) {
        const w = await device<WrappedKey>(`/api/episodes/${encodeURIComponent(id)}/key`);
        if (w.kid === a.key.kid) {
          res.json({ ...w, source: "robot" });
          return;
        }
        robotErr = new Error("the robot locks runs for a different key than your current one: link the robot again");
      }
    } catch (e) {
      robotErr = e;
    }
    // 2) robot offline: the copy the robot locked for the owner inside the sealed file (0G Storage, at the anchored root)
    for (const r of a.robots) {
      try {
        const v = await verifyPublic(id, { ...(await publicDeps(id, r.address)), robotCopy: async () => null });
        // only from a stored file that matches the robot's own record and signature
        if (!v.sealed || v.checks.some((c) => (c.id === 2 || c.id === 4) && c.status !== "PASS")) continue;
        const w = v.sealed?.keys?.find((k) => k.kid === a.key!.kid);
        if (w) {
          res.json({ ...w, source: "0g-storage" });
          return;
        }
      } catch {
        // next robot
      }
    }
    const st = (robotErr as { status?: number } | null)?.status;
    res.status(st === 404 ? 404 : 502).json({ error: robotErr ? `${errMsg(robotErr)}; and no key for you was found in this run's stored file` : "no key for you was found for this run" });
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
  const claimCfg = claimArkivConfigFromEnv();
  const ledger = new ClaimLedger(
    opts.claimWriter !== undefined
      ? opts.claimWriter
      : envFlag("CLAIMS_ARKIV", "on") && claimWriterConfigured(claimCfg)
        ? { create: (f) => createClaimRecord(claimCfg, f), patch: (k, f) => patchClaimRecord(claimCfg, k, f) }
        : null,
    opts.claimLedgerFile,
  );
  const rewardDeps: RewardDeps = {
    verify: async (episodeId, dev) => {
      const v = await verifyPublic(episodeId, await publicDeps(episodeId, dev));
      return { result: v.result, failed: v.failed };
    },
    // incident facts come from the robot's own record on 0G Chain (no robot needed): the first linked robot with a record
    incident: async (episodeId, devices) => {
      const read = opts.verifyDeps?.readAnchor ?? (ethers.isAddress(anchorCfg.address) ? (d: string, id: string) => readAnchor(anchorCfg, d, id) : null);
      if (!read) throw new Error("no EpisodeAnchor contract is configured, so the incident cannot be confirmed on 0G Chain");
      for (const dev of devices) {
        const a = await read(dev, episodeId);
        if (!a) continue;
        const outcome = (["DONE", "ABORTED", "FAILSAFE", "TRIPPED"][a.outcome] ?? "UNKNOWN") as string;
        return { device: ethers.getAddress(dev), incident: a.incident, severity: a.severity, outcome };
      }
      throw new Error("none of your robots recorded this run on 0G Chain, so it cannot be claimed");
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
    onChange: (c) => void ledger.record(c),
    ...opts.rewardDeps,
  };
  const desk = new RewardDesk(rewardDeps);
  const withArkiv = <T extends { claimId: string }>(c: T) => ({ ...c, arkiv: ledger.get(c.claimId) });

  // every claim's public facts are mirrored to Arkiv; anyone can read a run's claim history from there
  const listClaimsFn = opts.listClaimRecords ?? listClaimRecords;
  app.get("/api/arkiv/claims", async (req, res) => {
    const q = req.query as { episodeId?: unknown; status?: unknown; device?: unknown };
    const filter = {
      ...(typeof q.episodeId === "string" && validId(q.episodeId) ? { episodeId: q.episodeId } : {}),
      ...(typeof q.status === "string" && /^[A-Z_]{2,20}$/.test(q.status) ? { status: q.status } : {}),
      ...(typeof q.device === "string" && ethers.isAddress(q.device) ? { device: q.device } : {}),
    };
    if (!claimReaderConfigured(claimCfg)) {
      res.json({ configured: false, items: [] });
      return;
    }
    try {
      const r = await listClaimsFn(claimCfg, filter);
      res.json({ configured: true, source: "arkiv", writer: claimCfg.writer, schema: CLAIM_SCHEMA, query: r.query, blockNumber: r.blockNumber, items: r.rows });
    } catch (e) {
      res.status(502).json({ configured: true, error: `Arkiv read failed: ${errMsg(e)}`, items: [] });
    }
  });

  // the reward pool, from 0G Chain only (public facts: address, balance, max payout, recent payouts)
  // Home counters, from the public record only: runs and incidents from the robot's Arkiv entries, claims paid from
  // the RewardPool's Paid events on 0G Chain. Cached 30 s; each part reports null when it can't be read.
  let statsCache: { at: number; body: unknown } | null = null;
  app.get("/api/stats", async (req, res) => {
    if (statsCache && Date.now() - statsCache.at < 30_000) {
      res.json(statsCache.body);
      return;
    }
    const robots = accountOf(req)?.robots?.map((r) => r.address) ?? [];
    const addr = (await robotAddress()) || robots[0] || "";
    const kc = { ...arkivConfigFromEnv(), writer: addr };
    const read = opts.listIndex ?? listIndex;
    const [all, inc, pool] = await Promise.all([
      arkivReaderConfigured(kc) ? read(kc, {}, 100).catch(() => null) : Promise.resolve(null),
      arkivReaderConfigured(kc) ? read(kc, { kind: "incident" }, 100).catch(() => null) : Promise.resolve(null),
      opts.readPool || ethers.isAddress(poolCfg.address) ? (opts.readPool ?? (() => readPool(poolCfg)))().catch(() => null) : Promise.resolve(null),
    ]);
    const body = {
      robot: addr || null,
      runs: all ? all.rows.length : null,
      runsCapped: !!all && all.rows.length >= 100,
      incidents: inc ? inc.rows.length : null,
      lastRunAt: all?.rows[0]?.ts ?? null,
      claimsPaid: pool ? pool.paid.length : null,
      paidWei: pool ? pool.paid.reduce((t, p) => t + BigInt(p.amountWei), 0n).toString() : null,
      source: { runs: "arkiv", claimsPaid: "0g-chain" },
    };
    statsCache = { at: Date.now(), body };
    res.json(body);
  });

  app.get("/api/pool", async (_req, res) => {
    if (!opts.readPool && !ethers.isAddress(poolCfg.address)) {
      res.json({ configured: false });
      return;
    }
    try {
      const p = await (opts.readPool ?? (() => readPool(poolCfg)))();
      res.json({ configured: true, ...p, perSeverityWei: perSeverity.toString(), maxRewardWei: maxReward.toString() });
    } catch (e) {
      res.status(502).json({ configured: true, error: errMsg(e) });
    }
  });
  const claimsOn = envFlag("CLAIMS_WORLDID", "on");

  // incidents on my robots that could be claimed: from Arkiv (each linked robot's own entities; works with the robot
  // offline), else the robot's list. The 0G Chain record is checked again when claiming.
  const listIndexFn = opts.listIndex ?? listIndex;
  app.get("/api/claimable", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const mine = new Set(a.robots.map((r) => r.address.toLowerCase()));
    const out = new Map<string, unknown>();
    const notes: string[] = [];
    let source: "arkiv" | "device" | "none" = "none";
    for (const r of a.robots) {
      const kc = { ...arkivConfigFromEnv(), writer: r.address };
      if (!envFlag("INDEX_ARKIV", "on") || !arkivReaderConfigured(kc)) break;
      try {
        const page = await listIndexFn(kc, { kind: "incident" });
        source = "arkiv";
        for (const it of page.rows) {
          out.set(it.episodeId, { episodeId: it.episodeId, device: r.address, severity: it.severity, outcome: it.outcome, ts: it.ts, claimable: it.severity >= 2 });
        }
      } catch (e) {
        notes.push(`Arkiv read failed for ${r.address.slice(0, 10)}…: ${errMsg(e)}`);
      }
    }
    if (mine.size && source === "none") {
      try {
        const list = await device<{ items: { episodeId: string; locked?: boolean; kind?: string; severity?: number; outcome?: string; device?: string; ts?: number }[] }>("/api/episodes");
        source = "device";
        for (const it of list.items) {
          if (!it.locked || it.kind !== "incident" || !it.device || !mine.has(it.device.toLowerCase())) continue;
          out.set(it.episodeId, { episodeId: it.episodeId, device: it.device, severity: it.severity ?? 0, outcome: it.outcome, ts: it.ts, claimable: (it.severity ?? 0) >= 2 });
        }
      } catch {
        notes.push("robot offline");
      }
    }
    const items = [...out.values()].sort((x, y) => ((y as { ts?: number }).ts ?? 0) - ((x as { ts?: number }).ts ?? 0));
    res.json({ items, source, ...(notes.length ? { note: notes.join("; ") } : {}), amounts: { perSeverityWei: perSeverity.toString(), maxWei: maxReward.toString() } });
  });

  app.get("/api/claims", (req, res) => {
    const a = requireAccount(req, res);
    if (a) res.json(desk.list(a.accountId).map(withArkiv));
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
    if (c) res.json(withArkiv(c));
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
    if (requireInsurer(req, res)) res.json(desk.listForInsurer().map(withArkiv));
  });
  app.get("/api/insurer/claims/:id", (req, res) => {
    if (!requireInsurer(req, res)) return;
    const c = desk.getForInsurer(String(req.params.id));
    if (c) res.json(withArkiv(c));
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

  return { app, deviceUrl, watchForRelays, relayQueue };
}
