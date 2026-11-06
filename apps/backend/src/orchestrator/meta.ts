/**
 * Per-episode side record (data/episodes/<id>.meta.json): where the log went and what each sponsor module did.
 * Every module reports one of: ok (with ids), failed (with the error), off (flag), not_configured (keys missing).
 * Nothing here is ever marked ok without a real receipt.
 */
import { resolve } from "node:path";
import { episodesDir } from "./log.js";
import { readJson, writeJson } from "../shared/util.js";

export type ModuleStatus<T> =
  | ({ status: "ok" } & T)
  | { status: "failed"; error: string }
  | { status: "off" }
  | { status: "not_configured"; missing: string };

export interface EpisodeMeta {
  episodeId: string;
  storage?: ModuleStatus<{ rootHash: string; txHash: string; txSeq: number; url: string; ms: number }>;
  anchor?: ModuleStatus<{ address: string; txHash: string }>;
  arkiv?: ModuleStatus<{ entityKey: string; txHash: string }>;
  /** Present only for episodes started by a zerobot command: the receipt that closes that command on 0G Chain. */
  zerobot?: ModuleStatus<{ robotId: string; nonce: number; receiptTx: string; link: string }>;
  frames?: { idx: number; rootHash: string; status: "ok" | "failed" | "not_configured"; txHash?: string; error?: string }[];
  /**
   * Offline relay (relay spec): the robot had no internet, so it packed this run into a sealed bundle of its own
   * pre-signed txs. via "laptop" = submitted by the laptop relay ("sent via relay"), "self" = by the robot once back online.
   */
  relay?: {
    bundleId: string;
    state: "queued" | "sent" | "submitting" | "done" | "failed" | "stale";
    via: "laptop" | "self" | null;
    relayUrl?: string;
    steps?: { purpose: string; txHash: string; status: string; error?: string; txSeq?: number; entityKey?: string }[];
    error?: string;
    updatedAt: string;
  };
}

const path = (id: string, dir = episodesDir()) => resolve(dir, `${id}.meta.json`);

export function readMeta(episodeId: string, dir = episodesDir()): EpisodeMeta {
  const p = path(episodeId, dir);
  return readJson<EpisodeMeta>(p, { episodeId });
}

export function updateMeta(episodeId: string, patch: Partial<EpisodeMeta>, dir = episodesDir()): EpisodeMeta {
  const m = { ...readMeta(episodeId, dir), ...patch, episodeId };
  writeJson(path(episodeId, dir), m);
  return m;
}
