// Mesh (spec §7): robots carry each other's sealed bundles store-and-forward over BLE. Nothing is trusted: a bundle is
// accepted only if it verifies (§1: signature recovers to its device, every tx is sent by that device on an expected
// chain, every file matches its 0G Storage root and its submit calldata). The carry store's policy (dedupe, 4 MB total,
// 1 MB per origin, TTL 7 days, ≤ 8 hops, incidents first), delivered receipts, verified ping gossip and the LIST /
// RECEIPTS payloads live here, portable, so the host tests pin them down; the board only adds files and radio.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include <vector>
#include "bundle.h"

namespace pearl::mesh {

// ---------------------------------------------------------------- §1 verification
struct Verified {
  std::string bundleId, device, episodeId, outcome;  // device: EIP-55
  int severity = 0;
  bool incident = false;
  uint64_t createdAtMs = 0;
  std::string anchorTx;  // hash of the "anchor" tx ("" if none) …
  uint64_t anchorChainId = 0;
  std::string lastTx;    // … else the last tx: what proves delivery
  uint64_t lastChainId = 0;
};
struct Chains {
  uint64_t og = 16602, arkiv = 7794095;
};
/** Everything a relayer must check before carrying or submitting someone else's bundle. */
bool verify(JsonVariantConst bundle, const Chains& chains, Verified& out, std::string& err);

// ---------------------------------------------------------------- carry store policy
struct Carried {
  std::string bundleId, origin, episodeId, outcome;  // origin: the device address, lower case
  int severity = 0;
  size_t size = 0;
  uint64_t createdAtMs = 0, receivedAtMs = 0;
  int hops = 1;          // local metadata: hops this copy travelled (the bundle itself is unchanged)
  bool forward = true;   // false once a peer/courier said "done" (unverified): kept until we verify on-chain
  std::string proofTx;   // anchor tx (or last tx) and its chain: checked on-chain once online
  uint64_t proofChainId = 0;
};
struct Receipt {
  std::string bundleId, anchorTx;
  uint64_t chainId = 0, atMs = 0;
};
struct Policy {
  size_t cap = 4u << 20, perOrigin = 1u << 20;
  uint64_t ttlMs = 7ULL * 24 * 3600 * 1000;
  int maxHops = 8;
};
enum class Admit { OK, INVALID, DUPLICATE, DELIVERED, OWN, EXPIRED, HOPS, TOO_BIG, NO_ROOM };
const char* admitName(Admit a);

std::string carriedJson(const Carried& c);
bool parseCarried(const std::string& json, Carried& c);

class Carry {
 public:
  Policy pol;
  std::vector<Carried> items;
  std::vector<Receipt> receipts;
  /** Priority: incidents first (severity desc), then oldest first. */
  static bool before(const Carried& a, const Carried& b);
  std::vector<Carried> ordered() const;
  /** Would `c` be accepted at `now`? `evict` gets the ids to drop first (lower priority, to respect the caps). */
  Admit admit(const Carried& c, uint64_t now, const std::string& selfDevice, std::vector<std::string>& evict) const;
  void add(const Carried& c);
  bool remove(const std::string& id);
  Carried* find(const std::string& id);
  bool hasReceipt(const std::string& id) const;
  /** Verified on-chain: drop the bundle, keep the receipt (gossiped for TTL). */
  void delivered(const std::string& id, const std::string& anchorTx, uint64_t chainId, uint64_t now);
  /** An unverified "done" (ack or a peer's receipt): stop forwarding, keep until verified. */
  bool stopForward(const std::string& id);
  /** Drops expired bundles and receipts; returns the dropped bundle ids (their files must go too). */
  std::vector<std::string> expire(uint64_t now);
  size_t bytes() const;
  size_t bytesOf(const std::string& origin) const;
  size_t forwardable() const;
  uint8_t maxSeverity() const;
};

// ---------------------------------------------------------------- LIST / RECEIPTS payloads
struct ListItem {
  std::string bundleId, origin, episodeId, outcome;
  size_t size = 0;
  int severity = 0, hops = 0;
  bool own = false;
};
/** Everything this node serves: own outbox (nonce order), then forwardable carried bundles (priority order). */
std::string listJson(const bundle::Index& own, const std::string& selfDevice, const Carry& carry);
bool parseList(const std::string& json, std::vector<ListItem>& out);
std::string receiptsJson(const Carry& carry);
bool parseReceipts(const std::string& json, std::vector<Receipt>& out);

// ---------------------------------------------------------------- ping gossip
struct Ping {
  std::string json, device, episodeId;
  int severity = 0;
  uint64_t ts = 0;
};
/** A §5 ping whose signature recovers to its device. */
bool verifyPing(const std::string& json, Ping& out);
class Pings {
 public:
  size_t max = 8;
  std::vector<Ping> list;  // severity desc, then newest
  /** Verifies and keeps it (newest per device + episode); false if invalid. */
  bool add(const std::string& json);
  /** JSON array of the kept pings, as many as fit in maxBytes (0 = all). */
  std::string json(size_t maxBytes = 0) const;
};

}  // namespace pearl::mesh
