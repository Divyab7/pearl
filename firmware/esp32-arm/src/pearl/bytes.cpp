#include "bytes.h"
#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>
#include <cstring>

namespace pearl {

Bytes randomBytes(size_t n) {
  Bytes b(n);
  randomFill(b.data(), n);
  return b;
}

std::string toHex(const uint8_t* p, size_t n) {
  static const char* h = "0123456789abcdef";
  std::string s(n * 2, '0');
  for (size_t i = 0; i < n; i++) {
    s[2 * i] = h[p[i] >> 4];
    s[2 * i + 1] = h[p[i] & 15];
  }
  return s;
}

static int nib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool fromHex(const std::string& in, Bytes& out) {
  size_t o = (in.size() >= 2 && in[0] == '0' && (in[1] == 'x' || in[1] == 'X')) ? 2 : 0;
  if ((in.size() - o) % 2) return false;
  out.clear();
  out.reserve((in.size() - o) / 2);
  for (size_t i = o; i < in.size(); i += 2) {
    int a = nib(in[i]), b = nib(in[i + 1]);
    if (a < 0 || b < 0) return false;
    out.push_back(static_cast<uint8_t>(a << 4 | b));
  }
  return true;
}

std::string base64(const uint8_t* p, size_t n) {
  size_t len = 0;
  mbedtls_base64_encode(nullptr, 0, &len, p, n);
  std::string s(len, '\0');
  if (mbedtls_base64_encode(reinterpret_cast<unsigned char*>(&s[0]), len, &len, p, n) != 0) return "";
  s.resize(len);  // len excludes the terminating NUL
  return s;
}

bool unbase64(const std::string& s, Bytes& out) {
  size_t len = 0;
  int r = mbedtls_base64_decode(nullptr, 0, &len, reinterpret_cast<const unsigned char*>(s.data()), s.size());
  if (r != 0 && r != MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL) return false;
  out.resize(len);
  if (mbedtls_base64_decode(out.data(), len, &len, reinterpret_cast<const unsigned char*>(s.data()), s.size()) != 0) return false;
  out.resize(len);
  return true;
}

std::string base64url(const uint8_t* p, size_t n) {
  std::string s = base64(p, n);
  for (char& c : s) {
    if (c == '+') c = '-';
    else if (c == '/') c = '_';
  }
  while (!s.empty() && s.back() == '=') s.pop_back();
  return s;
}

bool unbase64url(const std::string& in, Bytes& out) {
  std::string s = in;
  for (char& c : s) {
    if (c == '-') c = '+';
    else if (c == '_') c = '/';
  }
  while (s.size() % 4) s.push_back('=');
  return unbase64(s, out);
}

void sha256(const uint8_t* p, size_t n, uint8_t out[32]) { mbedtls_sha256(p, n, out, 0); }

Bytes sha256(const Bytes& b) {
  Bytes o(32);
  sha256(b.data(), b.size(), o.data());
  return o;
}

std::string sha256Hex(const std::string& s) {
  uint8_t o[32];
  sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size(), o);
  return toHex(o, 32);
}

// ---------------------------------------------------------------- Keccak-256 (Ethereum: pad 0x01, not SHA3's 0x06)
static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL, 0x000000000000808bULL,
    0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000aULL, 0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int ROT[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const int PI[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

static inline uint64_t rol(uint64_t x, int s) { return (x << s) | (x >> (64 - s)); }

static void keccakf(uint64_t st[25]) {
  for (int round = 0; round < 24; round++) {
    uint64_t bc[5];
    for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (int i = 0; i < 5; i++) {
      uint64_t t = bc[(i + 4) % 5] ^ rol(bc[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    uint64_t t = st[1];
    for (int i = 0; i < 24; i++) {
      int j = PI[i];
      uint64_t tmp = st[j];
      st[j] = rol(t, ROT[i]);
      t = tmp;
    }
    for (int j = 0; j < 25; j += 5) {
      for (int i = 0; i < 5; i++) bc[i] = st[j + i];
      for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
    }
    st[0] ^= RC[round];
  }
}

void keccak256(const uint8_t* p, size_t n, uint8_t out[32]) {
  const size_t rate = 136;
  uint64_t st[25] = {0};
  uint8_t block[136];
  while (n >= rate) {
    for (size_t i = 0; i < rate / 8; i++) {
      uint64_t w = 0;
      for (int b = 0; b < 8; b++) w |= static_cast<uint64_t>(p[i * 8 + b]) << (8 * b);
      st[i] ^= w;
    }
    keccakf(st);
    p += rate;
    n -= rate;
  }
  memset(block, 0, rate);
  memcpy(block, p, n);
  block[n] ^= 0x01;
  block[rate - 1] ^= 0x80;
  for (size_t i = 0; i < rate / 8; i++) {
    uint64_t w = 0;
    for (int b = 0; b < 8; b++) w |= static_cast<uint64_t>(block[i * 8 + b]) << (8 * b);
    st[i] ^= w;
  }
  keccakf(st);
  for (int i = 0; i < 4; i++)
    for (int b = 0; b < 8; b++) out[i * 8 + b] = static_cast<uint8_t>(st[i] >> (8 * b));
}

Bytes keccak256(const Bytes& b) {
  Bytes o(32);
  keccak256(b.data(), b.size(), o.data());
  return o;
}

}  // namespace pearl
