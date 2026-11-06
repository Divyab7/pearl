/**
 * Sealed relay bundle (shared spec v1 §1): everything a closed run needs to reach 0G Storage, 0G Chain and Arkiv,
 * packed so ANY carrier can submit it without a key, without funds and without being trusted:
 *  - files[] are the exact bytes for 0G Storage (the locked log + locked frames: unreadable, and any edit changes the root);
 *  - txs[] are raw EIP-1559 transactions pre-signed by the ROBOT key (storage Flow.submit per file, EpisodeAnchor.anchor,
 *    Arkiv execute), so records stay keyed by the robot's address and the robot's wallet pays;
 *  - bundleId = 0x + sha256(canonical JSON of the bundle without `sig`); sig = EIP-191 over `pearl/bundle/v1|<bundleId>`.
 * verifyBundle() is what every relayer runs before touching a chain.
 */
import { ethers } from "ethers";
import { canonicalize } from "../shared/canonical.js";
import { sha256Hex } from "../shared/hash.js";
import { recoverDevice } from "../shared/deviceKey.js";
import { anchorCalldata } from "../og/anchor.js";
import type { EpisodeOutcome } from "../shared/types.js";
import { errMsg } from "../shared/util.js";
import { CHAIN_IDS, FEE_FLOOR, GALILEO_TIP, GAS_LIMIT, isChainName, STORAGE_FEE_HEADROOM_PCT, type ChainName } from "./chains.js";
import type { PresignCache } from "./cache.js";
import { fileRoot, submitCall } from "./storageFlow.js";
import { presignArkivCreate } from "./arkivPresign.js";

export const OUTCOMES = ["DONE", "ABORTED", "FAILSAFE", "TRIPPED"] as const;

export interface BundleFile {
  role: "log" | "frame";
  idx?: number;
  root: string;
  size: number;
  /** standard base64 of the exact bytes */
  data: string;
}

export interface BundleTx {
  chain: ChainName;
  chainId: number;
  purpose: string; // storage:log | storage:frame:<idx> | anchor | arkiv
  nonce: number;
  hash: string;
  raw: string;
  file?: number;
}

export interface BundleSummary {
  outcome: EpisodeOutcome;
  incident: boolean;
  severity: number;
  headHash: string; // 0x + 64 hex
  rootHash: string; // 0G Storage root of the log file
}

export interface Bundle {
  v: 1;
  type: "pearl.bundle";
  episodeId: string;
  device: string;
  createdAt: string;
  summary: BundleSummary;
  files: BundleFile[];
  txs: BundleTx[];
  sig: string;
}

export const bundleMessage = (bundleId: string) => `pearl/bundle/v1|${bundleId}`;

/** 0x + sha256 of the canonical JSON of the bundle without its `sig` member. */
export function bundleIdOf(b: Omit<Bundle, "sig"> & { sig?: string }): string {
  const { sig: _sig, ...rest } = b;
  return `0x${sha256Hex(canonicalize(rest))}`;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const hex0x = (h: string) => (h.startsWith("0x") ? h.toLowerCase() : `0x${h.toLowerCase()}`);

/** The decoded bytes of a bundle file. */
export const fileBytes = (f: Pick<BundleFile, "data">): Uint8Array => unb64(f.data);

/** maxFeePerGas = max(3 × cached gas price, floor); tip = cached tip (Galileo: at least 2 gwei); tip ≤ maxFee. */
export function feesFor(chain: ChainName, cache: PresignCache): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const c = cache.chains[chain];
  const gp = BigInt(c.gasPrice || "0");
  const maxFee = 3n * gp > FEE_FLOOR[chain] ? 3n * gp : FEE_FLOOR[chain];
  let tip = BigInt(c.tip || "0");
  if (chain === "0g-galileo" && tip < GALILEO_TIP) tip = GALILEO_TIP;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip > maxFee ? maxFee : tip };
}

export interface BundleInput {
  episodeId: string;
  armId: string;
  endedAtMs: number;
  outcome: EpisodeOutcome;
  incident: boolean;
  severity: number;
  /** the log's head hash (64 hex, with or without 0x) */
  headHash: string;
  requestIds: string[];
  /** the locked log file (sealedBytes) */
  log: Uint8Array;
  /** locked frame files by decision index */
  frames: { idx: number; bytes: Uint8Array }[];
  /** EpisodeAnchor address; null = no anchor tx (OG_CHAIN_ANCHOR off or not deployed) */
  anchorAddress: string | null;
  /** Arkiv entity lifetime; null = no Arkiv tx (INDEX_ARKIV off) */
  arkivLifetimeDays: number | null;
  /** Arkiv entity-key salt (default: 16 random bytes, as the SDK does); the mesh simulator fixes it for determinism */
  arkivSalt?: bigint;
}

/**
 * Builds and signs a bundle with the robot's wallet, consuming nonces from the cache (returned updated; the caller
 * persists it). Needs a cached storage price (the robot's last online refresh).
 */
export async function buildBundle(
  wallet: ethers.Wallet,
  input: BundleInput,
  cache: PresignCache,
  now = new Date(),
): Promise<{ bundle: Bundle; cache: PresignCache }> {
  if (cache.device.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("pre-sign cache belongs to another device");
  if (!cache.storage) throw new Error("no cached 0G Storage price yet: the robot must be online once before it can pre-sign");
  const next: PresignCache = structuredClone(cache);
  const device = wallet.address;
  const files: BundleFile[] = [];
  const txs: BundleTx[] = [];
  const g = next.chains["0g-galileo"];
  const gFees = feesFor("0g-galileo", next);
  const signG = async (to: string, data: string, value: bigint, gasLimit: bigint) => {
    const raw = await wallet.signTransaction({
      type: 2, chainId: CHAIN_IDS["0g-galileo"], nonce: g.nextNonce, to, data, value, gasLimit, ...gFees,
    });
    const t = { nonce: g.nextNonce, raw, hash: ethers.keccak256(raw) };
    g.nextNonce++;
    return t;
  };

  const pricePerSector = BigInt(next.storage!.pricePerSector);
  const addFile = async (role: "log" | "frame", bytes: Uint8Array, idx?: number) => {
    const call = await submitCall(bytes, device);
    const fileIndex = files.length;
    files.push({ role, ...(idx !== undefined ? { idx } : {}), root: call.root, size: bytes.length, data: b64(bytes) });
    const fee = (call.feeFor(pricePerSector) * STORAGE_FEE_HEADROOM_PCT) / 100n;
    const t = await signG(next.storage!.flow, call.data, fee, GAS_LIMIT.storage);
    txs.push({ chain: "0g-galileo", chainId: CHAIN_IDS["0g-galileo"], purpose: role === "log" ? "storage:log" : `storage:frame:${idx}`, ...t, file: fileIndex });
    return { root: call.root, txHash: t.hash };
  };

  const log = await addFile("log", input.log);
  for (const f of [...input.frames].sort((a, b) => a.idx - b.idx)) await addFile("frame", f.bytes, f.idx);

  let anchorTx: string | null = null;
  if (input.anchorAddress) {
    const data = anchorCalldata({
      episodeId: input.episodeId, headHash: input.headHash.replace(/^0x/, ""), rootHash: log.root, requestIds: input.requestIds,
      outcome: input.outcome, severity: input.severity, incident: input.incident,
    });
    const t = await signG(input.anchorAddress, data, 0n, GAS_LIMIT.anchor);
    anchorTx = t.hash;
    txs.push({ chain: "0g-galileo", chainId: CHAIN_IDS["0g-galileo"], purpose: "anchor", ...t });
  }

  if (input.arkivLifetimeDays !== null) {
    const a = next.chains["arkiv-rabdi"];
    const r = await presignArkivCreate(
      wallet.privateKey,
      {
        kind: input.incident ? "incident" : "episode", armId: input.armId, episodeId: input.episodeId, outcome: input.outcome,
        endedAtMs: input.endedAtMs, severity: input.severity, headHash: input.headHash.replace(/^0x/, ""),
        rootHash: log.root, storageTx: log.txHash, anchorTx,
      },
      { nonce: a.nextNonce, gas: GAS_LIMIT.arkiv, ...feesFor("arkiv-rabdi", next), lifetimeDays: input.arkivLifetimeDays, ...(input.arkivSalt !== undefined ? { salt: input.arkivSalt } : {}) },
    );
    txs.push({ chain: "arkiv-rabdi", chainId: CHAIN_IDS["arkiv-rabdi"], purpose: "arkiv", nonce: a.nextNonce, hash: r.hash, raw: r.raw });
    a.nextNonce++;
  }

  const unsigned: Omit<Bundle, "sig"> = {
    v: 1, type: "pearl.bundle", episodeId: input.episodeId, device, createdAt: now.toISOString(),
    summary: { outcome: input.outcome, incident: input.incident, severity: input.severity, headHash: hex0x(input.headHash), rootHash: log.root },
    files, txs,
  };
  const id = bundleIdOf(unsigned);
  const bundle: Bundle = { ...unsigned, sig: await wallet.signMessage(bundleMessage(id)) };
  return { bundle, cache: next };
}

// ---------------------------------------------------------------- verification (every relayer, before any chain call)
export type VerifyResult = { ok: true; bundleId: string; bundle: Bundle } | { ok: false; error: string };

export interface VerifyOptions {
  /** chain name → accepted chainId (default CHAIN_IDS) */
  chainIds?: Partial<Record<ChainName, number>>;
  /** only accept bundles from this device */
  expectedDevice?: string;
  maxFiles?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isHex = (v: unknown, bytes?: number): v is string =>
  typeof v === "string" && (bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x[0-9a-fA-F]*$/).test(v);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function shape(b: unknown, maxFiles: number): string | null {
  if (!isObj(b)) return "bundle must be a JSON object";
  if (b.v !== 1 || b.type !== "pearl.bundle") return 'not a Pearl bundle (need v: 1, type: "pearl.bundle")';
  if (typeof b.episodeId !== "string" || !/^ep_[A-Za-z0-9_-]{1,120}$/.test(b.episodeId)) return "episodeId must look like ep_…";
  if (typeof b.device !== "string" || !ethers.isAddress(b.device)) return "device must be an address";
  if (typeof b.createdAt !== "string" || Number.isNaN(Date.parse(b.createdAt))) return "createdAt must be an ISO-8601 time";
  const s = b.summary;
  if (!isObj(s)) return "summary missing";
  if (!OUTCOMES.includes(s.outcome as EpisodeOutcome)) return "summary.outcome must be DONE|ABORTED|FAILSAFE|TRIPPED";
  if (typeof s.incident !== "boolean" || !Number.isInteger(s.severity) || (s.severity as number) < 0 || (s.severity as number) > 255) return "summary.incident/severity malformed";
  if (!isHex(s.headHash, 32) || !isHex(s.rootHash, 32)) return "summary.headHash/rootHash must be 0x + 64 hex";
  if (!Array.isArray(b.files) || b.files.length < 1 || b.files.length > maxFiles) return `files must be 1..${maxFiles} entries`;
  for (const [i, f] of b.files.entries()) {
    if (!isObj(f)) return `files[${i}] malformed`;
    if (f.role !== "log" && f.role !== "frame") return `files[${i}].role must be log or frame`;
    if (f.role === "frame" && !Number.isInteger(f.idx)) return `files[${i}].idx must be an integer`;
    if (!isHex(f.root, 32) || !Number.isInteger(f.size) || (f.size as number) < 1) return `files[${i}] root/size malformed`;
    if (typeof f.data !== "string" || !BASE64.test(f.data)) return `files[${i}].data must be base64`;
  }
  if (b.files.filter((f) => (f as BundleFile).role === "log").length !== 1 || (b.files[0] as BundleFile).role !== "log") return "files[0] must be the one log file";
  if (!Array.isArray(b.txs) || b.txs.length < 1 || b.txs.length > maxFiles + 2) return "txs malformed";
  for (const [i, t] of b.txs.entries()) {
    if (!isObj(t)) return `txs[${i}] malformed`;
    if (!isChainName(t.chain) || !Number.isInteger(t.chainId) || !Number.isInteger(t.nonce) || (t.nonce as number) < 0) return `txs[${i}] chain/chainId/nonce malformed`;
    if (typeof t.purpose !== "string" || !isHex(t.hash, 32) || !isHex(t.raw)) return `txs[${i}] purpose/hash/raw malformed`;
    if (t.file !== undefined && !Number.isInteger(t.file)) return `txs[${i}].file must be an integer`;
  }
  if (!isHex(b.sig, 65)) return "sig must be a 65-byte signature";
  return null;
}

/** Full relayer check (spec §1): shape, robot signature, tx senders, chain ids, file roots and storage calldata. */
export async function verifyBundle(input: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const bad = shape(input, opts.maxFiles ?? 64);
  if (bad) return { ok: false, error: bad };
  const b = input as Bundle;
  const device = ethers.getAddress(b.device);
  if (opts.expectedDevice && opts.expectedDevice.toLowerCase() !== device.toLowerCase()) return { ok: false, error: `bundle is from ${device}, expected ${opts.expectedDevice}` };
  const bundleId = bundleIdOf(b);
  const who = recoverDevice(bundleMessage(bundleId), b.sig);
  if (!who || who !== device) return { ok: false, error: `bad signature: recovers to ${who ?? "nobody"}, not the device ${device}` };

  // files: recompute every 0G Storage root from the bytes
  const bytes: Uint8Array[] = [];
  for (const [i, f] of b.files.entries()) {
    const d = fileBytes(f);
    if (d.length !== f.size) return { ok: false, error: `files[${i}]: size ${f.size} but data has ${d.length} bytes` };
    let root: string;
    try {
      root = await fileRoot(d);
    } catch (e) {
      return { ok: false, error: `files[${i}]: ${errMsg(e)}` };
    }
    if (root.toLowerCase() !== f.root.toLowerCase()) return { ok: false, error: `files[${i}]: root ${f.root} does not match its data (${root})` };
    bytes.push(d);
  }
  if (b.summary.rootHash.toLowerCase() !== b.files[0]!.root.toLowerCase()) return { ok: false, error: "summary.rootHash is not the log file's root" };

  const accepted = { ...CHAIN_IDS, ...(opts.chainIds ?? {}) };
  const lastNonce: Partial<Record<ChainName, number>> = {};
  const usedFiles = new Set<number>();
  const purposes = new Set<string>();
  for (const [i, t] of b.txs.entries()) {
    const where = `txs[${i}] (${t.purpose})`;
    if (t.chainId !== accepted[t.chain]) return { ok: false, error: `${where}: unexpected chainId ${t.chainId} for ${t.chain}` };
    let tx: ethers.Transaction;
    try {
      tx = ethers.Transaction.from(t.raw);
    } catch (e) {
      return { ok: false, error: `${where}: raw tx does not parse: ${errMsg(e)}` };
    }
    if (tx.type !== 2) return { ok: false, error: `${where}: not an EIP-1559 tx` };
    if (tx.chainId !== BigInt(t.chainId)) return { ok: false, error: `${where}: signed for chain ${tx.chainId}, labelled ${t.chainId}` };
    if (!tx.from || tx.from !== device) return { ok: false, error: `${where}: sent by ${tx.from ?? "nobody"}, not the device ${device}` };
    if (tx.hash?.toLowerCase() !== t.hash.toLowerCase()) return { ok: false, error: `${where}: hash does not match the raw tx` };
    if (tx.nonce !== t.nonce) return { ok: false, error: `${where}: nonce ${t.nonce} but the raw tx has ${tx.nonce}` };
    const prev = lastNonce[t.chain];
    if (prev !== undefined && t.nonce <= prev) return { ok: false, error: `${where}: nonces must increase in array order` };
    lastNonce[t.chain] = t.nonce;
    if (purposes.has(t.purpose)) return { ok: false, error: `${where}: duplicate purpose` };
    purposes.add(t.purpose);

    if (t.purpose.startsWith("storage:")) {
      if (t.chain !== "0g-galileo") return { ok: false, error: `${where}: storage txs go to 0g-galileo` };
      const fi = t.file;
      const f = fi === undefined ? undefined : b.files[fi];
      if (fi === undefined || !f || usedFiles.has(fi)) return { ok: false, error: `${where}: file index missing, wrong or reused` };
      usedFiles.add(fi);
      const want = f.role === "log" ? "storage:log" : `storage:frame:${f.idx}`;
      if (t.purpose !== want) return { ok: false, error: `${where}: purpose should be ${want} for files[${fi}]` };
      // the calldata must be the Flow.submit of exactly these bytes by this device
      const call = await submitCall(bytes[fi]!, device);
      if (call.data.toLowerCase() !== tx.data.toLowerCase()) return { ok: false, error: `${where}: calldata is not the Flow.submit of files[${fi}]` };
    } else if (t.purpose === "anchor") {
      if (t.chain !== "0g-galileo") return { ok: false, error: `${where}: the anchor goes to 0g-galileo` };
    } else if (t.purpose === "arkiv") {
      if (t.chain !== "arkiv-rabdi") return { ok: false, error: `${where}: the Arkiv tx goes to arkiv-rabdi` };
    } else {
      return { ok: false, error: `${where}: unknown purpose` };
    }
  }
  return { ok: true, bundleId, bundle: b };
}
