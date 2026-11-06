/**
 * Arkiv claim records (owner decision 6 Nov 2026): one entity per reward claim, owned by the insurer desk's wallet
 * (OG_OPERATOR_PRIVATE_KEY, the wallet that pays from the RewardPool), PATCHED as the claim moves:
 * AGENT_PASS → IDKIT → INSURER_REVIEW → PAYING → PAID, or DENIED / FAILED. Anyone can read a run's claim history
 * and the insurer's queue from Arkiv; only the desk's wallet can change a record (Arkiv entity ownership).
 * Public facts only: run id, robot address, severity, status, amount and payout tx. Never the owner's account,
 * World ID nullifier, keys or the insurer's reason text.
 * SDK @arkiv-network/sdk 1.0.1: createEntity(schema, values, { expiration }) · patchEntity(schema, key, { set })
 * (an entity created without the readonly flag can be patched by its owner) · select().from().ownedBy().where()
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema";
import { http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../shared/env.js";
import { isPrivateKey } from "../shared/util.js";

export const CLAIM_SCHEMA = "pearl.claim.v1";

export const ClaimRecord = defineSchema(CLAIM_SCHEMA, {
  claimId: str().indexed(),
  episodeId: str().indexed(),
  device: str().indexed(), // the robot's address, lower case
  status: str().indexed(), // AGENT_PASS | IDKIT | INSURER_REVIEW | PAYING | PAID | DENIED | FAILED
  severity: i32().indexed(),
  ts: u64().indexed(), // last change, ms since epoch
  amountWei: str(), // fixed by severity
  payoutTx: str().optional(), // RewardPool payout on 0G Chain, once PAID
});

export interface ClaimArkivConfig {
  accessKey: string;
  privateKey: string;
  /** The desk wallet that owns the records (derived from the key, or ARKIV_CLAIM_WRITER for a reader). */
  writer: string;
  lifetimeDays: number;
}

export function claimArkivConfigFromEnv(): ClaimArkivConfig {
  loadEnv();
  const privateKey = process.env.OG_OPERATOR_PRIVATE_KEY ?? "";
  return {
    accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
    privateKey,
    writer: isPrivateKey(privateKey) ? privateKeyToAccount(privateKey as Hex).address : (process.env.ARKIV_CLAIM_WRITER ?? ""),
    lifetimeDays: Number(process.env.ARKIV_CLAIM_LIFETIME_DAYS ?? 90),
  };
}
export const claimWriterConfigured = (c: ClaimArkivConfig) => isPrivateKey(c.privateKey);
export const claimReaderConfigured = (c: ClaimArkivConfig) => isAddress(c.writer);

export interface ClaimFacts {
  claimId: string;
  episodeId: string;
  device: string;
  status: string;
  severity: number;
  ts: number;
  amountWei: string;
  payoutTx: string | null;
}

const wallet = (c: ClaimArkivConfig) =>
  createWalletClient({ chain: rabdi({ accessKey: c.accessKey }), transport: http(), account: privateKeyToAccount(c.privateKey as Hex) });

export async function createClaimRecord(c: ClaimArkivConfig, f: ClaimFacts): Promise<{ entityKey: string; txHash: string }> {
  if (!claimWriterConfigured(c)) throw new Error("no desk wallet key (OG_OPERATOR_PRIVATE_KEY) to write claim records");
  const r = await wallet(c).createEntity(
    ClaimRecord,
    {
      claimId: f.claimId,
      episodeId: f.episodeId,
      device: f.device.toLowerCase(),
      status: f.status,
      severity: f.severity,
      ts: u64(BigInt(f.ts)),
      amountWei: f.amountWei,
      payoutTx: f.payoutTx ?? undefined,
    },
    { expiration: ExpirationTime.fromDays(c.lifetimeDays) },
  );
  return { entityKey: r.entityKey, txHash: r.txHash };
}

export async function patchClaimRecord(c: ClaimArkivConfig, entityKey: string, f: Pick<ClaimFacts, "status" | "ts" | "payoutTx">): Promise<{ txHash: string }> {
  if (!claimWriterConfigured(c)) throw new Error("no desk wallet key (OG_OPERATOR_PRIVATE_KEY) to write claim records");
  const r = await wallet(c).patchEntity(ClaimRecord, entityKey as Hex, {
    set: { status: f.status, ts: u64(BigInt(f.ts)), ...(f.payoutTx ? { payoutTx: f.payoutTx } : {}) },
  });
  return { txHash: r.txHash };
}

const val = (v: unknown): unknown => (v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v);

export interface ClaimRow extends ClaimFacts {
  entityKey: string;
}

/** Claim records written by the desk wallet (owner filter: anyone can write this schema tag), newest first. */
export async function listClaimRecords(
  c: ClaimArkivConfig,
  filter: { episodeId?: string; device?: string; status?: string } = {},
  limit = 50,
): Promise<{ rows: ClaimRow[]; query: string; blockNumber: string }> {
  if (!claimReaderConfigured(c)) throw new Error("claim desk wallet unknown (OG_OPERATOR_PRIVATE_KEY or ARKIV_CLAIM_WRITER)");
  const preds = [
    ...(filter.episodeId ? [eq("episodeId", filter.episodeId)] : []),
    ...(filter.device ? [eq("device", filter.device.toLowerCase())] : []),
    ...(filter.status ? [eq("status", filter.status)] : []),
  ];
  let q = createPublicClient({ chain: rabdi({ accessKey: c.accessKey }), transport: http() }).select().from(ClaimRecord).ownedBy(c.writer as Hex);
  if (preds.length) q = q.where(and(...preds));
  q = q.orderBy(desc("ts")).limit(Math.min(limit, 100));
  const query = q.toString();
  const page = await q.fetch();
  const rows = page.entities.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      entityKey: String(r.$key ?? ""),
      claimId: String(val(r.claimId)),
      episodeId: String(val(r.episodeId)),
      device: String(val(r.device)),
      status: String(val(r.status)),
      severity: Number(val(r.severity)),
      ts: Number(val(r.ts)),
      amountWei: String(val(r.amountWei)),
      payoutTx: (val(r.payoutTx) as string | undefined) ?? null,
    };
  });
  return { rows, query, blockNumber: String(page.blockNumber) };
}
