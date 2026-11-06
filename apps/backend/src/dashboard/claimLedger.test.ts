import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaimLedger, type LedgerWriter } from "./claimLedger.js";
import type { RewardClaim } from "./rewards.js";

const file = () => join(mkdtempSync(join(tmpdir(), "pearl-ledger-")), "l.json");
const claim = (status: RewardClaim["status"], payout: RewardClaim["payout"] = null): RewardClaim =>
  ({
    claimId: "rc_1", accountId: "acc-secret", episodeId: "ep_1", device: "0xAbC0000000000000000000000000000000000001", severity: 2, wallet: "0xw",
    action: "claim:ep_1", status, failure: null, agentPass: null, nullifier: "0x1234", amountWei: "20000000000000000",
    insurerKey: { kid: "k" } as never, review: null, payout, history: [], createdAt: "t",
  }) as RewardClaim;

function fakeWriter(failFirst = false) {
  const calls: { op: string; key?: string; facts: Record<string, unknown> }[] = [];
  let fails = failFirst ? 1 : 0;
  const w: LedgerWriter = {
    create: async (f) => {
      if (fails-- > 0) throw new Error("insufficient funds for gas * price + value");
      calls.push({ op: "create", facts: { ...f } });
      return { entityKey: "0xentity", txHash: `0xtx${calls.length}` };
    },
    patch: async (key, f) => {
      calls.push({ op: "patch", key, facts: { ...f } });
      return { txHash: `0xtx${calls.length}` };
    },
  };
  return { w, calls };
}

describe("Arkiv claim records", () => {
  it("the first status creates the record, every later one patches it, in order; only public facts are written", async () => {
    const { w, calls } = fakeWriter();
    const l = new ClaimLedger(w, file());
    void l.record(claim("AGENT_PASS"));
    void l.record(claim("IDKIT"));
    void l.record(claim("INSURER_REVIEW"));
    void l.record(claim("PAYING"));
    await l.record(claim("PAID", { amountWei: "20000000000000000", txHash: "0xpaid" }));
    expect(calls.map((c) => c.op)).toEqual(["create", "patch", "patch", "patch", "patch"]);
    expect(calls.map((c) => c.facts.status)).toEqual(["AGENT_PASS", "IDKIT", "INSURER_REVIEW", "PAYING", "PAID"]);
    expect(calls.slice(1).every((c) => c.key === "0xentity")).toBe(true);
    expect(calls[4]!.facts.payoutTx).toBe("0xpaid");
    const s = l.get("rc_1")!;
    expect(s).toMatchObject({ entityKey: "0xentity", status: "PAID", error: null });
    expect(s.writes).toHaveLength(5);
    // never the owner's account, World ID nullifier or keys
    const written = JSON.stringify(calls);
    expect(written).not.toContain("acc-secret");
    expect(written).not.toContain("0x1234");
    expect(written).not.toContain("insurerKey");
  });

  it("an unfunded desk wallet is reported, the claim goes on, and the next change creates the record", async () => {
    const { w, calls } = fakeWriter(true);
    const path = file();
    const l = new ClaimLedger(w, path);
    await l.record(claim("AGENT_PASS"));
    expect(l.get("rc_1")!.error).toMatch(/no tGLM/);
    await l.record(claim("IDKIT"));
    expect(calls.map((c) => [c.op, c.facts.status])).toEqual([["create", "IDKIT"]]);
    expect(l.get("rc_1")).toMatchObject({ entityKey: "0xentity", status: "IDKIT", error: null });
    // persisted: a restarted dashboard keeps patching the same record
    expect(new ClaimLedger(w, path).get("rc_1")!.entityKey).toBe("0xentity");
  });

  it("off without a desk wallet key: says so", async () => {
    const l = new ClaimLedger(null, file());
    await l.record(claim("AGENT_PASS"));
    expect(l.get("rc_1")!.error).toMatch(/off/);
  });
});
