/** pnpm device — the device program (the virtual ESP32 in sim). Port DEVICE_HTTP_PORT (default 8070). */
import { createApp } from "./app.js";

const port = Number(process.env.DEVICE_HTTP_PORT ?? 8070);
const ctx = await createApp();
await ctx.startDevice();
const server = ctx.app.listen(port, () => {
  console.log(`device ${ctx.deviceAddress} on http://localhost:${port} (DEVICE=${ctx.device.kind})`);
});
const shutdown = async () => {
  server.close();
  await ctx.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
