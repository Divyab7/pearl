/**
 * Offline test vectors for the 0G Storage upload path, produced by the installed
 * @0gfoundation/0g-storage-ts-sdk@1.2.13 itself (lib.esm), plus an independent
 * re-implementation (refRoot / refNodes) that the ESP32 port can mirror line by line.
 * No network calls. Run from apps/backend:  npx tsx <this file> [out.json]
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BACKEND = "/Users/divyabanda/ethglobal mumbai divya/apps/backend/package.json";
const req = createRequire(BACKEND);
const sdkMain = req.resolve("@0gfoundation/0g-storage-ts-sdk"); // .../lib.commonjs/index.js
const sdkRoot = sdkMain.replace(/lib\.commonjs\/index\.js$/, "");
const esm = (p: string) => import(pathToFileURL(sdkRoot + "lib.esm/" + p).href);
const { MemData } = await esm("file/MemData.js");
const { Uploader } = await esm("transfer/Uploader.js");
const { calculatePrice } = await esm("transfer/utils.js");
const { FixedPriceFlow__factory } = await esm("contracts/flow/index.js");
const { keccak256, getBytes, concat, id } = req("ethers");

const OBSERVED_PRICE_PER_SECTOR = 30733644962n; // read from chain 2026-11-06, runtime value
const EXAMPLE_SUBMITTER = "0x1111111111111111111111111111111111111111";

const pattern = (n: number) => { const b = new Uint8Array(n); for (let k = 0; k < n; k++) b[k] = k % 251; return b; };

// ---------------- independent reference implementation ----------------
const CHUNK = 256, SEG_CHUNKS = 1024;
const numSplits = (t: number, u: number) => Math.floor((t - 1) / u) + 1;
const nextPow2 = (x: number) => { let p = 1; while (p < x) p *= 2; return p; };
function paddedChunks(chunks: number) {
  const np2 = nextPow2(chunks);
  if (np2 === chunks) return np2;
  const minChunk = np2 >= 16 ? np2 / 16 : 1;
  return numSplits(chunks, minChunk) * minChunk;
}
const h2 = (a: Uint8Array, b: Uint8Array) => getBytes(keccak256(concat([a, b])));
/** SDK MerkleTree.build: pair left-to-right; an unpaired last node is carried up unchanged. */
function buildRoot(level: Uint8Array[]): Uint8Array {
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(h2(level[i], level[i + 1]));
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    level = next;
  }
  return level[0];
}
function refRoot(data: Uint8Array): string {
  const chunks = numSplits(data.length, CHUNK);
  const pChunks = paddedChunks(chunks);
  const padded = new Uint8Array(pChunks * CHUNK); padded.set(data);
  const segRoots: Uint8Array[] = [];
  for (let s = 0; s < pChunks; s += SEG_CHUNKS) {
    const leaves: Uint8Array[] = [];
    for (let c = s; c < Math.min(s + SEG_CHUNKS, pChunks); c++) leaves.push(getBytes(keccak256(padded.subarray(c * CHUNK, (c + 1) * CHUNK))));
    segRoots.push(buildRoot(leaves));
  }
  return keccak256(buildRoot(segRoots)).length && ("0x" + Buffer.from(buildRoot(segRoots)).toString("hex"));
}
// ----------------------------------------------------------------------

const lengths = [0, 1, 255, 256, 257, 4096, 7175, 262144, 262145, 70000];
const out: any = {
  generatedBy: "@0gfoundation/0g-storage-ts-sdk@1.2.13 lib.esm (MemData.merkleTree / createSubmission / Uploader.getSegment)",
  inputPattern: "byte[k] = k % 251",
  constants: { CHUNK_SIZE: 256, SEGMENT_MAX_CHUNKS: 1024, SEGMENT_SIZE: 262144,
    EMPTY_CHUNK_HASH: keccak256(new Uint8Array(256)) },
  vectors: [] as any[],
};

for (const n of lengths) {
  const data = pattern(n);
  const mem = new MemData(data);
  const [tree, err] = await mem.merkleTree();
  const v: any = { length: n, first8Hex: Buffer.from(data.subarray(0, 8)).toString("hex"),
    keccakOfRawInput: keccak256(data) };
  if (err || !tree) { v.root = null; v.note = `SDK returns no tree (err=${err?.message ?? "null"}); size 0 is unsupported`; out.vectors.push(v); continue; }
  v.root = tree.rootHash();
  v.refRoot = refRoot(data);
  v.refMatches = v.refRoot === v.root;
  v.numChunks = mem.numChunks();
  v.paddedSize = mem.paddedSize();
  v.paddedChunks = mem.paddedSize() / 256;
  v.numSegmentsPadded = mem.numSegmentsPadded();
  v.segmentRoots = tree.leaves.map((l: any) => l.hash);
  const [sub] = await mem.createSubmission("0x", EXAMPLE_SUBMITTER);
  v.submissionNodes = sub.data.nodes.map((x: any) => ({ height: x.height, root: x.root }));
  v.sectors = sub.data.nodes.reduce((a: number, x: any) => a + 2 ** x.height, 0);
  out.vectors.push(v);
}

// extra cross-check of the reference implementation on many lengths
const extra: number[] = [];
for (const n of [2, 511, 512, 513, 3839, 3840, 3841, 4097, 8191, 8193, 16384, 60000, 61440, 65537, 131072, 300000, 524288, 600000, 1048577]) {
  const [t] = await new MemData(pattern(n)).merkleTree();
  if (t.rootHash() !== refRoot(pattern(n))) extra.push(n);
}
out.referenceImplMismatches = extra;

// ---------- full detail for 7175 bytes ----------
{
  const data = pattern(7175);
  const mem = new MemData(data);
  const [tree] = await mem.merkleTree();
  const [submission] = await mem.createSubmission("0x", EXAMPLE_SUBMITTER);
  const iface = FixedPriceFlow__factory.createInterface();
  const frag = iface.getFunction("submit");
  const calldata = iface.encodeFunctionData("submit", [submission]);
  const fee = calculatePrice(submission, OBSERVED_PRICE_PER_SECTOR);
  // Uploader.getSegment does not touch `this`; call it unbound to get exactly what is sent to the node
  const [allDone, seg] = await Uploader.prototype.getSegment.call({}, mem, tree, 0);
  const segBytes = Buffer.from(seg.data, "base64");
  out.detail7175 = {
    root: tree.rootHash(),
    submission: {
      data: { length: submission.data.length, tags: submission.data.tags,
        nodes: submission.data.nodes.map((x: any) => ({ root: x.root, height: x.height })) },
      submitter: submission.submitter,
    },
    abi: { signature: frag.format("sighash"), fullSignature: frag.format("full"), selector: frag.selector,
      stateMutability: frag.stateMutability },
    calldata,
    calldataWords: (calldata.slice(10).match(/.{64}/g) ?? []).map((w: string, i: number) => `${(4 + i * 32).toString().padStart(4)}: ${w}`),
    fee: { pricePerSectorUsed: OBSERVED_PRICE_PER_SECTOR.toString(), sectors: submission.data.nodes.reduce((a: number, x: any) => a + 2 ** x.height, 0), valueWei: fee.toString(),
      note: "pricePerSector is a runtime value read from market() -> pricePerSector()" },
    segmentUpload: {
      rpcMethod: "zgs_uploadSegmentsByTxSeq",
      paramsShape: "[[SegmentWithProof...], txSeq]",
      allDataUploaded: allDone,
      segmentWithProof: JSON.parse(JSON.stringify(seg)),
      decodedDataLength: segBytes.length,
      decodedDataSha: keccak256(segBytes),
      decodedTailHex: segBytes.subarray(7175 - 7, segBytes.length).toString("hex").replace(/(00)+$/, (m: string) => `…(${m.length / 2} zero bytes)`),
    },
    exampleJsonRpcBody: { jsonrpc: "2.0", method: "zgs_uploadSegmentsByTxSeq", params: [[JSON.parse(JSON.stringify(seg))], 123456], id: 1 },
  };
}

// ---------- detail for a 2-segment file: proofs ----------
{
  const data = pattern(262145);
  const mem = new MemData(data);
  const [tree] = await mem.merkleTree();
  const segs = [];
  for (let i = 0; i < mem.numSegmentsPadded(); i++) {
    const [done, seg] = await Uploader.prototype.getSegment.call({}, mem, tree, i);
    segs.push({ index: seg.index, fileSize: seg.fileSize, root: seg.root, proof: JSON.parse(JSON.stringify(seg.proof)),
      dataBytes: Buffer.from(seg.data, "base64").length, allDataUploaded: done });
  }
  out.detail262145Segments = segs;
}

const target = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "vectors.json");
writeFileSync(target, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.vectors.map((v: any) => ({ n: v.length, root: v.root, ok: v.refMatches, pc: v.paddedChunks, nodes: v.submissionNodes?.map((x: any) => x.height) })), null, 1));
console.log("extra mismatches:", extra, "->", target);
