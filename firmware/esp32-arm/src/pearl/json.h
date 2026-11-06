// Canonical JSON, byte-identical to apps/backend/src/shared/canonical.ts: keys sorted (ASCII order), no whitespace,
// numbers written exactly as JavaScript's JSON.stringify writes them (shortest round-trip), strings escaped as
// JSON.stringify does. Every hash in a run log is computed over this form, so the TypeScript verifier and the board
// must agree to the byte. Portable: compiles on the ESP32 and on the laptop (host tests).
#pragma once
#include <ArduinoJson.h>
#include <string>

namespace pearl {

/** A double as JavaScript's Number.prototype.toString / JSON.stringify writes it (finite values only). */
std::string jsNumber(double v);

/** Appends s as a JSON string literal, escaped exactly like JSON.stringify. */
void jsString(std::string& out, const char* s, size_t n);
inline void jsString(std::string& out, const std::string& s) { jsString(out, s.data(), s.size()); }

/**
 * Parses JSON into `doc` with numbers read by strtod (correctly rounded, like JSON.parse), so a model's 0.94 becomes
 * the same double JavaScript sees. ArduinoJson's own float parser is not always correctly rounded. Strict: rejects
 * trailing garbage, NaN/Infinity, comments and unescaped control characters; nesting is limited to 32.
 */
bool parseExact(const char* text, JsonDocument& doc);
bool parseExact(const std::string& text, JsonDocument& doc);

/** "2026-11-06T05:22:09.120Z" → milliseconds since the Unix epoch (UTC; no libc timegm on the ESP32). 0 if malformed. */
uint64_t isoToEpochMs(const std::string& iso);

/** Canonical JSON of an ArduinoJson value. Returns false (and leaves `out` partial) for non-finite numbers. */
bool canonical(JsonVariantConst v, std::string& out);
std::string canonical(JsonVariantConst v);

}  // namespace pearl
