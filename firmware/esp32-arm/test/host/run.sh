#!/bin/sh
# Builds and runs the firmware core's host tests, then has the REAL TypeScript code open what the board locked.
# Needs: Homebrew mbedtls@3 (same 3.6 line as the ESP32 core) and ArduinoJson from `pio run`.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
FW="$HERE/../.."
MBED="$(brew --prefix mbedtls@3)"
AJ="$FW/.pio/libdeps/serial/ArduinoJson/src"
OUT="${TMPDIR:-/tmp}/pearl-host-tests"
clang++ -std=c++17 -O1 -g -Wall -Wno-unused-function \
  -DVECTORS_PATH="\"$HERE/vectors.json\"" -DOUT_DIR="\"$HERE/out\"" \
  -I"$AJ" -I"$MBED/include" -I"$FW/src" \
  "$HERE"/*.cpp "$FW"/src/pearl/*.cpp \
  -L"$MBED/lib" -lmbedcrypto -o "$OUT"
"$OUT"
echo
echo "TypeScript opens what the board locked:"
cd "$FW/../../apps/backend" && npx tsx src/scripts/fw-crosscheck.ts
