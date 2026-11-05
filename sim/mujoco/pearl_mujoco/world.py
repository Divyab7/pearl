"""
The MuJoCo world: physics, sensors, fault injection, scene reading and camera frames.

The firmware logic decides where each servo should be; the world turns that into actuator targets, steps the physics
and reads the sensors back: the rangefinder (VL53L0X stand-in) and the base accelerometer (MPU6050 stand-in). The
cubes move only by contact and friction with the gripper; nothing is teleported or welded.
Python bindings: https://mujoco.readthedocs.io/en/stable/python.html
"""
from __future__ import annotations

import io
import math
from typing import Dict, List, Optional

import mujoco
import numpy as np

from .model import BIN_HALF, CUBE, build_xml, load_arm_config, servo_to_qpos

G = 9.81
TOF_MAX_MM = 2000  # VL53L0X useful range; no target in range reads as this
HAND_ABOVE_TOF_M = 0.08
BUMP_FORCE_N = 80.0
BUMP_MS = 10.0


class World:
    def __init__(self, cfg: Optional[dict] = None, colours: Optional[Dict[str, Optional[str]]] = None):
        self.cfg = cfg or load_arm_config()
        xml, self.layout = build_xml(self.cfg, colours)
        self.model = mujoco.MjModel.from_xml_string(xml)
        self.data = mujoco.MjData(self.model)
        m = self.model
        self._act = [m.actuator(n).id for n in ("a_base", "a_shoulder", "a_elbow", "a_finger_l", "a_finger_r")]
        self._jq = [m.joint(n).qposadr[0] for n in ("j_base", "j_shoulder", "j_elbow", "j_finger_l", "j_finger_r")]
        self._mount = m.body("mount").id
        self._hand_mocap = m.body("op_hand").mocapid[0]
        self._acc_adr = m.sensor("acc").adr[0]
        self._tof_adr = m.sensor("tof").adr[0]
        self._finger_geoms = {m.geom("finger_l").id, m.geom("finger_r").id}
        self._cube_geoms = {c: m.geom(f"cube_{c}").id for c in self.layout["cubes"]}
        self._cube_bodies = {c: m.body(f"cube_{c}").id for c in self.layout["cubes"]}
        self._cube_q0 = {c: (m.body(f"cube_{c}").jntadr[0], None) for c in self.layout["cubes"]}
        self._hand_until_ms = -1.0
        self._bump_until_ms = -1.0
        self._renderer: Optional[mujoco.Renderer] = None
        self.grip_closed = False
        # start with the arm at home, settled
        self.set_servos(self.cfg["home"], snap=True)
        mujoco.mj_forward(m, self.data)
        self._cube_q0 = {c: (j, self.data.qpos[m.jnt_qposadr[j] : m.jnt_qposadr[j] + 7].copy()) for c, (j, _) in self._cube_q0.items()}
        self.step(300)

    # ---------------- time ----------------
    @property
    def ms(self) -> float:
        return self.data.time * 1000.0

    def set_servos(self, deg: List[float], snap: bool = False) -> None:
        """Servo targets in degrees -> actuator targets; snap=True also teleports the joints (initial pose only)."""
        q = servo_to_qpos(self.cfg, deg)
        ctrl = [q[0], q[1], q[2], q[3], q[3]]
        for a, v in zip(self._act, ctrl):
            self.data.ctrl[a] = v
        if snap:
            for adr, v in zip(self._jq, ctrl):
                self.data.qpos[adr] = v
        go, gc = self.cfg["gripOpen"], self.cfg["gripClosed"]
        self.grip_closed = abs(deg[3] - gc) < abs(deg[3] - go)

    def step(self, dt_ms: float) -> float:
        """Advance physics by dt_ms; returns the peak accelerometer magnitude in g over the interval."""
        n = max(1, int(round(dt_ms / (self.model.opt.timestep * 1000.0))))
        worst = 1.0  # the IMU sample furthest from 1 g in this interval, as a fast-polling firmware would catch it
        for _ in range(n):
            self._apply_faults()
            mujoco.mj_step(self.model, self.data)
            a = self.data.sensordata[self._acc_adr : self._acc_adr + 3]
            g = float(np.linalg.norm(a)) / G
            if abs(g - 1.0) > abs(worst - 1.0):
                worst = g
        return worst

    # ---------------- sensors ----------------
    def tof_mm(self) -> int:
        d = float(self.data.sensordata[self._tof_adr])
        if d < 0:
            return TOF_MAX_MM
        return int(min(TOF_MAX_MM, round(d * 1000)))

    # ---------------- fault injection ----------------
    def inject_hand(self, ms: float) -> None:
        self._hand_until_ms = self.ms + ms

    def inject_bump(self) -> None:
        self._bump_until_ms = self.ms + BUMP_MS

    def _apply_faults(self) -> None:
        now = self.ms
        tx, ty, _ = self.layout["tof"]
        if now < self._hand_until_ms:
            self.data.mocap_pos[self._hand_mocap] = [tx - 0.02, ty, HAND_ABOVE_TOF_M + 0.012]
        else:
            self.data.mocap_pos[self._hand_mocap] = [0.9, 0.9, 0.3]
        self.data.xfrc_applied[self._mount] = [BUMP_FORCE_N, -BUMP_FORCE_N * 0.4, 0, 0, 0, 0] if now < self._bump_until_ms else 0

    # ---------------- scene ----------------
    def _touching_fingers(self, cube_geom: int) -> int:
        touched = set()
        for i in range(self.data.ncon):
            c = self.data.contact[i]
            pair = {c.geom1, c.geom2}
            if cube_geom in pair:
                touched |= pair & self._finger_geoms
        return len(touched)

    def scene(self) -> dict:
        """The tabletop as the dashboard and the scene-JSON prompt expect it (same shape as SceneState in scene.ts)."""
        slots: Dict[str, Optional[str]] = {"A1": None, "A2": None, "A3": None}
        bin_: List[str] = []
        table: List[str] = []
        holding: Optional[str] = None
        b = self.layout["bin"]
        for colour, gid in self._cube_geoms.items():
            p = self.data.xpos[self._cube_bodies[colour]]
            if self._touching_fingers(gid) == 2 and p[2] > 0.02:
                holding = colour
                continue
            # bin: inside the walls, in the bin frame
            dx, dy = p[0] - b["x"], p[1] - b["y"]
            c, s = math.cos(-b["yaw"]), math.sin(-b["yaw"])
            lx, ly = c * dx - s * dy, s * dx + c * dy
            if abs(lx) < BIN_HALF and abs(ly) < BIN_HALF and p[2] < b["wall"] + CUBE:
                bin_.append(colour)
                continue
            placed = False
            for sid, sl in self.layout["slots"].items():
                if math.hypot(p[0] - sl["x"], p[1] - sl["y"]) < 0.012 and abs(p[2] - (sl["top"] + CUBE / 2)) < 0.008:
                    slots[sid] = colour
                    placed = True
                    break
            if not placed:
                table.append(colour)
        return {"slots": slots, "bin": bin_, "table": table, "claw": "closed" if self.grip_closed else "open", "holding": holding}

    def reset_table(self) -> bool:
        """The operator puts the cubes back on their posts. Refused while the gripper is holding one."""
        if self.scene()["holding"]:
            return False
        m = self.model
        for j, q0 in self._cube_q0.values():
            qa, va = m.jnt_qposadr[j], m.jnt_dofadr[j]
            self.data.qpos[qa : qa + 7] = q0
            self.data.qvel[va : va + 6] = 0
        mujoco.mj_forward(m, self.data)
        return True

    def cube_pos(self, colour: str) -> List[float]:
        return [float(v) for v in self.data.xpos[self._cube_bodies[colour]]]

    # ---------------- camera ----------------
    def render_jpeg(self, quality: int = 85) -> bytes:
        """A fresh 640x480 frame from the fixed table camera (rendered on demand, never cached)."""
        from PIL import Image

        if self._renderer is None:
            self._renderer = mujoco.Renderer(self.model, 480, 640)
        self._renderer.update_scene(self.data, camera="overhead")
        img = self._renderer.render()
        buf = io.BytesIO()
        Image.fromarray(img).save(buf, format="JPEG", quality=quality)
        return buf.getvalue()

    def close(self) -> None:
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
