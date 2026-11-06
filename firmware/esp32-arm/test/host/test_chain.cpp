// On-chain encodings against the SDKs' own output (test/host/storage-vectors.json, arkiv-vectors.json) and ethers.
#include <fstream>
#include <sstream>
#include "harness.h"
#include "../../src/pearl/chain.h"

using namespace pearl;

static JsonDocument& load(const char* name) {
  static JsonDocument a, s;
  JsonDocument& d = name[0] == 'a' ? a : s;
  if (d.isNull()) {
    std::string path = std::string(VECTORS_PATH);
    path = path.substr(0, path.rfind('/') + 1) + name;
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    deserializeJson(d, ss.str());
  }
  return d;
}

static Bytes pattern(size_t n) {
  Bytes b(n);
  for (size_t i = 0; i < n; i++) b[i] = static_cast<uint8_t>(i % 251);
  return b;
}

TEST(storage_root_matches_sdk) {
  for (JsonObjectConst v : load("storage-vectors.json")["vectors"].as<JsonArrayConst>()) {
    size_t n = v["length"];
    if (!n) continue;
    CHECK_EQ(to0x(chain::storageRoot(pattern(n))), std::string(v["root"].as<const char*>()));
  }
}

TEST(storage_submission_and_segment_match_sdk) {
  JsonObjectConst d = load("storage-vectors.json")["detail7175"];
  Bytes file = pattern(7175);
  auto nodes = chain::submissionNodes(file);
  JsonArrayConst want = d["submission"]["data"]["nodes"];
  CHECK_EQ(nodes.size(), want.size());
  for (size_t i = 0; i < nodes.size() && i < want.size(); i++) {
    CHECK_EQ(to0x(nodes[i].root), std::string(want[i]["root"].as<const char*>()));
    CHECK_EQ(nodes[i].height, want[i]["height"].as<uint32_t>());
  }
  Bytes submitter;
  fromHex(d["submission"]["submitter"].as<const char*>(), submitter);
  CHECK_EQ(to0x(chain::submitCalldata(7175, nodes, submitter)), std::string(d["calldata"].as<const char*>()));
  CHECK_EQ(chain::paddedChunks(7175), size_t(30));
  CHECK_EQ(base64(chain::singleSegment(file)), std::string(d["segmentUpload"]["segmentWithProof"]["data"].as<const char*>()));
}

TEST(arkiv_create_calldata_matches_sdk) {
  JsonObjectConst v = load("arkiv-vectors.json").as<JsonObjectConst>();
  Bytes salt, head;
  fromHex(v["inputs"]["salt"].as<const char*>(), salt);
  std::vector<chain::Attribute> a = {
      chain::attrStr("arkiv.schema", "pearl.episode.v2", true), chain::attrStr("kind", "incident", true),
      chain::attrStr("armId", "arm-1", true), chain::attrStr("episodeId", "ep_20261106052200_b7e2", true),
      chain::attrStr("outcome", "TRIPPED", true), chain::attrU64("ts", 1762406520000ULL, true),
      chain::attrI32("severity", 3, true),
  };
  // the vector's hashes are text attributes: "ab" × 32, "0x" + "cd" × 32, "0x" + "ef" × 32
  std::string ab;
  for (int i = 0; i < 32; i++) ab += "ab";
  a.push_back(chain::attrStr("headHash", ab, false));
  std::string cd = "0x", ef = "0x";
  for (int i = 0; i < 32; i++) cd += "cd", ef += "ef";
  a.push_back(chain::attrStr("rootHash", cd, false));
  a.push_back(chain::attrStr("storageTx", ef, false));
  Bytes data = chain::arkivCreateCalldata(salt, 30 * chain::ARKIV_BLOCKS_PER_DAY, 1, a);
  CHECK_EQ(to0x(data), std::string(v["calldata"].as<const char*>()));

  // the signed EIP-1559 transaction and its hash
  Bytes pk;
  fromHex(v["inputs"]["privateKey"].as<const char*>(), pk);
  eth::Key k;
  CHECK(eth::keyFromPrivate(pk.data(), k));
  chain::Eip1559Tx tx;
  tx.chainId = v["chainId"];
  tx.nonce = v["tx"]["nonce"];
  eth::decimalToBytes("0", tx.maxPriorityFeePerGas);
  eth::decimalToBytes(v["tx"]["maxFeePerGas"].as<const char*>(), tx.maxFeePerGas);
  tx.gas = strtoull(v["tx"]["gas"].as<const char*>(), nullptr, 10);
  fromHex(v["to"].as<const char*>(), tx.to);
  tx.data = data;
  Bytes raw, hash;
  CHECK(chain::signEip1559(k, tx, raw, hash));
  CHECK_EQ(to0x(raw), std::string(v["signedRawTx"].as<const char*>()));
  CHECK_EQ(to0x(hash), std::string(v["txHash"].as<const char*>()));
}

TEST(anchor_calldata_matches_ethers) {
  JsonObjectConst a = vectors()["anchor"];
  Bytes head, root, req;
  fromHex(a["headHash"].as<const char*>(), head);
  fromHex(a["rootHash"].as<const char*>(), root);
  fromHex(a["requestIdsHash"].as<const char*>(), req);
  CHECK_EQ(to0x(chain::anchorCalldata(a["episodeId"].as<const char*>(), head, root, req, a["outcome"], a["severity"], a["incident"])),
           std::string(a["calldata"].as<const char*>()));
  CHECK_EQ(to0x(chain::anchorCalldata(a["episodeId"].as<const char*>(), head, Bytes{}, req, a["outcome"], a["severity"], a["incident"])),
           std::string(a["calldataNoRoot"].as<const char*>()));
}
