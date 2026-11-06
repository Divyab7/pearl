// Locking both ways: the board opens what TypeScript locked, and writes out/cpp-seal.json for TypeScript to open
// (apps/backend/src/scripts/fw-crosscheck.ts, run by run.sh after these tests).
#include <sys/stat.h>
#include <fstream>
#include "harness.h"
#include "../../src/pearl/json.h"
#include "../../src/pearl/seal.h"

using namespace pearl;

static seal::PublicJwk vecRecipient() {
  JsonObjectConst r = vectors()["seal"]["recipient"]["publicJwk"];
  return {r["x"].as<const char*>(), r["y"].as<const char*>()};
}

TEST(key_id_matches_typescript) {
  CHECK_EQ(seal::keyId(vecRecipient()), std::string(vectors()["seal"]["recipient"]["kid"].as<const char*>()));
}

TEST(board_opens_what_typescript_locked) {
  JsonObjectConst s = vectors()["seal"];
  Bytes runKey;
  CHECK(unbase64(s["runKey"].as<const char*>(), runKey));
  Bytes got;
  CHECK(seal::unwrapRunKey(s["wrapped"], vecRecipient(), s["recipient"]["d"].as<const char*>(), s["context"].as<const char*>(), got));
  CHECK(got == runKey);
  std::string log;
  CHECK(seal::openEpisode(runKey, s["sealed"], log));
  CHECK_EQ(log, std::string(s["logCanonical"].as<const char*>()));
  Bytes locked, jpeg, want;
  CHECK(unbase64(s["frame"]["locked"].as<const char*>(), locked));
  CHECK(unbase64(s["frame"]["jpeg"].as<const char*>(), want));
  CHECK(seal::unlockFrame(runKey, locked, jpeg));
  CHECK(jpeg == want);
}

TEST(tampering_is_detected) {
  JsonObjectConst s = vectors()["seal"];
  Bytes runKey;
  unbase64(s["runKey"].as<const char*>(), runKey);
  JsonDocument d;
  d.set(s["sealed"]);
  d["severity"] = 3;  // the header is bound to the locked data
  std::string log;
  CHECK(!seal::openEpisode(runKey, d.as<JsonObjectConst>(), log));
  Bytes wrong = randomBytes(32);
  CHECK(!seal::openEpisode(wrong, s["sealed"], log));
  Bytes other;
  CHECK(!seal::unwrapRunKey(s["wrapped"], vecRecipient(), s["recipient"]["d"].as<const char*>(), "pearl/run-key/v1|0x00|ep_x", other));
}

TEST(board_locks_for_typescript_to_open) {
  JsonObjectConst s = vectors()["seal"];
  Bytes runKey;
  unbase64(s["runKey"].as<const char*>(), runKey);
  JsonDocument out;
  out["context"] = s["context"];
  CHECK(seal::wrapRunKey(runKey, vecRecipient(), s["context"].as<const char*>(), out["wrapped"].to<JsonObject>()));
  // the same public header TypeScript wrote, locked again by the board
  JsonObject sealed = out["sealed"].to<JsonObject>();
  for (JsonPairConst p : s["sealed"].as<JsonObjectConst>())
    if (strcmp(p.key().c_str(), "cipher") != 0) sealed[p.key()] = p.value();
  CHECK(seal::sealEpisode(runKey, s["logCanonical"].as<const char*>(), sealed));
  Bytes frame;
  CHECK(seal::lockFrame(runKey, utf8("JPEG-BYTES"), frame));
  out["frame"] = base64(frame);
  mkdir(OUT_DIR, 0755);
  std::ofstream f(std::string(OUT_DIR) + "/cpp-seal.json");
  f << canonical(out.as<JsonVariantConst>());
}
