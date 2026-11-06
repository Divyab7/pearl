/**
 * Hash-chained episode log (prompt §8.5).
 * Each record carries prevHash (the previous record's recordHash, ZERO_HASH for idx 0) and
 * recordHash = sha256(canonical(record without recordHash)). headHash = recordHash of the last record.
 * Changing any byte of any record breaks its own hash and every later prevHash link.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "../shared/canonical.js";
import { REPO_ROOT } from "../shared/env.js";
import { ZERO_HASH, hashCanonical } from "../shared/hash.js";
import type {
  ChainedRecord,
  DecisionRecord,
  EpisodeLog,
  EpisodeOutcome,
  EventRecord,
  TaskSpec,
} from "../shared/types.js";

type DecisionInput = Omit<DecisionRecord, "v" | "kind" | "episodeId" | "idx">;
type EventInput = Omit<EventRecord, "v" | "kind" | "episodeId" | "idx">;

export function recordHashOf(rec: Omit<ChainedRecord, "recordHash">): string {
  return hashCanonical(rec);
}

export class EpisodeRecorder {
  private readonly records: ChainedRecord[] = [];
  private closed = false;
  readonly startedAt = new Date().toISOString();

  constructor(
    readonly episodeId: string,
    readonly deviceId: string,
    readonly armId: string,
    readonly task: TaskSpec,
  ) {}

  get length(): number {
    return this.records.length;
  }
  get nextIdx(): number {
    return this.records.length;
  }
  get headHash(): string {
    return this.records.at(-1)?.recordHash ?? ZERO_HASH;
  }
  all(): readonly ChainedRecord[] {
    return this.records;
  }

  addDecision(d: DecisionInput): ChainedRecord {
    return this.push({ v: 2, kind: "decision", episodeId: this.episodeId, idx: this.nextIdx, ...d });
  }

  addEvent(e: EventInput): ChainedRecord {
    return this.push({ v: 2, kind: "event", episodeId: this.episodeId, idx: this.nextIdx, ...e });
  }

  private push(body: DecisionRecord | EventRecord): ChainedRecord {
    if (this.closed) throw new Error(`episode ${this.episodeId} is closed`);
    // canonicalize first so a non-JSON value fails here, before it can enter the chain
    const withPrev = JSON.parse(canonicalize({ ...body, prevHash: this.headHash })) as Omit<ChainedRecord, "recordHash">;
    const rec = { ...withPrev, recordHash: recordHashOf(withPrev) } as ChainedRecord;
    this.records.push(rec);
    return rec;
  }

  close(outcome: EpisodeOutcome): EpisodeLog {
    this.closed = true;
    return {
      v: 2,
      episodeId: this.episodeId,
      deviceId: this.deviceId,
      armId: this.armId,
      task: this.task,
      outcome,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      records: [...this.records],
      headHash: this.headHash,
    };
  }
}

export interface ChainCheck {
  ok: boolean;
  badIdx: number | null;
  reason: string | null;
  recomputedHead: string;
}

/** Verifier check 1: recompute every recordHash and prevHash link and the headHash. */
export function verifyChain(log: Pick<EpisodeLog, "records" | "headHash" | "episodeId">): ChainCheck {
  let prev = ZERO_HASH;
  for (let i = 0; i < log.records.length; i++) {
    const r = log.records[i]!;
    const fail = (reason: string): ChainCheck => ({ ok: false, badIdx: i, reason, recomputedHead: prev });
    if (r.idx !== i) return fail(`idx ${r.idx} at position ${i}`);
    if (r.episodeId !== log.episodeId) return fail("episodeId mismatch");
    if (r.prevHash !== prev) return fail("prevHash does not match the previous record");
    const { recordHash, ...rest } = r;
    const h = recordHashOf(rest);
    if (h !== recordHash) return fail("recordHash does not match the record's content");
    prev = h;
  }
  if (prev !== log.headHash) {
    return { ok: false, badIdx: null, reason: "headHash does not match the last record", recomputedHead: prev };
  }
  return { ok: true, badIdx: null, reason: null, recomputedHead: prev };
}

/** Every 0G request id in the log, in order (the anchor commits to their hash). */
export function requestIdsOf(log: Pick<EpisodeLog, "records">): string[] {
  return log.records.flatMap((r) => (r.kind === "decision" && r.requestId ? [r.requestId] : []));
}

// ---------------- files under data/episodes ----------------
export function episodesDir(): string {
  return process.env.EPISODES_DIR ?? resolve(REPO_ROOT, "data", "episodes");
}

/** Where the LOCKED camera frame of decision record `idx` is kept (the robot never stores frames unlocked). */
export function framePath(episodeId: string, idx: number, dir = episodesDir()): string {
  return resolve(dir, episodeId, `frame-${idx}.locked`);
}

/** The sealed (locked) copy of an episode: what goes to 0G Storage and what the robot serves. */
export function sealedPath(episodeId: string, dir = episodesDir()): string {
  if (!/^ep_[A-Za-z0-9_-]+$/.test(episodeId)) throw new Error("bad episode id");
  return resolve(dir, `${episodeId}.sealed.json`);
}

export function writeEpisode(log: EpisodeLog, dir = episodesDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${log.episodeId}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
  return path;
}

export function readEpisode(episodeId: string, dir = episodesDir()): EpisodeLog {
  if (!/^ep_[A-Za-z0-9_-]+$/.test(episodeId)) throw new Error("bad episode id");
  return JSON.parse(readFileSync(resolve(dir, `${episodeId}.json`), "utf8")) as EpisodeLog;
}

export function listEpisodeIds(dir = episodesDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^ep_.*\.json$/.test(f) && !f.endsWith(".meta.json") && !f.endsWith(".sealed.json"))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
