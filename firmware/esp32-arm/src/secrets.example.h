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
#define OG_BASE_URL "https://router-api.0g.ai/v1"
#define OG_ANCHOR_ADDRESS ""                       // EpisodeAnchor on Galileo (pnpm anchor:deploy)
#define ARKIV_ACCESS_KEY ""                        // hub.arkiv.network/access-keys ("" = public, rate-limited)
#define CAMERA_URL ""                              // phone camera snapshot URL, e.g. http://192.168.43.2:8080/shot.jpg ("" = no camera)
// plain-HTTP 0G Storage nodes on Galileo (the turbo indexer needs TLS 1.3, which the ESP32 core lacks);
// refresh with: curl -s https://indexer-storage-testnet-turbo.0g.ai -d '{"jsonrpc":"2.0","method":"indexer_getShardedNodes","id":1}'
#define OG_STORAGE_NODES "http://34.83.53.209:5678,http://34.169.28.106:5678,http://34.19.125.196:5678,http://34.102.76.235:5678"
