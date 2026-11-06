#include "eth.h"
#include <mbedtls/bignum.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <cstring>

namespace pearl::eth {

static int rng(void*, unsigned char* out, size_t n) {
  randomFill(out, n);
  return 0;
}

namespace {
/** secp256k1 group + scratch, freed on scope exit. */
struct Curve {
  mbedtls_ecp_group grp;
  Curve() {
    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256K1);
  }
  ~Curve() { mbedtls_ecp_group_free(&grp); }
};
struct Mpi {
  mbedtls_mpi v;
  Mpi() { mbedtls_mpi_init(&v); }
  ~Mpi() { mbedtls_mpi_free(&v); }
  mbedtls_mpi* operator&() { return &v; }
};
struct Point {
  mbedtls_ecp_point v;
  Point() { mbedtls_ecp_point_init(&v); }
  ~Point() { mbedtls_ecp_point_free(&v); }
  mbedtls_ecp_point* operator&() { return &v; }
};
}  // namespace

std::string checksumAddress(const uint8_t addr[20]) {
  std::string lower = toHex(addr, 20);
  uint8_t h[32];
  keccak256(reinterpret_cast<const uint8_t*>(lower.data()), lower.size(), h);
  std::string out = "0x";
  for (int i = 0; i < 40; i++) {
    char c = lower[i];
    int nib = (h[i / 2] >> (i % 2 ? 0 : 4)) & 0xF;
    out.push_back((c >= 'a' && c <= 'f' && nib >= 8) ? static_cast<char>(c - 32) : c);
  }
  return out;
}

bool keyFromPrivate(const uint8_t priv[32], Key& out) {
  Curve c;
  Mpi d;
  Point Q;
  if (mbedtls_mpi_read_binary(&d, priv, 32)) return false;
  if (mbedtls_ecp_check_privkey(&c.grp, &d)) return false;
  if (mbedtls_ecp_mul(&c.grp, &Q, &d, &c.grp.G, rng, nullptr)) return false;
  memcpy(out.priv, priv, 32);
  mbedtls_mpi_write_binary(&Q.v.private_X, out.pub, 32);
  mbedtls_mpi_write_binary(&Q.v.private_Y, out.pub + 32, 32);
  uint8_t h[32];
  keccak256(out.pub, 64, h);
  memcpy(out.addr, h + 12, 20);
  out.address = checksumAddress(out.addr);
  return true;
}

bool newKey(Key& out) {
  for (int i = 0; i < 16; i++) {
    uint8_t p[32];
    randomFill(p, 32);
    if (keyFromPrivate(p, out)) return true;
  }
  return false;
}

/** Q = r⁻¹(s·R − z·G) for the R with x = r and y parity `parity`; true when Q equals `pub`. */
static bool recovers(Curve& c, const mbedtls_mpi* r, const mbedtls_mpi* s, const uint8_t digest[32], int parity, const uint8_t pub[64]) {
  const mbedtls_mpi* p = &c.grp.P;
  const mbedtls_mpi* n = &c.grp.N;
  Mpi x3, rhs, e, y, rinv, u1, u2, t, ex;
  Point R, Q;
  // y² = x³ + 7 (mod p); p ≡ 3 (mod 4) so y = rhs^((p+1)/4)
  if (mbedtls_mpi_mul_mpi(&x3, r, r) || mbedtls_mpi_mod_mpi(&x3, &x3, p) || mbedtls_mpi_mul_mpi(&x3, &x3, r) ||
      mbedtls_mpi_mod_mpi(&x3, &x3, p) || mbedtls_mpi_add_int(&rhs, &x3, 7) || mbedtls_mpi_mod_mpi(&rhs, &rhs, p))
    return false;
  if (mbedtls_mpi_add_int(&ex, p, 1) || mbedtls_mpi_shift_r(&ex, 2) || mbedtls_mpi_exp_mod(&y, &rhs, &ex, p, nullptr)) return false;
  if (static_cast<int>(mbedtls_mpi_get_bit(&y, 0)) != parity && mbedtls_mpi_sub_mpi(&y, p, &y)) return false;
  if (mbedtls_mpi_copy(&R.v.private_X, r) || mbedtls_mpi_copy(&R.v.private_Y, &y) || mbedtls_mpi_lset(&R.v.private_Z, 1)) return false;
  if (mbedtls_ecp_check_pubkey(&c.grp, &R)) return false;
  if (mbedtls_mpi_read_binary(&e, digest, 32) || mbedtls_mpi_mod_mpi(&e, &e, n)) return false;
  if (mbedtls_mpi_inv_mod(&rinv, r, n)) return false;
  // u1 = −e·r⁻¹ mod n, u2 = s·r⁻¹ mod n
  if (mbedtls_mpi_mul_mpi(&t, &e, &rinv) || mbedtls_mpi_mod_mpi(&t, &t, n)) return false;
  if (mbedtls_mpi_cmp_int(&t, 0) == 0) mbedtls_mpi_lset(&u1, 0);
  else if (mbedtls_mpi_sub_mpi(&u1, n, &t)) return false;
  if (mbedtls_mpi_mul_mpi(&u2, s, &rinv) || mbedtls_mpi_mod_mpi(&u2, &u2, n)) return false;
  if (mbedtls_ecp_muladd(&c.grp, &Q, &u1, &c.grp.G, &u2, &R)) return false;
  uint8_t q[64];
  mbedtls_mpi_write_binary(&Q.v.private_X, q, 32);
  mbedtls_mpi_write_binary(&Q.v.private_Y, q + 32, 32);
  return memcmp(q, pub, 64) == 0;
}

bool signDigest(const Key& k, const uint8_t digest[32], uint8_t rOut[32], uint8_t sOut[32], int& recid) {
  Curve c;
  Mpi d, r, s, half;
  if (mbedtls_mpi_read_binary(&d, k.priv, 32)) return false;
  if (mbedtls_ecdsa_sign_det_ext(&c.grp, &r, &s, &d, digest, 32, MBEDTLS_MD_SHA256, rng, nullptr)) return false;
  // low-s (EIP-2): s > n/2 → n − s
  if (mbedtls_mpi_copy(&half, &c.grp.N) || mbedtls_mpi_shift_r(&half, 1)) return false;
  if (mbedtls_mpi_cmp_mpi(&s, &half) > 0 && mbedtls_mpi_sub_mpi(&s, &c.grp.N, &s)) return false;
  recid = -1;
  for (int v = 0; v < 2; v++) {
    if (recovers(c, &r, &s, digest, v, k.pub)) {
      recid = v;
      break;
    }
  }
  if (recid < 0) return false;
  mbedtls_mpi_write_binary(&r, rOut, 32);
  mbedtls_mpi_write_binary(&s, sOut, 32);
  return true;
}

void personalHash(const std::string& msg, uint8_t out[32]) {
  std::string pre = "\x19" "Ethereum Signed Message:\n" + std::to_string(msg.size()) + msg;
  keccak256(reinterpret_cast<const uint8_t*>(pre.data()), pre.size(), out);
}

std::string personalSign(const Key& k, const std::string& msg) {
  uint8_t h[32], r[32], s[32];
  int recid;
  personalHash(msg, h);
  if (!signDigest(k, h, r, s, recid)) return "";
  uint8_t sig[65];
  memcpy(sig, r, 32);
  memcpy(sig + 32, s, 32);
  sig[64] = static_cast<uint8_t>(27 + recid);
  return "0x" + toHex(sig, 65);
}

// ---------------------------------------------------------------- RLP
static Bytes rlpLen(size_t len, uint8_t offset) {
  if (len < 56) return Bytes{static_cast<uint8_t>(offset + len)};
  Bytes l = uintBytes(len);
  Bytes o{static_cast<uint8_t>(offset + 55 + l.size())};
  o.insert(o.end(), l.begin(), l.end());
  return o;
}

Bytes rlpBytes(const Bytes& b) {
  if (b.size() == 1 && b[0] < 0x80) return b;
  Bytes o = rlpLen(b.size(), 0x80);
  o.insert(o.end(), b.begin(), b.end());
  return o;
}

Bytes rlpList(const std::vector<Bytes>& items) {
  Bytes body;
  for (const Bytes& i : items) body.insert(body.end(), i.begin(), i.end());
  Bytes o = rlpLen(body.size(), 0xc0);
  o.insert(o.end(), body.begin(), body.end());
  return o;
}

Bytes uintBytes(uint64_t v) {
  Bytes o;
  for (int i = 7; i >= 0; i--) {
    uint8_t b = static_cast<uint8_t>(v >> (8 * i));
    if (o.empty() && b == 0) continue;
    o.push_back(b);
  }
  return o;
}

Bytes stripZeros(const Bytes& b) {
  size_t i = 0;
  while (i < b.size() && b[i] == 0) i++;
  return Bytes(b.begin() + static_cast<long>(i), b.end());
}

bool decimalToBytes(const std::string& dec, Bytes& out) {
  if (dec.empty()) return false;
  for (char ch : dec)
    if (ch < '0' || ch > '9') return false;
  Mpi x;
  if (mbedtls_mpi_read_string(&x, 10, dec.c_str())) return false;
  size_t n = mbedtls_mpi_size(&x.v);
  out.assign(n, 0);
  if (n && mbedtls_mpi_write_binary(&x, out.data(), n)) return false;
  return true;
}

bool signLegacy(const Key& k, const LegacyTx& tx, Bytes& raw) {
  if (tx.to.size() != 20) return false;
  std::vector<Bytes> f = {
      rlpBytes(uintBytes(tx.nonce)), rlpBytes(stripZeros(tx.gasPrice)), rlpBytes(uintBytes(tx.gasLimit)), rlpBytes(tx.to),
      rlpBytes(stripZeros(tx.value)), rlpBytes(tx.data),
  };
  std::vector<Bytes> unsignedF = f;
  unsignedF.push_back(rlpBytes(uintBytes(tx.chainId)));
  unsignedF.push_back(rlpBytes(Bytes{}));
  unsignedF.push_back(rlpBytes(Bytes{}));
  Bytes pre = rlpList(unsignedF);
  uint8_t h[32], r[32], s[32];
  keccak256(pre.data(), pre.size(), h);
  int recid;
  if (!signDigest(k, h, r, s, recid)) return false;
  f.push_back(rlpBytes(uintBytes(tx.chainId * 2 + 35 + static_cast<uint64_t>(recid))));
  f.push_back(rlpBytes(stripZeros(Bytes(r, r + 32))));
  f.push_back(rlpBytes(stripZeros(Bytes(s, s + 32))));
  raw = rlpList(f);
  return true;
}

}  // namespace pearl::eth
