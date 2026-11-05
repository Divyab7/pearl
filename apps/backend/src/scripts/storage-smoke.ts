/** pnpm storage:smoke — uploads a small JSON document to 0G Storage, downloads it with proof, compares bytes. */
import { canonicalize } from "../shared/canonical.js";
import { downloadBytes, localRoot, publicFileUrl, storageConfigFromEnv, storageConfigured, uploadBytes } from "../og/storage.js";

const c = storageConfigFromEnv();
if (!storageConfigured(c)) {
  console.error("Set OG_STORAGE_PRIVATE_KEY (Galileo wallet with test 0G from faucet.0g.ai) in .env first.");
  process.exit(2);
}
const bytes = Buffer.from(canonicalize({ smoke: "pearl", at: new Date().toISOString() }), "utf8");
console.log(`local root: ${await localRoot(bytes)}`);
const up = await uploadBytes(c, bytes);
console.log(`uploaded: root=${up.rootHash} tx=${up.txHash} txSeq=${up.txSeq} time-to-finality=${up.ms} ms`);
const down = await downloadBytes(c, up.rootHash);
console.log(`downloaded ${down.length} bytes, equal: ${Buffer.compare(Buffer.from(down), bytes) === 0}`);
console.log(publicFileUrl(c, up.rootHash));
