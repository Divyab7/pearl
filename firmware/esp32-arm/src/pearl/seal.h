// On-board locking, the C++ twin of apps/backend/src/shared/seal.ts (same formats, checked both ways by the host
// tests): a random 256-bit run key locks the canonical log and every camera frame with AES-256-GCM; the run key is
// wrapped for the linked owner's P-256 key (ephemeral ECDH → HKDF-SHA256 → AES-256-GCM, bound to robot + run).
#pragma once
#include <ArduinoJson.h>
#include <string>
#include "bytes.h"

namespace pearl::seal {

struct Locked {
  std::string iv;    // base64, 12 bytes
  std::string data;  // base64, ciphertext + 16-byte tag
};

bool lockBytes(const Bytes& runKey, const Bytes& plain, const Bytes* aad, Locked& out);
bool unlockBytes(const Bytes& runKey, const Locked& l, const Bytes* aad, Bytes& plain);

/** A locked camera frame: 12-byte IV ‖ ciphertext ‖ tag (the bytes uploaded to 0G Storage). */
bool lockFrame(const Bytes& runKey, const Bytes& jpeg, Bytes& out);
bool unlockFrame(const Bytes& runKey, const Bytes& locked, Bytes& jpeg);

struct PublicJwk {
  std::string x, y;  // base64url, no padding
};
/** First 16 hex of sha256(canonical {crv,kty,x,y}): the key fingerprint ("kid"). */
std::string keyId(const PublicJwk& k);
std::string runContext(const std::string& deviceAddress, const std::string& episodeId);

/** WrappedKey JSON object ({v,alg,kid,epk,context,iv,data}) for `recipient`, written into `out`. */
bool wrapRunKey(const Bytes& runKey, const PublicJwk& recipient, const std::string& context, JsonObject out);
/** Test helper: unwrap with the recipient's private scalar d (base64url). */
bool unwrapRunKey(JsonObjectConst wrapped, const PublicJwk& recipient, const std::string& dB64url, const std::string& expectedContext, Bytes& runKey);

/**
 * The sealed episode: `header` (the public fields, without "cipher") gets a "cipher" member locking `logCanonical`
 * with AES-GCM, AAD = canonical(header). The result's canonical form is what goes to 0G Storage.
 */
bool sealEpisode(const Bytes& runKey, const std::string& logCanonical, JsonObject sealed);
/** Test helper: the canonical log back out of a sealed object. */
bool openEpisode(const Bytes& runKey, JsonObjectConst sealed, std::string& logCanonical);

}  // namespace pearl::seal
