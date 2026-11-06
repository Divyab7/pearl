// What the robot writes on-chain, encoded exactly as the TypeScript SDKs do (host tests compare every byte):
//  - EIP-1559 (type 2) transactions — Arkiv's SDK and ethers send type 2 on both chains
//  - EpisodeAnchor.anchor(...) calldata (0G Chain)
//  - 0G Storage: file Merkle root, Flow.submit(...) calldata, and the single-segment upload (files ≤ 256 KiB)
//  - Arkiv: execute([(Create, operationData)]) calldata for one entity
// Specs: test/host/gen/storage-spec.md and test/host/gen/arkiv-spec.md (from the SDK sources, 6 Nov 2026).
#pragma once
#include <string>
#include <vector>
#include "bytes.h"
#include "eth.h"

namespace pearl::chain {

struct Eip1559Tx {
  uint64_t chainId = 0;
  uint64_t nonce = 0;
  Bytes maxPriorityFeePerGas;  // big-endian
  Bytes maxFeePerGas;          // big-endian
  uint64_t gas = 0;
  Bytes to;                    // 20 bytes
  Bytes value;                 // big-endian
  Bytes data;
};
/** 0x02 ‖ rlp([...]) signed, and its hash (keccak256 of the raw bytes). */
bool signEip1559(const eth::Key& k, const Eip1559Tx& tx, Bytes& raw, Bytes& txHash);

/** A signed type-2 transaction read back: its fields, sender (recovered) and hash. */
struct DecodedTx {
  Eip1559Tx tx;
  uint8_t from[20];
  Bytes hash;
};
/** Parses 0x02 ‖ rlp([...12 fields]) (empty access list only) and recovers the sender; false if malformed. */
bool decodeEip1559(const Bytes& raw, DecodedTx& out);

// ---- ABI words
Bytes word(uint64_t v);
Bytes wordBytes(const Bytes& b);  // left-padded big-endian number or right-aligned value ≤ 32 bytes
Bytes selector(const std::string& signature);

// ---- EpisodeAnchor (apps/backend/src/og/anchor.ts)
enum Outcome : uint8_t { DONE = 0, ABORTED = 1, FAILSAFE = 2, TRIPPED = 3 };
/** anchor(bytes32 episodeKey, bytes32 headHash, bytes32 rootHash, bytes32 requestIdsHash, uint8 outcome, uint8 severity, bool incident). */
Bytes anchorCalldata(const std::string& episodeId, const Bytes& headHash, const Bytes& rootHashOrEmpty,
                     const Bytes& requestIdsHash, uint8_t outcome, uint8_t severity, bool incident);

// ---- 0G Storage
constexpr size_t CHUNK = 256;
constexpr size_t SEGMENT_CHUNKS = 1024;
struct StorageNode {
  Bytes root;
  uint32_t height;
};
/** The file's Merkle root (what MemData.merkleTree().rootHash() returns). Size must be ≥ 1. */
Bytes storageRoot(const Bytes& file);
/** The submission's nodes: descending powers of two over the padded chunks, each a perfect subtree. */
std::vector<StorageNode> submissionNodes(const Bytes& file);
size_t paddedChunks(size_t size);
/** Flow.submit(((uint256 length, bytes tags, (bytes32 root, uint256 height)[] nodes), address submitter)). */
Bytes submitCalldata(size_t length, const std::vector<StorageNode>& nodes, const Bytes& submitter);
/** The one segment of a file ≤ 256 KiB: data trimmed to whole chunks (padding chunks not sent). */
Bytes singleSegment(const Bytes& file);

// ---- Arkiv
struct Attribute {
  std::string name;  // ASCII, ≤ 32
  uint8_t type;      // base type | 0x80 when indexed: str 8, u64 3, i32 2, bytes 7
  Bytes value;
};
Attribute attrStr(const std::string& name, const std::string& v, bool indexed);
Attribute attrU64(const std::string& name, uint64_t v, bool indexed);
Attribute attrI32(const std::string& name, int32_t v, bool indexed);
/** execute([(1, abi.encode((salt, 0, minLifetime, flags, sorted attributes)))]) for one Create. */
Bytes arkivCreateCalldata(const Bytes& salt16, uint64_t minLifetimeBlocks, uint8_t flags, std::vector<Attribute> attrs);
constexpr uint64_t ARKIV_BLOCKS_PER_DAY = 43200;  // the SDK assumes 2-second blocks
extern const char* ARKIV_PROCESSOR;               // 0x4400000000000000000000000000000000000044
extern const char* ARKIV_ENTITY_CREATED_TOPIC;    // EntityCreated(bytes32 indexed, address indexed, uint64, uint8)

}  // namespace pearl::chain
