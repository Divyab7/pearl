/**
 * Opens what the firmware's host tests locked (firmware/esp32-arm/test/host/out/cpp-seal.json) with the REAL
 * TypeScript code: the owner's browser and the verifier must be able to read everything the board produces.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import { openEpisode, parseSealed, unb64, unlockFrame, unwrapRunKey, type PrivateJwk } from "../shared/seal.js";
import { canonicalize } from "../shared/canonical.js";

const v = JSON.parse(readFileSync(resolve(REPO_ROOT, "firmware/esp32-arm/test/host/vectors.json"), "utf8"));
const c = JSON.parse(readFileSync(resolve(REPO_ROOT, "firmware/esp32-arm/test/host/out/cpp-seal.json"), "utf8"));
const priv: PrivateJwk = { ...v.seal.recipient.publicJwk, d: v.seal.recipient.d };
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails++;
};
const key = await unwrapRunKey(c.wrapped, priv, c.context);
check(Buffer.from(key).equals(Buffer.from(unb64(v.seal.runKey))), "TS unwraps the firmware's wrapped run key");
const sealed = parseSealed(JSON.stringify(c.sealed));
const log = await openEpisode(sealed, key);
check(canonicalize(log) === v.seal.logCanonical, "TS opens the firmware's sealed episode and gets the same log");
const jpeg = await unlockFrame(key, unb64(c.frame));
check(new TextDecoder().decode(jpeg) === "JPEG-BYTES", "TS unlocks the firmware's locked frame");
// whole runs made by the C++ orchestrator: the REAL verifier must accept every one
const { readdirSync } = await import("node:fs");
const { contentChecks, requestIdsHashOf, requestIdsOfLog, framesOf } = await import("../verify/content.js");
const { verifyChain } = await import("../orchestrator/log.js");
const { loadArmConfig } = await import("../shared/armConfig.js");
const { incidentOf } = await import("../og/anchor.js");
const { localRoot } = await import("../og/storage.js");
const { sha256Hex } = await import("../shared/hash.js");
const { headMessage, recoverDevice } = await import("../shared/deviceKey.js");
const dir = resolve(REPO_ROOT, "firmware/esp32-arm/test/host/out/runs");
const arm = loadArmConfig();
for (const f of readdirSync(dir).filter((x) => /^ep_.*\.json$/.test(x) && !x.endsWith(".sealed.json")).sort()) {
  const log = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
  const id = log.episodeId;
  check(verifyChain(log).ok, `${id}: hash chain recomputes`);
  check(recoverDevice(headMessage(id, log.headHash), log.device.signature) === v.eth.address, `${id}: signed by the robot key`);
  const cs = contentChecks(log, { headerHead: log.headHash, anchoredRequestIdsHash: requestIdsHashOf(requestIdsOfLog(log)), arm });
  const bad = cs.filter((c) => c.status === "FAIL");
  check(bad.length === 0, `${id}: content checks pass (${cs.map((c) => c.status).join(", ")})${bad.length ? " — " + bad.map((c) => c.detail).join("; ") : ""}`);
  const sealedRun = parseSealed(readFileSync(resolve(dir, `${id}.sealed.json`), "utf8"));
  const inc = incidentOf(log);
  check(sealedRun.incident === inc.incident && sealedRun.severity === inc.severity && sealedRun.headHash === log.headHash, `${id}: sealed header matches the log (incident ${inc.incident}, severity ${inc.severity})`);
  check(canonicalize(await openEpisode(sealedRun, unb64(v.seal.runKey))) === canonicalize(log), `${id}: TS opens the board's sealed run`);
  for (const fr of framesOf(log)) {
    const locked = new Uint8Array(readFileSync(resolve(dir, `${id}.frame-${fr.idx}.locked`)));
    check((await localRoot(locked)) === fr.root, `${id}: frame #${fr.idx} root matches the 0G Storage SDK`);
    check(sha256Hex(await unlockFrame(unb64(v.seal.runKey), locked)) === fr.hash, `${id}: frame #${fr.idx} unlocks to its recorded hash`);
  }
}
process.exit(fails ? 1 : 0);
