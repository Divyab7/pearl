// Host tests for the firmware's portable core (src/pearl/). Run: test/host/run.sh
#include <cstdio>
#include <cstdlib>
#include "harness.h"
#include "../../src/pearl/bytes.h"

namespace pearl {
void randomFill(uint8_t* out, size_t n) {
  FILE* f = fopen("/dev/urandom", "rb");
  if (!f || fread(out, 1, n, f) != n) abort();
  fclose(f);
}
}  // namespace pearl

int main() {
  for (auto& t : tests()) {
    int before = failures();
    t.fn();
    printf("%s %s\n", failures() == before ? "ok  " : "FAIL", t.name);
  }
  printf("\n%zu tests, %d failed checks\n", tests().size(), failures());
  return failures() ? 1 : 0;
}
