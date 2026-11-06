#include "orch.h"
#include <cstring>
#include "chain.h"
#include "json.h"
#include "seal.h"

namespace pearl::orch {

static const uint32_t HAND_WAIT_MS = 15000;
static const uint32_t MOVE_TIMEOUT_MS = 20000;
static const uint32_t SAFE_TIMEOUT_MS = 20000;
static const char* CP[4] = {"PLAN", "VERIFY_GRASP", "VERIFY_PLACE", "INCIDENT"};
static int cpIndex(const std::string& cp) {
  for (int i = 0; i < 4; i++)
    if (cp == CP[i]) return i;
  return 0;
}
static bool isSafety(const std::string& ev) { return ev == "hand_in_zone" || ev == "trip_bump" || ev == "trip_watchdog" || ev == "sensor_fault"; }
static bool isHardTrip(const std::string& ev) { return ev == "trip_bump" || ev == "trip_watchdog" || ev == "sensor_fault"; }

// ---------------------------------------------------------------- monitor
void Monitor::pump(uint32_t waitMs) {
  JsonDocument m;
  if (!arm_.recv(m, waitMs)) return;
  std::string t = m["t"] | "";
  if (t == "tel") {
    lastTel.set(m.as<JsonVariantConst>());
    hasTel = true;
  } else if (t == "event") {
    std::string ev = m["ev"] | "";
    if (ev == "hand_in_zone") handClear = false;
    if (ev == "hand_clear") handClear = true;
    if (isHardTrip(ev)) hardTrip = true;
    if (ev == "reset_done") hardTrip = false;
    if (isSafety(ev)) {
      lastSafety.set(m.as<JsonVariantConst>());
      pending_ = true;
    }
    if (onEvent) {
      JsonDocument data;
      JsonObject d = data.to<JsonObject>();
      for (JsonPairConst kv : m.as<JsonObjectConst>())
        if (strcmp(kv.key().c_str(), "t") && strcmp(kv.key().c_str(), "ev")) d[kv.key()] = kv.value();
      onEvent(ev, data.as<JsonObjectConst>());
    }
  } else if (t == "done") {
    outcomes_[m["id"] | ""] = "done";
  } else if (t == "nack") {
    std::string id = m["id"] | "";
    if (!id.empty()) outcomes_[id] = m["reason"] | "nack";
    if (onEvent) {
      JsonDocument data;
      JsonObject d = data.to<JsonObject>();
      for (JsonPairConst kv : m.as<JsonObjectConst>())
        if (strcmp(kv.key().c_str(), "t")) d[kv.key()] = kv.value();
      onEvent("nack", data.as<JsonObjectConst>());
    }
  }
}

Monitor::Cmd Monitor::awaitCommand(const std::string& id, uint32_t timeoutMs, std::string& reason, Platform& p, const std::atomic<bool>& stop) {
  uint32_t until = p.millis() + timeoutMs;
  while (static_cast<int32_t>(until - p.millis()) > 0) {
    auto it = outcomes_.find(id);
    if (it != outcomes_.end()) {
      std::string o = it->second;
      outcomes_.erase(it);
      if (o == "done") return Cmd::OK;
      reason = o;
      return Cmd::NACK;
    }
    if (pending_) return Cmd::INTERRUPTED;  // a safety event interrupts every command still waiting
    if (stop) return Cmd::STOPPED;
    pump(20);
  }
  reason = "timeout";
  return Cmd::TIMEOUT;
}

bool Monitor::waitFor(const std::function<bool(JsonObjectConst)>& pred, uint32_t timeoutMs, bool interruptOnSafety, Platform& p) {
  uint32_t until = p.millis() + timeoutMs;
  for (;;) {
    if (hasTel && pred(lastTel.as<JsonObjectConst>())) return true;
    if (interruptOnSafety && pending_) return false;
    if (static_cast<int32_t>(until - p.millis()) <= 0) return false;
    pump(20);
  }
}

// ---------------------------------------------------------------- orchestrator
Orchestrator::Orchestrator(Platform& p, ArmLink& arm, const run::ArmCfg& cfg, const Prompts& prompts, const eth::Key& device,
                           std::string deviceId, std::string armId)
    : p_(p), arm_(arm), mon_(arm), cfg_(cfg), prompts_(prompts), key_(device), deviceId_(std::move(deviceId)), armId_(std::move(armId)) {
  mon_.onEvent = [this](const std::string& ev, JsonObjectConst data) {
    if (busy_ && rec_) event(ev, data);
  };
}

void Orchestrator::setPhase(const std::string& ph) {
  phase_ = ph;
  p_.onPhase(ph, rec_ ? rec_->episodeId() : "");
}

void Orchestrator::event(const std::string& ev, JsonObjectConst data) {
  if (!rec_) return;
  p_.onRecord(rec_->addEvent(p_.nowIso(), ev, data));
}

static void send(ArmLink& a, const char* cmd) {
  JsonDocument d;
  d["cmd"] = cmd;
  a.send(d);
}

bool Orchestrator::canStart(std::string& why) {
  mon_.pump(0);
  std::string st = mon_.state();
  if (busy_) why = "an episode is already running";
  else if (st == "TRIPPED") why = "device is TRIPPED: operator reset required";
  else if (st == "FROZEN_HAND") why = "device is FROZEN_HAND: clear the zone first";
  else if (!mon_.hasTel) why = "arm not connected: no telemetry yet";
  else return true;
  return false;
}

void Orchestrator::requestStop() {
  if (!busy_) return;
  stop_ = true;
}

Result Orchestrator::run(const run::Task& task, const std::string& episodeId, const Bytes& runKey) {
  busy_ = true;
  stop_ = false;
  task_ = task;
  runKey_ = runKey;
  frames_.clear();
  cmdSeq_ = 0;
  callSeq_ = 0;
  incidentOutcome_.clear();
  run::Recorder rec(episodeId, deviceId_, armId_, task, p_.nowIso());
  rec_ = &rec;
  mon_.takeSafety();
  {
    JsonDocument d;
    JsonObject t = d["task"].to<JsonObject>();
    t["task"] = "pick";
    t["color"] = task.color;
    t["from"] = task.from;
    t["to"] = "BIN";
    d["deviceState"] = mon_.state();
    d["armConfigHash"] = sha256Hex(cfg_.canonical);
    event("episode_start", d.as<JsonObjectConst>());
  }
  auto finish = [&](const run::PolicyResult& p) {
    if (!p.steps.empty()) {
      size_t at;
      std::string err;
      runSteps(p.steps, true, at, err);
    }
    return closeWith(p.outcome.empty() ? "ABORTED" : p.outcome);
  };
  JsonDocument none;
  JsonObjectConst noExtra = none.to<JsonObject>();
  bool stopped = false;
  Result out;
  do {
    std::string st = mon_.state();
    if (st == "SAFE" || st == "WAITING") {
      send(arm_, "resume");
      mon_.waitFor([](JsonObjectConst t) { return std::string(t["state"] | "") == "IDLE"; }, 2000, true, p_);
    }
    // PLAN
    run::PolicyResult p = checkpoint("PLAN", [&](const run::Decision& d) { return run::policyPlan(d, task_, cfg_); }, noExtra);
    if (stop_) { stopped = true; break; }
    if (p.next == run::PolicyResult::END) { out = finish(p); break; }
    if (!runPhase("MOVING_TO_PICK", p.steps)) { stopped = stop_; if (!stopped) out = closeWith(incidentOutcome_.empty() ? "ABORTED" : incidentOutcome_); break; }
    // VERIFY_GRASP (max 1 retry)
    int graspRetries = 0;
    bool ended = false;
    for (;;) {
      JsonDocument x;
      x["graspRetriesUsed"] = graspRetries;
      p = checkpoint("VERIFY_GRASP", [&](const run::Decision& d) { return run::policyVerifyGrasp(d, task_, cfg_, graspRetries); }, x.as<JsonObjectConst>());
      if (stop_) { stopped = true; ended = true; break; }
      if (p.next == run::PolicyResult::END) { out = finish(p); ended = true; break; }
      std::string phase = p.next == run::PolicyResult::VERIFY_GRASP ? "MOVING_TO_PICK" : "MOVING_TO_PLACE";
      if (p.next == run::PolicyResult::VERIFY_GRASP) graspRetries++;
      if (!runPhase(phase, p.steps)) { stopped = stop_; if (!stopped) out = closeWith(incidentOutcome_.empty() ? "ABORTED" : incidentOutcome_); ended = true; break; }
      if (p.next == run::PolicyResult::VERIFY_PLACE) break;
    }
    if (ended) break;
    // VERIFY_PLACE (max 1 retry)
    int placeRetries = 0;
    for (;;) {
      JsonDocument x;
      x["placeRetriesUsed"] = placeRetries;
      p = checkpoint("VERIFY_PLACE", [&](const run::Decision& d) { return run::policyVerifyPlace(d, cfg_, placeRetries); }, x.as<JsonObjectConst>());
      if (stop_) { stopped = true; break; }
      if (p.next == run::PolicyResult::END) { out = finish(p); break; }
      placeRetries++;
      if (!runPhase("MOVING_TO_PLACE", p.steps)) { stopped = stop_; if (!stopped) out = closeWith(incidentOutcome_.empty() ? "ABORTED" : incidentOutcome_); break; }
    }
  } while (false);
  if (stopped) {
    JsonDocument e;
    event("operator_stop", e.to<JsonObject>());
    send(arm_, "safe");
    out = closeWith("ABORTED");
  }
  rec_ = nullptr;
  busy_ = false;
  return out;
}

bool Orchestrator::runPhase(const std::string& phase, std::vector<run::Step> todo) {
  for (;;) {
    setPhase(phase);
    size_t at = 0;
    std::string err;
    StepEnd r = mon_.peekSafety() ? StepEnd::INTERRUPTED : runSteps(todo, false, at, err);
    if (r == StepEnd::OK) return true;
    if (stop_) return false;
    if (r == StepEnd::ERROR) {
      JsonDocument d;
      d["error"] = err;
      event("host_error", d.as<JsonObjectConst>());
      send(arm_, "safe");
      incidentOutcome_ = "ABORTED";
      return false;
    }
    std::vector<run::Step> remaining(todo.begin() + static_cast<long>(at), todo.end());
    run::PolicyResult p = incident(remaining);
    if (p.next != run::PolicyResult::CONTINUE_INTERRUPTED) {
      if (!p.steps.empty()) {
        size_t a2;
        std::string e2;
        runSteps(p.steps, true, a2, e2);
      }
      incidentOutcome_ = p.outcome;
      return false;
    }
    todo = p.steps;  // resume + remaining
  }
}

run::PolicyResult Orchestrator::incident(const std::vector<run::Step>& remaining) {
  mon_.takeSafety();
  setPhase("INCIDENT_DECIDING");
  if (!mon_.hardTrip) {
    // ask 0G once the zone is clear (or a trip happens, or the wait times out)
    mon_.waitFor([this](JsonObjectConst) { return mon_.handClear || mon_.hardTrip; }, HAND_WAIT_MS, false, p_);
  }
  mon_.takeSafety();
  run::IncidentCtx ctx;
  ctx.hardTrip = mon_.hardTrip;
  ctx.frozenHand = mon_.state() == "FROZEN_HAND";
  ctx.handClear = mon_.handClear;
  ctx.remaining = remaining;
  JsonDocument x;
  x["event"] = mon_.lastSafety.as<JsonVariantConst>();
  x["handClear"] = ctx.handClear;
  x["hardTrip"] = ctx.hardTrip;
  return checkpoint("INCIDENT", [&](const run::Decision& d) { return run::policyIncident(d, ctx); }, x.as<JsonObjectConst>());
}

run::PolicyResult Orchestrator::checkpoint(const std::string& cp, const std::function<run::PolicyResult(const run::Decision&)>& policy, JsonObjectConst extra) {
  if (stop_) return run::PolicyResult{};
  std::string st = mon_.state();
  if (st == "IDLE" || st == "MOVING") send(arm_, "hold");
  setPhase(cp == "PLAN" ? "PLANNING" : cp == "INCIDENT" ? "INCIDENT_DECIDING" : cp == "VERIFY_GRASP" ? "VERIFYING_GRASP" : "VERIFYING_PLACE");
  mon_.pump(30);

  run::Telemetry tel;
  if (mon_.hasTel) {
    JsonObjectConst t = mon_.lastTel.as<JsonObjectConst>();
    tel.state = t["state"] | "UNKNOWN";
    for (JsonVariantConst j : t["joints"].as<JsonArrayConst>()) tel.joints.push_back(j.as<int>());
    tel.tofMm = t["tofMm"] | -1;
    tel.accG = t["accG"] | -1.0;
  }
  int ci = cpIndex(cp);
  std::string clientRequestId = rec_->episodeId() + ":" + std::to_string(callSeq_++) + ":" + cp;
  Bytes jpeg;
  std::string camErr;
  bool haveFrame = p_.camera(jpeg, camErr);
  std::string ts = p_.nowIso();
  run::Decision d;
  if (!haveFrame && !camErr.empty()) {
    // a configured camera that gives no frame is treated as a 0G failure
    d = run::failsafe(cp, clientRequestId, "camera: " + camErr);
  } else {
    JsonDocument ctx;
    JsonObject t = ctx["task"].to<JsonObject>();
    t["task"] = "pick";
    t["color"] = task_.color;
    t["from"] = task_.from;
    t["to"] = "BIN";
    JsonObject te = ctx["telemetry"].to<JsonObject>();
    te["state"] = tel.state;
    JsonArray j = te["joints"].to<JsonArray>();
    for (int x : tel.joints) j.add(x);
    te["tofMm"] = tel.tofMm;
    te["accG"] = tel.accG;
    for (JsonPairConst kv : extra) ctx[kv.key()] = kv.value();
    std::string image = haveFrame ? "data:image/jpeg;base64," + base64(jpeg) : "";
    std::string body = run::routerBody(router, cp, prompts_.text[ci], ctx.as<JsonObjectConst>(), image);
    image.clear();
    std::string base = cut0g ? blackholeUrl : router.baseUrl;
    while (!base.empty() && base.back() == '/') base.pop_back();
    Headers h = {{"Authorization", "Bearer " + router.apiKey},
                 {"Content-Type", "application/json"},
                 {"X-Client-Request-Id", clientRequestId},
                 {"X-0G-Provider-Trust-Mode", router.trustMode}};
    run::HttpResult r = p_.post(base + "/chat/completions", h, body, router.timeoutMs);
    d = run::interpret(cp, clientRequestId, r, router.timeoutMs);
  }
  run::PolicyResult pr = policy(d);
  std::string frameHash, frameRoot;
  if (haveFrame) {
    Bytes locked;
    if (seal::lockFrame(runKey_, jpeg, locked)) {
      frameRoot = to0x(chain::storageRoot(locked));
      frameHash = toHex(sha256(jpeg));
      p_.saveFrame(rec_->episodeId(), rec_->length(), locked);
      frames_.push_back({rec_->length(), frameRoot});
    }
  }
  p_.onRecord(rec_->addDecision(d, ts, prompts_.hash[ci], frameHash, frameRoot, tel, pr));
  if (pr.fileClaim) {
    JsonDocument e;
    e["checkpoint"] = cp;
    if (d.hasRequestId) e["requestId"] = d.requestId;
    else e["requestId"] = nullptr;
    if (d.fromZeroG && d.parsed["severity"].is<int>()) e["severity"] = d.parsed["severity"].as<int>();
    else e["severity"] = nullptr;
    event("claim_requested", e.as<JsonObjectConst>());
  }
  return pr;
}

Orchestrator::StepEnd Orchestrator::runSteps(const std::vector<run::Step>& steps, bool endOfEpisode, size_t& at, std::string& error) {
  for (size_t i = 0; i < steps.size(); i++) {
    if (stop_ && !endOfEpisode) return StepEnd::INTERRUPTED;
    const run::Step& s = steps[i];
    if (s.kind == run::Step::SAFE) {
      send(arm_, "safe");
      const int* safe = cfg_.safe.j;
      mon_.waitFor(
          [safe](JsonObjectConst t) {
            std::string st = t["state"] | "";
            if (st == "TRIPPED") return true;
            if (st != "SAFE") return false;
            JsonArrayConst j = t["joints"];
            for (int k = 0; k < 4; k++)
              if (j[k].as<int>() != safe[k]) return false;
            return true;
          },
          SAFE_TIMEOUT_MS, false, p_);
      continue;
    }
    if (s.kind == run::Step::RESUME) {
      send(arm_, "resume");
      bool ok = mon_.waitFor([](JsonObjectConst t) { return std::string(t["state"] | "") == "IDLE"; }, 2000, !endOfEpisode, p_);
      if (!ok && !endOfEpisode) {
        if (mon_.peekSafety()) {
          at = i;
          return StepEnd::INTERRUPTED;
        }
        error = "device did not leave " + mon_.state() + " on resume";
        return StepEnd::ERROR;
      }
      continue;
    }
    std::string id = "m" + std::to_string(++cmdSeq_);
    JsonDocument c;
    if (s.kind == run::Step::MOVE) {
      c["cmd"] = "move";
      c["id"] = id;
      JsonArray j = c["joints"].to<JsonArray>();
      for (int k = 0; k < 4; k++) j.add(s.j[k]);
    } else {
      c["cmd"] = "grip";
      c["id"] = id;
      c["close"] = s.close;
    }
    arm_.send(c);
    std::string reason;
    Monitor::Cmd o = mon_.awaitCommand(id, MOVE_TIMEOUT_MS, reason, p_, stop_);
    if (stop_ && !endOfEpisode) return StepEnd::INTERRUPTED;
    if (o == Monitor::Cmd::OK) continue;
    if (o == Monitor::Cmd::INTERRUPTED || mon_.peekSafety()) {
      at = i;
      return StepEnd::INTERRUPTED;
    }
    error = std::string(s.kind == run::Step::MOVE ? "move " : "grip ") + id + ": " + reason;
    return StepEnd::ERROR;
  }
  return StepEnd::OK;
}

Result Orchestrator::closeWith(const std::string& outcome) {
  JsonDocument e;
  e["outcome"] = outcome;
  event("episode_end", e.as<JsonObjectConst>());
  Result r;
  r.endedAt = p_.nowIso();
  rec_->close(outcome, r.endedAt);
  r.episodeId = rec_->episodeId();
  r.outcome = outcome;
  r.headHash = rec_->headHash();
  r.startedAt = rec_->startedAt();
  r.incident = rec_->incident();
  r.severity = rec_->severity();
  r.requestIds = rec_->requestIds();
  r.frames = frames_;
  std::string sig = eth::personalSign(key_, run::headMessage(r.episodeId, r.headHash));
  r.logCanonical = rec_->closedWithDevice(key_.address, sig);
  // seal: the public header carries only what 0G Chain and Arkiv already show
  JsonDocument s;
  JsonObject h = s.to<JsonObject>();
  h["v"] = 1;
  h["type"] = "pearl.sealed-episode";
  h["episodeId"] = r.episodeId;
  h["armId"] = armId_;
  h["device"]["address"] = key_.address;
  h["device"]["signature"] = sig;
  h["headHash"] = r.headHash;
  h["outcome"] = outcome;
  h["startedAt"] = r.startedAt;
  h["endedAt"] = r.endedAt;
  h["incident"] = r.incident;
  h["severity"] = r.severity;
  h["origin"] = nullptr;
  if (hasOwner) {
    // bound into the header (the AAD), so the copy cannot be swapped for another key without breaking the file
    JsonObject w = h["keys"].to<JsonArray>().add<JsonObject>();
    if (!seal::wrapRunKey(runKey_, owner, seal::runContext(key_.address, r.episodeId), w)) h.remove("keys");
  }
  if (seal::sealEpisode(runKey_, r.logCanonical, h)) r.sealedCanonical = canonical(s.as<JsonVariantConst>());
  setPhase(outcome == "DONE" ? "DONE" : outcome == "FAILSAFE" ? "FAILSAFE_STOPPED" : outcome);
  return r;
}

}  // namespace pearl::orch
