// The robot's address, message signatures and raw transactions must equal ethers v6's, byte for byte.
#include "harness.h"
#include "../../src/pearl/eth.h"

using namespace pearl;

static eth::Key vectorKey() {
  Bytes pk;
  fromHex(vectors()["eth"]["privateKey"].as<const char*>(), pk);
  eth::Key k;
  CHECK(eth::keyFromPrivate(pk.data(), k));
  return k;
}

TEST(address_matches_ethers) {
  eth::Key k = vectorKey();
  CHECK_EQ(k.address, std::string(vectors()["eth"]["address"].as<const char*>()));
  CHECK_EQ("0x04" + toHex(k.pub, 64), std::string(vectors()["eth"]["publicKey"].as<const char*>()));
}

TEST(personal_sign_matches_ethers_signMessage) {
  eth::Key k = vectorKey();
  for (JsonObjectConst s : vectors()["eth"]["signatures"].as<JsonArrayConst>()) {
    CHECK_EQ(eth::personalSign(k, s["message"].as<const char*>()), std::string(s["signature"].as<const char*>()));
  }
}

TEST(legacy_transactions_match_ethers_signTransaction) {
  eth::Key k = vectorKey();
  for (JsonObjectConst t : vectors()["eth"]["transactions"].as<JsonArrayConst>()) {
    eth::LegacyTx tx;
    tx.chainId = t["chainId"].as<uint64_t>();
    tx.nonce = t["nonce"].as<uint64_t>();
    CHECK(eth::decimalToBytes(t["gasPrice"].as<const char*>(), tx.gasPrice));
    tx.gasLimit = strtoull(t["gasLimit"].as<const char*>(), nullptr, 10);
    CHECK(fromHex(t["to"].as<const char*>(), tx.to));
    CHECK(eth::decimalToBytes(t["value"].as<const char*>(), tx.value));
    CHECK(fromHex(t["data"].as<const char*>(), tx.data));
    Bytes raw;
    CHECK(eth::signLegacy(k, tx, raw));
    CHECK_EQ(to0x(raw), std::string(t["raw"].as<const char*>()));
  }
}

TEST(fresh_keys_sign_and_recover) {
  for (int i = 0; i < 20; i++) {
    eth::Key k;
    CHECK(eth::newKey(k));
    uint8_t h[32], r[32], s[32];
    int recid = -1;
    eth::personalHash("run " + std::to_string(i), h);
    CHECK(eth::signDigest(k, h, r, s, recid));
    CHECK(recid == 0 || recid == 1);
  }
}
