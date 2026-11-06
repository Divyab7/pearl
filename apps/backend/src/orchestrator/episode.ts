/**
 * Episode orchestrator (prompt §8.3). One episode at a time:
 *   PLANNING → MOVING_TO_PICK → VERIFYING_GRASP → MOVING_TO_PLACE → VERIFYING_PLACE → DONE
 * with side states INCIDENT_DECIDING, FAILSAFE_STOPPED, TRIPPED, ABORTED.
 * (World ID is not in the arm's loop: since rev 5 it gates reward claims in the dashboard, not restarts.)
 * At every checkpoint the host sends `hold`, so the arm is stationary while 0G decides; heartbeats keep flowing.
 * Every 0G decision and every device event during the episode goes into the hash-chained log.
 */
import { randomBytes } from "node:crypto";
import { headMessage, type DeviceSigner } from "../shared/deviceKey.js";
import type { CameraSource } from "../camera/index.js";
import type { ArmDevice } from "../device/ArmDevice.js";
import type { DeviceMonitor } from "../device/monitor.js";
import type { SceneState } from "../device/scene.js";
import type { RouterConfig } from "../og/router.js";
import { systemPrompt } from "../og/prompts.js";
import type { ArmConfig } from "../shared/armConfig.js";
import { hashCanonical, sha256Hex } from "../shared/hash.js";
import type { Checkpoint, ChainedRecord, DeviceMsg, EpisodeLog, EpisodeOutcome, TaskSpec } from "../shared/types.js";
import { decide, failsafeDecision, type DecisionCore } from "./decision.js";
import { EpisodeRecorder, framePath, sealedPath, writeEpisode } from "./log.js";
import { localRoot } from "../og/storage.js";
import { RobotKeys } from "../shared/runKeys.js";
import { lockFrame, sealEpisode, sealedBytes, type SealedEpisode } from "../shared/seal.js";
import { incidentOf } from "../og/anchor.js";
import { zerobotOriginOf } from "./pipeline.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  commandsOf,
  policyIncident,
  policyPlan,
  policyVerifyGrasp,
  policyVerifyPlace,
  type PolicyResult,
} from "./policy.js";
import { Poses, type Step } from "./poses.js";
import { errMsg } from "../shared/util.js";

export type OrchPhase =
  | "IDLE"
  | "PLANNING"
  | "MOVING_TO_PICK"
  | "VERIFYING_GRASP"
  | "MOVING_TO_PLACE"
  | "VERIFYING_PLACE"
  | "INCIDENT_DECIDING"
  | "DONE"
  | "ABORTED"
  | "FAILSAFE_STOPPED"
  | "TRIPPED";

const OUTCOME_PHASE: Record<EpisodeOutcome, OrchPhase> = {
  DONE: "DONE",
  ABORTED: "ABORTED",
  FAILSAFE: "FAILSAFE_STOPPED",
  TRIPPED: "TRIPPED",
};

const HAND_WAIT_MS = 15_000;
const MOVE_TIMEOUT_MS = 20_000;
const SAFE_TIMEOUT_MS = 20_000;

export interface OrchestratorDeps {
  device: ArmDevice;
  monitor: DeviceMonitor;
  arm: ArmConfig;
  camera: CameraSource;
  armId: string;
  deviceId: string;
  routerConfig: () => RouterConfig;
  scene?: () => SceneState | null;
  /**
   * Called with every closed episode and its sealed (locked) copy; app.ts publishes the sealed copy here (0G Storage,
   * 0G Chain anchor, Arkiv). `sealed` is null only without a device signer (unit tests).
   */
  onEpisodeClosed?: (log: EpisodeLog, sealed: SealedEpisode | null) => Promise<void> | void;
  /** The device's own key: signs every closed log's head (rev 5, device-first). */
  deviceSigner?: DeviceSigner;
  fetchImpl?: typeof fetch;
  writeFiles?: boolean;
  /** The robot's key memory: a fresh run key per episode locks its frames and, after close, its log. */
  keys?: RobotKeys;
}

export interface OrchStatus {
  phase: OrchPhase;
  episodeId: string | null;
  task: TaskSpec | null;
  outcome: EpisodeOutcome | null;
  records: number;
  lastDecision: Pick<DecisionCore, "checkpoint" | "source" | "requestId" | "error"> | null;
}

type Listener = (ev: { type: "status"; status: OrchStatus } | { type: "record"; record: ChainedRecord }) => void;

type StepRun = { ok: true } | { ok: false; interruptedAt: number } | { ok: false; error: string };

class StopRequested extends Error {}

export class Orchestrator {
  private phase: OrchPhase = "IDLE";
  private rec: EpisodeRecorder | null = null;
  private task: TaskSpec | null = null;
  private outcome: EpisodeOutcome | null = null;
  private lastDecision: OrchStatus["lastDecision"] = null;
  private running: Promise<EpisodeLog> | null = null;
  private stopRequested = false;
  private cmdSeq = 0;
  private callSeq = 0;
  private readonly poses: Poses;
  private listeners: Listener[] = [];
  private runKey: Uint8Array | null = null;
  readonly keys: RobotKeys;

  constructor(private readonly deps: OrchestratorDeps) {
    this.poses = new Poses(deps.arm);
    this.keys = deps.keys ?? new RobotKeys(deps.deviceId, deps.writeFiles !== false);
    deps.monitor.onAny((m) => this.onDeviceMsg(m));
  }

  on(cb: Listener): void {
    this.listeners.push(cb);
  }

  status(): OrchStatus {
    return {
      phase: this.phase,
      episodeId: this.rec?.episodeId ?? null,
      task: this.task,
      outcome: this.outcome,
      records: this.rec?.length ?? 0,
      lastDecision: this.lastDecision,
    };
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * Starts an episode in the background; resolves with its id once the first record is written.
   * `origin` says who asked for the episode (e.g. a zerobot command on 0G Chain); it is recorded in episode_start.
   */
  start(task: TaskSpec, origin?: Record<string, unknown>): { episodeId: string; done: Promise<EpisodeLog> } {
    if (this.running) throw new Error("an episode is already running");
    const st = this.deps.monitor.state;
    if (st === "TRIPPED") throw new Error("device is TRIPPED: operator reset required");
    if (st === "FROZEN_HAND") throw new Error("device is FROZEN_HAND: clear the zone first");
    const episodeId = `ep_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(2).toString("hex")}`;
    this.rec = new EpisodeRecorder(episodeId, this.deps.deviceId, this.deps.armId, task);
    this.runKey = this.keys.createRunKey(episodeId);
    this.task = task;
    this.outcome = null;
    this.lastDecision = null;
    this.stopRequested = false;
    this.callSeq = 0;
    this.deps.monitor.takeSafety();
    this.event("episode_start", { task, deviceState: st, armConfigHash: hashCanonical(this.deps.arm), ...(origin ? { origin } : {}) });
    const done = this.run().finally(() => {
      this.running = null;
    });
    this.running = done;
    return { episodeId, done };
  }

  /** Operator stop: recorded as an operator event, then the arm is sent to SAFE. */
  requestStop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.event("operator_stop", {});
    this.deps.device.send({ cmd: "safe" });
    this.deps.monitor.cancelAll("operator stop");
  }

  // ------------------------------------------------------------------
  private async run(): Promise<EpisodeLog> {
    const task = this.task!;
    try {
      // Leave SAFE/WAITING from a previous episode: part of the operator's start action, logged above.
      if (this.deps.monitor.state === "SAFE" || this.deps.monitor.state === "WAITING") {
        this.deps.device.send({ cmd: "resume" });
        await this.deps.monitor.waitFor((t) => t.state === "IDLE", 2000);
      }

      // PLAN
      let p = await this.checkpointAndPolicy("PLAN", (d) => policyPlan(d, task, this.poses));
      if (p.next === "END") return await this.finish(p);
      if (!(await this.runPhase("MOVING_TO_PICK", p.steps))) return await this.closeFromIncident();

      // VERIFY_GRASP (max 1 retry)
      let graspRetries = 0;
      for (;;) {
        p = await this.checkpointAndPolicy("VERIFY_GRASP", (d) => policyVerifyGrasp(d, task, this.poses, graspRetries), {
          graspRetriesUsed: graspRetries,
        });
        if (p.next === "END") return await this.finish(p);
        const phase = p.next === "VERIFY_GRASP" ? "MOVING_TO_PICK" : "MOVING_TO_PLACE";
        if (p.next === "VERIFY_GRASP") graspRetries++;
        if (!(await this.runPhase(phase, p.steps))) return await this.closeFromIncident();
        if (p.next === "VERIFY_PLACE") break;
      }

      // VERIFY_PLACE (max 1 retry)
      let placeRetries = 0;
      for (;;) {
        p = await this.checkpointAndPolicy("VERIFY_PLACE", (d) => policyVerifyPlace(d, this.poses, placeRetries), {
          placeRetriesUsed: placeRetries,
        });
        if (p.next === "END") return await this.finish(p);
        placeRetries++;
        if (!(await this.runPhase("MOVING_TO_PLACE", p.steps))) return await this.closeFromIncident();
      }
    } catch (e) {
      if (e instanceof StopRequested) return await this.closeWith("ABORTED");
      this.event("host_error", { error: errMsg(e) });
      this.deps.device.send({ cmd: "safe" });
      return await this.closeWith("ABORTED");
    }
  }

  private incidentOutcome: EpisodeOutcome | null = null;

  /**
   * Runs steps; on a safety interruption runs the INCIDENT checkpoint and, if 0G RESUMEs (and policy allows), re-sends
   * the interrupted steps. Returns false when the episode must end (outcome stored in incidentOutcome).
   */
  private async runPhase(phase: OrchPhase, steps: Step[]): Promise<boolean> {
    let todo = steps;
    for (;;) {
      this.setPhase(phase);
      const r = this.deps.monitor.peekSafety() ? { ok: false as const, interruptedAt: 0 } : await this.runSteps(todo);
      if (r.ok) return true;
      if ("error" in r) {
        this.event("host_error", { error: r.error });
        this.deps.device.send({ cmd: "safe" });
        this.incidentOutcome = "ABORTED";
        return false;
      }
      const remaining = todo.slice(r.interruptedAt);
      const p = await this.incident(remaining);
      if (p.next !== "CONTINUE_INTERRUPTED") {
        await this.execEnd(p);
        this.incidentOutcome = p.outcome;
        return false;
      }
      todo = p.steps; // ["resume", ...remaining]
    }
  }

  private async incident(remaining: Step[]): Promise<PolicyResult> {
    const mon = this.deps.monitor;
    mon.takeSafety();
    this.setPhase("INCIDENT_DECIDING");
    if (!mon.hardTrip) {
      // ask 0G once the zone is clear (or a trip happens, or the wait times out)
      await mon.waitHandClearOrTrip(HAND_WAIT_MS);
    }
    mon.takeSafety();
    const ctxSnapshot = {
      hardTrip: mon.hardTrip,
      frozenHand: mon.state === "FROZEN_HAND",
      handClear: mon.handClear,
      remaining,
    };
    return this.checkpointAndPolicy(
      "INCIDENT",
      (d) => policyIncident(d, ctxSnapshot),
      { event: mon.lastSafety, handClear: ctxSnapshot.handClear, hardTrip: ctxSnapshot.hardTrip },
    );
  }

  private async closeFromIncident(): Promise<EpisodeLog> {
    return this.closeWith(this.incidentOutcome ?? "ABORTED");
  }

  private async finish(p: PolicyResult): Promise<EpisodeLog> {
    await this.execEnd(p);
    return this.closeWith(p.outcome ?? "ABORTED");
  }

  private async execEnd(p: PolicyResult): Promise<void> {
    if (p.steps.length) await this.runSteps(p.steps, true);
  }

  private async closeWith(outcome: EpisodeOutcome): Promise<EpisodeLog> {
    this.outcome = outcome;
    this.event("episode_end", { outcome });
    const log = this.rec!.close(outcome);
    if (this.deps.deviceSigner) {
      const signer = this.deps.deviceSigner;
      log.device = { address: signer.address, signature: await signer.sign(headMessage(log.episodeId, log.headHash)) };
    }
    // lock the log with this run's key; the public header carries only what 0G Chain and Arkiv already show
    const origin = zerobotOriginOf(log);
    // the owner's copy of the run key travels inside the locked file: readable by the owner from 0G Storage alone
    const ownerWrap = log.device ? await this.keys.wrapForOwner(log.device.address, log.episodeId).catch(() => null) : null;
    const sealed = log.device
      ? await sealEpisode(log, this.runKey!, { ...incidentOf(log), origin: origin ? { kind: "zerobot", ...origin } : null, ...(ownerWrap ? { keys: [ownerWrap] } : {}) })
      : null;
    this.setPhase(OUTCOME_PHASE[outcome]);
    if (this.deps.writeFiles !== false) {
      writeEpisode(log); // the robot's own memory
      if (sealed) writeFileSync(sealedPath(log.episodeId), sealedBytes(sealed));
    }
    try {
      await this.deps.onEpisodeClosed?.(log, sealed);
    } catch (e) {
      console.error("onEpisodeClosed failed:", e);
    }
    return log;
  }

  // ------------------------------------------------------------------
  private async checkpointAndPolicy(
    cp: Checkpoint,
    policy: (d: DecisionCore) => PolicyResult,
    extraContext: Record<string, unknown> = {},
  ): Promise<PolicyResult> {
    if (this.stopRequested) throw new StopRequested();
    const mon = this.deps.monitor;
    if (mon.state === "IDLE" || mon.state === "MOVING") this.deps.device.send({ cmd: "hold" });
    this.setPhase(cp === "PLAN" ? "PLANNING" : cp === "INCIDENT" ? "INCIDENT_DECIDING" : cp === "VERIFY_GRASP" ? "VERIFYING_GRASP" : "VERIFYING_PLACE");

    const tel = mon.lastTel;
    const telemetry = {
      state: tel?.state ?? "UNKNOWN",
      joints: tel?.joints ?? [],
      tofMm: tel?.tofMm ?? -1,
      accG: tel?.accG ?? -1,
    };
    const sp = systemPrompt(cp);
    const cfg = this.deps.routerConfig();
    const clientRequestId = `${this.rec!.episodeId}:${this.callSeq++}:${cp}`;

    let frame: Awaited<ReturnType<CameraSource["capture"]>> = null;
    let frameError: string | null = null;
    try {
      frame = await this.deps.camera.capture(cp);
    } catch (e) {
      frameError = `camera: ${errMsg(e)}`;
    }
    const scene = this.deps.camera.kind === "none" ? (this.deps.scene?.() ?? null) : null;
    const ts = new Date().toISOString();

    let d: DecisionCore;
    if (frameError) {
      // a configured camera that gives no frame is treated as a 0G failure (prompt §8.2)
      d = failsafeDecision(cp, clientRequestId, frameError);
    } else {
      d = await decide(
        cfg,
        {
          checkpoint: cp,
          systemPrompt: sp.text,
          context: { task: this.task, telemetry, ...(scene ? { scene } : {}), ...extraContext },
          imageDataUrl: frame?.dataUrl ?? null,
          clientRequestId,
        },
        this.deps.fetchImpl,
      );
    }
    const p = policy(d);
    const frameRoot = frame ? await this.keepFrame(frame.bytes) : null;
    const rec = this.rec!.addDecision({
      ...d,
      ts,
      promptHash: sp.hash,
      frameHash: frame ? sha256Hex(frame.bytes) : null,
      frameRoot,
      telemetry,
      policy: p.policy,
      override: p.override,
      commandsSent: commandsOf(p.steps),
    });
    this.lastDecision = { checkpoint: cp, source: d.source, requestId: d.requestId, error: d.error };
    this.emit({ type: "record", record: rec });
    if (p.fileClaim) {
      const sev = (d.parsed as { severity?: number } | null)?.severity ?? null;
      this.event("claim_requested", { checkpoint: cp, requestId: d.requestId, severity: sev });
    }
    return p;
  }

  /**
   * Locks a checkpoint frame with this run's key, saves the locked file next to the log and returns ITS 0G Storage
   * root, computed offline now (same bytes → same root); the locked file is uploaded after the episode. The record
   * also keeps the sha256 of the unlocked JPEG, so a key holder can check the frame after unlocking it.
   */
  private async keepFrame(bytes: Uint8Array): Promise<string> {
    const locked = await lockFrame(this.runKey!, bytes);
    if (this.deps.writeFiles !== false) {
      const p = framePath(this.rec!.episodeId, this.rec!.nextIdx);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, locked);
    }
    return localRoot(locked);
  }

  /** Executes steps in order. Stops at the first safety interruption (returns its index) or refusal. */
  private async runSteps(steps: Step[], endOfEpisode = false): Promise<StepRun> {
    const mon = this.deps.monitor;
    const dev = this.deps.device;
    for (let i = 0; i < steps.length; i++) {
      if (this.stopRequested && !endOfEpisode) throw new StopRequested();
      const s = steps[i]!;
      if (s.kind === "safe") {
        dev.send({ cmd: "safe" });
        const safe = this.deps.arm.safe;
        // done when the arm reports SAFE at the safe pose; a tripped arm refuses `safe` and stays where it is
        await mon.waitFor(
          (t) => (t.state === "SAFE" && t.joints.every((j, k) => j === safe[k])) || t.state === "TRIPPED",
          SAFE_TIMEOUT_MS,
          false,
        );
        continue;
      }
      if (s.kind === "resume") {
        dev.send({ cmd: "resume" });
        const ok = await mon.waitFor((t) => t.state === "IDLE", 2000, !endOfEpisode);
        if (!ok && !endOfEpisode) {
          if (mon.peekSafety()) return { ok: false, interruptedAt: i };
          return { ok: false, error: `device did not leave ${mon.state} on resume` };
        }
        continue;
      }
      const id = `m${++this.cmdSeq}`;
      const wait = mon.awaitCommand(id, MOVE_TIMEOUT_MS);
      if (s.kind === "move") dev.send({ cmd: "move", id, joints: s.joints });
      else dev.send({ cmd: "grip", id, close: s.close });
      const o = await wait;
      if (this.stopRequested && !endOfEpisode) throw new StopRequested();
      if (o.ok) continue;
      if (o.reason === "interrupted") return { ok: false, interruptedAt: i };
      if (mon.peekSafety()) return { ok: false, interruptedAt: i };
      return { ok: false, error: `${s.kind} ${id}: ${o.reason}` };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------
  private onDeviceMsg(m: DeviceMsg): void {
    if (!this.running || !this.rec) return;
    if (m.t === "event") {
      const { t: _t, ev, ...data } = m;
      this.event(ev, data);
    } else if (m.t === "nack") {
      const { t: _t, ...data } = m;
      this.event("nack", data);
    }
  }

  /** Records a host-side device event (e.g. parse_error) in the running episode's log. */
  noteDeviceEvent(ev: string, data: Record<string, unknown>): void {
    if (this.running) this.event(ev, data);
  }

  private event(ev: string, data: Record<string, unknown>): void {
    if (!this.rec) return;
    try {
      const rec = this.rec.addEvent({ ts: new Date().toISOString(), ev, data: JSON.parse(JSON.stringify(data ?? {})) });
      this.emit({ type: "record", record: rec });
    } catch {
      // recorder closed (late device message after episode end): ignore
    }
  }

  private setPhase(p: OrchPhase): void {
    this.phase = p;
    this.emit({ type: "status", status: this.status() });
  }

  private emit(ev: Parameters<Listener>[0]): void {
    for (const l of this.listeners) l(ev);
  }
}
