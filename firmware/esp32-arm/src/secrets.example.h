// Copy to secrets.h (gitignored). Testnet keys only: anyone holding the board can read its flash.
#pragma once
#define WIFI_SSID "your-hotspot"
#define WIFI_PASS "your-password"

// ---- env:ws (the laptop drives the arm over Wi-Fi)
#define WS_HOST "192.168.43.10"   // the laptop's IP on the hotspot
#define WS_PORT 8081

// ---- env:device (the robot runs everything itself; the dashboard server reads http://<board-ip>:8070)
#define OG_API_KEY "sk-..."                       // 0G Compute Router key (pc.0g.ai)
#define OG_MODEL "glm-5.3-flash"                  // an image-capable model (pnpm og:smoke)
// other 0G models tried in order when OG_MODEL's provider is down (5xx, 429, no response, no provider for the trust mode),
// inside the same time budget; "" = none. Leave out for the default list below.
#define OG_MODEL_FALLBACKS "qwen2.5-vl-72b-instruct,gemini-2.5-flash-lite"
#define OG_BASE_URL "https://router-api.0g.ai/v1"
#define OG_ANCHOR_ADDRESS ""                       // EpisodeAnchor on Galileo (pnpm anchor:deploy)
#define ARKIV_ACCESS_KEY ""                        // hub.arkiv.network/access-keys ("" = public, rate-limited)
#define CAMERA_URL ""                              // phone camera snapshot URL, e.g. http://192.168.43.2:8080/shot.jpg ("" = no camera)
// plain-HTTP 0G Storage nodes on Galileo (the turbo indexer needs TLS 1.3, which the ESP32 core lacks);
// refresh with: curl -s https://indexer-storage-testnet-turbo.0g.ai -d '{"jsonrpc":"2.0","method":"indexer_getShardedNodes","id":1}'
#define OG_STORAGE_NODES "http://34.83.53.209:5678,http://34.169.28.106:5678,http://34.19.125.196:5678,http://34.102.76.235:5678"

// ---- offline relay + mesh (optional; safe defaults when left out)
// #define PEARL_RELAY_URL "http://192.168.43.10:8080/api/relay"  // laptop relay if mDNS is blocked ("" = mDNS only)
// #define PEARL_BLE 0                                            // no Bluetooth at all (no BLE relay, no mesh)
// #define PEARL_MESH 0                                           // BLE peripheral only (no pulling from peers)
// #define PEARL_OUTBOX_CAP 2097152                               // bytes of own bundles kept (LittleFS is 3.4 MB)
// #define PEARL_CARRY_CAP 1048576                                // bytes of other robots' bundles carried
