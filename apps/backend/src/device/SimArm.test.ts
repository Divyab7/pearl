import { beforeEach, describe, expect, it } from "vitest";
import { loadArmConfig } from "../shared/armConfig.js";
import { DeviceMsgSchema } from "../shared/schemas.js";
import type { DeviceMsg } from "../shared/types.js";
import { SimArm } from "./SimArm.js";

const cfg = loadArmConfig();
const TICK = 20;

let arm: SimArm;
let msgs: DeviceMsg[];
let hbSeq = 0;

async function make(opts: ConstructorParameters<typeof SimArm>[1] = {}) {
  arm = new SimArm(cfg, { manualClock: true, ...opts });
  msgs = [];
  arm.on("msg", (m) => msgs.push(m));
  await arm.connect();
}

/** Advance simulated time, sending heartbeats every 500 ms unless told not to. */
function run(ms: number, heartbeat = true) {
  let since = 0;
  for (let t = 0; t < ms; t += TICK) {
    if (heartbeat && since <= 0) {
      arm.send({ cmd: "hb", seq: hbSeq++ });
      since = cfg.heartbeatIntervalMs;
    }
    arm.tick(TICK);
    since -= TICK;
  }
}

const events = () => msgs.filter((m) => m.t === "event").map((m) => (m as { ev: string }).ev);
const last = <T extends DeviceMsg["t"]>(t: T) =>
  msgs.filter((m) => m.t === t).at(-1) as Extract<DeviceMsg, { t: T }> | undefined;
const moveTime = (from: readonly number[], to: readonly number[]) =>
  (from.reduce((s, d, i) => s + Math.abs(d - to[i]!), 0) / cfg.maxDegPerS) * 1000;

describe("SimArm", () => {
  beforeEach(async () => {
    await make();
  });

  it("says hello and goes IDLE on connect", () => {
    expect(msgs[0]).toMatchObject({ t: "hello", joints: cfg.home });
    expect(arm.getState()).toBe("IDLE");
  });

  it("moves one joint at a time at the configured speed, then reports done", () => {
    const target: [number, number, number, number] = [120, 100, 80, 10];
    arm.send({ cmd: "move", id: "m1", joints: target });
    expect(last("ack")).toEqual({ t: "ack", id: "m1" });
    expect(arm.getState()).toBe("MOVING");
    run(250); // base needs 500 ms for 30°; shoulder must not have moved yet
    const mid = arm.joints();
    expect(mid[0]).toBeGreaterThan(90);
    expect(mid[0]).toBeLessThan(120);
    expect(mid[1]).toBe(90);
    run(moveTime(cfg.home, target) + 100);
    expect(arm.joints()).toEqual(target);
    expect(last("done")).toEqual({ t: "done", id: "m1" });
    expect(arm.getState()).toBe("IDLE");
  });

  it("refuses a pose outside the joint limits without moving", () => {
    arm.send({ cmd: "move", id: "m2", joints: [5, 90, 90, 10] });
    expect(last("nack")).toEqual({ t: "nack", id: "m2", reason: "limit" });
    run(500);
    expect(arm.joints()).toEqual(cfg.home);
    expect(arm.getState()).toBe("IDLE");
  });

  it("refuses a second move while moving", () => {
    arm.send({ cmd: "move", id: "a", joints: [150, 90, 90, 10] });
    arm.send({ cmd: "move", id: "b", joints: [60, 90, 90, 10] });
    expect(last("nack")).toEqual({ t: "nack", id: "b", reason: "busy" });
  });

  it("hand in zone while moving → FROZEN_HAND; resume only after the zone is clear", () => {
    arm.send({ cmd: "move", id: "m3", joints: [150, 90, 90, 10] });
    run(200);
    arm.injectHand(400);
    run(TICK);
    expect(arm.getState()).toBe("FROZEN_HAND");
    expect(events()).toContain("hand_in_zone");
    const frozenAt = arm.joints();
    run(300);
    expect(arm.joints()).toEqual(frozenAt); // holds position
    arm.send({ cmd: "resume" });
    expect(last("nack")).toEqual({ t: "nack", reason: "state" }); // not clear yet
    run(cfg.handClearMs + 200);
    expect(events()).toContain("hand_clear");
    arm.send({ cmd: "move", id: "m4", joints: [90, 90, 90, 10] });
    expect(last("nack")).toEqual({ t: "nack", id: "m4", reason: "state" }); // still frozen until resume
    arm.send({ cmd: "resume" });
    expect(arm.getState()).toBe("IDLE");
    expect(msgs.some((m) => m.t === "done" && m.id === "m3")).toBe(false); // interrupted move never reports done
  });

  it("a hand while IDLE does nothing", () => {
    arm.injectHand(300);
    run(100);
    expect(arm.getState()).toBe("IDLE");
    expect(events()).not.toContain("hand_in_zone");
  });

  it("bump → TRIPPED, frozen in place, every command but reset refused", () => {
    arm.send({ cmd: "move", id: "m5", joints: [150, 90, 90, 10] });
    run(200);
    arm.injectBump();
    run(TICK);
    expect(arm.getState()).toBe("TRIPPED");
    expect(events()).toContain("trip_bump");
    const at = arm.joints();
    run(2000);
    expect(arm.joints()).toEqual(at); // never moves after a collision
    arm.send({ cmd: "move", id: "m6", joints: [90, 90, 90, 10] });
    expect(last("nack")).toEqual({ t: "nack", id: "m6", reason: "state" });
    arm.send({ cmd: "safe" });
    expect(last("nack")).toEqual({ t: "nack", reason: "state" });
    arm.send({ cmd: "resume" });
    expect(last("nack")).toEqual({ t: "nack", reason: "state" });
  });

  it("no heartbeat for 3 s → TRIPPED (watchdog) and ramps to the SAFE pose", () => {
    run(cfg.heartbeatTimeoutMs - 200, false);
    expect(arm.getState()).toBe("IDLE");
    run(400, false);
    expect(arm.getState()).toBe("TRIPPED");
    const ev = msgs.find((m) => m.t === "event" && m.ev === "trip_watchdog") as { hbAgeMs: number };
    expect(ev.hbAgeMs).toBeGreaterThan(cfg.heartbeatTimeoutMs);
    run(moveTime(cfg.home, cfg.safe) + 200, false);
    expect(arm.joints()).toEqual(cfg.safe);
  });

  it("a dead link (heartbeats sent but not received) also trips", () => {
    arm.stopHeartbeatReply();
    run(cfg.heartbeatTimeoutMs + 200);
    expect(arm.getState()).toBe("TRIPPED");
  });

  it("reset after a trip: reset_armed → reset_done → SAFE pose → IDLE on resume", () => {
    arm.injectBump();
    run(TICK);
    arm.send({ cmd: "reset" });
    expect(events().slice(-2)).toEqual(["reset_armed", "reset_done"]);
    expect(arm.getState()).toBe("SAFE");
    arm.send({ cmd: "resume" });
    expect(last("nack")).toEqual({ t: "nack", reason: "busy" }); // still ramping
    run(moveTime(cfg.home, cfg.safe) + 200);
    expect(arm.joints()).toEqual(cfg.safe);
    arm.send({ cmd: "resume" });
    expect(arm.getState()).toBe("IDLE");
  });

  it("without the button press (hardware), reset only arms", async () => {
    await make({ autoResetButton: false });
    arm.injectBump();
    run(TICK);
    arm.send({ cmd: "reset" });
    expect(events().at(-1)).toBe("reset_armed");
    expect(arm.getState()).toBe("TRIPPED");
    arm.pressResetButton();
    expect(arm.getState()).toBe("SAFE");
  });

  it("hold → WAITING; a move from WAITING is accepted", () => {
    arm.send({ cmd: "hold" });
    expect(arm.getState()).toBe("WAITING");
    arm.send({ cmd: "move", id: "m7", joints: [100, 90, 90, 10] });
    expect(arm.getState()).toBe("MOVING");
  });

  it("safe command ramps to the SAFE pose", () => {
    arm.send({ cmd: "safe" });
    expect(arm.getState()).toBe("SAFE");
    run(moveTime(cfg.home, cfg.safe) + 200);
    expect(arm.joints()).toEqual(cfg.safe);
  });

  it("bad lines get nack parse", () => {
    arm.sendLine("{not json");
    expect(last("nack")).toEqual({ t: "nack", reason: "parse" });
    arm.sendLine(JSON.stringify({ cmd: "move", id: "x", joints: [1, 2] }));
    expect(last("nack")).toEqual({ t: "nack", id: "x", reason: "parse" });
    arm.sendLine("x".repeat(600));
    expect(last("nack")).toEqual({ t: "nack", reason: "parse" });
  });

  it("emits telemetry at 20 Hz and every message passes the protocol schema", () => {
    run(1000);
    const tel = msgs.filter((m) => m.t === "tel").length;
    expect(tel).toBeGreaterThanOrEqual(19);
    expect(tel).toBeLessThanOrEqual(21);
    arm.injectHand(100);
    arm.send({ cmd: "i2c_scan" });
    arm.injectBump();
    run(200);
    for (const m of msgs) expect(DeviceMsgSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
});

describe("scene follows the arm", () => {
  async function pickAndPlace(failRate: number) {
    await make({ graspFailRate: failRate, rng: () => 0.5 });
    const go = (id: string, j: readonly number[]) => {
      arm.send({ cmd: "move", id, joints: j as [number, number, number, number] });
      run(4000);
      expect(last("done")).toEqual({ t: "done", id });
    };
    go("1", cfg.slots.A2.above);
    go("2", cfg.slots.A2.down);
    arm.send({ cmd: "grip", id: "3", close: true });
    run(2000);
    // slot poses store the gripper open; when carrying, keep it closed (the orchestrator does the same in S6)
    go("4", [...cfg.slots.A2.above.slice(0, 3), cfg.gripClosed]);
    go("5", cfg.slots.BIN.above);
    arm.send({ cmd: "grip", id: "6", close: false });
    run(2000);
    return arm.scene.snapshot();
  }

  it("picks the red cube at A2 and drops it in the bin", async () => {
    const s = await pickAndPlace(0);
    expect(s.slots.A2).toBeNull();
    expect(s.bin).toEqual(["red"]);
    expect(s.holding).toBeNull();
  });

  it("a failed grasp leaves the cube in its slot", async () => {
    const s = await pickAndPlace(1);
    expect(s.slots.A2).toBe("red");
    expect(s.bin).toEqual([]);
  });
});
