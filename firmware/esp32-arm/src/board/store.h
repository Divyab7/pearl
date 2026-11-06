// env:device — the robot's memory (F2, F3): runs on LittleFS, keys in NVS.
//  /runs/<id>.json         the readable log (stays on the robot)
//  /runs/<id>.sealed.json  the locked copy (what 0G Storage holds and the robot serves)
//  /runs/<id>.meta.json    where it went (storage, anchor, Arkiv, frames)
//  /runs/<id>/f<idx>.lock  locked camera frames
//  NVS "pearl": dev (the robot's secp256k1 key), owner (the linked owner's P-256 public key JSON), run keys "r<hash>"
#pragma once
#include <string>
#include <vector>
#include "pearl/bytes.h"
#include "pearl/eth.h"

namespace store {
bool begin();
bool writeFile(const std::string& path, const std::string& data);
bool writeBytes(const std::string& path, const pearl::Bytes& data);
bool readFile(const std::string& path, std::string& out);
bool readBytes(const std::string& path, pearl::Bytes& out);
/** Run ids, newest first (by name: ep_YYYYMMDDhhmmss_xxxx). */
std::vector<std::string> runIds(size_t max = 100);
bool validRunId(const std::string& id);

/** The robot's key: loaded from NVS, created with the hardware RNG on first boot. */
bool deviceKey(pearl::eth::Key& k);
bool saveRunKey(const std::string& episodeId, const pearl::Bytes& key);
bool loadRunKey(const std::string& episodeId, pearl::Bytes& key);
bool saveOwner(const std::string& json);
bool loadOwner(std::string& json);
}  // namespace store
