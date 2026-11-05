import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { fileCamera, httpCamera } from "../camera/index.js";
import type { DeviceMsg } from "../shared/types.js";
import { encodeCmd, LineHub } from "./lineProtocol.js";
import { WsArm } from "./WsArm.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe("line protocol", () => {
  it("accepts valid device lines and reports bad ones", () => {
    const hub = new LineHub();
    const msgs: DeviceMsg[] = [];
    const errs: string[] = [];
    hub.onMsg((m) => msgs.push(m));
    hub.onError((e) => errs.push(e.error));
    hub.receive('{"t":"ack","id":"m1"}\r');
    hub.receive("");
    hub.receive("garbage");
    hub.receive('{"t":"tel","state":"FLYING"}');
    hub.receive(`{"t":"ack","id":"${"x".repeat(600)}"}`);
    expect(msgs).toEqual([{ t: "ack", id: "m1" }]);
    expect(errs).toHaveLength(3);
    expect(errs[0]).toBe("not JSON");
    expect(encodeCmd({ cmd: "hb", seq: 1 })).toBe('{"cmd":"hb","seq":1}\n');
  });
});

describe("WsArm", () => {
  it("talks to an ESP32-like WebSocket client both ways", async () => {
    const arm = new WsArm(18081);
    await arm.connect();
    const got: DeviceMsg[] = [];
    const bad: string[] = [];
    arm.on("msg", (m) => got.push(m));
    arm.onParseError((e) => bad.push(e.error));
    const client = new WebSocket("ws://127.0.0.1:18081");
    const fromHost: string[] = [];
    client.on("message", (d) => fromHost.push(d.toString()));
    await new Promise((r) => client.once("open", r));
    client.send('{"t":"hello","fw":"pearl-arm-0.2","deviceId":"esp32-s3-01","joints":[90,90,90,10]}');
    client.send("not json");
    await new Promise((r) => setTimeout(r, 100));
    arm.send({ cmd: "move", id: "m1", joints: [90, 100, 80, 10] });
    await new Promise((r) => setTimeout(r, 100));
    client.close();
    await arm.close();
    expect(got[0]).toMatchObject({ t: "hello", deviceId: "esp32-s3-01" });
    expect(bad).toEqual(["not JSON"]);
    expect(fromHost).toEqual(['{"cmd":"move","id":"m1","joints":[90,100,80,10]}']);
  });
});

describe("camera sources", () => {
  it("http: fetches a fresh JPEG each time and refuses non-JPEG or errors", async () => {
    let n = 0;
    const urls: string[] = [];
    const server = createServer((req, res) => {
      urls.push(req.url ?? "");
      n++;
      if (n === 3) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>");
      } else if (n === 4) {
        res.writeHead(503);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(Buffer.from(JPEG));
      }
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    const cam = httpCamera(`http://127.0.0.1:${(server.address() as AddressInfo).port}/shot.jpg`);
    const f = await cam.capture("PLAN");
    expect(f!.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    await cam.capture("PLAN");
    await expect(cam.capture("PLAN")).rejects.toThrow(/not a JPEG/);
    await expect(cam.capture("PLAN")).rejects.toThrow(/HTTP 503/);
    server.close();
    expect(new Set(urls).size).toBe(urls.length); // every request is distinct (no cached frame)
  });

  it("file: reads fixtures/frames/<checkpoint>.jpg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-frames-"));
    writeFileSync(join(dir, "verify_grasp.jpg"), JPEG);
    const f = await fileCamera(dir).capture("VERIFY_GRASP");
    expect(f!.bytes).toEqual(JPEG);
    await expect(fileCamera(dir).capture("PLAN")).rejects.toThrow();
  });
});
