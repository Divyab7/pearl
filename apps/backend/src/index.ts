/** pnpm dev:backend — the dashboard server on the laptop (port 8080; the web page proxies /api here). */
import { createDashboard } from "./dashboard/server.js";
import { envFlag } from "./shared/env.js";
import { advertiseRelay } from "./relay/mdns.js";

const port = Number(process.env.PORT ?? 8080);
const { app, deviceUrl, watchForRelays, relayQueue } = createDashboard();
if (envFlag("STORAGE_RELAY", "off")) watchForRelays();
// bundles a restart interrupted carry on; robots on this Wi-Fi find the relay by mDNS (RELAY_MDNS=off to stop it)
relayQueue.resume();
let stopMdns = () => {};
if (envFlag("RELAY_MDNS", "on")) {
  try {
    stopMdns = advertiseRelay(port);
  } catch (e) {
    console.warn("mDNS advertisement failed:", e);
  }
}
const server = app.listen(port, () => {
  console.log(`dashboard server on http://localhost:${port}, device at ${deviceUrl}`);
});
const shutdown = () => {
  stopMdns();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
