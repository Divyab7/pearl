/**
 * Storage backup (rev 5, R5; owner chose "device uploads, laptop backup"). When the device's own 0G Storage upload did
 * not happen, the dashboard may upload the SAME canonical log with the operator's key, but only if the log carries a
 * valid signature from the expected device. The relay can carry the log; it cannot change it (any edit breaks the
 * device's signature and the hash chain). Every relayed upload is recorded and shown as "relayed", never as the
 * device's own.
 */
import { resolve } from "node:path";
import { episodeBytes } from "../orchestrator/pipeline.js";
import type { UploadReceipt } from "../og/storage.js";
import { REPO_ROOT } from "../shared/env.js";
import { headMessage, recoverDevice } from "../shared/deviceKey.js";
import { verifyChain } from "../orchestrator/log.js";
import type { EpisodeLog } from "../shared/types.js";
import { readJson, safeName, writeJson } from "../shared/util.js";

export interface RelayRecord {
  episodeId: string;
  rootHash: string;
  txHash: string;
  txSeq: number;
  device: string;
  relayedAt: string;
}

export function relayDir(): string {
  return process.env.RELAY_DIR ?? resolve(REPO_ROOT, "data", "relay");
}

const relayPath = (episodeId: string, dir: string) => resolve(dir, `${safeName(episodeId)}.json`);

export function readRelay(episodeId: string, dir = relayDir()): RelayRecord | null {
  return readJson<RelayRecord | null>(relayPath(episodeId, dir), null);
}

export async function relayEpisode(
  log: EpisodeLog,
  expectedDevice: string,
  upload: (bytes: Uint8Array) => Promise<UploadReceipt>,
  dir = relayDir(),
): Promise<RelayRecord> {
  const existing = readRelay(log.episodeId, dir);
  if (existing) return existing;
  if (!log.device) throw new Error("refused: the log is not device-signed");
  const chain = verifyChain(log);
  if (!chain.ok) throw new Error(`refused: hash chain broken (${chain.reason})`);
  const who = recoverDevice(headMessage(log.episodeId, chain.recomputedHead), log.device.signature);
  if (!who || who.toLowerCase() !== expectedDevice.toLowerCase()) {
    throw new Error(`refused: signed by ${who ?? "nobody"}, expected device ${expectedDevice}`);
  }
  const r = await upload(episodeBytes(log));
  const rec: RelayRecord = {
    episodeId: log.episodeId, rootHash: r.rootHash, txHash: r.txHash, txSeq: r.txSeq, device: who, relayedAt: new Date().toISOString(),
  };
  writeJson(relayPath(log.episodeId, dir), rec);
  return rec;
}
