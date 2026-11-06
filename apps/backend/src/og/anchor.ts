/**
 * EpisodeAnchor v2 + RewardPool on 0G Chain (Galileo testnet, chain 16602; Solidity on 0G only, PLAN §7.2).
 * Sources: contracts/src/EpisodeAnchor.sol, contracts/src/RewardPool.sol. ethers 6: https://docs.ethers.org/v6/api/contract/
 * rev 5 (device-first): the DEVICE's own key sends anchor(), so records are keyed by the device address. The
 * dashboard's operator key only calls RewardPool.payout after a World ID–verified, approved claim.
 * Keys: episodeKey = keccak256(utf8(episodeId)); headHash = sha256 chain head; rootHash = 0G Storage root;
 * requestIdsHash = sha256(canonical JSON array of 0G request ids).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { canonicalize } from "../shared/canonical.js";
import { REPO_ROOT, loadEnv } from "../shared/env.js";
import { sha256Hex } from "../shared/hash.js";
import { isSafetyEventName, type EpisodeLog, type EpisodeOutcome } from "../shared/types.js";
import { chainWallet, galileoExplorer, galileoRpc } from "./config.js";
import { isPrivateKey } from "../shared/util.js";

export const ANCHOR_ABI = [
  "function anchor(bytes32 episodeKey, bytes32 headHash, bytes32 rootHash, bytes32 requestIdsHash, uint8 outcome, uint8 severity, bool incident)",
  "function get(address device, bytes32 episodeKey) view returns (tuple(bytes32 headHash, bytes32 rootHash, bytes32 requestIdsHash, uint64 anchoredAt, uint8 outcome, uint8 severity, bool incident))",
  "function countOf(address device) view returns (uint256)",
  "event EpisodeAnchored(address indexed device, bytes32 indexed episodeKey, bytes32 headHash, bytes32 rootHash, bytes32 requestIdsHash, uint8 outcome, uint8 severity, bool incident)",
];

export const POOL_ABI = [
  "function payout(address device, bytes32 episodeKey, bytes32 claimant, address to, uint256 amount)",
  "function paid(bytes32 key) view returns (bool)",
  "function claimKey(address device, bytes32 episodeKey, bytes32 claimant) pure returns (bytes32)",
  "function maxPayout() view returns (uint256)",
  "function operator() view returns (address)",
  "event Paid(address indexed device, bytes32 indexed episodeKey, bytes32 indexed claimant, address to, uint256 amount)",
];

export interface PoolInfo {
  address: string;
  balanceWei: string;
  maxPayoutWei: string;
  paid: { txHash: string; to: string; amountWei: string; block: number }[];
}

/** The pool as 0G Chain sees it: balance, max payout and recent Paid events (read-only; no key). */
export async function readPool(c: Pick<PoolConfig, "rpcUrl" | "address">, lookbackBlocks = 20_000): Promise<PoolInfo> {
  const provider = new ethers.JsonRpcProvider(c.rpcUrl);
  const pool = new ethers.Contract(c.address, POOL_ABI, provider);
  const [balance, max] = await Promise.all([provider.getBalance(c.address), pool.getFunction("maxPayout")()]);
  let paid: PoolInfo["paid"] = [];
  try {
    const head = await provider.getBlockNumber();
    const logs = await pool.queryFilter(pool.filters.Paid!(), Math.max(0, head - lookbackBlocks), head);
    paid = logs.slice(-10).reverse().map((l) => {
      const a = (l as ethers.EventLog).args;
      return { txHash: l.transactionHash, to: String(a?.to ?? ""), amountWei: String(a?.amount ?? 0n), block: l.blockNumber };
    });
  } catch {
    // some RPCs cap log ranges: show the balance without history rather than fail
  }
  return { address: c.address, balanceWei: balance.toString(), maxPayoutWei: String(max), paid };
}

export const OUTCOME_CODE: Record<EpisodeOutcome, number> = { DONE: 0, ABORTED: 1, FAILSAFE: 2, TRIPPED: 3 };

export interface AnchorConfig {
  rpcUrl: string;
  address: string;
  /** The device's key (rev 5). */
  privateKey: string;
  /** Explorer base for links. The /tx/<hash> path on chainscan-galileo is UNVERIFIED until clicked once. */
  explorer: string;
}

export function anchorConfigFromEnv(devicePrivateKey = ""): AnchorConfig {
  loadEnv();
  return {
    rpcUrl: galileoRpc(),
    address: process.env.OG_ANCHOR_ADDRESS ?? "",
    privateKey: devicePrivateKey,
    explorer: galileoExplorer(),
  };
}

export const anchorConfigured = (c: AnchorConfig) =>
  ethers.isAddress(c.address) && isPrivateKey(c.privateKey);

export const episodeKey = (episodeId: string) => ethers.id(episodeId);
const b32 = (hex: string | null) => (hex ? ethers.zeroPadValue(hex.startsWith("0x") ? hex : `0x${hex}`, 32) : ethers.ZeroHash);
export const requestIdsHash = (ids: string[]) => `0x${sha256Hex(canonicalize(ids))}`;

/** Incident facts from the log itself: any safety event, and the highest severity 0G gave in an INCIDENT decision. */
export function incidentOf(log: Pick<EpisodeLog, "records">): { incident: boolean; severity: number } {
  let incident = false;
  let severity = 0;
  for (const r of log.records) {
    if (r.kind === "event" && isSafetyEventName(r.ev)) incident = true;
    if (r.kind === "decision" && r.checkpoint === "INCIDENT" && r.source === "0g") {
      const s = (r.parsed as { severity?: number } | null)?.severity;
      if (typeof s === "number" && s > severity) severity = s;
    }
  }
  return { incident, severity };
}

export interface AnchorInput {
  episodeId: string;
  headHash: string; // 64 hex, no 0x
  rootHash: string | null; // 0x… or null when storage failed
  requestIds: string[];
  outcome: EpisodeOutcome;
  severity: number;
  incident: boolean;
}

/** The exact anchor() calldata for an episode (the relay bundle pre-signs it offline). */
export function anchorCalldata(a: AnchorInput): string {
  return new ethers.Interface(ANCHOR_ABI).encodeFunctionData("anchor", [
    episodeKey(a.episodeId), b32(a.headHash), b32(a.rootHash), requestIdsHash(a.requestIds),
    OUTCOME_CODE[a.outcome], a.severity, a.incident,
  ]);
}

export async function anchorEpisode(c: AnchorConfig, a: AnchorInput): Promise<{ txHash: string; address: string; device: string }> {
  const wallet = chainWallet(c.privateKey, c.rpcUrl);
  const contract = new ethers.Contract(c.address, ANCHOR_ABI, wallet);
  const tx = await contract.getFunction("anchor")(
    episodeKey(a.episodeId), b32(a.headHash), b32(a.rootHash), requestIdsHash(a.requestIds),
    OUTCOME_CODE[a.outcome], a.severity, a.incident,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`anchor tx ${tx.hash} failed`);
  return { txHash: tx.hash as string, address: c.address, device: wallet.address };
}

export interface OnChainAnchor {
  headHash: string; // 64 hex, no 0x
  rootHash: string; // 0x…
  requestIdsHash: string;
  anchoredAt: number;
  outcome: number;
  severity: number;
  incident: boolean;
}

export async function readAnchor(c: Pick<AnchorConfig, "rpcUrl" | "address">, device: string, episodeId: string): Promise<OnChainAnchor | null> {
  const contract = new ethers.Contract(c.address, ANCHOR_ABI, new ethers.JsonRpcProvider(c.rpcUrl));
  const r = await contract.getFunction("get")(device, episodeKey(episodeId));
  const at = Number(r.anchoredAt ?? r[3]);
  if (at === 0) return null;
  return {
    headHash: String(r.headHash ?? r[0]).slice(2),
    rootHash: String(r.rootHash ?? r[1]),
    requestIdsHash: String(r.requestIdsHash ?? r[2]),
    anchoredAt: at,
    outcome: Number(r.outcome ?? r[4]),
    severity: Number(r.severity ?? r[5]),
    incident: Boolean(r.incident ?? r[6]),
  };
}

// ---------------------------------------------------------------- RewardPool (dashboard operator)
export interface PoolConfig {
  rpcUrl: string;
  address: string;
  operatorKey: string;
}

export function poolConfigFromEnv(): PoolConfig {
  loadEnv();
  return {
    rpcUrl: galileoRpc(),
    address: process.env.OG_REWARD_POOL_ADDRESS ?? "",
    operatorKey: process.env.OG_OPERATOR_PRIVATE_KEY ?? "",
  };
}

export const poolConfigured = (c: PoolConfig) => ethers.isAddress(c.address) && isPrivateKey(c.operatorKey);

/** claimant = bytes32 IDKit nullifier (or any per-human id); amountWei in wei of test 0G. */
export async function payReward(
  c: PoolConfig,
  p: { device: string; episodeId: string; claimant: string; to: string; amountWei: bigint },
): Promise<{ txHash: string }> {
  const wallet = chainWallet(c.operatorKey, c.rpcUrl);
  const pool = new ethers.Contract(c.address, POOL_ABI, wallet);
  const tx = await pool.getFunction("payout")(p.device, episodeKey(p.episodeId), b32(p.claimant), p.to, p.amountWei);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`payout tx ${tx.hash} failed`);
  return { txHash: tx.hash as string };
}

// ---------------------------------------------------------------- deploy (from Foundry artifacts)
function artifact(name: string) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8")) as {
    abi: ethers.InterfaceAbi;
    bytecode: { object: string };
  };
}

export async function deployContract(rpcUrl: string, privateKey: string, name: string, args: unknown[] = []): Promise<{ address: string; txHash: string }> {
  const art = artifact(name);
  const wallet = chainWallet(privateKey, rpcUrl);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return { address: await contract.getAddress(), txHash: contract.deploymentTransaction()?.hash ?? "" };
}

export const deployAnchor = (rpcUrl: string, privateKey: string) => deployContract(rpcUrl, privateKey, "EpisodeAnchor");
export const deployPool = (rpcUrl: string, privateKey: string, anchor: string, maxPayoutWei: bigint) =>
  deployContract(rpcUrl, privateKey, "RewardPool", [anchor, maxPayoutWei]);
