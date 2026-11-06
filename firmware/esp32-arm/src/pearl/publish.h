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
/** Builds, signs and sends a type-2 transaction, then waits for its receipt (status 1 required). */
bool sendTx(orch::Platform& p, const std::string& url, uint64_t chainId, const eth::Key& k, const Bytes& to, const Bytes& value,
            const Bytes& data, uint32_t timeoutMs, TxResult& out, std::string& err, bool arkivFees = false);

struct Upload {
  std::string rootHash, txHash;
  uint64_t txSeq = 0;
  uint32_t ms = 0;
};
/** 0G Storage upload of one file ≤ 256 KiB (one segment), following the SDK (test/host/gen/storage-spec.md). */
bool uploadFile(orch::Platform& p, const Config& c, const eth::Key& k, const Bytes& file, Upload& out, std::string& err);

/**
 * Publishes a closed run. `frameFiles` maps a decision idx to its locked frame bytes. `onMeta` is called after every
 * step with the meta JSON so far (the dashboard's live "meta" event).
 */
void publishRun(orch::Platform& p, const Config& c, const eth::Key& k, const orch::Result& r,
                const std::vector<std::pair<size_t, Bytes>>& frameFiles, JsonDocument& meta,
                const std::function<void(const JsonDocument&)>& onMeta);

}  // namespace pearl::publish
