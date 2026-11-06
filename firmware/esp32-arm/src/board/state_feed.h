// env:device — a thread-safe snapshot of the run task's status for /api/state and the live feed.
#pragma once
#include <string>

namespace statefeed {
void begin();
void phase(const std::string& phase, const std::string& episodeId);
void task(const std::string& color, const std::string& from);
void outcome(const std::string& outcome);
std::string json();  // {"phase","episodeId","task","outcome","records":0,"lastDecision":null}
bool busy();
void setBusy(bool b);
}  // namespace statefeed
