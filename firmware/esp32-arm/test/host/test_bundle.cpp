// Offline relay + mesh (spec v1): bundles built and signed by the board's code, read back field by field, verified the
// way every relayer must, served over the BLE cursor, kept in the outbox / carry store by their policies, and submitted
// against a fake chain. out/bundle.json + out/ping.json go to fw-crosscheck.ts, which checks them with ethers.
#include <sys/stat.h>
#include <fstream>
#include <map>
#include "harness.h"
#include "../../src/pearl/bundle.h"
#include "../../src/pearl/chain.h"
#include "../../src/pearl/json.h"
#include "../../src/pearl/mesh.h"

using namespace pearl;

static eth::Key vectorKey() {
  Bytes pk;
  fromHex(vectors()["eth"]["privateKey"].as<const char*>(), pk);
  eth::Key k;
  eth::keyFromPrivate(pk.data(), k);
  return k;
}
static eth::Key otherKey(uint8_t seed) {
  uint8_t p[32];
  for (int i = 0; i < 32; i++) p[i] = static_cast<uint8_t>(seed + i * 7 + 1);
  eth::Key k;
  eth::keyFromPrivate(p, k);
  return k;
}

static publish::Config cfg() {
  publish::Config c;
  c.anchorAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  c.storageNodes = {"http://node-a:5678"};
  c.arkivRpc = "https://rpc.arkiv.test/key";
  return c;
}
static bundle::Cache cache() {
  bundle::Cache c;
  c.og = {true, 41, 4000000007ULL, 4000000007ULL};
  c.arkiv = {true, 7, 1200000000ULL, 0};
  c.pricePerSector = eth::uintBytes(30733644962ULL);
  c.flow = "0x22e03a6a89b950f1c82ec5e74f8eca321a105296";
  return c;
}
static orch::Result sampleRun(const std::string& id = "ep_20261106052200_b7e2", int severity = 2) {
  orch::Result r;
  r.episodeId = id;
  r.outcome = severity ? "TRIPPED" : "DONE";
  r.headHash = sha256Hex(id);
  r.endedAt = "2026-11-06T05:22:09.120Z";
  r.incident = severity > 0;
  r.severity = severity;
  r.requestIds = {"0g-req-1", "0g-req-2"};
  r.sealedCanonical = "{\"cipher\":{\"data\":\"" + std::string(3000, 'Q') + "\"},\"episodeId\":\"" + id + "\",\"v\":1}";
  return r;
}
static std::vector<std::pair<size_t, Bytes>> frames() {
  Bytes a(26000), b(700);
  for (size_t i = 0; i < a.size(); i++) a[i] = static_cast<uint8_t>(i * 31 + 7);
  for (size_t i = 0; i < b.size(); i++) b[i] = static_cast<uint8_t>(i ^ 0x5a);
  return {{1, a}, {3, b}};
}
static Bytes salt() { return Bytes(16, 0x11); }

static bool buildOne(bundle::Built& out, const eth::Key& k, const orch::Result& r, bundle::Cache& c, std::string& err) {
  return bundle::build(cfg(), k, r, frames(), "2026-11-06T05:22:10.000Z", salt(), c, bundle::Limits{}, out, err);
}

TEST(bundle_builds_signed_txs_with_exact_fields) {
  eth::Key k = vectorKey();
  bundle::Cache c = cache();
  bundle::Built b;
  std::string err;
  CHECK(buildOne(b, k, sampleRun(), c, err));
  if (!err.empty()) fprintf(stderr, "      %s\n", err.c_str());
  JsonDocument d;
  CHECK(!deserializeJson(d, b.json));
  CHECK_EQ(bundle::idOf(d.as<JsonVariantConst>()), b.bundleId);
  CHECK_EQ(canonical(d.as<JsonVariantConst>()), b.json);  // stored canonical
  CHECK_EQ(eth::recoverPersonal(bundle::bundleMessage(b.bundleId), d["sig"] | ""), k.address);
  CHECK_EQ(std::string(d["device"] | ""), k.address);
  CHECK_EQ(std::string(d["summary"]["headHash"] | ""), "0x" + sha256Hex("ep_20261106052200_b7e2"));
  // nonces consumed: 3 storage + anchor on 0G, 1 on Arkiv
  CHECK_EQ(c.og.nonce, uint64_t(45));
  CHECK_EQ(c.arkiv.nonce, uint64_t(8));
  CHECK_EQ(b.ogNext, uint64_t(45));
  CHECK_EQ(b.arkivNext, uint64_t(8));
  JsonArrayConst txs = d["txs"].as<JsonArrayConst>();
  CHECK_EQ(txs.size(), size_t(5));
  const char* purposes[] = {"storage:log", "storage:frame:1", "storage:frame:3", "anchor", "arkiv"};
  std::vector<Bytes> files;
  for (JsonVariantConst f : d["files"].as<JsonArrayConst>()) {
    Bytes x;
    unbase64(f["data"] | "", x);
    files.push_back(x);
    CHECK_EQ(std::string(f["root"] | ""), to0x(chain::storageRoot(x)));
    CHECK_EQ(f["size"].as<size_t>(), x.size());
  }
  CHECK_EQ(files.size(), size_t(3));
  CHECK(files[0] == utf8(sampleRun().sealedCanonical));
  CHECK_EQ(std::string(d["summary"]["rootHash"] | ""), to0x(chain::storageRoot(files[0])));
  std::string storageTx, anchorTx;
  Bytes dev(k.addr, k.addr + 20);
  for (size_t i = 0; i < txs.size(); i++) {
    JsonVariantConst t = txs[i];
    CHECK_EQ(std::string(t["purpose"] | ""), std::string(purposes[i]));
    Bytes raw;
    fromHex(t["raw"] | "", raw);
    chain::DecodedTx dt;
    CHECK(chain::decodeEip1559(raw, dt));
    CHECK(memcmp(dt.from, k.addr, 20) == 0);
    CHECK_EQ(to0x(dt.hash), std::string(t["hash"] | ""));
    CHECK_EQ(dt.tx.nonce, t["nonce"].as<uint64_t>());
    CHECK_EQ(dt.tx.chainId, t["chainId"].as<uint64_t>());
    if (i < 3) {
      CHECK_EQ(dt.tx.chainId, uint64_t(16602));
      CHECK_EQ(dt.tx.nonce, uint64_t(41 + i));
      CHECK_EQ(to0x(dt.tx.to), std::string("0x22e03a6a89b950f1c82ec5e74f8eca321a105296"));
      CHECK_EQ(t["file"].as<int>(), int(i));
      CHECK(dt.tx.data == chain::submitCalldata(files[i].size(), chain::submissionNodes(files[i]), dev));
      // padded sectors × price × 1.2
      uint64_t want = 30733644962ULL * chain::paddedChunks(files[i].size()) * 12 / 10;
      CHECK(dt.tx.value == eth::uintBytes(want));
      CHECK_EQ(dt.tx.gas, uint64_t(1000000));
      CHECK(dt.tx.maxFeePerGas == eth::uintBytes(12000000021ULL));  // 3 × cached gas price
      CHECK(dt.tx.maxPriorityFeePerGas == eth::uintBytes(4000000007ULL));
      if (i == 0) storageTx = t["hash"] | "";
    } else if (i == 3) {
      CHECK_EQ(dt.tx.nonce, uint64_t(44));
      CHECK_EQ(to0x(dt.tx.to), std::string("0x5fbdb2315678afecb367f032d93f642f64180aa3"));
      CHECK(dt.tx.value.empty());
      CHECK(dt.tx.data == publish::anchorData(sampleRun(), to0x(chain::storageRoot(files[0]))));
      anchorTx = t["hash"] | "";
    } else {
      CHECK_EQ(dt.tx.chainId, uint64_t(7794095));
      CHECK_EQ(dt.tx.nonce, uint64_t(7));
      CHECK_EQ(to0x(dt.tx.to), std::string(chain::ARKIV_PROCESSOR));
      CHECK(dt.tx.data == publish::arkivData(cfg(), sampleRun(), to0x(chain::storageRoot(files[0])), storageTx, anchorTx, salt()));
      CHECK(dt.tx.maxFeePerGas == eth::uintBytes(3600000000ULL));
      CHECK(dt.tx.maxPriorityFeePerGas.empty());
    }
  }
  // stable: same inputs, same bytes, same id
  bundle::Cache c2 = cache();
  bundle::Built b2;
  CHECK(buildOne(b2, k, sampleRun(), c2, err));
  CHECK_EQ(b2.bundleId, b.bundleId);
  CHECK_EQ(b2.json, b.json);
  // the relayer's checks pass
  mesh::Verified v;
  CHECK(mesh::verify(d.as<JsonVariantConst>(), mesh::Chains{}, v, err));
  if (!err.empty()) fprintf(stderr, "      verify: %s\n", err.c_str());
  CHECK_EQ(v.bundleId, b.bundleId);
  CHECK_EQ(v.anchorTx, anchorTx);
  CHECK_EQ(v.severity, 2);
  mkdir(OUT_DIR, 0755);
  std::ofstream(std::string(OUT_DIR) + "/bundle.json") << b.json;
  // and the ping
  std::string ping = bundle::pingJson(k, "ep_20261106052200_b7e2", "TRIPPED", 2, sha256Hex("ep_20261106052200_b7e2"), 1762406529120ULL);
  std::ofstream(std::string(OUT_DIR) + "/ping.json") << ping;
}

TEST(bundle_refuses_without_cached_nonce) {
  bundle::Cache c;  // never online
  bundle::Built b;
  std::string err;
  CHECK(!buildOne(b, vectorKey(), sampleRun(), c, err));
  CHECK(err.find("nonce") != std::string::npos);
}

TEST(bundle_cache_roundtrips) {
  bundle::Cache c = cache(), d;
  CHECK(bundle::parseCache(bundle::cacheJson(c), d));
  CHECK_EQ(d.og.nonce, uint64_t(41));
  CHECK_EQ(d.arkiv.fee, uint64_t(1200000000ULL));
  CHECK(d.pricePerSector == c.pricePerSector);
  CHECK_EQ(d.flow, c.flow);
}

/** Re-signs a tampered bundle with `signer` (so only the intended check can fail). */
static std::string resign(JsonDocument& d, const eth::Key& signer) {
  d.remove("sig");
  std::string id = bundle::idOf(d.as<JsonVariantConst>());
  d["sig"] = eth::personalSign(signer, bundle::bundleMessage(id));
  return id;
}

TEST(mesh_verify_refuses_tampered_bundles) {
  eth::Key k = vectorKey();
  bundle::Cache c = cache();
  bundle::Built b;
  std::string err;
  buildOne(b, k, sampleRun(), c, err);
  mesh::Verified v;
  auto refused = [&](const std::function<void(JsonDocument&)>& tamper, const char* expect) {
    JsonDocument d;
    deserializeJson(d, b.json);
    tamper(d);
    std::string e;
    bool ok = mesh::verify(d.as<JsonVariantConst>(), mesh::Chains{}, v, e);
    CHECK(!ok);
    if (e.find(expect) == std::string::npos) {
      failures()++;
      fprintf(stderr, "  FAIL expected '%s', got '%s'\n", expect, e.c_str());
    }
  };
  // the carrier changes a label (sig no longer matches)
  refused([](JsonDocument& d) { d["summary"]["severity"] = 0; }, "signature");
  // someone else signs it
  refused([&](JsonDocument& d) { resign(d, otherKey(3)); }, "signature");
  // file bytes swapped (still signed by the device: the root check must catch it)
  refused([&](JsonDocument& d) {
    d["files"][1]["data"] = base64(Bytes(700, 1));
    d["files"][1]["size"] = 700;
    resign(d, k);
  }, "root");
  // a tx from another wallet, slipped in and re-signed
  refused([&](JsonDocument& d) {
    chain::Eip1559Tx t;
    t.chainId = 16602;
    t.nonce = 44;
    t.gas = 21000;
    t.maxFeePerGas = eth::uintBytes(1);
    fromHex("0x5FbDB2315678afecb367f032d93F642f64180aa3", t.to);
    Bytes raw, h;
    chain::signEip1559(otherKey(9), t, raw, h);
    d["txs"][3]["raw"] = to0x(raw);
    d["txs"][3]["hash"] = to0x(h);
    resign(d, k);
  }, "sender");
  // a tx on an unexpected chain (the device's own key)
  refused([&](JsonDocument& d) {
    chain::Eip1559Tx t;
    t.chainId = 1;
    t.nonce = 44;
    t.gas = 21000;
    t.maxFeePerGas = eth::uintBytes(1);
    fromHex("0x5FbDB2315678afecb367f032d93F642f64180aa3", t.to);
    Bytes raw, h;
    chain::signEip1559(k, t, raw, h);
    d["txs"][3]["raw"] = to0x(raw);
    d["txs"][3]["hash"] = to0x(h);
    d["txs"][3]["chainId"] = 1;
    resign(d, k);
  }, "chainId");
  // the stated hash lies
  refused([&](JsonDocument& d) {
    d["txs"][0]["hash"] = "0x" + std::string(64, 'a');
    resign(d, k);
  }, "hash");
}

TEST(ping_is_signed_and_verifiable) {
  eth::Key k = vectorKey();
  std::string p = bundle::pingJson(k, "ep_x", "TRIPPED", 2, "ab12", 1762400000000ULL);
  JsonDocument d;
  deserializeJson(d, p);
  CHECK_EQ(std::string(d["headHash"] | ""), std::string("0xab12"));
  std::string msg = "pearl/ping/v1|" + bundle::hex0x(k.address) + "|ep_x|TRIPPED|2|0xab12|1762400000000";
  CHECK_EQ(bundle::pingMessage(k.address, "ep_x", "TRIPPED", 2, "0xab12", 1762400000000ULL), msg);
  CHECK_EQ(eth::recoverPersonal(msg, d["sig"] | ""), k.address);
  mesh::Ping pg;
  CHECK(mesh::verifyPing(p, pg));
  d["severity"] = 0;
  std::string forged;
  serializeJson(d, forged);
  CHECK(!mesh::verifyPing(forged, pg));
}

struct FakeSource : bundle::Source {
  std::map<std::string, std::string> files;
  std::string list = "[]";
  size_t read(const std::string& id, size_t off, uint8_t* out, size_t n) override {
    auto it = files.find(id);
    if (it == files.end() || off >= it->second.size()) return 0;
    n = std::min(n, it->second.size() - off);
    memcpy(out, it->second.data() + off, n);
    return n;
  }
  std::string listing(const std::string& what) override { return what == "LIST" ? list : "[]"; }
};

TEST(ble_data_reads_advance_and_end) {
  FakeSource s;
  std::string id = "0x" + std::string(64, 'b');
  std::string body(1300, 'x');
  for (size_t i = 0; i < body.size(); i++) body[i] = static_cast<char>('a' + i % 26);
  s.files[id] = body;
  bundle::Cursor c;
  uint8_t buf[600];
  CHECK_EQ(c.next(s, buf), size_t(0));  // nothing selected
  CHECK(c.select(id + " 0", s));
  std::string got;
  size_t n;
  std::vector<size_t> sizes;
  while ((n = c.next(s, buf)) > 0) {
    sizes.push_back(n);
    got.append(reinterpret_cast<char*>(buf), n);
  }
  CHECK_EQ(sizes.size(), size_t(3));
  CHECK_EQ(sizes[0], size_t(512));
  CHECK_EQ(sizes[2], size_t(276));
  CHECK(got == body);
  CHECK_EQ(c.next(s, buf), size_t(0));  // stays at end
  // resume from an offset (a courier that lost the link)
  CHECK(c.select(id + " 1000", s));
  CHECK_EQ(c.next(s, buf), size_t(300));
  CHECK(memcmp(buf, body.data() + 1000, 300) == 0);
  CHECK(c.select(id, s));  // no offset = 0
  CHECK_EQ(c.offset(), size_t(0));
  // malformed
  CHECK(!c.select("0x12 0", s));
  CHECK(!c.select(id + " -5", s));
  CHECK(!c.select("../../etc 0", s));
  CHECK(!c.select("", s));
  // unknown bundle: end at once
  CHECK(c.select("0x" + std::string(64, 'c'), s));
  CHECK_EQ(c.next(s, buf), size_t(0));
  // LIST paging: a snapshot, read in 512-byte pages, resumable
  std::string list = "[";
  for (int i = 0; i < 20; i++) list += std::string(i ? "," : "") + "{\"bundleId\":\"0x" + std::string(64, static_cast<char>('a' + i % 6)) + "\",\"own\":false}";
  list += "]";
  s.list = list;
  CHECK(c.select("LIST 0", s));
  s.list = "[]";  // changes after the snapshot do not tear the pages
  got.clear();
  while ((n = c.next(s, buf)) > 0) got.append(reinterpret_cast<char*>(buf), n);
  CHECK(got == list);
  CHECK(c.select("LIST 512", s));  // resume keeps the snapshot
  n = c.next(s, buf);
  CHECK_EQ(std::string(reinterpret_cast<char*>(buf), n), list.substr(512, 512));
  CHECK(c.select("RECEIPTS 0", s));
  n = c.next(s, buf);
  CHECK_EQ(std::string(reinterpret_cast<char*>(buf), n), std::string("[]"));
}

static bundle::Entry entry(char c, uint64_t seq, int sev, const char* state = "queued") {
  bundle::Entry e;
  e.bundleId = "0x" + std::string(64, c);
  e.episodeId = "ep_20261106052200_" + std::string(4, c);
  e.outcome = sev ? "TRIPPED" : "DONE";
  e.severity = sev;
  e.size = 150000;
  e.seq = seq;
  e.state = state;
  e.ogNext = 40 + seq * 4;
  e.arkivNext = 7 + seq;
  return e;
}

TEST(outbox_is_oldest_first_and_info_fits) {
  bundle::Index ix;
  ix.add(entry('c', 3, 0));
  ix.add(entry('a', 1, 2, "relayed"));
  ix.add(entry('b', 2, 1));
  std::vector<bundle::Entry> o = ix.ordered();
  CHECK_EQ(o[0].seq, uint64_t(1));
  CHECK_EQ(o[2].seq, uint64_t(3));
  CHECK_EQ(ix.pending(), uint8_t(3));
  CHECK_EQ(ix.maxSeverity(), uint8_t(2));
  CHECK_EQ(ix.nextOg(), uint64_t(52));
  CHECK_EQ(ix.nextArkiv(), uint64_t(10));
  CHECK(ix.fits(1000000, 2000000));
  CHECK(!ix.fits(1900000, 2000000));
  for (int i = 0; i < 6; i++) ix.add(entry(static_cast<char>('d' + i), 4 + i, 0));
  std::string info = ix.infoJson("0xAbC", "arm-1", 2, 1);
  CHECK(info.size() <= 512);
  JsonDocument d;
  CHECK(!deserializeJson(d, info));
  CHECK_EQ(d["carrying"].as<int>(), 2);
  CHECK_EQ(d["delivered"].as<int>(), 1);
  JsonArrayConst p = d["pending"].as<JsonArrayConst>();
  CHECK(p.size() >= 2);
  CHECK_EQ(std::string(p[0]["bundleId"] | ""), "0x" + std::string(64, 'b'));  // relayed one goes last
  bundle::Entry back;
  CHECK(bundle::parseEntry(bundle::entryJson(o[0]), back));
  CHECK_EQ(back.state, std::string("relayed"));
  CHECK(ix.remove(o[0].bundleId));
  CHECK(!ix.find(o[0].bundleId));
}

static mesh::Carried carried(char c, const std::string& origin, int sev, uint64_t created, size_t size, int hops = 1) {
  mesh::Carried x;
  x.bundleId = "0x" + std::string(64, c);
  x.origin = origin;
  x.episodeId = "ep_" + std::string(1, c);
  x.severity = sev;
  x.createdAtMs = created;
  x.size = size;
  x.hops = hops;
  return x;
}

TEST(carry_store_policy) {
  const std::string self = "0xself", A = "0xaaaa", B = "0xbbbb", C = "0xcccc";
  const uint64_t day = 24ULL * 3600 * 1000, now = 100 * day;
  mesh::Carry cs;
  std::vector<std::string> ev;
  // dedupe, own, hops, TTL, size
  cs.add(carried('1', A, 0, now - day, 400000));
  CHECK(cs.admit(carried('1', A, 0, now - day, 400000), now, self, ev) == mesh::Admit::DUPLICATE);
  CHECK(cs.admit(carried('2', "0xSELF", 0, now, 10), now, self, ev) == mesh::Admit::OWN);
  CHECK(cs.admit(carried('2', B, 0, now, 10, 9), now, self, ev) == mesh::Admit::HOPS);
  CHECK(cs.admit(carried('2', B, 0, now, 10, 8), now, self, ev) == mesh::Admit::OK);
  CHECK(cs.admit(carried('2', B, 0, now - 7 * day, 10), now, self, ev) == mesh::Admit::EXPIRED);
  CHECK(cs.admit(carried('2', B, 0, now, (1u << 20) + 1), now, self, ev) == mesh::Admit::TOO_BIG);
  // per-origin cap 1 MB: A has 400 KB; another 400 KB fits, a third only if it outranks one of A's
  cs.add(carried('3', A, 0, now - 2 * day, 400000));
  CHECK(cs.admit(carried('4', A, 0, now, 400000), now, self, ev) == mesh::Admit::NO_ROOM);  // newer, same severity: outranked
  CHECK(cs.admit(carried('4', A, 3, now, 400000), now, self, ev) == mesh::Admit::OK);       // an incident evicts the newest low one
  CHECK_EQ(ev.size(), size_t(1));
  CHECK_EQ(ev[0], "0x" + std::string(64, '1'));
  // total cap 4 MB across origins: fill with B and C, then an incident from another origin pushes out the lowest
  cs.pol.cap = 2000000;
  cs.add(carried('5', B, 1, now - 3 * day, 600000));
  cs.add(carried('6', C, 0, now - day, 500000));  // total 1.9 MB
  CHECK(cs.admit(carried('7', "0xdddd", 0, now, 300000), now, self, ev) == mesh::Admit::NO_ROOM);
  CHECK(cs.admit(carried('7', "0xdddd", 2, now, 300000), now, self, ev) == mesh::Admit::OK);
  CHECK_EQ(ev.size(), size_t(1));
  CHECK_EQ(ev[0], "0x" + std::string(64, '6'));  // severity 0 and newest of the low ones
  // priority order: incidents first, then oldest
  std::vector<mesh::Carried> o = cs.ordered();
  CHECK_EQ(o[0].bundleId, "0x" + std::string(64, '5'));
  CHECK_EQ(o[1].bundleId, "0x" + std::string(64, '3'));
  // receipts: delivered drops the bundle, refuses it later, is listed; TTL drops old bundles and receipts
  cs.delivered("0x" + std::string(64, '3'), "0xanchor", 16602, now);
  CHECK(!cs.find("0x" + std::string(64, '3')));
  CHECK(cs.admit(carried('3', A, 0, now, 10), now, self, ev) == mesh::Admit::DELIVERED);
  std::vector<mesh::Receipt> rs;
  CHECK(mesh::parseReceipts(mesh::receiptsJson(cs), rs));
  CHECK_EQ(rs.size(), size_t(1));
  CHECK_EQ(rs[0].anchorTx, std::string("0xanchor"));
  // unverified done: stops forwarding (not listed, not counted), kept
  CHECK(cs.stopForward("0x" + std::string(64, '6')));
  CHECK_EQ(cs.forwardable(), size_t(2));  // 1 and 5 (3 delivered, 6 stopped)
  bundle::Index own;
  own.add(entry('e', 1, 1));
  std::vector<mesh::ListItem> li;
  CHECK(mesh::parseList(mesh::listJson(own, "0xSELF", cs), li));
  CHECK_EQ(li.size(), size_t(3));
  CHECK(li[0].own);
  CHECK_EQ(li[0].hops, 0);
  CHECK_EQ(li[0].origin, std::string("0xself"));
  CHECK_EQ(li[1].bundleId, "0x" + std::string(64, '5'));  // carried: incidents first
  for (const auto& x : li) CHECK(x.bundleId != "0x" + std::string(64, '6'));
  std::vector<std::string> gone = cs.expire(now + 5 * day);  // only 5 (created now-3d) is past 7 days
  CHECK_EQ(gone.size(), size_t(1));
  CHECK_EQ(gone[0], "0x" + std::string(64, '5'));
  CHECK_EQ(cs.receipts.size(), size_t(1));
  cs.expire(now + 8 * day);
  CHECK_EQ(cs.receipts.size(), size_t(0));
  mesh::Carried back;
  CHECK(mesh::parseCarried(mesh::carriedJson(carried('9', A, 2, 5, 6, 3)), back));
  CHECK_EQ(back.hops, 3);
  CHECK_EQ(back.severity, 2);
}

TEST(ping_gossip_keeps_verified_and_fits) {
  mesh::Pings ps;
  for (int i = 0; i < 10; i++) {
    eth::Key k = otherKey(static_cast<uint8_t>(i * 13));
    CHECK(ps.add(bundle::pingJson(k, "ep_" + std::to_string(i), i == 4 ? "TRIPPED" : "DONE", i == 4 ? 3 : 0, "00", 1000 + i)));
  }
  CHECK(!ps.add("{\"v\":1,\"device\":\"0x00\",\"sig\":\"0x00\"}"));
  CHECK_EQ(ps.list.size(), size_t(8));
  CHECK_EQ(ps.list[0].severity, 3);  // the incident leads
  std::string small = ps.json(512);
  CHECK(small.size() <= 512);
  JsonDocument d;
  CHECK(!deserializeJson(d, small));
  CHECK(d.as<JsonArrayConst>().size() >= 1);
  JsonDocument all;
  CHECK(!deserializeJson(all, ps.json()));
  CHECK_EQ(all.as<JsonArrayConst>().size(), size_t(8));
}

/** A chain that accepts raw txs and mines them; one storage node. */
struct FakeChain : orch::Platform {
  uint32_t t = 0;
  std::vector<std::string> sent, uploads;
  std::map<std::string, bool> mined;
  bool nonceTaken = false;
  uint32_t millis() override { return t += 10; }
  void sleep(uint32_t ms) override { t += ms; }
  std::string nowIso() override { return "2026-11-06T06:00:00.000Z"; }
  bool camera(Bytes&, std::string&) override { return false; }
  void saveFrame(const std::string&, size_t, const Bytes&) override {}
  run::HttpResult post(const std::string& url, const orch::Headers&, const std::string& body, uint32_t) override {
    JsonDocument q, r;
    deserializeJson(q, body);
    std::string m = q["method"] | "";
    r["jsonrpc"] = "2.0";
    r["id"] = 1;
    JsonVariant res = r["result"].to<JsonVariant>();
    if (m == "eth_sendRawTransaction") {
      Bytes raw;
      fromHex(q["params"][0] | "", raw);
      std::string h = to0x(keccak256(raw));
      if (nonceTaken) r["error"]["message"] = "nonce too low";
      else if (mined.count(h)) r["error"]["message"] = "already known";
      else {
        sent.push_back(h);
        mined[h] = true;
        res.set(h);
      }
    } else if (m == "eth_getTransactionReceipt" || m == "eth_getTransactionByHash") {
      std::string h = q["params"][0] | "";
      if (mined.count(h)) {
        res["status"] = "0x1";
        JsonObject l = res["logs"].to<JsonArray>().add<JsonObject>();
        JsonArray tp = l["topics"].to<JsonArray>();
        tp.add(chain::ARKIV_ENTITY_CREATED_TOPIC);
        tp.add("0x" + std::string(64, 'e'));
      } else
        res.set(nullptr);
    } else if (m == "zgs_getShardConfig") {
      res["shardId"] = 0;
      res["numShard"] = 1;
    } else if (m == "zgs_getStatus") res["networkIdentity"]["flowAddress"] = "0x22e03a6a89b950f1c82ec5e74f8eca321a105296";
    else if (m == "zgs_getFileInfo") {
      res["tx"]["seq"] = 70 + uploads.size();
      res["tx"]["startEntryIndex"] = 0;
      res["finalized"] = !uploads.empty() && uploads.back() == std::string(q["params"][0] | "");
    } else if (m == "zgs_uploadSegmentsByTxSeq") {
      uploads.push_back(q["params"][0][0]["root"] | "");
      res.set(nullptr);
    }
    run::HttpResult h;
    h.status = 200;
    serializeJson(r, h.body);
    return h;
  }
};

TEST(robot_submits_its_bundle_in_order_and_idempotently) {
  eth::Key k = vectorKey();
  bundle::Cache c = cache();
  bundle::Built b;
  std::string err;
  buildOne(b, k, sampleRun(), c, err);
  JsonDocument d;
  deserializeJson(d, b.json);
  FakeChain net;
  JsonDocument meta;
  bundle::Submitted s = bundle::submit(net, cfg(), d.as<JsonVariantConst>(), meta);
  CHECK_EQ(s.state, std::string("done"));
  CHECK_EQ(s.steps.size(), size_t(5));
  CHECK_EQ(net.sent.size(), size_t(5));
  for (size_t i = 0; i < net.sent.size(); i++) CHECK_EQ(net.sent[i], std::string(d["txs"][i]["hash"] | ""));
  CHECK_EQ(net.uploads.size(), size_t(3));
  CHECK_EQ(std::string(meta["storage"]["status"] | ""), std::string("ok"));
  CHECK_EQ(std::string(meta["storage"]["rootHash"] | ""), std::string(d["summary"]["rootHash"] | ""));
  CHECK_EQ(std::string(meta["anchor"]["status"] | ""), std::string("ok"));
  CHECK_EQ(std::string(meta["anchor"]["txHash"] | ""), std::string(d["txs"][3]["hash"] | ""));
  CHECK_EQ(std::string(meta["arkiv"]["entityKey"] | ""), "0x" + std::string(64, 'e'));
  CHECK_EQ(meta["frames"].size(), size_t(2));
  CHECK_EQ(std::string(meta["bundleId"] | ""), b.bundleId);
  // a second run (a courier already delivered it): no new sends, still done
  JsonDocument meta2;
  s = bundle::submit(net, cfg(), d.as<JsonVariantConst>(), meta2);
  CHECK_EQ(s.state, std::string("done"));
  CHECK_EQ(net.sent.size(), size_t(5));
  // the nonce went to another tx: stale, stop at once
  FakeChain other;
  other.nonceTaken = true;
  JsonDocument meta3;
  s = bundle::submit(other, cfg(), d.as<JsonVariantConst>(), meta3);
  CHECK_EQ(s.state, std::string("stale"));
  CHECK_EQ(s.steps.size(), size_t(1));
  CHECK_EQ(s.steps[0].status, std::string("stale"));
}
