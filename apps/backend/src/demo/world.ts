/**
 * DEMO WORKSPACE: the sample world. Built with the REAL recorder, policy, sealing and signing code, it holds a
 * simulated robot with locked sample runs (a normal run, incidents incl. a severity-3 one, a run whose 0G Storage upload
 * failed), an owner account with the robot linked and an unlock key, an insurer wallet + receiving key, and two claims
 * (one waiting for the insurer, one paid). Every networked dependency of the dashboard (0G Chain / Storage, Arkiv,
 * World ID, the RewardPool) is a local fake here: nothing in the demo touches a real network or real funds.
 * Its files live in a fresh temp directory (never data/), so a restart regenerates everything.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { commandsOf, policyIncident, policyPlan, policyVerifyGrasp, policyVerifyPlace } from "../orchestrator/policy.js";
import { Poses } from "../orchestrator/poses.js";
import { loadArmConfig } from "../shared/armConfig.js";
import { hashCanonical, sha256Hex } from "../shared/hash.js";
import { headMessage, linkMessage } from "../shared/deviceKey.js";
import { incidentOf, OUTCOME_CODE, requestIdsHash, type OnChainAnchor, type PoolInfo } from "../og/anchor.js";
import * as seal from "../shared/seal.js";
import { REPO_ROOT } from "../shared/env.js";
import { accountIdOf, type Account } from "../dashboard/accounts.js";
import { claimAction, type RewardClaim } from "../dashboard/rewards.js";
import type { ClaimFacts, ClaimRow } from "../index/arkivClaims.js";
import type { IndexRow } from "../index/arkiv.js";
import type { DashboardOptions } from "../dashboard/server.js";

export const DEMO_LABEL = "Demo data";
export const DEMO_ACTIONS_OFF = "Demo robot: actions are turned off here. The live robot is in the real app.";

/** The browser's stored unlock key (apps/dashboard/src/lib/keys.ts KeyRecord). */
export interface KeyRecord {
  type: "pearl-unlock-key";
  v: 1;
  role: "owner" | "insurer";
  who: string;
  kid: string;
  createdAt: string;
  privateJwk: seal.PrivateJwk;
}

/** Fixed demo-only wallets (no funds, never used on a real chain): same robot and insurer address on every start. */
const fixedWallet = (label: string) => new ethers.Wallet(`0x${createHash("sha256").update(`pearl-demo/${label}`).digest("hex")}`);

const ek = (seed: string) => `0x${createHash("sha256").update(`pearl-demo/entity/${seed}`).digest("hex")}`;
const fakeTx = () => `0x${randomBytes(32).toString("hex")}`;

type Built = { id: string; runKey: Uint8Array; sealed: seal.SealedEpisode; root: string | null; anchor: OnChainAnchor };

export interface DemoWorld {
  dir: string;
  device: ethers.Wallet;
  insurerWallet: ethers.Wallet;
  accountId: string;
  ownerKeyRecord: KeyRecord;
  insurerKeyRecord: KeyRecord;
  runIds: string[];
  /** Options for createDashboard(): the demo instance's own files and fakes for every networked dependency. */
  options: DashboardOptions;
  /** Wire the dashboard's claim desk in (new demo claims then pass the simulated IDKit step on their own). */
  attachDesk: (desk: { idkitResult: (id: string, accountId: string, body: { result?: Record<string, unknown> }) => Promise<unknown> }) => void;
}

export async function buildDemoWorld(): Promise<DemoWorld> {
  const dir = mkdtempSync(join(tmpdir(), "pearl-demo-"));
  const files = {
    accounts: join(dir, "accounts.json"),
    claims: join(dir, "claims.json"),
    insurerKey: join(dir, "insurer-key.json"),
    ledger: join(dir, "claim-arkiv.json"),
    relay: join(dir, "relay"),
    bundles: join(dir, "relay-bundles"),
  };
  const arm = loadArmConfig();
  const poses = new Poses(arm);
  const device = fixedWallet("robot");
  const insurerWallet = fixedWallet("insurer");
  const task = { task: "pick" as const, color: "red", from: "A2" as const, to: "BIN" as const };

  // ---------------------------------------------------------------- sample runs (sealed with the real code)
  let reqN = 4100;
  const T0 = Date.now() - 3 * 3600_000; // "this morning": a few hours before the server started
  const decision = (cp: string, parsed: unknown, t: number) => ({
    checkpoint: cp, source: "0g", model: "glm-5.3-flash", requestId: `0g-req-7f3a${(reqN++).toString(16)}e1c9`, httpRequestId: null,
    clientRequestId: `c-${reqN}`, clientRequestIdEchoed: true, provider: "0x9a4c…provider", providerIdentity: null, teeVerified: true,
    cost: null, zgResKey: null, reasoning: null, raw: JSON.stringify(parsed), parsed, error: null, latencyMs: 700 + (reqN % 9) * 90,
    ts: new Date(t).toISOString(), promptHash: "a".repeat(64), frameHash: null as string | null, frameRoot: null as string | null,
    telemetry: { state: "WAITING", joints: [90, 90, 90, 10], tofMm: 600, accG: 1 },
  });
  const failsafe = (cp: string, t: number) => ({
    ...decision(cp, null, t), source: "failsafe", model: null, requestId: null, raw: null, parsed: null, provider: null, teeVerified: null,
    error: "0G Router unreachable: connect ETIMEDOUT (Cut 0G)",
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Rec = any;
  const runs = new Map<string, Built>();
  const storage = new Map<string, Uint8Array>();
  const frameStore = new Map<string, Uint8Array>();
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const build = async (suffix: string, startMs: number, steps: (rec: Rec, t: () => number, runKey: Uint8Array) => Promise<string>, opts: { storageFails?: boolean } = {}) => {
    const id = `ep_${stamp(startMs)}_${suffix}`;
    let t = startMs;
    const tick = () => (t += 1800 + (t % 700));
    const rec: Rec = new EpisodeRecorder(id, "sim-arm-01", "arm-1", task);
    rec.addEvent({ ts: new Date(tick()).toISOString(), ev: "episode_start", data: { task, deviceState: "IDLE", armConfigHash: hashCanonical(arm) } });
    const runKey = seal.newRunKey();
    const outcome = await steps(rec, tick, runKey);
    rec.addEvent({ ts: new Date(tick()).toISOString(), ev: "episode_end", data: { outcome } });
    const log = rec.close(outcome);
    log.startedAt = new Date(startMs).toISOString();
    log.endedAt = new Date(t).toISOString();
    log.device = { address: device.address, signature: await device.signMessage(headMessage(log.episodeId, log.headHash)) };
    const inc = incidentOf(log);
    const sealed = await seal.sealEpisode(log, runKey, { ...inc, origin: null });
    const bytes = seal.sealedBytes(sealed);
    const root = opts.storageFails ? null : `0x${sha256Hex(bytes)}`;
    if (root) storage.set(root, bytes);
    const reqIds = log.records.flatMap((r: Rec) => (r.kind === "decision" && r.requestId ? [r.requestId] : []));
    const anchor: OnChainAnchor = {
      headHash: log.headHash, rootHash: root ?? ethers.ZeroHash, requestIdsHash: requestIdsHash(reqIds), anchoredAt: Math.floor(t / 1000) + 9,
      outcome: OUTCOME_CODE[outcome as keyof typeof OUTCOME_CODE], severity: inc.severity, incident: inc.incident,
    } as OnChainAnchor;
    runs.set(id, { id, runKey, sealed, root, anchor });
    return id;
  };
  const addDecision = (rec: Rec, d: Rec, p: { policy: string; override: string | null; steps: Rec[] }) =>
    rec.addDecision({ ...d, policy: p.policy, override: p.override, commandsSent: commandsOf(p.steps as never) });
  const frame = (name: string) => new Uint8Array(readFileSync(resolve(REPO_ROOT, "fixtures", "frames", name)));
  const [planJpeg, graspJpeg, incidentJpeg] = [frame("plan.jpg"), frame("verify_grasp.jpg"), frame("incident.jpg")];
  const withFrame = async (d: Rec, rec: Rec, runKey: Uint8Array, img: Uint8Array) => {
    const locked = await seal.lockFrame(runKey, img);
    frameStore.set(`${rec.episodeId}/${rec.nextIdx}`, locked);
    return { ...d, frameHash: sha256Hex(img), frameRoot: `0x${sha256Hex(locked)}` };
  };
  const P = (x: unknown) => x as never;

  // A: normal run, DONE, with camera photos
  await build("a1c4", T0 + 52 * 60_000, async (rec, t, k) => {
    const plan = await withFrame(decision("PLAN", { action: "PICK", slot: "A2", reason: "Red cube clearly visible at slot A2; path to the bin is clear.", confidence: 0.94 }, t()), rec, k, planJpeg);
    addDecision(rec, plan, policyPlan(P(plan), task, poses));
    const g = await withFrame(decision("VERIFY_GRASP", { action: "CONTINUE", grasped: true, reason: "Gripper closed on the red cube; cube lifted off A2.", confidence: 0.91 }, t()), rec, k, graspJpeg);
    addDecision(rec, g, policyVerifyGrasp(P(g), task, poses, 0));
    const pl = decision("VERIFY_PLACE", { action: "DONE", placed: true, reason: "Red cube is inside the bin.", confidence: 0.96 }, t());
    addDecision(rec, pl, policyVerifyPlace(P(pl), poses, 0));
    return "DONE";
  });
  // B: hard bump while carrying → TRIPPED, severity 3 (claimed; waiting for the insurer)
  const runB = await build("b7e2", T0 + 12 * 60_000, async (rec, t, k) => {
    const plan = decision("PLAN", { action: "PICK", slot: "A2", reason: "Red cube at A2.", confidence: 0.92 }, t());
    addDecision(rec, plan, policyPlan(P(plan), task, poses));
    const g = decision("VERIFY_GRASP", { action: "CONTINUE", grasped: true, reason: "Cube held.", confidence: 0.9 }, t());
    addDecision(rec, g, policyVerifyGrasp(P(g), task, poses, 0));
    rec.addEvent({ ts: new Date(t()).toISOString(), ev: "trip_bump", data: { accG: 2.7 } });
    const inc = await withFrame(decision("INCIDENT", { action: "RESUME", severity: 3, reason: "Base struck hard while carrying; cube dropped near A3. Arm stopped within limits.", confidence: 0.88, file_claim: true }, t()), rec, k, incidentJpeg);
    addDecision(rec, inc, policyIncident(P(inc), P({ hardTrip: true, frozenHand: false, handClear: true, remaining: [] })));
    rec.addEvent({ ts: new Date(t()).toISOString(), ev: "claim_requested", data: { checkpoint: "INCIDENT", severity: 3 } });
    return "TRIPPED";
  });
  // D: a hand in the work zone → froze, resumed after clear, severity 2 (claim paid)
  const runD = await build("d3f9", T0 + 25 * 60_000, async (rec, t) => {
    const plan = decision("PLAN", { action: "PICK", slot: "A2", reason: "Red cube at A2.", confidence: 0.93 }, t());
    addDecision(rec, plan, policyPlan(P(plan), task, poses));
    rec.addEvent({ ts: new Date(t()).toISOString(), ev: "hand_in_zone", data: { tofMm: 140 } });
    rec.addEvent({ ts: new Date(t()).toISOString(), ev: "hand_clear", data: { tofMm: 610 } });
    const inc = decision("INCIDENT", { action: "RESUME", severity: 2, reason: "A hand entered the work zone; it is clear now. Safe to resume.", confidence: 0.9 }, t());
    addDecision(rec, inc, policyIncident(P(inc), P({ hardTrip: false, frozenHand: true, handClear: true, remaining: [] })));
    const g = decision("VERIFY_GRASP", { action: "CONTINUE", grasped: true, reason: "Cube held.", confidence: 0.9 }, t());
    addDecision(rec, g, policyVerifyGrasp(P(g), task, poses, 0));
    const pl = decision("VERIFY_PLACE", { action: "DONE", placed: true, reason: "Cube in bin.", confidence: 0.95 }, t());
    addDecision(rec, pl, policyVerifyPlace(P(pl), poses, 0));
    return "DONE";
  });
  // F: another bump, severity 2, not claimed yet (the owner can claim it in the demo)
  await build("f0a6", T0 + 38 * 60_000, async (rec, t) => {
    const plan = decision("PLAN", { action: "PICK", slot: "A2", reason: "Red cube clearly at A2.", confidence: 0.9 }, t());
    addDecision(rec, plan, policyPlan(P(plan), task, poses));
    rec.addEvent({ ts: new Date(t()).toISOString(), ev: "trip_bump", data: { accG: 2.1 } });
    const inc = decision("INCIDENT", { action: "SAFE_STOP", severity: 2, reason: "Table knocked; arm stopped. Minor.", confidence: 0.86 }, t());
    addDecision(rec, inc, policyIncident(P(inc), P({ hardTrip: true, frozenHand: false, handClear: true, remaining: [] })));
    return "TRIPPED";
  });
  // C: 0G cut → failsafe; its 0G Storage upload failed (the public check shows the failure honestly)
  await build("c5b1", T0 - 20 * 60_000, async (rec, t) => {
    const d = failsafe("PLAN", t());
    addDecision(rec, d, policyPlan(P(d), task, poses));
    return "FAILSAFE";
  }, { storageFails: true });

  // ---------------------------------------------------------------- people: owner account, insurer, keys
  const owner = await seal.newRecipientKey();
  const insurer = await seal.newRecipientKey();
  const issuer = "https://auth.world.org";
  const subject = "demo-owner";
  const accountId = accountIdOf(issuer, subject);
  const payout = "0x8Ba1f109551bD432803012645Ac136ddd64DBA72";
  const linkNonce = "0123456789abcdef0123456789abcdef";
  const account: Account = {
    accountId, issuer, subject, createdAt: new Date(T0 - 86400_000).toISOString(), wallet: payout,
    key: { publicJwk: owner.publicJwk, kid: owner.kid, setAt: new Date(T0 - 86000_000).toISOString() },
    robots: [{
      address: device.address, deviceId: "sim-arm-01", deviceUrl: "http://demo-robot.local", linkedAt: new Date(T0 - 85000_000).toISOString(),
      ownerKid: owner.kid, linkSignature: await device.signMessage(linkMessage(accountId, linkNonce, owner.kid)),
    }],
  };
  writeFileSync(files.accounts, JSON.stringify([account], null, 2));
  writeFileSync(files.insurerKey, JSON.stringify({ publicJwk: insurer.publicJwk, kid: insurer.kid, setAt: new Date(T0 - 80000_000).toISOString(), by: insurerWallet.address }));
  const createdAt = new Date().toISOString();
  const ownerKeyRecord: KeyRecord = { type: "pearl-unlock-key", v: 1, role: "owner", who: accountId, kid: owner.kid, createdAt, privateJwk: owner.privateJwk };
  const insurerKeyRecord: KeyRecord = { type: "pearl-unlock-key", v: 1, role: "insurer", who: insurerWallet.address, kid: insurer.kid, createdAt, privateJwk: insurer.privateJwk };

  // ---------------------------------------------------------------- sample claims + their (fake) Arkiv records
  const ctxOf = (id: string) => seal.runContext(device.address, id);
  const claimB = runs.get(runB)!;
  const claimD = runs.get(runD)!;
  const hist = (start: number, rows: [RewardClaim["status"], string][]) => rows.map(([status, note], i) => ({ ts: new Date(start + i * 47_000).toISOString(), status, note }));
  const paidTx = "0x6a1e3c9f7b2d4e8a0c5f1b3d7e9a2c4f6b8d0e1a3c5f7b9d2e4a6c8f0b1d3e5a";
  const claims: RewardClaim[] = [
    {
      claimId: "rc_9b21f04c7a11", accountId, episodeId: claimB.id, device: device.address, severity: 3, wallet: payout, action: claimAction(claimB.id),
      status: "INSURER_REVIEW", failure: null, agentPass: { prompt: null, subject, acr: "https://world.org/oidc/acr/orb", idTokenSha256: "h" },
      nullifier: "0x1c4e9a77d02b5f3e8a61c0d94b7e2f5a3c8d1e6f9a0b4c7d2e5f8a1b3c6d9e0f", amountWei: ethers.parseEther("0.03").toString(),
      insurerKey: await seal.wrapRunKey(claimB.runKey, insurer.publicJwk, ctxOf(claimB.id)), review: null, payout: null,
      createdAt: new Date(T0 + 30 * 60_000).toISOString(),
      history: hist(T0 + 30 * 60_000, [
        ["AGENT_PASS", "claim opened; fresh World ID Agent Pass verification requested"],
        ["IDKIT", "Agent Pass validated; IDKit Proof of Human requested"],
        ["INSURER_REVIEW", "IDKit Proof of Human verified by World (one claim per human per incident); waiting for the insurer's review"],
      ]),
    },
    {
      claimId: "rc_3f8d6e2b0c94", accountId, episodeId: claimD.id, device: device.address, severity: 2, wallet: payout, action: claimAction(claimD.id),
      status: "PAID", failure: null, agentPass: { prompt: null, subject, acr: "https://world.org/oidc/acr/orb", idTokenSha256: "h" },
      nullifier: "0x2d5f0b88e13c6a4f9b72d1e05c8f3a6b4d9e2f7a0b1c5d8e3f6a9b2c4d7e0f1a", amountWei: ethers.parseEther("0.02").toString(),
      insurerKey: await seal.wrapRunKey(claimD.runKey, insurer.publicJwk, ctxOf(claimD.id)),
      review: { decision: "APPROVED", reason: "Hand entered the zone; arm froze and resumed only after clear. Matches severity 2.", by: insurerWallet.address, at: new Date(T0 + 44 * 60_000).toISOString() },
      payout: { amountWei: ethers.parseEther("0.02").toString(), txHash: paidTx },
      createdAt: new Date(T0 + 36 * 60_000).toISOString(),
      history: hist(T0 + 36 * 60_000, [
        ["AGENT_PASS", "claim opened"], ["IDKIT", "Agent Pass validated"], ["INSURER_REVIEW", "IDKit verified; waiting for the insurer's review"],
        ["PAYING", "insurer approved; paying from the RewardPool"], ["PAID", "RewardPool paid 20000000000000000 wei of test 0G"],
      ]),
    },
  ];
  writeFileSync(files.claims, JSON.stringify(claims, null, 2));
  const arkivClaims = new Map<string, ClaimRow>();
  const ledger: Record<string, unknown> = {};
  for (const c of claims) {
    const key = ek(c.claimId);
    const statuses = c.history.map((h) => h.status);
    arkivClaims.set(key, { entityKey: key, claimId: c.claimId, episodeId: c.episodeId, device: c.device.toLowerCase(), status: c.status, severity: c.severity, ts: Date.parse(c.history.at(-1)!.ts), amountWei: c.amountWei, payoutTx: c.payout?.txHash ?? null });
    ledger[c.claimId] = { entityKey: key, status: c.status, error: null, writes: statuses.map((st, i) => ({ status: st, txHash: ek(`${c.claimId}/${i}`), at: c.history[i]!.ts })) };
  }
  writeFileSync(files.ledger, JSON.stringify(ledger));

  // ---------------------------------------------------------------- the fake RewardPool
  const pool = {
    address: "0xeec59Be297d33bf4DCE12c2F9aC8D2Ce69E571Bb",
    balanceWei: ethers.parseEther("0.98"),
    paid: [{ txHash: paidTx, to: payout, amountWei: ethers.parseEther("0.02").toString(), block: 281002 }],
  };
  let block = 281075;

  // ---------------------------------------------------------------- the simulated robot's HTTP surface
  const scene = { slots: { A1: "blue", A2: "red", A3: null }, bin: [] as string[], holding: null };
  const tel = (ms: number) => {
    const s = Math.sin(ms / 2400);
    return {
      t: "tel", ms, state: "IDLE", joints: [90 + Math.round(s * 2), 92 + Math.round(Math.cos(ms / 3100) * 2), 88, 10], tofMm: 610 + Math.round(s * 4),
      accG: 1.01, hbAgeMs: 140, status: { ring: "dim green", buzzer: "off" }, scene,
    };
  };
  const list = () => [...runs.values()].reverse().map((r) => ({
    episodeId: r.id, locked: true, armId: "arm-1", kind: r.sealed.incident ? "incident" : "episode", outcome: r.sealed.outcome,
    severity: r.sealed.severity, ts: Date.parse(r.sealed.endedAt), headHash: r.sealed.headHash, device: device.address,
  }));
  let ownerKey: seal.PublicJwk = owner.publicJwk;
  const robotFetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === "/api/stream") {
      const enc = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => timer && clearInterval(timer);
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(": demo robot\n\n"));
          timer = setInterval(() => {
            try {
              c.enqueue(enc.encode(`event: tel\ndata: ${JSON.stringify(tel(Date.now()))}\n\n`));
            } catch {
              stop();
            }
          }, 1000);
          init?.signal?.addEventListener("abort", () => {
            stop();
            try {
              c.close();
            } catch {
              // already closed
            }
          });
        },
        cancel: stop,
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && path === "/api/link") {
      const b = JSON.parse(String(init!.body)) as { accountId: string; nonce: string; ownerKey: seal.PublicJwk };
      ownerKey = b.ownerKey;
      const kid = seal.keyId(b.ownerKey);
      return Response.json({ address: device.address, deviceId: "sim-arm-01", ownerKid: kid, signature: await device.signMessage(linkMessage(b.accountId, b.nonce, kid)) });
    }
    if (method !== "GET") return Response.json({ error: DEMO_ACTIONS_OFF }, { status: 409 });
    if (path === "/api/state") {
      return Response.json({
        deviceId: "sim-arm-01", deviceAddress: device.address, device: tel(Date.now()), deviceKind: "sim", status: { ring: "dim green", buzzer: "off" },
        handClear: true, hardTrip: false, orchestrator: { phase: "IDLE", episodeId: null, task: null, outcome: null, records: 0, lastDecision: null },
        scene, cameraKind: "none", cut0g: false, heartbeatPaused: false, demo: true,
        modules: { ogChainAnchor: "on", indexArkiv: "on", robotZerobot: "off" },
      });
    }
    if (path === "/api/episodes") return Response.json({ source: "device", items: list() });
    if (path === "/api/outbox") return Response.json({ items: [] });
    const m = path.match(/^\/api\/episodes\/([^/]+)(\/meta|\/key)?$/);
    if (m) {
      const r = runs.get(decodeURIComponent(m[1]!));
      if (!r) return Response.json({ error: "not found" }, { status: 404 });
      if (m[2] === "/meta") {
        return Response.json({
          episodeId: r.id,
          storage: r.root ? { status: "ok", rootHash: r.root, txHash: ek(`${r.id}/storage`), txSeq: 1, url: "demo", ms: 900 } : { status: "failed", error: "insufficient funds for gas" },
          // like a real robot's meta: its own 0G Chain record and Arkiv entry (sample hashes)
          anchor: { status: "ok", txHash: ek(`${r.id}/anchor`), address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", device: device.address },
          arkiv: { status: "ok", entityKey: ek(`${r.id}/arkiv`), txHash: ek(`${r.id}/arkiv-tx`) },
        });
      }
      if (m[2] === "/key") return Response.json(await seal.wrapRunKey(r.runKey, ownerKey, ctxOf(r.id)));
      return Response.json(r.sealed);
    }
    const fm = path.match(/^\/api\/frames\/([^/]+)\/(\d+)$/);
    if (fm) {
      const b = frameStore.get(`${fm[1]}/${fm[2]}`);
      if (!b) return Response.json({ error: "frame not available" }, { status: 404 });
      return new Response(b, { headers: { "content-type": "application/octet-stream", "x-frame-source": "0g-storage" } });
    }
    if (path.startsWith("/api/camera")) return Response.json({ error: "the demo robot has no camera" }, { status: 404 });
    if (path.startsWith("/api/zerobot")) return Response.json({ configured: false, items: [] });
    return Response.json({ error: "not found" }, { status: 404 });
  }) as unknown as typeof fetch;

  // ---------------------------------------------------------------- fake World ID (approves after a moment)
  const gate = {
    provider: "World ID",
    cancel: () => true,
    verify: async (_r: unknown, onPrompt: (p: { attemptId: string; provider: string; verificationUri: string; userCode: string; expiresAt: string }) => void) => {
      const attemptId = `demo-att-${randomBytes(6).toString("hex")}`;
      onPrompt({ attemptId, provider: "World ID", verificationUri: "https://world.org/device", userCode: "DEMO-4K7Q", expiresAt: new Date(Date.now() + 600_000).toISOString() });
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true as const, attemptId, provider: "World ID", issuer, subject, acr: "https://world.org/oidc/acr/orb", amr: ["pop"], authTime: Math.floor(Date.now() / 1000), idTokenSha256: "demo" };
    },
  };
  const idkit = { appId: "app_demo", rpId: "rp_demo", environment: "staging" as const };
  // a new demo claim at the IDKit step passes a simulated Proof of Human on its own (no World App needed)
  let desk: Parameters<DemoWorld["attachDesk"]>[0] | null = null;
  const { hashSignal } = await import("@worldcoin/idkit-core/hashing");
  const autoProve = (c: RewardClaim) => {
    if (c.status !== "IDKIT" || !desk) return;
    const d = desk;
    setTimeout(() => {
      const nullifier = `0x${randomBytes(32).toString("hex")}`;
      const result = { environment: idkit.environment, action: c.action, responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(c.wallet), nullifier }] };
      void d.idkitResult(c.claimId, c.accountId, { result }).catch(() => null);
    }, 1200).unref?.();
  };

  const options: DashboardOptions = {
    deviceUrl: "http://demo-robot.local",
    fetchImpl: robotFetch,
    arm,
    agentPass: gate as never,
    accountsFile: files.accounts,
    claimsFile: files.claims,
    insurerKeyFile: files.insurerKey,
    claimLedgerFile: files.ledger,
    relayDir: files.relay,
    relayBundlesDir: files.bundles,
    insurerAddress: insurerWallet.address,
    cookies: { owner: "pearl_demo_session", insurer: "pearl_demo_insurer", path: "/demo-api" },
    claimArkiv: { writer: fixedWallet("claim-desk").address },
    verifyDeps: {
      anchorOn: true, anchorAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", zerobotOn: false,
      readAnchor: async (_d: string, id: string) => runs.get(id)?.anchor ?? null,
      downloadStorage: async (root: string) => {
        const b = storage.get(root.toLowerCase()) ?? storage.get(root);
        if (!b) throw new Error("not found on 0G Storage");
        return b;
      },
      rootOf: async (b: Uint8Array) => `0x${sha256Hex(b)}`,
    },
    readPool: async (): Promise<PoolInfo> => ({ address: pool.address, balanceWei: pool.balanceWei.toString(), maxPayoutWei: ethers.parseEther("0.05").toString(), paid: [...pool.paid] }),
    relayUpload: async () => {
      throw new Error("Demo: the storage backup is turned off here (sample data).");
    },
    relaySubmit: async () => {
      throw new Error("Demo: the offline relay is turned off here (sample data).");
    },
    listIndex: (async (c: { writer: string }, filter: { armId?: string; kind?: string; outcome?: string } = {}, limit = 50) => {
      const rows: IndexRow[] = [...runs.values()].reverse()
        .filter((r) => (!filter.kind || (r.sealed.incident ? "incident" : "episode") === filter.kind) && (!filter.outcome || r.sealed.outcome === filter.outcome) && (!filter.armId || filter.armId === "arm-1"))
        .slice(0, limit)
        .map((r) => ({
          entityKey: ek(r.id), kind: r.sealed.incident ? "incident" : "episode", armId: "arm-1", episodeId: r.id, outcome: r.sealed.outcome,
          ts: Date.parse(r.sealed.endedAt), severity: r.sealed.severity, headHash: r.sealed.headHash, rootHash: r.root, anchorTx: ek(`${r.id}/anchor`),
        }));
      return { rows, blockNumber: String(block), query: `arkiv.schema = str('pearl.episode.v1')${filter.kind ? ` AND kind = str('${filter.kind}')` : ""} AND $owner = addr(${c.writer.toLowerCase()}) ORDER BY ts:u64 DESC` };
    }) as never,
    claimWriter: {
      create: async (f: ClaimFacts) => {
        const key = ek(f.claimId);
        arkivClaims.set(key, { ...f, device: f.device.toLowerCase(), entityKey: key });
        block += 1;
        return { entityKey: key, txHash: fakeTx() };
      },
      patch: async (key: string, f: Pick<ClaimFacts, "status" | "ts" | "payoutTx">) => {
        const cur = arkivClaims.get(key);
        if (cur) arkivClaims.set(key, { ...cur, status: f.status, ts: f.ts, payoutTx: f.payoutTx ?? cur.payoutTx });
        block += 1;
        return { txHash: fakeTx() };
      },
    },
    listClaimRecords: (async (c: { writer: string }, filter: { episodeId?: string; device?: string; status?: string } = {}) => ({
      query: `arkiv.schema = str('pearl.claim.v1')${filter.episodeId ? ` AND episodeId = str('${filter.episodeId}')` : ""} AND $owner = addr(${c.writer.toLowerCase()}) ORDER BY ts:u64 DESC`,
      blockNumber: String(block),
      rows: [...arkivClaims.values()]
        .filter((r) => (!filter.episodeId || r.episodeId === filter.episodeId) && (!filter.status || r.status === filter.status) && (!filter.device || r.device === filter.device.toLowerCase()))
        .sort((a, b) => b.ts - a.ts),
    })) as never,
    rewardDeps: {
      idkit,
      signRequest: () => ({ sig: `0x${"de".repeat(65)}`, nonce: randomBytes(16).toString("hex"), createdAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      verifyProof: async (_rpId: string, result: unknown) => {
        const r = result as { environment?: string; responses?: { nullifier?: string }[] };
        return { status: 200, body: { success: true, environment: r.environment, nullifier: r.responses?.[0]?.nullifier ?? `0x${randomBytes(32).toString("hex")}` } };
      },
      pay: async (p: { amountWei: bigint; to: string }) => {
        const txHash = fakeTx();
        pool.balanceWei -= p.amountWei;
        block += 1;
        pool.paid.unshift({ txHash, to: p.to, amountWei: p.amountWei.toString(), block });
        return { txHash };
      },
      requireValid: true,
      onChange: autoProve,
    },
  };

  return {
    dir, device, insurerWallet, accountId, ownerKeyRecord, insurerKeyRecord, runIds: [...runs.keys()], options,
    attachDesk: (d) => {
      desk = d;
    },
  };
}
