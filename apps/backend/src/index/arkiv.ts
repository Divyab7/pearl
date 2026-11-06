/**
 * Arkiv episode/incident index (PLAN Plus 1, §5). One read-only entity per closed episode, queryable by arm, kind,
 * outcome and time; the dashboard's episode list reads from here. SDK @arkiv-network/sdk 1.0.1 (checked in its src/):
 *  - rabdi({ accessKey }) is a FUNCTION; "" = public endpoint      src/chains/rabdi.ts          · docs start-here/clients
 *  - createPublicClient / createWalletClient({ chain, transport: http(), account })            · docs start-here/first-entity
 *  - defineSchema(name, columns), str/u64/i32/bytes, .indexed(), .optional()                   · docs schemas/define, schemas/column-types
 *    (a bare bigint means u256, so u64 columns get u64(...) values; strings ≤ 128 bytes)        · docs reference/limits
 *  - walletClient.createEntity(schema, values, { expiration, flags }) → { entityKey, txHash, expiresAt }
 *    ExpirationTime.fromDays(30); readonly entities cannot be patched                           · docs writing/create, writing/expiration, writing/change
 *  - publicClient.select("*").from(schema).ownedBy(addr).where(and(eq(..)…)).orderBy(desc("ts")).limit(n).fetch()
 *    → { entities: flat rows with typed values {type, value}, blockNumber, skipped }; builder.toString() = query text
 *                                                                                               · docs querying/select, filter, sort, paginate
 *  - owner filter is mandatory: anyone can write our schema tag                                 · docs schemas/define
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, desc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema";
import { http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../shared/env.js";
import { isPrivateKey } from "../shared/util.js";

/** v2 (6 Nov 2026): search labels and public fingerprints only; the decision count and 0G request ids were dropped. */
export const SCHEMA_NAME = "pearl.episode.v2";

export const EpisodeIndex = defineSchema(SCHEMA_NAME, {
  kind: str().indexed(), // "episode" | "incident"
  armId: str().indexed(),
  episodeId: str().indexed(),
  outcome: str().indexed(), // DONE | ABORTED | FAILSAFE | TRIPPED
  ts: u64().indexed(), // episode end, ms since epoch
  severity: i32().indexed(), // 0..3 from the INCIDENT decision, 0 otherwise
  headHash: str(), // fingerprint of the locked log's content (also on 0G Chain)
  rootHash: str().optional(), // 0G Storage root of the LOCKED file
  storageTx: str().optional(),
  anchorTx: str().optional(), // 0G Chain EpisodeAnchor tx
});

export interface ArkivConfig {
  accessKey: string;
  privateKey: string;
  writer: string;
  lifetimeDays: number;
}

/** rev 5: pass the device's key so the device owns (and signs) its own Arkiv entities. */
export function arkivConfigFromEnv(writerKey?: string): ArkivConfig {
  loadEnv();
  const privateKey = writerKey ?? "";
  return {
    accessKey: process.env.ARKIV_ACCESS_KEY ?? "",
    privateKey,
    // the writer (entity owner) is the device: derived from its key, or DEVICE_ADDRESS for a reader without the key
    writer: isPrivateKey(privateKey) ? privateKeyToAccount(privateKey as Hex).address : (process.env.DEVICE_ADDRESS ?? ""),
    lifetimeDays: Number(process.env.ARKIV_LIFETIME_DAYS ?? 30),
  };
}

export const arkivWriterConfigured = (c: ArkivConfig) => isPrivateKey(c.privateKey);
export const arkivReaderConfigured = (c: ArkivConfig) => isAddress(c.writer);

const ARKIV_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network";
/** Rabdi testnet JSON-RPC, with the optional access key. */
export const arkivRpcUrl = (accessKey = ""): string => `${ARKIV_RPC}${accessKey ? `/${accessKey}` : ""}`;

const publicClient = (c: Pick<ArkivConfig, "accessKey">) =>
  createPublicClient({ chain: rabdi({ accessKey: c.accessKey }), transport: http() });

export interface IndexInput {
  kind: "episode" | "incident";
  armId: string;
  episodeId: string;
  outcome: string;
  endedAtMs: number;
  severity: number;
  headHash: string;
  rootHash: string | null;
  storageTx: string | null;
  anchorTx: string | null;
}

const opt = <T>(v: T | null | undefined) => (v === null || v === undefined || v === "" ? undefined : v);

export async function indexEpisode(c: ArkivConfig, e: IndexInput): Promise<{ entityKey: string; txHash: string }> {
  if (!arkivWriterConfigured(c)) throw new Error("no device key to write to Arkiv");
  const wallet = createWalletClient({
    chain: rabdi({ accessKey: c.accessKey }),
    transport: http(),
    account: privateKeyToAccount(c.privateKey as Hex),
  });
  const r = await wallet.createEntity(
    EpisodeIndex,
    {
      kind: e.kind,
      armId: e.armId,
      episodeId: e.episodeId,
      outcome: e.outcome,
      ts: u64(BigInt(e.endedAtMs)),
      severity: e.severity,
      headHash: e.headHash,
      rootHash: opt(e.rootHash),
      storageTx: opt(e.storageTx),
      anchorTx: opt(e.anchorTx),
    },
    { expiration: ExpirationTime.fromDays(c.lifetimeDays), flags: { readonly: true } },
  );
  return { entityKey: r.entityKey, txHash: r.txHash };
}

export interface IndexRow {
  entityKey: string;
  kind: string;
  armId: string;
  episodeId: string;
  outcome: string;
  ts: number;
  severity: number;
  headHash: string;
  rootHash: string | null;
  anchorTx: string | null;
}

const val = (v: unknown): unknown => (v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v);

/** Reads our entities back from Arkiv (writer-owned only), newest first. Returns the rows and the exact query text. */
export async function listIndex(
  c: ArkivConfig,
  filter: { armId?: string; kind?: string; outcome?: string } = {},
  limit = 50,
): Promise<{ rows: IndexRow[]; query: string; blockNumber: string; skipped: number }> {
  if (!arkivReaderConfigured(c)) throw new Error("device address unknown: start the device, or set DEVICE_ADDRESS, to read the index");
  const preds = [
    ...(filter.armId ? [eq("armId", filter.armId)] : []),
    ...(filter.kind ? [eq("kind", filter.kind)] : []),
    ...(filter.outcome ? [eq("outcome", filter.outcome)] : []),
  ];
  let q = publicClient(c).select().from(EpisodeIndex).ownedBy(c.writer as Hex);
  if (preds.length) q = q.where(and(...preds));
  q = q.orderBy(desc("ts")).limit(Math.min(limit, 100));
  const query = q.toString();
  const page = await q.fetch();
  const rows = page.entities.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      entityKey: String(r.$key ?? ""),
      kind: String(val(r.kind)),
      armId: String(val(r.armId)),
      episodeId: String(val(r.episodeId)),
      outcome: String(val(r.outcome)),
      ts: Number(val(r.ts)),
      severity: Number(val(r.severity)),
      headHash: String(val(r.headHash)),
      rootHash: (val(r.rootHash) as string | undefined) ?? null,
      anchorTx: (val(r.anchorTx) as string | undefined) ?? null,
    };
  });
  return { rows, query, blockNumber: String(page.blockNumber), skipped: page.skipped };
}

/** The no-SDK query for judges (JSON-RPC arkiv_query, docs json-rpc/querying-data + reference/query-language). */
export function judgeCurl(c: ArkivConfig, armId = "arm-1"): string {
  const q = `arkiv.schema = str('${SCHEMA_NAME}') AND armId = str('${armId}') AND kind = str('incident') AND $owner = addr(${c.writer})`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "arkiv_query",
    params: [q, { select: { key: true, owner: true, expiresAt: true, attributes: true }, limit: "0xa" }],
  });
  // the query contains single quotes, so escape them for a single-quoted shell argument
  const shell = body.replace(/'/g, `'"'"'`);
  return `curl -s ${ARKIV_RPC} -H 'content-type: application/json' --data '${shell}'`;
}
