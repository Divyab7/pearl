#include "publish.h"
#include <cstring>
#include <mbedtls/bignum.h>
#include "json.h"

namespace pearl::publish {

bool rpc(orch::Platform& p, const std::string& url, const char* method, JsonVariantConst params, JsonDocument& result, std::string& err, uint32_t timeoutMs) {
  JsonDocument req;
  req["jsonrpc"] = "2.0";
  req["method"] = method;
  if (!params.isNull()) req["params"] = params;
  req["id"] = 1;
  std::string body;
  serializeJson(req, body);
  run::HttpResult r = p.post(url, {{"Content-Type", "application/json"}}, body, timeoutMs);
  if (r.status == 0) {
    err = std::string(method) + ": " + (r.error.empty() ? "no response" : r.error);
    return false;
  }
  JsonDocument resp;
  if (deserializeJson(resp, r.body)) {
    err = std::string(method) + ": HTTP " + std::to_string(r.status) + " " + r.body.substr(0, 120);
    return false;
  }
  if (!resp["error"].isNull()) {
    std::string m = resp["error"]["message"] | "error";
    std::string data = resp["error"]["data"].is<const char*>() ? resp["error"]["data"].as<const char*>() : "";
    err = std::string(method) + ": " + m + (data.empty() ? "" : " (" + data + ")");
    return false;
  }
  result.set(resp["result"]);
  return true;
}


uint64_t hexU64(JsonVariantConst v) {
  const char* s = v | "0x0";
  return strtoull(s, nullptr, 16);
}
Bytes hexBytes(JsonVariantConst v) {
  Bytes b;
  std::string s = v | "0x0";
  if (s.size() % 2) s = "0x0" + s.substr(2);
  fromHex(s, b);
  return eth::stripZeros(b);
}

/** Multiplies a big-endian number by num/den (fees, gas headroom) with mbedTLS big integers: no overflow. */
Bytes mulDiv(const Bytes& v, uint64_t num, uint64_t den) {
  mbedtls_mpi x, q;
  mbedtls_mpi_init(&x);
  mbedtls_mpi_init(&q);
  Bytes out = v;
  if (mbedtls_mpi_read_binary(&x, v.data(), v.size()) == 0 && mbedtls_mpi_mul_int(&x, &x, static_cast<mbedtls_mpi_uint>(num)) == 0 &&
      mbedtls_mpi_div_int(&q, nullptr, &x, static_cast<mbedtls_mpi_sint>(den)) == 0) {
    out.assign(mbedtls_mpi_size(&q), 0);
    if (!out.empty()) mbedtls_mpi_write_binary(&q, out.data(), out.size());
  }
  mbedtls_mpi_free(&x);
  mbedtls_mpi_free(&q);
  return out;
}

bool prepareTx(orch::Platform& p, const std::string& url, uint64_t chainId, const eth::Key& k, const Bytes& to, const Bytes& value,
               const Bytes& data, chain::Eip1559Tx& tx, std::string& err, bool arkivFees) {
  JsonDocument par, res;
  // nonce (pending, like ethers and viem)
  JsonArray a = par.to<JsonArray>();
  a.add(k.address);
  a.add("pending");
  if (!rpc(p, url, "eth_getTransactionCount", par.as<JsonVariantConst>(), res, err)) return false;
  tx.chainId = chainId;
  tx.nonce = hexU64(res.as<JsonVariantConst>());
  // fees: 0G (ethers): maxFee = maxPriority = eth_gasPrice. Arkiv (viem): priority = eth_maxPriorityFeePerGas,
  // maxFee = baseFee × 1.2 + priority.
  if (arkivFees) {
    JsonDocument none;
    if (!rpc(p, url, "eth_maxPriorityFeePerGas", none.as<JsonVariantConst>(), res, err)) return false;
    tx.maxPriorityFeePerGas = hexBytes(res.as<JsonVariantConst>());
    JsonDocument bp;
    JsonArray ba = bp.to<JsonArray>();
    ba.add("latest");
    ba.add(false);
    if (!rpc(p, url, "eth_getBlockByNumber", bp.as<JsonVariantConst>(), res, err)) return false;
    Bytes base = mulDiv(hexBytes(res["baseFeePerGas"]), 12, 10);
    uint64_t b = 0, pr = 0;
    for (uint8_t x : base) b = b << 8 | x;  // gas prices on both testnets fit in 64 bits
    for (uint8_t x : tx.maxPriorityFeePerGas) pr = pr << 8 | x;
    tx.maxFeePerGas = eth::uintBytes(b + pr);
  } else {
    JsonDocument none;
    if (!rpc(p, url, "eth_gasPrice", none.as<JsonVariantConst>(), res, err)) return false;
    tx.maxFeePerGas = hexBytes(res.as<JsonVariantConst>());
    tx.maxPriorityFeePerGas = tx.maxFeePerGas;
  }
  tx.to = to;
  tx.value = value;
  tx.data = data;
  // gas: estimate × 1.25 (viem's headroom; ethers sends the bare estimate, which can run short on 0G)
  JsonDocument ep;
  JsonObject call = ep.to<JsonArray>().add<JsonObject>();
  call["from"] = k.address;
  call["to"] = to0x(to);
  call["data"] = to0x(data);
  if (!eth::stripZeros(value).empty()) call["value"] = to0x(eth::stripZeros(value));
  if (!rpc(p, url, "eth_estimateGas", ep.as<JsonVariantConst>(), res, err)) return false;
  tx.gas = hexU64(res.as<JsonVariantConst>()) * 125 / 100;
  return true;
}

static bool contains(const std::string& s, const char* what) {
  std::string a = s;
  for (char& c : a) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  return a.find(what) != std::string::npos;
}

Sent sendRaw(orch::Platform& p, const std::string& url, const std::string& raw0x, const std::string& hash0x, std::string& err) {
  JsonDocument sp, res;
  sp.to<JsonArray>().add(raw0x);
  std::string e;
  if (rpc(p, url, "eth_sendRawTransaction", sp.as<JsonVariantConst>(), res, e)) return Sent::OK;
  if (contains(e, "already known") || contains(e, "already imported") || contains(e, "known transaction")) return Sent::OK;
  if (contains(e, "nonce too low") || contains(e, "replacement transaction underpriced") || contains(e, "invalid nonce")) {
    // our own tx, already mined or pending? Otherwise the nonce went to a different tx.
    JsonDocument hp;
    hp.to<JsonArray>().add(hash0x);
    std::string e2;
    if (rpc(p, url, "eth_getTransactionReceipt", hp.as<JsonVariantConst>(), res, e2) && !res.isNull()) return Sent::OK;
    if (e2.empty() && rpc(p, url, "eth_getTransactionByHash", hp.as<JsonVariantConst>(), res, e2) && !res.isNull()) return Sent::OK;
    err = e;
    return e2.empty() ? Sent::STALE : Sent::ERROR;
  }
  err = e;
  return Sent::ERROR;
}

bool waitReceipt(orch::Platform& p, const std::string& url, const std::string& hash0x, uint32_t timeoutMs, JsonDocument& receipt, std::string& err) {
  uint32_t until = p.millis() + timeoutMs;
  JsonDocument rp, res;
  rp.to<JsonArray>().add(hash0x);
  while (static_cast<int32_t>(until - p.millis()) > 0) {
    if (rpc(p, url, "eth_getTransactionReceipt", rp.as<JsonVariantConst>(), res, err) && !res.isNull()) {
      receipt.set(res.as<JsonVariantConst>());
      if (hexU64(res["status"]) != 1) {
        err = "transaction " + hash0x + " reverted";
        return false;
      }
      return true;
    }
    p.sleep(1500);
  }
  err = "no receipt for " + hash0x + " within " + std::to_string(timeoutMs / 1000) + " s";
  return false;
}

bool sendTx(orch::Platform& p, const std::string& url, uint64_t chainId, const eth::Key& k, const Bytes& to, const Bytes& value,
            const Bytes& data, uint32_t timeoutMs, TxResult& out, std::string& err, bool arkivFees) {
  chain::Eip1559Tx tx;
  if (!prepareTx(p, url, chainId, k, to, value, data, tx, err, arkivFees)) return false;
  Bytes raw, hash;
  if (!chain::signEip1559(k, tx, raw, hash)) {
    err = "signing failed";
    return false;
  }
  if (sendRaw(p, url, to0x(raw), to0x(hash), err) != Sent::OK) return false;
  out.txHash = to0x(hash);
  return waitReceipt(p, url, out.txHash, timeoutMs, out.receipt, err);
}

static bool ethCall(orch::Platform& p, const std::string& url, const std::string& to, const Bytes& data, Bytes& out, std::string& err) {
  JsonDocument par, res;
  JsonArray a = par.to<JsonArray>();
  JsonObject c = a.add<JsonObject>();
  c["to"] = to;
  c["data"] = to0x(data);
  a.add("latest");
  if (!rpc(p, url, "eth_call", par.as<JsonVariantConst>(), res, err)) return false;
  if (!fromHex(res | "0x", out)) {
    err = "eth_call to " + to + ": malformed result";
    return false;
  }
  return true;
}

bool discoverStorage(orch::Platform& p, const Config& c, StorageNet& net, std::string& err) {
  if (c.storageNodes.empty()) {
    err = "no 0G Storage nodes configured";
    return false;
  }
  // nodes: shard config of each, and the Flow contract from the first that answers
  JsonDocument none, res;
  net.nodes.clear();
  net.flow.clear();
  for (const std::string& u : c.storageNodes) {
    std::string e;
    if (!rpc(p, u, "zgs_getShardConfig", none.as<JsonVariantConst>(), res, e)) continue;
    net.nodes.push_back({u, res["shardId"] | 0ULL, res["numShard"] | 1ULL});
    if (net.flow.empty() && rpc(p, u, "zgs_getStatus", none.as<JsonVariantConst>(), res, e)) net.flow = res["networkIdentity"]["flowAddress"] | "";
  }
  if (net.nodes.empty() || net.flow.empty()) {
    err = "no 0G Storage node reachable";
    return false;
  }
  return true;
}

bool storagePrice(orch::Platform& p, const Config& c, const std::string& flow, Bytes& pricePerSector, std::string& err) {
  Bytes marketWord, priceWord;
  if (!ethCall(p, c.chainRpc, flow, chain::selector("market()"), marketWord, err) || marketWord.size() < 32) {
    if (err.empty()) err = "market(): short answer";
    return false;
  }
  std::string market = to0x(Bytes(marketWord.begin() + 12, marketWord.begin() + 32));
  if (!ethCall(p, c.chainRpc, market, chain::selector("pricePerSector()"), priceWord, err) || priceWord.size() < 32) {
    if (err.empty()) err = "pricePerSector(): short answer";
    return false;
  }
  pricePerSector = eth::stripZeros(priceWord);
  return true;
}

bool pushSegment(orch::Platform& p, const Config& c, const StorageNet& net, const Bytes& file, uint32_t started, Upload& out, std::string& err) {
  // wait until the nodes know the entry, then send the one segment to the node of its shard
  JsonDocument res;
  uint64_t start = 0;
  bool known = false;
  uint32_t until = p.millis() + c.storageTimeoutMs;
  while (!known && static_cast<int32_t>(until - p.millis()) > 0) {
    JsonDocument fp;
    JsonArray a = fp.to<JsonArray>();
    a.add(out.rootHash);
    a.add(true);
    std::string e;
    if (rpc(p, net.nodes[0].url, "zgs_getFileInfo", fp.as<JsonVariantConst>(), res, e) && !res.isNull()) {
      out.txSeq = res["tx"]["seq"] | 0ULL;
      start = res["tx"]["startEntryIndex"] | 0ULL;
      known = true;
      break;
    }
    p.sleep(1000);
  }
  if (!known) {
    err = "storage nodes did not see the submission within " + std::to_string(c.storageTimeoutMs / 1000) + " s";
    return false;
  }
  uint64_t seg = start / chain::SEGMENT_CHUNKS;
  const StorageNet::Node* target = &net.nodes[0];
  for (const auto& n : net.nodes)
    if (n.numShard && seg % n.numShard == n.shardId) {
      target = &n;
      break;
    }
  JsonDocument up;
  JsonArray ua = up.to<JsonArray>();
  JsonObject s = ua.add<JsonArray>().add<JsonObject>();
  s["root"] = out.rootHash;
  s["data"] = base64(chain::singleSegment(file));
  s["index"] = 0;
  JsonObject proof = s["proof"].to<JsonObject>();
  proof["lemma"].to<JsonArray>().add(out.rootHash);
  proof["path"].to<JsonArray>();
  s["fileSize"] = file.size();
  ua.add(out.txSeq);
  std::string e;
  if (!rpc(p, target->url, "zgs_uploadSegmentsByTxSeq", up.as<JsonVariantConst>(), res, e, 30000) && e.find("already uploaded") == std::string::npos) {
    err = e;
    return false;
  }
  // finalized?
  while (static_cast<int32_t>(until - p.millis()) > 0) {
    JsonDocument fp;
    JsonArray a = fp.to<JsonArray>();
    a.add(out.rootHash);
    a.add(true);
    if (rpc(p, target->url, "zgs_getFileInfo", fp.as<JsonVariantConst>(), res, e) && !res.isNull() && (res["finalized"] | false)) {
      out.ms = p.millis() - started;
      return true;
    }
    p.sleep(1500);
  }
  err = "uploaded, but not finalized within " + std::to_string(c.storageTimeoutMs / 1000) + " s";
  return false;
}

bool uploadFile(orch::Platform& p, const Config& c, const eth::Key& k, const Bytes& file, Upload& out, std::string& err) {
  uint32_t started = p.millis();
  if (file.empty() || file.size() > chain::CHUNK * chain::SEGMENT_CHUNKS) {
    err = "file size " + std::to_string(file.size()) + " outside 1..262144 bytes (one segment)";
    return false;
  }
  if (c.storageNodes.empty()) {
    err = "no 0G Storage nodes configured";
    return false;
  }
  Bytes root = chain::storageRoot(file);
  out.rootHash = to0x(root);
  StorageNet net;
  if (!discoverStorage(p, c, net, err)) return false;
  // already stored and finalized? (same bytes → same root)
  {
    JsonDocument fp, res;
    JsonArray a = fp.to<JsonArray>();
    a.add(out.rootHash);
    a.add(false);
    std::string e;
    if (rpc(p, net.nodes[0].url, "zgs_getFileInfo", fp.as<JsonVariantConst>(), res, e) && !res.isNull() && (res["finalized"] | false)) {
      out.txSeq = res["tx"]["seq"] | 0ULL;
      out.ms = p.millis() - started;
      return true;
    }
  }
  // fee = padded chunks (sectors) × market.pricePerSector()
  Bytes price;
  if (!storagePrice(p, c, net.flow, price, err)) return false;
  Bytes fee = mulDiv(price, chain::paddedChunks(file.size()), 1);
  Bytes flowAddr;
  fromHex(net.flow, flowAddr);
  TxResult tx;
  Bytes submitter(k.addr, k.addr + 20);
  if (!sendTx(p, c.chainRpc, c.chainId, k, flowAddr, fee, chain::submitCalldata(file.size(), chain::submissionNodes(file), submitter), c.txTimeoutMs, tx, err)) return false;
  out.txHash = tx.txHash;
  return pushSegment(p, c, net, file, started, out, err);
}

uint8_t outcomeCode(const std::string& o) { return o == "DONE" ? 0 : o == "ABORTED" ? 1 : o == "FAILSAFE" ? 2 : 3; }

Bytes anchorData(const orch::Result& r, const std::string& root0x) {
  Bytes head, rootB, req;
  fromHex(r.headHash, head);
  if (!root0x.empty()) fromHex(root0x, rootB);
  fromHex(run::requestIdsHash(r.requestIds), req);
  return chain::anchorCalldata(r.episodeId, head, rootB, req, outcomeCode(r.outcome), static_cast<uint8_t>(r.severity), r.incident);
}

Bytes arkivData(const Config& c, const orch::Result& r, const std::string& root, const std::string& storageTx, const std::string& anchorTx, const Bytes& salt16) {
  std::vector<chain::Attribute> at = {
      chain::attrStr("arkiv.schema", "pearl.episode.v2", true), chain::attrStr("kind", r.incident ? "incident" : "episode", true),
      chain::attrStr("armId", c.armId, true), chain::attrStr("episodeId", r.episodeId, true), chain::attrStr("outcome", r.outcome, true),
      chain::attrI32("severity", r.severity, true), chain::attrStr("headHash", r.headHash, false),
  };
  at.push_back(chain::attrU64("ts", isoToEpochMs(r.endedAt), true));  // run end, ms since epoch
  if (!root.empty()) at.push_back(chain::attrStr("rootHash", root, false));
  if (!storageTx.empty()) at.push_back(chain::attrStr("storageTx", storageTx, false));
  if (!anchorTx.empty()) at.push_back(chain::attrStr("anchorTx", anchorTx, false));
  return chain::arkivCreateCalldata(salt16, static_cast<uint64_t>(c.arkivLifetimeDays) * chain::ARKIV_BLOCKS_PER_DAY, 1, at);
}

std::string arkivEntityKey(JsonVariantConst receipt) {
  std::string key;
  for (JsonVariantConst l : receipt["logs"].as<JsonArrayConst>())
    if (strcasecmp(l["topics"][0] | "", chain::ARKIV_ENTITY_CREATED_TOPIC) == 0) key = l["topics"][1] | "";
  return key;
}

static void status(JsonObject o, const char* st) { o["status"] = st; }

void publishRun(orch::Platform& p, const Config& c, const eth::Key& k, const orch::Result& r,
                const std::vector<std::pair<size_t, Bytes>>& frameFiles, JsonDocument& meta,
                const std::function<void(const JsonDocument&)>& onMeta) {
  meta["episodeId"] = r.episodeId;
  std::string err;
  // 1. 0G Storage: the locked log
  std::string root;
  {
    JsonObject s = meta["storage"].to<JsonObject>();
    if (!c.storageOn) status(s, "off");
    else if (c.storageNodes.empty()) {
      status(s, "not_configured");
      s["missing"] = "storage nodes";
    } else {
      Upload u;
      if (uploadFile(p, c, k, utf8(r.sealedCanonical), u, err)) {
        status(s, "ok");
        s["rootHash"] = u.rootHash;
        s["txHash"] = u.txHash;
        s["txSeq"] = u.txSeq;
        s["url"] = c.storageIndexer + "/file?root=" + u.rootHash;
        s["ms"] = u.ms;
        root = u.rootHash;
      } else {
        status(s, "failed");
        s["error"] = err;
      }
    }
  }
  onMeta(meta);
  // 1b. locked frames
  if (!frameFiles.empty()) {
    JsonArray fr = meta["frames"].to<JsonArray>();
    for (const auto& f : frameFiles) {
      JsonObject o = fr.add<JsonObject>();
      o["idx"] = f.first;
      o["rootHash"] = to0x(chain::storageRoot(f.second));
      if (!c.storageOn || c.storageNodes.empty()) {
        o["status"] = "not_configured";
        continue;
      }
      Upload u;
      if (uploadFile(p, c, k, f.second, u, err)) {
        o["status"] = "ok";
        o["txHash"] = u.txHash;
      } else {
        o["status"] = "failed";
        o["error"] = err;
      }
    }
    onMeta(meta);
  }
  // 2. 0G Chain anchor
  {
    JsonObject a = meta["anchor"].to<JsonObject>();
    if (!c.anchorOn) status(a, "off");
    else if (c.anchorAddress.empty()) {
      status(a, "not_configured");
      a["missing"] = "OG_ANCHOR_ADDRESS";
    } else {
      Bytes to;
      fromHex(c.anchorAddress, to);
      TxResult tx;
      if (sendTx(p, c.chainRpc, c.chainId, k, to, Bytes{}, anchorData(r, root), c.txTimeoutMs, tx, err)) {
        status(a, "ok");
        a["address"] = c.anchorAddress;
        a["txHash"] = tx.txHash;
      } else {
        status(a, "failed");
        a["error"] = err;
      }
    }
  }
  onMeta(meta);
  // 3. Arkiv: public labels only (owner decision 6 Nov 2026)
  {
    JsonObject a = meta["arkiv"].to<JsonObject>();
    if (!c.arkivOn) status(a, "off");
    else if (c.arkivRpc.empty()) {
      status(a, "not_configured");
      a["missing"] = "Arkiv RPC";
    } else {
      Bytes to;
      fromHex(chain::ARKIV_PROCESSOR, to);
      TxResult tx;
      Bytes data = arkivData(c, r, root, meta["storage"]["txHash"] | "", meta["anchor"]["txHash"] | "", randomBytes(16));
      if (sendTx(p, c.arkivRpc, c.arkivChainId, k, to, Bytes{}, data, c.txTimeoutMs, tx, err, true)) {
        status(a, "ok");
        a["entityKey"] = arkivEntityKey(tx.receipt.as<JsonVariantConst>());
        a["txHash"] = tx.txHash;
      } else {
        status(a, "failed");
        a["error"] = err;
      }
    }
  }
  onMeta(meta);
}

}  // namespace pearl::publish
