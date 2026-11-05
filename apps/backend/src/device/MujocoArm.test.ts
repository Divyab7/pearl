import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { DeviceMsg } from "../shared/types.js";
import { MujocoArm } from "./MujocoArm.js";

const PORT = 18_431;
let arm: MujocoArm | null = null;

afterEach(async () => {
  await arm?.close();
  arm = null;
});

function fakeBridge(calls: string[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u.replace("http://bridge", "")}`);
    if (u.endsWith("/scene")) {
      return new Response(JSON.stringify({ slots: { A1: null, A2: "red", A3: "blue" }, bin: [], table: [], claw: "open", holding: null }));
    }
    return new Response('{"ok":true}');
  }) as typeof fetch;
}

describe("MujocoArm (DEVICE=mujoco)", () => {
  it("speaks the ESP32 line protocol with the bridge over WebSocket", async () => {
    arm = new MujocoArm(PORT, "http://bridge", fakeBridge([]));
    const got: DeviceMsg[] = [];
    arm.on("msg", (m) => got.push(m));
    await arm.connect();
    const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const sent: string[] = [];
    client.on("message", (d) => sent.push(d.toString()));
    await new Promise((r) => client.once("open", r));
    client.send('{"t":"hello","fw":"pearl-mujoco-0.1","deviceId":"mujoco-arm-01","joints":[90,90,90,10]}');
    client.send('{"t":"tel","ms":20,"state":"IDLE","joints":[90,90,90,10],"target":[90,90,90,10],"tofMm":2000,"accG":1.0,"hbAgeMs":3}');
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.t)).toEqual(["hello", "tel"]);
    arm.send({ cmd: "move", id: "m1", joints: [60, 100, 80, 10] });
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(sent[0]!)).toEqual({ cmd: "move", id: "m1", joints: [60, 100, 80, 10] });
    client.close();
  });

  it("drops lines that break the protocol", async () => {
    arm = new MujocoArm(PORT, "http://bridge", fakeBridge([]));
    const errors: string[] = [];
    arm.onParseError((e) => errors.push(e.error));
    await arm.connect();
    const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((r) => client.once("open", r));
    client.send('{"t":"tel","ms":1,"state":"IDLE","joints":[90,90,90,10],"target":[90,90,90,10],"tofMm":2000,"accG":1,"hbAgeMs":0,"extra":1}');
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.length).toBe(1);
    client.close();
  });

  it("reads the scene and forwards fault injection and table reset to the bridge", async () => {
    const calls: string[] = [];
    arm = new MujocoArm(PORT, "http://bridge", fakeBridge(calls));
    expect(arm.frameUrl).toBe("http://bridge/frame.jpg");
    await arm.refreshScene();
    expect(arm.scene()?.slots.A2).toBe("red");
    await arm.injectHand(2500);
    await arm.injectBump();
    await arm.resetTable();
    expect(calls).toEqual(["GET /scene", "POST /inject/hand?ms=2500", "POST /inject/bump", "POST /reset-table"]);
  });

  it("shows no scene when the bridge is down (never a stale one)", async () => {
    arm = new MujocoArm(PORT, "http://bridge", fakeBridge([]));
    await arm.refreshScene();
    expect(arm.scene()).not.toBeNull();
    (arm as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await arm.refreshScene();
    expect(arm.scene()).toBeNull();
  });
});
