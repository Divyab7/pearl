/**
 * The DEVICE program (rev 5, device-first): the virtual ESP32 in sim, and the same role the firmware takes on hardware.
 * It runs the arm, the safety loop, the 0G decisions and the hash-chained log, and with its OWN key it uploads to 0G
 * Storage, anchors on 0G Chain and writes Arkiv. It serves a read-only status feed plus operator requests it may refuse.
 * Verification, accounts and claims live in the dashboard server (src/dashboard/server.ts), never here.
 * Express 5 API: https://expressjs.com/en/5x/api.html
 */
import cors from "cors";
import express, { type Request, type Response } from "express";
import { cameraFromEnv, httpCamera } from "./camera/index.js";
import { STATUS_TABLE, type ArmDevice } from "./device/ArmDevice.js";
import { Heartbeat } from "./device/heartbeat.js";
import { DeviceMonitor } from "./device/monitor.js";
import { SimArm } from "./device/SimArm.js";
import { SerialArm } from "./device/SerialArm.js";
import { WsArm } from "./device/WsArm.js";
import { MujocoArm } from "./device/MujocoArm.js";
import { routerConfigFromEnv } from "./og/config.js";
import { framePath, listEpisodeIds, readEpisode } from "./orchestrator/log.js";
import { readFileSync } from "node:fs";
import { readMeta } from "./orchestrator/meta.js";
import { publishEpisode } from "./orchestrator/pipeline.js";
import { downloadBytes, storageConfigFromEnv } from "./og/storage.js";
import { linkMessage, loadDeviceWallet, signerFor } from "./shared/deviceKey.js";
import { envFlag, loadEnv } from "./shared/env.js";
import { Orchestrator } from "./orchestrator/episode.js";
import { loadArmConfig, type ArmConfig } from "./shared/armConfig.js";
import { parseTask } from "./shared/schemas.js";
import type { EpisodeLog } from "./shared/types.js";
import { SseHub } from "./sse.js";
import { ZerobotOperator } from "./zerobot/operator.js";
import { API_RUN_EPISODE, txLink, ZEROBOT_MISSING, zerobotConfigFromEnv, zerobotFromEnv, type ZerobotChain } from "./zerobot/zerobot.js";
import { errMsg } from "./shared/util.js";

export interface AppOptions {
  /** zerobot chain access (tests pass a fake); default: real contracts when ROBOT_ZEROBOT=on and configured. */
  zerobot?: ZerobotChain | null;
  device?: ArmDevice;
  arm?: ArmConfig;
  fetchImpl?: typeof fetch;
  writeFiles?: boolean;
  /** Upload/anchor after each episode (default true; tests turn it off). */
  publish?: boolean;
  /** Tests only: run the publish pipeline without the networked 0G Storage upload. */
  skipStorage?: boolean;
  onEpisodeClosed?: (log: EpisodeLog) => Promise<void> | void;
}

const simDeviceId = () => process.env.SIM_DEVICE_ID ?? "sim-arm-01";

export function createDevice(arm: ArmConfig): ArmDevice {
  const kind = process.env.DEVICE ?? "sim";
  if (kind === "sim") {
    return new SimArm(arm, {
      deviceId: simDeviceId(),
      graspFailRate: Number(process.env.SIM_GRASP_FAIL_RATE ?? 0),
    });
  }
  if (kind === "serial") {
    const path = process.env.SERIAL_PATH;
    if (!path) throw new Error("DEVICE=serial needs SERIAL_PATH (e.g. /dev/cu.usbmodem1101)");
    return new SerialArm(path);
  }
  if (kind === "ws") return new WsArm(Number(process.env.WS_PORT ?? 8081));
  if (kind === "mujoco") return new MujocoArm(Number(process.env.WS_PORT ?? 8081), process.env.MUJOCO_URL ?? "http://127.0.0.1:8092");
  throw new Error(`DEVICE must be sim, mujoco, serial or ws, got ${kind}`);
}

export async function createApp(opts: AppOptions = {}) {
  loadEnv();
  const arm = opts.arm ?? loadArmConfig();
  const device = opts.device ?? createDevice(arm);
  const monitor = new DeviceMonitor(device);
  const heartbeat = new Heartbeat(device, arm.heartbeatIntervalMs);
  const sse = new SseHub();
  const sim = device instanceof SimArm ? device : null;
  const mj = device instanceof MujocoArm ? device : null;
  const sceneNow = () => sim?.scene.snapshot() ?? mj?.scene() ?? null;
  // the MuJoCo bridge renders the table camera; CAMERA_SOURCE still wins when it is set explicitly
  const camera = mj && !process.env.CAMERA_SOURCE ? httpCamera(mj.frameUrl) : cameraFromEnv();
  let cut0g = false;

  // the device's own key (rev 5): DEVICE_PRIVATE_KEY on hardware, a generated test key for the simulated arm
  const deviceIdNow = sim
    ? simDeviceId()
    : (process.env.DEVICE_ID ?? (mj ? "mujoco-arm-01" : "esp32-s3-01"));
  const deviceWallet = loadDeviceWallet(deviceIdNow);

  const orch = new Orchestrator({
    deviceSigner: signerFor(deviceWallet),
    device,
    monitor,
    arm,
    camera,
    armId: process.env.ARM_ID ?? "arm-1",
    deviceId: deviceIdNow,
    routerConfig: () =>
      routerConfigFromEnv(cut0g ? { baseUrl: process.env.OG_BLACKHOLE_URL ?? "http://10.255.255.1" } : {}),
    scene: sceneNow,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.writeFiles !== undefined ? { writeFiles: opts.writeFiles } : {}),
    onEpisodeClosed: async (log) => {
      sse.send("episode", { episodeId: log.episodeId, outcome: log.outcome, headHash: log.headHash });
      if (opts.publish !== false) {
        // storage, anchor, index and receipt run after the episode, off the control path; the dashboard sees each result
        void publishEpisode(log, (meta) => sse.send("meta", meta), zbChain ? () => zbChain : undefined, { devicePrivateKey: deviceWallet.privateKey, ...(opts.skipStorage ? { skipStorage: true } : {}) })
          .catch((e) => console.error("publish failed:", e));
      }
      await opts.onEpisodeClosed?.(log);
    },
  });

  // zerobot: the arm's on-chain identity and command queue on 0G Galileo (0G track, owner decision 4 Nov 2026)
  const zbCfg = zerobotConfigFromEnv();
  const zbChain: ZerobotChain | null =
    opts.zerobot !== undefined ? opts.zerobot
      : zerobotFromEnv();
  const zbOperator = zbChain
    ? new ZerobotOperator({
        chain: zbChain,
        busy: () => orch.busy,
        startEpisode: (task, origin) => {
          if (!monitor.linkAlive()) throw new Error("arm not connected");
          const r = orch.start(task, { ...origin });
          sse.send("zerobot", { nonce: origin.nonce, sender: origin.sender, episodeId: r.episodeId });
          return r;
        },
        log: (line) => {
          console.log(line);
          sse.send("zerobot", { line });
        },
      })
    : null;

  // live stream: telemetry at most 10 Hz to the browser, every device event, every log record, every status change
  let lastTelSent = 0;
  monitor.onAny((m) => {
    if (m.t === "tel") {
      if (m.ms - lastTelSent < 100) return;
      lastTelSent = m.ms;
      sse.send("tel", { ...m, status: STATUS_TABLE[m.state], scene: sceneNow() });
    } else {
      sse.send("device", m);
    }
  });
  orch.on((ev) => sse.send(ev.type, ev.type === "status" ? ev.status : ev.record));
  device.onParseError?.((e) => {
    sse.send("device", { t: "parse_error", ...e });
    orch.noteDeviceEvent("parse_error", e);
  });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "64kb" }));

  const state = () => ({
    deviceId: deviceIdNow,
    deviceAddress: deviceWallet.address,
    device: monitor.lastTel,
    deviceKind: device.kind,
    status: monitor.lastTel ? STATUS_TABLE[monitor.lastTel.state] : null,
    handClear: monitor.handClear,
    hardTrip: monitor.hardTrip,
    orchestrator: orch.status(),
    scene: sceneNow(),
    cameraKind: camera.kind,
    cut0g,
    heartbeatPaused: heartbeat.isPaused,
    modules: {
      ogChainAnchor: process.env.OG_CHAIN_ANCHOR ?? "on",
      indexArkiv: process.env.INDEX_ARKIV ?? "on",
      robotZerobot: zbChain ? "on" : process.env.ROBOT_ZEROBOT === "off" ? "off" : "not_configured",
    },
  });

  app.get("/api/state", (_req, res) => {
    res.json(state());
  });
  app.get("/api/stream", sse.handler);

  app.post("/api/episode/start", (req: Request, res: Response) => {
    const task = parseTask(req.body);
    if (typeof task === "string") {
      res.status(400).json({ error: task });
      return;
    }
    if (!monitor.linkAlive()) {
      // never start an episode whose first move would go to an arm that is not listening
      res.status(409).json({ error: "arm not connected: no telemetry in the last second" });
      return;
    }
    try {
      const { episodeId } = orch.start(task);
      res.status(202).json({ episodeId });
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  app.post("/api/control/stop", (_req, res) => {
    orch.requestStop();
    res.json({ ok: true });
  });
  app.post("/api/control/safe", (_req, res) => {
    device.send({ cmd: "safe" });
    res.json({ ok: true });
  });
  app.post("/api/control/reset", (_req, res) => {
    // on hardware this only arms the reset; the operator must also press the BOOT button within 10 s
    device.send({ cmd: "reset" });
    heartbeat.setPaused(false);
    sim?.restoreHeartbeat();
    monitor.clearTrip();
    res.json({ ok: true, note: sim || mj ? "sim: button press implied" : "press the BOOT button on the arm within 10 s" });
  });

  // Cut 0G: the Router base URL becomes an unroutable address, so the real failure path runs (timeout → failsafe)
  app.post("/api/control/cut0g", (req: Request, res: Response) => {
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== "boolean") {
      res.status(400).json({ error: "body must be {on: true|false}" });
      return;
    }
    cut0g = on;
    sse.send("cut0g", { on });
    res.json({ ok: true, cut0g });
  });

  app.post("/api/sim/inject", async (req: Request, res: Response) => {
    if (!sim && !mj) {
      res.status(404).json({ error: "fault injection exists only with DEVICE=sim or DEVICE=mujoco" });
      return;
    }
    const kind = (req.body as { kind?: string } | undefined)?.kind;
    const ms = Number((req.body as { ms?: number }).ms ?? 2500);
    try {
      if (kind === "hand") await (sim ? sim.injectHand(ms) : mj!.injectHand(ms));
      else if (kind === "bump") await (sim ? sim.injectBump() : mj!.injectBump());
      else if (kind === "nohb") heartbeat.setPaused(true);
      else {
        res.status(400).json({ error: 'kind must be "hand", "bump" or "nohb"' });
        return;
      }
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
      return;
    }
    res.json({ ok: true, kind });
  });

  // zerobot: robot identity, and "Start via zerobot" (dispatches RUN_EPISODE on 0G Chain; the operator loop runs it)
  app.get("/api/zerobot", async (_req, res) => {
    if (!zbChain) {
      res.json({
        status: envFlag("ROBOT_ZEROBOT", "on") ? "not_configured" : "off",
        missing: `${ZEROBOT_MISSING}, then pnpm zerobot:register`,
      });
      return;
    }
    try {
      const robot = await zbChain.robot();
      res.json({
        status: robot ? "ok" : "not_registered",
        robotId: zbChain.robotId,
        robot,
        operator: zbChain.address,
        registry: zbCfg.registry,
        dispatcher: zbCfg.dispatcher,
      });
    } catch (e) {
      res.status(502).json({ status: "failed", error: errMsg(e) });
    }
  });
  app.post("/api/zerobot/dispatch", async (req: Request, res: Response) => {
    if (!zbChain) {
      res.status(404).json({ error: "zerobot is off or not configured" });
      return;
    }
    const task = parseTask(req.body);
    if (typeof task === "string") {
      res.status(400).json({ error: task });
      return;
    }
    try {
      const params = JSON.stringify({ color: task.color, from: task.from });
      const r = await zbChain.dispatch(API_RUN_EPISODE, params, `pick ${task.color} ${task.from}`);
      res.status(202).json({ ...r, link: txLink(zbCfg, r.txHash), note: `command #${r.nonce} on 0G Chain; the arm picks it up within a few seconds` });
      void zbOperator?.poll();
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  app.post("/api/sim/reset-table", async (_req: Request, res: Response) => {
    if (!mj) {
      res.status(404).json({ error: "table reset exists only with DEVICE=mujoco" });
      return;
    }
    try {
      await mj.resetTable();
      res.json({ ok: true, note: "cubes back on their posts" });
    } catch (e) {
      res.status(409).json({ error: errMsg(e) });
    }
  });

  // live camera view for the dashboard (the same source the decisions use); 404 when there is no camera
  app.get("/api/camera/live.jpg", async (_req, res) => {
    if (camera.kind === "none") {
      res.status(404).json({ error: "no camera (CAMERA_SOURCE=none)" });
      return;
    }
    try {
      const f = await camera.capture("LIVE");
      if (!f) throw new Error("no frame");
      res.set("Cache-Control", "no-store").type("image/jpeg").send(Buffer.from(f.bytes));
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
    }
  });

  const localList = () =>
    listEpisodeIds().slice(0, 100).map((id) => {
      try {
        const e = readEpisode(id);
        return { episodeId: id, outcome: e.outcome, startedAt: e.startedAt, n: e.records.length, headHash: e.headHash, armId: e.armId };
      } catch {
        return { episodeId: id, error: "unreadable" };
      }
    });

  // robot linking (R6): the device signs ONLY the fixed link text for an account, proving the dashboard holds this robot.
  // On hardware the firmware asks for a BOOT-button press before signing; the simulated arm signs directly.
  app.post("/api/link", async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { accountId?: unknown; nonce?: unknown };
    if (typeof b.accountId !== "string" || !/^[0-9a-f]{32}$/.test(b.accountId) || typeof b.nonce !== "string" || !/^[0-9a-f]{32}$/.test(b.nonce)) {
      res.status(400).json({ error: "body must be {accountId: 32 hex, nonce: 32 hex}" });
      return;
    }
    const signature = await deviceWallet.signMessage(linkMessage(b.accountId, b.nonce));
    res.json({ address: deviceWallet.address, deviceId: deviceIdNow, signature });
  });

  // the device's own episode list (its local memory); the dashboard reads the public index on Arkiv
  app.get("/api/episodes", (req, res) => {
    const armId = typeof req.query.armId === "string" ? req.query.armId : "";
    let items = localList();
    if (armId) items = items.filter((i) => !("armId" in i) || i.armId === armId);
    res.json({ source: "device", items });
  });
  app.get("/api/episodes/:id", (req, res) => {
    try {
      res.json(readEpisode(req.params.id));
    } catch {
      res.status(404).json({ error: "not found" });
    }
  });

  // a camera frame of a decision: from 0G Storage by its recorded root when possible, else the local copy (labelled)
  app.get("/api/frames/:id/:idx", async (req, res) => {
    let log: EpisodeLog;
    try {
      log = readEpisode(req.params.id);
    } catch {
      res.status(404).json({ error: "not found" });
      return;
    }
    const rec = log.records.find((r) => r.idx === Number(req.params.idx));
    if (!rec || rec.kind !== "decision" || !rec.frameRoot) {
      res.status(404).json({ error: "no frame for this record" });
      return;
    }
    try {
      const bytes = await downloadBytes(storageConfigFromEnv(), rec.frameRoot);
      res.setHeader("X-Frame-Source", "0g-storage");
      res.type("image/jpeg").send(Buffer.from(bytes));
    } catch {
      try {
        const bytes = readFileSync(framePath(log.episodeId, rec.idx));
        res.setHeader("X-Frame-Source", "local");
        res.type("image/jpeg").send(bytes);
      } catch {
        res.status(404).json({ error: "frame not available" });
      }
    }
  });

  app.get("/api/episodes/:id/meta", (req, res) => {
    res.json(readMeta(req.params.id));
  });

  return {
    app,
    device,
    monitor,
    heartbeat,
    orch,
    sse,
    sim,
    mj,
    setCut0g(v: boolean) {
      cut0g = v;
    },
    zerobot: zbOperator,
    deviceAddress: deviceWallet.address,
    async startDevice() {
      await device.connect();
      heartbeat.start();
      await zbOperator?.start();
    },
    async stop() {
      zbOperator?.stop();
      heartbeat.stop();
      await device.close();
    },
  };
}
