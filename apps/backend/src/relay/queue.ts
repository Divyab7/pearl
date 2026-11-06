/**
 * The laptop relay's bundle queue (spec §3): accepts verified bundles, persists each to data/relay-bundles/<id>.json
 * (so a restart resumes), and submits them one at a time in the background with the §2 relayer.
 * Idempotent by bundleId: a re-POST of a known bundle returns its current state; a `failed` one is retried.
 * The relay holds no key and pays nothing: every tx is the robot's own, pre-signed.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import { errMsg, readJson, writeJson } from "../shared/util.js";
import { verifyBundle, type Bundle, type VerifyOptions } from "./bundle.js";
import { initialSteps, type BundleState, type Step } from "./submit.js";

export interface RelayBundleStatus {
  bundleId: string;
  episodeId: string;
  device: string;
  state: BundleState;
  steps: Step[];
  receivedAt: string;
  updatedAt: string;
  /** public labels, for the dashboard list */
  summary: Bundle["summary"];
  error?: string;
}

interface Stored {
  status: RelayBundleStatus;
  bundle: Bundle;
}

export type BundleSubmitter = (
  bundle: Bundle,
  steps: Step[],
  onStep: (steps: Step[], state: BundleState) => void,
) => Promise<{ state: BundleState; steps: Step[] }>;

export function relayBundlesDir(): string {
  return process.env.RELAY_BUNDLES_DIR ?? resolve(REPO_ROOT, "data", "relay-bundles");
}

const ID = /^0x[0-9a-f]{64}$/;

export class RelayQueue {
  private items = new Map<string, Stored>();
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<string>();

  constructor(
    private submit: BundleSubmitter,
    private dir = relayBundlesDir(),
    private verifyOpts: VerifyOptions = {},
  ) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f));
    } catch {
      // no folder yet
    }
    for (const f of files) {
      const s = readJson<Stored | null>(resolve(dir, f), null);
      if (s?.status?.bundleId) this.items.set(s.status.bundleId, s);
    }
  }

  /** Re-queues everything a restart interrupted (received / submitting), oldest bundle first. */
  resume(): void {
    const open = [...this.items.values()].filter((s) => s.status.state === "received" || s.status.state === "submitting");
    open.sort((a, b) => a.bundle.createdAt.localeCompare(b.bundle.createdAt));
    for (const s of open) this.enqueue(s.status.bundleId);
  }

  /** Validates and stores a POSTed bundle. 400 with a reason when it is not acceptable. */
  async accept(body: unknown): Promise<{ status: 202 | 400; body: { bundleId: string; state: BundleState } | { error: string } }> {
    const v = await verifyBundle(body, this.verifyOpts);
    if (!v.ok) return { status: 400, body: { error: v.error } };
    const existing = this.items.get(v.bundleId);
    if (existing) {
      if (existing.status.state === "failed") {
        this.patch(v.bundleId, { state: "received" });
        this.enqueue(v.bundleId);
      }
      return { status: 202, body: { bundleId: v.bundleId, state: this.items.get(v.bundleId)!.status.state } };
    }
    const now = new Date().toISOString();
    const b = v.bundle;
    const stored: Stored = {
      bundle: b,
      status: {
        bundleId: v.bundleId, episodeId: b.episodeId, device: b.device, state: "received", steps: initialSteps(b),
        receivedAt: now, updatedAt: now, summary: b.summary,
      },
    };
    this.items.set(v.bundleId, stored);
    this.save(v.bundleId);
    this.enqueue(v.bundleId);
    return { status: 202, body: { bundleId: v.bundleId, state: "received" } };
  }

  get(bundleId: string): RelayBundleStatus | null {
    if (!ID.test(bundleId)) return null;
    return this.items.get(bundleId)?.status ?? null;
  }

  list(limit = 50): RelayBundleStatus[] {
    return [...this.items.values()].map((s) => s.status).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  }

  /** Resolves when the background worker has nothing left to do (tests, shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }

  private save(id: string): void {
    writeJson(resolve(this.dir, `${id}.json`), this.items.get(id));
  }

  private patch(id: string, p: Partial<RelayBundleStatus>): void {
    const s = this.items.get(id)!;
    s.status = { ...s.status, ...p, updatedAt: new Date().toISOString() };
    this.save(id);
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.chain = this.chain.then(async () => {
      const s = this.items.get(id);
      try {
        if (!s) return;
        this.patch(id, { state: "submitting" });
        const r = await this.submit(s.bundle, s.status.steps, (steps, state) => this.patch(id, { steps, state }));
        const failedStep = r.steps.find((x) => x.status === "failed" || x.status === "stale");
        this.patch(id, { steps: r.steps, state: r.state, ...(failedStep?.error ? { error: failedStep.error } : {}) });
      } catch (e) {
        this.patch(id, { state: "failed", error: errMsg(e) });
      } finally {
        this.queued.delete(id);
      }
    });
  }
}
