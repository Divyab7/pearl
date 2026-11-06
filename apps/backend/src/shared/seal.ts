/**
 * Locking of episode logs and camera frames (owner decisions 5–6 Nov 2026, docs/DASHBOARD-PLAN.md §8).
 *
 *  - Every run gets its own random 256-bit RUN KEY. The device locks the canonical log and every camera frame with it
 *    (AES-256-GCM), so 0G Storage only ever holds locked files.
 *  - The run key itself is locked to ONE recipient's public key (ECDH P-256 → HKDF-SHA256 → AES-256-GCM, a fresh
 *    ephemeral key per wrap). The device wraps it for the robot's linked OWNER; when the owner files a claim, the
 *    owner's browser unwraps it and re-wraps it for the INSURER, for that one run only. The dashboard server only ever
 *    carries wrapped keys.
 *  - The sealed log keeps a small public header (run id, robot, head hash and the robot's signature, outcome, incident,
 *    severity, times): exactly what is already public on 0G Chain and Arkiv. The header is bound to the locked content
 *    as AES-GCM additional data, so changing a header field makes unlocking fail.
 *
 * Only WebCrypto (globalThis.crypto.subtle) is used, so the same file runs in the device program (Node) and in the
 * dashboard's browser pages. Spec: https://www.w3.org/TR/WebCryptoAPI/ (AES-GCM, ECDH, HKDF).
 */
import { canonicalize } from "./canonical.js";
import { sha256HexPure } from "./sha256.js";

const subtle = () => globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);
/** A copy backed by a plain ArrayBuffer (what WebCrypto's BufferSource type wants). */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytesWeb(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ---------------------------------------------------------------- run key: AES-256-GCM
export const newRunKey = () => randomBytesWeb(32);

const aesKey = (raw: Uint8Array) => subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export interface Locked {
  iv: string; // base64, 12 bytes
  data: string; // base64 ciphertext + 16-byte tag
}

export async function lockBytes(runKey: Uint8Array, plain: Uint8Array, aad?: Uint8Array): Promise<Locked> {
  const iv = randomBytesWeb(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), ...(aad ? { additionalData: buf(aad) } : {}) }, await aesKey(runKey), buf(plain));
  return { iv: b64(iv), data: b64(new Uint8Array(ct)) };
}

export async function unlockBytes(runKey: Uint8Array, l: Locked, aad?: Uint8Array): Promise<Uint8Array> {
  try {
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: buf(unb64(l.iv)), ...(aad ? { additionalData: buf(aad) } : {}) }, await aesKey(runKey), buf(unb64(l.data)));
    return new Uint8Array(pt);
  } catch {
    throw new Error("cannot unlock: wrong key, or the locked data or its header was changed");
  }
}

/** A locked camera frame on 0G Storage: the 12-byte IV followed by the AES-GCM ciphertext and tag. */
export async function lockFrame(runKey: Uint8Array, jpeg: Uint8Array): Promise<Uint8Array> {
  const l = await lockBytes(runKey, jpeg);
  const iv = unb64(l.iv);
  const ct = unb64(l.data);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

export async function unlockFrame(runKey: Uint8Array, locked: Uint8Array): Promise<Uint8Array> {
  return unlockBytes(runKey, { iv: b64(locked.subarray(0, 12)), data: b64(locked.subarray(12)) });
}

// ---------------------------------------------------------------- recipient keys: ECDH P-256
export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}
export interface PrivateJwk extends PublicJwk {
  d: string;
}

const pubOnly = (j: { kty?: string; crv?: string; x?: string; y?: string }): PublicJwk => {
  if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string") throw new Error("not a P-256 public key");
  return { kty: "EC", crv: "P-256", x: j.x, y: j.y };
};

export function isPublicJwk(j: unknown): j is PublicJwk {
  try {
    pubOnly(j as PublicJwk);
    return true;
  } catch {
    return false;
  }
}

/** Short, stable fingerprint of a public key (first 16 hex of sha256 over its canonical JWK). */
export function keyId(pub: PublicJwk): string {
  return sha256HexPure(canonicalize(pubOnly(pub))).slice(0, 16);
}

export async function newRecipientKey(): Promise<{ publicJwk: PublicJwk; privateJwk: PrivateJwk; kid: string }> {
  const kp = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const priv = (await subtle().exportKey("jwk", kp.privateKey)) as PrivateJwk;
  const publicJwk = pubOnly(priv);
  return { publicJwk, privateJwk: { ...publicJwk, d: priv.d }, kid: keyId(publicJwk) };
}

/** What a wrapped run key is bound to: the robot and the run. A wrap for one run cannot unlock another. */
export const runContext = (device: string, episodeId: string) => `pearl/run-key/v1|${device.toLowerCase()}|${episodeId}`;

export interface WrappedKey {
  v: 1;
  alg: "ECDH-ES-P256+HKDF-SHA256+A256GCM";
  kid: string; // recipient key fingerprint
  epk: PublicJwk; // ephemeral sender key
  context: string; // runContext(device, episodeId)
  iv: string;
  data: string;
}

async function wrapKeyFor(shared: ArrayBuffer, kid: string, context: string) {
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(utf8(kid)), info: buf(utf8(context)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapRunKey(runKey: Uint8Array, recipient: PublicJwk, context: string): Promise<WrappedKey> {
  const pub = pubOnly(recipient);
  const kid = keyId(pub);
  const eph = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const rKey = await subtle().importKey("jwk", pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: rKey }, eph.privateKey, 256);
  const k = await wrapKeyFor(shared, kid, context);
  const iv = randomBytesWeb(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8(context)) }, k, buf(runKey));
  const epk = pubOnly((await subtle().exportKey("jwk", eph.publicKey)) as PublicJwk);
  return { v: 1, alg: "ECDH-ES-P256+HKDF-SHA256+A256GCM", kid, epk, context, iv: b64(iv), data: b64(new Uint8Array(ct)) };
}

export async function unwrapRunKey(w: WrappedKey, privateJwk: PrivateJwk, expectedContext: string): Promise<Uint8Array> {
  if (w.context !== expectedContext) throw new Error("this key belongs to a different robot or run");
  if (w.kid !== keyId(privateJwk)) throw new Error("this run key was locked for a different key than yours");
  const priv = await subtle().importKey("jwk", { ...pubOnly(privateJwk), d: privateJwk.d }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = await subtle().importKey("jwk", pubOnly(w.epk), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: epk }, priv, 256);
  const k = await wrapKeyFor(shared, w.kid, w.context);
  try {
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: buf(unb64(w.iv)), additionalData: buf(utf8(w.context)) }, k, buf(unb64(w.data)));
    return new Uint8Array(pt);
  } catch {
    throw new Error("cannot unlock the run key with this private key");
  }
}

// ---------------------------------------------------------------- the sealed episode file
export interface SealedHeader {
  v: 1;
  type: "pearl.sealed-episode";
  episodeId: string;
  armId: string;
  /** The robot's address and its signature over headMessage(episodeId, headHash). */
  device: { address: string; signature: string };
  headHash: string;
  outcome: string;
  startedAt: string;
  endedAt: string;
  incident: boolean;
  severity: number;
  /** The zerobot command this run answers (already public on 0G Chain); null for local starts. */
  origin: { kind: "zerobot"; robotId: string; nonce: number } | null;
  /**
   * The run key wrapped for the robot's linked owner at the time of the run (only that owner's private key opens it).
   * It travels with the locked file, so the owner can unlock the run from 0G Storage alone, even if the robot is gone.
   * Bound to the locked data like every header field. Absent on runs made before an owner was linked.
   */
  keys?: WrappedKey[];
}

export interface SealedEpisode extends SealedHeader {
  cipher: { alg: "A256GCM" } & Locked;
}

export const headerOf = (s: SealedEpisode | SealedHeader): SealedHeader => {
  const { cipher: _c, ...h } = s as SealedEpisode;
  return h;
};
const headerAad = (h: SealedHeader) => utf8(canonicalize(headerOf(h)));

/** The exact bytes uploaded to 0G Storage (canonical JSON of the sealed file). */
export const sealedBytes = (s: SealedEpisode): Uint8Array => utf8(canonicalize(s));

export function parseSealed(bytes: Uint8Array | string): SealedEpisode {
  const s = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) as SealedEpisode;
  if (s?.type !== "pearl.sealed-episode" || s.v !== 1 || !s.cipher?.data) throw new Error("not a sealed Pearl episode");
  return s;
}

/** Plain log fields the header needs; the log type lives in types.ts (kept loose so the browser needs nothing else). */
interface LogLike {
  episodeId: string;
  armId: string;
  headHash: string;
  outcome: string;
  startedAt: string;
  endedAt: string;
  device?: { address: string; signature: string };
}

export async function sealEpisode(
  log: LogLike,
  runKey: Uint8Array,
  labels: { incident: boolean; severity: number; origin: SealedHeader["origin"]; keys?: WrappedKey[] },
): Promise<SealedEpisode> {
  if (!log.device) throw new Error("only a device-signed log can be sealed");
  const header: SealedHeader = {
    v: 1, type: "pearl.sealed-episode", episodeId: log.episodeId, armId: log.armId, device: log.device, headHash: log.headHash,
    outcome: log.outcome, startedAt: log.startedAt, endedAt: log.endedAt, incident: labels.incident, severity: labels.severity,
    origin: labels.origin, ...(labels.keys && labels.keys.length ? { keys: labels.keys } : {}),
  };
  const cipher = await lockBytes(runKey, utf8(canonicalize(log)), headerAad(header));
  return { ...header, cipher: { alg: "A256GCM", ...cipher } };
}

/** Unlocks a sealed file; the unlocked log must name the same run and head as its public header. */
export async function openEpisode<T extends LogLike>(s: SealedEpisode, runKey: Uint8Array): Promise<T> {
  const plain = await unlockBytes(runKey, s.cipher, headerAad(s));
  const log = JSON.parse(new TextDecoder().decode(plain)) as T;
  if (log.episodeId !== s.episodeId) throw new Error("the unlocked log names a different run than its header");
  return log;
}
