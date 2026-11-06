/**
 * Mirrors every reward claim onto Arkiv (index/arkivClaims.ts): the first change creates the claim's record, each
 * later one patches it. Writes for one claim run strictly in order and never block the claim itself: when Arkiv is
 * unreachable or the desk wallet has no tGLM, the claim goes on and the error is shown next to it.
 */
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import { errMsg, readJson, writeJson } from "../shared/util.js";
import type { ClaimFacts } from "../index/arkivClaims.js";
import type { RewardClaim } from "./rewards.js";

export interface ClaimArkivState {
  entityKey: string | null;
  /** Every Arkiv write for this claim: the create, then one patch per status change. */
  writes: { status: string; txHash: string; at: string }[];
  status: string | null; // the status Arkiv holds now
  error: string | null;
}

export interface LedgerWriter {
  create: (f: ClaimFacts) => Promise<{ entityKey: string; txHash: string }>;
  patch: (entityKey: string, f: Pick<ClaimFacts, "status" | "ts" | "payoutTx">) => Promise<{ txHash: string }>;
}

export function factsOf(c: RewardClaim, now = Date.now()): ClaimFacts {
  return {
    claimId: c.claimId,
    episodeId: c.episodeId,
    device: c.device,
    status: c.status,
    severity: c.severity,
    ts: now,
    amountWei: c.amountWei,
    payoutTx: c.payout?.txHash ?? null,
  };
}

export class ClaimLedger {
  private state: Record<string, ClaimArkivState>;
  private chains = new Map<string, Promise<void>>();

  constructor(
    private readonly writer: LedgerWriter | null,
    private readonly path = process.env.CLAIM_LEDGER_FILE ?? resolve(REPO_ROOT, "data", "claim-arkiv.json"),
  ) {
    this.state = readJson<Record<string, ClaimArkivState>>(this.path, {});
  }

  get(claimId: string): ClaimArkivState | null {
    return this.state[claimId] ?? null;
  }

  /** Queues the claim's current status for Arkiv; resolves when this write (and earlier ones) finished. */
  record(c: RewardClaim): Promise<void> {
    const facts = factsOf(c);
    const prev = this.chains.get(c.claimId) ?? Promise.resolve();
    const next = prev.then(() => this.write(facts));
    this.chains.set(c.claimId, next);
    return next;
  }

  private save(id: string, s: ClaimArkivState) {
    this.state[id] = s;
    writeJson(this.path, this.state);
  }

  private async write(f: ClaimFacts): Promise<void> {
    const s: ClaimArkivState = this.state[f.claimId] ?? { entityKey: null, writes: [], status: null, error: null };
    if (!this.writer) {
      this.save(f.claimId, { ...s, error: "Arkiv claim records are off (no desk wallet key)" });
      return;
    }
    if (s.status === f.status) return;
    try {
      if (!s.entityKey) {
        const r = await this.writer.create(f);
        this.save(f.claimId, { entityKey: r.entityKey, writes: [...s.writes, { status: f.status, txHash: r.txHash, at: new Date().toISOString() }], status: f.status, error: null });
      } else {
        const r = await this.writer.patch(s.entityKey, f);
        this.save(f.claimId, { ...s, writes: [...s.writes, { status: f.status, txHash: r.txHash, at: new Date().toISOString() }], status: f.status, error: null });
      }
    } catch (e) {
      const msg = errMsg(e);
      const funded = /insufficient funds|balance/i.test(msg) ? "the desk wallet has no tGLM on Arkiv (faucet: https://hub.arkiv.network/faucet)" : msg;
      this.save(f.claimId, { ...s, error: `Arkiv write for ${f.status} failed: ${funded.slice(0, 300)}` });
    }
  }
}
