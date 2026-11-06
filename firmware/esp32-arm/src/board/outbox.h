// env:device — the offline relay's storage on the board (spec v1): the robot's own outbox of sealed bundles
// (/outbox, oldest first = nonce order, cap PEARL_OUTBOX_CAP), the mesh carry store of other robots' bundles
// (/carry, verified before accepted, policy in pearl/mesh), delivered receipts, verified ping gossip and the
// nonce/fee cache (NVS). Thread-safe: the run task, the mesh task and BLE callbacks all use it; the in-memory index is
// behind one mutex and file I/O happens outside it.
#pragma once
#include <string>
#include <vector>
#include "pearl/bundle.h"
#include "pearl/mesh.h"

namespace outbox {

bool begin(const std::string& selfAddress, const std::string& deviceId);

// ---- nonce/fee cache (NVS)
pearl::bundle::Cache cache();
void saveCache(const pearl::bundle::Cache& c);

// ---- the robot's own bundles
bool addOwn(const pearl::bundle::Built& b, const std::string& episodeId, const std::string& outcome, int severity, std::string& err);
std::vector<pearl::bundle::Entry> own();  // oldest first
bool loadJson(const std::string& bundleId, std::string& json);  // own or carried
void removeOwn(const std::string& bundleId);
void setOwnState(const std::string& bundleId, const std::string& state, const std::string& relay = "");
bool hasOwn(const std::string& bundleId);
uint64_t nextOg();
uint64_t nextArkiv();

// ---- carried bundles (mesh)
/** Verifies (§1) and admits per policy; writes the bundle. `hops` = hops this copy has travelled. */
pearl::mesh::Admit offerCarry(const std::string& json, int hops, std::string& why);
/** Quick pre-check from a peer's LIST entry, before downloading. */
bool wantsCarry(const pearl::mesh::ListItem& li);
std::vector<pearl::mesh::Carried> carried();  // priority order
void deliveredCarried(const std::string& bundleId, const std::string& anchorTx, uint64_t chainId);
void dropCarried(const std::string& bundleId);
/** A peer/courier said done (unverified): own → "relayed"; carried → stop forwarding. Never deletes. */
void unverifiedDone(const std::string& bundleId);
void expire();

// ---- pings (gossip)
void addPing(const std::string& json);
std::string pingsJson(size_t maxBytes);

// ---- what BLE serves
std::string info();
std::string listing(const std::string& what);  // LIST | RECEIPTS | PINGS
size_t read(const std::string& bundleId, size_t off, uint8_t* out, size_t n);
uint8_t advPending();
uint8_t advMaxSeverity();
/** Bumped on every change (advertising refresh). */
uint32_t version();
std::string statusJson();  // GET /api/outbox

}  // namespace outbox
