/**
 * The relayer (shared spec v1 §2), used by the laptop relay and by the robot when it flushes its own outbox.
 * For each pre-signed tx in array order: eth_sendRawTransaction (an "already known" / already-mined tx with the same
 * hash counts as sent), wait for a status-1 receipt; after a storage:* receipt read the Flow Submit event → txSeq and
 * upload the file's segments with zgs_uploadSegmentsByTxSeq (no key needed), then wait until the node says finalized.
 * If a tx's nonce was used by a DIFFERENT tx the bundle is `stale` (the robot must re-sign).
 * Idempotent: re-running a bundle re-checks every step, so a restart or a second carrier is harmless.
 * Every network call goes through the injected JsonRpc, so tests run against fakes.
 */
import { ENTITY_EVENTS_ABI } from "@arkiv-network/sdk/entity";
import { ethers } from "ethers";
import { toEventSelector, type AbiEvent } from "viem";
import { errMsg } from "../shared/util.js";
import { fileBytes, type Bundle } from "./bundle.js";
import { rpcUrlFor, type ChainName } from "./chains.js";
import { qtyBig, type JsonRpc } from "./rpc.js";
import { discoverStorageNodes, segmentsOf, submitEventOf, type StorageNodeInfo } from "./storageFlow.js";

export type BundleState = "received" | "submitting" | "done" | "failed" | "stale";

export interface Step {
  purpose: string;
  txHash: string;
  status: "pending" | "ok" | "failed" | "stale";
  error?: string;
  /** storage:* only: the Flow submission index, and whether the nodes report the file finalized */
  txSeq?: number;
  finalized?: boolean;
  /** arkiv only: the created entity key */
  entityKey?: string;
  block?: number;
}

export interface SubmitDeps {
  rpc: JsonRpc;
  rpcUrl?: (chain: ChainName) => string;
  storageNodes?: () => Promise<StorageNodeInfo[]>;
  sleep?: (ms: number) => Promise<void>;
  receiptTimeoutMs?: number;
  storageTimeoutMs?: number;
  pollMs?: number;
}

export const initialSteps = (b: Bundle): Step[] => b.txs.map((t) => ({ purpose: t.purpose, txHash: t.hash, status: "pending" }));

const ALREADY_KNOWN = /already known|known transaction|already imported|already exists|already in (the )?(tx )?pool|alreadyknown/i;
const NONCE_USED = /nonce too low|nonce has already been used|invalid nonce|nonce.*(lower|already)|replacement transaction underpriced|could not replace/i;
const SEGMENT_DONE = /already uploaded|already finalized|finalized/i;

const ENTITY_CREATED = (() => {
  const ev = (ENTITY_EVENTS_ABI as readonly { type: string; name?: string }[]).find((e) => e.type === "event" && e.name === "EntityCreated");
  return ev ? toEventSelector(ev as AbiEvent).toLowerCase() : null;
})();

interface Receipt {
  status: string;
  blockNumber?: string;
  logs: { address: string; topics: string[]; data: string }[];
}

class StaleError extends Error {}

export async function submitBundle(
  bundle: Bundle,
  deps: SubmitDeps,
  opts: { steps?: Step[]; onStep?: (steps: Step[], state: BundleState) => void } = {},
): Promise<{ state: BundleState; steps: Step[] }> {
  const url = deps.rpcUrl ?? rpcUrlFor;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 1500;
  const receiptTimeout = deps.receiptTimeoutMs ?? 120_000;
  const storageTimeout = deps.storageTimeoutMs ?? 180_000;
  const steps: Step[] = opts.steps && opts.steps.length === bundle.txs.length ? opts.steps.map((s) => ({ ...s })) : initialSteps(bundle);
  const emit = (state: BundleState) => opts.onStep?.(steps.map((s) => ({ ...s })), state);
  let nodes: StorageNodeInfo[] | null = null;
  const storageNodes = async () => (nodes ??= await (deps.storageNodes ?? (() => discoverStorageNodes(deps.rpc)))());

  emit("submitting");
  for (const [i, t] of bundle.txs.entries()) {
    const step = steps[i]!;
    const isStorage = t.purpose.startsWith("storage:");
    if (step.status === "ok" && (!isStorage || step.finalized)) continue;
    const u = url(t.chain);
    try {
      const receipt = await sendAndWait(deps.rpc, u, bundle.device, t.raw, t.hash, t.nonce, { sleep, pollMs, timeoutMs: receiptTimeout });
      if (receipt.blockNumber) step.block = Number(qtyBig(receipt.blockNumber));
      if (t.purpose === "arkiv" && ENTITY_CREATED) {
        const l = receipt.logs.find((x) => x.topics[0]?.toLowerCase() === ENTITY_CREATED);
        if (l?.topics[1]) step.entityKey = l.topics[1];
      }
      if (isStorage) {
        const flow = ethers.Transaction.from(t.raw).to;
        const ev = submitEventOf(receipt.logs, flow);
        if (!ev) throw new Error("no Flow Submit event in the receipt");
        step.txSeq = ev.txSeq;
        step.status = "ok"; // the tx is in; the upload may still need a retry
        emit("submitting");
        const f = bundle.files[t.file!]!;
        await uploadSegments(deps.rpc, await storageNodes(), fileBytes(f), f.root, ev.txSeq, ev.startPos, { sleep, pollMs, timeoutMs: storageTimeout });
        step.finalized = true;
      }
      step.status = "ok";
      delete step.error;
      emit("submitting");
    } catch (e) {
      const stale = e instanceof StaleError;
      step.status = stale ? "stale" : "failed";
      step.error = errMsg(e);
      emit(stale ? "stale" : "failed");
      return { state: stale ? "stale" : "failed", steps };
    }
  }
  emit("done");
  return { state: "done", steps };
}

async function sendAndWait(
  rpc: JsonRpc, u: string, device: string, raw: string, hash: string, nonce: number,
  o: { sleep: (ms: number) => Promise<void>; pollMs: number; timeoutMs: number },
): Promise<Receipt> {
  const usedByOther = async (): Promise<boolean> => {
    if (await rpc(u, "eth_getTransactionByHash", [hash])) return false;
    const latest = Number(qtyBig(await rpc(u, "eth_getTransactionCount", [device, "latest"])));
    return latest > nonce;
  };
  try {
    await rpc(u, "eth_sendRawTransaction", [raw]);
  } catch (e) {
    const m = errMsg(e);
    if (ALREADY_KNOWN.test(m)) {
      // same tx already in the pool or mined: fine
    } else if (NONCE_USED.test(m)) {
      if (await usedByOther()) throw new StaleError(`nonce ${nonce} already used by another tx (${m}); the robot must re-sign`);
    } else {
      throw e;
    }
  }
  const until = Date.now() + o.timeoutMs;
  for (;;) {
    const r = (await rpc(u, "eth_getTransactionReceipt", [hash])) as Receipt | null;
    if (r) {
      if (qtyBig(r.status) !== 1n) throw new Error(`tx ${hash} reverted`);
      return { ...r, logs: r.logs ?? [] };
    }
    if (await usedByOther()) throw new StaleError(`nonce ${nonce} was used by another tx; the robot must re-sign`);
    if (Date.now() >= until) throw new Error(`no receipt for ${hash} within ${Math.round(o.timeoutMs / 1000)} s`);
    await o.sleep(o.pollMs);
  }
}

const SEGMENT_CHUNKS = 1024n;

async function uploadSegments(
  rpc: JsonRpc, nodes: StorageNodeInfo[], bytes: Uint8Array, root: string, txSeq: number, startPos: bigint,
  o: { sleep: (ms: number) => Promise<void>; pollMs: number; timeoutMs: number },
): Promise<void> {
  if (!nodes.length) throw new Error("no 0G Storage node available");
  const until = Date.now() + o.timeoutMs;
  type Info = { finalized?: boolean } | null;
  const info = async (n: StorageNodeInfo): Promise<Info> => {
    try {
      return (await rpc(n.url, "zgs_getFileInfo", [root, true])) as Info;
    } catch {
      return null;
    }
  };
  // wait until a node has seen the submission (it follows the chain a few seconds behind)
  for (;;) {
    const known = await Promise.all(nodes.map(info));
    if (known.some((k) => k?.finalized)) return; // already stored (same bytes, same root)
    if (known.some((k) => k)) break;
    if (Date.now() >= until) throw new Error(`storage nodes did not see tx seq ${txSeq} within ${Math.round(o.timeoutMs / 1000)} s`);
    await o.sleep(o.pollMs);
  }
  const first = Number(startPos / SEGMENT_CHUNKS);
  const used = new Set<StorageNodeInfo>();
  for (const seg of await segmentsOf(bytes)) {
    const g = first + seg.index;
    const targets = nodes.filter((n) => n.numShard > 0 && g % n.numShard === n.shardId);
    if (!targets.length) throw new Error(`no storage node holds shard of segment ${g}`);
    let lastErr = "";
    let sent = false;
    for (const n of targets) {
      try {
        await rpc(n.url, "zgs_uploadSegmentsByTxSeq", [[seg], txSeq]);
        sent = true;
      } catch (e) {
        lastErr = errMsg(e);
        sent = SEGMENT_DONE.test(lastErr);
      }
      if (sent) {
        used.add(n);
        break;
      }
    }
    if (!sent) throw new Error(`segment ${seg.index} upload failed: ${lastErr}`);
  }
  for (;;) {
    const states = await Promise.all([...used].map(info));
    if (states.length && states.every((s) => s?.finalized)) return;
    if (Date.now() >= until) throw new Error(`uploaded, but not finalized within ${Math.round(o.timeoutMs / 1000)} s`);
    await o.sleep(o.pollMs);
  }
}
