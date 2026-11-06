// Publishing against a fake 0G Chain / storage node / Arkiv node: the right calls with the right calldata and fee,
// receipts read back, and the run's meta filled in exactly as the dashboard expects.
#include <map>
#include "harness.h"
#include "../../src/pearl/json.h"
#include "../../src/pearl/publish.h"

using namespace pearl;

struct FakeNet : orch::Platform {
  uint32_t t = 0;
  std::vector<std::string> methods;
  std::map<std::string, JsonDocument> estimates;  // to → the estimateGas call object
  bool submitted = false, uploaded = false;
  std::string uploadedData;
  uint64_t txs = 0;
  uint32_t millis() override { return t += 10; }
  void sleep(uint32_t ms) override { t += ms; }
  std::string nowIso() override { return "2026-11-06T05:10:09.000Z"; }
  bool camera(Bytes&, std::string&) override { return false; }
  void saveFrame(const std::string&, size_t, const Bytes&) override {}
  run::HttpResult post(const std::string& url, const orch::Headers&, const std::string& body, uint32_t) override {
    JsonDocument q, r;
    deserializeJson(q, body);
    std::string m = q["method"] | "";
    methods.push_back(m);
    r["jsonrpc"] = "2.0";
    r["id"] = 1;
    JsonVariant res = r["result"].to<JsonVariant>();
    if (m == "eth_getTransactionCount") res.set("0x5");
    else if (m == "eth_gasPrice") res.set("0xee6b2807");
    else if (m == "eth_maxPriorityFeePerGas") res.set("0x0");
    else if (m == "eth_getBlockByNumber") res["baseFeePerGas"] = "0x3b9aca00";
    else if (m == "eth_estimateGas") {
      estimates[q["params"][0]["to"] | ""].set(q["params"][0]);
      res.set("0x30d40");
    } else if (m == "eth_sendRawTransaction") {
      txs++;
      std::string raw = q["params"][0] | "";
      CHECK(raw.rfind("0x02", 0) == 0);  // type-2
      res.set("0x" + std::string(64, 'a'));
      if (url.find("rpc.arkiv") != std::string::npos) {}
    } else if (m == "eth_getTransactionReceipt") {
      res["status"] = "0x1";
      JsonObject l = res["logs"].to<JsonArray>().add<JsonObject>();
      l["address"] = chain::ARKIV_PROCESSOR;
      JsonArray tp = l["topics"].to<JsonArray>();
      tp.add(chain::ARKIV_ENTITY_CREATED_TOPIC);
      tp.add("0x" + std::string(64, 'e'));
    } else if (m == "eth_call") {
      std::string data = q["params"][0]["data"] | "";
      if (data == to0x(chain::selector("market()"))) res.set("0x000000000000000000000000" "26c8f001c94b0fd287db5397f05ef8bd8ef2cf4b");
      else res.set("0x0000000000000000000000000000000000000000000000000000000727de34a2");  // 30733644962 wei per sector
    } else if (m == "zgs_getShardConfig") {
      res["shardId"] = url.find("node-b") != std::string::npos ? 1 : 0;
      res["numShard"] = 2;
    } else if (m == "zgs_getStatus") res["networkIdentity"]["flowAddress"] = "0x22e03a6a89b950f1c82ec5e74f8eca321a105296";
    else if (m == "zgs_getFileInfo") {
      if (!submitted) res.set(nullptr);
      else {
        res["tx"]["seq"] = 77;
        res["tx"]["startEntryIndex"] = 1024 * 3 + 960;  // global segment 3 → shard 1 (node-b)
        res["finalized"] = uploaded;
      }
    } else if (m == "zgs_uploadSegmentsByTxSeq") {
      CHECK(url.find("node-b") != std::string::npos);
      uploadedData = q["params"][0][0]["data"] | "";
      CHECK_EQ(q["params"][1].as<int>(), 77);
      uploaded = true;
      res.set(nullptr);
    }
    if (m == "eth_sendRawTransaction" && estimates.count("0x22e03a6a89b950f1c82ec5e74f8eca321a105296")) submitted = true;
    run::HttpResult h;
    h.status = 200;
    serializeJson(r, h.body);
    return h;
  }
};

TEST(publish_uploads_anchors_and_indexes_with_exact_calls) {
  FakeNet net;
  publish::Config c;
  c.anchorAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  c.storageNodes = {"http://node-a:5678", "http://node-b:5678"};
  c.arkivRpc = "https://rpc.arkiv.test/key";
  Bytes pk;
  fromHex(vectors()["eth"]["privateKey"].as<const char*>(), pk);
  eth::Key k;
  eth::keyFromPrivate(pk.data(), k);
  orch::Result r;
  r.episodeId = "ep_20261106052200_b7e2";
  r.outcome = "TRIPPED";
  r.headHash = std::string(64, 'b');
  r.endedAt = "2026-11-06T05:22:09.120Z";
  r.incident = true;
  r.severity = 3;
  r.requestIds = {"0g-req-1", "0g-req-2"};
  r.sealedCanonical = "{\"sealed\":true}";
  JsonDocument meta;
  int updates = 0;
  publish::publishRun(net, c, k, r, {}, meta, [&](const JsonDocument&) { updates++; });

  CHECK_EQ(std::string(meta["storage"]["status"] | ""), std::string("ok"));
  if (meta["storage"]["error"].is<const char*>()) fprintf(stderr, "      storage error: %s\n", meta["storage"]["error"].as<const char*>());
  CHECK_EQ(std::string(meta["anchor"]["status"] | ""), std::string("ok"));
  CHECK_EQ(std::string(meta["arkiv"]["status"] | ""), std::string("ok"));
  CHECK_EQ(std::string(meta["arkiv"]["entityKey"] | ""), "0x" + std::string(64, 'e'));
  CHECK_EQ(meta["storage"]["txSeq"].as<int>(), 77);
  CHECK_EQ(updates, 3);
  CHECK_EQ(net.txs, uint64_t(3));
  // storage: submit calldata for this file and fee = padded chunks × price per sector
  Bytes file = utf8(r.sealedCanonical);
  JsonObjectConst sub = net.estimates["0x22e03a6a89b950f1c82ec5e74f8eca321a105296"].as<JsonObjectConst>();
  Bytes submitter(k.addr, k.addr + 20);
  CHECK_EQ(std::string(sub["data"] | ""), to0x(chain::submitCalldata(file.size(), chain::submissionNodes(file), submitter)));
  CHECK_EQ(std::string(sub["value"] | ""), to0x(eth::uintBytes(30733644962ULL)));  // 1 padded chunk × price per sector
  CHECK_EQ(net.uploadedData, base64(chain::singleSegment(file)));
  // anchor: the anchored root is the storage root of the sealed file
  Bytes head, root, req;
  fromHex(r.headHash, head);
  fromHex(std::string(meta["storage"]["rootHash"] | ""), root);
  fromHex(run::requestIdsHash(r.requestIds), req);
  CHECK_EQ(std::string(net.estimates["0x5fbdb2315678afecb367f032d93f642f64180aa3"]["data"] | ""), to0x(chain::anchorCalldata(r.episodeId, head, root, req, 3, 3, true)));
  CHECK(net.estimates.count(chain::ARKIV_PROCESSOR) == 1);
}

TEST(publish_reports_not_configured_honestly) {
  FakeNet net;
  publish::Config c;  // no anchor address, no nodes, no Arkiv
  eth::Key k;
  eth::newKey(k);
  orch::Result r;
  r.episodeId = "ep_x";
  r.sealedCanonical = "{}";
  JsonDocument meta;
  publish::publishRun(net, c, k, r, {}, meta, [](const JsonDocument&) {});
  CHECK_EQ(std::string(meta["storage"]["status"] | ""), std::string("not_configured"));
  CHECK_EQ(std::string(meta["anchor"]["status"] | ""), std::string("not_configured"));
  CHECK_EQ(std::string(meta["arkiv"]["status"] | ""), std::string("not_configured"));
  CHECK(net.methods.empty());
}
