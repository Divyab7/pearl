import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { beforeAll, describe, expect, it } from "vitest";
import { newRecipientKey, newRunKey, runContext, wrapRunKey, type WrappedKey } from "../shared/seal.js";
import type { HumanCheckResult, HumanGate } from "../human/gate.js";
import type { Account } from "./accounts.js";
import { claimAction, RewardDesk, RewardStore, type RewardDeps } from "./rewards.js";

const DEVICE = ethers.Wallet.createRandom().address;
const WALLET = ethers.Wallet.createRandom().address;
const ISS = "https://auth.world.org";
const account = (over: Partial<Account> = {}): Account => ({
  accountId: "a".repeat(32), issuer: ISS, subject: "sub-owner", createdAt: "t", wallet: WALLET,
  robots: [{ address: DEVICE, deviceId: "sim", deviceUrl: "u", linkedAt: "t", linkSignature: "0x", ownerKid: "k" }], ...over,
});

/** A World ID Agent Pass stand-in that answers with a scripted outcome (the real client is tested in worldid.test.ts). */
function gate(outcome: "ok" | "denied" | "expired" | "other-person"): HumanGate & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    provider: "World ID",
    cancelled,
    cancel: (id) => (cancelled.push(id), true),
    async verify(_r, onPrompt) {
      onPrompt({ attemptId: "att-1", provider: "World ID", verificationUri: "https://world.example/device", userCode: "ABCD", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await new Promise((r) => setTimeout(r, 20));
      const base = { attemptId: "att-1", provider: "World ID" };
      if (outcome === "denied") return { ...base, ok: false, reason: "denied", detail: "access_denied" } as HumanCheckResult;
      if (outcome === "expired") return { ...base, ok: false, reason: "expired", detail: "expired_token" } as HumanCheckResult;
      return { ...base, ok: true, issuer: ISS, subject: outcome === "ok" ? "sub-owner" : "sub-stranger", acr: "https://world.org/oidc/acr/orb", amr: ["pop"], authTime: 1, idTokenSha256: "h" };
    },
  };
}

const ENV = "production" as const;
/** The insurer's receiving key and the incident key the owner's browser locks for it at claim time. */
let INSURER: Awaited<ReturnType<typeof newRecipientKey>>;
beforeAll(async () => {
  INSURER = await newRecipientKey();
});
const share = (episodeId: string, device = DEVICE): Promise<WrappedKey> => wrapRunKey(newRunKey(), INSURER.publicJwk, runContext(device, episodeId));
function deps(over: Partial<RewardDeps> = {}): RewardDeps & { paid: unknown[] } {
  const paid: unknown[] = [];
  return {
    paid,
    verify: async () => ({ result: "VALID", failed: [] }),
    incident: async () => ({ device: DEVICE, incident: true, severity: 2, outcome: "TRIPPED" }),
    agentPass: () => gate("ok"),
    idkit: { appId: "app_test", rpId: "rp_test", environment: ENV },
    signRequest: () => ({ sig: "0xsig", nonce: "0xnonce", createdAt: 1, expiresAt: 2 }),
    hashSignal,
    verifyProof: async (_rp, result) => ({ status: 200, body: { success: true, environment: ENV, nullifier: (result as { responses: { nullifier: string }[] }).responses[0]!.nullifier } }),
    insurerKid: () => INSURER.kid,
    pay: async (p) => (paid.push(p), { txHash: "0xpaid" }),
    amountWeiFor: (s) => ethers.parseEther("0.01") * BigInt(s),
    requireValid: true,
    ...over,
  };
}

const proof = (action: string, nullifier = "0x04e5f6", wallet = WALLET, env: string = ENV) => ({
  protocol_version: "4.0", nonce: "n", action, environment: env,
  responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(wallet), proof: ["0x1", "0x2", "0x3", "0x4", "0x5"], nullifier, issuer_schema_id: 1, expires_at_min: 1 }],
});

const desk = (d: RewardDeps) => new RewardDesk(d, new RewardStore(join(mkdtempSync(join(tmpdir(), "pearl-rc-")), "c.json")));
const waitFor = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("reward claims: World ID Agent Pass + IDKit Proof of Human", () => {
  it("full journey: request → Agent Pass → IDKit → World verify → insurer approves → RewardPool payout", async () => {
    const d = deps();
    const k = desk(d);
    const c = await k.start(account(), "ep_1", await share("ep_1"));
    expect(c.status).toBe("AGENT_PASS");
    expect(c.agentPass?.prompt?.userCode).toBe("ABCD");
    await waitFor(() => k.get(c.claimId, account().accountId)?.status === "IDKIT");
    const req = k.idkitRequest(c.claimId, account().accountId);
    expect(req).toMatchObject({ app_id: "app_test", action: "claim-ep-1", signal: WALLET, rp_context: { rp_id: "rp_test", signature: "0xsig" } });
    expect(k.listForInsurer()).toEqual([]); // the insurer sees nothing before both human checks pass
    const waiting = await k.idkitResult(c.claimId, account().accountId, { result: proof("claim-ep-1") });
    expect(waiting.status).toBe("INSURER_REVIEW");
    expect(d.paid).toEqual([]); // nothing is paid before a person at the insurer approves
    const seen = k.getForInsurer(c.claimId)!;
    expect(seen.insurerKey.kid).toBe(INSURER.kid);
    expect(seen.amountWei).toBe(ethers.parseEther("0.02").toString()); // fixed by severity 2
    const done = await k.decide(c.claimId, { approve: true, reason: "bump on video matches severity 2", by: "0xins" });
    expect(done.status).toBe("PAID");
    expect(done.review).toMatchObject({ decision: "APPROVED", reason: "bump on video matches severity 2", by: "0xins" });
    expect(done.payout).toMatchObject({ txHash: "0xpaid", amountWei: ethers.parseEther("0.02").toString() });
    expect(d.paid[0]).toMatchObject({ device: DEVICE, episodeId: "ep_1", to: WALLET });
    expect(done.history.map((h) => h.status)).toEqual(["AGENT_PASS", "IDKIT", "INSURER_REVIEW", "PAYING", "PAID"]);
    await expect(k.decide(c.claimId, { approve: true, reason: "again", by: "0xins" })).rejects.toThrow(/not waiting/);
  });

  it("every status change is handed to the Arkiv record, and a failing record never blocks the claim", async () => {
    const statuses: string[] = [];
    const d = deps({ onChange: (c) => { statuses.push(c.status); throw new Error("Arkiv down"); } });
    const k = desk(d);
    const c = await k.start(account(), "ep_1", await share("ep_1"));
    await waitFor(() => k.get(c.claimId, account().accountId)?.status === "IDKIT");
    await k.idkitResult(c.claimId, account().accountId, { result: proof("claim-ep-1") });
    expect((await k.decide(c.claimId, { approve: true, reason: "ok", by: "0xins" })).status).toBe("PAID");
    expect(statuses).toEqual(["AGENT_PASS", "IDKIT", "INSURER_REVIEW", "PAYING", "PAID"]);
  });

  const toReview = async (d: RewardDeps) => {
    const k = desk(d);
    const c = await k.start(account(), "ep_1", await share("ep_1"));
    await waitFor(() => k.get(c.claimId, account().accountId)?.status === "IDKIT");
    await k.idkitResult(c.claimId, account().accountId, { result: proof("claim-ep-1") });
    return { k, id: c.claimId };
  };

  it("the insurer denies with a reason: nothing is paid and the owner sees why; a reason is required", async () => {
    const d = deps();
    const { k, id } = await toReview(d);
    await expect(k.decide(id, { approve: false, reason: "   ", by: "0xins" })).rejects.toThrow(/reason/);
    const r = await k.decide(id, { approve: false, reason: "arm was outside its insured zone", by: "0xins" });
    expect(r).toMatchObject({ status: "DENIED", failure: "insurer denied: arm was outside its insured zone", review: { decision: "DENIED" } });
    expect(k.get(id, account().accountId)?.review?.reason).toBe("arm was outside its insured zone");
    expect(d.paid).toEqual([]);
  });

  it("a failed payout after Approve is shown, not hidden", async () => {
    const d = deps({ pay: async () => { throw new Error("NotAnIncident"); } });
    const { k, id } = await toReview(d);
    const r = await k.decide(id, { approve: true, reason: "ok", by: "0xins" });
    expect(r).toMatchObject({ status: "FAILED", failure: "payout failed: NotAnIncident" });
  });

  it("the owner can withdraw while the insurer reviews", async () => {
    const d = deps();
    const { k, id } = await toReview(d);
    expect(k.cancel(id, account().accountId)).toMatchObject({ status: "FAILED", failure: expect.stringMatching(/withdrawn/) });
    await expect(k.decide(id, { approve: true, reason: "ok", by: "0xins" })).rejects.toThrow(/not waiting/);
    expect(d.paid).toEqual([]);
  });

  it("refuses a claim whose incident key is not locked for the insurer's current key, or for another run", async () => {
    const other = await newRecipientKey();
    const wrongKid = await wrapRunKey(newRunKey(), other.publicJwk, runContext(DEVICE, "ep_1"));
    await expect(desk(deps()).start(account(), "ep_1", wrongKid)).rejects.toThrow(/insurer's current key/);
    await expect(desk(deps()).start(account(), "ep_1", await share("ep_2"))).rejects.toThrow(/different robot or run/);
    await expect(desk(deps({ insurerKid: () => null })).start(account(), "ep_1", await share("ep_1"))).rejects.toThrow(/receiving key/);
  });

  const failUntilIdkit = async (d: RewardDeps) => {
    const k = desk(d);
    const c = await k.start(account(), "ep_1", await share("ep_1"));
    await waitFor(() => k.get(c.claimId, account().accountId)?.status !== "AGENT_PASS");
    return { k, c: k.get(c.claimId, account().accountId)! };
  };

  it("Agent Pass denied or expired: claim fails, nothing paid", async () => {
    for (const o of ["denied", "expired"] as const) {
      const d = deps({ agentPass: () => gate(o) });
      const { c } = await failUntilIdkit(d);
      expect(c).toMatchObject({ status: "FAILED", failure: expect.stringContaining(`Agent Pass ${o}`) });
      expect(d.paid).toEqual([]);
    }
  });

  it("Agent Pass by someone other than the account owner is refused", async () => {
    const d = deps({ agentPass: () => gate("other-person") });
    const { c } = await failUntilIdkit(d);
    expect(c.failure).toMatch(/different World ID/);
  });

  it("IDKit cancelled, wrong environment, wrong wallet, wrong action, verify rejected: nothing paid", async () => {
    const cases: [Record<string, unknown>, RegExp, Partial<RewardDeps>?][] = [
      [{ error: "user_rejected" }, /IDKit user_rejected/],
      [{ result: proof("claim-ep-1", "0x1", WALLET, "staging") }, /environment staging/],
      [{ result: proof("claim-ep-1", "0x1", ethers.Wallet.createRandom().address) }, /different wallet/],
      [{ result: proof("claim-ep-other") }, /different action/],
      [{ result: proof("claim-ep-1") }, /nullifier reused/, { verifyProof: async () => ({ status: 200, body: { success: true, environment: "production", nullifier: "0x1", nullifier_reused: true } }) }],
      [{ result: proof("claim-ep-1") }, /World verify rejected/, { verifyProof: async () => ({ status: 400, body: { success: false, code: "all_verifications_failed" } }) }],
    ];
    for (const [body, why, over] of cases) {
      const d = deps(over);
      const { k, c } = await failUntilIdkit(d);
      expect(c.status).toBe("IDKIT");
      const r = await k.idkitResult(c.claimId, account().accountId, body as never);
      expect(r).toMatchObject({ status: "FAILED", failure: expect.stringMatching(why) });
      expect(d.paid).toEqual([]);
    }
  });

  it("the same human cannot claim the same incident twice (nullifier replay)", async () => {
    const d = deps();
    const k = desk(d);
    const second = account({ accountId: "b".repeat(32), subject: "sub-owner-2" });
    const c1 = await k.start(account(), "ep_1", await share("ep_1"));
    await waitFor(() => k.get(c1.claimId, account().accountId)?.status === "IDKIT");
    expect((await k.idkitResult(c1.claimId, account().accountId, { result: proof("claim-ep-1", "0xABC") })).status).toBe("INSURER_REVIEW");
    // a second account controlled by the same human produces the same nullifier for the same action
    d.agentPass = () => ({ ...gate("ok"), verify: async (r, p) => ({ ...(await gate("ok").verify(r, p)), subject: "sub-owner-2" }) as HumanCheckResult });
    const c2 = await k.start(second, "ep_1", await share("ep_1"));
    await waitFor(() => k.get(c2.claimId, second.accountId)?.status === "IDKIT");
    const r = await k.idkitResult(c2.claimId, second.accountId, { result: proof("claim-ep-1", "0xabc") });
    expect(r.failure).toMatch(/already claimed/);
    expect(k.listForInsurer().map((c) => c.claimId)).toEqual([c1.claimId]); // only the first claim reaches the insurer
  });

  it("refuses before any World ID step: unlinked robot, low severity, log that does not verify, no wallet", async () => {
    await expect(desk(deps()).start(account({ robots: [] }), "ep_1", await share("ep_1"))).rejects.toThrow(/not linked/);
    await expect(desk(deps({ incident: async () => ({ device: DEVICE, incident: true, severity: 1, outcome: "TRIPPED" }) })).start(account(), "ep_1", await share("ep_1"))).rejects.toThrow(/severity 1/);
    await expect(desk(deps({ verify: async () => ({ result: "REJECTED", failed: [3] }) })).start(account(), "ep_1", await share("ep_1"))).rejects.toThrow(/does not verify/);
    await expect(desk(deps()).start(account({ wallet: null }), "ep_1", await share("ep_1"))).rejects.toThrow(/wallet/);
  });

  it("the user can cancel while World ID is pending; nothing is paid", async () => {
    const slow: HumanGate = { provider: "World ID", cancel: () => true, verify: async (_r, onPrompt) => {
      onPrompt({ attemptId: "att-9", provider: "World ID", verificationUri: "u", userCode: "C", expiresAt: "t" });
      return new Promise(() => {});
    } };
    const d = deps({ agentPass: () => slow });
    const k = desk(d);
    const c = await k.start(account(), "ep_1", await share("ep_1"));
    expect(k.cancel(c.claimId, account().accountId)).toMatchObject({ status: "FAILED", failure: "cancelled by the owner" });
    expect(d.paid).toEqual([]);
  });

  it("IDKit action names follow the Developer Portal rule (lowercase, digits, hyphens, ≤ 32)", () => {
    for (const id of ["ep_1", "ep_20261106142947_f024", "ep_20261106142947_F024_extra_long_suffix"]) {
      const a = claimAction(id);
      expect(a).toMatch(/^[a-z0-9-]{1,32}$/);
    }
    expect(claimAction("ep_20261106142947_f024")).toBe("claim-ep-20261106142947-f024");
  });
});
