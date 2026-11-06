#include "bundle.h"
#include <algorithm>
#include <cstring>
#include "chain.h"
#include "json.h"

namespace pearl::bundle {

using publish::rpc;

static uint64_t u64(const Bytes& b) {
  uint64_t v = 0;
  for (uint8_t x : eth::stripZeros(b)) v = v << 8 | x;
  return v;
}

std::string hex0x(const std::string& h) {
  std::string s = h.rfind("0x", 0) == 0 || h.rfind("0X", 0) == 0 ? h.substr(2) : h;
  for (char& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return "0x" + s;
}

// ---------------------------------------------------------------- cache
static void chainOut(JsonObject o, const ChainCache& c) {
  o["known"] = c.known;
  o["nonce"] = c.nonce;
  o["fee"] = c.fee;
  o["tip"] = c.tip;
}
static void chainIn(JsonObjectConst o, ChainCache& c) {
  c.known = o["known"] | false;
  c.nonce = o["nonce"] | 0ULL;
  c.fee = o["fee"] | 0ULL;
  c.tip = o["tip"] | 0ULL;
}

std::string cacheJson(const Cache& c) {
  JsonDocument d;
  chainOut(d["og"].to<JsonObject>(), c.og);
  chainOut(d["arkiv"].to<JsonObject>(), c.arkiv);
  d["pricePerSector"] = to0x(c.pricePerSector);
  d["flow"] = c.flow;
  d["at"] = c.at;
  std::string s;
  serializeJson(d, s);
  return s;
}

bool parseCache(const std::string& json, Cache& c) {
  JsonDocument d;
  if (deserializeJson(d, json) || !d.is<JsonObject>()) return false;
  chainIn(d["og"], c.og);
  chainIn(d["arkiv"], c.arkiv);
  c.pricePerSector.clear();
  fromHex(d["pricePerSector"] | "0x", c.pricePerSector);
  c.flow = d["flow"] | "";
  c.at = d["at"] | "";
  return true;
}

static bool pendingNonce(orch::Platform& p, const std::string& url, const eth::Key& k, uint64_t& n, std::string& err) {
  JsonDocument par, res;
  JsonArray a = par.to<JsonArray>();
  a.add(k.address);
  a.add("pending");
  if (!rpc(p, url, "eth_getTransactionCount", par.as<JsonVariantConst>(), res, err, 10000)) return false;
  n = publish::hexU64(res.as<JsonVariantConst>());
  return true;
}

bool refreshCache(orch::Platform& p, const publish::Config& c, const eth::Key& k, Cache& cache, std::string& err, uint64_t minOg, uint64_t minArkiv) {
  uint64_t n = 0;
  JsonDocument none, res;
  if (!pendingNonce(p, c.chainRpc, k, n, err)) return false;
  if (!rpc(p, c.chainRpc, "eth_gasPrice", none.as<JsonVariantConst>(), res, err, 10000)) return false;
  cache.og.known = true;
  cache.og.nonce = std::max(n, minOg);
  cache.og.fee = u64(publish::hexBytes(res.as<JsonVariantConst>()));
  cache.og.tip = cache.og.fee;
  if (c.arkivOn && !c.arkivRpc.empty()) {
    std::string e;
    uint64_t an = 0;
    if (pendingNonce(p, c.arkivRpc, k, an, e) && rpc(p, c.arkivRpc, "eth_maxPriorityFeePerGas", none.as<JsonVariantConst>(), res, e, 10000)) {
      uint64_t tip = u64(publish::hexBytes(res.as<JsonVariantConst>()));
      JsonDocument bp;
      JsonArray ba = bp.to<JsonArray>();
      ba.add("latest");
      ba.add(false);
      if (rpc(p, c.arkivRpc, "eth_getBlockByNumber", bp.as<JsonVariantConst>(), res, e, 10000)) {
        cache.arkiv.known = true;
        cache.arkiv.nonce = std::max(an, minArkiv);
        cache.arkiv.tip = tip;
        cache.arkiv.fee = u64(publish::mulDiv(publish::hexBytes(res["baseFeePerGas"]), 12, 10)) + tip;
      }
    }
  }
  if (c.storageOn && !c.storageNodes.empty()) {
    publish::StorageNet net;
    std::string e;
    Bytes price;
    if (publish::discoverStorage(p, c, net, e) && publish::storagePrice(p, c, net.flow, price, e)) {
      cache.flow = net.flow;
      cache.pricePerSector = price;
    }
  }
  cache.at = p.nowIso();
  return true;
}

// ---------------------------------------------------------------- building
static void fees(const ChainCache& cc, uint64_t floor, uint64_t defaultTip, chain::Eip1559Tx& tx) {
  uint64_t tip = std::max(cc.tip, defaultTip);  // Galileo needs ≥ 2 gwei; Arkiv: no minimum
  uint64_t maxFee = std::max(cc.fee * 3, floor);
  maxFee = std::max(maxFee, tip);
  tx.maxPriorityFeePerGas = eth::uintBytes(tip);
  tx.maxFeePerGas = eth::uintBytes(maxFee);
}

static bool addTx(const eth::Key& k, chain::Eip1559Tx& tx, const char* chainName, const std::string& purpose, JsonArray txs, int fileIdx,
                  std::string& hashOut, std::string& err) {
  Bytes raw, hash;
  if (!chain::signEip1559(k, tx, raw, hash)) {
    err = "signing " + purpose + " failed";
    return false;
  }
  JsonObject o = txs.add<JsonObject>();
  o["chain"] = chainName;
  o["chainId"] = tx.chainId;
  o["purpose"] = purpose;
  o["nonce"] = tx.nonce;
  o["hash"] = to0x(hash);
  o["raw"] = to0x(raw);
  if (fileIdx >= 0) o["file"] = fileIdx;
  hashOut = to0x(hash);
  return true;
}

bool build(const publish::Config& c, const eth::Key& k, const orch::Result& r, const std::vector<std::pair<size_t, Bytes>>& frames,
           const std::string& createdAt, const Bytes& salt16, Cache& cache, const Limits& lim, Built& out, std::string& err) {
  bool storage = c.storageOn && !c.storageNodes.empty();
  bool anchor = c.anchorOn && !c.anchorAddress.empty();
  bool arkiv = c.arkivOn && !c.arkivRpc.empty();
  // never pre-sign a partial run (e.g. an anchor without its file): wait until the cache has what is configured
  if ((storage || anchor) && !cache.og.known) {
    err = "no cached 0G nonce (the robot has not been online since it was flashed)";
    return false;
  }
  if (storage && (cache.flow.empty() || cache.pricePerSector.empty())) {
    err = "no cached 0G Storage price (storage nodes not reached while online)";
    return false;
  }
  if (arkiv && !cache.arkiv.known) {
    err = "no cached Arkiv nonce (Arkiv not reached while online)";
    return false;
  }
  Bytes log = utf8(r.sealedCanonical);
  std::string logRoot = to0x(chain::storageRoot(log));
  JsonDocument d;
  d["v"] = 1;
  d["type"] = "pearl.bundle";
  d["episodeId"] = r.episodeId;
  d["device"] = k.address;
  d["createdAt"] = createdAt;
  JsonObject sum = d["summary"].to<JsonObject>();
  sum["outcome"] = r.outcome;
  sum["incident"] = r.incident;
  sum["severity"] = r.severity;
  sum["headHash"] = hex0x(r.headHash);
  sum["rootHash"] = logRoot;
  JsonArray files = d["files"].to<JsonArray>();
  JsonArray txs = d["txs"].to<JsonArray>();
  uint64_t ogNonce = cache.og.nonce, arkivNonce = cache.arkiv.nonce;
  Bytes submitter(k.addr, k.addr + 20);
  std::string storageTx, anchorTx, root;
  auto storageTxFor = [&](const Bytes& file, const std::string& purpose, JsonObject f, std::string& hash) -> bool {
    if (file.empty() || file.size() > chain::CHUNK * chain::SEGMENT_CHUNKS) {
      err = purpose + ": file size " + std::to_string(file.size()) + " outside 1..262144 bytes";
      return false;
    }
    f["root"] = to0x(chain::storageRoot(file));
    f["size"] = file.size();
    f["data"] = base64(file);
    chain::Eip1559Tx tx;
    tx.chainId = c.chainId;
    tx.nonce = ogNonce++;
    fees(cache.og, lim.ogFloorWei, lim.ogDefaultTipWei, tx);
    tx.gas = lim.gasStorage;
    fromHex(cache.flow, tx.to);
    // fee: price per sector × padded sectors, +20% headroom (the price may move while the bundle travels)
    tx.value = publish::mulDiv(publish::mulDiv(cache.pricePerSector, chain::paddedChunks(file.size()), 1), 12, 10);
    tx.data = chain::submitCalldata(file.size(), chain::submissionNodes(file), submitter);
    return addTx(k, tx, CHAIN_OG, purpose, txs, static_cast<int>(files.size()) - 1, hash, err);
  };
  if (storage) {
    JsonObject f = files.add<JsonObject>();
    f["role"] = "log";
    if (!storageTxFor(log, "storage:log", f, storageTx)) return false;
    root = logRoot;
    for (const auto& fr : frames) {
      JsonObject ff = files.add<JsonObject>();
      ff["role"] = "frame";
      ff["idx"] = fr.first;
      std::string h;
      if (!storageTxFor(fr.second, "storage:frame:" + std::to_string(fr.first), ff, h)) return false;
    }
  }
  if (anchor) {
    chain::Eip1559Tx tx;
    tx.chainId = c.chainId;
    tx.nonce = ogNonce++;
    fees(cache.og, lim.ogFloorWei, lim.ogDefaultTipWei, tx);
    tx.gas = lim.gasAnchor;
    fromHex(c.anchorAddress, tx.to);
    tx.data = publish::anchorData(r, root);
    if (!addTx(k, tx, CHAIN_OG, "anchor", txs, -1, anchorTx, err)) return false;
  }
  if (arkiv) {
    chain::Eip1559Tx tx;
    tx.chainId = c.arkivChainId;
    tx.nonce = arkivNonce++;
    fees(cache.arkiv, lim.arkivFloorWei, 0, tx);  // tip as cached (viem)
    tx.gas = lim.gasArkiv;
    fromHex(chain::ARKIV_PROCESSOR, tx.to);
    tx.data = publish::arkivData(c, r, root, storageTx, anchorTx, salt16);
    std::string h;
    if (!addTx(k, tx, CHAIN_ARKIV, "arkiv", txs, -1, h, err)) return false;
  }
  if (txs.size() == 0) {
    err = "nothing to publish (storage, anchor and Arkiv all off or never seen online)";
    return false;
  }
  std::string unsignedJson;
  if (!canonical(d.as<JsonVariantConst>(), unsignedJson)) {
    err = "canonical JSON failed";
    return false;
  }
  out.bundleId = to0x(sha256(utf8(unsignedJson)));
  unsignedJson.clear();
  unsignedJson.shrink_to_fit();
  out.sig = eth::personalSign(k, bundleMessage(out.bundleId));
  d["sig"] = out.sig;
  if (!canonical(d.as<JsonVariantConst>(), out.json)) {
    err = "canonical JSON failed";
    return false;
  }
  out.txs = txs.size();
  out.ogNext = ogNonce != cache.og.nonce ? ogNonce : 0;
  out.arkivNext = arkivNonce != cache.arkiv.nonce ? arkivNonce : 0;
  cache.og.nonce = ogNonce;
  cache.arkiv.nonce = arkivNonce;
  return true;
}

std::string idOf(JsonVariantConst bundle) {
  JsonDocument d;
  d.set(bundle);
  d.remove("sig");
  std::string s;
  if (!canonical(d.as<JsonVariantConst>(), s)) return "";
  return to0x(sha256(utf8(s)));
}

// ---------------------------------------------------------------- ping
std::string pingMessage(const std::string& device, const std::string& episodeId, const std::string& outcome, int severity, const std::string& headHash0x, uint64_t ts) {
  std::string dev = hex0x(device);
  return "pearl/ping/v1|" + dev + "|" + episodeId + "|" + outcome + "|" + std::to_string(severity) + "|" + headHash0x + "|" + std::to_string(ts);
}

std::string pingJson(const eth::Key& k, const std::string& episodeId, const std::string& outcome, int severity, const std::string& headHash, uint64_t ts) {
  std::string head = hex0x(headHash);
  JsonDocument d;
  d["v"] = 1;
  d["device"] = k.address;
  d["episodeId"] = episodeId;
  d["outcome"] = outcome;
  d["severity"] = severity;
  d["headHash"] = head;
  d["ts"] = ts;
  d["sig"] = eth::personalSign(k, pingMessage(k.address, episodeId, outcome, severity, head, ts));
  std::string s;
  serializeJson(d, s);
  return s;
}

// ---------------------------------------------------------------- BLE cursor
bool validId(const std::string& id) {
  if (id.size() != 66 || id[0] != '0' || id[1] != 'x') return false;
  for (size_t i = 2; i < id.size(); i++)
    if (!isxdigit(static_cast<unsigned char>(id[i]))) return false;
  return true;
}

bool Cursor::select(const std::string& text, Source& src) {
  std::string t = text;
  while (!t.empty() && (t.back() == '\n' || t.back() == '\r' || t.back() == ' ' || t.back() == '\0')) t.pop_back();
  size_t sp = t.find(' ');
  std::string head = t.substr(0, sp);
  size_t off = 0;
  if (sp != std::string::npos) {
    std::string n = t.substr(sp + 1);
    if (n.empty() || n.size() > 9) return false;
    for (char ch : n)
      if (ch < '0' || ch > '9') return false;
    off = static_cast<size_t>(strtoul(n.c_str(), nullptr, 10));
  }
  if (head == "LIST" || head == "RECEIPTS" || head == "PINGS") {
    // a fresh snapshot when the listing starts (offset 0) or another one was selected; resumes keep the old pages
    if (id_ != head || off == 0) snap_ = src.listing(head);
    id_ = head;
    off_ = off;
    return true;
  }
  std::string id = hex0x(head);
  if (!validId(id)) return false;
  id_ = id;
  snap_.clear();
  off_ = off;
  return true;
}

size_t Cursor::next(Source& s, uint8_t* out, size_t max) {
  if (id_.empty()) return 0;
  max = std::min(max, CHUNK_MAX);
  size_t n;
  if (id_[0] != '0') {
    n = off_ < snap_.size() ? std::min(max, snap_.size() - off_) : 0;
    if (n) memcpy(out, snap_.data() + off_, n);
  } else
    n = s.read(id_, off_, out, max);
  off_ += n;
  return n;
}

// ---------------------------------------------------------------- outbox index
std::string entryJson(const Entry& e) {
  JsonDocument d;
  d["bundleId"] = e.bundleId;
  d["episodeId"] = e.episodeId;
  d["outcome"] = e.outcome;
  d["severity"] = e.severity;
  d["size"] = e.size;
  d["seq"] = e.seq;
  d["state"] = e.state;
  d["ogNext"] = e.ogNext;
  d["arkivNext"] = e.arkivNext;
  if (!e.relay.empty()) d["relay"] = e.relay;
  std::string s;
  serializeJson(d, s);
  return s;
}

bool parseEntry(const std::string& json, Entry& e) {
  JsonDocument d;
  if (deserializeJson(d, json)) return false;
  e.bundleId = d["bundleId"] | "";
  e.episodeId = d["episodeId"] | "";
  e.outcome = d["outcome"] | "";
  e.severity = d["severity"] | 0;
  e.size = d["size"] | 0;
  e.seq = d["seq"] | 0ULL;
  e.state = d["state"] | "queued";
  e.ogNext = d["ogNext"] | 0ULL;
  e.arkivNext = d["arkivNext"] | 0ULL;
  e.relay = d["relay"] | "";
  return validId(e.bundleId);
}

void Index::add(const Entry& e) {
  remove(e.bundleId);
  list.push_back(e);
}
bool Index::remove(const std::string& id) {
  auto it = std::remove_if(list.begin(), list.end(), [&](const Entry& e) { return e.bundleId == id; });
  bool any = it != list.end();
  list.erase(it, list.end());
  return any;
}
Entry* Index::find(const std::string& id) {
  for (Entry& e : list)
    if (e.bundleId == id) return &e;
  return nullptr;
}
std::vector<Entry> Index::ordered() const {
  std::vector<Entry> v = list;
  std::stable_sort(v.begin(), v.end(), [](const Entry& a, const Entry& b) { return a.seq < b.seq; });
  return v;
}
size_t Index::bytes() const {
  size_t n = 0;
  for (const Entry& e : list) n += e.size;
  return n;
}
uint8_t Index::maxSeverity() const {
  int m = 0;
  for (const Entry& e : list) m = std::max(m, e.severity);
  return static_cast<uint8_t>(std::min(m, 255));
}
uint64_t Index::nextOg() const {
  uint64_t m = 0;
  for (const Entry& e : list) m = std::max(m, e.ogNext);
  return m;
}
uint64_t Index::nextArkiv() const {
  uint64_t m = 0;
  for (const Entry& e : list) m = std::max(m, e.arkivNext);
  return m;
}

std::string Index::infoJson(const std::string& device, const std::string& deviceId, size_t carrying, size_t delivered, size_t maxBytes,
                            size_t maxEntries) const {
  std::vector<Entry> v = ordered();
  std::stable_partition(v.begin(), v.end(), [](const Entry& e) { return e.state != "relayed"; });
  JsonDocument d;
  d["v"] = 1;
  d["device"] = device;
  d["deviceId"] = deviceId;
  d["carrying"] = carrying;
  d["delivered"] = delivered;
  JsonArray p = d["pending"].to<JsonArray>();
  std::string s;
  serializeJson(d, s);
  for (const Entry& e : v) {
    if (p.size() >= maxEntries) break;
    JsonObject o = p.add<JsonObject>();
    o["bundleId"] = e.bundleId;
    o["episodeId"] = e.episodeId;
    o["size"] = e.size;
    o["severity"] = e.severity;
    o["outcome"] = e.outcome;
    std::string t;
    serializeJson(d, t);
    if (t.size() > maxBytes) {
      p.remove(p.size() - 1);
      break;
    }
    s.swap(t);
  }
  return s;
}

// ---------------------------------------------------------------- submitter
static JsonObject frameMeta(JsonDocument& meta, int idx) {
  JsonArray fr = meta["frames"].is<JsonArray>() ? meta["frames"].as<JsonArray>() : meta["frames"].to<JsonArray>();
  for (JsonObject o : fr)
    if ((o["idx"] | -1) == idx) return o;
  JsonObject o = fr.add<JsonObject>();
  o["idx"] = idx;
  return o;
}

Submitted submit(orch::Platform& p, const publish::Config& c, JsonVariantConst b, JsonDocument& meta) {
  Submitted out;
  out.state = "done";
  meta["episodeId"] = b["episodeId"] | "";
  meta["bundleId"] = idOf(b);
  for (const char* part : {"storage", "anchor", "arkiv"})
    if (!meta[part].is<JsonObject>()) meta[part]["status"] = "not_configured";
  publish::StorageNet net;
  bool haveNet = false;
  JsonArrayConst files = b["files"].as<JsonArrayConst>();
  for (JsonVariantConst t : b["txs"].as<JsonArrayConst>()) {
    Step st;
    st.purpose = t["purpose"] | "";
    st.txHash = t["hash"] | "";
    uint64_t chainId = t["chainId"] | 0ULL;
    std::string url = chainId == c.chainId ? c.chainRpc : chainId == c.arkivChainId ? c.arkivRpc : "";
    uint32_t started = p.millis();
    JsonDocument receipt;
    std::string err;
    bool stop = false;
    if (url.empty()) {
      st.status = "failed";
      st.error = "no RPC for chain " + std::to_string(chainId);
      out.state = "retry";
      stop = true;
    } else {
      publish::Sent s = publish::sendRaw(p, url, t["raw"] | "", st.txHash, err);
      if (s == publish::Sent::STALE) {
        st.status = "stale";
        st.error = err;
        out.state = "stale";
        stop = true;
      } else if (s == publish::Sent::ERROR) {
        st.status = "failed";
        st.error = err;
        out.state = "retry";
        stop = true;
      } else if (!publish::waitReceipt(p, url, st.txHash, c.txTimeoutMs, receipt, err)) {
        st.status = "failed";
        st.error = err;
        if (err.find("reverted") != std::string::npos) {
          if (out.state == "done") out.state = "failed";  // nonce consumed: later txs still go
        } else {
          out.state = "retry";
          stop = true;
        }
      } else {
        st.status = "ok";
      }
    }
    // storage: the segment, now that the submit is mined
    publish::Upload up;
    int fileIdx = t["file"] | -1;
    bool isStorage = st.purpose.rfind("storage:", 0) == 0;
    if (isStorage && st.status == "ok") {
      Bytes file;
      JsonVariantConst f = fileIdx >= 0 && static_cast<size_t>(fileIdx) < files.size() ? files[fileIdx] : JsonVariantConst();
      up.rootHash = f["root"] | "";
      if (f.isNull() || !unbase64(f["data"] | "", file)) {
        st.status = "failed";
        st.error = "bundle has no data for file " + std::to_string(fileIdx);
        if (out.state == "done") out.state = "failed";
      } else if (!haveNet && !(haveNet = publish::discoverStorage(p, c, net, err))) {
        st.status = "failed";
        st.error = err;
        out.state = "retry";
        stop = true;
      } else if (!publish::pushSegment(p, c, net, file, started, up, err)) {
        st.status = "failed";
        st.error = err;
        out.state = "retry";
        stop = true;
      }
    }
    // meta, in publishRun's shape
    JsonObject m;
    if (st.purpose == "storage:log") {
      m = meta["storage"].to<JsonObject>();
      if (st.status == "ok") {
        m["rootHash"] = up.rootHash;
        m["txSeq"] = up.txSeq;
        m["url"] = c.storageIndexer + "/file?root=" + up.rootHash;
        m["ms"] = up.ms;
      }
    } else if (st.purpose.rfind("storage:frame:", 0) == 0) {
      m = frameMeta(meta, atoi(st.purpose.c_str() + 14));
      JsonVariantConst f = fileIdx >= 0 ? files[fileIdx] : JsonVariantConst();
      m["rootHash"] = f["root"] | "";
    } else if (st.purpose == "anchor") {
      m = meta["anchor"].to<JsonObject>();
      if (!c.anchorAddress.empty()) m["address"] = c.anchorAddress;
    } else if (st.purpose == "arkiv") {
      m = meta["arkiv"].to<JsonObject>();
      if (st.status == "ok") m["entityKey"] = publish::arkivEntityKey(receipt.as<JsonVariantConst>());
    }
    if (!m.isNull()) {
      m["status"] = st.status == "ok" ? "ok" : st.status == "stale" ? "stale" : stop ? "queued" : "failed";
      m["txHash"] = st.txHash;
      m["via"] = "bundle";
      if (!st.error.empty()) m["error"] = st.error;
    }
    out.steps.push_back(st);
    if (stop) break;
  }
  return out;
}

}  // namespace pearl::bundle
