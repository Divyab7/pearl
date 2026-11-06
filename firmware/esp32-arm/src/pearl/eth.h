// The robot's Ethereum identity, built on mbedTLS secp256k1 (no extra library): key → address (EIP-55),
// EIP-191 personal_sign (what ethers' Wallet.signMessage produces, so the verifier recovers this robot), and signed
// legacy EIP-155 transactions for 0G Chain and Arkiv. Signatures use RFC 6979 deterministic nonces and low-s, exactly
// like ethers v6, so identical inputs give identical bytes on the board and in Node (checked by the host tests).
#pragma once
#include <string>
#include "bytes.h"

namespace pearl::eth {

struct Key {
  uint8_t priv[32];
  uint8_t pub[64];  // uncompressed X||Y
  uint8_t addr[20];
  std::string address;  // 0x… EIP-55 checksummed
};

bool keyFromPrivate(const uint8_t priv[32], Key& out);
bool newKey(Key& out);
std::string checksumAddress(const uint8_t addr[20]);

/** Signs a 32-byte digest: r, s (low-s) and the recovery id (0/1). */
bool signDigest(const Key& k, const uint8_t digest[32], uint8_t r[32], uint8_t s[32], int& recid);

/** keccak256("\x19Ethereum Signed Message:\n" + len + msg). */
void personalHash(const std::string& msg, uint8_t out[32]);
/** 0x + r + s + v (27/28), 65 bytes in hex: the format ethers.verifyMessage expects. */
std::string personalSign(const Key& k, const std::string& msg);

// ---- RLP
Bytes rlpBytes(const Bytes& b);
Bytes rlpList(const std::vector<Bytes>& items);
/** Big-endian with leading zeros stripped (RLP integers; 0 → empty). */
Bytes uintBytes(uint64_t v);
Bytes stripZeros(const Bytes& b);
/** A decimal string (wei can exceed 64 bits) → minimal big-endian bytes; false if not a number. */
bool decimalToBytes(const std::string& dec, Bytes& out);

struct LegacyTx {
  uint64_t nonce = 0;
  Bytes gasPrice;  // big-endian, any length
  uint64_t gasLimit = 0;
  Bytes to;        // 20 bytes
  Bytes value;     // big-endian, any length (empty = 0)
  Bytes data;
  uint64_t chainId = 0;
};

/** The signed raw transaction (EIP-155 legacy, type 0), ready for eth_sendRawTransaction. */
bool signLegacy(const Key& k, const LegacyTx& tx, Bytes& raw);

}  // namespace pearl::eth
