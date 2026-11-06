/**
 * The two chains a Pearl bundle writes to (spec §1): 0G Galileo (storage Flow + EpisodeAnchor) and Arkiv Rabdi.
 * Pre-signing constants (spec "Pre-signing rules"): fixed generous gas limits per purpose, a fee floor per chain, and
 * the Galileo default tip. The robot pays: maxFeePerGas × gasLimit must fit its balance, the chain only charges gas used.
 */
import { galileoRpc } from "../og/config.js";
import { arkivRpcUrl } from "../index/arkiv.js";
import { loadEnv } from "../shared/env.js";

export type ChainName = "0g-galileo" | "arkiv-rabdi";

export const CHAIN_IDS: Record<ChainName, number> = { "0g-galileo": 16602, "arkiv-rabdi": 7794095 };

export const isChainName = (s: unknown): s is ChainName => typeof s === "string" && s in CHAIN_IDS;

const GWEI = 1_000_000_000n;

/** maxFeePerGas = max(3 × cached gas price, floor). */
export const FEE_FLOOR: Record<ChainName, bigint> = { "0g-galileo": 10n * GWEI, "arkiv-rabdi": 2n * GWEI };
/** Galileo's default tip when the cached one is lower or missing. */
export const GALILEO_TIP = 2n * GWEI;

/** Fixed gas limits per purpose (well above what each call measured: Arkiv create ≈ 170 k, anchor and Flow submit < 300 k). */
export const GAS_LIMIT = { storage: 800_000n, anchor: 400_000n, arkiv: 600_000n } as const;

/** Storage fee headroom: cached pricePerSector × sectors × 120 %. */
export const STORAGE_FEE_HEADROOM_PCT = 120n;

/** The JSON-RPC endpoint the relayer uses for each chain (env-driven; the Arkiv access key is optional). */
export function rpcUrlFor(chain: ChainName): string {
  loadEnv();
  return chain === "0g-galileo" ? galileoRpc() : arkivRpcUrl(process.env.ARKIV_ACCESS_KEY ?? "");
}

/** 0G Storage indexer (lists the storage nodes; no key needed). */
export function storageIndexerUrl(): string {
  loadEnv();
  return process.env.OG_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
}
