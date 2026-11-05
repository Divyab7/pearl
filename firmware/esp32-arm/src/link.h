// Newline-delimited JSON link (build spec §7.5): USB serial, or WebSocket text frames in env:ws.
#pragma once
#include <ArduinoJson.h>

namespace hostlink {
void begin();
void poll();                                  // reads input, dispatches complete lines to commands::handle
void send(const JsonDocument& doc);           // one line out
void nack(const char* id, const char* reason);
void event(const char* ev);                   // {"t":"event","ev":...}
void eventInt(const char* ev, const char* key, long v);
void eventFloat(const char* ev, const char* key, float v);
void eventStr(const char* ev, const char* key, const char* v);
}  // namespace hostlink

namespace commands {
void handle(JsonDocument& doc);
}
