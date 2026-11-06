/**
 * The robot's pre-signing cache (spec "Pre-signing rules"), persisted under data/presign/<device>.json:
 * next nonce per chain, last gas price and tip per chain, and the 0G Storage Flow address + pricePerSector.
 * Refreshed whenever the robot is online; offline the robot increments nonces locally as it signs bundles.
 * Nonces still reserved by bundles in the outbox win over the chain's pending count (they are not on-chain yet).
 */
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import { readJson, safeName, writeJson } from "../shared/util.js";
import { CHAIN_IDS, rpcUrlFor, type ChainName } from "./chains.js";
import { qtyBig, type JsonRpc } from "./rpc.js";
import { discoverStorageNodes, readStoragePrice, type StorageNodeInfo } from "./storageFlow.js";

export interface ChainCache {
  chainId: number;
  nextNonce: number;
  /** wei, decimal string */
  gasPrice: string;
  tip: string;
}

export interface PresignCache {
  device: string;
  updatedAt: string | null;
  chains: Record<ChainName, ChainCache>;
  storage: { flow: string; pricePerSector: string } | null;
}

export function presignDir(): string {
  return process.env.PRESIGN_DIR ?? resolve(REPO_ROOT, "data", "presign");
}

const cachePath = (device: string, dir: string) => resolve(dir, `${safeName(device.toLowerCase())}.json`);

export function emptyCache(device: string): PresignCache {
  const c = (name: ChainName): ChainCache => ({ chainId: CHAIN_IDS[name], nextNonce: 0, gasPrice: "0", tip: "0" });
  return { device, updatedAt: null, chains: { "0g-galileo": c("0g-galileo"), "arkiv-rabdi": c("arkiv-rabdi") }, storage: null };
}

export function loadCache(device: string, dir = presignDir()): PresignCache {
  return readJson<PresignCache>(cachePath(device, dir), emptyCache(device));
}

export function saveCache(c: PresignCache, dir = presignDir()): void {
  writeJson(cachePath(c.device, dir), c);
}

export interface RefreshDeps {
  rpc: JsonRpc;
  rpcUrl?: (chain: ChainName) => string;
  storageNodes?: () => Promise<StorageNodeInfo[]>;
}

/**
 * Online refresh: pending nonce (never below `reserved`, the next nonce after the outbox's bundles), gas price, tip,
 * and the storage price. Each part that fails keeps its previous value; the error list says what did.
 */
export async function refreshCache(
  prev: PresignCache,
  deps: RefreshDeps,
  reserved: Partial<Record<ChainName, number>> = {},
): Promise<{ cache: PresignCache; errors: string[] }> {
  const url = deps.rpcUrl ?? rpcUrlFor;
  const errors: string[] = [];
  const next: PresignCache = structuredClone(prev);
  for (const name of Object.keys(CHAIN_IDS) as ChainName[]) {
    const u = url(name);
    const c = next.chains[name];
    try {
      const pending = Number(qtyBig(await deps.rpc(u, "eth_getTransactionCount", [prev.device, "pending"])));
      c.nextNonce = Math.max(pending, reserved[name] ?? 0);
      c.gasPrice = qtyBig(await deps.rpc(u, "eth_gasPrice")).toString();
      try {
        c.tip = qtyBig(await deps.rpc(u, "eth_maxPriorityFeePerGas")).toString();
      } catch {
        c.tip = "0"; // not every node has it; the fee rule falls back to the chain default
      }
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  try {
    const nodes = await (deps.storageNodes ?? (() => discoverStorageNodes(deps.rpc)))();
    const p = await readStoragePrice(deps.rpc, url("0g-galileo"), nodes);
    next.storage = { flow: p.flow, pricePerSector: p.pricePerSector.toString() };
  } catch (e) {
    errors.push(`storage price: ${(e as Error).message}`);
  }
  if (errors.length < 3) next.updatedAt = new Date().toISOString();
  return { cache: next, errors };
}

