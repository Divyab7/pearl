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
process.exit(fails ? 1 : 0);
