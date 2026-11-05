/** Offline check (no key, no network): the SDK computes a Merkle root for our canonical bytes, deterministically. */
import { canonicalize } from "../shared/canonical.js";
import { localRoot } from "../og/storage.js";

const a = await localRoot(Buffer.from(canonicalize({ b: 1, a: 2 })));
const b = await localRoot(Buffer.from(canonicalize({ a: 2, b: 1 })));
console.log(`root ${a}\nsame for reordered keys: ${a === b}`);
