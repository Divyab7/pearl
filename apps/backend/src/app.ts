/**
 * The DEVICE program (rev 5, device-first): the virtual ESP32 in sim, and the same role the firmware takes on hardware.
 * It runs the arm, the safety loop, the 0G decisions and the hash-chained log, and with its OWN key it uploads to 0G
 * Storage, anchors on 0G Chain and writes Arkiv. It serves a read-only status feed plus operator requests it may refuse.
 * Verification, accounts and claims live in the dashboard server (src/dashboard/server.ts), never here.
 * Express 5 API: https://expressjs.com/en/5x/api.html
 */
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
import { framePath, listEpisodeIds, sealedPath } from "./orchestrator/log.js";
import { existsSync, readFileSync } from "node:fs";
import { headerOf, isPublicJwk, keyId, parseSealed, type SealedEpisode } from "./shared/seal.js";
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
import { RobotRelay } from "./relay/robot.js";
import { discoverRelay } from "./relay/mdns.js";
import { galileoRpc } from "./og/config.js";
import { httpJsonRpc } from "./relay/rpc.js";

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
  onEpisodeClosed?: (log: EpisodeLog, sealed: SealedEpisode | null) => Promise<void> | void;
  /** Offline relay overrides (tests): how the robot finds the laptop relay, checks its internet, reaches the chains. */
  relay?: Partial<Pick<import("./relay/robot.js").RobotRelayDeps, "discover" | "online" | "fetchImpl" | "rpc" | "submitDeps" | "pollMs" | "pollTimeoutMs" | "cacheDir" | "outbox">>;
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

  // offline relay: the sim/mujoco drill can cut the robot's internet; otherwise "online" = Galileo answers quickly
  let netOnline = true;
  const probe = httpJsonRpc(opts.relay?.fetchImpl ?? fetch, 3000);
  const relay = new RobotRelay({
    wallet: deviceWallet,
    online: async () => {
      if (!netOnline) return false;
      if (opts.relay?.online) return opts.relay.online();
      return probe(galileoRpc(), "eth_chainId").then(() => true, () => false);
    },
    discover: opts.relay?.discover ?? (() => discoverRelay()),
    notify: (m) => sse.send("meta", m),
    ...(opts.relay?.fetchImpl ? { fetchImpl: opts.relay.fetchImpl } : {}),
    ...(opts.relay?.rpc ? { rpc: opts.relay.rpc } : {}),
    ...(opts.relay?.submitDeps ? { submitDeps: opts.relay.submitDeps } : {}),
    ...(opts.relay?.pollMs !== undefined ? { pollMs: opts.relay.pollMs } : {}),
    ...(opts.relay?.pollTimeoutMs !== undefined ? { pollTimeoutMs: opts.relay.pollTimeoutMs } : {}),
    ...(opts.relay?.cacheDir ? { cacheDir: opts.relay.cacheDir } : {}),
    ...(opts.relay?.outbox ? { outbox: opts.relay.outbox } : {}),
  });

  const orch = new Orchestrator({
    deviceSigner: signerFor(deviceWallet),
    device,
    monitor,
    arm,
    camera,
    armId: process.env.ARM_ID ?? "arm-1",
    deviceId: deviceIdNow,
    routerConfig: () =>
      // Cut 0G: one call to the blackhole, no model fallback (every fallback would hit the same blackhole)
      routerConfigFromEnv(cut0g ? { baseUrl: process.env.OG_BLACKHOLE_URL ?? "http://10.255.255.1", fallbackModels: [], allowStandardFallback: false } : {}),
    scene: sceneNow,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.writeFiles !== undefined ? { writeFiles: opts.writeFiles } : {}),
    onEpisodeClosed: async (log, sealed) => {
      sse.send("episode", { episodeId: log.episodeId, outcome: log.outcome, headHash: log.headHash });
      if (opts.publish !== false && sealed) {
        // storage, anchor, index and receipt run after the episode, off the control path; the dashboard sees each result
        void publishEpisode(log, sealed, (meta) => sse.send("meta", meta), zbChain ? () => zbChain : undefined, { devicePrivateKey: deviceWallet.privateKey, relay, ...(opts.skipStorage ? { skipStorage: true } : {}) })
          .catch((e) => console.error("publish failed:", e));
      }
      await opts.onEpisodeClosed?.(log, sealed);
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
  // no CORS: only the dashboard server (server-side) talks to the robot program
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
    net: netOnline ? "online" : "offline",
    outbox: { pending: relay.pending() },
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

  // drill: cut or restore the robot's internet (sim/mujoco only). Offline runs are packed into relay bundles; on
  // reconnect the robot flushes its outbox itself before any new direct publish.
  app.post("/api/sim/net", (req: Request, res: Response) => {
    if (!sim && !mj) {
      res.status(404).json({ error: "the internet drill exists only with DEVICE=sim or DEVICE=mujoco" });
      return;
    }
    const online = (req.body as { online?: unknown } | undefined)?.online;
    if (typeof online !== "boolean") {
      res.status(400).json({ error: "body must be {online: true|false}" });
      return;
    }
    netOnline = online;
    sse.send("net", { net: online ? "online" : "offline" });
    void relay.deliver().catch((e) => console.error("outbox:", errMsg(e)));
    res.json({ ok: true, net: online ? "online" : "offline", outbox: { pending: relay.pending() } });
  });
  app.get("/api/outbox", (_req, res) => {
    res.json({
      items: relay.outbox.list().map((e) => ({ bundleId: e.bundleId, episodeId: e.episodeId, state: e.state, via: e.via, relayUrl: e.relayUrl ?? null, error: e.error ?? null, createdAt: e.createdAt, updatedAt: e.updatedAt })),
    });
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

  // MuJoCo only: a free orbit view people can rotate (az/el/dist); decisions never use it
  app.get("/api/camera/view.jpg", async (req, res) => {
    if (!mj) {
      res.status(404).json({ error: "the orbit view exists only with DEVICE=mujoco" });
      return;
    }
    const n = (k: string, lo: number, hi: number, d: number) => {
      const v = Number((req.query as Record<string, unknown>)[k]);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    };
    try {
      const r = await fetch(`${mj.bridgeUrl}/view.jpg?az=${n("az", -720, 720, 150)}&el=${n("el", -89, -5, -32)}&dist=${n("dist", 0.2, 1.5, 0.55)}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`bridge ${r.status}`);
      res.set("Cache-Control", "no-store").type("image/jpeg").send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: errMsg(e) });
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

  // the robot serves only LOCKED runs (owner decision 5–6 Nov 2026): the public header, never the log itself
  const readSealedFile = (id: string): SealedEpisode | null => {
    try {
      const p = sealedPath(id);
      return existsSync(p) ? parseSealed(readFileSync(p)) : null;
    } catch {
      return null;
    }
  };
  const localList = () =>
    listEpisodeIds().slice(0, 100).map((id) => {
      const s = readSealedFile(id);
      if (!s) return { episodeId: id, locked: false, note: "recorded before locking; not served" };
      const h = headerOf(s);
      return {
        episodeId: id, locked: true, armId: h.armId, kind: h.incident ? "incident" : "episode", outcome: h.outcome,
        severity: h.severity, ts: Date.parse(h.endedAt), headHash: h.headHash, device: h.device.address,
      };
    });

  // robot linking (R6): the device signs ONLY the fixed link text for an account and its owner key, proving the dashboard
  // holds this robot, and from then on locks every run key for that owner key.
  // On hardware the firmware asks for a BOOT-button press before signing; the simulated arm signs directly.
  app.post("/api/link", async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { accountId?: unknown; nonce?: unknown; ownerKey?: unknown };
    if (typeof b.accountId !== "string" || !/^[0-9a-f]{32}$/.test(b.accountId) || typeof b.nonce !== "string" || !/^[0-9a-f]{32}$/.test(b.nonce)) {
      res.status(400).json({ error: "body must be {accountId: 32 hex, nonce: 32 hex, ownerKey: P-256 public JWK}" });
      return;
    }
    if (!isPublicJwk(b.ownerKey)) {
      res.status(400).json({ error: "ownerKey must be the owner's P-256 public key (JWK)" });
      return;
    }
    const kid = keyId(b.ownerKey);
    const signature = await deviceWallet.signMessage(linkMessage(b.accountId, b.nonce, kid));
    orch.keys.setOwner(b.accountId, b.ownerKey);
    res.json({ address: deviceWallet.address, deviceId: deviceIdNow, ownerKid: kid, signature });
  });

  // the device's own episode list (labels only); the dashboard reads the public index on Arkiv
  app.get("/api/episodes", (req, res) => {
    const armId = typeof req.query.armId === "string" ? req.query.armId : "";
    let items = localList();
    if (armId) items = items.filter((i) => !("armId" in i) || i.armId === armId);
    res.json({ source: "device", items });
  });
  app.get("/api/episodes/:id", (req, res) => {
    const s = readSealedFile(String(req.params.id));
    if (s) res.json(s);
    else res.status(404).json({ error: "no locked copy of this run on the robot" });
  });

  // this run's key, locked for the linked owner's key (useless to anyone else)
  app.get("/api/episodes/:id/key", async (req, res) => {
    const id = String(req.params.id);
    if (!orch.keys.owner()) {
      res.status(409).json({ error: "no owner linked yet: link the robot to your account first" });
      return;
    }
    const w = await orch.keys.wrapForOwner(deviceWallet.address, id).catch(() => null);
    if (w) res.json(w);
    else res.status(404).json({ error: "the robot has no key for this run" });
  });

  // a LOCKED camera frame of a decision, by the root recorded in the log: from 0G Storage, else the robot's copy
  app.get("/api/frames/:id/:idx", async (req, res) => {
    const id = String(req.params.id);
    const idx = Number(req.params.idx);
    const root = typeof req.query.root === "string" && /^0x[0-9a-f]{64}$/.test(req.query.root) ? req.query.root : null;
    if (root) {
      try {
        const bytes = await downloadBytes(storageConfigFromEnv(), root);
        res.setHeader("X-Frame-Source", "0g-storage");
        res.type("application/octet-stream").send(Buffer.from(bytes));
        return;
      } catch {
        // fall through to the robot's copy
      }
    }
    try {
      if (!/^ep_[A-Za-z0-9_-]+$/.test(id) || !Number.isInteger(idx)) throw new Error("bad id");
      const bytes = readFileSync(framePath(id, idx));
      res.setHeader("X-Frame-Source", "robot");
      res.type("application/octet-stream").send(bytes);
    } catch {
      res.status(404).json({ error: "frame not available" });
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
    relay,
    setNetOnline(v: boolean) {
      netOnline = v;
    },
    async startDevice() {
      await device.connect();
      heartbeat.start();
      // retry loop for bundles waiting for a carrier; when online, prime the pre-sign cache and flush leftovers
      if (opts.publish !== false && !opts.skipStorage) {
        relay.start();
        void relay.online().then(async (on) => {
          if (!on) return;
          await relay.refresh().catch(() => {});
          await relay.flush().catch(() => {});
        });
      }
      await zbOperator?.start();
    },
    async stop() {
      relay.stop();
      zbOperator?.stop();
      heartbeat.stop();
      await device.close();
    },
  };
}
