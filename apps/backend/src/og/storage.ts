/**
 * 0G Storage on Galileo testnet via @0gfoundation/0g-storage-ts-sdk@1.2.13 (peer ethers 6.13.1, pinned).
 * Signatures checked in the installed lib.esm/indexer/Indexer.d.ts and file/MemData.d.ts:
 *   new Indexer(url)                      · new MemData(data: ArrayLike<number>)
 *   mem.merkleTree(): Promise<[MerkleTree|null, Error|null]>   (must run before upload)
 *   indexer.upload(file, rpc, signer, uploadOpts?, retryOpts?, txOpts?)
 *     → Promise<[{txHash, rootHash, txSeq} | {txHashes[], rootHashes[], txSeqs[]}, Error|null]>
 *   indexer.downloadToBlob(rootHash, { proof?: boolean }) → Promise<[Blob, Error|null]>
 * Docs: https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk (turbo indexer recommended; the standard indexer
 * was down on 4 Nov). upload() waits for finality in an unbounded poll loop, so we wrap it in our own deadline and run
 * it after the episode closes, never on the control path.
 */
import { Indexer, MemData, StorageNode } from "@0gfoundation/0g-storage-ts-sdk";
import { loadEnv } from "../shared/env.js";
import { chainWallet, galileoRpc } from "./config.js";
import { isPrivateKey } from "../shared/util.js";

export interface StorageConfig {
  rpcUrl: string;
  indexerUrl: string;
  privateKey: string;
  deadlineMs: number;
}

export interface UploadReceipt {
  rootHash: string;
  txHash: string;
  txSeq: number;
  ms: number;
}

/** rev 5: pass the device's key so the device pays for and signs its own upload; reads need no key. */
export function storageConfigFromEnv(signerKey?: string): StorageConfig {
  loadEnv();
  return {
    rpcUrl: galileoRpc(),
    indexerUrl: process.env.OG_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai",
    privateKey: signerKey ?? process.env.OG_STORAGE_PRIVATE_KEY ?? "",
    deadlineMs: Number(process.env.OG_STORAGE_DEADLINE_MS ?? 120_000),
  };
}

export function storageConfigured(c: StorageConfig): boolean {
  return isPrivateKey(c.privateKey);
}

/** Public, unauthenticated retrieval link documented on the SDK page (`GET /file?root=0x…`). */
export function publicFileUrl(c: StorageConfig, rootHash: string): string {
  return `${c.indexerUrl.replace(/\/$/, "")}/file?root=${rootHash}`;
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what}: no result within ${ms} ms`)), ms);
    }),
  ]);
}

/** Root hash computed locally, without any network call. Same bytes → same root. */
export async function localRoot(bytes: Uint8Array): Promise<string> {
  const [tree, err] = await new MemData(bytes).merkleTree();
  if (err || !tree) throw new Error(`merkleTree: ${err?.message ?? "no tree"}`);
  const root = tree.rootHash();
  if (!root) throw new Error("merkleTree: empty root");
  return root;
}

export async function uploadBytes(c: StorageConfig, bytes: Uint8Array): Promise<UploadReceipt> {
  if (!storageConfigured(c)) throw new Error("no signer key for 0G Storage (device key or OG_STORAGE_PRIVATE_KEY)");
  const started = Date.now();
  const mem = new MemData(bytes);
  const [, treeErr] = await mem.merkleTree();
  if (treeErr) throw new Error(`merkleTree: ${treeErr.message}`);
  const signer = chainWallet(c.privateKey, c.rpcUrl);
  const indexer = new Indexer(c.indexerUrl);
  // The SDK's .d.ts references ethers' CommonJS types while we import the ESM build of the same ethers 6.13.1; the
  // objects are identical at runtime, only TypeScript sees two declarations of the same class.
  const sdkSigner = signer as unknown as Parameters<Indexer["upload"]>[2];
  const [res, err] = await withDeadline(indexer.upload(mem, c.rpcUrl, sdkSigner), c.deadlineMs, "0G Storage upload");
  if (err) throw new Error(`0G Storage upload: ${err.message}`);
  if ("rootHash" in res) return { rootHash: res.rootHash, txHash: res.txHash, txSeq: res.txSeq, ms: Date.now() - started };
  // fragmented result only happens above 4 GB; an episode log is a few KB
  throw new Error(`unexpected fragmented upload (${res.rootHashes.length} fragments)`);
}

/** Upload with one retry (prompt §8.6). */
export async function uploadWithRetry(c: StorageConfig, bytes: Uint8Array): Promise<UploadReceipt> {
  try {
    return await uploadBytes(c, bytes);
  } catch (first) {
    try {
      return await uploadBytes(c, bytes);
    } catch (second) {
      throw new Error(`${(second as Error).message} (first attempt: ${(first as Error).message})`);
    }
  }
}

export async function downloadBytes(c: StorageConfig, rootHash: string): Promise<Uint8Array> {
  const indexer = new Indexer(c.indexerUrl);
  const [blob, err] = await withDeadline(indexer.downloadToBlob(rootHash, { proof: true }), c.deadlineMs, "0G Storage download");
  if (!err) return new Uint8Array(await blob.arrayBuffer());
  // The indexer's location lookup can lag minutes behind the nodes (seen live for files whose segments were pushed
  // straight to the nodes by a relay). Ask the indexer's trusted nodes directly which ones hold the file finalized,
  // and download from those, still with Merkle proofs.
  try {
    return await downloadFromNodes(indexer, rootHash, c.deadlineMs);
  } catch (e) {
    throw new Error(`0G Storage download: ${err.message}; direct from nodes: ${(e as Error).message}`);
  }
}

async function downloadFromNodes(indexer: Indexer, rootHash: string, deadlineMs: number): Promise<Uint8Array> {
  const sharded = await indexer.getShardedNodes();
  const urls = [...(sharded.trusted ?? []), ...(sharded.discovered ?? [])].map((n) => n.url);
  type Info = { finalized?: boolean; tx: { seq: number; size: number } };
  const holders: { node: StorageNode; info: Info }[] = [];
  await Promise.all(urls.map(async (u) => {
    const node = new StorageNode(u);
    const info = (await withDeadline(node.getFileInfo(rootHash, true), 8000, "file info").catch(() => null)) as Info | null;
    if (info?.finalized) holders.push({ node, info });
  }));
  if (!holders.length) throw new Error("no storage node holds this file finalized yet");
  const { seq, size } = holders[0]!.info.tx;
  const CHUNK = 256, SEG = 1024;
  const numChunks = Math.ceil(size / CHUNK);
  const parts: Uint8Array[] = [];
  const until = Date.now() + deadlineMs;
  for (let start = 0; start < numChunks; start += SEG) {
    const end = Math.min(start + SEG, numChunks);
    let got: Uint8Array | null = null;
    for (const h of holders) {
      if (Date.now() > until) throw new Error("timed out");
      const b64 = await h.node.downloadSegmentByTxSeq(seq, start, end).catch(() => null);
      if (b64) {
        got = Uint8Array.from(Buffer.from(b64, "base64"));
        break;
      }
    }
    if (!got) throw new Error(`no node returned chunks ${start}–${end}`);
    parts.push(got);
  }
  const all = Buffer.concat(parts).subarray(0, size);
  const bytes = new Uint8Array(all);
  // no per-segment proofs on this path: the whole file must hash to the requested root instead
  const root = await localRoot(bytes);
  if (root.toLowerCase() !== rootHash.toLowerCase()) throw new Error(`downloaded bytes have root ${root}, not ${rootHash}`);
  return bytes;
}
