// After a run closes, the robot publishes it itself, with its own key (rev 5, device-first), as
// apps/backend/src/orchestrator/pipeline.ts does: 0G Storage (the locked log and locked frames), the 0G Chain anchor,
// then the Arkiv index entry (labels only). Each step's real result, or the honest reason it did not run, goes into
// the run's meta JSON (same shape as orchestrator/meta.ts), which the dashboard reads. Portable: JSON-RPC over the
// Platform's HTTP, so the host tests drive it against a fake node.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include <vector>
#include "chain.h"
#include "orch.h"

namespace pearl::publish {

struct Config {
  std::string chainRpc = "https://evmrpc-testnet.0g.ai";
  uint64_t chainId = 16602;
  std::string explorer = "https://chainscan-galileo.0g.ai";
  std::string anchorAddress;              // EpisodeAnchor (empty: anchor not configured)
  std::vector<std::string> storageNodes;  // plain-HTTP 0G Storage nodes (the turbo indexer is TLS 1.3 only)
  std::string arkivRpc;                   // https://rpc.rabdi.db-chain.testnet.arkiv.network[/<accessKey>]
  uint64_t arkivChainId = 7794095;
  uint32_t arkivLifetimeDays = 30;
  std::string armId = "arm-1";
  std::string storageIndexer = "https://indexer-storage-testnet-turbo.0g.ai";  // only for the public file link
  bool anchorOn = true, arkivOn = true, storageOn = true;
  uint32_t txTimeoutMs = 90000, storageTimeoutMs = 120000;
};

/** One JSON-RPC call; false + `err` on transport or RPC error. */
bool rpc(orch::Platform& p, const std::string& url, const char* method, JsonVariantConst params, JsonDocument& result, std::string& err, uint32_t timeoutMs = 20000);

struct TxResult {
  std::string txHash;
  JsonDocument receipt;
};
/** Online: the transaction sendTx signs (pending nonce, fees as ethers/viem pick them, estimate × 1.25). */
bool prepareTx(orch::Platform& p, const std::string& url, uint64_t chainId, const eth::Key& k, const Bytes& to, const Bytes& value,
               const Bytes& data, chain::Eip1559Tx& tx, std::string& err, bool arkivFees = false);
/** eth_sendRawTransaction of an already signed tx. OK also when the node already knows it or already mined it;
 *  STALE when its nonce was taken by a DIFFERENT transaction (the robot must re-sign). */
enum class Sent { OK, STALE, ERROR };
Sent sendRaw(orch::Platform& p, const std::string& url, const std::string& raw0x, const std::string& hash0x, std::string& err);
/** Waits for the receipt (status 1 required). */
bool waitReceipt(orch::Platform& p, const std::string& url, const std::string& hash0x, uint32_t timeoutMs, JsonDocument& receipt, std::string& err);
/** Builds, signs and sends a type-2 transaction, then waits for its receipt (status 1 required). */
bool sendTx(orch::Platform& p, const std::string& url, uint64_t chainId, const eth::Key& k, const Bytes& to, const Bytes& value,
            const Bytes& data, uint32_t timeoutMs, TxResult& out, std::string& err, bool arkivFees = false);

/** v × num / den on big-endian numbers (fees, headroom), no overflow. */
Bytes mulDiv(const Bytes& v, uint64_t num, uint64_t den);
uint64_t hexU64(JsonVariantConst v);
/** A JSON-RPC quantity ("0x1a") → minimal big-endian bytes. */
Bytes hexBytes(JsonVariantConst v);

struct Upload {
  std::string rootHash, txHash;
  uint64_t txSeq = 0;
  uint32_t ms = 0;
};
/** The storage nodes that answer (with their shard), and the Flow contract they report. */
struct StorageNet {
  struct Node {
    std::string url;
    uint64_t shardId = 0, numShard = 1;
  };
  std::vector<Node> nodes;
  std::string flow;
};
bool discoverStorage(orch::Platform& p, const Config& c, StorageNet& net, std::string& err);
/** market().pricePerSector() of the Flow contract, big-endian. */
bool storagePrice(orch::Platform& p, const Config& c, const std::string& flow, Bytes& pricePerSector, std::string& err);
/** After the Flow submit is mined: waits until the nodes know the file, sends its one segment to the node of its
 *  shard (no key needed) and waits until finalized. `out.rootHash` must be set. */
bool pushSegment(orch::Platform& p, const Config& c, const StorageNet& net, const Bytes& file, uint32_t started, Upload& out, std::string& err);
/** 0G Storage upload of one file ≤ 256 KiB (one segment), following the SDK (test/host/gen/storage-spec.md). */
bool uploadFile(orch::Platform& p, const Config& c, const eth::Key& k, const Bytes& file, Upload& out, std::string& err);

// ---- what both paths (direct publish and pre-signed bundle) put on-chain, from one place
uint8_t outcomeCode(const std::string& outcome);
/** EpisodeAnchor.anchor(...) calldata for a run; `root0x` empty when the log is not on 0G Storage. */
Bytes anchorData(const orch::Result& r, const std::string& root0x);
/** Arkiv execute(Create) calldata: public labels only. Empty strings are left out. */
Bytes arkivData(const Config& c, const orch::Result& r, const std::string& root0x, const std::string& storageTx, const std::string& anchorTx, const Bytes& salt16);
/** The Arkiv entity key from an execute receipt's EntityCreated log ("" if none). */
std::string arkivEntityKey(JsonVariantConst receipt);

/**
 * Publishes a closed run. `frameFiles` maps a decision idx to its locked frame bytes. `onMeta` is called after every
 * step with the meta JSON so far (the dashboard's live "meta" event).
 */
void publishRun(orch::Platform& p, const Config& c, const eth::Key& k, const orch::Result& r,
                const std::vector<std::pair<size_t, Bytes>>& frameFiles, JsonDocument& meta,
                const std::function<void(const JsonDocument&)>& onMeta);

}  // namespace pearl::publish
