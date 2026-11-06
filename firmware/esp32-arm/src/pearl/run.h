// The run logic, a line-by-line port of the TypeScript device program (orchestrator/poses.ts, policy.ts,
// decision.ts, log.ts, og/router.ts). The verifier replays the policy over the recorded decisions, so every policy
// string, command string and record field must match the TypeScript output exactly; the host tests run a whole run
// through here and have the real TypeScript verifier check it.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include <vector>
#include "bytes.h"

namespace pearl::run {

// ---------------------------------------------------------------- arm config (config/arm.json)
struct Pose {
  int j[4];
};
struct ArmCfg {
  Pose home, safe;
  int gripOpen = 10, gripClosed = 80;
  Pose above[4], down[4];  // A1, A2, A3, BIN
  std::string canonical;   // canonical JSON of arm.json: its sha256 is the armConfigHash in episode_start
};
bool parseArmConfig(const std::string& armJson, ArmCfg& out);
int slotIndex(const std::string& slot);  // A1..A3 → 0..2, BIN → 3, else -1

// ---------------------------------------------------------------- steps and poses
struct Step {
  enum Kind { MOVE, GRIP, SAFE, RESUME } kind;
  int j[4] = {0, 0, 0, 0};
  bool close = false;
};
std::string fmtStep(const Step& s);
std::vector<std::string> commandsOf(const std::vector<Step>& steps);
std::vector<Step> grasp(const ArmCfg& c, int slot);
std::vector<Step> regrasp(const ArmCfg& c, int slot);
std::vector<Step> place(const ArmCfg& c);

// ---------------------------------------------------------------- one decision (DecisionCore)
struct Decision {
  std::string checkpoint;
  bool fromZeroG = false;  // source "0g" vs "failsafe"
  // nullable strings: empty + flag
  std::string model, requestId, httpRequestId, clientRequestId, provider, providerIdentity, cost, zgResKey, reasoning, raw, error;
  bool hasModel = false, hasRequestId = false, hasHttpRequestId = false, hasProvider = false, hasProviderIdentity = false,
       hasCost = false, hasZgResKey = false, hasReasoning = false, hasRaw = false, hasError = false;
  int clientRequestIdEchoed = -1;  // -1 null, 0 false, 1 true
  int teeVerified = -1;            // -1 null, 0 false, 1 true
  JsonDocument parsed;             // null for failsafe
  uint32_t latencyMs = 0;
};
Decision failsafe(const std::string& checkpoint, const std::string& clientRequestId, const std::string& error);

// ---------------------------------------------------------------- 0G Router
struct RouterConfig {
  std::string baseUrl, apiKey, model, trustMode = "verified";
  uint32_t timeoutMs = 30000;
  bool verifyTee = true;
  int maxTokens = 1000;
};
/** The exact request body og/router.ts buildBody() sends (context merged under "checkpoint"). */
std::string routerBody(const RouterConfig& cfg, const std::string& checkpoint, const std::string& systemPrompt,
                       JsonObjectConst context, const std::string& imageDataUrl);
struct HttpResult {
  int status = 0;            // 0 = no response (network error / timeout)
  std::string body, error;   // error set when status == 0
  std::string xRequestId, xClientRequestId, zgResKey;  // response headers ("" if absent)
  bool hasXClientRequestId = false, hasZgResKey = false;
  uint32_t latencyMs = 0;
};
/** callRouter + interpret: a decision from the HTTP result (failsafe on any problem, never a default answer). */
Decision interpret(const std::string& checkpoint, const std::string& clientRequestId, const HttpResult& r, uint32_t timeoutMs);
std::string stripFence(const std::string& s);

// ---------------------------------------------------------------- policy
struct Task {
  std::string color, from;  // pick <color> at <from> → BIN
};
struct PolicyResult {
  std::string policy;
  bool hasOverride = false;
  std::string override_;
  std::vector<Step> steps;
  enum Next { VERIFY_GRASP, VERIFY_PLACE, END, CONTINUE_INTERRUPTED } next = END;
  std::string outcome;  // "" unless next == END
  bool fileClaim = false;
};
PolicyResult policyPlan(const Decision& d, const Task& t, const ArmCfg& c);
PolicyResult policyVerifyGrasp(const Decision& d, const Task& t, const ArmCfg& c, int retriesUsed);
PolicyResult policyVerifyPlace(const Decision& d, const ArmCfg& c, int retriesUsed);
struct IncidentCtx {
  bool hardTrip = false, frozenHand = false, handClear = false;
  std::vector<Step> remaining;
};
PolicyResult policyIncident(const Decision& d, const IncidentCtx& ctx);

// ---------------------------------------------------------------- the hash-chained log
struct Telemetry {
  std::string state = "UNKNOWN";
  std::vector<int> joints;
  int tofMm = -1;
  double accG = -1;
};
class Recorder {
 public:
  Recorder(std::string episodeId, std::string deviceId, std::string armId, Task task, std::string startedAt);
  /** Each returns the record's canonical JSON (with prevHash and recordHash), as broadcast on the live feed. */
  std::string addEvent(const std::string& ts, const std::string& ev, JsonObjectConst data);
  std::string addDecision(const Decision& d, const std::string& ts, const std::string& promptHash, const std::string& frameHash,
                          const std::string& frameRoot, const Telemetry& tel, const PolicyResult& p);
  /** The closed EpisodeLog's canonical JSON (without the device signature); headHash() is final. */
  std::string close(const std::string& outcome, const std::string& endedAt);
  /** The closed log with `device: {address, signature}`, canonical (what the owner unlocks). */
  std::string closedWithDevice(const std::string& address, const std::string& signature);
  const std::string& headHash() const { return head_; }
  const std::string& episodeId() const { return episodeId_; }
  size_t length() const { return count_; }
  std::vector<std::string> requestIds() const { return requestIds_; }
  bool incident() const { return incident_; }
  int severity() const { return severity_; }
  const std::string& startedAt() const { return startedAt_; }
  const std::string& endedAt() const { return endedAt_; }
  const std::string& outcome() const { return outcome_; }
  const std::string& armId() const { return armId_; }

 private:
  std::string push(JsonObject rec);
  std::string episodeId_, deviceId_, armId_, startedAt_, endedAt_, outcome_;
  Task task_;
  std::string head_ = std::string(64, '0');
  size_t count_ = 0;
  std::string records_;  // canonical records joined by ',' (no brackets)
  std::vector<std::string> requestIds_;
  bool incident_ = false;
  int severity_ = 0;
  JsonDocument closed_;
};

/** 0x + sha256 of the canonical JSON array of request ids (og/anchor.ts requestIdsHash). */
std::string requestIdsHash(const std::vector<std::string>& ids);
/** The text the robot signs for a run (shared/deviceKey.ts headMessage). */
inline std::string headMessage(const std::string& episodeId, const std::string& head) {
  return "Pearl episode " + episodeId + " head " + head;
}
inline std::string linkMessage(const std::string& accountId, const std::string& nonce, const std::string& ownerKid) {
  return "Pearl link to account " + accountId + " nonce " + nonce + " owner key " + ownerKid;
}

}  // namespace pearl::run
