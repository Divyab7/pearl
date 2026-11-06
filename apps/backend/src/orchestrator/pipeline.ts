/**
 * After an episode closes, the device (rev 5: with its own key) uploads the LOCKED log and LOCKED frames to 0G Storage
 * (owner decision 5 Nov 2026: nothing readable leaves the robot; shared/seal.ts),
 * anchors it on 0G Chain (OG_CHAIN_ANCHOR), indexes it on Arkiv (INDEX_ARKIV) and, for an episode started by a
 * zerobot command, submits that command's receipt (ROBOT_ZEROBOT).
 * Each module's real result, or the honest reason it did not run, goes into <id>.meta.json.
 */
import { sealedBytes, type SealedEpisode } from "../shared/seal.js";
import { envFlag } from "../shared/env.js";
import type { EpisodeLog } from "../shared/types.js";
import { publicFileUrl, storageConfigFromEnv, storageConfigured, uploadWithRetry } from "../og/storage.js";
import { readFileSync } from "node:fs";
import { framePath, requestIdsOf } from "./log.js";
import { chainWallet } from "../og/config.js";
import { anchorConfigFromEnv, anchorConfigured, anchorEpisode, incidentOf } from "../og/anchor.js";
import { arkivConfigFromEnv, arkivRpcUrl, arkivWriterConfigured, indexEpisode } from "../index/arkiv.js";
import { updateMeta, type EpisodeMeta } from "./meta.js";
import {
  encodeResult,
  ethersZerobot,
  txLink,
  ZEROBOT_MISSING,
  zerobotConfigFromEnv,
  zerobotConfigured,
  type ZerobotChain,
} from "../zerobot/zerobot.js";
import { errMsg } from "../shared/util.js";

/** The zerobot command an episode answers, from its episode_start record (null for locally started episodes). */
export function zerobotOriginOf(log: EpisodeLog): { robotId: string; nonce: number } | null {
  const start = log.records.find((r) => r.kind === "event" && r.ev === "episode_start");
  const o = start && start.kind === "event" ? (start.data as { origin?: { kind?: string; robotId?: string; nonce?: number } }).origin : undefined;
  return o?.kind === "zerobot" && typeof o.robotId === "string" && typeof o.nonce === "number" ? { robotId: o.robotId, nonce: o.nonce } : null;
}

/** The device pays for its own uploads: say clearly when its wallet is empty instead of failing inside the SDK. */
async function unfundedReason(rpcUrl: string, privateKey: string, coin = "test 0G", faucet = "faucet.0g.ai"): Promise<string | null> {
  try {
    const w = chainWallet(privateKey, rpcUrl);
    const addr = w.address;
    const bal = await w.provider!.getBalance(addr);
    return bal === 0n ? `device wallet ${addr} has no ${coin} (fund it at ${faucet})` : null;
  } catch (e) {
    return `cannot read the device balance: ${errMsg(e)}`;
  }
}

export async function publishEpisode(
  log: EpisodeLog,
  /** The locked copy made at close (orchestrator); its exact canonical bytes are what 0G Storage holds. */
  sealed: SealedEpisode,
  notify: (m: EpisodeMeta) => void = () => {},
  /** The app passes its zerobot connection; without one, the env config is used. */
  zerobotChain?: () => ZerobotChain,
  /** rev 5: the device's own key signs and pays for every write: 0G Storage, the 0G Chain anchor, Arkiv. */
  opts: { devicePrivateKey?: string; skipStorage?: boolean } = {},
): Promise<EpisodeMeta> {
  // 1. 0G Storage
  const sc = storageConfigFromEnv(opts.devicePrivateKey);
  let meta: EpisodeMeta;
  const unfunded = !opts.skipStorage && storageConfigured(sc) ? await unfundedReason(sc.rpcUrl, sc.privateKey) : null;
  if (opts.skipStorage) {
    meta = updateMeta(log.episodeId, { storage: { status: "off" } });
  } else if (!storageConfigured(sc)) {
    meta = updateMeta(log.episodeId, { storage: { status: "not_configured", missing: "device key" } });
  } else if (unfunded) {
    meta = updateMeta(log.episodeId, { storage: { status: "not_configured", missing: unfunded } });
  } else {
    try {
      const r = await uploadWithRetry(sc, sealedBytes(sealed));
      meta = updateMeta(log.episodeId, { storage: { status: "ok", ...r, url: publicFileUrl(sc, r.rootHash) } });
    } catch (e) {
      meta = updateMeta(log.episodeId, { storage: { status: "failed", error: errMsg(e) } });
    }
  }
  notify(meta);
  const rootHash = meta.storage?.status === "ok" ? meta.storage.rootHash : null;

  // 1b. locked camera frames, each as its own 0G Storage file (its root is already in the decision record)
  const framed = log.records.flatMap((r) => (r.kind === "decision" && r.frameRoot ? [{ idx: r.idx, root: r.frameRoot }] : []));
  if (framed.length) {
    const frames: NonNullable<EpisodeMeta["frames"]> = [];
    for (const f of framed) {
      if (!storageConfigured(sc)) {
        frames.push({ idx: f.idx, rootHash: f.root, status: "not_configured" });
        continue;
      }
      try {
        const bytes = readFileSync(framePath(log.episodeId, f.idx));
        const r = await uploadWithRetry(sc, bytes);
        frames.push(r.rootHash === f.root
          ? { idx: f.idx, rootHash: r.rootHash, status: "ok", txHash: r.txHash }
          : { idx: f.idx, rootHash: f.root, status: "failed", error: `uploaded root ${r.rootHash} ≠ recorded ${f.root}` });
      } catch (e) {
        frames.push({ idx: f.idx, rootHash: f.root, status: "failed", error: errMsg(e) });
      }
    }
    meta = updateMeta(log.episodeId, { frames });
    notify(meta);
  }

  // 2. 0G Chain anchor
  if (!envFlag("OG_CHAIN_ANCHOR", "on")) {
    meta = updateMeta(log.episodeId, { anchor: { status: "off" } });
  } else {
    const ac = anchorConfigFromEnv(opts.devicePrivateKey ?? "");
    if (!anchorConfigured(ac)) {
      meta = updateMeta(log.episodeId, {
        anchor: { status: "not_configured", missing: "OG_ANCHOR_ADDRESS (pnpm anchor:deploy) and the device key" },
      });
    } else {
      try {
        const r = await anchorEpisode(ac, {
          episodeId: log.episodeId, headHash: log.headHash, rootHash, requestIds: requestIdsOf(log),
          outcome: log.outcome, ...incidentOf(log),
        });
        meta = updateMeta(log.episodeId, { anchor: { status: "ok", ...r } });
      } catch (e) {
        meta = updateMeta(log.episodeId, { anchor: { status: "failed", error: errMsg(e) } });
      }
    }
  }
  notify(meta);

  // 3. Arkiv index
  if (!envFlag("INDEX_ARKIV", "on")) {
    meta = updateMeta(log.episodeId, { arkiv: { status: "off" } });
  } else {
    const kc = arkivConfigFromEnv(opts.devicePrivateKey);
    const arkivRpc = arkivRpcUrl(kc.accessKey);
    const noGas = arkivWriterConfigured(kc) ? await unfundedReason(arkivRpc, kc.privateKey, "tGLM", "hub.arkiv.network/faucet") : null;
    if (!arkivWriterConfigured(kc)) {
      meta = updateMeta(log.episodeId, { arkiv: { status: "not_configured", missing: "device key and ARKIV_ACCESS_KEY" } });
    } else if (noGas) {
      meta = updateMeta(log.episodeId, { arkiv: { status: "not_configured", missing: noGas } });
    } else {
      try {
        // public search labels only (owner decision 6 Nov 2026); everything else stays in the locked file
        const r = await indexEpisode(kc, {
          kind: sealed.incident ? "incident" : "episode",
          armId: sealed.armId,
          episodeId: sealed.episodeId,
          outcome: sealed.outcome,
          endedAtMs: Date.parse(sealed.endedAt),
          severity: sealed.severity,
          headHash: sealed.headHash,
          rootHash,
          storageTx: meta.storage?.status === "ok" ? meta.storage.txHash : null,
          anchorTx: meta.anchor?.status === "ok" ? meta.anchor.txHash : null,
        });
        meta = updateMeta(log.episodeId, { arkiv: { status: "ok", ...r } });
      } catch (e) {
        meta = updateMeta(log.episodeId, { arkiv: { status: "failed", error: errMsg(e) } });
      }
    }
  }
  notify(meta);

  // 4. zerobot receipt: closes the command that started this episode, carrying the chain head and storage root
  const origin = zerobotOriginOf(log);
  if (origin) {
    const zc = zerobotConfigFromEnv();
    if (!envFlag("ROBOT_ZEROBOT", "on")) {
      meta = updateMeta(log.episodeId, { zerobot: { status: "off" } });
    } else if (!zerobotChain && !zerobotConfigured(zc)) {
      meta = updateMeta(log.episodeId, { zerobot: { status: "not_configured", missing: ZEROBOT_MISSING } });
    } else {
      try {
        const result = encodeResult({ v: 1, episodeId: log.episodeId, outcome: log.outcome, headHash: log.headHash, rootHash });
        const chain = zerobotChain ? zerobotChain() : ethersZerobot(zc);
        const r = await chain.submitReceipt(origin.nonce, log.outcome === "DONE", result);
        meta = updateMeta(log.episodeId, {
          zerobot: { status: "ok", robotId: origin.robotId, nonce: origin.nonce, receiptTx: r.txHash, link: txLink(zc, r.txHash) },
        });
      } catch (e) {
        meta = updateMeta(log.episodeId, { zerobot: { status: "failed", error: errMsg(e) } });
      }
    }
    notify(meta);
  }
  return meta;
}
