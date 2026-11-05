/** pnpm dev:backend — the dashboard server on the laptop (port 8080; the web page proxies /api here). */
import { createDashboard } from "./dashboard/server.js";
import { envFlag } from "./shared/env.js";

const port = Number(process.env.PORT ?? 8080);
const { app, deviceUrl, watchForRelays } = createDashboard();
if (envFlag("STORAGE_RELAY", "off")) watchForRelays();
const server = app.listen(port, () => {
  console.log(`dashboard server on http://localhost:${port}, device at ${deviceUrl}`);
});
const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
