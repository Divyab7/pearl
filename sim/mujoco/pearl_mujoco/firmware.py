"""
The arm's on-board logic, ported line for line from the ESP32 firmware rules (prompt §7.4) and the TypeScript
SimArm (apps/backend/src/device/SimArm.ts). It holds no physics: the MuJoCo world feeds it real sensor readings
(rangefinder distance, accelerometer magnitude) every control tick, and it returns the servo ramp positions the
world's position actuators must follow.

Rules, all thresholds from config/arm.json:
  - hand in the ToF zone while MOVING/WAITING -> FROZEN_HAND (hold position); leaves only after the zone has been
    clear for handClearMs AND the host sends `resume`;
  - |accel - 1 g| > bumpG -> TRIPPED, frozen in place (never move after a collision);
  - no heartbeat for heartbeatTimeoutMs (any state but BOOT) -> TRIPPED and ramp to the SAFE pose;
  - TRIPPED clears only on `reset` + the reset button (pressed automatically in sim, PLAN §4.3);
  - `move` is refused in FROZEN_HAND / TRIPPED / SAFE (nack state), while MOVING (nack busy), and outside joint
    limits (nack limit, no motion at all).
Motion ramps at maxDegPerS, one joint at a time in [base, shoulder, elbow, gripper] order.
"""
from __future__ import annotations

import json
from typing import Callable, Dict, List, Optional

MAX_LINE_BYTES = 512
RESET_WINDOW_MS = 10_000

Emit = Callable[[dict], None]


class Firmware:
    def __init__(self, cfg: dict, emit: Emit, device_id: str = "mujoco-arm-01", auto_reset_button: bool = True):
        self.cfg = cfg
        self.emit = emit
        self.device_id = device_id
        self.auto_reset_button = auto_reset_button
        self.now = 0.0
        self.state = "BOOT"
        self.pos: List[float] = [float(x) for x in cfg["home"]]
        self.target: List[float] = [float(x) for x in cfg["home"]]
        self.pending_id: Optional[str] = None
        self.last_hb_at = 0.0
        self.clear_since: Optional[float] = None
        self.hand_clear = False
        self.trip_reason: Optional[str] = None
        self.reset_armed_until = -1.0
        self.next_tel_at = 0.0
        self.tof_mm = 2000
        self.acc_g = 1.0

    # ---------------- lifecycle ----------------
    def boot(self) -> None:
        """Sensors initialised (always true in sim): say hello and go IDLE."""
        self.emit({"t": "hello", "fw": "pearl-mujoco-0.1", "deviceId": self.device_id, "joints": self.joints()})
        self.last_hb_at = self.now
        self.state = "IDLE"

    def joints(self) -> List[int]:
        return [int(round(d)) for d in self.pos]

    def hb_age_ms(self) -> int:
        return max(0, int(round(self.now - self.last_hb_at)))

    # ---------------- one control tick ----------------
    def tick(self, dt_ms: float, tof_mm: int, acc_g: float) -> None:
        """Advance the clock, read sensors, run safety before motion, emit telemetry at telemetryHz."""
        self.now += dt_ms
        self.tof_mm = int(tof_mm)
        self.acc_g = float(acc_g)
        self._safety()
        self._motion(dt_ms)
        if self.now >= self.next_tel_at:
            period = 1000.0 / self.cfg["telemetryHz"]
            self.next_tel_at += period
            if self.next_tel_at <= self.now:
                self.next_tel_at = self.now + period
            self.emit({
                "t": "tel",
                "ms": int(round(self.now)),
                "state": self.state,
                "joints": self.joints(),
                "target": [int(round(d)) for d in self.target],
                "tofMm": self.tof_mm,
                "accG": round(self.acc_g, 3),
                "hbAgeMs": self.hb_age_ms(),
            })

    def _safety(self) -> None:
        if self.state == "BOOT":
            return
        cfg = self.cfg
        # bump: freeze in place, even if already tripped by the watchdog
        if abs(self.acc_g - 1.0) > cfg["bumpG"] and self.trip_reason != "bump":
            self._freeze()
            self.trip_reason = "bump"
            self.state = "TRIPPED"
            self.emit({"t": "event", "ev": "trip_bump", "accG": round(self.acc_g, 3)})
            return
        # heartbeat watchdog: trip and ramp to SAFE (unless a collision already froze the arm)
        if self.hb_age_ms() > cfg["heartbeatTimeoutMs"] and self.state != "TRIPPED":
            self.pending_id = None
            self.trip_reason = "watchdog"
            self.state = "TRIPPED"
            self.target = [float(x) for x in cfg["safe"]]
            self.emit({"t": "event", "ev": "trip_watchdog", "hbAgeMs": self.hb_age_ms()})
            return
        # hand in zone
        in_zone = self.tof_mm < cfg["handZoneMm"]
        if self.state in ("MOVING", "WAITING"):
            if in_zone:
                self._freeze()
                self.state = "FROZEN_HAND"
                self.clear_since = None
                self.hand_clear = False
                self.emit({"t": "event", "ev": "hand_in_zone", "tofMm": self.tof_mm})
        elif self.state == "FROZEN_HAND":
            if in_zone:
                if self.clear_since is not None:
                    self.emit({"t": "event", "ev": "hand_in_zone", "tofMm": self.tof_mm})
                self.clear_since = None
                self.hand_clear = False
            else:
                if self.clear_since is None:
                    self.clear_since = self.now
                if not self.hand_clear and self.now - self.clear_since >= cfg["handClearMs"]:
                    self.hand_clear = True
                    self.emit({"t": "event", "ev": "hand_clear"})

    def _motion(self, dt_ms: float) -> None:
        if self.state == "FROZEN_HAND" or (self.state == "TRIPPED" and self.trip_reason == "bump"):
            return
        budget = self.cfg["maxDegPerS"] * dt_ms / 1000.0
        for i in range(4):
            if budget <= 0:
                break
            d = self.target[i] - self.pos[i]
            if d == 0:
                continue
            step = min(abs(d), budget)
            self.pos[i] += step if d > 0 else -step
            budget -= step
            if abs(self.target[i] - self.pos[i]) > 1e-9:
                break  # one joint at a time
            self.pos[i] = self.target[i]
        if self.state == "MOVING" and self._at_target():
            self.state = "IDLE"
            pid, self.pending_id = self.pending_id, None
            if pid:
                self.emit({"t": "done", "id": pid})

    # ---------------- commands ----------------
    def receive_line(self, line: str) -> None:
        line = line.rstrip("\r")
        if not line.strip():
            return
        if len(line.encode("utf-8")) > MAX_LINE_BYTES:
            return self.emit({"t": "nack", "reason": "parse"})
        try:
            cmd = json.loads(line)
        except ValueError:
            return self.emit({"t": "nack", "reason": "parse"})
        err = _validate(cmd)
        if err:
            cid = cmd.get("id") if isinstance(cmd, dict) else None
            return self.emit({"t": "nack", "id": cid, "reason": "parse"} if isinstance(cid, str) else {"t": "nack", "reason": "parse"})
        self._handle(cmd)

    def _handle(self, cmd: Dict) -> None:
        c = cmd["cmd"]
        cfg = self.cfg
        if c == "hb":
            self.last_hb_at = self.now
        elif c == "i2c_scan":
            self.emit({"t": "i2c", "addrs": ["0x29", "0x40", "0x68"]})
        elif c == "move":
            self._start_move(cmd["id"], cmd["joints"])
        elif c == "grip":
            g = cfg["gripClosed"] if cmd["close"] else cfg["gripOpen"]
            j = self.joints()
            self._start_move(cmd["id"], [j[0], j[1], j[2], g])
        elif c == "hold":
            if self.state in ("IDLE", "MOVING"):
                self._freeze()
                self.state = "WAITING"
            elif self.state != "WAITING":
                self.emit({"t": "nack", "reason": "state"})
        elif c == "resume":
            self._resume()
        elif c == "safe":
            if self.state == "TRIPPED":
                return self.emit({"t": "nack", "reason": "state"})
            self._enter_safe()
        elif c == "reset":
            if self.state != "TRIPPED":
                return self.emit({"t": "nack", "reason": "state"})
            self.reset_armed_until = self.now + RESET_WINDOW_MS
            self.emit({"t": "event", "ev": "reset_armed"})
            if self.auto_reset_button:
                self.press_reset_button()
        elif c == "cal":
            if self.state != "IDLE":
                self.emit({"t": "nack", "reason": "state"})

    def press_reset_button(self) -> None:
        if self.state != "TRIPPED" or self.now > self.reset_armed_until:
            return
        self.reset_armed_until = -1
        self.trip_reason = None
        self.last_hb_at = self.now
        self.emit({"t": "event", "ev": "reset_done"})
        self._enter_safe()

    def _start_move(self, cid: str, joints: List[int]) -> None:
        if self.state == "MOVING":
            return self.emit({"t": "nack", "id": cid, "reason": "busy"})
        if self.state not in ("IDLE", "WAITING"):
            return self.emit({"t": "nack", "id": cid, "reason": "state"})
        for i in range(4):
            if joints[i] < self.cfg["jointMinDeg"][i] or joints[i] > self.cfg["jointMaxDeg"][i]:
                return self.emit({"t": "nack", "id": cid, "reason": "limit"})
        self.target = [float(x) for x in joints]
        self.pending_id = cid
        self.state = "MOVING"
        self.emit({"t": "ack", "id": cid})
        if self._at_target():
            self._motion(0)

    def _resume(self) -> None:
        if self.state == "FROZEN_HAND":
            if not self.hand_clear:
                return self.emit({"t": "nack", "reason": "state"})
            self.state = "IDLE"
        elif self.state == "WAITING":
            self.state = "IDLE"
        elif self.state == "SAFE":
            if not self._at_target():
                return self.emit({"t": "nack", "reason": "busy"})
            self.state = "IDLE"
        else:
            self.emit({"t": "nack", "reason": "state"})

    def _enter_safe(self) -> None:
        self.pending_id = None
        self.state = "SAFE"
        self.target = [float(x) for x in self.cfg["safe"]]

    def _freeze(self) -> None:
        self.pending_id = None
        self.target = list(self.pos)

    def _at_target(self) -> bool:
        return all(abs(t - p) < 1e-9 for t, p in zip(self.target, self.pos))


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _validate(cmd) -> Optional[str]:
    """Strict check of a host command, same rules as HostCmdSchema (unknown keys rejected)."""
    if not isinstance(cmd, dict) or not isinstance(cmd.get("cmd"), str):
        return "no cmd"
    c = cmd["cmd"]
    keys = set(cmd.keys())

    def only(*allowed: str) -> bool:
        return keys == {"cmd", *allowed}

    def ok_id() -> bool:
        return isinstance(cmd.get("id"), str) and 1 <= len(cmd["id"]) <= 32

    if c == "hb":
        return None if only("seq") and _is_int(cmd["seq"]) and cmd["seq"] >= 0 else "hb"
    if c == "move":
        j = cmd.get("joints")
        good = only("id", "joints") and ok_id() and isinstance(j, list) and len(j) == 4 and all(_is_int(x) and 0 <= x <= 180 for x in j)
        return None if good else "move"
    if c == "grip":
        return None if only("id", "close") and ok_id() and isinstance(cmd["close"], bool) else "grip"
    if c in ("hold", "resume", "safe", "reset", "i2c_scan"):
        return None if only() else c
    if c == "cal":
        good = only("ch", "us") and _is_int(cmd["ch"]) and 0 <= cmd["ch"] <= 15 and _is_int(cmd["us"]) and 500 <= cmd["us"] <= 2500
        return None if good else "cal"
    return "unknown cmd"
