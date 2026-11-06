/**
 * pnpm fw:vectors — writes firmware/esp32-arm/test/host/vectors.json from the REAL TypeScript code, so the firmware's
 * portable core (canonical JSON, number formatting, hashes, signatures, locking) is tested byte-for-byte against what
 * the verifier and the dashboard compute. Deterministic: fixed keys and inputs only.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { canonicalize } from "../shared/canonical.js";
import { sha256Hex } from "../shared/hash.js";
import { REPO_ROOT } from "../shared/env.js";
import { b64, lockFrame, newRecipientKey, runContext, sealEpisode, wrapRunKey } from "../shared/seal.js";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { headMessage } from "../shared/deviceKey.js";

const f64hex = (x: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString("hex");
};

// numbers: JS formatting of exact doubles (given as IEEE-754 bits so the C++ side reads them exactly)
const nums = [
  0.94, 0.88, 0.1, 0.2, 0.3, 1.01, 2.7, 1.8, 0.6, 0.123456789012345678, 1 / 3, 2 / 3, 100, 1e21, 1e20, 123456789012345680000,
  1e-6, 1e-7, 1.5e-7, 5e-324, 1.7976931348623157e308, -0.5, -1e-9, 3.14159, 299792.458, 1234.5678, 9007199254740993,
  0.000001234, 12e-8, 4.35, 0.07, 1.23e25, -2.5e-12,
];
for (let i = 0; i < 200; i++) {
  // reproducible pseudo-random doubles across many magnitudes
  const m = Math.sin(i * 12.9898) * 43758.5453;
  const frac = m - Math.floor(m);
  nums.push(frac * 10 ** ((i % 40) - 20));
}
const numbers = nums.map((x) => ({ bits: f64hex(x), js: JSON.stringify(x) }));

// parsing: the text a model might send → what JSON.parse + JSON.stringify gives
const parseTexts = ["0.94", "0.9", "0.88", "1.01", "2.7", "0.123456789", "1e-7", "12.5", "0.30000000000000004", "1.7976931348623157e308", "3", "-0", "0.6", "0.95", "0.99", "0.85", "0.75"];
const parse = parseTexts.map((t) => ({ text: t, js: JSON.stringify(JSON.parse(t)) }));

// canonical JSON of record-like values
const records: unknown[] = [
  { v: 2, kind: "event", episodeId: "ep_1", idx: 0, ts: "2026-11-06T05:10:00.000Z", ev: "episode_start", data: { task: { task: "pick", color: "red", from: "A2", to: "BIN" }, deviceState: "IDLE", armConfigHash: "a".repeat(64) }, prevHash: "0".repeat(64) },
  { b: 1, a: [true, false, null, 0.94, -3, "x\"y\\z\n\t\u0001é→✓"], c: { z: 1, y: { "": 0, A: 2, a: 1 } } },
  { parsed: { action: "PICK", slot: "A2", reason: "Red cube clearly visible at slot A2; path to the bin is clear.", confidence: 0.94 }, policy: "CONTINUE → carry to BIN", commandsSent: ["move:[90,100,80,10]", "grip:close"], telemetry: { state: "WAITING", joints: [90, 92, 88, 10], tofMm: 612, accG: 1.01 } },
];
const canon = records.map((r) => ({ json: JSON.stringify(r), canonical: canonicalize(r), sha256: sha256Hex(canonicalize(r)) }));

// hashes
const hashInputs = ["", "abc", "a".repeat(135), "a".repeat(136), "a".repeat(137), "a".repeat(1000), "Pearl episode ep_1 head " + "f".repeat(64)];
const hashes = hashInputs.map((s) => ({
  text: s,
  sha256: sha256Hex(s),
  keccak256: ethers.keccak256(ethers.toUtf8Bytes(s)).slice(2),
}));

// Ethereum: a fixed device key; address, EIP-191 signature (RFC 6979, low-s) and EIP-155 legacy transactions
const pk = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const w = new ethers.Wallet(pk);
const msgs = ["Pearl episode ep_20261106051000_a1c4 head " + "ab".repeat(32), "Pearl link to account " + "c".repeat(32) + " nonce " + "d".repeat(32) + " owner key 0123456789abcdef", "x"];
const eth = {
  privateKey: pk,
  address: w.address,
  publicKey: w.signingKey.publicKey,
  signatures: await Promise.all(msgs.map(async (m) => ({ message: m, signature: await w.signMessage(m) }))),
  transactions: await Promise.all([
    { chainId: 16602, nonce: 0, gasPrice: 4_000_000_000n, gasLimit: 200_000n, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3", value: 0n, data: "0x1234abcd" + "00".repeat(60) },
    { chainId: 16602, nonce: 37, gasPrice: 1n, gasLimit: 21_000n, to: "0x5FbDB2315678afecb367f032d93F642f64180aa3", value: 10n ** 16n, data: "0x" },
    { chainId: 7794095, nonce: 1024, gasPrice: 1_000_000_007n, gasLimit: 300_000n, to: "0x4444444444444444444444444444444444444444", value: 0n, data: "0x" + "ee".repeat(300) },
  ].map(async (t) => ({ ...t, gasPrice: t.gasPrice.toString(), gasLimit: t.gasLimit.toString(), value: t.value.toString(), raw: await w.signTransaction({ ...t, type: 0 }) }))),
};

// locking: TS wraps and seals; the firmware must open both (and test/host/crosscheck.ts opens what the firmware made)
const recipient = await newRecipientKey();
const runKey = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const rec = new EpisodeRecorder("ep_20261106051000_a1c4", "esp32-s3-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
rec.addEvent({ ts: "2026-11-06T05:10:00.000Z", ev: "episode_start", data: { task: { task: "pick", color: "red", from: "A2", to: "BIN" }, deviceState: "IDLE", armConfigHash: "a".repeat(64) } });
rec.addEvent({ ts: "2026-11-06T05:10:09.000Z", ev: "episode_end", data: { outcome: "ABORTED" } });
const log = rec.close("ABORTED");
log.startedAt = "2026-11-06T05:10:00.000Z";
log.endedAt = "2026-11-06T05:10:09.000Z";
log.device = { address: w.address, signature: await w.signMessage(headMessage(log.episodeId, log.headHash)) };
const ctx = runContext(w.address, log.episodeId);
const sealed = await sealEpisode(log, runKey, { incident: false, severity: 0, origin: null });
const seal = {
  recipient: { publicJwk: recipient.publicJwk, d: recipient.privateJwk.d, kid: recipient.kid },
  runKey: b64(runKey),
  context: ctx,
  wrapped: await wrapRunKey(runKey, recipient.publicJwk, ctx),
  logCanonical: canonicalize(log),
  sealed,
  frame: { jpeg: b64(new TextEncoder().encode("JPEG-BYTES")), locked: b64(await lockFrame(runKey, new TextEncoder().encode("JPEG-BYTES"))) },
};

// the 0G Chain anchor call, encoded by ethers from the contract ABI the dashboard uses
const { ANCHOR_ABI, episodeKey } = await import("../og/anchor.js");
const iface = new ethers.Interface(ANCHOR_ABI);
const aIn = { episodeId: "ep_20261106052200_b7e2", headHash: "0x" + "ab".repeat(32), rootHash: "0x" + "cd".repeat(32), requestIdsHash: "0x" + "ef".repeat(32), outcome: 3, severity: 3, incident: true };
const anchor = {
  ...aIn,
  calldata: iface.encodeFunctionData("anchor", [episodeKey(aIn.episodeId), aIn.headHash, aIn.rootHash, aIn.requestIdsHash, aIn.outcome, aIn.severity, aIn.incident]),
  calldataNoRoot: iface.encodeFunctionData("anchor", [episodeKey(aIn.episodeId), aIn.headHash, ethers.ZeroHash, aIn.requestIdsHash, aIn.outcome, aIn.severity, aIn.incident]),
};

const out = { generatedBy: "apps/backend/src/scripts/fw-vectors.ts", numbers, parse, canon, hashes, eth, seal, anchor };
const path = resolve(REPO_ROOT, "firmware/esp32-arm/test/host/vectors.json");
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(`wrote ${path}: ${numbers.length} numbers, ${canon.length} canonical, ${hashes.length} hashes, ${eth.signatures.length} signatures, ${eth.transactions.length} txs`);
