#include "run.h"
#include <cmath>
#include <cstring>
#include "json.h"

namespace pearl::run {

// ---------------------------------------------------------------- arm config
int slotIndex(const std::string& s) {
  if (s == "A1") return 0;
  if (s == "A2") return 1;
  if (s == "A3") return 2;
  if (s == "BIN") return 3;
  return -1;
}

static bool pose(JsonVariantConst a, Pose& p) {
  JsonArrayConst arr = a.as<JsonArrayConst>();
  if (arr.isNull() || arr.size() != 4) return false;
  for (int i = 0; i < 4; i++) p.j[i] = arr[i].as<int>();
  return true;
}

bool parseArmConfig(const std::string& armJson, ArmCfg& out) {
  JsonDocument d;
  if (!parseExact(armJson, d)) return false;
  out.canonical = canonical(d.as<JsonVariantConst>());
  bool ok = pose(d["home"], out.home) && pose(d["safe"], out.safe);
  out.gripOpen = d["gripOpen"] | 10;
  out.gripClosed = d["gripClosed"] | 80;
  const char* names[4] = {"A1", "A2", "A3", "BIN"};
  for (int i = 0; i < 4; i++) ok = ok && pose(d["slots"][names[i]]["above"], out.above[i]) && pose(d["slots"][names[i]]["down"], out.down[i]);
  return ok;
}

// ---------------------------------------------------------------- steps
std::string fmtStep(const Step& s) {
  switch (s.kind) {
    case Step::MOVE: return "move:[" + std::to_string(s.j[0]) + "," + std::to_string(s.j[1]) + "," + std::to_string(s.j[2]) + "," + std::to_string(s.j[3]) + "]";
    case Step::GRIP: return s.close ? "grip:close" : "grip:open";
    case Step::SAFE: return "safe";
    case Step::RESUME: return "resume";
  }
  return "";
}

std::vector<std::string> commandsOf(const std::vector<Step>& steps) {
  std::vector<std::string> o;
  for (const Step& s : steps) o.push_back(fmtStep(s));
  return o;
}

static Step mv(const Pose& p, int grip) {
  Step s{Step::MOVE};
  for (int i = 0; i < 3; i++) s.j[i] = p.j[i];
  s.j[3] = grip;
  return s;
}
static Step gr(bool close) {
  Step s{Step::GRIP};
  s.close = close;
  return s;
}

std::vector<Step> grasp(const ArmCfg& c, int slot) {
  return {mv(c.above[slot], c.gripOpen), mv(c.down[slot], c.gripOpen), gr(true), mv(c.above[slot], c.gripClosed)};
}
std::vector<Step> regrasp(const ArmCfg& c, int slot) {
  return {gr(false), mv(c.down[slot], c.gripOpen), gr(true), mv(c.above[slot], c.gripClosed)};
}
std::vector<Step> place(const ArmCfg& c) { return {mv(c.above[3], c.gripClosed), gr(false), mv(c.home, c.gripOpen)}; }

// ---------------------------------------------------------------- decisions
Decision failsafe(const std::string& cp, const std::string& cid, const std::string& error) {
  Decision d;
  d.checkpoint = cp;
  d.clientRequestId = cid;
  d.error = error;
  d.hasError = true;
  return d;
}

std::string stripFence(const std::string& in) {
  size_t a = in.find_first_not_of(" \t\r\n");
  size_t b = in.find_last_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  std::string s = in.substr(a, b - a + 1);
  if (s.size() >= 6 && s.compare(0, 3, "```") == 0 && s.compare(s.size() - 3, 3, "```") == 0) {
    size_t start = 3;
    if (s.size() >= 7 && (s.compare(3, 4, "json") == 0 || s.compare(3, 4, "JSON") == 0)) start = 7;
    std::string inner = s.substr(start, s.size() - 3 - start);
    size_t x = inner.find_first_not_of(" \t\r\n");
    size_t y = inner.find_last_not_of(" \t\r\n");
    return x == std::string::npos ? "" : inner.substr(x, y - x + 1);
  }
  return s;
}

static bool isStr(JsonVariantConst v) { return v.is<const char*>(); }
static size_t utf16len(const char* s) {
  size_t n = 0;
  for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; p++) {
    if ((*p & 0xC0) == 0x80) continue;
    n += (*p >= 0xF0) ? 2 : 1;
  }
  return n;
}
static bool num01(JsonVariantConst v) {
  if (!(v.is<double>() || v.is<long long>())) return false;
  double d = v.as<double>();
  return d >= 0 && d <= 1;
}
static bool oneOf(JsonVariantConst v, std::initializer_list<const char*> opts) {
  if (!isStr(v)) return false;
  for (const char* o : opts)
    if (strcmp(v.as<const char*>(), o) == 0) return true;
  return false;
}

/** The strict zod schemas of shared/schemas.ts: exact keys, enums and ranges. Returns "" when valid. */
static std::string validate(const std::string& cp, JsonVariantConst v) {
  if (!v.is<JsonObjectConst>()) return "<root>: expected object";
  JsonObjectConst o = v.as<JsonObjectConst>();
  std::vector<const char*> keys;
  if (cp == "PLAN") keys = {"action", "slot", "reason", "confidence"};
  else if (cp == "VERIFY_GRASP") keys = {"action", "grasped", "reason", "confidence"};
  else if (cp == "VERIFY_PLACE") keys = {"action", "placed", "reason", "confidence"};
  else keys = {"action", "severity", "file_claim", "reason", "confidence"};
  for (JsonPairConst p : o) {
    bool known = false;
    for (const char* k : keys) known = known || strcmp(p.key().c_str(), k) == 0;
    if (!known) return std::string("<root>: unrecognized key \"") + p.key().c_str() + "\"";
  }
  for (const char* k : keys)
    if (!o[k].is<JsonVariantConst>() || (o[k].isNull() && strcmp(k, "slot") != 0)) return std::string(k) + ": required";
  if (!isStr(o["reason"]) || utf16len(o["reason"].as<const char*>()) > 200) return "reason: string of at most 200 characters";
  if (!num01(o["confidence"])) return "confidence: number between 0 and 1";
  if (cp == "PLAN") {
    if (!oneOf(o["action"], {"PICK", "ABORT"})) return "action: invalid option";
    if (!o["slot"].isNull() && !oneOf(o["slot"], {"A1", "A2", "A3"})) return "slot: invalid option";
  } else if (cp == "VERIFY_GRASP") {
    if (!oneOf(o["action"], {"CONTINUE", "RETRY", "ABORT"})) return "action: invalid option";
    if (!o["grasped"].is<bool>()) return "grasped: expected boolean";
  } else if (cp == "VERIFY_PLACE") {
    if (!oneOf(o["action"], {"DONE", "RETRY", "ABORT"})) return "action: invalid option";
    if (!o["placed"].is<bool>()) return "placed: expected boolean";
  } else {
    if (!oneOf(o["action"], {"RESUME", "SAFE_STOP"})) return "action: invalid option";
    JsonVariantConst s = o["severity"];
    if (!(s.is<long long>() || s.is<double>())) return "severity: expected number";
    double sv = s.as<double>();
    if (sv != std::floor(sv) || sv < 0 || sv > 3) return "severity: integer 0..3";
    if (!o["file_claim"].is<bool>()) return "file_claim: expected boolean";
  }
  return "";
}

static void setOpt(std::string& dst, bool& has, JsonVariantConst v) {
  if (v.is<const char*>() && strlen(v.as<const char*>()) > 0) {
    dst = v.as<const char*>();
    has = true;
  }
}

static std::string pickHttpRequestId(const std::string& header, const std::string& bodyId, bool hasBody) {
  std::vector<std::string> parts;
  size_t i = 0;
  while (i <= header.size()) {
    size_t j = header.find(',', i);
    if (j == std::string::npos) j = header.size();
    std::string p = header.substr(i, j - i);
    size_t a = p.find_first_not_of(' '), b = p.find_last_not_of(' ');
    if (a != std::string::npos) parts.push_back(p.substr(a, b - a + 1));
    i = j + 1;
  }
  if (parts.empty()) return "";
  if (hasBody)
    for (const std::string& p : parts)
      if (p == bodyId) return bodyId;
  return parts.back();
}

Decision interpret(const std::string& cp, const std::string& cid, const HttpResult& r, uint32_t timeoutMs) {
  Decision d;
  d.checkpoint = cp;
  d.clientRequestId = cid;
  d.latencyMs = r.latencyMs;
  auto fail = [&](const std::string& e) {
    d.fromZeroG = false;
    d.model.clear();
    d.hasModel = d.hasProvider = d.hasProviderIdentity = d.hasZgResKey = d.hasReasoning = d.hasRaw = false;
    d.parsed.clear();
    d.error = e;
    d.hasError = true;
    return std::move(d);
  };
  if (r.status == 0) return fail(r.error.empty() ? "timeout after " + std::to_string(timeoutMs) + " ms" : r.error);

  JsonDocument body;
  bool hasJson = parseExact(r.body, body);
  JsonVariantConst b = body.as<JsonVariantConst>();
  JsonVariantConst trace = b["x_0g_trace"];
  JsonVariantConst msg = b["choices"][0]["message"];
  // trace (extractTrace)
  setOpt(d.requestId, d.hasRequestId, trace["request_id"]);
  if (!d.hasRequestId) setOpt(d.requestId, d.hasRequestId, b["request_id"]);
  if (!r.xRequestId.empty()) {
    d.httpRequestId = pickHttpRequestId(r.xRequestId, d.requestId, d.hasRequestId);
    d.hasHttpRequestId = !d.httpRequestId.empty();
  }
  d.clientRequestIdEchoed = r.hasXClientRequestId ? (r.xClientRequestId == cid ? 1 : 0) : 0;
  JsonVariantConst tee = b["tee_verified"].isNull() ? trace["tee_verified"] : b["tee_verified"];
  if (tee.is<bool>()) d.teeVerified = tee.as<bool>() ? 1 : 0;
  JsonVariantConst cost = trace["billing"]["total_cost"];
  if (!cost.isNull()) {
    d.cost = cost.is<const char*>() ? std::string(cost.as<const char*>()) : canonical(cost);
    d.hasCost = true;
  }
  std::string model, provider, providerIdentity, reasoning;
  bool hm = false, hp = false, hpi = false, hr = false;
  setOpt(model, hm, b["model"]);
  setOpt(provider, hp, trace["provider"]);
  setOpt(providerIdentity, hpi, trace["provider_identity"]);
  setOpt(reasoning, hr, msg["reasoning_content"]);
  if (!hr) setOpt(reasoning, hr, msg["provider_specific_fields"]["reasoning_content"]);
  if (hr && reasoning.size() > 2000) {
    size_t cut = 2000;
    while (cut > 0 && (static_cast<unsigned char>(reasoning[cut]) & 0xC0) == 0x80) cut--;
    reasoning.resize(cut);
  }

  if (r.status < 200 || r.status >= 300) {
    JsonVariantConst err = b["error"];
    std::string code = err["code"].is<const char*>() ? err["code"].as<const char*>() : err["type"].is<const char*>() ? err["type"].as<const char*>() : "unknown";
    std::string message = err["message"].is<const char*>() ? err["message"].as<const char*>() : r.body.substr(0, 200);
    return fail("HTTP " + std::to_string(r.status) + " " + code + ": " + message);
  }
  if (!hasJson || !msg["content"].is<const char*>() || strlen(msg["content"].as<const char*>()) == 0) return fail("response has no message content");
  std::string content = msg["content"].as<const char*>();
  JsonDocument parsed;
  if (!parseExact(stripFence(content), parsed)) return fail("invalid JSON from model: " + content.substr(0, 120));
  std::string bad = validate(cp, parsed.as<JsonVariantConst>());
  if (!bad.empty()) return fail("schema check failed: " + bad);
  if (d.teeVerified == 0) return fail("tee_verified:false (TEE signature present but did not verify)");
  d.fromZeroG = true;
  d.model = model;
  d.hasModel = hm;
  d.provider = provider;
  d.hasProvider = hp;
  d.providerIdentity = providerIdentity;
  d.hasProviderIdentity = hpi;
  if (r.hasZgResKey) {
    d.zgResKey = r.zgResKey;
    d.hasZgResKey = true;
  }
  d.reasoning = reasoning;
  d.hasReasoning = hr;
  d.raw = content;
  d.hasRaw = true;
  d.parsed.set(parsed.as<JsonVariantConst>());
  return d;
}

bool isProviderFailure(const HttpResult& r) {
  if (r.status == 0) return true;
  if (r.status >= 200 && r.status < 300) return false;
  JsonDocument body;
  if (parseExact(r.body, body)) {
    JsonVariantConst e = body["error"];
    const char* code = e["code"].is<const char*>() ? e["code"].as<const char*>() : (e["type"] | "");
    if (strcmp(code, "no_provider_for_trust_mode") == 0 || strcmp(code, "no_available_provider") == 0) return true;
  }
  return r.status >= 500 || r.status == 429;
}

std::vector<std::string> modelsOf(const RouterConfig& cfg) {
  std::vector<std::string> out;
  auto add = [&](const std::string& m) {
    if (m.empty()) return;
    for (const std::string& x : out)
      if (x == m) return;
    out.push_back(m);
  };
  add(cfg.model);
  for (const std::string& m : cfg.fallbackModels) add(m);
  if (out.empty()) out.push_back(cfg.model);
  return out;
}

std::vector<Call> callsOf(const RouterConfig& cfg) {
  std::vector<Call> calls;
  std::vector<std::string> models = modelsOf(cfg);
  for (const std::string& m : models) calls.push_back({m, cfg.trustMode});
  if (cfg.trustMode == "verified" && cfg.allowStandardFallback)
    for (const std::string& m : models) calls.push_back({m, "standard"});
  return calls;
}

Decision decide(const RouterConfig& cfg, const std::string& cp, const std::string& cid, const CallFn& call, const std::function<uint32_t()>& nowMs) {
  std::vector<Call> calls = callsOf(cfg);
  if (calls.size() == 1) {
    Decision d = interpret(cp, cid, call(calls[0].model, calls[0].trustMode, cfg.timeoutMs), cfg.timeoutMs);
    if (cfg.trustMode != "verified") {
      d.trustMode = cfg.trustMode;
      d.hasTrustMode = true;
    }
    return d;
  }
  bool perCall = calls.size() > modelsOf(cfg).size();
  auto unit = [&](size_t k) { return std::string(perCall ? (k == 1 ? "call" : "calls") : (k == 1 ? "model" : "models")); };
  uint32_t started = nowMs();
  std::vector<Attempt> attempts;
  Decision last;
  bool budgetLeft = true, providerFail = false;
  for (const Call& c : calls) {
    uint32_t used = nowMs() - started;
    if (used >= cfg.timeoutMs) {
      budgetLeft = false;
      break;
    }
    uint32_t left = cfg.timeoutMs - used;
    HttpResult r = call(c.model, c.trustMode, left);
    last = interpret(cp, cid, r, left);
    Attempt a;
    a.model = c.model;
    a.trustMode = c.trustMode;
    a.status = r.status;
    a.requestId = last.requestId;
    a.hasRequestId = last.hasRequestId;
    a.latencyMs = r.latencyMs;
    bool answered = r.status >= 200 && r.status < 300 && last.error != "response has no message content";
    if (!answered) {
      a.error = last.error;
      a.hasError = true;
    }
    attempts.push_back(a);
    providerFail = isProviderFailure(r);
    if (!providerFail) break;  // an answer (good or bad) or a fault in our request: never ask another model
  }
  last.latencyMs = nowMs() - started;
  size_t n = attempts.size();
  const Attempt& la = attempts.back();
  if (!last.fromZeroG && (n > 1 || !budgetLeft)) {
    std::string why = !budgetLeft ? "time budget of " + std::to_string(cfg.timeoutMs) + " ms used up after " + std::to_string(n) + " " + unit(n)
                      : providerFail ? "all " + std::to_string(n) + " " + unit(n) + " failed"
                                     : unit(1) + " " + std::to_string(n) + " of " + std::to_string(calls.size()) + " refused the request";
    last.error = why + "; last (" + la.model + (la.trustMode == "verified" ? "" : ", " + la.trustMode) + "): " + last.error;
    last.hasError = true;
  }
  if (n > 1 || la.trustMode != "verified") {
    last.trustMode = la.trustMode;
    last.hasTrustMode = true;
  }
  if (n > 1) last.attempts = attempts;
  return last;
}

static void thinkingOff(JsonObject b, const std::string& model) {
  if (model.rfind("0gm-", 0) == 0) b["chat_template_kwargs"]["enable_thinking"] = false;
  else if (model.rfind("qwen3", 0) == 0) b["enable_thinking"] = false;
}

std::string routerBody(const RouterConfig& cfg, const std::string& cp, const std::string& sys, JsonObjectConst context, const std::string& image) {
  JsonDocument user;
  user["checkpoint"] = cp;
  for (JsonPairConst p : context) user[p.key()] = p.value();
  std::string userText;
  serializeJson(user, userText);
  JsonDocument b;
  b["model"] = cfg.model;
  JsonArray m = b["messages"].to<JsonArray>();
  JsonObject s = m.add<JsonObject>();
  s["role"] = "system";
  s["content"] = sys;
  JsonObject u = m.add<JsonObject>();
  u["role"] = "user";
  JsonArray content = u["content"].to<JsonArray>();
  JsonObject t = content.add<JsonObject>();
  t["type"] = "text";
  t["text"] = userText;
  if (!image.empty()) {
    JsonObject im = content.add<JsonObject>();
    im["type"] = "image_url";
    im["image_url"]["url"] = image;
  }
  b["temperature"] = 0;
  b["max_tokens"] = cfg.maxTokens;
  b["response_format"]["type"] = "json_object";
  if (cfg.verifyTee) b["verify_tee"] = true;
  thinkingOff(b.as<JsonObject>(), cfg.model);
  std::string out;
  serializeJson(b, out);
  return out;
}

// ---------------------------------------------------------------- policy
static PolicyResult end(const std::string& policy, const char* outcome, const char* override_ = nullptr, bool safe = true) {
  PolicyResult p;
  p.policy = policy;
  if (override_) {
    p.hasOverride = true;
    p.override_ = override_;
  }
  if (safe) p.steps = {Step{Step::SAFE}};
  p.next = PolicyResult::END;
  p.outcome = outcome;
  return p;
}

static const double MIN_CONFIDENCE = 0.6;
static const int MAX_RETRIES = 1;

static bool lowConfidence(const Decision& d, double& c) {
  JsonVariantConst v = d.parsed["confidence"];
  if (!(v.is<double>() || v.is<long long>())) return false;
  c = v.as<double>();
  return c < MIN_CONFIDENCE;
}

static std::string failsafeWhy(const Decision& d) { return "failsafe (" + d.error + ")"; }

PolicyResult policyPlan(const Decision& d, const Task& t, const ArmCfg& c) {
  if (!d.fromZeroG) return end(failsafeWhy(d) + " → safe stop", "FAILSAFE");
  double lc;
  if (lowConfidence(d, lc)) return end("confidence " + jsNumber(lc) + " < " + jsNumber(MIN_CONFIDENCE) + " → ABORT", "ABORTED");
  std::string action = d.parsed["action"] | "";
  if (action == "ABORT") return end("model ABORT → safe stop", "ABORTED");
  std::string slot = d.parsed["slot"].isNull() ? "null" : d.parsed["slot"].as<const char*>();
  if (slot != t.from) {
    std::string ov = "model chose " + slot + ", task says " + t.from;
    PolicyResult p = end("PICK at a slot other than the task's → ABORT", "ABORTED");
    p.hasOverride = true;
    p.override_ = ov;
    return p;
  }
  PolicyResult p;
  p.policy = "PICK " + slot;
  p.steps = grasp(c, slotIndex(t.from));
  p.next = PolicyResult::VERIFY_GRASP;
  return p;
}

PolicyResult policyVerifyGrasp(const Decision& d, const Task& t, const ArmCfg& c, int retriesUsed) {
  if (!d.fromZeroG) return end(failsafeWhy(d) + " → safe stop", "FAILSAFE");
  double lc;
  if (lowConfidence(d, lc)) return end("confidence " + jsNumber(lc) + " < " + jsNumber(MIN_CONFIDENCE) + " → ABORT", "ABORTED");
  std::string action = d.parsed["action"] | "";
  if (action == "ABORT") return end("model ABORT → safe stop", "ABORTED");
  if (action == "RETRY") {
    if (retriesUsed >= MAX_RETRIES) return end("RETRY limit reached → ABORT", "ABORTED", "max 1 retry");
    PolicyResult p;
    p.policy = "RETRY grasp at " + t.from;
    p.steps = regrasp(c, slotIndex(t.from));
    p.next = PolicyResult::VERIFY_GRASP;
    return p;
  }
  if (!(d.parsed["grasped"] | false)) return end("CONTINUE with grasped:false → ABORT", "ABORTED", "inconsistent answer");
  PolicyResult p;
  p.policy = "CONTINUE → carry to BIN";
  p.steps = place(c);
  p.next = PolicyResult::VERIFY_PLACE;
  return p;
}

PolicyResult policyVerifyPlace(const Decision& d, const ArmCfg& c, int retriesUsed) {
  if (!d.fromZeroG) return end(failsafeWhy(d) + " → safe stop", "FAILSAFE");
  double lc;
  if (lowConfidence(d, lc)) return end("confidence " + jsNumber(lc) + " < " + jsNumber(MIN_CONFIDENCE) + " → ABORT", "ABORTED");
  std::string action = d.parsed["action"] | "";
  if (action == "ABORT") return end("model ABORT → safe stop", "ABORTED");
  if (action == "RETRY") {
    if (retriesUsed >= MAX_RETRIES) return end("RETRY limit reached → ABORT", "ABORTED", "max 1 retry");
    PolicyResult p;
    p.policy = "RETRY release over BIN";
    p.steps = place(c);
    p.next = PolicyResult::VERIFY_PLACE;
    return p;
  }
  if (!(d.parsed["placed"] | false)) return end("DONE with placed:false → ABORT", "ABORTED", "inconsistent answer");
  PolicyResult p;
  p.policy = "DONE";
  p.steps = {Step{Step::RESUME}};
  p.next = PolicyResult::END;
  p.outcome = "DONE";
  return p;
}

PolicyResult policyIncident(const Decision& d, const IncidentCtx& ctx) {
  bool zg = d.fromZeroG;
  std::string action = zg ? (d.parsed["action"] | "") : "";
  int severity = zg ? d.parsed["severity"].as<int>() : 0;
  bool fileClaim = zg && ((d.parsed["file_claim"] | false) || severity >= 2);
  std::string claimNote = fileClaim ? "; claim filed" : "";
  if (ctx.hardTrip) {
    PolicyResult p;
    if (zg && action == "RESUME") {
      p.hasOverride = true;
      p.override_ = "hard trip: operator reset required";
    }
    std::string why = !zg ? failsafeWhy(d) : "model " + action;
    p.policy = why + "; hard trip → stay tripped" + claimNote;
    p.next = PolicyResult::END;
    p.outcome = "TRIPPED";
    p.fileClaim = fileClaim;
    return p;
  }
  if (!zg) return end(failsafeWhy(d) + " → safe stop", "FAILSAFE");
  double lc;
  if (lowConfidence(d, lc)) {
    PolicyResult p = end("confidence " + jsNumber(lc) + " < " + jsNumber(MIN_CONFIDENCE) + " → SAFE_STOP" + claimNote, "ABORTED");
    p.fileClaim = fileClaim;
    return p;
  }
  if (action == "SAFE_STOP") {
    PolicyResult p = end("model SAFE_STOP → safe stop" + claimNote, "ABORTED");
    p.fileClaim = fileClaim;
    return p;
  }
  if (!ctx.frozenHand || !ctx.handClear) {
    std::string why = !ctx.frozenHand ? "device not in FROZEN_HAND" : "hand zone not clear";
    std::string ov = "RESUME ignored: " + why;
    PolicyResult p = end("RESUME refused (" + why + ") → safe stop" + claimNote, "ABORTED", ov.c_str());
    p.fileClaim = fileClaim;
    return p;
  }
  PolicyResult p;
  p.policy = "RESUME after hand clear" + claimNote;
  p.steps = {Step{Step::RESUME}};
  p.steps.insert(p.steps.end(), ctx.remaining.begin(), ctx.remaining.end());
  p.next = PolicyResult::CONTINUE_INTERRUPTED;
  p.fileClaim = fileClaim;
  return p;
}

// ---------------------------------------------------------------- recorder
Recorder::Recorder(std::string episodeId, std::string deviceId, std::string armId, Task task, std::string startedAt)
    : episodeId_(std::move(episodeId)), deviceId_(std::move(deviceId)), armId_(std::move(armId)), startedAt_(std::move(startedAt)), task_(std::move(task)) {
  closed_["records"].to<JsonArray>();
}

static void taskJson(JsonObject o, const Task& t) {
  o["task"] = "pick";
  o["color"] = t.color;
  o["from"] = t.from;
  o["to"] = "BIN";
}

std::string Recorder::push(JsonObject rec) {
  rec["prevHash"] = head_;
  std::string c = canonical(rec);
  head_ = sha256Hex(c);
  rec["recordHash"] = head_;
  count_++;
  return canonical(rec);
}

static const char* SAFETY[] = {"hand_in_zone", "trip_bump", "trip_watchdog", "sensor_fault"};

std::string Recorder::addEvent(const std::string& ts, const std::string& ev, JsonObjectConst data) {
  JsonObject r = closed_["records"].as<JsonArray>().add<JsonObject>();
  r["v"] = 2;
  r["kind"] = "event";
  r["episodeId"] = episodeId_;
  r["idx"] = count_;
  r["ts"] = ts;
  r["ev"] = ev;
  JsonObject d = r["data"].to<JsonObject>();
  for (JsonPairConst p : data) d[p.key()] = p.value();
  for (const char* s : SAFETY)
    if (ev == s) incident_ = true;
  return push(r);
}

static void nullable(JsonObject o, const char* k, bool has, const std::string& v) {
  if (has) o[k] = v;
  else o[k] = nullptr;
}
static void tri(JsonObject o, const char* k, int v) {
  if (v < 0) o[k] = nullptr;
  else o[k] = v == 1;
}

std::string Recorder::addDecision(const Decision& d, const std::string& ts, const std::string& promptHash, const std::string& frameHash,
                                  const std::string& frameRoot, const Telemetry& tel, const PolicyResult& p) {
  JsonObject r = closed_["records"].as<JsonArray>().add<JsonObject>();
  r["v"] = 2;
  r["kind"] = "decision";
  r["episodeId"] = episodeId_;
  r["idx"] = count_;
  r["checkpoint"] = d.checkpoint;
  r["ts"] = ts;
  r["source"] = d.fromZeroG ? "0g" : "failsafe";
  nullable(r, "model", d.hasModel, d.model);
  nullable(r, "requestId", d.hasRequestId, d.requestId);
  nullable(r, "httpRequestId", d.hasHttpRequestId, d.httpRequestId);
  r["clientRequestId"] = d.clientRequestId;
  tri(r, "clientRequestIdEchoed", d.clientRequestIdEchoed);
  nullable(r, "provider", d.hasProvider, d.provider);
  nullable(r, "providerIdentity", d.hasProviderIdentity, d.providerIdentity);
  tri(r, "teeVerified", d.teeVerified);
  nullable(r, "cost", d.hasCost, d.cost);
  nullable(r, "zgResKey", d.hasZgResKey, d.zgResKey);
  nullable(r, "reasoning", d.hasReasoning, d.reasoning);
  r["promptHash"] = promptHash;
  nullable(r, "frameHash", !frameHash.empty(), frameHash);
  nullable(r, "frameRoot", !frameRoot.empty(), frameRoot);
  JsonObject t = r["telemetry"].to<JsonObject>();
  t["state"] = tel.state;
  JsonArray j = t["joints"].to<JsonArray>();
  for (int x : tel.joints) j.add(x);
  t["tofMm"] = tel.tofMm;
  t["accG"] = tel.accG;
  nullable(r, "raw", d.hasRaw, d.raw);
  if (d.fromZeroG) r["parsed"] = d.parsed.as<JsonVariantConst>();
  else r["parsed"] = nullptr;
  nullable(r, "error", d.hasError, d.error);
  r["policy"] = p.policy;
  nullable(r, "override", p.hasOverride, p.override_);
  JsonArray cmds = r["commandsSent"].to<JsonArray>();
  for (const std::string& c : commandsOf(p.steps)) cmds.add(c);
  r["latencyMs"] = d.latencyMs;
  if (d.hasTrustMode) r["trustMode"] = d.trustMode;
  if (!d.attempts.empty()) {
    JsonArray at = r["attempts"].to<JsonArray>();
    for (const Attempt& a : d.attempts) {
      JsonObject o = at.add<JsonObject>();
      o["model"] = a.model;
      o["trustMode"] = a.trustMode;
      if (a.status) o["status"] = a.status;
      else o["status"] = nullptr;
      nullable(o, "requestId", a.hasRequestId, a.requestId);
      nullable(o, "error", a.hasError, a.error);
      o["latencyMs"] = a.latencyMs;
    }
  }
  if (d.hasRequestId) requestIds_.push_back(d.requestId);
  if (d.fromZeroG && d.checkpoint == "INCIDENT") {
    int s = d.parsed["severity"].as<int>();
    if (s > severity_) severity_ = s;
  }
  return push(r);
}

std::string Recorder::close(const std::string& outcome, const std::string& endedAt) {
  outcome_ = outcome;
  endedAt_ = endedAt;
  closed_["v"] = 2;
  closed_["episodeId"] = episodeId_;
  closed_["deviceId"] = deviceId_;
  closed_["armId"] = armId_;
  taskJson(closed_["task"].to<JsonObject>(), task_);
  closed_["outcome"] = outcome;
  closed_["startedAt"] = startedAt_;
  closed_["endedAt"] = endedAt;
  closed_["headHash"] = head_;
  return canonical(closed_.as<JsonVariantConst>());
}

std::string Recorder::closedWithDevice(const std::string& address, const std::string& signature) {
  closed_["device"]["address"] = address;
  closed_["device"]["signature"] = signature;
  return canonical(closed_.as<JsonVariantConst>());
}

std::string requestIdsHash(const std::vector<std::string>& ids) {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (const std::string& s : ids) a.add(s);
  return "0x" + sha256Hex(canonical(d.as<JsonVariantConst>()));
}

}  // namespace pearl::run
