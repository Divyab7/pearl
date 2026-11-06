/**
 * Mesh carry store (relay spec §7): the bundles of OTHER devices a node agreed to carry, separate from its own outbox.
 * Pure policy, no I/O; the clock is injected. Rules:
 *  - accept only bundles that pass §1 verification (verifyBundle); dedupe by bundleId; never carry its own bundles;
 *  - caps: 4 MB total, 1 MB per origin device (size = bytes of the bundle JSON); when full, lower-priority bundles are
 *    evicted only if the newcomer outranks them;
 *  - TTL 7 days from the bundle's createdAt; max 8 hops (hop count is local metadata: the signed bundle never changes);
 *  - priority (storage and serving): incidents first (severity desc), then oldest first;
 *  - delivered receipts {bundleId, anchorTx, chainId} are kept 7 days to gossip; only a node that VERIFIED the anchor
 *    on-chain records one. An unverified ack (a peer says "done") only stops forwarding; the bundle stays until the
 *    node can check the chain itself (a lying peer cannot make a bundle disappear).
 */
import { verifyBundle, type Bundle, type VerifyOptions } from "./bundle.js";

export const CARRY_LIMITS = {
  totalBytes: 4 * 1024 * 1024,
  perOriginBytes: 1024 * 1024,
  ttlMs: 7 * 24 * 3600 * 1000,
  maxHops: 8,
  receiptTtlMs: 7 * 24 * 3600 * 1000,
};
export type CarryLimits = typeof CARRY_LIMITS;

export interface CarryEntry {
  bundleId: string;
  origin: string; // device address
  episodeId: string;
  severity: number;
  incident: boolean;
  outcome: string;
  size: number;
  createdAtMs: number;
  /** hops travelled to reach this node (1 = straight from the origin) */
  hops: number;
  receivedAtMs: number;
  /** a peer claimed it is delivered; not verified yet, so this node stops forwarding but keeps it */
  unverifiedAck?: { anchorTx: string; chainId: number };
  bundle: Bundle;
}

export interface DeliveredReceipt {
  bundleId: string;
  anchorTx: string;
  chainId: number;
  atMs: number;
}

/** One line of the GATT LIST (§7). */
export interface ListItem {
  bundleId: string;
  origin: string;
  episodeId: string;
  size: number;
  severity: number;
  outcome: string;
  hops: number;
  own: boolean;
}

export type OfferResult =
  | { accepted: true; bundleId: string; evicted: string[] }
  | { accepted: false; bundleId: string | null; reason: "invalid" | "own" | "duplicate" | "delivered" | "expired" | "hops" | "too-big" | "full"; detail: string };

/** incidents first (severity desc), then oldest first; bundleId breaks ties so the order is total. */
export function priorityCompare(
  a: { incident: boolean; severity: number; createdAtMs: number; bundleId: string },
  b: { incident: boolean; severity: number; createdAtMs: number; bundleId: string },
): number {
  if (a.incident !== b.incident) return a.incident ? -1 : 1;
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.bundleId < b.bundleId ? -1 : a.bundleId > b.bundleId ? 1 : 0;
}

export const bundleSize = (b: unknown): number => Buffer.byteLength(JSON.stringify(b), "utf8");

export class CarryStore {
  private entries = new Map<string, CarryEntry>();
  private receipts = new Map<string, DeliveredReceipt>();
  readonly limits: CarryLimits;

  constructor(
    /** this node's own device address (its own bundles live in its outbox, not here) */
    readonly self: string,
    private now: () => number = Date.now,
    limits: Partial<CarryLimits> = {},
    private verifyOpts: VerifyOptions = {},
  ) {
    this.limits = { ...CARRY_LIMITS, ...limits };
  }

  has(bundleId: string): boolean {
    return this.entries.has(bundleId) || this.receipts.has(bundleId);
  }
  get(bundleId: string): CarryEntry | undefined {
    return this.entries.get(bundleId);
  }
  isDelivered(bundleId: string): boolean {
    return this.receipts.has(bundleId);
  }
  count(): number {
    return this.entries.size;
  }
  bytes(origin?: string): number {
    let n = 0;
    for (const e of this.entries.values()) if (!origin || e.origin.toLowerCase() === origin.toLowerCase()) n += e.size;
    return n;
  }

  /** A bundle offered by a peer that has carried it `hops` times so far (0 = the peer is the origin). */
  async offer(raw: unknown, hops: number): Promise<OfferResult> {
    this.expire();
    const v = await verifyBundle(raw, this.verifyOpts);
    if (!v.ok) return { accepted: false, bundleId: null, reason: "invalid", detail: v.error };
    const b = v.bundle;
    const id = v.bundleId;
    if (b.device.toLowerCase() === this.self.toLowerCase()) return { accepted: false, bundleId: id, reason: "own", detail: "this node's own bundle" };
    if (this.receipts.has(id)) return { accepted: false, bundleId: id, reason: "delivered", detail: "already delivered (receipt kept)" };
    if (this.entries.has(id)) return { accepted: false, bundleId: id, reason: "duplicate", detail: "already carried" };
    const createdAtMs = Date.parse(b.createdAt);
    if (this.now() - createdAtMs > this.limits.ttlMs) return { accepted: false, bundleId: id, reason: "expired", detail: "older than the carry TTL" };
    const h = hops + 1;
    if (h > this.limits.maxHops) return { accepted: false, bundleId: id, reason: "hops", detail: `${h} hops > ${this.limits.maxHops}` };
    const size = bundleSize(b);
    if (size > this.limits.perOriginBytes || size > this.limits.totalBytes) return { accepted: false, bundleId: id, reason: "too-big", detail: `${size} bytes` };
    const e: CarryEntry = {
      bundleId: id, origin: b.device, episodeId: b.episodeId, severity: b.summary.severity, incident: b.summary.incident,
      outcome: b.summary.outcome, size, createdAtMs, hops: h, receivedAtMs: this.now(), bundle: b,
    };
    // make room: per origin first, then in total; only entries the newcomer outranks may go
    const evict: string[] = [];
    const pick = (pool: CarryEntry[], need: number): boolean => {
      const victims = pool.filter((x) => !evict.includes(x.bundleId) && priorityCompare(e, x) < 0).sort((x, y) => priorityCompare(y, x));
      let freed = 0;
      for (const x of victims) {
        if (freed >= need) break;
        evict.push(x.bundleId);
        freed += x.size;
      }
      return freed >= need;
    };
    const same = [...this.entries.values()].filter((x) => x.origin.toLowerCase() === b.device.toLowerCase());
    const originOver = this.bytes(b.device) + size - this.limits.perOriginBytes;
    if (originOver > 0 && !pick(same, originOver)) return { accepted: false, bundleId: id, reason: "full", detail: `per-origin cap (${this.limits.perOriginBytes} bytes) holds higher-priority bundles` };
    const freedSoFar = evict.reduce((n, x) => n + this.entries.get(x)!.size, 0);
    const totalOver = this.bytes() - freedSoFar + size - this.limits.totalBytes;
    if (totalOver > 0 && !pick([...this.entries.values()], totalOver)) return { accepted: false, bundleId: id, reason: "full", detail: `carry store (${this.limits.totalBytes} bytes) full of higher-priority bundles` };
    for (const x of evict) this.entries.delete(x);
    this.entries.set(id, e);
    return { accepted: true, bundleId: id, evicted: evict };
  }

  /** Drops expired bundles and receipts; returns the dropped bundle ids. */
  expire(): string[] {
    const t = this.now();
    const gone: string[] = [];
    for (const [id, e] of this.entries) {
      if (t - e.createdAtMs > this.limits.ttlMs) {
        this.entries.delete(id);
        gone.push(id);
      }
    }
    for (const [id, r] of this.receipts) if (t - r.atMs > this.limits.receiptTtlMs) this.receipts.delete(id);
    return gone;
  }

  /** What this node serves to peers, in priority order (never bundles it was told are delivered, nor past max hops). */
  serveList(): ListItem[] {
    this.expire();
    return [...this.entries.values()]
      .filter((e) => !e.unverifiedAck && e.hops < this.limits.maxHops)
      .sort(priorityCompare)
      .map((e) => ({ bundleId: e.bundleId, origin: e.origin, episodeId: e.episodeId, size: e.size, severity: e.severity, outcome: e.outcome, hops: e.hops, own: false }));
  }

  /** What an online node should submit, in priority order (including ones with unverified acks: it can check now). */
  toSubmit(): CarryEntry[] {
    this.expire();
    return [...this.entries.values()].sort(priorityCompare);
  }

  /** A peer says the bundle is delivered, and this node cannot check yet: stop forwarding, keep it. */
  ackUnverified(bundleId: string, anchorTx: string, chainId: number): boolean {
    const e = this.entries.get(bundleId);
    if (!e || e.unverifiedAck) return false;
    e.unverifiedAck = { anchorTx, chainId };
    return true;
  }

  /** The node found the anchor on-chain itself: drop the bundle, keep a receipt to gossip. */
  markDelivered(bundleId: string, anchorTx: string, chainId: number): void {
    this.entries.delete(bundleId);
    this.receipts.set(bundleId, { bundleId, anchorTx, chainId, atMs: this.now() });
  }

  /** The claimed delivery was false (anchor not on-chain): forward it again. */
  clearAck(bundleId: string): void {
    const e = this.entries.get(bundleId);
    if (e) delete e.unverifiedAck;
  }

  receiptList(): DeliveredReceipt[] {
    this.expire();
    return [...this.receipts.values()];
  }
}
