// Canonical JSON, JS number formatting, SHA-256 and Keccak-256 against the TypeScript code's own output.
#include <cstring>
#include "harness.h"
#include "../../src/pearl/bytes.h"
#include "../../src/pearl/json.h"

using namespace pearl;

static double fromBits(const char* hex) {
  Bytes b;
  fromHex(hex, b);
  uint64_t u = 0;
  for (uint8_t x : b) u = u << 8 | x;
  double d;
  memcpy(&d, &u, 8);
  return d;
}

TEST(js_number_formatting_matches_json_stringify) {
  for (JsonObjectConst n : vectors()["numbers"].as<JsonArrayConst>()) {
    CHECK_EQ(jsNumber(fromBits(n["bits"])), std::string(n["js"].as<const char*>()));
  }
}

TEST(model_numbers_parse_like_json_parse) {
  // The firmware parses model answers with its own strtod-based reader (json.h parseExact), never ArduinoJson's float parser.
  for (JsonObjectConst p : vectors()["parse"].as<JsonArrayConst>()) {
    JsonDocument d;
    CHECK(parseExact(p["text"].as<const char*>(), d));
    CHECK_EQ(canonical(d.as<JsonVariantConst>()), std::string(p["js"].as<const char*>()));
  }
}

TEST(canonical_json_and_its_hash_match_typescript) {
  for (JsonObjectConst c : vectors()["canon"].as<JsonArrayConst>()) {
    JsonDocument d;
    CHECK(parseExact(c["json"].as<const char*>(), d));
    std::string got = canonical(d.as<JsonVariantConst>());
    CHECK_EQ(got, std::string(c["canonical"].as<const char*>()));
    CHECK_EQ(sha256Hex(got), std::string(c["sha256"].as<const char*>()));
  }
}

TEST(sha256_and_keccak256_match) {
  for (JsonObjectConst h : vectors()["hashes"].as<JsonArrayConst>()) {
    std::string t = h["text"].as<const char*>();
    CHECK_EQ(sha256Hex(t), std::string(h["sha256"].as<const char*>()));
    CHECK_EQ(toHex(keccak256(t)), std::string(h["keccak256"].as<const char*>()));
  }
}

TEST(hex_and_base64_round_trip) {
  Bytes b = randomBytes(257), o;
  CHECK(fromHex(to0x(b), o) && o == b);
  CHECK(unbase64(base64(b), o) && o == b);
  CHECK(unbase64url(base64url(b.data(), b.size()), o) && o == b);
  CHECK_EQ(base64(utf8("abc")), std::string("YWJj"));
  CHECK_EQ(base64url(utf8("\xfb\xff").data(), 2), std::string("-_8"));
}
