// Courier: carry a robot's sealed bundles to 0G and Arkiv when the robot has no internet (offline relay spec v1).
// Pure logic, no React: Bluetooth client (§4), bundle and ping checks (§1, §5), and a carry queue in IndexedDB that
// submits to the laptop relay (§3) whenever this browser is online. Nothing here needs a key: the bundle is signed by
// the robot, its file is locked, and every transaction is pre-signed by the robot's own key.
import { keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress, type Hex } from "viem";
import { b64, canonicalize, sha256HexPure, unb64 } from "./core";

// ---------------------------------------------------------------------------------------------------------------------
// Types (§1, §3, §4, §5)

export interface BundleFile { role: string; idx?: number; root: string; size: number; data: string }
export interface BundleTx { chain: string; chainId: number; purpose: string; nonce: number; hash: string; raw: string; file?: number }
export interface Bundle {
  v: 1;
  type: "pearl.bundle";
  episodeId: string;
  device: string;
  createdAt: string;
  summary: { outcome: string; incident: boolean; severity: number; headHash: string; rootHash: string };
  files: BundleFile[];
  txs: BundleTx[];
  sig: string;
}
export interface PendingEntry { bundleId: string; episodeId: string; size: number; severity: number; outcome: string }
export interface RobotInfo { v: number; device: string; deviceId?: string; pending: PendingEntry[]; carrying?: number; delivered?: number }
/** One bundle a mesh node can serve (§7 "LIST"): its own, or one it carries for another robot. */
export interface ServeEntry { bundleId: string; origin: string; episodeId: string; size: number; severity: number; outcome: string; hops: number; own: boolean }
/** A delivery the node has heard of (§7 "RECEIPTS"). */
export interface Receipt { bundleId: string; anchorTx: string; chainId: number }
export interface Ping { v: number; device: string; episodeId: string; outcome: string; severity: number; headHash: string; ts: number; sig: string }
export interface RelayStep { purpose: string; txHash?: string | null; status: string; error?: string | null }
export interface RelayStatus { bundleId: string; episodeId?: string; device?: string; state: string; steps: RelayStep[]; updatedAt?: string }

export const SERVICE = "5b0e0001-7c2a-4f8e-9a51-70ea21c0b10c";
const uuid = (n: number) => `5b0e000${n}-7c2a-4f8e-9a51-70ea21c0b10c`;
export const CHAR = { info: uuid(2), ping: uuid(3), select: uuid(4), data: uuid(5), ack: uuid(6), pings: uuid(7) } as const;
export const NAME_PREFIX = "Pearl-";

/** Chains a bundle may target, by chainId (§1: relayers reject unexpected chain ids). */
export const CHAINS: Record<number, string> = { 16602: "0g-galileo", 7794095: "arkiv-rabdi" };

const enc = new TextEncoder();
const dec = new TextDecoder();
const flags = new URLSearchParams(location.search);
/** Development only: `?fakeRobot` simulates the robot's Bluetooth service in memory (`?fakeRobot=drop` also drops
 *  the link once mid-download); `?fakeRelay` simulates the laptop relay (`?fakeRelay=down` makes it unreachable). */
export const FAKE_ROBOT = flags.has("fakeRobot");
export const FAKE_RELAY = flags.has("fakeRelay");

// ---------------------------------------------------------------------------------------------------------------------
// Checks (§1, §5)

export interface Check { name: string; ok: boolean; detail: string }
export interface BundleCheck { bundleId: string; ok: boolean; checks: Check[] }

/** bundleId = 0x + sha256(canonical JSON of the bundle without `sig`). */
export function bundleIdOf(b: Bundle): string {
  const { sig: _sig, ...rest } = b;
  return `0x${sha256HexPure(canonicalize(rest))}`;
}

const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Everything the browser can check without the network: the robot's signature, that every transaction is the
 *  robot's own and for an expected chain, and that every file is the size it claims. (The relay also recomputes each
 *  file's 0G Storage root before sending anything.) */
export async function checkBundle(b: Bundle, expectedId?: string): Promise<BundleCheck> {
  const checks: Check[] = [];
  let bundleId = "";
  try {
    if (b?.v !== 1 || b?.type !== "pearl.bundle") throw new Error("not a Pearl bundle");
    bundleId = bundleIdOf(b);
    checks.push({ name: "Fingerprint", ok: !expectedId || sameAddr(expectedId, bundleId), detail: expectedId && !sameAddr(expectedId, bundleId) ? "differs from what the robot announced" : "matches what the robot announced" });
  } catch (e: any) {
    return { bundleId, ok: false, checks: [{ name: "Format", ok: false, detail: e.message }] };
  }
  try {
    const who = await recoverMessageAddress({ message: `pearl/bundle/v1|${bundleId}`, signature: b.sig as Hex });
    checks.push({ name: "Signed by the robot", ok: sameAddr(who, b.device), detail: sameAddr(who, b.device) ? "the robot's key signed it" : "signed by a different key" });
  } catch {
    checks.push({ name: "Signed by the robot", ok: false, detail: "signature unreadable" });
  }
  const txProblems: string[] = [];
  for (const [i, t] of (b.txs ?? []).entries()) {
    try {
      const raw = t.raw as Hex;
      const p = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as any });
      if (!sameAddr(from, b.device)) txProblems.push(`transaction ${i + 1} is not from the robot`);
      if (!CHAINS[t.chainId] || p.chainId !== t.chainId) txProblems.push(`transaction ${i + 1} is for an unexpected network`);
      if (p.nonce !== t.nonce) txProblems.push(`transaction ${i + 1} has a different order number`);
      if (keccak256(raw).toLowerCase() !== t.hash?.toLowerCase()) txProblems.push(`transaction ${i + 1} has a different id`);
      if (t.purpose.startsWith("storage:") && !(t.file !== undefined && b.files[t.file])) txProblems.push(`transaction ${i + 1} points at a missing file`);
    } catch {
      txProblems.push(`transaction ${i + 1} is unreadable`);
    }
  }
  checks.push({ name: "Transactions are the robot's own", ok: b.txs?.length > 0 && txProblems.length === 0, detail: txProblems.length ? txProblems.join("; ") : `${b.txs?.length ?? 0} pre-signed by the robot` });
  const fileProblems = (b.files ?? []).flatMap((f, i) => {
    try {
      return unb64(f.data).length === f.size ? [] : [`file ${i + 1} is not the size it claims`];
    } catch {
      return [`file ${i + 1} is unreadable`];
    }
  });
  checks.push({ name: "Files complete", ok: fileProblems.length === 0, detail: fileProblems.length ? fileProblems.join("; ") : `${b.files?.length ?? 0} locked ${b.files?.length === 1 ? "file" : "files"}` });
  return { bundleId, ok: checks.every((c) => c.ok), checks };
}

export const pingMessage = (p: Omit<Ping, "sig" | "v">) =>
  `pearl/ping/v1|${p.device.toLowerCase()}|${p.episodeId}|${p.outcome}|${p.severity}|${p.headHash}|${p.ts}`;

/** True when the ping's signature recovers to the device it names. */
export async function checkPing(p: Ping): Promise<boolean> {
  try {
    const who = await recoverMessageAddress({ message: pingMessage(p), signature: p.sig as Hex });
    return sameAddr(who, p.device);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Bluetooth (§4)

export type Support = { ok: true } | { ok: false; why: "insecure" | "unsupported" | "adapter-off" };

export async function bluetoothSupport(): Promise<Support> {
  if (FAKE_ROBOT) return { ok: true };
  if (!window.isSecureContext) return { ok: false, why: "insecure" };
  const bt = (navigator as any).bluetooth;
  if (!bt?.requestDevice) return { ok: false, why: "unsupported" };
  try {
    if (bt.getAvailability && !(await bt.getAvailability())) return { ok: false, why: "adapter-off" };
  } catch {
    /* availability unknown: let requestDevice decide */
  }
  return { ok: true };
}

/** A courier-side failure with a reason the page can explain. */
export class CourierError extends Error {
  constructor(readonly kind: "cancelled" | "denied" | "out-of-range" | "protocol" | "invalid", message: string) {
    super(message);
  }
}

function asCourierError(e: any): CourierError {
  if (e instanceof CourierError) return e;
  const n = e?.name;
  if (n === "NotFoundError") return new CourierError("cancelled", e.message);
  if (n === "SecurityError" || n === "NotAllowedError") return new CourierError("denied", e.message);
  if (n === "NetworkError" || /disconnect|GATT|connection/i.test(e?.message ?? "")) return new CourierError("out-of-range", e?.message ?? "lost the robot");
  return new CourierError("protocol", e?.message ?? String(e));
}

/** One robot reached over Bluetooth (or the in-memory fake). */
export interface RobotLink {
  name: string;
  connected(): boolean;
  info(): Promise<RobotInfo>;
  ping(): Promise<Ping | null>;
  /** Recent pings this robot heard from any robot (§7 `pings`); unchecked as read. */
  pings(): Promise<Ping[]>;
  /** Downloads one bundle's JSON bytes (or, with "LIST"/"RECEIPTS" as the id, that listing); resumes from what it already has after a dropped link. */
  download(bundleId: string, size: number, onProgress: (got: number, total: number) => void): Promise<Uint8Array>;
  ack(msg: { bundleId: string; state: string; steps?: RelayStep[] }): Promise<void>;
  onDisconnect(cb: () => void): void;
  onPing(cb: (p: Ping) => void): void;
  disconnect(): void;
}

const partial = new Map<string, Uint8Array[]>(); // bytes already downloaded per bundleId, survives a dropped link
const joined = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const parseJson = (b: Uint8Array | DataView) => {
  const s = dec.decode(b).replace(/\0+$/, "").trim();
  return s ? JSON.parse(s) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared select/data loop: write "<id> <offset>", read until an empty read; on a dropped link reconnect and resume. */
async function downloadWith(
  io: { select(s: string): Promise<void>; read(): Promise<Uint8Array>; reconnect(): Promise<void> },
  bundleId: string,
  size: number,
  onProgress: (got: number, total: number) => void,
): Promise<Uint8Array> {
  if (bundleId === "LIST" || bundleId === "RECEIPTS") partial.delete(bundleId); // listings are always read fresh
  const parts = partial.get(bundleId) ?? [];
  partial.set(bundleId, parts);
  let got = parts.reduce((n, p) => n + p.length, 0);
  let retries = 0;
  onProgress(got, size);
  await io.select(`${bundleId} ${got}`);
  for (;;) {
    try {
      const chunk = await io.read();
      if (chunk.length === 0) break;
      parts.push(chunk);
      got += chunk.length;
      retries = 0;
      onProgress(got, Math.max(size, got));
    } catch (e) {
      if (++retries > 3) throw asCourierError(e);
      await sleep(600 * retries);
      try {
        await io.reconnect();
        await io.select(`${bundleId} ${got}`);
      } catch {
        /* try again on the next round */
      }
    }
  }
  partial.delete(bundleId);
  return joined(parts);
}

const ackBytes = (msg: { bundleId: string; state: string; steps?: RelayStep[] }) => {
  const full = enc.encode(JSON.stringify(msg));
  return full.length <= 512 ? full : enc.encode(JSON.stringify({ bundleId: msg.bundleId, state: msg.state }));
};

/** Opens the browser's Bluetooth chooser for nearby Pearl robots and connects. */
export async function findRobot(): Promise<RobotLink> {
  if (FAKE_ROBOT) return fakeRobot();
  const bt = (navigator as any).bluetooth;
  let device: any;
  try {
    device = await bt.requestDevice({ filters: [{ services: [SERVICE] }, { namePrefix: NAME_PREFIX }], optionalServices: [SERVICE] });
  } catch (e) {
    throw asCourierError(e);
  }
  let chars: Record<keyof typeof CHAR, any> = {} as any;
  const connect = async () => {
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const entries = await Promise.all(Object.entries(CHAR).map(async ([k, u]) => [k, await svc.getCharacteristic(u).catch(() => null)] as const));
    chars = Object.fromEntries(entries) as any;
    if (!chars.info || !chars.select || !chars.data) throw new CourierError("protocol", "This device does not offer Pearl's courier service.");
  };
  try {
    await connect();
  } catch (e) {
    throw asCourierError(e);
  }
  const write = (c: any, bytes: Uint8Array) => (c.writeValueWithResponse ? c.writeValueWithResponse(bytes) : c.writeValue(bytes));
  const read = async (c: any) => {
    const v: DataView = await c.readValue();
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  };
  return {
    name: device.name ?? "Pearl robot",
    connected: () => !!device.gatt?.connected,
    info: async () => {
      try {
        return parseJson(await read(chars.info)) as RobotInfo;
      } catch (e) {
        throw asCourierError(e);
      }
    },
    ping: async () => {
      if (!chars.ping) return null;
      try {
        return parseJson(await read(chars.ping)) as Ping | null;
      } catch {
        return null;
      }
    },
    pings: async () => {
      if (!chars.pings) return [];
      try {
        const v = parseJson(await read(chars.pings));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    download: (id, size, onProgress) =>
      downloadWith({ select: (s) => write(chars.select, enc.encode(s)), read: () => read(chars.data), reconnect: connect }, id, size, onProgress),
    ack: async (msg) => {
      if (!device.gatt?.connected || !chars.ack) return;
      await write(chars.ack, ackBytes(msg)).catch(() => {});
    },
    onDisconnect: (cb) => device.addEventListener("gattserverdisconnected", cb),
    onPing: (cb) => {
      chars.ping?.startNotifications?.().then(() => {
        chars.ping.addEventListener("characteristicvaluechanged", (e: any) => {
          try {
            const p = parseJson(e.target.value);
            if (p) cb(p);
          } catch {
            /* ignore a malformed notification */
          }
        });
      }).catch(() => {});
    },
    disconnect: () => device.gatt?.disconnect(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Carry queue (IndexedDB, no dependency) and relay client (§3)

export type CarryState = "carrying" | "sending" | "done" | "failed" | "stale";
export interface Carried {
  bundleId: string;
  episodeId: string;
  device: string;
  outcome: string;
  severity: number;
  size: number;
  json: string;
  from: string;
  collectedAt: string;
  state: CarryState;
  relay?: RelayStatus | null;
  note?: string | null;
  updatedAt: string;
  /** Collected from the practice robot: only listed and sent while the page is in practice mode. */
  practice?: boolean;
}

const DB = "pearl-courier";
const STORE = "bundles";
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "bundleId" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = f(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export const changes = new EventTarget();
const changed = () => changes.dispatchEvent(new Event("change"));

/** Everything this device carries (practice-robot items only in practice mode, real ones only otherwise). */
export async function listCarried(): Promise<Carried[]> {
  const all = (await tx<Carried[]>("readonly", (s) => s.getAll())).filter((c) => !!c.practice === FAKE_ROBOT);
  return all.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
}
async function getCarried(id: string) {
  return tx<Carried | undefined>("readonly", (s) => s.get(id));
}
async function putCarried(c: Carried) {
  await tx("readwrite", (s) => s.put(c));
  changed();
}
async function patch(id: string, p: Partial<Carried>) {
  const c = await getCarried(id);
  if (c) await putCarried({ ...c, ...p, updatedAt: new Date().toISOString() });
}
export async function forget(id: string) {
  await tx("readwrite", (s) => s.delete(id));
  changed();
}

/** Keeps a checked bundle on this device, then tries to deliver it right away. */
export async function carry(bundle: Bundle, json: string, bundleId: string, from: string, link?: RobotLink | null) {
  const existing = await getCarried(bundleId);
  if (!existing) {
    const now = new Date().toISOString();
    await putCarried({
      bundleId, episodeId: bundle.episodeId, device: bundle.device, outcome: bundle.summary?.outcome, severity: bundle.summary?.severity,
      size: enc.encode(json).length, json, from, collectedAt: now, state: "carrying", updatedAt: now, practice: FAKE_ROBOT,
    });
  }
  if (link) acks.set(bundleId, link);
  void deliver(bundleId);
}

const TERMINAL = new Set(["done", "failed", "stale"]);
const acks = new Map<string, RobotLink>(); // robots to tell once a bundle settles, while still connected
const inflight = new Set<string>();

export class RelayUnreachable extends Error {}
/** The relay has no record of a bundle it was given (e.g. its storage was wiped): send it again. */
class RelayForgot extends Error {}

/** Laptop relay client; the fake keeps state in memory for development. */
export const relay = {
  async submit(json: string): Promise<{ bundleId: string; state: string }> {
    if (FAKE_RELAY) return fakeRelay.submit(json);
    let r: Response;
    try {
      r = await fetch("/api/relay/bundle", { method: "POST", headers: { "content-type": "application/json" }, body: json });
    } catch {
      throw new RelayUnreachable("relay unreachable");
    }
    const out = await r.json().catch(() => ({}));
    if (r.status >= 500 || r.status === 404) throw new RelayUnreachable(out.error ?? `HTTP ${r.status}`);
    if (!r.ok) throw Object.assign(new Error(out.error ?? `HTTP ${r.status}`), { status: r.status });
    return out;
  },
  async status(id: string): Promise<RelayStatus> {
    if (FAKE_RELAY) return fakeRelay.status(id);
    let r: Response;
    try {
      r = await fetch(`/api/relay/bundles/${encodeURIComponent(id)}`);
    } catch {
      throw new RelayUnreachable("relay unreachable");
    }
    if (r.status === 404) throw new RelayForgot(id);
    if (!r.ok) throw new RelayUnreachable(`HTTP ${r.status}`);
    return r.json();
  },
  async list(): Promise<RelayStatus[]> {
    if (FAKE_RELAY) return fakeRelay.list();
    const r = await fetch("/api/relay/bundles");
    if (!r.ok) throw new RelayUnreachable(`HTTP ${r.status}`);
    const body = await r.json();
    return Array.isArray(body) ? body : body.items ?? body.bundles ?? [];
  },
};

/** Submits one carried bundle and follows it until the relay settles it. Safe to call repeatedly. */
export async function deliver(id: string): Promise<void> {
  if (inflight.has(id)) return;
  inflight.add(id);
  let again = false;
  try {
    const c = await getCarried(id);
    if (!c || TERMINAL.has(c.state) || !!c.practice !== FAKE_ROBOT) return;
    if (c.state === "carrying") {
      try {
        const r = await relay.submit(c.json);
        await patch(id, { state: "sending", note: null, relay: { bundleId: id, state: r.state, steps: [] } });
        await acks.get(id)?.ack({ bundleId: id, state: r.state });
      } catch (e: any) {
        if (e instanceof RelayUnreachable) await patch(id, { note: "offline" });
        else await patch(id, { state: "failed", note: e.message });
        return;
      }
    }
    for (let misses = 0; misses < 30;) {
      let s: RelayStatus;
      try {
        s = await relay.status(id);
        misses = 0;
      } catch (e) {
        if (e instanceof RelayForgot) {
          await patch(id, { state: "carrying" });
          again = true;
          return;
        }
        misses++;
        await sleep(4000);
        continue;
      }
      const state: CarryState = TERMINAL.has(s.state) ? (s.state as CarryState) : "sending";
      await patch(id, { relay: s, state, note: null });
      if (TERMINAL.has(s.state)) {
        await acks.get(id)?.ack({ bundleId: id, state: s.state, steps: s.steps });
        acks.delete(id);
        return;
      }
      await sleep(2000);
    }
  } finally {
    inflight.delete(id);
  }
  if (again) return deliver(id);
}

/** Delivers everything still being carried. */
export async function deliverAll() {
  const all = await listCarried().catch(() => [] as Carried[]);
  await Promise.all(all.filter((c) => !TERMINAL.has(c.state)).map((c) => deliver(c.bundleId)));
}

let started = false;
/** Starts the background carrier once: on page load, whenever the browser comes back online, and every 30 s. */
export function startCarrier() {
  if (started) return;
  started = true;
  addEventListener("online", () => void deliverAll());
  void deliverAll();
  setInterval(() => {
    if (navigator.onLine) void deliverAll();
  }, 30_000);
}

/** Everything a robot can serve: own outbox and bundles it carries for others (§7 LIST). A robot without mesh
 *  support answers LIST with nothing or an error; its own pending list from `info` is used then. */
export async function listServable(link: RobotLink, info: RobotInfo): Promise<ServeEntry[]> {
  const own = (): ServeEntry[] => info.pending.map((p) => ({ ...p, origin: info.device, hops: 0, own: true }));
  try {
    const v = parseJson(await link.download("LIST", 0, () => {}));
    if (!Array.isArray(v) || (v.length === 0 && info.pending.length > 0)) return own();
    return (v as ServeEntry[]).sort((a, b) => b.severity - a.severity || Number(b.own) - Number(a.own));
  } catch {
    return own();
  }
}

/** Deliveries the robot has heard of (§7 RECEIPTS); empty when it has none or does not support them. */
export async function readReceipts(link: RobotLink): Promise<Receipt[]> {
  try {
    const v = parseJson(await link.download("RECEIPTS", 0, () => {}));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface HeardPing { p: Ping; ok: boolean }
/** Checks each gossiped ping; newest first, one per run. */
export async function checkPings(list: Ping[]): Promise<HeardPing[]> {
  const seen = new Set<string>();
  const out: HeardPing[] = [];
  for (const p of [...list].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
    const k = `${p.device?.toLowerCase()}|${p.episodeId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ p, ok: await checkPing(p) });
  }
  return out;
}

/** Collects one bundle from a robot (its own or one it carries): download, parse, check, then carry it. */
export async function collect(link: RobotLink, p: PendingEntry & { origin?: string; hops?: number }, onProgress: (got: number, total: number) => void): Promise<BundleCheck> {
  const bytes = await link.download(p.bundleId, p.size, onProgress);
  let bundle: Bundle;
  const json = dec.decode(bytes);
  try {
    bundle = JSON.parse(json);
  } catch {
    throw new CourierError("invalid", "The record arrived incomplete. Try collecting it again.");
  }
  const check = await checkBundle(bundle, p.bundleId);
  if (p.origin && !sameAddr(p.origin, bundle.device)) {
    check.ok = false;
    check.checks.push({ name: "From the robot listed", ok: false, detail: "made by a different robot than announced" });
  }
  if (check.ok) await carry(bundle, json, check.bundleId, link.name, link);
  return check;
}

/** Relay step → the three public records a run ends up in. */
export function stepGroup(purpose: string): "storage" | "anchor" | "arkiv" {
  return purpose.startsWith("storage") ? "storage" : purpose === "arkiv" ? "arkiv" : "anchor";
}
export function stepDone(status: string) {
  return /^(done|ok|success|confirmed|mined|finalized|already)/i.test(status);
}
export function stepFailed(status: string) {
  return /^(fail|error|stale|reverted)/i.test(status);
}

// ---------------------------------------------------------------------------------------------------------------------
// Development fakes (only with ?fakeRobot / ?fakeRelay)

// A throwaway key that only signs the fake robot's sample bundle; it holds nothing and is never used on a real robot.
const FAKE_KEY = "0x8d3c1e1a6f2b4d5e9c7a0b1f2e3d4c5b6a79881726354453627180918a7b6c5d" as const;
// A second practice robot (another owner) whose bundle the first one carries; a third whose ping is forged.
const FAKE_KEY_2 = "0x3b9f0c6e2a417d58c1e09b7a6f5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3" as const;
const FAKE_KEY_3 = "0x5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b" as const;

type Sample = { bundle: Bundle; json: string; id: string; own: boolean; hops: number };
async function sampleBundles(): Promise<Sample[]> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const runs = [
    { key: FAKE_KEY, episodeId: "ep_20261106093012_c4e1", outcome: "TRIPPED", incident: true, severity: 2, nonce: 41, ark: 7, frames: 3, hops: 0 },
    { key: FAKE_KEY, episodeId: "ep_20261106095540_1a9f", outcome: "DONE", incident: false, severity: 0, nonce: 46, ark: 8, frames: 1, hops: 0 },
    { key: FAKE_KEY_2, episodeId: "ep_20261106081205_7d02", outcome: "TRIPPED", incident: true, severity: 3, nonce: 12, ark: 3, frames: 2, hops: 1 },
  ];
  const out: Sample[] = [];
  for (const r of runs) {
    const acct = privateKeyToAccount(r.key);
    const fileBytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17) & 0xff);
    const files: BundleFile[] = [{ role: "log", root: "", size: 8700, data: "" }, ...Array.from({ length: r.frames }, (_, i) => ({ role: "frame", idx: 3 + i * 4, root: "", size: 6000, data: "" }))];
    for (const [i, f] of files.entries()) {
      const bytes = fileBytes(f.size, i + r.nonce);
      f.data = b64(bytes);
      f.root = `0x${sha256HexPure(bytes)}`;
    }
    const mk = async (chainId: number, nonce: number, purpose: string, file?: number) => {
      const raw = await acct.signTransaction({
        type: "eip1559", chainId, nonce, gas: 300000n, maxFeePerGas: 12_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n,
        to: "0x000000000000000000000000000000000000dEaD", value: 0n, data: "0x",
      });
      return { chain: CHAINS[chainId], chainId, purpose, nonce, hash: keccak256(raw), raw, ...(file !== undefined ? { file } : {}) } as BundleTx;
    };
    const txs: BundleTx[] = [];
    let n = r.nonce;
    for (const [i, f] of files.entries()) txs.push(await mk(16602, n++, f.role === "log" ? "storage:log" : `storage:frame:${f.idx}`, i));
    txs.push(await mk(16602, n++, "anchor"));
    txs.push(await mk(7794095, r.ark, "arkiv"));
    const unsigned = {
      v: 1 as const, type: "pearl.bundle" as const, episodeId: r.episodeId, device: acct.address, createdAt: new Date(Date.parse("2026-11-06T09:30:12Z") + r.nonce * 60_000).toISOString(),
      summary: { outcome: r.outcome, incident: r.incident, severity: r.severity, headHash: `0x${sha256HexPure(`head-${r.episodeId}`)}`, rootHash: files[0].root },
      files, txs,
    };
    const id = `0x${sha256HexPure(canonicalize(unsigned))}`;
    const bundle: Bundle = { ...unsigned, sig: await acct.signMessage({ message: `pearl/bundle/v1|${id}` }) };
    out.push({ bundle, json: canonicalize(bundle), id, own: r.key === FAKE_KEY, hops: r.hops });
  }
  return out;
}

async function fakeRobot(): Promise<RobotLink> {
  await sleep(500);
  const samples = await sampleBundles();
  const { privateKeyToAccount } = await import("viem/accounts");
  const acct = privateKeyToAccount(FAKE_KEY);
  const signPing = async (key: Hex, b: Bundle, ts: number, signer: Hex = key): Promise<Ping> => {
    const body = { v: 1, device: privateKeyToAccount(key).address, episodeId: b.episodeId, outcome: b.summary.outcome, severity: b.summary.severity, headHash: b.summary.headHash, ts };
    return { ...body, sig: await privateKeyToAccount(signer).signMessage({ message: pingMessage(body) }) };
  };
  const ping = await signPing(FAKE_KEY, samples[0].bundle, Date.parse("2026-11-06T09:31:40Z"));
  const forged = { ...samples[2].bundle, episodeId: "ep_20261106090044_e5b8", summary: { ...samples[2].bundle.summary, severity: 3 } };
  const heard: Ping[] = [
    ping,
    await signPing(FAKE_KEY_2, samples[2].bundle, Date.parse("2026-11-06T08:12:51Z")),
    await signPing(FAKE_KEY_3, forged, Date.parse("2026-11-06T09:00:44Z"), FAKE_KEY), // claims robot 3, signed by another key
  ];
  const listing = samples.map((s) => ({
    bundleId: s.id, origin: s.bundle.device, episodeId: s.bundle.episodeId, size: enc.encode(s.json).length,
    severity: s.bundle.summary.severity, outcome: s.bundle.summary.outcome, hops: s.hops, own: s.own,
  }));
  const receipts: Receipt[] = [{ bundleId: `0x${sha256HexPure("delivered-by-a-phone")}`, anchorTx: `0x${sha256HexPure("anchor-tx")}`, chainId: 16602 }];
  let connected = true;
  let dropOnce = flags.get("fakeRobot") === "drop";
  let sel: { bytes: Uint8Array; off: number } | null = null;
  const disc: (() => void)[] = [];
  return {
    name: `Pearl-${acct.address.slice(-4)}`,
    connected: () => connected,
    info: async () => ({
      v: 1, device: acct.address, deviceId: "pearl-arm-01", carrying: listing.filter((l) => !l.own).length, delivered: receipts.length,
      pending: listing.filter((l) => l.own).map(({ bundleId, episodeId, size, severity, outcome }) => ({ bundleId, episodeId, size, severity, outcome })),
    }),
    ping: async () => ping,
    pings: async () => heard,
    download: (id, size, onProgress) =>
      downloadWith({
        select: async (s) => {
          const [bid, off] = s.split(" ");
          const body = bid === "LIST" ? JSON.stringify(listing) : bid === "RECEIPTS" ? JSON.stringify(receipts) : samples.find((x) => x.id === bid)?.json;
          if (body === undefined) throw new CourierError("protocol", "unknown bundle");
          sel = { bytes: enc.encode(body), off: Number(off) };
        },
        read: async () => {
          await sleep(12);
          if (!connected || !sel) throw Object.assign(new Error("GATT Server is disconnected."), { name: "NetworkError" });
          if (dropOnce && sel.bytes.length > 4096 && sel.off > sel.bytes.length / 2) {
            dropOnce = false;
            connected = false;
            throw Object.assign(new Error("GATT Server is disconnected."), { name: "NetworkError" });
          }
          const chunk = sel.bytes.slice(sel.off, sel.off + 512);
          sel.off += chunk.length;
          return chunk;
        },
        reconnect: async () => {
          await sleep(300);
          connected = true;
        },
      }, id, size, onProgress),
    ack: async (msg) => console.info("[fake robot] ack", msg),
    onDisconnect: (cb) => disc.push(cb),
    onPing: () => {},
    disconnect: () => {
      connected = false;
      disc.forEach((f) => f());
    },
  };
}

const fakeRelay = (() => {
  const mem = new Map<string, { started: number; b: Bundle }>();
  const down = () => flags.get("fakeRelay") === "down";
  const status = (id: string): RelayStatus => {
    const m = mem.get(id);
    if (!m) throw new RelayForgot(id);
    const t = (Date.now() - m.started) / 900; // one step per ~0.9 s
    const steps = m.b.txs.map((x, i) => ({ purpose: x.purpose, txHash: i < t ? x.hash : null, status: i + 1 < t ? "done" : i < t ? "submitted" : "pending" }));
    const done = t > m.b.txs.length + 1;
    return { bundleId: id, episodeId: m.b.episodeId, device: m.b.device, state: done ? "done" : "submitting", steps, updatedAt: new Date().toISOString() };
  };
  return {
    async submit(json: string) {
      await sleep(200);
      if (down() || !navigator.onLine) throw new RelayUnreachable("relay unreachable");
      const b = JSON.parse(json) as Bundle;
      const id = bundleIdOf(b);
      if (!mem.has(id)) mem.set(id, { started: Date.now(), b });
      return { bundleId: id, state: "received" };
    },
    async status(id: string) {
      if (down()) throw new RelayUnreachable("relay unreachable");
      return status(id);
    },
    async list() {
      if (down()) throw new RelayUnreachable("relay unreachable");
      return [...mem.keys()].map((id) => status(id));
    },
  };
})();
