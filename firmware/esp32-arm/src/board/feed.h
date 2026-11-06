// env:device — the live feed (/api/stream, Server-Sent Events), same events as the TypeScript device program:
// tel (≤ 10 Hz), device, record, status, episode, meta.
#pragma once
#include <Network.h>
#include <string>

namespace feed {
void begin();
void addClient(NetworkClient& c);
void send(const char* event, const std::string& data);
void fromArm(const char* line, size_t n, bool tel);
}  // namespace feed
