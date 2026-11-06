// env:device — Bluetooth LE for the offline relay and the mesh (spec v1 §4, §5, §7), on the core's built-in BLE
// library (NimBLE host on the S3). Peripheral: always advertising "Pearl-<last4>" + the Pearl service, serving info,
// ping, select/data (bundles, LIST, RECEIPTS, PINGS), ack and pings. Central: the mesh pull cycle (scan ~5 s every
// ~30 s, one peer at a time). Everything runs in the BLE host task and a low-priority "mesh" task: loop() (the safety
// checks) never waits on the radio; write callbacks only record or queue work.
#pragma once
#include <string>

namespace ble {
/** Starts BLE (after outbox::begin). `name` = "Pearl-xxxx". */
void begin(const std::string& name);
/** The latest run's signed ping: served on `ping` (read + notify) and added to the gossiped pings. */
void setPing(const std::string& json);
bool started();
}  // namespace ble
