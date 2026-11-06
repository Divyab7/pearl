#include "chain.h"
#include <algorithm>
#include <cstring>

namespace pearl::chain {

const char* ARKIV_PROCESSOR = "0x4400000000000000000000000000000000000044";
const char* ARKIV_ENTITY_CREATED_TOPIC = "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5";

static void append(Bytes& a, const Bytes& b) { a.insert(a.end(), b.begin(), b.end()); }

bool signEip1559(const eth::Key& k, const Eip1559Tx& tx, Bytes& raw, Bytes& txHash) {
  using namespace eth;
  if (tx.to.size() != 20) return false;
  std::vector<Bytes> f = {
      rlpBytes(uintBytes(tx.chainId)), rlpBytes(uintBytes(tx.nonce)), rlpBytes(stripZeros(tx.maxPriorityFeePerGas)),
      rlpBytes(stripZeros(tx.maxFeePerGas)), rlpBytes(uintBytes(tx.gas)), rlpBytes(tx.to), rlpBytes(stripZeros(tx.value)),
      rlpBytes(tx.data), rlpList({}),  // empty access list
  };
  Bytes pre{0x02};
  append(pre, rlpList(f));
  uint8_t h[32], r[32], s[32];
  keccak256(pre.data(), pre.size(), h);
  int recid;
  if (!signDigest(k, h, r, s, recid)) return false;
  f.push_back(rlpBytes(uintBytes(static_cast<uint64_t>(recid))));
  f.push_back(rlpBytes(stripZeros(Bytes(r, r + 32))));
  f.push_back(rlpBytes(stripZeros(Bytes(s, s + 32))));
  raw = Bytes{0x02};
  append(raw, rlpList(f));
  txHash = keccak256(raw);
  return true;
}

Bytes word(uint64_t v) {
  Bytes w(32, 0);
  for (int i = 0; i < 8; i++) w[31 - i] = static_cast<uint8_t>(v >> (8 * i));
  return w;
}

Bytes wordBytes(const Bytes& b) {
  Bytes w(32, 0);
  size_t n = std::min<size_t>(b.size(), 32);
  memcpy(w.data() + 32 - n, b.data() + b.size() - n, n);
  return w;
}

static Bytes padRight(const Bytes& b) {
  Bytes o = b;
  o.resize((b.size() + 31) / 32 * 32, 0);
  return o;
}

Bytes selector(const std::string& sig) {
  Bytes h = keccak256(sig);
  return Bytes(h.begin(), h.begin() + 4);
}

Bytes anchorCalldata(const std::string& episodeId, const Bytes& headHash, const Bytes& rootHash, const Bytes& requestIdsHash,
                     uint8_t outcome, uint8_t severity, bool incident) {
  Bytes d = selector("anchor(bytes32,bytes32,bytes32,bytes32,uint8,uint8,bool)");
  append(d, keccak256(episodeId));
  append(d, wordBytes(headHash));
  append(d, rootHash.empty() ? Bytes(32, 0) : wordBytes(rootHash));
  append(d, wordBytes(requestIdsHash));
  append(d, word(outcome));
  append(d, word(severity));
  append(d, word(incident ? 1 : 0));
  return d;
}

// ---------------------------------------------------------------- 0G Storage
static size_t nextPow2(size_t x) {
  size_t p = 1;
  while (p < x) p <<= 1;
  return p;
}

size_t paddedChunks(size_t size) {
  size_t chunks = (size + CHUNK - 1) / CHUNK;
  size_t np2 = nextPow2(chunks);
  if (np2 == chunks) return chunks;
  size_t minChunk = np2 >= 16 ? np2 / 16 : 1;
  return (chunks + minChunk - 1) / minChunk * minChunk;
}

static Bytes leaf(const Bytes& file, size_t i) {
  uint8_t c[CHUNK] = {0};
  size_t off = i * CHUNK;
  if (off < file.size()) memcpy(c, file.data() + off, std::min(CHUNK, file.size() - off));
  return keccak256(Bytes(c, c + CHUNK));
}

static Bytes hashPair(const Bytes& a, const Bytes& b) {
  Bytes x = a;
  append(x, b);
  return keccak256(x);
}

/** MerkleTree.build: pair left to right, an unpaired last node is carried up unchanged. */
static Bytes reduce(std::vector<Bytes> h) {
  while (h.size() > 1) {
    std::vector<Bytes> n;
    for (size_t i = 0; i + 1 < h.size(); i += 2) n.push_back(hashPair(h[i], h[i + 1]));
    if (h.size() % 2) n.push_back(h.back());
    h.swap(n);
  }
  return h.empty() ? Bytes(32, 0) : h[0];
}

Bytes storageRoot(const Bytes& file) {
  size_t pc = paddedChunks(file.size());
  std::vector<Bytes> segs;
  for (size_t s = 0; s * SEGMENT_CHUNKS < pc; s++) {
    std::vector<Bytes> leaves;
    for (size_t c = s * SEGMENT_CHUNKS; c < std::min(pc, (s + 1) * SEGMENT_CHUNKS); c++) leaves.push_back(leaf(file, c));
    segs.push_back(reduce(leaves));
  }
  return reduce(segs);
}

std::vector<StorageNode> submissionNodes(const Bytes& file) {
  size_t chunks = (file.size() + CHUNK - 1) / CHUNK;
  size_t remaining = paddedChunks(file.size());
  std::vector<StorageNode> out;
  size_t start = 0;
  for (size_t p = nextPow2(chunks); p >= 1 && remaining; p >>= 1) {
    if (p > remaining) continue;
    std::vector<Bytes> leaves;
    for (size_t c = start; c < start + p; c++) leaves.push_back(leaf(file, c));
    uint32_t h = 0;
    while ((static_cast<size_t>(1) << h) < p) h++;
    out.push_back({reduce(leaves), h});
    start += p;
    remaining -= p;
  }
  return out;
}

Bytes submitCalldata(size_t length, const std::vector<StorageNode>& nodes, const Bytes& submitter) {
  // submit(((uint256,bytes,(bytes32,uint256)[]),address)): one dynamic tuple argument
  Bytes d = selector("submit(((uint256,bytes,(bytes32,uint256)[]),address))");
  append(d, word(0x20));                       // offset of the outer tuple
  append(d, word(0x40));                       // offset of `data` inside it
  append(d, wordBytes(submitter));             // submitter
  append(d, word(length));                     // data.length
  append(d, word(0x60));                       // offset of tags inside data
  append(d, word(0x80));                       // offset of nodes inside data (tags is empty: 1 word)
  append(d, word(0));                          // tags length
  append(d, word(nodes.size()));
  for (const StorageNode& n : nodes) {
    append(d, wordBytes(n.root));
    append(d, word(n.height));
  }
  return d;
}

Bytes singleSegment(const Bytes& file) {
  size_t chunks = (file.size() + CHUNK - 1) / CHUNK;
  Bytes s = file;
  s.resize(chunks * CHUNK, 0);
  return s;
}

// ---------------------------------------------------------------- Arkiv
static Bytes asciiName(const std::string& n) {
  Bytes b(32, 0);
  memcpy(b.data(), n.data(), std::min<size_t>(n.size(), 32));
  return b;
}

Attribute attrStr(const std::string& name, const std::string& v, bool indexed) {
  return {name, static_cast<uint8_t>(8 | (indexed ? 0x80 : 0)), utf8(v)};
}
Attribute attrU64(const std::string& name, uint64_t v, bool indexed) {
  return {name, static_cast<uint8_t>(3 | (indexed ? 0x80 : 0)), word(v)};
}
Attribute attrI32(const std::string& name, int32_t v, bool indexed) {
  Bytes w(32, v < 0 ? 0xff : 0x00);
  uint32_t u = static_cast<uint32_t>(v);
  for (int i = 0; i < 4; i++) w[31 - i] = static_cast<uint8_t>(u >> (8 * i));
  return {name, static_cast<uint8_t>(2 | (indexed ? 0x80 : 0)), w};
}

Bytes arkivCreateCalldata(const Bytes& salt16, uint64_t minLifetimeBlocks, uint8_t flags, std::vector<Attribute> attrs) {
  std::sort(attrs.begin(), attrs.end(), [](const Attribute& a, const Attribute& b) { return asciiName(a.name) < asciiName(b.name); });
  // operationData = abi.encode((uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 flags, (bytes32,uint8,bytes)[]))
  Bytes body;  // the tuple's encoding, starting at its head
  append(body, wordBytes(salt16));
  append(body, word(0));  // expiresAt: none, the contract uses inclusion block + minLifetime
  append(body, word(minLifetimeBlocks));
  append(body, word(flags));
  append(body, word(0xa0));  // offset of the attribute array within the tuple
  Bytes arr = word(attrs.size());
  std::vector<Bytes> elems;
  for (const Attribute& a : attrs) {
    Bytes e = asciiName(a.name);
    append(e, word(a.type));
    append(e, word(0x60));
    append(e, word(a.value.size()));
    append(e, padRight(a.value));
    elems.push_back(e);
  }
  size_t off = 32 * elems.size();
  for (const Bytes& e : elems) {
    append(arr, word(off));
    off += e.size();
  }
  for (const Bytes& e : elems) append(arr, e);
  append(body, arr);
  Bytes opData = word(0x20);  // abi.encode of one dynamic tuple: offset then the tuple
  append(opData, body);
  // execute((uint8 operation, bytes operationData)[])
  Bytes d = selector("execute((uint8,bytes)[])");
  append(d, word(0x20));
  append(d, word(1));
  append(d, word(0x20));  // offset of element 0
  append(d, word(1));     // Create
  append(d, word(0x40));
  append(d, word(opData.size()));
  append(d, padRight(opData));
  return d;
}

}  // namespace pearl::chain
