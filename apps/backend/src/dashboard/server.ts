/**
 * The DASHBOARD server (rev 5, device-first). It runs on the laptop and only shows things and handles people:
 *  - passes operator requests (start, stop, safe, reset, Cut 0G, sim faults) to the device, which may refuse them;
 *  - reads the device's public record: the episode list from Arkiv (entities owned by the device's address), logs from
 *    the device or from 0G Storage, the device's own anchor on 0G Chain;
 *  - verifies episodes (8 checks, including the device's signature);
 *  - accounts, robot linking and reward claims (World ID Agent Pass + IDKit, paid from the RewardPool).
 * It never makes a decision, never signs device data and never sends a motor command itself.
 * Express 5: https://expressjs.com/en/5x/api.html · fetch streaming: https://nodejs.org/api/globals.html#fetch
 */
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { arkivConfigFromEnv, arkivReaderConfigured, judgeCurl, listIndex } from "../index/arkiv.js";
import { downloadBytes, storageConfigFromEnv, storageConfigured, uploadWithRetry } from "../og/storage.js";
import { loadArmConfig, type ArmConfig } from "../shared/armConfig.js";
import { canonicalize } from "../shared/canonical.js";
import { envFlag, loadEnv } from "../shared/env.js";
import type { EpisodeLog } from "../shared/types.js";
import type { EpisodeMeta } from "../orchestrator/meta.js";
import { tamperedCopy, verifyEpisode, type VerifyDeps } from "../verify/verifier.js";
import { readRelay, relayEpisode } from "./relay.js";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { AccountStore, Sessions, cookieValue, type Account } from "./accounts.js";
import { RewardDesk, type IdkitConfig, type RewardDeps } from "./rewards.js";
import { WorldIdGate, worldIdConfigFromEnv, worldIdConfigured } from "../human/worldid.js";
import type { HumanCheckResult, HumanGate } from "../human/gate.js";
import { incidentOf, payReward, poolConfigFromEnv, poolConfigured } from "../og/anchor.js";
import { zerobotFromEnv } from "../zerobot/zerobot.js";
import { errMsg } from "../shared/util.js";

export interface DashboardOptions {
  deviceUrl?: string;
  arm?: ArmConfig;
  fetchImpl?: typeof fetch;
  /** Overrides for the verifier's networked lookups (tests). */
  verifyDeps?: Partial<VerifyDeps>;
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
  app.get("/api/episodes/:id", passthrough);
  app.get("/api/episodes/:id/meta", passthrough);

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
          items: r.rows.map((x) => ({ ...x, n: x.nDecisions })),
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

  // ---------------------------------------------------------------- verification (independent of the device)
  const verifyDeps = async (): Promise<VerifyDeps> => ({
    arm,
    requireDeviceSignature: true,
    expectedDevice: await deviceAddress().catch(() => undefined as unknown as string),
    ...(zbChain ? { readZerobotReceipt: (n: number) => zbChain.receipt(n) } : {}),
    ...opts.verifyDeps,
  });
  const relayUpload = opts.relayUpload ?? ((bytes: Uint8Array) => {
    const sc = storageConfigFromEnv(process.env.OG_OPERATOR_PRIVATE_KEY ?? "");
    if (!storageConfigured(sc)) throw new Error("no operator key for the relay (OG_OPERATOR_PRIVATE_KEY)");
    return uploadWithRetry(sc, bytes);
  });
  const withRelay = async (episodeId: string) => ({ ...(await verifyDeps()), relayedRoot: readRelay(episodeId)?.rootHash ?? null });
  const loadLog = async (id: string) => ({
    log: await device<EpisodeLog>(`/api/episodes/${encodeURIComponent(id)}`),
    meta: await device<EpisodeMeta>(`/api/episodes/${encodeURIComponent(id)}/meta`),
  });

  app.get("/api/verify/:id", async (req, res) => {
    try {
      const { log, meta } = await loadLog(String(req.params.id));
      res.json(await verifyEpisode(log, meta, await withRelay(log.episodeId)));
    } catch (e) {
      res.status((e as { status?: number }).status === 404 ? 404 : 502).json({ error: errMsg(e) });
    }
  });

  // Edit log: verify a COPY with one changed byte
  app.post("/api/verify/:id/tamper", async (req, res) => {
    try {
      const { log, meta } = await loadLog(String(req.params.id));
      const { copy, where } = tamperedCopy(log);
      res.json({ tampered: where, ...(await verifyEpisode(copy, meta, await withRelay(log.episodeId))) });
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  // Replay: the log comes from 0G Storage by the root the device recorded, not from the device's memory
  app.get("/api/replay/:id", async (req, res) => {
    try {
      const id = String(req.params.id);
      const meta = await device<EpisodeMeta>(`/api/episodes/${encodeURIComponent(id)}/meta`);
      const relay = readRelay(id);
      const root = meta.storage?.status === "ok" ? meta.storage.rootHash : relay?.rootHash;
      if (!root) {
        res.status(409).json({ error: "no 0G Storage root for this episode", storage: meta.storage ?? null });
        return;
      }
      const bytes = await downloadBytes(storageConfigFromEnv(), root);
      const log = JSON.parse(Buffer.from(bytes).toString("utf8")) as EpisodeLog;
      const verify = await verifyEpisode(log, meta, { ...(await withRelay(id)), downloadStorage: async () => bytes });
      res.json({ source: meta.storage?.status === "ok" ? "0g-storage" : "0g-storage (relayed)", rootHash: root, log, verify, canonical: canonicalize(log).length });
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  // ---------------------------------------------------------------- storage backup (R5)
  const relay = async (episodeId: string) => {
    const { log, meta } = await loadLog(episodeId);
    if (meta.storage?.status === "ok") return { status: "not needed: the device uploaded it", rootHash: meta.storage.rootHash };
    const rec = await relayEpisode(log, await deviceAddress(), relayUpload);
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

  // link the robot this dashboard is connected to: the DEVICE must sign the link message with its own key
  app.post("/api/robots/link", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    try {
      const nonce = randomBytes(16).toString("hex");
      const r = await postJson(`${deviceUrl}/api/link`, { accountId: a.accountId, nonce }, 35_000);
      const d = (await r.json()) as { address?: string; deviceId?: string; signature?: string; error?: string };
      if (!r.ok || !d.address || !d.signature) throw new Error(d.error ?? `device ${r.status}`);
      res.json(accounts.linkRobot(a.accountId, { address: d.address, deviceId: d.deviceId ?? "", deviceUrl, linkSignature: d.signature }, nonce));
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  // ---------------------------------------------------------------- reward claims (World ID Agent Pass + IDKit)
  const idkit: IdkitConfig | null = process.env.WORLD_APP_ID && process.env.WORLD_RP_ID && process.env.WORLD_RP_SIGNING_KEY
    ? { appId: process.env.WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, environment: (process.env.WORLD_ENV ?? "production") as IdkitConfig["environment"] }
    : null;
  const poolCfg = poolConfigFromEnv();
  const perSeverity = ethers.parseEther(process.env.REWARD_PER_SEVERITY_0G ?? "0.01");
  const maxReward = ethers.parseEther(process.env.REWARD_MAX_0G ?? "0.05");
  const rewardDeps: RewardDeps = {
    verify: async (episodeId, dev) => {
      const { log, meta } = await loadLog(episodeId);
      const v = await verifyEpisode(log, meta, { ...(await withRelay(episodeId)), expectedDevice: dev });
      return { result: v.result, failed: v.failed };
    },
    incident: async (episodeId) => {
      const { log } = await loadLog(episodeId);
      if (!log.device) throw new Error("the episode log is not device-signed");
      return { device: log.device.address, outcome: log.outcome, ...incidentOf(log) };
    },
    agentPass: () => agentPass,
    idkit,
    signRequest: (action) => signRequest({ signingKeyHex: process.env.WORLD_RP_SIGNING_KEY ?? "", action }),
    hashSignal: (s) => hashSignal(s),
    verifyProof: async (rpId, result) => {
      // forward the IDKit result unchanged (docs.world.org/world-id/idkit/integrate, Step 5)
      const r = await postJson(`https://developer.world.org/api/v4/verify/${encodeURIComponent(rpId)}`, result, 20_000);
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    },
    assess: async (body) => {
      const r = await postJson(`${process.env.INSURER_URL ?? "http://localhost:8090"}/assess`, body, 5000);
      if (!r.ok) throw new Error(`insurer HTTP ${r.status}`);
      return (await r.json()) as { status: string; amount: number; reason: string };
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

  // incidents on my robots that could be claimed
  app.get("/api/claimable", async (req, res) => {
    const a = requireAccount(req, res);
    if (!a) return;
    const out: unknown[] = [];
    const mine = new Set(a.robots.map((r) => r.address.toLowerCase()));
    if (mine.size) {
      try {
        const list = await device<{ items: { episodeId: string }[] }>("/api/episodes");
        for (const it of list.items.slice(0, 50)) {
          const inc = await rewardDeps.incident(it.episodeId).catch(() => null);
          if (inc && inc.incident && mine.has(inc.device.toLowerCase())) {
            out.push({ episodeId: it.episodeId, device: inc.device, severity: inc.severity, outcome: inc.outcome, claimable: inc.severity >= 2 });
          }
        }
      } catch {
        // robot offline: nothing listed
      }
    }
    res.json({ items: out });
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
      res.json(await desk.start(a, String((req.body as { episodeId?: unknown })?.episodeId ?? "")));
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
