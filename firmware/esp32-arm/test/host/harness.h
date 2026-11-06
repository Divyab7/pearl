// Minimal host test harness: CHECK/CHECK_EQ count failures, main() runs every TEST and returns non-zero on failure.
#pragma once
#include <ArduinoJson.h>
#include <cstdio>
#include <fstream>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

struct TestCase {
  const char* name;
  std::function<void()> fn;
};
inline std::vector<TestCase>& tests() {
  static std::vector<TestCase> t;
  return t;
}
inline int& failures() {
  static int f = 0;
  return f;
}
struct Reg {
  Reg(const char* n, std::function<void()> f) { tests().push_back({n, f}); }
};
#define TEST(name)                         \
  static void name();                      \
  static Reg reg_##name(#name, name);      \
  static void name()

#define CHECK(cond)                                                           \
  do {                                                                        \
    if (!(cond)) {                                                            \
      failures()++;                                                           \
      fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);       \
    }                                                                         \
  } while (0)

#define CHECK_EQ(a, b)                                                                                   \
  do {                                                                                                   \
    auto _a = (a);                                                                                       \
    auto _b = (b);                                                                                       \
    if (!(_a == _b)) {                                                                                   \
      failures()++;                                                                                      \
      std::ostringstream _o;                                                                             \
      _o << _a << "  !=  " << _b;                                                                        \
      fprintf(stderr, "  FAIL %s:%d  %s == %s\n      %s\n", __FILE__, __LINE__, #a, #b, _o.str().c_str()); \
    }                                                                                                    \
  } while (0)

/** vectors.json, written by apps/backend/src/scripts/fw-vectors.ts from the real TypeScript code. */
inline JsonDocument& vectors() {
  static JsonDocument doc;
  static bool loaded = false;
  if (!loaded) {
    std::ifstream f(VECTORS_PATH);
    std::stringstream ss;
    ss << f.rdbuf();
    if (deserializeJson(doc, ss.str())) fprintf(stderr, "cannot read %s\n", VECTORS_PATH);
    loaded = true;
  }
  return doc;
}
