#include "json.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace pearl {

// ECMAScript Number::toString (ECMA-262 §6.1.6.1.20) over the shortest digits that round-trip.
std::string jsNumber(double v) {
  if (std::isnan(v) || std::isinf(v)) return "null";
  if (v == 0) return "0";  // also -0
  std::string sign = v < 0 ? "-" : "";
  double a = std::fabs(v);
  char buf[40];
  int p = 1;
  for (; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*e", p - 1, a);
    if (strtod(buf, nullptr) == a) break;
  }
  // buf = d.dddde[+-]XX
  const char* e = strchr(buf, 'e');
  int exp10 = atoi(e + 1);
  std::string digits;
  for (const char* c = buf; c < e; c++)
    if (*c >= '0' && *c <= '9') digits.push_back(*c);
  while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
  int k = static_cast<int>(digits.size());
  int n = exp10 + 1;  // value = 0.digits × 10^n
  std::string out = sign;
  if (k <= n && n <= 21) {
    out += digits;
    out.append(n - k, '0');
  } else if (0 < n && n <= 21) {
    out += digits.substr(0, n);
    out += '.';
    out += digits.substr(n);
  } else if (-6 < n && n <= 0) {
    out += "0.";
    out.append(-n, '0');
    out += digits;
  } else {
    int ee = n - 1;
    out += digits[0];
    if (k > 1) {
      out += '.';
      out += digits.substr(1);
    }
    out += 'e';
    out += ee < 0 ? '-' : '+';
    out += std::to_string(ee < 0 ? -ee : ee);
  }
  return out;
}

void jsString(std::string& out, const char* s, size_t n) {
  static const char* hex = "0123456789abcdef";
  out.push_back('"');
  for (size_t i = 0; i < n; i++) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out.push_back(hex[c >> 4]);
          out.push_back(hex[c & 15]);
        } else {
          out.push_back(static_cast<char>(c));  // UTF-8 passes through, as JSON.stringify does
        }
    }
  }
  out.push_back('"');
}

static bool enc(JsonVariantConst v, std::string& out) {
  if (v.isNull()) {
    out += "null";
    return true;
  }
  if (v.is<bool>()) {
    out += v.as<bool>() ? "true" : "false";
    return true;
  }
  if (v.is<const char*>()) {
    const char* s = v.as<const char*>();
    jsString(out, s, strlen(s));
    return true;
  }
  if (v.is<JsonArrayConst>()) {
    out.push_back('[');
    bool first = true;
    for (JsonVariantConst x : v.as<JsonArrayConst>()) {
      if (!first) out.push_back(',');
      first = false;
      if (!enc(x, out)) return false;
    }
    out.push_back(']');
    return true;
  }
  if (v.is<JsonObjectConst>()) {
    JsonObjectConst o = v.as<JsonObjectConst>();
    std::vector<JsonPairConst> kv;
    for (JsonPairConst p : o) kv.push_back(p);
    std::sort(kv.begin(), kv.end(), [](const JsonPairConst& a, const JsonPairConst& b) { return strcmp(a.key().c_str(), b.key().c_str()) < 0; });
    out.push_back('{');
    bool first = true;
    for (const JsonPairConst& p : kv) {
      if (!first) out.push_back(',');
      first = false;
      const char* k = p.key().c_str();
      jsString(out, k, strlen(k));
      out.push_back(':');
      if (!enc(p.value(), out)) return false;
    }
    out.push_back('}');
    return true;
  }
  // numbers: integers exactly, everything else through the JS formatter
  if (v.is<long long>()) {
    out += std::to_string(v.as<long long>());
    return true;
  }
  if (v.is<unsigned long long>()) {
    out += std::to_string(v.as<unsigned long long>());
    return true;
  }
  double d = v.as<double>();
  if (!std::isfinite(d)) return false;
  out += jsNumber(d);
  return true;
}

bool canonical(JsonVariantConst v, std::string& out) { return enc(v, out); }

uint64_t isoToEpochMs(const std::string& iso) {
  int y, mo, d, h, mi, s, ms = 0;
  if (sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%d.%dZ", &y, &mo, &d, &h, &mi, &s, &ms) < 6) return 0;
  // days from civil (H. Hinnant's algorithm)
  y -= mo <= 2;
  long era = (y >= 0 ? y : y - 399) / 400;
  long yoe = y - era * 400;
  long doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long long days = era * 146097LL + doe - 719468;
  return static_cast<uint64_t>(((days * 24 + h) * 60 + mi) * 60 + s) * 1000ULL + static_cast<uint64_t>(ms);
}

// ---------------------------------------------------------------- exact parser
namespace {
struct Parser {
  const char* p;
  const char* end;
  int depth = 0;
  void ws() {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
  }
  static void utf8(std::string& o, uint32_t cp) {
    if (cp < 0x80) o.push_back(static_cast<char>(cp));
    else if (cp < 0x800) {
      o.push_back(static_cast<char>(0xC0 | cp >> 6));
      o.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      o.push_back(static_cast<char>(0xE0 | cp >> 12));
      o.push_back(static_cast<char>(0x80 | (cp >> 6 & 0x3F)));
      o.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      o.push_back(static_cast<char>(0xF0 | cp >> 18));
      o.push_back(static_cast<char>(0x80 | (cp >> 12 & 0x3F)));
      o.push_back(static_cast<char>(0x80 | (cp >> 6 & 0x3F)));
      o.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  bool hex4(uint32_t& v) {
    if (end - p < 4) return false;
    v = 0;
    for (int i = 0; i < 4; i++) {
      char c = *p++;
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else return false;
    }
    return true;
  }
  bool str(std::string& o) {
    if (p >= end || *p != '"') return false;
    p++;
    while (p < end && *p != '"') {
      unsigned char c = static_cast<unsigned char>(*p);
      if (c < 0x20) return false;
      if (c != '\\') {
        o.push_back(*p++);
        continue;
      }
      p++;
      if (p >= end) return false;
      char e = *p++;
      switch (e) {
        case '"': o.push_back('"'); break;
        case '\\': o.push_back('\\'); break;
        case '/': o.push_back('/'); break;
        case 'b': o.push_back('\b'); break;
        case 'f': o.push_back('\f'); break;
        case 'n': o.push_back('\n'); break;
        case 'r': o.push_back('\r'); break;
        case 't': o.push_back('\t'); break;
        case 'u': {
          uint32_t cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
            const char* save = p;
            p += 2;
            uint32_t lo;
            if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            else p = save;
          }
          utf8(o, cp);
          break;
        }
        default: return false;
      }
    }
    if (p >= end) return false;
    p++;
    return true;
  }
  bool num(JsonVariant v) {
    const char* s = p;
    bool frac = false;
    if (p < end && *p == '-') p++;
    if (p >= end || !(*p >= '0' && *p <= '9')) return false;
    if (*p == '0') p++;
    else while (p < end && *p >= '0' && *p <= '9') p++;
    if (p < end && *p == '.') {
      frac = true;
      p++;
      if (p >= end || !(*p >= '0' && *p <= '9')) return false;
      while (p < end && *p >= '0' && *p <= '9') p++;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
      frac = true;
      p++;
      if (p < end && (*p == '+' || *p == '-')) p++;
      if (p >= end || !(*p >= '0' && *p <= '9')) return false;
      while (p < end && *p >= '0' && *p <= '9') p++;
    }
    std::string t(s, p);
    if (!frac && t.size() <= 18) {
      long long i = strtoll(t.c_str(), nullptr, 10);
      return v.set(i == 0 ? 0LL : i);
    }
    return v.set(strtod(t.c_str(), nullptr));
  }
  bool lit(const char* w) {
    size_t n = strlen(w);
    if (static_cast<size_t>(end - p) < n || strncmp(p, w, n) != 0) return false;
    p += n;
    return true;
  }
  bool value(JsonVariant v) {
    ws();
    if (p >= end) return false;
    if (*p == '{') {
      if (++depth > 32) return false;
      p++;
      JsonObject o = v.to<JsonObject>();
      ws();
      if (p < end && *p == '}') {
        p++;
        depth--;
        return true;
      }
      for (;;) {
        ws();
        std::string k;
        if (!str(k)) return false;
        ws();
        if (p >= end || *p != ':') return false;
        p++;
        if (!value(o[k].to<JsonVariant>())) return false;
        ws();
        if (p < end && *p == ',') {
          p++;
          continue;
        }
        if (p < end && *p == '}') {
          p++;
          depth--;
          return true;
        }
        return false;
      }
    }
    if (*p == '[') {
      if (++depth > 32) return false;
      p++;
      JsonArray a = v.to<JsonArray>();
      ws();
      if (p < end && *p == ']') {
        p++;
        depth--;
        return true;
      }
      for (;;) {
        if (!value(a.add<JsonVariant>())) return false;
        ws();
        if (p < end && *p == ',') {
          p++;
          continue;
        }
        if (p < end && *p == ']') {
          p++;
          depth--;
          return true;
        }
        return false;
      }
    }
    if (*p == '"') {
      std::string s;
      if (!str(s)) return false;
      return v.set(s);
    }
    if (*p == 't') return lit("true") && v.set(true);
    if (*p == 'f') return lit("false") && v.set(false);
    if (*p == 'n') {
      if (!lit("null")) return false;
      v.set(nullptr);
      return true;
    }
    return num(v);
  }
};
}  // namespace

bool parseExact(const char* text, JsonDocument& doc) { return parseExact(std::string(text), doc); }

bool parseExact(const std::string& text, JsonDocument& doc) {
  doc.clear();
  Parser ps{text.data(), text.data() + text.size()};
  if (!ps.value(doc.to<JsonVariant>())) return false;
  ps.ws();
  return ps.p == ps.end && !doc.overflowed();
}

std::string canonical(JsonVariantConst v) {
  std::string s;
  enc(v, s);
  return s;
}

}  // namespace pearl
