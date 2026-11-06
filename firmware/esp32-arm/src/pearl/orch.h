// One run, start to sealed log: the C++ port of apps/backend/src/orchestrator/episode.ts + device/monitor.ts.
// Synchronous by design: the board runs it in its own FreeRTOS task, so 0G calls and waits never block the safety
// loop, which keeps running in loop(). Everything outside the logic goes through two interfaces, so the same code runs
// on the board (in-process arm, HTTPS, NTP clock, LittleFS) and in the host tests (simulated arm, scripted 0G answers).
#pragma once
#include <ArduinoJson.h>
#include <atomic>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include "bytes.h"
#include "eth.h"
#include "run.h"
#include "seal.h"

namespace pearl::orch {

/** The arm: commands in (protocol of firmware/commands.cpp), messages out (tel, ack, done, nack, event). */
struct ArmLink {
  virtual ~ArmLink() = default;
  virtual void send(const JsonDocument& cmd) = 0;
  /** Next message from the arm, waiting up to waitMs; false when none arrived. */
  virtual bool recv(JsonDocument& msg, uint32_t waitMs) = 0;
};

using Headers = std::vector<std::pair<std::string, std::string>>;

struct Platform {
  virtual ~Platform() = default;
  virtual uint32_t millis() = 0;
  virtual void sleep(uint32_t ms) = 0;
  /** ISO 8601 UTC with milliseconds, e.g. 2026-11-06T05:10:00.123Z (NTP time on the board). */
  virtual std::string nowIso() = 0;
  virtual run::HttpResult post(const std::string& url, const Headers& headers, const std::string& body, uint32_t timeoutMs) = 0;
  /** No camera configured: false without error. Camera configured but failed: false with `err`. */
  virtual bool camera(Bytes& jpeg, std::string& err) = 0;
  virtual void saveFrame(const std::string& episodeId, size_t idx, const Bytes& locked) = 0;
  virtual void onRecord(const std::string& recordJson) {}
  virtual void onPhase(const std::string& phase, const std::string& episodeId) {}
};

struct Prompts {
  std::string text[4], hash[4];  // PLAN, VERIFY_GRASP, VERIFY_PLACE, INCIDENT
};

/** device/monitor.ts: the latest telemetry, safety state and command outcomes, fed by ArmLink messages. */
class Monitor {
 public:
  explicit Monitor(ArmLink& arm) : arm_(arm) {}
  JsonDocument lastTel, lastSafety;
  bool hasTel = false, handClear = false, hardTrip = false;
  std::function<void(const std::string& ev, JsonObjectConst data)> onEvent;  // events and nacks (recorded in the log)
  std::string state() const { return hasTel ? lastTel["state"].as<std::string>() : "UNKNOWN"; }
  bool takeSafety() {
    bool p = pending_;
    pending_ = false;
    return p;
  }
  bool peekSafety() const { return pending_; }
  void clearTrip() {
    hardTrip = false;
    pending_ = false;
    lastSafety.clear();
  }
  /** Processes arm messages for up to waitMs. */
  void pump(uint32_t waitMs);
  enum class Cmd { OK, NACK, INTERRUPTED, TIMEOUT, STOPPED };
  Cmd awaitCommand(const std::string& id, uint32_t timeoutMs, std::string& reason, Platform& p, const std::atomic<bool>& stop);
  bool waitFor(const std::function<bool(JsonObjectConst tel)>& pred, uint32_t timeoutMs, bool interruptOnSafety, Platform& p);

 private:
  ArmLink& arm_;
  bool pending_ = false;
  std::map<std::string, std::string> outcomes_;  // id → "done" or nack reason
};

struct Result {
  std::string episodeId, outcome, headHash, startedAt, endedAt;
  std::string logCanonical;     // with device signature: the owner's readable log
  std::string sealedCanonical;  // what goes to 0G Storage and what the robot serves
  bool incident = false;
  int severity = 0;
  std::vector<std::string> requestIds;
  std::vector<std::pair<size_t, std::string>> frames;  // decision idx → 0x root of the LOCKED frame
};

class Orchestrator {
 public:
  Orchestrator(Platform& p, ArmLink& arm, const run::ArmCfg& cfg, const Prompts& prompts, const eth::Key& device,
               std::string deviceId, std::string armId);
  run::RouterConfig router;
  std::string blackholeUrl = "http://10.255.255.1";
  std::atomic<bool> cut0g{false};
  /** The linked owner's P-256 key: when set, the run key is also locked for it INSIDE the sealed file ("keys"),
   *  so the owner can open the run from 0G Storage while the robot is offline (as orchestrator/episode.ts). */
  bool hasOwner = false;
  seal::PublicJwk owner;
  Monitor& monitor() { return mon_; }
  /** Refused (false + why) when the arm is TRIPPED or FROZEN_HAND. */
  bool canStart(std::string& why);
  /** Runs one whole run synchronously; `runKey` locks its frames and log. */
  Result run(const run::Task& task, const std::string& episodeId, const Bytes& runKey);
  void requestStop();
  bool busy() const { return busy_; }
  std::string phase() const { return phase_; }

 private:
  run::PolicyResult checkpoint(const std::string& cp, const std::function<run::PolicyResult(const run::Decision&)>& policy, JsonObjectConst extra);
  enum class StepEnd { OK, INTERRUPTED, ERROR };
  StepEnd runSteps(const std::vector<run::Step>& steps, bool endOfEpisode, size_t& interruptedAt, std::string& error);
  bool runPhase(const std::string& phase, std::vector<run::Step> steps);
  run::PolicyResult incident(const std::vector<run::Step>& remaining);
  void event(const std::string& ev, JsonObjectConst data);
  void setPhase(const std::string& ph);
  Result closeWith(const std::string& outcome);

  Platform& p_;
  ArmLink& arm_;
  Monitor mon_;
  const run::ArmCfg& cfg_;
  const Prompts& prompts_;
  const eth::Key& key_;
  std::string deviceId_, armId_;
  run::Recorder* rec_ = nullptr;
  run::Task task_;
  Bytes runKey_;
  std::atomic<bool> stop_{false};
  std::atomic<bool> busy_{false};
  std::string phase_ = "IDLE", incidentOutcome_;
  int cmdSeq_ = 0, callSeq_ = 0;
  std::vector<std::pair<size_t, std::string>> frames_;
};

}  // namespace pearl::orch
