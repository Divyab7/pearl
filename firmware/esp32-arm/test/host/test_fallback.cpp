// Model fallback (run::decide), the C++ twin of apps/backend/src/orchestrator/fallback.test.ts: provider-side failures
// move on to the next model in order, faults in our request and any model answer stop there, the time budget is shared,
// and when every model fails the decision is a failsafe with no model, raw or parsed answer.
#include <map>
#include "harness.h"
#include "../../src/pearl/run.h"

using namespace pearl;

static const char* GOOD = R"({"action":"PICK","slot":"A2","reason":"Red cube at A2.","confidence":0.94})";

static run::HttpResult answer(const std::string& model, const std::string& rid, const std::string& content = GOOD) {
  JsonDocument b;
  b["model"] = model;
  b["choices"][0]["message"]["content"] = content;
  b["x_0g_trace"]["request_id"] = rid;
  b["tee_verified"] = true;
  run::HttpResult r;
  r.status = 200;
  serializeJson(b, r.body);
  r.latencyMs = 10;
  return r;
}
static run::HttpResult err(int status, const std::string& code, const std::string& rid = "") {
  run::HttpResult r;
  r.status = status;
  r.body = R"({"error":{"message":"m","type":"server_error","code":")" + code + "\"}" + (rid.empty() ? "" : ",\"request_id\":\"" + rid + "\"") + "}";
  r.latencyMs = 10;
  return r;
}
static run::HttpResult down() {
  run::HttpResult r;
  r.error = "network error: connect ECONNREFUSED";
  r.latencyMs = 10;
  return r;
}

struct Fake {
  std::map<std::string, run::HttpResult> replies;
  std::vector<std::pair<std::string, uint32_t>> asked;  // model, timeout given
  uint32_t clock = 1000, costMs = 10;                    // each call advances the clock
  run::CallFn call() {
    return [this](const std::string& m, uint32_t t) {
      asked.push_back({m, t});
      clock += costMs;
      auto it = replies.find(m);
      return it == replies.end() ? down() : it->second;
    };
  }
  std::function<uint32_t()> now() {
    return [this] { return clock; };
  }
};

static run::RouterConfig cfg() {
  run::RouterConfig c;
  c.model = "0gm-1.0-35b-a3b";
  c.fallbackModels = {"qwen2.5-vl-72b-instruct", "gemini-2.5-flash-lite"};
  c.timeoutMs = 1000;
  return c;
}
static void expectFailsafe(const run::Decision& d) {
  CHECK(!d.fromZeroG);
  CHECK(!d.hasModel);
  CHECK(!d.hasRaw);
  CHECK(d.parsed.isNull());
  CHECK(d.hasError && !d.error.empty());
}

TEST(fallback_models_in_order_without_repeats) {
  run::RouterConfig c = cfg();
  c.fallbackModels = {"0gm-1.0-35b-a3b", "a", "", "a", "b"};
  std::vector<std::string> m = run::modelsOf(c);
  CHECK_EQ(m.size(), (size_t)3);
  CHECK_EQ(m[0], std::string("0gm-1.0-35b-a3b"));
  CHECK_EQ(m[1], std::string("a"));
  CHECK_EQ(m[2], std::string("b"));
}

TEST(fallback_provider_failure_rules) {
  CHECK(run::isProviderFailure(down()));
  CHECK(run::isProviderFailure(err(502, "provider_error")));
  CHECK(run::isProviderFailure(err(503, "no_provider_for_trust_mode")));
  CHECK(run::isProviderFailure(err(429, "rate_limited")));
  CHECK(run::isProviderFailure(err(400, "no_available_provider")));
  CHECK(!run::isProviderFailure(err(400, "invalid_request")));
  CHECK(!run::isProviderFailure(err(401, "x")));
  CHECK(!run::isProviderFailure(err(402, "insufficient_balance")));
  CHECK(!run::isProviderFailure(err(403, "x")));
  CHECK(!run::isProviderFailure(answer("m", "r", "not json")));
}

TEST(fallback_primary_502_then_fallback_answers) {
  Fake f;
  f.replies["0gm-1.0-35b-a3b"] = err(502, "provider_error", "rid-p");
  f.replies["qwen2.5-vl-72b-instruct"] = answer("qwen2.5-vl-72b-instruct", "rid-fb");
  run::Decision d = run::decide(cfg(), "PLAN", "c", f.call(), f.now());
  CHECK(d.fromZeroG);
  CHECK_EQ(d.model, std::string("qwen2.5-vl-72b-instruct"));
  CHECK_EQ(d.requestId, std::string("rid-fb"));
  CHECK(!d.hasError);
  CHECK_EQ(f.asked.size(), (size_t)2);
  CHECK_EQ(d.attempts.size(), (size_t)2);
  CHECK_EQ(d.attempts[0].model, std::string("0gm-1.0-35b-a3b"));
  CHECK_EQ(d.attempts[0].status, 502);
  CHECK_EQ(d.attempts[0].requestId, std::string("rid-p"));
  CHECK(d.attempts[0].hasError);
  CHECK(!d.attempts[1].hasError);
  CHECK_EQ(d.latencyMs, (uint32_t)20);
  // the fallback got only what was left of the budget
  CHECK_EQ(f.asked[0].second, (uint32_t)1000);
  CHECK_EQ(f.asked[1].second, (uint32_t)990);
}

TEST(fallback_every_model_fails_is_failsafe) {
  Fake f;
  f.replies["0gm-1.0-35b-a3b"] = err(502, "provider_error");
  f.replies["qwen2.5-vl-72b-instruct"] = err(503, "no_provider_for_trust_mode");
  // gemini: no reply set → network error
  run::Decision d = run::decide(cfg(), "PLAN", "c", f.call(), f.now());
  expectFailsafe(d);
  CHECK_EQ(f.asked.size(), (size_t)3);
  CHECK_EQ(d.attempts.size(), (size_t)3);
  CHECK_EQ(d.error.rfind("all 3 models failed; last (gemini-2.5-flash-lite): network error", 0), (size_t)0);
}

TEST(fallback_not_on_our_request_faults_or_answers) {
  {
    Fake f;
    f.replies["0gm-1.0-35b-a3b"] = err(400, "invalid_request");
    f.replies["qwen2.5-vl-72b-instruct"] = answer("qwen2.5-vl-72b-instruct", "rid-fb");
    run::Decision d = run::decide(cfg(), "PLAN", "c", f.call(), f.now());
    expectFailsafe(d);
    CHECK_EQ(f.asked.size(), (size_t)1);
    CHECK(d.attempts.empty());
    CHECK_EQ(d.error, std::string("HTTP 400 invalid_request: m"));
  }
  {
    Fake f;
    f.replies["0gm-1.0-35b-a3b"] = answer("0gm-1.0-35b-a3b", "rid-p", "Sure, pick A2");
    f.replies["qwen2.5-vl-72b-instruct"] = answer("qwen2.5-vl-72b-instruct", "rid-fb");
    run::Decision d = run::decide(cfg(), "PLAN", "c", f.call(), f.now());
    expectFailsafe(d);
    CHECK_EQ(f.asked.size(), (size_t)1);
    CHECK_EQ(d.error.rfind("invalid JSON from model", 0), (size_t)0);
  }
}

TEST(fallback_budget_exhausted_is_failsafe) {
  Fake f;
  f.costMs = 1000;  // the primary uses the whole budget (a timeout)
  f.replies["qwen2.5-vl-72b-instruct"] = answer("qwen2.5-vl-72b-instruct", "rid-fb");
  run::Decision d = run::decide(cfg(), "PLAN", "c", f.call(), f.now());
  expectFailsafe(d);
  CHECK_EQ(f.asked.size(), (size_t)1);
  CHECK_EQ(d.error.rfind("time budget of 1000 ms used up after 1 model; last (0gm-1.0-35b-a3b): ", 0), (size_t)0);
}

TEST(fallback_none_configured_is_one_call) {
  Fake f;
  f.replies["0gm-1.0-35b-a3b"] = err(502, "provider_error");
  run::RouterConfig c = cfg();
  c.fallbackModels.clear();
  run::Decision d = run::decide(c, "PLAN", "c", f.call(), f.now());
  expectFailsafe(d);
  CHECK_EQ(f.asked.size(), (size_t)1);
  CHECK(d.attempts.empty());
  CHECK_EQ(d.error, std::string("HTTP 502 provider_error: m"));
}
