#ifdef PEARL_DEVICE
#include "store.h"
#include <LittleFS.h>
#include <Preferences.h>
#include <algorithm>

namespace store {

static Preferences prefs;

bool begin() {
  if (!LittleFS.begin(true)) return false;  // formats on first use
  if (!LittleFS.exists("/runs")) LittleFS.mkdir("/runs");
  return prefs.begin("pearl", false);
}

bool validRunId(const std::string& id) {
  if (id.size() < 4 || id.size() > 40 || id.compare(0, 3, "ep_") != 0) return false;
  for (char c : id)
    if (!(isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-')) return false;
  return true;
}

static void ensureDir(const std::string& path) {
  size_t slash = path.rfind('/');
  if (slash == std::string::npos || slash == 0) return;
  std::string dir = path.substr(0, slash);
  if (!LittleFS.exists(dir.c_str())) LittleFS.mkdir(dir.c_str());
}

bool writeBytes(const std::string& path, const pearl::Bytes& data) {
  ensureDir(path);
  File f = LittleFS.open(path.c_str(), "w");
  if (!f) return false;
  size_t n = f.write(data.data(), data.size());
  f.close();
  return n == data.size();
}

bool writeFile(const std::string& path, const std::string& data) {
  return writeBytes(path, pearl::Bytes(data.begin(), data.end()));
}

bool readBytes(const std::string& path, pearl::Bytes& out) {
  File f = LittleFS.open(path.c_str(), "r");
  if (!f) return false;
  out.resize(f.size());
  size_t n = f.read(out.data(), out.size());
  f.close();
  return n == out.size();
}

bool readFile(const std::string& path, std::string& out) {
  pearl::Bytes b;
  if (!readBytes(path, b)) return false;
  out.assign(b.begin(), b.end());
  return true;
}

std::vector<std::string> runIds(size_t max) {
  std::vector<std::string> ids;
  File dir = LittleFS.open("/runs");
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    std::string n = f.name();
    const std::string suf = ".sealed.json";
    if (n.size() > suf.size() && n.compare(n.size() - suf.size(), suf.size(), suf) == 0) ids.push_back(n.substr(0, n.size() - suf.size()));
  }
  std::sort(ids.rbegin(), ids.rend());
  if (ids.size() > max) ids.resize(max);
  return ids;
}

bool deviceKey(pearl::eth::Key& k) {
  uint8_t priv[32];
  if (prefs.getBytesLength("dev") == 32 && prefs.getBytes("dev", priv, 32) == 32 && pearl::eth::keyFromPrivate(priv, k)) return true;
  if (!pearl::eth::newKey(k)) return false;  // esp_fill_random: the hardware RNG (Wi-Fi/BT on = true random)
  return prefs.putBytes("dev", k.priv, 32) == 32;
}

static std::string runKeyName(const std::string& episodeId) {
  // NVS keys are ≤ 15 chars: "r" + 14 hex of sha256(id)
  return "r" + pearl::sha256Hex(episodeId).substr(0, 14);
}

bool saveRunKey(const std::string& episodeId, const pearl::Bytes& key) {
  return prefs.putBytes(runKeyName(episodeId).c_str(), key.data(), key.size()) == key.size();
}

bool loadRunKey(const std::string& episodeId, pearl::Bytes& key) {
  std::string n = runKeyName(episodeId);
  if (prefs.getBytesLength(n.c_str()) != 32) return false;
  key.resize(32);
  return prefs.getBytes(n.c_str(), key.data(), 32) == 32;
}

bool saveOwner(const std::string& json) { return prefs.putString("owner", json.c_str()) > 0; }

bool loadOwner(std::string& json) {
  if (!prefs.isKey("owner")) return false;
  json = prefs.getString("owner").c_str();
  return !json.empty();
}

}  // namespace store
#endif
