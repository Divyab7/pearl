// Byte helpers shared by every core module: hex, base64 (standard and URL-safe), SHA-256 (mbedTLS), Keccak-256
// (portable; the ESP32's mbedTLS has no SHA-3) and the platform's random source.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace pearl {

using Bytes = std::vector<uint8_t>;

/** Filled by the platform: esp_fill_random on the ESP32, /dev/urandom on the laptop. */
void randomFill(uint8_t* out, size_t n);
Bytes randomBytes(size_t n);

std::string toHex(const uint8_t* p, size_t n);
inline std::string toHex(const Bytes& b) { return toHex(b.data(), b.size()); }
inline std::string to0x(const Bytes& b) { return "0x" + toHex(b); }
/** Accepts "0x…" or bare hex; returns false on odd length or a non-hex digit. */
bool fromHex(const std::string& s, Bytes& out);

std::string base64(const uint8_t* p, size_t n);
inline std::string base64(const Bytes& b) { return base64(b.data(), b.size()); }
bool unbase64(const std::string& s, Bytes& out);
/** RFC 4648 §5 without padding (JWK coordinates). */
std::string base64url(const uint8_t* p, size_t n);
bool unbase64url(const std::string& s, Bytes& out);

void sha256(const uint8_t* p, size_t n, uint8_t out[32]);
Bytes sha256(const Bytes& b);
std::string sha256Hex(const std::string& s);

void keccak256(const uint8_t* p, size_t n, uint8_t out[32]);
Bytes keccak256(const Bytes& b);
inline Bytes keccak256(const std::string& s) { return keccak256(Bytes(s.begin(), s.end())); }

inline Bytes utf8(const std::string& s) { return Bytes(s.begin(), s.end()); }

}  // namespace pearl
