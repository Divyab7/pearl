#include "mesh.h"
#include <algorithm>
#include <cstring>
#include "chain.h"
#include "json.h"

namespace pearl::mesh {

static std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return s;
}

// ---------------------------------------------------------------- verification
bool verify(JsonVariantConst b, const Chains& chains, Verified& out, std::string& err) {
  if ((b["v"] | 0) != 1 || std::string(b["type"] | "") != "pearl.bundle") {
    err = "not a pearl.bundle v1";
    return false;
  }
  std::string device = b["device"] | "";
  Bytes devB;
  if (device.size() != 42 || !fromHex(device, devB) || devB.size() != 20) {
    err = "bad device address";
    return false;
  }
  out.device = eth::checksumAddress(devB.data());
  out.episodeId = b["episodeId"] | "";
  if (out.episodeId.empty() || out.episodeId.size() > 64) {
    err = "bad episodeId";
    return false;
  }
  out.bundleId = bundle::idOf(b);
  std::string signer = eth::recoverPersonal(bundle::bundleMessage(out.bundleId), b["sig"] | "");
  if (signer.empty() || lower(signer) != lower(device)) {
    err = "bundle signature does not recover to its device";
    return false;
  }
  out.outcome = b["summary"]["outcome"] | "";
  out.severity = b["summary"]["severity"] | 0;
  out.incident = b["summary"]["incident"] | false;
  out.createdAtMs = isoToEpochMs(b["createdAt"] | "");
  if (!out.createdAtMs) {
    err = "bad createdAt";
    return false;
  }
  // files: bytes match their 0G Storage root
  JsonArrayConst files = b["files"].as<JsonArrayConst>();
  std::vector<Bytes> fileBytes;
  for (JsonVariantConst f : files) {
    Bytes data;
    if (!unbase64(f["data"] | "", data) || data.empty() || data.size() != (f["size"] | 0u) || data.size() > chain::CHUNK * chain::SEGMENT_CHUNKS) {
      err = "file " + std::to_string(fileBytes.size()) + ": bad data or size";
      return false;
    }
    if (lower(f["root"] | "") != to0x(chain::storageRoot(data))) {
      err = "file " + std::to_string(fileBytes.size()) + ": root does not match its bytes";
      return false;
    }
    if (std::string(f["role"] | "") == "log" && lower(b["summary"]["rootHash"] | "") != lower(f["root"] | "")) {
      err = "summary.rootHash is not the log's root";
      return false;
    }
    fileBytes.push_back(std::move(data));
  }
  // txs: well-formed, sent by the device, on an expected chain, nonces ascending per chain, hash as stated
  JsonArrayConst txs = b["txs"].as<JsonArrayConst>();
  if (txs.size() == 0 || txs.size() > 64) {
    err = "no transactions";
    return false;
  }
  uint64_t lastNonce[2] = {0, 0};
  bool seen[2] = {false, false};
  for (JsonVariantConst t : txs) {
    std::string purpose = t["purpose"] | "";
    Bytes raw;
    chain::DecodedTx d;
    if (!fromHex(t["raw"] | "", raw) || !chain::decodeEip1559(raw, d)) {
      err = purpose + ": not a signed type-2 transaction";
      return false;
    }
    if (memcmp(d.from, devB.data(), 20) != 0) {
      err = purpose + ": sender is not the bundle's device";
      return false;
    }
    if (lower(t["hash"] | "") != to0x(d.hash)) {
      err = purpose + ": hash does not match raw";
      return false;
    }
    int ci = d.tx.chainId == chains.og ? 0 : d.tx.chainId == chains.arkiv ? 1 : -1;
    if (ci < 0 || (t["chainId"] | 0ULL) != d.tx.chainId) {
      err = purpose + ": unexpected chainId " + std::to_string(d.tx.chainId);
      return false;
    }
    if ((t["nonce"] | 0ULL) != d.tx.nonce || (seen[ci] && d.tx.nonce <= lastNonce[ci])) {
      err = purpose + ": nonce out of order";
      return false;
    }
    seen[ci] = true;
    lastNonce[ci] = d.tx.nonce;
    if (purpose.rfind("storage:", 0) == 0) {
      int fi = t["file"] | -1;
      if (fi < 0 || static_cast<size_t>(fi) >= fileBytes.size() || ci != 0) {
        err = purpose + ": no such file";
        return false;
      }
      const Bytes& file = fileBytes[fi];
      if (d.tx.data != chain::submitCalldata(file.size(), chain::submissionNodes(file), devB)) {
        err = purpose + ": submit calldata does not match the file";
        return false;
      }
    }
    if (purpose == "anchor") {
      out.anchorTx = to0x(d.hash);
      out.anchorChainId = d.tx.chainId;
    }
    out.lastTx = to0x(d.hash);
    out.lastChainId = d.tx.chainId;
  }
  return true;
}

// ---------------------------------------------------------------- carry store
const char* admitName(Admit a) {
  switch (a) {
    case Admit::OK: return "ok";
    case Admit::INVALID: return "invalid";
    case Admit::DUPLICATE: return "duplicate";
    case Admit::DELIVERED: return "already delivered";
    case Admit::OWN: return "own bundle";
    case Admit::EXPIRED: return "expired";
    case Admit::HOPS: return "too many hops";
    case Admit::TOO_BIG: return "bigger than the per-origin cap";
    case Admit::NO_ROOM: return "no room (everything kept outranks it)";
  }
  return "?";
}

std::string carriedJson(const Carried& c) {
  JsonDocument d;
  d["bundleId"] = c.bundleId;
  d["origin"] = c.origin;
  d["episodeId"] = c.episodeId;
  d["outcome"] = c.outcome;
  d["severity"] = c.severity;
  d["size"] = c.size;
  d["createdAtMs"] = c.createdAtMs;
  d["receivedAtMs"] = c.receivedAtMs;
  d["hops"] = c.hops;
  d["forward"] = c.forward;
  d["proofTx"] = c.proofTx;
  d["proofChainId"] = c.proofChainId;
  std::string s;
  serializeJson(d, s);
  return s;
}

bool parseCarried(const std::string& json, Carried& c) {
  JsonDocument d;
  if (deserializeJson(d, json)) return false;
  c.bundleId = d["bundleId"] | "";
  c.origin = d["origin"] | "";
  c.episodeId = d["episodeId"] | "";
  c.outcome = d["outcome"] | "";
  c.severity = d["severity"] | 0;
  c.size = d["size"] | 0;
  c.createdAtMs = d["createdAtMs"] | 0ULL;
  c.receivedAtMs = d["receivedAtMs"] | 0ULL;
  c.hops = d["hops"] | 1;
  c.forward = d["forward"] | true;
  c.proofTx = d["proofTx"] | "";
  c.proofChainId = d["proofChainId"] | 0ULL;
  return bundle::validId(c.bundleId);
}

bool Carry::before(const Carried& a, const Carried& b) {
  if (a.severity != b.severity) return a.severity > b.severity;
  if (a.createdAtMs != b.createdAtMs) return a.createdAtMs < b.createdAtMs;
  return a.bundleId < b.bundleId;
}

std::vector<Carried> Carry::ordered() const {
  std::vector<Carried> v = items;
  std::sort(v.begin(), v.end(), before);
  return v;
}

size_t Carry::bytes() const {
  size_t n = 0;
  for (const Carried& c : items) n += c.size;
  return n;
}
size_t Carry::bytesOf(const std::string& origin) const {
  size_t n = 0;
  for (const Carried& c : items)
    if (c.origin == origin) n += c.size;
  return n;
}

Admit Carry::admit(const Carried& c, uint64_t now, const std::string& self, std::vector<std::string>& evict) const {
  evict.clear();
  if (lower(c.origin) == lower(self)) return Admit::OWN;
  for (const Carried& x : items)
    if (x.bundleId == c.bundleId) return Admit::DUPLICATE;
  if (hasReceipt(c.bundleId)) return Admit::DELIVERED;
  if (c.createdAtMs + pol.ttlMs <= now) return Admit::EXPIRED;
  if (c.hops > pol.maxHops) return Admit::HOPS;
  if (c.size > pol.perOrigin || c.size > pol.cap) return Admit::TOO_BIG;
  // make room, lowest priority first, only with bundles the newcomer outranks
  std::vector<Carried> v = ordered();
  size_t total = bytes(), mine = bytesOf(c.origin);
  for (auto it = v.rbegin(); it != v.rend() && mine + c.size > pol.perOrigin; ++it) {
    if (it->origin != c.origin) continue;
    if (!before(c, *it)) return Admit::NO_ROOM;
    evict.push_back(it->bundleId);
    mine -= it->size;
    total -= it->size;
  }
  for (auto it = v.rbegin(); it != v.rend() && total + c.size > pol.cap; ++it) {
    if (std::find(evict.begin(), evict.end(), it->bundleId) != evict.end()) continue;
    if (!before(c, *it)) {
      evict.clear();
      return Admit::NO_ROOM;
    }
    evict.push_back(it->bundleId);
    total -= it->size;
  }
  return Admit::OK;
}

void Carry::add(const Carried& c) {
  remove(c.bundleId);
  items.push_back(c);
  if (c.hops >= pol.maxHops) items.back().forward = false;  // last hop: kept (and submitted when online), not forwarded
}
bool Carry::remove(const std::string& id) {
  auto it = std::remove_if(items.begin(), items.end(), [&](const Carried& c) { return c.bundleId == id; });
  bool any = it != items.end();
  items.erase(it, items.end());
  return any;
}
Carried* Carry::find(const std::string& id) {
  for (Carried& c : items)
    if (c.bundleId == id) return &c;
  return nullptr;
}
bool Carry::hasReceipt(const std::string& id) const {
  for (const Receipt& r : receipts)
    if (r.bundleId == id) return true;
  return false;
}
void Carry::delivered(const std::string& id, const std::string& anchorTx, uint64_t chainId, uint64_t now) {
  remove(id);
  if (!hasReceipt(id)) receipts.push_back({id, anchorTx, chainId, now});
}
bool Carry::stopForward(const std::string& id) {
  Carried* c = find(id);
  if (!c || !c->forward) return false;
  c->forward = false;
  return true;
}
std::vector<std::string> Carry::expire(uint64_t now) {
  std::vector<std::string> gone;
  for (const Carried& c : items)
    if (c.createdAtMs + pol.ttlMs <= now) gone.push_back(c.bundleId);
  for (const std::string& id : gone) remove(id);
  receipts.erase(std::remove_if(receipts.begin(), receipts.end(), [&](const Receipt& r) { return r.atMs + pol.ttlMs <= now; }), receipts.end());
  return gone;
}
size_t Carry::forwardable() const {
  size_t n = 0;
  for (const Carried& c : items) n += c.forward ? 1 : 0;
  return n;
}
uint8_t Carry::maxSeverity() const {
  int m = 0;
  for (const Carried& c : items)
    if (c.forward) m = std::max(m, c.severity);
  return static_cast<uint8_t>(std::min(m, 255));
}

// ---------------------------------------------------------------- LIST / RECEIPTS
std::string listJson(const bundle::Index& own, const std::string& self, const Carry& carry) {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (const bundle::Entry& e : own.ordered()) {
    JsonObject o = a.add<JsonObject>();
    o["bundleId"] = e.bundleId;
    o["origin"] = lower(self);
    o["episodeId"] = e.episodeId;
    o["size"] = e.size;
    o["severity"] = e.severity;
    o["outcome"] = e.outcome;
    o["hops"] = 0;
    o["own"] = true;
  }
  for (const Carried& c : carry.ordered()) {
    if (!c.forward) continue;
    JsonObject o = a.add<JsonObject>();
    o["bundleId"] = c.bundleId;
    o["origin"] = c.origin;
    o["episodeId"] = c.episodeId;
    o["size"] = c.size;
    o["severity"] = c.severity;
    o["outcome"] = c.outcome;
    o["hops"] = c.hops;
    o["own"] = false;
  }
  std::string s;
  serializeJson(d, s);
  return s;
}

bool parseList(const std::string& json, std::vector<ListItem>& out) {
  JsonDocument d;
  if (deserializeJson(d, json) || !d.is<JsonArray>()) return false;
  out.clear();
  for (JsonObjectConst o : d.as<JsonArrayConst>()) {
    ListItem li;
    li.bundleId = bundle::hex0x(o["bundleId"] | "");
    if (!bundle::validId(li.bundleId)) continue;
    li.origin = lower(o["origin"] | "");
    li.episodeId = o["episodeId"] | "";
    li.outcome = o["outcome"] | "";
    li.size = o["size"] | 0;
    li.severity = o["severity"] | 0;
    li.hops = o["hops"] | 0;
    li.own = o["own"] | false;
    out.push_back(li);
  }
  return true;
}

std::string receiptsJson(const Carry& carry) {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (const Receipt& r : carry.receipts) {
    JsonObject o = a.add<JsonObject>();
    o["bundleId"] = r.bundleId;
    o["anchorTx"] = r.anchorTx;
    o["chainId"] = r.chainId;
  }
  std::string s;
  serializeJson(d, s);
  return s;
}

bool parseReceipts(const std::string& json, std::vector<Receipt>& out) {
  JsonDocument d;
  if (deserializeJson(d, json) || !d.is<JsonArray>()) return false;
  out.clear();
  for (JsonObjectConst o : d.as<JsonArrayConst>()) {
    Receipt r;
    r.bundleId = bundle::hex0x(o["bundleId"] | "");
    r.anchorTx = o["anchorTx"] | "";
    r.chainId = o["chainId"] | 0ULL;
    if (bundle::validId(r.bundleId)) out.push_back(r);
  }
  return true;
}

// ---------------------------------------------------------------- pings
bool verifyPing(const std::string& json, Ping& out) {
  JsonDocument d;
  if (json.size() > 1024 || deserializeJson(d, json) || (d["v"] | 0) != 1) return false;
  out.device = d["device"] | "";
  out.episodeId = d["episodeId"] | "";
  out.severity = d["severity"] | 0;
  out.ts = d["ts"] | 0ULL;
  std::string msg = bundle::pingMessage(out.device, out.episodeId, d["outcome"] | "", out.severity, d["headHash"] | "", out.ts);
  std::string signer = eth::recoverPersonal(msg, d["sig"] | "");
  if (signer.empty() || lower(signer) != lower(out.device)) return false;
  out.json.clear();
  serializeJson(d, out.json);  // compact
  return true;
}

bool Pings::add(const std::string& json) {
  Ping p;
  if (!verifyPing(json, p)) return false;
  for (Ping& q : list)
    if (lower(q.device) == lower(p.device) && q.episodeId == p.episodeId) {
      if (p.ts > q.ts) q = p;
      return true;
    }
  list.push_back(p);
  std::stable_sort(list.begin(), list.end(), [](const Ping& a, const Ping& b) { return a.severity != b.severity ? a.severity > b.severity : a.ts > b.ts; });
  if (list.size() > max) list.resize(max);
  return true;
}

std::string Pings::json(size_t maxBytes) const {
  std::string s = "[";
  for (const Ping& p : list) {
    size_t add = p.json.size() + (s.size() > 1 ? 1 : 0);
    if (maxBytes && s.size() + add + 1 > maxBytes) break;
    if (s.size() > 1) s += ",";
    s += p.json;
  }
  return s + "]";
}

}  // namespace pearl::mesh
