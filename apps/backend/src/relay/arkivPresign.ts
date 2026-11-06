/**
 * Pre-signs the robot's Arkiv create-entity transaction WITHOUT a network, using @arkiv-network/sdk@1.0.1 itself so the
 * calldata is exactly what index/arkiv.ts indexEpisode sends: the wallet client gets a local viem transport that
 * answers the few reads viem makes, and captures eth_sendRawTransaction instead of sending it. Nonce, gas and fees are
 * passed explicitly (SDK TxParams), so nothing depends on the fake answers except the expiry, which is relative
 * (ExpirationTime.fromDays → minLifetime in blocks, counted from the block the tx lands in).
 */
import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { u64 } from "@arkiv-network/sdk/schema";
import { custom, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EpisodeIndex, type IndexInput } from "../index/arkiv.js";

class Captured extends Error {
  constructor(readonly raw: Hex) {
    super("captured");
  }
}

const opt = <T>(v: T | null | undefined) => (v === null || v === undefined || v === "" ? undefined : v);

export async function presignArkivCreate(
  privateKey: string,
  e: IndexInput,
  tx: { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; lifetimeDays: number },
): Promise<{ raw: Hex; hash: Hex }> {
  const chain = rabdi({ accessKey: "offline" });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_chainId":
          return `0x${chain.id.toString(16)}`;
        case "eth_blockNumber":
          return "0x1"; // only used to resolve absolute expiries; ours is relative
        case "eth_getBlockByNumber":
          return { number: "0x1", baseFeePerGas: "0x0", timestamp: "0x0", hash: `0x${"00".repeat(32)}`, transactions: [] };
        case "eth_getTransactionCount":
          return `0x${tx.nonce.toString(16)}`;
        case "eth_sendRawTransaction":
          throw new Captured((params as Hex[])[0]!);
        default:
          throw new Error(`offline pre-sign: unexpected ${method}`);
      }
    },
  });
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(privateKey as Hex) });
  try {
    await wallet.createEntity(
      EpisodeIndex,
      {
        kind: e.kind, armId: e.armId, episodeId: e.episodeId, outcome: e.outcome, ts: u64(BigInt(e.endedAtMs)), severity: e.severity,
        headHash: e.headHash, rootHash: opt(e.rootHash), storageTx: opt(e.storageTx), anchorTx: opt(e.anchorTx),
      },
      { expiration: ExpirationTime.fromDays(tx.lifetimeDays), flags: { readonly: true } },
      { nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
    );
  } catch (err) {
    let c: unknown = err;
    for (let i = 0; i < 8 && c; i++) {
      if (c instanceof Captured) return { raw: c.raw, hash: keccak256(c.raw) };
      c = (c as { cause?: unknown }).cause;
    }
    throw err;
  }
  throw new Error("offline pre-sign: the SDK did not produce a transaction");
}
