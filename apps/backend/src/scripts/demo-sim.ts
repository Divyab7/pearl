/**
 * pnpm demo:sim [-- --scenario normal|hand|bump|cut0g|all]
 * Runs real episodes against the simulated arm in-process (PLAN §4.1), or against the MuJoCo arm with DEVICE=mujoco
 * (start the bridge first: pnpm sim:mujoco):
 *   normal  red cube A2 → BIN
 *   hand    a hand enters the zone during the carry → freeze → INCIDENT → RESUME after clear
 *   bump    the base is knocked → TRIPPED → INCIDENT (RESUME overridden) → claim_requested event (claims are made by people in the dashboard)
 *   cut0g   0G unreachable → FAILSAFE record, arm to SAFE
 * 0G calls, 0G Storage, the 0G Chain anchor and Arkiv are real when .env has the keys and funded wallets; without them each step says what is missing.
 */
import { createApp } from "../app.js";
import type { EpisodeLog } from "../shared/types.js";
import { requestIdsOf } from "../orchestrator/log.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const scenario = process.argv.includes("--cut0g") ? "cut0g" : (arg("scenario") ?? "normal");
const list = scenario === "all" ? ["normal", "hand", "bump", "cut0g"] : [scenario];

const ctx = await createApp();
await ctx.startDevice();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// a wire arm (MuJoCo bridge, ESP32) connects to us: wait for its telemetry before the first command
if (!ctx.monitor.linkAlive()) console.log(`waiting for the ${ctx.device.kind} arm to connect…`);
for (let i = 0; i < 300 && !ctx.monitor.linkAlive(); i++) await wait(100);
if (!ctx.monitor.linkAlive()) {
  console.error(`no telemetry from the ${ctx.device.kind} arm after 30 s${ctx.device.kind === "mujoco" ? " (start it with: pnpm sim:mujoco)" : ""}`);
  await ctx.stop();
  process.exit(1);
}

ctx.orch.on((ev) => {
  if (ev.type === "status") console.log(`  phase → ${ev.status.phase}`);
  if (ev.type === "record" && ev.record.kind === "decision") {
    const r = ev.record;
    console.log(`  ${r.checkpoint.padEnd(12)} ${r.source.padEnd(8)} request_id=${r.requestId ?? "-"} policy="${r.policy}"${r.override ? ` override="${r.override}"` : ""}${r.error ? ` error="${r.error}"` : ""}`);
  }
  if (ev.type === "record" && ev.record.kind === "event" && !["episode_start", "episode_end"].includes(ev.record.ev)) {
    console.log(`  event ${ev.record.ev} ${JSON.stringify(ev.record.data)}`);
  }
});

function summary(log: EpisodeLog) {
  const ids = requestIdsOf(log);
  console.log(`  outcome ${log.outcome} · ${log.records.length} records · head ${log.headHash.slice(0, 16)}… · 0G request ids: ${ids.join(", ") || "(none)"}`);
}

for (const s of list) {
  console.log(`\n=== scenario: ${s} ===`);
  // a previous bump leaves the arm tripped: reset it the way the operator would
  if (ctx.monitor.state === "TRIPPED") {
    ctx.device.send({ cmd: "reset" });
    ctx.monitor.clearTrip();
    await ctx.monitor.waitFor((t) => t.state === "SAFE", 3000, false);
  }
  // MuJoCo keeps cubes where physics left them: put them back on their posts like the operator would
  if (ctx.mj) await ctx.mj.resetTable().catch((e) => console.log(`  (table not reset: ${e instanceof Error ? e.message : e})`));
  ctx.setCut0g(s === "cut0g");
  const { episodeId, done } = ctx.orch.start({ task: "pick", color: s === "hand" ? "blue" : "red", from: s === "hand" ? "A3" : "A2", to: "BIN" });
  console.log(`  episode ${episodeId}`);
  if (s === "hand" || s === "bump") {
    const phaseWanted = s === "hand" ? "MOVING_TO_PLACE" : "VERIFYING_GRASP";
    void (async () => {
      for (let i = 0; i < 600 && ctx.orch.status().phase !== phaseWanted && ctx.orch.busy; i++) await wait(50);
      if (!ctx.orch.busy) return;
      if (s === "hand") await (ctx.sim ? ctx.sim.injectHand(2500) : ctx.mj!.injectHand(2500));
      else await (ctx.sim ? ctx.sim.injectBump() : ctx.mj!.injectBump());
      console.log(`  (injected ${s})`);
    })();
  }
  summary(await done);
  await wait(500);
}
console.log("\nepisodes and meta are in data/episodes; publishing to 0G Storage, 0G Chain and Arkiv continues in the background");
await wait(3000);
await ctx.stop();
process.exit(0);
