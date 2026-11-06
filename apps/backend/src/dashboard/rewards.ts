/**
 * Reward claims (rev 5, R7; owner decisions 6 Nov 2026). After an incident on a robot you linked, you can claim a
 * reward. Claiming is the protected action, so it needs two human checks, both validated here on the backend:
 *
 *  1. World ID Agent Pass (World IdP OIDC, device grant; human/worldid.ts): a FRESH verification by the account owner
 *     right now. The validated ID token's pairwise subject must equal the account's subject.
 *  2. IDKit Proof of Human (docs.world.org/world-id/idkit/integrate): a uniqueness proof for action
 *     `claim:<episodeId>` with signal = the payout wallet. The backend signs the request (signRequest), checks the
 *     returned environment, action and signal hash, forwards the proof unchanged to
 *     POST https://developer.world.org/api/v4/verify/{rp_id}, then stores the nullifier per action: one claim per human
 *     per incident.
 *
 * With the claim, the owner's browser hands over this one run's key, locked for the insurer's key (the dashboard only
 * carries it). After both checks the claim WAITS FOR THE INSURER: a person on the Insurer page unlocks the incident,
 * runs the full check, watches the replay and approves or denies with a reason. Only after Approve does the dashboard
 * call the RewardPool on 0G Chain, for the amount fixed by severity; the pool itself re-checks that the device anchored
 * this incident with severity ≥ 2 and pays each (incident, nullifier) once. Denied, cancelled, expired, wrong person,
 * replayed proof, failed verification: nothing is paid, and the claim's history says why.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import type { HumanCheckPrompt, HumanCheckResult, HumanGate } from "../human/gate.js";
import type { Account } from "./accounts.js";
import { errMsg, readJson, writeJson } from "../shared/util.js";
import { runContext, type WrappedKey } from "../shared/seal.js";

export type ClaimStatus =
  | "AGENT_PASS" // waiting for the fresh World ID Agent Pass verification
  | "IDKIT" // waiting for the IDKit Proof of Human
  | "INSURER_REVIEW" // both human checks passed; waiting for a person at the insurer
  | "PAYING"
  | "PAID"
  | "DENIED" // the insurer said no, with a reason
  | "FAILED";

export interface InsurerReview {
  decision: "APPROVED" | "DENIED";
  reason: string;
  by: string; // the insurer wallet that signed in
  at: string;
}

export interface RewardClaim {
  claimId: string;
  accountId: string;
  episodeId: string;
  device: string;
  severity: number;
  wallet: string;
  action: string; // claim:<episodeId>
  status: ClaimStatus;
  failure: string | null;
  agentPass: { prompt: HumanCheckPrompt | null; subject?: string; acr?: string | null; idTokenSha256?: string } | null;
  nullifier: string | null;
  /** The amount the pool pays if the insurer approves: fixed by severity (owner decision 6 Nov 2026). */
  amountWei: string;
  /** This run's key, locked for the insurer's key by the owner's browser; only the insurer can open it. */
  insurerKey: WrappedKey;
  review: InsurerReview | null;
  payout: { amountWei: string; txHash: string } | null;
  history: { ts: string; status: ClaimStatus; note: string }[];
  createdAt: string;
}

export interface IdkitConfig {
  appId: string;
  rpId: string;
  environment: "production" | "staging" | "sandbox";
}

export interface RewardDeps {
  /** The public check of the locked run (anchor, 0G Storage, header, robot signature); needs no key. */
  verify: (episodeId: string, device: string) => Promise<{ result: "VALID" | "REJECTED"; failed: number[] }>;
  /**
   * Incident facts from the robot's own 0G Chain record (public; no key needed), looked up among `devices` (the
   * account's linked robots), so a claim works while the robot is offline.
   */
  incident: (episodeId: string, devices: string[]) => Promise<{ device: string; incident: boolean; severity: number; outcome: string }>;
  /** The insurer's public receiving key; claims cannot start until the insurer has set one up. */
  insurerKid: () => string | null;
  agentPass: () => HumanGate | null;
  idkit: IdkitConfig | null;
  signRequest: (action: string) => { sig: string; nonce: string; createdAt: number; expiresAt: number };
  hashSignal: (signal: string) => string;
  /** Forwards the IDKit result unchanged to World's verify API; returns its JSON body and HTTP status. */
  verifyProof: (rpId: string, result: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  pay: (p: { device: string; episodeId: string; claimant: string; to: string; amountWei: bigint }) => Promise<{ txHash: string }>;
  amountWeiFor: (severity: number) => bigint;
  requireValid: boolean;
}

export class RewardStore {
  constructor(private readonly path = process.env.REWARD_CLAIMS_FILE ?? resolve(REPO_ROOT, "data", "reward-claims.json")) {}
  all(): RewardClaim[] {
    return readJson<RewardClaim[]>(this.path, []);
  }
  get(id: string) {
    return this.all().find((c) => c.claimId === id);
  }
  put(c: RewardClaim) {
    const all = this.all().filter((x) => x.claimId !== c.claimId);
    all.unshift(c);
    writeJson(this.path, all);
    return c;
  }
  /** IDKit nullifiers are 256-bit numbers: compare as BigInt so casing/padding can't create duplicates. */
  nullifierUsed(nullifier: string, action: string): boolean {
    const n = BigInt(nullifier);
    return this.all().some((c) => c.nullifier !== null && c.action === action && BigInt(c.nullifier) === n);
  }
}

export class RewardDesk {
  constructor(private readonly deps: RewardDeps, private readonly store = new RewardStore()) {}

  list(accountId: string) {
    return this.store.all().filter((c) => c.accountId === accountId);
  }
  get(claimId: string, accountId: string) {
    const c = this.store.get(claimId);
    return c && c.accountId === accountId ? c : undefined;
  }

  private step(c: RewardClaim, status: ClaimStatus, note: string, patch: Partial<RewardClaim> = {}): RewardClaim {
    return this.store.put({ ...c, ...patch, status, history: [...c.history, { ts: new Date().toISOString(), status, note }] });
  }
  private fail(c: RewardClaim, why: string): RewardClaim {
    return this.step(c, "FAILED", why, { failure: why });
  }

  /** Claims the insurer may see: those that passed both human checks (or were withdrawn while it reviewed). */
  listForInsurer() {
    return this.store.all().filter((c) => c.status !== "AGENT_PASS" && c.status !== "IDKIT" && (c.status !== "FAILED" || c.history.some((h) => h.status === "INSURER_REVIEW")));
  }
  getForInsurer(claimId: string) {
    return this.listForInsurer().find((c) => c.claimId === claimId);
  }

  /** Starts a claim and the Agent Pass verification. Throws (no claim created) when the claim is not admissible. */
  async start(account: Account, episodeId: string, insurerKey: WrappedKey): Promise<RewardClaim> {
    if (!account.wallet) throw new Error("set a payout wallet first");
    const inc = await this.deps.incident(episodeId, account.robots.map((r) => r.address));
    if (!account.robots.some((r) => r.address.toLowerCase() === inc.device.toLowerCase())) {
      throw new Error("this episode belongs to a robot that is not linked to your account");
    }
    if (!inc.incident || inc.severity < 2) throw new Error(`not a claimable incident (severity ${inc.severity}; needs ≥ 2)`);
    const insurerKid = this.deps.insurerKid();
    if (!insurerKid) throw new Error("the insurer has not set up its receiving key yet, so it could not read this incident");
    if (!insurerKey || insurerKey.kid !== insurerKid) throw new Error("the incident key was not locked for the insurer's current key");
    if (insurerKey.context !== runContext(inc.device, episodeId)) throw new Error("the incident key belongs to a different robot or run");
    const open = this.store.all().find((c) => c.accountId === account.accountId && c.episodeId === episodeId && c.status !== "FAILED" && c.status !== "DENIED");
    if (open) throw new Error(`you already have a claim for this incident (${open.claimId}, ${open.status})`);
    if (this.deps.requireValid) {
      const v = await this.deps.verify(episodeId, inc.device);
      if (v.result !== "VALID") throw new Error(`the episode log does not verify (failed checks ${v.failed.join(", ")})`);
    }
    const gate = this.deps.agentPass();
    if (!gate) throw new Error("World ID Agent Pass is not configured (WORLDID_CLIENT_ID / WORLDID_CLIENT_SECRET)");
    if (!this.deps.idkit) throw new Error("IDKit is not configured (WORLD_APP_ID / WORLD_RP_ID / WORLD_RP_SIGNING_KEY)");

    const now = new Date().toISOString();
    let c: RewardClaim = this.store.put({
      claimId: `rc_${randomBytes(6).toString("hex")}`, accountId: account.accountId, episodeId, device: inc.device,
      severity: inc.severity, wallet: account.wallet, action: `claim:${episodeId}`, status: "AGENT_PASS", failure: null,
      agentPass: { prompt: null }, nullifier: null, amountWei: this.deps.amountWeiFor(inc.severity).toString(), insurerKey,
      review: null, payout: null, createdAt: now,
      history: [{ ts: now, status: "AGENT_PASS", note: "claim opened; fresh World ID Agent Pass verification requested" }],
    });
    const claimId = c.claimId;
    let prompted!: () => void;
    const promptReady = new Promise<void>((r) => (prompted = r));
    void gate
      .verify({ reason: `Claim a reward for incident ${episodeId} to ${account.wallet}` }, (p) => {
        const cur = this.store.get(claimId)!;
        this.store.put({ ...cur, agentPass: { prompt: p } });
        prompted();
      })
      .then((r) => this.onAgentPass(claimId, account, r))
      .finally(() => prompted());
    await Promise.race([promptReady, new Promise((r) => setTimeout(r, 10_000))]);
    c = this.store.get(claimId)!;
    return c;
  }

  private onAgentPass(claimId: string, account: Account, r: HumanCheckResult) {
    const c = this.store.get(claimId);
    if (!c || c.status !== "AGENT_PASS") return;
    if (!r.ok) return this.fail(c, `Agent Pass ${r.reason}: ${r.detail}`);
    if (r.subject !== account.subject || r.issuer !== account.issuer) {
      return this.fail(c, "Agent Pass was completed by a different World ID than the account owner");
    }
    return this.step(c, "IDKIT", "Agent Pass validated; IDKit Proof of Human requested", {
      agentPass: { prompt: null, subject: r.subject, acr: r.acr, idTokenSha256: r.idTokenSha256 },
    });
  }

  /** Cancels a pending claim (Agent Pass, IDKit or while the insurer reviews): nothing is paid. */
  cancel(claimId: string, accountId: string): RewardClaim {
    const c = this.get(claimId, accountId);
    if (!c) throw new Error("no such claim");
    if (c.status === "AGENT_PASS" && c.agentPass?.prompt) this.deps.agentPass()?.cancel(c.agentPass.prompt.attemptId);
    if (c.status === "AGENT_PASS" || c.status === "IDKIT") return this.fail(this.store.get(claimId)!, "cancelled by the owner");
    if (c.status === "INSURER_REVIEW") return this.fail(c, "withdrawn by the owner before the insurer decided");
    return c;
  }

  /** The insurer's decision (a person on the Insurer page). Approve pays the fixed severity amount from the pool. */
  async decide(claimId: string, d: { approve: boolean; reason: string; by: string }): Promise<RewardClaim> {
    const c = this.store.get(claimId);
    if (!c) throw new Error("no such claim");
    if (c.status !== "INSURER_REVIEW") throw new Error(`claim is ${c.status}, not waiting for the insurer`);
    const reason = d.reason.trim();
    if (!reason) throw new Error("give a reason; the owner sees it");
    if (reason.length > 500) throw new Error("keep the reason under 500 characters");
    const review: InsurerReview = { decision: d.approve ? "APPROVED" : "DENIED", reason, by: d.by, at: new Date().toISOString() };
    if (!d.approve) return this.step(c, "DENIED", `insurer denied: ${reason}`, { review, failure: `insurer denied: ${reason}` });
    const paying = this.step(c, "PAYING", `insurer approved: ${reason}; paying from the RewardPool`, { review });
    try {
      const claimant = `0x${BigInt(c.nullifier!).toString(16).padStart(64, "0").slice(-64)}`;
      const amountWei = BigInt(c.amountWei);
      const p = await this.deps.pay({ device: c.device, episodeId: c.episodeId, claimant, to: c.wallet, amountWei });
      return this.step(paying, "PAID", `RewardPool paid ${amountWei} wei of test 0G (tx ${p.txHash})`, { payout: { amountWei: amountWei.toString(), txHash: p.txHash } });
    } catch (e) {
      return this.fail(paying, `payout failed: ${errMsg(e)}`);
    }
  }

  /** What the browser needs to open the IDKit request: a fresh backend RP signature, never the signing key. */
  idkitRequest(claimId: string, accountId: string) {
    const c = this.get(claimId, accountId);
    if (!c) throw new Error("no such claim");
    if (c.status !== "IDKIT") throw new Error(`claim is ${c.status}, not waiting for IDKit`);
    const k = this.deps.idkit!;
    const s = this.deps.signRequest(c.action);
    return {
      app_id: k.appId,
      action: c.action,
      signal: c.wallet,
      environment: k.environment,
      rp_context: { rp_id: k.rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig },
    };
  }

  /** The browser reports either an IDKit error code (cancelled, user_rejected, timeout…) or the proof result. */
  async idkitResult(claimId: string, accountId: string, body: { error?: string; result?: Record<string, unknown> }): Promise<RewardClaim> {
    let c = this.get(claimId, accountId);
    if (!c) throw new Error("no such claim");
    if (c.status !== "IDKIT") throw new Error(`claim is ${c.status}, not waiting for IDKit`);
    if (body.error || !body.result) return this.fail(c, `IDKit ${body.error ?? "returned no result"}`);
    const k = this.deps.idkit!;
    const res = body.result;
    // never trust the client: environment, action and the signal (payout wallet) must be what this claim asked for
    if (res.environment !== k.environment) return this.fail(c, `IDKit proof from environment ${String(res.environment)}, expected ${k.environment}`);
    if (res.action !== c.action) return this.fail(c, "IDKit proof is for a different action");
    const responses = Array.isArray(res.responses) ? (res.responses as Record<string, unknown>[]) : [];
    if (!responses.length) return this.fail(c, "IDKit proof has no responses");
    const want = this.deps.hashSignal(c.wallet).toLowerCase();
    if (responses.some((r) => String(r.signal_hash ?? "").toLowerCase() !== want)) return this.fail(c, "IDKit proof is bound to a different wallet");
    if (responses.some((r) => r.identifier !== "proof_of_human")) return this.fail(c, "IDKit proof is not Proof of Human");

    const v = await this.deps.verifyProof(k.rpId, res).catch((e) => ({ status: 0, body: { detail: String(e) } as Record<string, unknown> }));
    if (v.status !== 200 || v.body.success !== true || v.body.environment !== k.environment) {
      return this.fail(c, `World verify rejected the proof (${String(v.body.code ?? v.status)}: ${String(v.body.detail ?? "")})`);
    }
    const nullifier = String(v.body.nullifier ?? responses[0]!.nullifier ?? "");
    if (!/^0x[0-9a-fA-F]+$/.test(nullifier)) return this.fail(c, "verify response has no nullifier");
    if (this.store.nullifierUsed(nullifier, c.action)) return this.fail(c, "this person already claimed this incident (nullifier replayed)");
    return this.step(c, "INSURER_REVIEW", "IDKit Proof of Human verified by World (one claim per human per incident); waiting for the insurer's review", { nullifier });
  }
}
