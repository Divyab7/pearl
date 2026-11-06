/**
 * TESTS ONLY: an in-memory 0G Galileo + Arkiv Rabdi + 0G Storage network behind the JsonRpc interface, so the bundle
 * builder, the relayer and the end-to-end relay test run with no network at all. It mines each valid tx at once,
 * enforces per-sender nonces like a real node ("already known", "nonce too low"), emits the Flow Submit event and the
 * Arkiv EntityCreated event, and accepts segments only when they carry the right root for that tx seq.
 */
import { ENTITY_EVENTS_ABI } from "@arkiv-network/sdk/entity";
import { ethers } from "ethers";
import { toEventSelector, type AbiEvent } from "viem";
import { CHAIN_IDS, type ChainName } from "./chains.js";
import { hexQty, RpcError, type JsonRpc } from "./rpc.js";
import { decodeSubmit, encodeSubmitLog, fileRoot, type StorageNodeInfo } from "./storageFlow.js";

export const FAKE_URLS: Record<ChainName, string> = { "0g-galileo": "fake://galileo", "arkiv-rabdi": "fake://arkiv" };
export const FAKE_NODE = "fake://zgs-node";
export const FAKE_INDEXER = "fake://indexer";
export const FAKE_FLOW = "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296";
export const FAKE_MARKET = "0x26c8d3d3e2E5e6E1C43E2c1E1c6A8e7Ff1B0c1c1";
export const FAKE_PRICE = 30_733_644_962n;

interface Chain {
  nonces: Map<string, number>;
  txs: Map<string, { tx: ethers.Transaction; receipt: Record<string, unknown> }>;
  block: number;
}

const ENTITY_CREATED = toEventSelector(
  (ENTITY_EVENTS_ABI as readonly { type: string; name?: string }[]).find((e) => e.name === "EntityCreated") as AbiEvent,
);

export class FakeNet {
  chains: Record<ChainName, Chain> = {
    "0g-galileo": { nonces: new Map(), txs: new Map(), block: 100 },
    "arkiv-rabdi": { nonces: new Map(), txs: new Map(), block: 5000 },
  };
  /** storage: root → {txSeq, finalized}; tx seq → root (null until its segments arrive) */
  files = new Map<string, { txSeq: number; finalized: boolean }>();
  bySeq = new Map<number, string | null>();
  nextSeq = 1000;
  nextPos = 0n;
  calls: { url: string; method: string }[] = [];
  /** set to make the next sendRawTransaction on a chain fail with this message */
  failNext: Partial<Record<ChainName, string>> = {};
  /** revert txs to this address */
  revertTo = new Set<string>();
  gasPrice = 4_000_000_000n;

  chainOf(url: string): ChainName | null {
    return (Object.keys(FAKE_URLS) as ChainName[]).find((k) => FAKE_URLS[k] === url) ?? null;
  }

  nonceOf(chain: ChainName, addr: string): number {
    return this.chains[chain].nonces.get(addr.toLowerCase()) ?? 0;
  }

  /** Someone else (same key, another program) used a nonce: a different tx is mined at it. */
  burnNonce(chain: ChainName, addr: string): void {
    this.chains[chain].nonces.set(addr.toLowerCase(), this.nonceOf(chain, addr) + 1);
  }

  rpc: JsonRpc = async (url, method, params = []) => {
    this.calls.push({ url, method });
    const chain = this.chainOf(url);
    if (chain) return this.chainCall(chain, method, params);
    if (url === FAKE_NODE) return this.nodeCall(method, params);
    if (url === FAKE_INDEXER && method === "indexer_getShardedNodes") return { trusted: [{ url: FAKE_NODE, config: { shardId: 0, numShard: 1 } }], discovered: [] };
    throw new RpcError(method, `fake: no endpoint ${url}`);
  };

  rpcUrl = (c: ChainName) => FAKE_URLS[c];
  storageNodes = async (): Promise<StorageNodeInfo[]> => [{ url: FAKE_NODE, shardId: 0, numShard: 1 }];

  private chainCall(name: ChainName, method: string, params: unknown[]): unknown {
    const c = this.chains[name];
    switch (method) {
      case "eth_chainId":
        return hexQty(CHAIN_IDS[name]);
      case "eth_gasPrice":
        return hexQty(this.gasPrice);
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_getTransactionCount":
        return hexQty(this.nonceOf(name, String(params[0])));
      case "eth_call": {
        const call = params[0] as { to: string; data: string };
        if (call.to.toLowerCase() === FAKE_FLOW.toLowerCase()) return ethers.zeroPadValue(FAKE_MARKET, 32);
        if (call.to.toLowerCase() === FAKE_MARKET.toLowerCase()) return ethers.toBeHex(FAKE_PRICE, 32);
        throw new RpcError(method, "execution reverted");
      }
      case "eth_getTransactionByHash": {
        const t = c.txs.get(String(params[0]).toLowerCase());
        return t ? { hash: t.tx.hash, nonce: hexQty(t.tx.nonce), blockNumber: t.receipt.blockNumber } : null;
      }
      case "eth_getTransactionReceipt":
        return c.txs.get(String(params[0]).toLowerCase())?.receipt ?? null;
      case "eth_sendRawTransaction": {
        const fail = this.failNext[name];
        if (fail) {
          delete this.failNext[name];
          throw new RpcError(method, fail);
        }
        const tx = ethers.Transaction.from(String(params[0]));
        if (tx.chainId !== BigInt(CHAIN_IDS[name])) throw new RpcError(method, "invalid chain id");
        const hash = tx.hash!.toLowerCase();
        if (c.txs.has(hash)) throw new RpcError(method, "already known");
        const from = tx.from!.toLowerCase();
        const n = this.nonceOf(name, from);
        if (tx.nonce < n) throw new RpcError(method, "nonce too low");
        if (tx.nonce > n) throw new RpcError(method, `nonce too high: next is ${n}`);
        c.nonces.set(from, n + 1);
        c.block++;
        const logs: unknown[] = [];
        let status = "0x1";
        if (tx.to && this.revertTo.has(tx.to.toLowerCase())) status = "0x0";
        else if (name === "0g-galileo" && tx.to?.toLowerCase() === FAKE_FLOW.toLowerCase()) {
          const sub = decodeSubmit(tx.data)!;
          const seq = this.nextSeq++;
          logs.push({ ...encodeSubmitLog(FAKE_FLOW, sub.submitter, ethers.ZeroHash, seq, this.nextPos, sub.length), blockNumber: hexQty(c.block), transactionHash: tx.hash, logIndex: "0x0" });
          this.nextPos += 1024n * BigInt(Math.ceil(Number(sub.length) / (256 * 1024)) || 1);
          this.bySeq.set(seq, null); // the node learns the root when the segments arrive
        } else if (name === "arkiv-rabdi") {
          logs.push({ address: "0x4400000000000000000000000000000000000044", topics: [ENTITY_CREATED, ethers.keccak256(tx.hash!), ethers.zeroPadValue(from, 32)], data: "0x" });
        }
        c.txs.set(hash, { tx, receipt: { transactionHash: tx.hash, status, blockNumber: hexQty(c.block), logs } });
        return tx.hash;
      }
      default:
        throw new RpcError(method, `fake chain: unsupported ${method}`);
    }
  }

  private async nodeCall(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "zgs_getShardConfig":
        return { shardId: 0, numShard: 1 };
      case "zgs_getStatus":
        return { networkIdentity: { flowAddress: FAKE_FLOW } };
      case "zgs_getFileInfo": {
        const root = String(params[0]).toLowerCase();
        const f = this.files.get(root);
        if (f) return { tx: { seq: f.txSeq }, finalized: f.finalized };
        // a submitted entry whose data has not arrived yet (the relayer handles one file at a time)
        const pending = [...this.bySeq.entries()].find(([, r]) => r === null)?.[0];
        return pending === undefined ? null : { tx: { seq: pending }, finalized: false };
      }
      case "zgs_uploadSegmentsByTxSeq": {
        const [segs, seq] = params as [{ root: string; index: number; data: string; fileSize: number }[], number];
        if (!this.bySeq.has(seq)) throw new RpcError(method, "tx seq unknown");
        const known = this.bySeq.get(seq);
        for (const s of segs) {
          if (known && s.root.toLowerCase() !== known) throw new RpcError(method, "root mismatch");
          // single-segment files: the data must really hash to the root
          if (s.index === 0 && s.fileSize <= 256 * 1024) {
            const bytes = new Uint8Array(Buffer.from(s.data, "base64")).slice(0, s.fileSize);
            if ((await fileRoot(bytes)).toLowerCase() !== s.root.toLowerCase()) throw new RpcError(method, "segment data does not match root");
          }
        }
        const root = segs[0]!.root.toLowerCase();
        if (this.files.get(root)?.finalized) throw new RpcError(method, "segment has already been uploaded or is being uploaded");
        this.bySeq.set(seq, root);
        this.files.set(root, { txSeq: seq, finalized: true });
        return null;
      }
      default:
        throw new RpcError(method, `fake node: unsupported ${method}`);
    }
  }
}
