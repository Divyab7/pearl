"""
MuJoCo arm bridge: runs the physics world in real time and connects to the backend exactly like the Wi-Fi ESP32
(DEVICE=mujoco on the backend, which is DEVICE=ws plus this bridge's camera and fault-injection endpoints).

  WebSocket client -> ws://127.0.0.1:8081   newline-JSON protocol, same lines as the firmware (prompt §7.5)
  HTTP server      -> http://127.0.0.1:8092
      GET  /frame.jpg      a fresh 640x480 render of the table camera (CAMERA_URL for the backend)
      GET  /scene          tabletop state as JSON (cube positions read from the physics)
      GET  /health         {"ok": true, ...}
      POST /inject/hand?ms=2500   the operator's hand enters the ToF beam
      POST /inject/bump           a knock on the arm's base
      POST /reset-table           the operator puts the cubes back on their posts (refused while one is held)

Run:  sim/mujoco/.venv/bin/python -m pearl_mujoco.bridge [--ws ws://127.0.0.1:8081] [--http-port 8092] [--view]
--view opens MuJoCo's 3D viewer next to the run (on macOS start it with .venv/bin/mjpython instead of python).
Physics, rendering and networking share one thread (asyncio), so the GL context is only touched from that thread.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Optional
from urllib.parse import parse_qs, urlparse

import websockets

from .firmware import Firmware
from .world import World

TICK_MS = 20.0  # 50 Hz control loop, like the firmware's loop()


class Bridge:
    def __init__(self, ws_url: str, http_port: int, device_id: str, viewer=None):
        self.world = World()
        self.ws_url = ws_url
        self.http_port = http_port
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.outbox: "Optional[asyncio.Queue[str]]" = None  # created inside the running loop (Python 3.9)
        self.fw = Firmware(self.world.cfg, self._emit, device_id=device_id)
        self.booted = False
        self.viewer = viewer

    def _emit(self, msg: dict) -> None:
        line = json.dumps(msg, separators=(",", ":"))
        if self.ws is not None and self.outbox is not None:
            self.outbox.put_nowait(line)

    # ---------------- physics loop ----------------
    async def physics(self) -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(TICK_MS / 1000.0)
            now = time.perf_counter()
            elapsed = min(200.0, (now - last) * 1000.0)  # never try to catch up more than 200 ms
            last = now
            while elapsed >= 1.0:
                dt = min(TICK_MS, elapsed)
                elapsed -= dt
                self.world.set_servos(self.fw.pos)
                g = self.world.step(dt)
                if self.booted:
                    self.fw.tick(dt, self.world.tof_mm(), g)
            if self.viewer is not None and self.viewer.is_running():
                self.viewer.sync()

    # ---------------- WebSocket link to the backend ----------------
    async def link(self) -> None:
        backoff = 0.5
        while True:
            try:
                async with websockets.connect(self.ws_url, max_size=4096) as ws:
                    print(f"[mujoco] connected to {self.ws_url}", flush=True)
                    self.ws = ws
                    backoff = 0.5
                    while not self.outbox.empty():
                        self.outbox.get_nowait()
                    if not self.booted:
                        self.fw.boot()
                        self.booted = True
                    else:
                        self._emit({"t": "hello", "fw": "pearl-mujoco-0.1", "deviceId": self.fw.device_id, "joints": self.fw.joints()})
                    sender = asyncio.ensure_future(self._send_loop(ws))
                    try:
                        async for data in ws:
                            text = data.decode() if isinstance(data, bytes) else data
                            for line in text.split("\n"):
                                self.fw.receive_line(line)
                    finally:
                        sender.cancel()
            except (OSError, websockets.WebSocketException) as e:
                if self.ws is not None:
                    print(f"[mujoco] link lost: {e}", flush=True)
            self.ws = None
            await asyncio.sleep(backoff)
            backoff = min(1.0, backoff * 2)  # the backend is local: keep retrying quickly

    async def _send_loop(self, ws) -> None:
        while True:
            line = await self.outbox.get()
            await ws.send(line)

    # ---------------- HTTP: camera, scene, injection ----------------
    async def http(self) -> None:
        server = await asyncio.start_server(self._handle_http, "127.0.0.1", self.http_port)
        print(f"[mujoco] camera and controls on http://127.0.0.1:{self.http_port}", flush=True)
        async with server:
            await server.serve_forever()

    async def _handle_http(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            method, target, _ = head.split(b"\r\n", 1)[0].decode().split(" ", 2)
            url = urlparse(target)
            q = parse_qs(url.query)
            status, ctype, body = 404, "application/json", b'{"error":"not found"}'
            if method == "GET" and url.path == "/frame.jpg":
                status, ctype, body = 200, "image/jpeg", self.world.render_jpeg()
            elif method == "GET" and url.path == "/scene":
                status, body = 200, json.dumps(self.world.scene()).encode()
            elif method == "GET" and url.path == "/health":
                body = json.dumps({"ok": True, "linked": self.ws is not None, "state": self.fw.state, "simMs": round(self.world.ms)}).encode()
                status = 200
            elif method == "POST" and url.path == "/inject/hand":
                ms = float(q.get("ms", ["2500"])[0])
                self.world.inject_hand(max(0.0, min(60_000.0, ms)))
                status, body = 200, json.dumps({"ok": True, "kind": "hand", "ms": ms}).encode()
            elif method == "POST" and url.path == "/reset-table":
                ok = self.world.reset_table()
                status, body = (200, b'{"ok":true}') if ok else (409, b'{"error":"the gripper is holding a cube"}')
            elif method == "POST" and url.path == "/inject/bump":
                self.world.inject_bump()
                status, body = 200, b'{"ok":true,"kind":"bump"}'
            reason = {200: "OK", 404: "Not Found", 409: "Conflict"}[status]
            writer.write(
                f"HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                f"Cache-Control: no-store\r\nConnection: close\r\n\r\n".encode() + body
            )
            await writer.drain()
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError, ConnectionError):
            pass
        finally:
            writer.close()

    async def run(self) -> None:
        self.outbox = asyncio.Queue()
        await asyncio.gather(self.physics(), self.link(), self.http())


def main() -> None:
    ap = argparse.ArgumentParser(description="MuJoCo arm bridge for Pearl")
    ap.add_argument("--ws", default="ws://127.0.0.1:8081", help="backend WebSocket (WS_PORT)")
    ap.add_argument("--http-port", type=int, default=8092)
    ap.add_argument("--device-id", default="mujoco-arm-01")
    ap.add_argument("--view", action="store_true", help="open the MuJoCo 3D viewer (macOS: run with mjpython)")
    a = ap.parse_args()
    viewer = None
    if a.view:
        import mujoco.viewer

        bridge = Bridge(a.ws, a.http_port, a.device_id)
        viewer = mujoco.viewer.launch_passive(bridge.world.model, bridge.world.data)
        bridge.viewer = viewer
    else:
        bridge = Bridge(a.ws, a.http_port, a.device_id)
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
