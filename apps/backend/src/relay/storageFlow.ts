/**
 * 0G Storage pieces the bundle needs, built from @0gfoundation/0g-storage-ts-sdk@1.2.13 (no network unless asked):
 *  - the Flow `submit(Submission)` calldata and fee for a file (MemData.createSubmission + FixedPriceFlow interface +
 *    calculatePrice, exactly what Uploader.submitLogEntryNoReceipt sends; selector 0xbc8c11f8 on Galileo);
 *  - the file's segments with proofs (Uploader.getSegment, which does not touch `this`), sent with
 *    zgs_uploadSegmentsByTxSeq — no key needed;
 *  - the Submit event → txSeq (submissionIndex) and startPos;
 *  - storage node discovery (OG_STORAGE_NODES or the indexer's indexer_getShardedNodes) and the Flow/market reads.
 * The firmware mirrors the same steps in firmware/esp32-arm/src/pearl/publish.cpp.
 */
import { calculatePrice, FixedPriceFlow__factory, MemData, Uploader } from "@0gfoundation/0g-storage-ts-sdk";
import { ethers } from "ethers";
import type { JsonRpc } from "./rpc.js";
import { qtyBig } from "./rpc.js";
import { storageIndexerUrl } from "./chains.js";
import { loadEnv } from "../shared/env.js";

const flowIface = FixedPriceFlow__factory.createInterface();
const marketIface = new ethers.Interface(["function pricePerSector() view returns (uint256)"]);

async function treeOf(bytes: Uint8Array) {
  const mem = new MemData(bytes);
  const [tree, err] = await mem.merkleTree();
  if (err || !tree) throw new Error(`merkleTree: ${err?.message ?? "no tree"}`);
  return { mem, tree };
}

/** The 0G Storage root of these exact bytes (same as og/storage.ts localRoot). */
export async function fileRoot(bytes: Uint8Array): Promise<string> {
  const { tree } = await treeOf(bytes);
  const r = tree.rootHash();
  if (!r) throw new Error("merkleTree: empty root");
  return r;
}

/** Flow.submit calldata for this file (submitter = the device) and the number of sectors it pays for. */
export async function submitCall(bytes: Uint8Array, submitter: string): Promise<{ data: string; sectors: bigint; root: string; feeFor: (pricePerSector: bigint) => bigint }> {
  const { mem, tree } = await treeOf(bytes);
  const [sub, err] = await mem.createSubmission("0x", submitter);
  if (err || !sub) throw new Error(`createSubmission: ${err?.message ?? "failed"}`);
  const data = flowIface.encodeFunctionData("submit", [sub]);
  const sectors = sub.data.nodes.reduce((a, n) => a + (1n << BigInt(n.height)), 0n);
  return { data, sectors, root: tree.rootHash()!, feeFor: (p) => calculatePrice(sub, p) };
}

/** The root a Flow.submit calldata commits to is not directly readable; check its length field and submitter instead. */
export function decodeSubmit(data: string): { length: bigint; submitter: string } | null {
  try {
    const d = flowIface.decodeFunctionData("submit", data);
    // ethers Result: `.length` is the tuple's arity, so read the struct fields by position
    const s = d[0] as unknown as [[bigint, string, unknown], string];
    return { length: BigInt(s[0][0]), submitter: ethers.getAddress(s[1]) };
  } catch {
    return null;
  }
}

export interface SegmentWithProof {
  root: string;
  data: string;
  index: number;
  proof: unknown;
  fileSize: number;
}

/** Every segment of the file with its proof, as the SDK uploads them. */
export async function segmentsOf(bytes: Uint8Array): Promise<SegmentWithProof[]> {
  const { mem, tree } = await treeOf(bytes);
  const out: SegmentWithProof[] = [];
  for (let i = 0; i < mem.numSegmentsPadded(); i++) {
    const [done, seg, err] = await Uploader.prototype.getSegment.call({} as Uploader, mem, tree, i);
    if (err) throw err;
    if (seg) out.push(JSON.parse(JSON.stringify(seg)) as SegmentWithProof);
    if (done) break;
  }
  return out;
}

/** The Flow Submit event in a receipt (from the given Flow address, or any address when null). */
export function submitEventOf(
  logs: { address: string; topics: string[]; data: string }[],
  flow: string | null = null,
): { txSeq: number; startPos: bigint; sender: string } | null {
  for (const l of logs) {
    if (flow && l.address.toLowerCase() !== flow.toLowerCase()) continue;
    try {
      const p = flowIface.parseLog({ topics: l.topics, data: l.data });
      if (p?.name === "Submit") return { txSeq: Number(p.args.submissionIndex), startPos: BigInt(p.args.startPos), sender: String(p.args.sender) };
    } catch {
      // not a Flow event
    }
  }
  return null;
}

export const submitTopic = (): string => flowIface.getEvent("Submit")!.topicHash;

/** Encodes a Submit log (tests and fakes only). */
export function encodeSubmitLog(flow: string, sender: string, root: string, txSeq: number, startPos: bigint, length: bigint) {
  const ev = flowIface.getEvent("Submit")!;
  const enc = flowIface.encodeEventLog(ev, [sender, root, txSeq, startPos, length, { length, tags: "0x", nodes: [{ root, height: 0 }] }]);
  return { address: flow, topics: enc.topics, data: enc.data };
}

export interface StorageNodeInfo {
  url: string;
  shardId: number;
  numShard: number;
}

/** Storage nodes to upload segments to: OG_STORAGE_NODES (comma list) or the indexer's trusted set. */
export async function discoverStorageNodes(rpc: JsonRpc, indexerUrl = storageIndexerUrl()): Promise<StorageNodeInfo[]> {
  loadEnv();
  const list = (process.env.OG_STORAGE_NODES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) {
    const out: StorageNodeInfo[] = [];
    for (const url of list) {
      try {
        const c = (await rpc(url, "zgs_getShardConfig")) as { shardId?: number; numShard?: number } | null;
        out.push({ url, shardId: Number(c?.shardId ?? 0), numShard: Number(c?.numShard ?? 1) });
      } catch {
        // node down: skip it
      }
    }
    return out;
  }
  const r = (await rpc(indexerUrl, "indexer_getShardedNodes")) as { trusted?: { url: string; config?: { shardId: number; numShard: number } }[] } | null;
  return (r?.trusted ?? []).map((n) => ({ url: n.url, shardId: Number(n.config?.shardId ?? 0), numShard: Number(n.config?.numShard ?? 1) }));
}

/** The Flow contract (OG_FLOW_ADDRESS, else what a storage node reports) and the market's price per sector. */
export async function readStoragePrice(rpc: JsonRpc, chainRpc: string, nodes: StorageNodeInfo[]): Promise<{ flow: string; pricePerSector: bigint }> {
  loadEnv();
  let flow = process.env.OG_FLOW_ADDRESS ?? "";
  for (const n of nodes) {
    if (ethers.isAddress(flow)) break;
    try {
      const s = (await rpc(n.url, "zgs_getStatus")) as { networkIdentity?: { flowAddress?: string } } | null;
      flow = s?.networkIdentity?.flowAddress ?? "";
    } catch {
      // try the next node
    }
  }
  if (!ethers.isAddress(flow)) throw new Error("0G Storage Flow address unknown (set OG_FLOW_ADDRESS or OG_STORAGE_NODES)");
  const marketWord = String(await rpc(chainRpc, "eth_call", [{ to: flow, data: flowIface.encodeFunctionData("market") }, "latest"]));
  const market = ethers.getAddress(`0x${marketWord.slice(-40)}`);
  const price = qtyBig(await rpc(chainRpc, "eth_call", [{ to: market, data: marketIface.encodeFunctionData("pricePerSector") }, "latest"]));
  return { flow: ethers.getAddress(flow), pricePerSector: price };
}
