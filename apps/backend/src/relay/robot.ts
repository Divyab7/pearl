/**
 * Robot side of the offline relay (relay spec §1 "fallback ladder", §3):
 *  - no internet → pack the closed run into a sealed bundle of the robot's own pre-signed txs, keep it in the outbox
 *    (data/outbox/<bundleId>.json), find the laptop relay (RELAY_URL or mDNS `_pearl-relay._tcp`), POST it and poll
 *    until `done`; the bundle is never deleted before that;
 *  - back online → flush the outbox by submitting the bundles itself (same §2 relayer, idempotent with whatever the
 *    laptop already did), BEFORE any new direct publish, so nonces stay in order; a `stale` bundle is re-signed with
 *    fresh nonces;
 *  - every state change lands in the run's meta (`relay`), and `done` fills storage/frames/anchor/arkiv with the real
 *    tx hashes, so the dashboard shows "sent via relay".
 */
import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Transaction, type ethers } from "ethers";
import { REPO_ROOT } from "../shared/env.js";
import { errMsg, readJson, writeJson } from "../shared/util.js";
import { updateMeta, type EpisodeMeta } from "../orchestrator/meta.js";
import { buildBundle, bundleIdOf, fileBytes, type Bundle, type BundleInput } from "./bundle.js";
import { loadCache, presignDir, refreshCache, saveCache } from "./cache.js";
import { storageIndexerUrl, type ChainName } from "./chains.js";
import { httpJsonRpc, type JsonRpc } from "./rpc.js";
import { submitBundle, type BundleState, type Step, type SubmitDeps } from "./submit.js";

type MetaRelay = NonNullable<EpisodeMeta["relay"]>;

export interface OutboxEntry {
  bundleId: string;
  episodeId: string;
  createdAt: string;
  bundle: Bundle;
  /** what is needed to re-sign the same run with fresh nonces (the bytes are in bundle.files) */
  extra: Pick<BundleInput, "armId" | "endedAtMs" | "requestIds" | "anchorAddress" | "arkivLifetimeDays">;
  state: MetaRelay["state"];
  via: MetaRelay["via"];
  relayUrl?: string;
  steps?: Step[];
  error?: string;
  updatedAt: string;
}

export function outboxDir(): string {
  return process.env.OUTBOX_DIR ?? resolve(REPO_ROOT, "data", "outbox");
}

export class Outbox {
  constructor(readonly dir = outboxDir()) {}
  private path = (id: string) => resolve(this.dir, `${id}.json`);

  /** Pending bundles in creation (= nonce) order. */
  list(): OutboxEntry[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f));
    } catch {
      return [];
    }
    const firstNonce = (e: OutboxEntry) => e.bundle.txs.find((t) => t.chain === "0g-galileo")?.nonce ?? 0;
    return files
      .map((f) => readJson<OutboxEntry | null>(resolve(this.dir, f), null))
      .filter((e): e is OutboxEntry => !!e)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || firstNonce(a) - firstNonce(b));
  }
  put(e: OutboxEntry): void {
    writeJson(this.path(e.bundleId), e);
  }
  remove(id: string): void {
    rmSync(this.path(id), { force: true });
  }
  /** The next free nonce per chain after every bundle still waiting here. */
  reserved(): Partial<Record<ChainName, number>> {
    const r: Partial<Record<ChainName, number>> = {};
    for (const e of this.list()) {
      if (e.state === "stale") continue; // its nonces are gone anyway; it will be re-signed
      for (const t of e.bundle.txs) r[t.chain] = Math.max(r[t.chain] ?? 0, t.nonce + 1);
    }
    return r;
  }
}

export interface RobotRelayDeps {
  wallet: ethers.Wallet;
  /** true when the robot can reach the chains itself (sim toggle + a quick RPC probe) */
  online: () => Promise<boolean>;
  /** the laptop relay's API base (…/api/relay), or null when none is found */
  discover: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  rpc?: JsonRpc;
  /** extra relayer settings for the robot's own submissions (tests: fake chains) */
  submitDeps?: Partial<SubmitDeps>;
  notify?: (m: EpisodeMeta) => void;
  outbox?: Outbox;
  cacheDir?: string;
  pollMs?: number;
  /** how long one delivery waits for the laptop to finish a bundle before trying again later */
  pollTimeoutMs?: number;
}

const FINAL: BundleState[] = ["done", "failed", "stale"];

export class RobotRelay {
  readonly outbox: Outbox;
  private lock: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private rpc: JsonRpc;
  private f: typeof fetch;

  constructor(private d: RobotRelayDeps) {
    this.outbox = d.outbox ?? new Outbox();
    this.f = d.fetchImpl ?? fetch;
    this.rpc = d.rpc ?? httpJsonRpc(this.f);
  }

  online(): Promise<boolean> {
    return this.d.online().catch(() => false);
  }

  pending(): number {
    return this.outbox.list().length;
  }

  /** One job at a time: building, delivering and flushing all touch nonces and the outbox. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.lock.then(job, job);
    this.lock = run.catch(() => {});
    return run;
  }

  private meta(episodeId: string, patch: Partial<EpisodeMeta>): EpisodeMeta {
    const m = updateMeta(episodeId, patch);
    this.d.notify?.(m);
    return m;
  }

  private metaRelay(e: OutboxEntry): EpisodeMeta {
    return this.meta(e.episodeId, {
      relay: {
        bundleId: e.bundleId, state: e.state, via: e.via, updatedAt: e.updatedAt,
        ...(e.relayUrl ? { relayUrl: e.relayUrl } : {}), ...(e.steps ? { steps: e.steps } : {}), ...(e.error ? { error: e.error } : {}),
      },
    });
  }

  private save(e: OutboxEntry, patch: { [K in keyof OutboxEntry]?: OutboxEntry[K] | undefined }): OutboxEntry {
    const n = { ...e, ...patch, updatedAt: new Date().toISOString() } as OutboxEntry;
    if (patch.error === undefined && "error" in patch) delete n.error;
    this.outbox.put(n);
    this.metaRelay(n);
    return n;
  }

  /** A run the robot could not publish: sign it into a bundle, keep it, and try the laptop relay in the background. */
  packOffline(input: BundleInput): Promise<EpisodeMeta> {
    return this.exclusive(async () => {
      const cache = loadCache(this.d.wallet.address, this.d.cacheDir ?? presignDir());
      let built;
      try {
        built = await buildBundle(this.d.wallet, input, cache);
      } catch (e) {
        return this.meta(input.episodeId, {
          relay: { bundleId: "", state: "failed", via: null, error: `cannot pack the run offline: ${errMsg(e)}`, updatedAt: new Date().toISOString() },
        });
      }
      saveCache(built.cache, this.d.cacheDir ?? presignDir());
      const b = built.bundle;
      const now = new Date().toISOString();
      const e: OutboxEntry = {
        bundleId: bundleIdOf(b), episodeId: b.episodeId, createdAt: b.createdAt, bundle: b,
        extra: { armId: input.armId, endedAtMs: input.endedAtMs, requestIds: input.requestIds, anchorAddress: input.anchorAddress, arkivLifetimeDays: input.arkivLifetimeDays },
        state: "queued", via: null, updatedAt: now,
      };
      this.outbox.put(e);
      const m = this.metaRelay(e);
      void this.deliver();
      return m;
    });
  }

  /** Offline: hand the outbox to the laptop relay, in order, and wait for each to finish. */
  deliver(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.outbox.list().length) return;
      if (await this.online()) return void (await this.flushNow());
      const base = await this.d.discover().catch(() => null);
      if (!base) return; // nobody to carry it yet; the retry loop tries again
      for (let e of this.outbox.list()) {
        if (e.state === "stale") return; // needs internet to re-sign
        try {
          const r = await this.f(`${base}/bundle`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e.bundle), signal: AbortSignal.timeout(15_000),
          });
          const body = (await r.json().catch(() => ({}))) as { state?: BundleState; error?: string };
          if (!r.ok) {
            this.save(e, { state: "failed", error: `relay refused: ${body.error ?? r.status}`, relayUrl: base, via: "laptop" });
            return;
          }
          e = this.save(e, { state: "sent", via: "laptop", relayUrl: base, error: undefined });
          const st = await this.pollRelay(base, e);
          if (st.state === "done") {
            this.finish(e, st.steps, "laptop");
            continue;
          }
          if (st.state === "failed" || st.state === "stale") {
            this.save(e, { state: st.state, steps: st.steps, error: st.steps.find((s) => s.error)?.error ?? st.state });
          }
          return; // keep nonce order: later bundles wait
        } catch (err) {
          this.save(e, { error: `relay unreachable: ${errMsg(err)}` });
          return;
        }
      }
    });
  }

  private async pollRelay(base: string, e: OutboxEntry): Promise<{ state: BundleState; steps: Step[] }> {
    const until = Date.now() + (this.d.pollTimeoutMs ?? 300_000);
    let last: { state: BundleState; steps: Step[] } = { state: "received", steps: [] };
    for (;;) {
      const r = await this.f(`${base}/bundles/${e.bundleId}`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        last = (await r.json()) as { state: BundleState; steps: Step[] };
        if (FINAL.includes(last.state)) return last;
        if (last.state === "submitting") this.save(e, { state: "submitting", steps: last.steps });
      }
      if (Date.now() >= until) return last;
      await new Promise((res) => setTimeout(res, this.d.pollMs ?? 2000));
    }
  }

  /** Online: submit every outbox bundle itself, in order, before any new direct tx. */
  flush(): Promise<void> {
    return this.exclusive(() => this.flushNow());
  }

  private submitDeps(): SubmitDeps {
    return { rpc: this.rpc, ...this.d.submitDeps };
  }

  private async flushNow(): Promise<void> {
    for (let e of this.outbox.list()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (e.state === "stale") e = await this.resign(e);
        e = this.save(e, { state: "submitting", via: "self", error: undefined });
        const r = await submitBundle(e.bundle, this.submitDeps(), { steps: e.steps ?? [] });
        if (r.state === "done") {
          this.finish(e, r.steps, "self");
          break;
        }
        e = this.save(e, { state: r.state === "stale" ? "stale" : "failed", steps: r.steps, error: r.steps.find((s) => s.error)?.error ?? r.state });
        if (r.state !== "stale") return; // failed: keep it, stop here (nonce order); the next flush retries
      }
      if (e.state === "stale") return;
    }
  }

  /** Re-signs a stale bundle's run with fresh nonces (needs internet). */
  private async resign(e: OutboxEntry): Promise<OutboxEntry> {
    const dir = this.d.cacheDir ?? presignDir();
    const { cache } = await refreshCache(loadCache(this.d.wallet.address, dir), { rpc: this.rpc, ...(this.d.submitDeps?.rpcUrl ? { rpcUrl: this.d.submitDeps.rpcUrl } : {}), ...(this.d.submitDeps?.storageNodes ? { storageNodes: this.d.submitDeps.storageNodes } : {}) });
    const b = e.bundle;
    const input: BundleInput = {
      ...e.extra, episodeId: b.episodeId, outcome: b.summary.outcome, incident: b.summary.incident, severity: b.summary.severity,
      headHash: b.summary.headHash, log: fileBytes(b.files[0]!),
      frames: b.files.slice(1).map((f) => ({ idx: f.idx ?? 0, bytes: fileBytes(f) })),
    };
    const built = await buildBundle(this.d.wallet, input, cache);
    saveCache(built.cache, dir);
    this.outbox.remove(e.bundleId);
    const n: OutboxEntry = { ...e, bundleId: bundleIdOf(built.bundle), bundle: built.bundle, createdAt: built.bundle.createdAt, state: "queued", updatedAt: new Date().toISOString() };
    delete n.steps;
    delete n.error;
    this.outbox.put(n);
    return n;
  }

  /** Online refresh of nonces/fees/prices, never below the outbox's reserved nonces. */
  refresh(): Promise<string[]> {
    return this.exclusive(async () => {
      const dir = this.d.cacheDir ?? presignDir();
      const r = await refreshCache(loadCache(this.d.wallet.address, dir), {
        rpc: this.rpc,
        ...(this.d.submitDeps?.rpcUrl ? { rpcUrl: this.d.submitDeps.rpcUrl } : {}),
        ...(this.d.submitDeps?.storageNodes ? { storageNodes: this.d.submitDeps.storageNodes } : {}),
      }, this.outbox.reserved());
      saveCache(r.cache, dir);
      return r.errors;
    });
  }

  /** The bundle is on-chain: record the real receipts in the meta and drop it from the outbox. */
  private finish(e: OutboxEntry, steps: Step[], via: "laptop" | "self"): void {
    const b = e.bundle;
    const stepOf = (p: string) => steps.find((s) => s.purpose === p);
    const patch: Partial<EpisodeMeta> = {};
    const log = stepOf("storage:log");
    if (log) {
      patch.storage = {
        status: "ok", rootHash: b.files[0]!.root, txHash: log.txHash, txSeq: log.txSeq ?? 0,
        url: `${storageIndexerUrl().replace(/\/$/, "")}/file?root=${b.files[0]!.root}`, ms: 0,
      };
    }
    const frames = b.files.slice(1).map((f) => {
      const s = stepOf(`storage:frame:${f.idx}`);
      return { idx: f.idx ?? 0, rootHash: f.root, status: "ok" as const, ...(s ? { txHash: s.txHash } : {}) };
    });
    if (frames.length) patch.frames = frames;
    const anchorTx = b.txs.find((t) => t.purpose === "anchor");
    const a = stepOf("anchor");
    if (a && anchorTx) patch.anchor = { status: "ok", address: Transaction.from(anchorTx.raw).to ?? "", txHash: a.txHash };
    const k = stepOf("arkiv");
    if (k) patch.arkiv = { status: "ok", entityKey: k.entityKey ?? "", txHash: k.txHash };
    this.outbox.remove(e.bundleId);
    this.meta(e.episodeId, {
      ...patch,
      relay: { bundleId: e.bundleId, state: "done", via, steps, updatedAt: new Date().toISOString(), ...(e.relayUrl ? { relayUrl: e.relayUrl } : {}) },
    });
  }

  /** Background retry: offline → offer the outbox to the laptop relay; online → flush it. */
  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.outbox.list().length) void this.deliver().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
