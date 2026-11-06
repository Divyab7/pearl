/**
 * Storage backup (rev 5, R5; owner chose "device uploads, laptop backup"). When the device's own 0G Storage upload did
 * not happen, the dashboard may upload the SAME locked file with the operator's key, but only if its public header
 * carries a valid signature from the expected device. The relay can carry the locked file; it can neither read it nor
 * change it (any edit changes its root and breaks unlocking). Every relayed upload is recorded and shown as "relayed",
 * never as the device's own.
 */
import { resolve } from "node:path";
import type { UploadReceipt } from "../og/storage.js";
import { REPO_ROOT } from "../shared/env.js";
import { headMessage, recoverDevice } from "../shared/deviceKey.js";
import { sealedBytes, type SealedEpisode } from "../shared/seal.js";
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
  sealed: SealedEpisode,
  expectedDevice: string,
  upload: (bytes: Uint8Array) => Promise<UploadReceipt>,
  dir = relayDir(),
): Promise<RelayRecord> {
  const existing = readRelay(sealed.episodeId, dir);
  if (existing) return existing;
  const who = recoverDevice(headMessage(sealed.episodeId, sealed.headHash), sealed.device.signature);
  if (!who || who.toLowerCase() !== expectedDevice.toLowerCase()) {
    throw new Error(`refused: signed by ${who ?? "nobody"}, expected device ${expectedDevice}`);
  }
  const r = await upload(sealedBytes(sealed));
  const rec: RelayRecord = {
    episodeId: sealed.episodeId, rootHash: r.rootHash, txHash: r.txHash, txSeq: r.txSeq, device: who, relayedAt: new Date().toISOString(),
  };
  writeJson(relayPath(sealed.episodeId, dir), rec);
  return rec;
}
