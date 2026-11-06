/**
 * Checks the offline-relay bundle and signed ping the firmware's host tests built
 * (firmware/esp32-arm/test/host/out/bundle.json, ping.json) with ethers and the repo's own 0G Storage root code,
 * exactly as a relayer must (spec §1/§5): bundleId recomputes, sig recovers to the device, every raw tx is sent by
 * the device on an expected chain in nonce order, its hash matches, files match their roots.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Transaction, verifyMessage, getAddress, AbiCoder, dataSlice } from "ethers";
import { REPO_ROOT } from "../shared/env.js";
import { canonicalize } from "../shared/canonical.js";
import { localRoot } from "../og/storage.js";

const out = resolve(REPO_ROOT, "firmware/esp32-arm/test/host/out");
const v = JSON.parse(readFileSync(resolve(REPO_ROOT, "firmware/esp32-arm/test/host/vectors.json"), "utf8"));
const b = JSON.parse(readFileSync(resolve(out, "bundle.json"), "utf8"));
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};

const { sig, ...unsigned } = b;
const id = "0x" + createHash("sha256").update(canonicalize(unsigned)).digest("hex");
check(canonicalize(b) === readFileSync(resolve(out, "bundle.json"), "utf8"), "bundle: stored as canonical JSON");
check(getAddress(b.device) === getAddress(v.eth.address), "bundle: device is the robot's address");
check(verifyMessage(`pearl/bundle/v1|${id}`, sig) === getAddress(b.device), "bundle: EIP-191 sig over the recomputed bundleId recovers to the device");

const expected: Record<number, string> = { 16602: "0g-galileo", 7794095: "arkiv-rabdi" };
const lastNonce: Record<number, number> = {};
for (const t of b.txs) {
  const tx = Transaction.from(t.raw);
  check(tx.type === 2 && tx.from === getAddress(b.device), `${t.purpose}: type-2, sent by the device`);
  check(tx.hash === t.hash, `${t.purpose}: hash matches raw`);
  const cid = Number(tx.chainId);
  check(expected[cid] === t.chain && cid === t.chainId, `${t.purpose}: chainId ${cid} (${t.chain})`);
  check(tx.nonce === t.nonce && (lastNonce[cid] === undefined || tx.nonce === lastNonce[cid] + 1), `${t.purpose}: nonce ${tx.nonce} in order`);
  lastNonce[cid] = tx.nonce;
  check(tx.maxFeePerGas! >= tx.maxPriorityFeePerGas! && tx.gasLimit > 21000n, `${t.purpose}: fees and gas sane`);
  if (t.purpose.startsWith("storage:")) {
    const f = b.files[t.file];
    const data = new Uint8Array(Buffer.from(f.data, "base64"));
    const root = await localRoot(data);
    check(root === f.root && data.length === f.size, `${t.purpose}: file root ${root.slice(0, 10)}… recomputed by the 0G Storage SDK`);
    // Flow.submit(((uint256 length, bytes tags, (bytes32 root, uint256 height)[] nodes), address submitter))
    const [[sub, submitter]] = AbiCoder.defaultAbiCoder().decode(["tuple(tuple(uint256,bytes,tuple(bytes32,uint256)[]),address)"], dataSlice(tx.data, 4));
    check(Number(sub[0]) === data.length && getAddress(submitter) === getAddress(b.device), `${t.purpose}: submit calldata covers the file, submitter = device`);
    check(tx.value > 0n, `${t.purpose}: storage fee in value (${tx.value} wei)`);
  }
}
const log = b.files.find((f: { role: string }) => f.role === "log");
check(!!log && log.root === b.summary.rootHash, "summary.rootHash is the log file's root");

const p = JSON.parse(readFileSync(resolve(out, "ping.json"), "utf8"));
const msg = `pearl/ping/v1|${p.device.toLowerCase()}|${p.episodeId}|${p.outcome}|${p.severity}|${p.headHash}|${p.ts}`;
check(verifyMessage(msg, p.sig) === getAddress(v.eth.address), "ping: EIP-191 sig recovers to the robot");
process.exit(fails ? 1 : 0);
