#include "seal.h"
#include <mbedtls/ecdh.h>
#include <mbedtls/ecp.h>
#include <mbedtls/gcm.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
#include <cstring>
#include "json.h"

namespace pearl::seal {

static int rng(void*, unsigned char* out, size_t n) {
  randomFill(out, n);
  return 0;
}

/** AES-256-GCM. Encrypt writes the tag into `tag`; decrypt reads and checks it. */
static bool gcm(bool enc, const uint8_t* key, const uint8_t iv[12], const Bytes* aad, const uint8_t* in, size_t n, uint8_t* out, const uint8_t* tag) {
  mbedtls_gcm_context g;
  mbedtls_gcm_init(&g);
  bool ok = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, key, 256) == 0;
  const uint8_t* a = aad ? aad->data() : nullptr;
  size_t al = aad ? aad->size() : 0;
  if (ok) {
    ok = enc ? mbedtls_gcm_crypt_and_tag(&g, MBEDTLS_GCM_ENCRYPT, n, iv, 12, a, al, in, out, 16, const_cast<uint8_t*>(tag)) == 0
             : mbedtls_gcm_auth_decrypt(&g, n, iv, 12, a, al, tag, 16, in, out) == 0;
  }
  mbedtls_gcm_free(&g);
  return ok;
}

bool lockBytes(const Bytes& runKey, const Bytes& plain, const Bytes* aad, Locked& out) {
  if (runKey.size() != 32) return false;
  Bytes iv = randomBytes(12);
  Bytes ct(plain.size() + 16);
  if (!gcm(true, runKey.data(), iv.data(), aad, plain.data(), plain.size(), ct.data(), ct.data() + plain.size())) return false;
  out.iv = base64(iv);
  out.data = base64(ct);
  return true;
}

bool unlockBytes(const Bytes& runKey, const Locked& l, const Bytes* aad, Bytes& plain) {
  Bytes iv, ct;
  if (runKey.size() != 32 || !unbase64(l.iv, iv) || iv.size() != 12 || !unbase64(l.data, ct) || ct.size() < 16) return false;
  size_t n = ct.size() - 16;
  plain.assign(n, 0);
  return gcm(false, runKey.data(), iv.data(), aad, ct.data(), n, plain.data(), ct.data() + n);
}

bool lockFrame(const Bytes& runKey, const Bytes& jpeg, Bytes& out) {
  if (runKey.size() != 32) return false;
  out.assign(12 + jpeg.size() + 16, 0);
  randomFill(out.data(), 12);
  return gcm(true, runKey.data(), out.data(), nullptr, jpeg.data(), jpeg.size(), out.data() + 12, out.data() + 12 + jpeg.size());
}

bool unlockFrame(const Bytes& runKey, const Bytes& locked, Bytes& jpeg) {
  if (runKey.size() != 32 || locked.size() < 28) return false;
  size_t n = locked.size() - 28;
  jpeg.assign(n, 0);
  return gcm(false, runKey.data(), locked.data(), nullptr, locked.data() + 12, n, jpeg.data(), locked.data() + 12 + n);
}

std::string keyId(const PublicJwk& k) {
  JsonDocument d;
  d["crv"] = "P-256";
  d["kty"] = "EC";
  d["x"] = k.x;
  d["y"] = k.y;
  return sha256Hex(canonical(d.as<JsonVariantConst>())).substr(0, 16);
}

std::string runContext(const std::string& deviceAddress, const std::string& episodeId) {
  std::string dev = deviceAddress;
  for (char& c : dev)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
  return "pearl/run-key/v1|" + dev + "|" + episodeId;
}

// ---------------------------------------------------------------- ECDH P-256 + HKDF
namespace {
struct P256 {
  mbedtls_ecp_group grp;
  P256() {
    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1);
  }
  ~P256() { mbedtls_ecp_group_free(&grp); }
};
struct Pt {
  mbedtls_ecp_point v;
  Pt() { mbedtls_ecp_point_init(&v); }
  ~Pt() { mbedtls_ecp_point_free(&v); }
};
struct Mp {
  mbedtls_mpi v;
  Mp() { mbedtls_mpi_init(&v); }
  ~Mp() { mbedtls_mpi_free(&v); }
};
}  // namespace

static bool readPoint(P256& c, const PublicJwk& k, mbedtls_ecp_point* P) {
  Bytes x, y;
  if (!unbase64url(k.x, x) || !unbase64url(k.y, y) || x.size() != 32 || y.size() != 32) return false;
  if (mbedtls_mpi_read_binary(&P->private_X, x.data(), 32) || mbedtls_mpi_read_binary(&P->private_Y, y.data(), 32) || mbedtls_mpi_lset(&P->private_Z, 1)) return false;
  return mbedtls_ecp_check_pubkey(&c.grp, P) == 0;
}

static bool sharedSecret(P256& c, const mbedtls_ecp_point* Q, const mbedtls_mpi* d, uint8_t out[32]) {
  Mp z;
  if (mbedtls_ecdh_compute_shared(&c.grp, &z.v, Q, d, rng, nullptr)) return false;
  return mbedtls_mpi_write_binary(&z.v, out, 32) == 0;
}

static bool hkdf(const uint8_t shared[32], const std::string& kid, const std::string& context, uint8_t key[32]) {
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  return mbedtls_hkdf(md, reinterpret_cast<const uint8_t*>(kid.data()), kid.size(), shared, 32,
                      reinterpret_cast<const uint8_t*>(context.data()), context.size(), key, 32) == 0;
}

bool wrapRunKey(const Bytes& runKey, const PublicJwk& recipient, const std::string& context, JsonObject out) {
  if (runKey.size() != 32) return false;
  P256 c;
  Pt R, E;
  Mp e;
  if (!readPoint(c, recipient, &R.v)) return false;
  if (mbedtls_ecp_gen_keypair(&c.grp, &e.v, &E.v, rng, nullptr)) return false;
  uint8_t shared[32], k[32];
  std::string kid = keyId(recipient);
  if (!sharedSecret(c, &R.v, &e.v, shared) || !hkdf(shared, kid, context, k)) return false;
  Bytes iv = randomBytes(12);
  Bytes ct(32 + 16);
  Bytes aad = utf8(context);
  if (!gcm(true, k, iv.data(), &aad, runKey.data(), 32, ct.data(), ct.data() + 32)) return false;
  uint8_t ex[32], ey[32];
  mbedtls_mpi_write_binary(&E.v.private_X, ex, 32);
  mbedtls_mpi_write_binary(&E.v.private_Y, ey, 32);
  out["v"] = 1;
  out["alg"] = "ECDH-ES-P256+HKDF-SHA256+A256GCM";
  out["kid"] = kid;
  JsonObject epk = out["epk"].to<JsonObject>();
  epk["kty"] = "EC";
  epk["crv"] = "P-256";
  epk["x"] = base64url(ex, 32);
  epk["y"] = base64url(ey, 32);
  out["context"] = context;
  out["iv"] = base64(iv);
  out["data"] = base64(ct);
  return true;
}

bool unwrapRunKey(JsonObjectConst w, const PublicJwk& recipient, const std::string& dB64url, const std::string& expectedContext, Bytes& runKey) {
  if (expectedContext != (w["context"] | "")) return false;
  std::string kid = keyId(recipient);
  if (kid != (w["kid"] | "")) return false;
  P256 c;
  Pt E;
  Mp d;
  Bytes db;
  if (!unbase64url(dB64url, db) || db.size() != 32 || mbedtls_mpi_read_binary(&d.v, db.data(), 32)) return false;
  PublicJwk epk{w["epk"]["x"] | "", w["epk"]["y"] | ""};
  if (!readPoint(c, epk, &E.v)) return false;
  uint8_t shared[32], k[32];
  std::string ctx = w["context"] | "";
  if (!sharedSecret(c, &E.v, &d.v, shared) || !hkdf(shared, kid, ctx, k)) return false;
  Bytes iv, ct;
  if (!unbase64(w["iv"] | "", iv) || iv.size() != 12 || !unbase64(w["data"] | "", ct) || ct.size() != 48) return false;
  Bytes aad = utf8(ctx);
  runKey.assign(32, 0);
  return gcm(false, k, iv.data(), &aad, ct.data(), 32, runKey.data(), ct.data() + 32);
}

// ---------------------------------------------------------------- sealed episode
bool sealEpisode(const Bytes& runKey, const std::string& logCanonical, JsonObject sealed) {
  sealed.remove("cipher");
  Bytes aad = utf8(canonical(sealed));
  Locked l;
  if (!lockBytes(runKey, utf8(logCanonical), &aad, l)) return false;
  JsonObject c = sealed["cipher"].to<JsonObject>();
  c["alg"] = "A256GCM";
  c["iv"] = l.iv;
  c["data"] = l.data;
  return true;
}

bool openEpisode(const Bytes& runKey, JsonObjectConst sealed, std::string& logCanonical) {
  JsonDocument h;
  for (JsonPairConst p : sealed)
    if (strcmp(p.key().c_str(), "cipher") != 0) h[p.key()] = p.value();
  Bytes aad = utf8(canonical(h.as<JsonVariantConst>()));
  Locked l{sealed["cipher"]["iv"] | "", sealed["cipher"]["data"] | ""};
  Bytes plain;
  if (!unlockBytes(runKey, l, &aad, plain)) return false;
  logCanonical.assign(plain.begin(), plain.end());
  return true;
}

}  // namespace pearl::seal
