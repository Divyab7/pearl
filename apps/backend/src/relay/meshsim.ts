/**
 * Deterministic mesh simulator (relay spec §7). N virtual robots and couriers of different owners, each with its own
 * key, build REAL signed bundles (buildBundle) and run the §7 pull cycle over an in-memory GATT-like transport
 * (info / LIST / data / RECEIPTS / pings, all as JSON text, like the BLE characteristics). A link schedule says who is
 * in range of whom over time; nodes lose or gain internet and can die; a tampering node edits what it serves and
 * gossips fake delivery receipts. Nodes with internet submit with the §2 relayer against fake chains/storage (FakeNet),
 * check the anchor on-chain and keep delivered receipts.
 * Output: nodes, a time-ordered event list (t in seconds of sim time), bundles and a result — the dashboard demo view
 * draws exactly this (GET /api/mesh/sim).
 */
import { ethers } from "ethers";
import { bundleIdOf, buildBundle, type Bundle } from "./bundle.js";
import { CHAIN_IDS } from "./chains.js";
import { CarryStore, bundleSize, type CarryLimits, type ListItem } from "./carry.js";
import { FakeNet } from "./fakeNet.js";
import { submitBundle, type SubmitDeps } from "./submit.js";
import { primedCache } from "./testkit.js";
import type { PresignCache } from "./cache.js";
import type { EpisodeOutcome } from "../shared/types.js";

export type MeshEventType =
  | "link-up" | "link-down" | "ping" | "pull" | "refused" | "submit" | "delivered" | "drop" | "internet-down" | "internet-up" | "node-dead";

export interface MeshEvent {
  t: number;
  type: MeshEventType;
  from?: string;
  to?: string;
  bundleId?: string;
  origin?: string;
  detail?: string;
}

export interface MeshNodeSpec {
  id: string;
  label: string;
  owner: string;
  internet: boolean;
  /** edits every bundle it serves, injects a forged one and gossips fake receipts */
  tamper?: boolean;
}

export interface Scenario {
  name: string;
  durationSec: number;
  tickSec: number;
  nodes: MeshNodeSpec[];
  links: { a: string; b: string; from: number; to: number }[];
  runs: { node: string; t: number; outcome: EpisodeOutcome; severity: number; incident: boolean }[];
  internet: { node: string; t: number; online: boolean }[];
  deaths: { node: string; t: number }[];
  limits?: Partial<CarryLimits>;
}

export interface MeshResult {
  scenario: string;
  seed: number;
  durationSec: number;
  nodes: { id: string; label: string; owner: string; internet: boolean; alive: boolean }[];
  events: MeshEvent[];
  bundles: { bundleId: string; origin: string; episodeId: string; severity: number; valid: boolean }[];
  result: { delivered: number; total: number; refused: number };
}

const SIM_EPOCH = Date.parse("2026-11-06T09:00:00.000Z");
const CYCLE_SEC = 30; // pull cycle (spec: scan ~5 s every ~30 s, and on a new advertisement)
const REVISIT_SEC = 60; // don't revisit a peer within a minute

export const pingMessage = (p: { device: string; episodeId: string; outcome: string; severity: number; headHash: string; ts: number }) =>
  `pearl/ping/v1|${p.device.toLowerCase()}|${p.episodeId}|${p.outcome}|${p.severity}|${p.headHash}|${p.ts}`;

interface Ping { v: 1; device: string; episodeId: string; outcome: string; severity: number; headHash: string; ts: number; sig: string }

const rnd = (seed: number, s: string) => BigInt(ethers.keccak256(ethers.toUtf8Bytes(`${seed}|${s}`)));
const bytesOf = (seed: number, label: string, n: number) => {
  const out = new Uint8Array(n);
  let h = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`${seed}|${label}`)));
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0 && i) h = ethers.getBytes(ethers.keccak256(h));
    out[i] = h[i % 32]!;
  }
  return out;
};

class SimNode {
  alive = true;
  internet: boolean;
  outbox: { id: string; bundle: Bundle }[] = [];
  carry: CarryStore;
  pings = new Map<string, Ping>();
  lastVisit = new Map<string, number>();
  refusedFrom = new Set<string>();
  submitSeen = new Map<string, string>();
  forged: { id: string; bundle: Bundle } | null = null;
  readonly wallet: ethers.Wallet;
  cache: PresignCache;

  constructor(readonly spec: MeshNodeSpec, seed: number, now: () => number, limits: Partial<CarryLimits> = {}) {
    this.wallet = new ethers.Wallet(ethers.toBeHex(rnd(seed, `key:${spec.id}`) % (2n ** 255n) + 1n, 32));
    this.internet = spec.internet;
    this.carry = new CarryStore(this.wallet.address, now, limits);
    this.cache = primedCache(this.wallet.address);
  }

  get address() {
    return this.wallet.address;
  }

  // ---- GATT-like server side (JSON text, as the BLE characteristics carry it)
  info(): string {
    return JSON.stringify({
      v: 1, device: this.address, pending: this.outbox.length, carrying: this.carry.count() + (this.forged ? 1 : 0),
      delivered: this.carry.receiptList().length,
    });
  }
  list(): string {
    const own: ListItem[] = this.outbox.map((o) => ({
      bundleId: o.id, origin: this.address, episodeId: o.bundle.episodeId, size: bundleSize(o.bundle), severity: o.bundle.summary.severity,
      outcome: o.bundle.summary.outcome, hops: 0, own: true,
    }));
    const items = [...own, ...this.carry.serveList()];
    if (this.forged) {
      const f = this.forged.bundle;
      items.push({ bundleId: this.forged.id, origin: f.device, episodeId: f.episodeId, size: bundleSize(f), severity: f.summary.severity, outcome: f.summary.outcome, hops: 1, own: false });
    }
    return JSON.stringify(items);
  }
  read(id: string): string | null {
    const own = this.outbox.find((o) => o.id === id)?.bundle;
    const b = own ?? this.carry.get(id)?.bundle ?? (this.forged?.id === id ? this.forged.bundle : undefined);
    if (!b) return null;
    if (this.spec.tamper && !own && this.forged?.id !== id) {
      // downgrade the incident it carries: the signature no longer matches
      const t = JSON.parse(JSON.stringify(b)) as Bundle;
      t.summary.severity = 0;
      t.summary.incident = false;
      return JSON.stringify(t);
    }
    return JSON.stringify(b);
  }
  receipts(): string {
    const real = this.carry.receiptList().map((r) => ({ bundleId: r.bundleId, anchorTx: r.anchorTx, chainId: r.chainId }));
    if (this.spec.tamper) {
      // lies: claims everything it carries is delivered
      for (const e of this.carry.toSubmit()) real.push({ bundleId: e.bundleId, anchorTx: `0x${"de".repeat(32)}`, chainId: CHAIN_IDS["0g-galileo"] });
    }
    return JSON.stringify(real);
  }
  pingList(): string {
    return JSON.stringify([...this.pings.values()].sort((a, b) => b.ts - a.ts).slice(0, 8));
  }
}

const verifyPing = (p: Ping): boolean => {
  try {
    return ethers.verifyMessage(pingMessage(p), p.sig) === ethers.getAddress(p.device);
  } catch {
    return false;
  }
};

/** Runs a scenario; same scenario + seed → the same events, byte for byte. */
export async function runMeshSim(scenario: Scenario, seed = 1): Promise<MeshResult & { net: FakeNet; validIds: Set<string> }> {
  let tNow = 0;
  const now = () => SIM_EPOCH + tNow * 1000;
  const nodes = scenario.nodes.map((s) => new SimNode(s, seed, now, scenario.limits));
  const byId = new Map(nodes.map((n) => [n.spec.id, n]));
  const nameOf = new Map(nodes.map((n) => [n.address.toLowerCase(), n.spec.id]));
  const originId = (addr: string) => nameOf.get(addr.toLowerCase()) ?? addr;
  const events: MeshEvent[] = [];
  const ev = (e: Omit<MeshEvent, "t">) => events.push({ t: tNow, ...e });
  const net = new FakeNet();
  const deps: SubmitDeps = { rpc: net.rpc, rpcUrl: net.rpcUrl, storageNodes: net.storageNodes, sleep: async () => {}, pollMs: 0, receiptTimeoutMs: 20, storageTimeoutMs: 20 };
  const bundles: MeshResult["bundles"] = [];
  const validIds = new Set<string>();
  const anchorOf = new Map<string, string>(); // bundleId → anchor tx hash
  const delivered = new Set<string>();
  let refused = 0;

  const anchorOnChain = (anchorTx: string | undefined): boolean => {
    if (!anchorTx) return false;
    const r = net.chains["0g-galileo"].txs.get(anchorTx.toLowerCase());
    return r?.receipt.status === "0x1";
  };

  const linkActive = (l: Scenario["links"][number]) => tNow >= l.from && tNow < l.to && byId.get(l.a)?.alive && byId.get(l.b)?.alive;
  let active = new Set<number>();
  const peersOf = (n: SimNode) =>
    scenario.links.flatMap((l, i) => (active.has(i) ? (l.a === n.spec.id ? [byId.get(l.b)!] : l.b === n.spec.id ? [byId.get(l.a)!] : []) : []));

  const makeRun = async (n: SimNode, r: Scenario["runs"][number], k: number) => {
    const episodeId = `ep_${new Date(now()).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${n.spec.id}${k}`;
    const headHash = ethers.keccak256(ethers.toUtf8Bytes(`${seed}|head|${episodeId}`)).slice(2);
    const built = await buildBundle(n.wallet, {
      episodeId, armId: n.spec.id, endedAtMs: now(), outcome: r.outcome, incident: r.incident, severity: r.severity, headHash,
      requestIds: [], log: bytesOf(seed, `log:${episodeId}`, 1800 + Number(rnd(seed, episodeId) % 1500n)), frames: [],
      anchorAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", arkivLifetimeDays: 30, arkivSalt: rnd(seed, `salt:${episodeId}`) % (2n ** 128n),
    }, n.cache, new Date(now()));
    n.cache = built.cache;
    const id = bundleIdOf(built.bundle);
    n.outbox.push({ id, bundle: built.bundle });
    validIds.add(id);
    anchorOf.set(id, built.bundle.txs.find((t) => t.purpose === "anchor")!.hash);
    bundles.push({ bundleId: id, origin: n.spec.id, episodeId, severity: r.severity, valid: true });
    const ping: Omit<Ping, "sig"> = { v: 1, device: n.address, episodeId, outcome: r.outcome, severity: r.severity, headHash, ts: now() };
    n.pings.set(episodeId, { ...ping, sig: await n.wallet.signMessage(pingMessage(ping)) });
    ev({ type: "ping", from: n.spec.id, bundleId: id, origin: n.spec.id, detail: `new run ${r.outcome}, severity ${r.severity}` });
  };

  const forge = (n: SimNode) => {
    // takes the first valid bundle it carries and edits its locked log: the root and the signature no longer hold
    const src = n.carry.toSubmit()[0]?.bundle;
    if (!src || n.forged) return;
    const f = JSON.parse(JSON.stringify(src)) as Bundle;
    const d = Buffer.from(f.files[0]!.data, "base64");
    d[10] = d[10]! ^ 0xff;
    f.files[0]!.data = d.toString("base64");
    f.summary.severity = 3;
    const id = bundleIdOf(f);
    n.forged = { id, bundle: f };
    bundles.push({ bundleId: id, origin: originId(f.device), episodeId: f.episodeId, severity: 3, valid: false });
  };

  /** A node with internet: own outbox in nonce order, then carried bundles by priority; verify the anchor, keep receipts. */
  const gateway = async (n: SimNode) => {
    const note = (id: string, origin: string, state: string, detail?: string) => {
      if (n.submitSeen.get(id) === state) return;
      n.submitSeen.set(id, state);
      ev({ type: "submit", from: n.spec.id, bundleId: id, origin, detail: detail ? `${state}: ${detail}` : state });
    };
    const confirm = (id: string, origin: string) => {
      if (!delivered.has(id)) {
        delivered.add(id);
        ev({ type: "delivered", from: n.spec.id, bundleId: id, origin, detail: `anchor ${anchorOf.get(id)} on 0G Chain` });
      }
    };
    for (const o of [...n.outbox]) {
      const r = await submitBundle(o.bundle, deps);
      note(o.id, n.spec.id, r.state, r.steps.find((s) => s.error)?.error);
      if (r.state !== "done" || !anchorOnChain(anchorOf.get(o.id))) break; // nonce order: later ones wait
      confirm(o.id, n.spec.id);
      n.outbox = n.outbox.filter((x) => x.id !== o.id);
      n.carry.markDelivered(o.id, anchorOf.get(o.id)!, CHAIN_IDS["0g-galileo"]);
    }
    for (const e of n.carry.toSubmit()) {
      const origin = originId(e.origin);
      if (e.unverifiedAck) {
        if (anchorOnChain(e.unverifiedAck.anchorTx) && anchorOf.get(e.bundleId) === e.unverifiedAck.anchorTx) {
          n.carry.markDelivered(e.bundleId, e.unverifiedAck.anchorTx, e.unverifiedAck.chainId);
          ev({ type: "drop", from: n.spec.id, bundleId: e.bundleId, origin, detail: "delivered: receipt verified on-chain" });
          continue;
        }
        n.carry.clearAck(e.bundleId);
        ev({ type: "drop", from: n.spec.id, bundleId: e.bundleId, origin, detail: "receipt was false (no anchor on-chain): forwarding again" });
      }
      const r = await submitBundle(e.bundle, deps);
      note(e.bundleId, origin, r.state, r.steps.find((s) => s.error)?.error);
      const anchorTx = e.bundle.txs.find((t) => t.purpose === "anchor")?.hash;
      if (r.state === "done" && anchorOnChain(anchorTx)) {
        confirm(e.bundleId, origin);
        n.carry.markDelivered(e.bundleId, anchorTx!, CHAIN_IDS["0g-galileo"]);
        ev({ type: "drop", from: n.spec.id, bundleId: e.bundleId, origin, detail: "delivered: dropped, receipt kept" });
      }
    }
  };

  /** Central side of one visit: info → LIST → pull → RECEIPTS → pings → disconnect. */
  const visit = async (p: SimNode, q: SimNode) => {
    p.lastVisit.set(q.spec.id, tNow);
    const info = JSON.parse(q.info()) as { pending: number; carrying: number; delivered: number };
    if (info.pending + info.carrying + info.delivered === 0 && q.pings.size === 0) return;
    const list = JSON.parse(q.list()) as ListItem[];
    for (const item of list) {
      if (item.origin.toLowerCase() === p.address.toLowerCase()) continue; // its own run
      if (p.carry.has(item.bundleId) || p.refusedFrom.has(`${q.spec.id}|${item.bundleId}`)) continue;
      const raw = q.read(item.bundleId);
      if (!raw) continue;
      const r = await p.carry.offer(JSON.parse(raw), item.own ? 0 : item.hops);
      const origin = originId(item.origin);
      if (r.accepted) {
        ev({ type: "pull", from: q.spec.id, to: p.spec.id, bundleId: r.bundleId, origin, detail: `hop ${item.own ? 1 : item.hops + 1}` });
        for (const x of r.evicted) ev({ type: "drop", from: p.spec.id, bundleId: x, detail: "evicted for a higher-priority bundle" });
      } else if (r.reason === "invalid") {
        refused++;
        p.refusedFrom.add(`${q.spec.id}|${item.bundleId}`);
        ev({ type: "refused", from: q.spec.id, to: p.spec.id, bundleId: item.bundleId, origin, detail: r.detail });
      } else if (r.reason !== "duplicate" && r.reason !== "own" && r.reason !== "delivered") {
        p.refusedFrom.add(`${q.spec.id}|${item.bundleId}`);
        ev({ type: "drop", from: p.spec.id, bundleId: item.bundleId, origin, detail: `not taken: ${r.reason} (${r.detail})` });
      }
    }
    for (const rc of JSON.parse(q.receipts()) as { bundleId: string; anchorTx: string; chainId: number }[]) {
      const carried = p.carry.get(rc.bundleId);
      const own = p.outbox.find((o) => o.id === rc.bundleId);
      if (!carried && !own) continue;
      const origin = carried ? originId(carried.origin) : p.spec.id;
      if (p.internet) {
        // can check now: only a real anchor counts
        if (anchorOnChain(rc.anchorTx) && anchorOf.get(rc.bundleId) === rc.anchorTx) {
          p.carry.markDelivered(rc.bundleId, rc.anchorTx, rc.chainId);
          if (own) p.outbox = p.outbox.filter((o) => o.id !== rc.bundleId);
          ev({ type: "drop", from: p.spec.id, bundleId: rc.bundleId, origin, detail: "delivered: receipt verified on-chain" });
        }
      } else if (carried && p.carry.ackUnverified(rc.bundleId, rc.anchorTx, rc.chainId)) {
        ev({ type: "drop", from: p.spec.id, bundleId: rc.bundleId, origin, detail: `stopped forwarding: unverified receipt from ${q.spec.id} (kept until checked on-chain)` });
      }
      // an unverified ack never touches the node's own outbox: it keeps offering its own runs (a liar cannot silence it)
    }
    for (const ping of JSON.parse(q.pingList()) as Ping[]) {
      if (p.pings.has(ping.episodeId) || !verifyPing(ping)) continue;
      p.pings.set(ping.episodeId, ping);
      ev({ type: "ping", from: q.spec.id, to: p.spec.id, origin: originId(ping.device), detail: `${ping.outcome}, severity ${ping.severity} (${ping.episodeId})` });
    }
  };

  const runCount = new Map<string, number>();
  const phase = new Map(nodes.map((n) => [n.spec.id, Number(rnd(seed, `phase:${n.spec.id}`) % BigInt(CYCLE_SEC / scenario.tickSec)) * scenario.tickSec]));
  for (tNow = 0; tNow <= scenario.durationSec; tNow += scenario.tickSec) {
    // schedule: deaths, internet, links
    for (const d of scenario.deaths) {
      const n = byId.get(d.node)!;
      if (d.t <= tNow && n.alive) {
        n.alive = false;
        ev({ type: "node-dead", from: n.spec.id });
      }
    }
    for (const i of scenario.internet) {
      const n = byId.get(i.node)!;
      if (i.t <= tNow && i.t > tNow - scenario.tickSec && n.alive && n.internet !== i.online) {
        n.internet = i.online;
        ev({ type: i.online ? "internet-up" : "internet-down", from: n.spec.id });
      }
    }
    const nowActive = new Set(scenario.links.flatMap((l, i) => (linkActive(l) ? [i] : [])));
    const fresh = new Set<string>();
    for (const i of nowActive) {
      if (!active.has(i)) {
        const l = scenario.links[i]!;
        ev({ type: "link-up", from: l.a, to: l.b });
        fresh.add(`${l.a}|${l.b}`).add(`${l.b}|${l.a}`);
      }
    }
    for (const i of active) if (!nowActive.has(i)) ev({ type: "link-down", from: scenario.links[i]!.a, to: scenario.links[i]!.b });
    active = nowActive;

    // runs closing now
    for (const r of scenario.runs) {
      if (r.t > tNow - scenario.tickSec && r.t <= tNow) {
        const n = byId.get(r.node)!;
        if (!n.alive) continue;
        const k = (runCount.get(n.spec.id) ?? 0) + 1;
        runCount.set(n.spec.id, k);
        await makeRun(n, r, k);
      }
    }
    // the tamperer forges once it has something to forge
    for (const n of nodes) if (n.alive && n.spec.tamper) forge(n);

    // gateways submit; then everyone runs its pull cycle (one connection at a time, in node order)
    for (const n of nodes) if (n.alive && n.internet) await gateway(n);
    for (const n of nodes) {
      if (!n.alive) continue;
      const cycle = (tNow - phase.get(n.spec.id)!) % CYCLE_SEC === 0;
      for (const q of peersOf(n)) {
        const last = n.lastVisit.get(q.spec.id);
        const due = last === undefined || tNow - last >= REVISIT_SEC;
        if (due && (cycle || fresh.has(`${n.spec.id}|${q.spec.id}`))) await visit(n, q);
      }
    }
    for (const n of nodes) for (const id of n.carry.expire()) ev({ type: "drop", from: n.spec.id, bundleId: id, detail: "TTL expired" });
  }
  tNow = scenario.durationSec;

  return {
    scenario: scenario.name,
    seed,
    durationSec: scenario.durationSec,
    nodes: scenario.nodes.map((s) => ({ id: s.id, label: s.label, owner: s.owner, internet: s.internet, alive: true })),
    events,
    bundles,
    result: { delivered: [...validIds].filter((id) => anchorOnChain(anchorOf.get(id))).length, total: validIds.size, refused },
    net,
    validIds,
  };
}

// ---------------------------------------------------------------- scenarios for the demo and the tests
export const SCENARIOS: Record<string, () => Scenario> = {
  /** Three robots of three owners, none online at first; bundles hop A → B → C, C gets internet and submits all. */
  "three-owners": () => ({
    name: "three-owners",
    durationSec: 900,
    tickSec: 5,
    nodes: [
      { id: "alice-arm", label: "Alice's arm", owner: "Alice", internet: false },
      { id: "bob-arm", label: "Bob's arm", owner: "Bob", internet: false },
      { id: "carol-arm", label: "Carol's arm", owner: "Carol", internet: false },
      { id: "dave-phone", label: "Dave's phone (courier)", owner: "Dave", internet: true },
    ],
    links: [
      { a: "alice-arm", b: "bob-arm", from: 30, to: 250 },
      { a: "bob-arm", b: "carol-arm", from: 200, to: 450 },
      { a: "alice-arm", b: "carol-arm", from: 500, to: 560 },
      { a: "carol-arm", b: "dave-phone", from: 600, to: 720 },
    ],
    runs: [
      { node: "alice-arm", t: 20, outcome: "TRIPPED", severity: 3, incident: true },
      { node: "bob-arm", t: 40, outcome: "FAILSAFE", severity: 2, incident: true },
      { node: "alice-arm", t: 60, outcome: "DONE", severity: 0, incident: false },
      { node: "carol-arm", t: 100, outcome: "DONE", severity: 0, incident: false },
    ],
    internet: [
      { node: "carol-arm", t: 480, online: true },
      { node: "carol-arm", t: 700, online: false },
    ],
    deaths: [],
  }),
  /** Alice's arm records an incident, hands it to Bob's arm, then dies; Bob meets a courier with internet. */
  "origin-dies": () => ({
    name: "origin-dies",
    durationSec: 600,
    tickSec: 5,
    nodes: [
      { id: "alice-arm", label: "Alice's arm", owner: "Alice", internet: false },
      { id: "bob-arm", label: "Bob's arm", owner: "Bob", internet: false },
      { id: "erin-phone", label: "Erin's phone (courier)", owner: "Erin", internet: true },
    ],
    links: [
      { a: "alice-arm", b: "bob-arm", from: 20, to: 140 },
      { a: "bob-arm", b: "erin-phone", from: 300, to: 400 },
    ],
    runs: [
      { node: "alice-arm", t: 10, outcome: "TRIPPED", severity: 3, incident: true },
      { node: "alice-arm", t: 40, outcome: "ABORTED", severity: 1, incident: true },
    ],
    internet: [],
    deaths: [{ node: "alice-arm", t: 150 }],
  }),
  /** Mallory's arm edits what it forwards, forges a bundle and lies about deliveries; every hop refuses it. */
  tamperer: () => ({
    name: "tamperer",
    durationSec: 800,
    tickSec: 5,
    nodes: [
      { id: "alice-arm", label: "Alice's arm", owner: "Alice", internet: false },
      { id: "mallory-arm", label: "Mallory's arm (tampering)", owner: "Mallory", internet: false, tamper: true },
      { id: "bob-arm", label: "Bob's arm", owner: "Bob", internet: false },
    ],
    links: [
      { a: "alice-arm", b: "mallory-arm", from: 20, to: 200 },
      { a: "mallory-arm", b: "bob-arm", from: 100, to: 300 },
      { a: "alice-arm", b: "bob-arm", from: 400, to: 480 },
      { a: "mallory-arm", b: "bob-arm", from: 500, to: 560 },
    ],
    runs: [{ node: "alice-arm", t: 10, outcome: "TRIPPED", severity: 3, incident: true }],
    internet: [{ node: "bob-arm", t: 600, online: true }],
    deaths: [],
  }),
};

/** The public view (no FakeNet internals), cached per scenario+seed: the run is deterministic. */
const cache = new Map<string, Promise<MeshResult>>();
export function meshSimView(name: string, seed: number): Promise<MeshResult> | null {
  const make = SCENARIOS[name];
  if (!make) return null;
  const key = `${name}|${seed}`;
  let p = cache.get(key);
  if (!p) {
    p = runMeshSim(make(), seed).then(({ net: _n, validIds: _v, ...view }) => view);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
  }
  return p;
}

