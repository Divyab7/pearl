// Offline relay (spec v1, 6 Nov 2026): when the robot has no internet it packs a closed run into a SEALED BUNDLE that
// any device can carry and submit without being trusted — the run file is already locked, every chain transaction is
// pre-signed here with the robot's own key (nonce + fees from a cache refreshed whenever online), and the bundle itself
// is signed (EIP-191 over its id). Also: the signed ping (BLE), the BLE data cursor, the outbox index and the robot's
// own submitter for when it is back online. Portable: the host tests build, read and submit bundles against fakes.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include <vector>
#include "bytes.h"
#include "eth.h"
#include "orch.h"
#include "publish.h"

namespace pearl::bundle {

constexpr const char* CHAIN_OG = "0g-galileo";
constexpr const char* CHAIN_ARKIV = "arkiv-rabdi";

// ---------------------------------------------------------------- nonce + fee cache
struct ChainCache {
  bool known = false;  // nonce known (refreshed online at least once)
  uint64_t nonce = 0;  // next nonce to use
  uint64_t fee = 0;    // wei: 0G eth_gasPrice; Arkiv baseFee × 1.2 + tip (what the online path would pay)
  uint64_t tip = 0;    // wei: 0G = gas price (as ethers); Arkiv eth_maxPriorityFeePerGas
};
struct Cache {
  ChainCache og, arkiv;
  Bytes pricePerSector;  // 0G Storage market price, big-endian
  std::string flow;      // 0G Storage Flow contract
  std::string at;        // ISO time of the last refresh
};
std::string cacheJson(const Cache& c);
bool parseCache(const std::string& json, Cache& c);
/**
 * Online: pending nonces (never below `minOg`/`minArkiv`, the next nonces still reserved by bundles in the outbox),
 * fees, Flow + price per sector. False (+ err) when the 0G chain RPC does not answer; Arkiv/storage are best-effort.
 */
bool refreshCache(orch::Platform& p, const publish::Config& c, const eth::Key& k, Cache& cache, std::string& err,
                  uint64_t minOg = 0, uint64_t minArkiv = 0);

// ---------------------------------------------------------------- building
struct Limits {  // same constants as the TS relay side (6 Nov 2026)
  uint64_t gasStorage = 800000, gasAnchor = 400000, gasArkiv = 600000;  // generous fixed limits per purpose
  uint64_t ogFloorWei = 10000000000ULL;     // maxFeePerGas floors: 10 gwei Galileo, 2 gwei Arkiv
  uint64_t arkivFloorWei = 2000000000ULL;
  uint64_t ogDefaultTipWei = 2000000000ULL;  // Galileo tip ≥ 2 gwei
};
struct Built {
  std::string bundleId, sig, json;  // json: canonical, with sig
  uint64_t ogNext = 0, arkivNext = 0;  // next nonces after this bundle (0 = chain not used)
  size_t txs = 0;
};
/**
 * Builds and signs the bundle of a closed run (spec §1). `frames`: decision idx → locked frame bytes. Consumes nonces
 * from `cache` (the caller persists it). `salt16`: the Arkiv entity salt (random on the board).
 */
bool build(const publish::Config& c, const eth::Key& k, const orch::Result& r, const std::vector<std::pair<size_t, Bytes>>& frames,
           const std::string& createdAt, const Bytes& salt16, Cache& cache, const Limits& lim, Built& out, std::string& err);

/** 0x + sha256(canonical(bundle without "sig")). */
std::string idOf(JsonVariantConst bundle);
inline std::string bundleMessage(const std::string& bundleId) { return "pearl/bundle/v1|" + bundleId; }

// ---------------------------------------------------------------- signed ping (§5)
std::string pingMessage(const std::string& deviceAddress, const std::string& episodeId, const std::string& outcome, int severity,
                        const std::string& headHash0x, uint64_t ts);
std::string pingJson(const eth::Key& k, const std::string& episodeId, const std::string& outcome, int severity, const std::string& headHash0x, uint64_t ts);
/** "abc…" or "0xabc…" → "0xabc…" (lower case). */
std::string hex0x(const std::string& h);

// ---------------------------------------------------------------- BLE data reads (§4)
struct Source {
  virtual ~Source() = default;
  /** Bytes of bundle `id` at `off` (up to n); 0 at/after the end or when the bundle is unknown. */
  virtual size_t read(const std::string& id, size_t off, uint8_t* out, size_t n) = 0;
  /** Mesh payloads (§7), snapshotted when selected: "LIST", "RECEIPTS", "PINGS" (an extension: all kept pings). */
  virtual std::string listing(const std::string& what) { return "[]"; }
};
constexpr size_t CHUNK_MAX = 512;
bool validId(const std::string& id);
class Cursor {
 public:
  /** `select` write: "<bundleId> <offset>", "LIST <offset>", "RECEIPTS <offset>" or "PINGS <offset>" (offset
   *  optional, default 0). A listing is snapshotted from `s` here, so its pages stay consistent. False if malformed. */
  bool select(const std::string& text, Source& s);
  /** One `data` read: up to max bytes at the current offset, then the offset advances; 0 = end (or nothing selected). */
  size_t next(Source& s, uint8_t* out, size_t max = CHUNK_MAX);
  const std::string& id() const { return id_; }
  size_t offset() const { return off_; }

 private:
  std::string id_;  // a bundle id, or LIST / RECEIPTS / PINGS
  std::string snap_;
  size_t off_ = 0;
};

// ---------------------------------------------------------------- outbox index
struct Entry {
  std::string bundleId, episodeId, outcome;
  int severity = 0;
  size_t size = 0;
  uint64_t seq = 0;              // creation order (= nonce order)
  std::string state = "queued";  // queued | posted (laptop relay has it) | relayed (a courier said done; unverified)
  uint64_t ogNext = 0, arkivNext = 0;
  std::string relay;  // relay base URL when posted
};
std::string entryJson(const Entry& e);
bool parseEntry(const std::string& json, Entry& e);
class Index {
 public:
  std::vector<Entry> list;
  void add(const Entry& e);
  bool remove(const std::string& id);
  Entry* find(const std::string& id);
  /** Oldest first (submit order). */
  std::vector<Entry> ordered() const;
  size_t bytes() const;
  bool fits(size_t size, size_t cap) const { return bytes() + size <= cap; }
  uint8_t pending() const { return static_cast<uint8_t>(list.size() > 255 ? 255 : list.size()); }
  uint8_t maxSeverity() const;
  uint64_t nextOg() const;
  uint64_t nextArkiv() const;
  /** The BLE `info` value: {v,device,deviceId,pending:[…]} ≤ maxBytes, ≤ maxEntries; not-yet-relayed first, oldest first. */
  std::string infoJson(const std::string& device, const std::string& deviceId, size_t carrying = 0, size_t delivered = 0,
                       size_t maxBytes = 512, size_t maxEntries = 6) const;
};

// ---------------------------------------------------------------- the robot's own submitter (back online)
struct Step {
  std::string purpose, txHash, status, error;  // status: ok | failed | stale
};
struct Submitted {
  std::string state;  // done | failed (mined but reverted: final) | stale (re-sign) | retry (network: keep, try later)
  std::vector<Step> steps;
};
/**
 * Spec §2 on the robot itself: each tx in order (already mined/known counts as sent), receipts, and after each storage
 * tx the file's segment. `meta` gets the same shape publishRun writes, so the dashboard shows the run as published.
 */
Submitted submit(orch::Platform& p, const publish::Config& c, JsonVariantConst bundle, JsonDocument& meta);

}  // namespace pearl::bundle
