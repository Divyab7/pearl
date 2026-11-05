"""
MuJoCo model (MJCF) of the Pearl arm and its table, generated from config/arm.json.

The arm: a 4-servo desk arm (base yaw, shoulder pitch, elbow pitch, parallel gripper), MG90-class servos modelled as
position actuators. Servo degrees map to joint angles as:
  base      yaw   = (b - 90) deg   (90 = straight ahead, +x)
  shoulder  pitch = (s - 90) deg   (90 = upper arm vertical, larger = leaning forward)
  elbow     pitch = (90 - e) deg   (90 = forearm square to the upper arm, smaller = forearm bent down)
  gripper   finger opening interpolated between gripOpen and gripClosed

Scene objects are placed where the calibrated poses actually put the gripper: the model is first built without
objects, the gripper's grasp point is computed for each slot's "down" pose with forward kinematics, and the slot
posts, cubes and bin are put there. So arm.json stays the single source of truth for sim and hardware.

The base sits on a stiff spring mount (two slide joints) so a knock on the base shows up on the accelerometer, the
way an MPU6050 on a real base feels a bump. The ToF sensor is a rangefinder on the table pointing up beside the
slots; a mocap "hand" moves into its beam to inject a hand-in-zone.
MJCF reference: https://mujoco.readthedocs.io/en/stable/XMLreference.html
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import mujoco

REPO_ROOT = Path(__file__).resolve().parents[3]

# geometry, metres
BASE_H = 0.070  # shoulder axis height above the table
UPPER = 0.100  # shoulder -> elbow
FORE = 0.090  # elbow -> gripper palm
GRASP = 0.030  # palm -> grasp point along the fingers
CUBE = 0.025  # cube edge
FINGER_OPEN = 0.024  # finger centre offset from the gripper axis when open
FINGER_CLOSED = 0.002  # target when closed: past the cube face, so the servo squeezes
POST_HALF = 0.010  # slot posts are narrower than the cube so the fingers pass beside them
BIN_HALF = 0.040
BIN_WALL = 0.035
TOF_POS = (0.240, 0.0, 0.0)
SLOT_COLOURS = {"A1": None, "A2": "red", "A3": "blue"}
RGBA = {"red": "0.85 0.15 0.15 1", "blue": "0.15 0.35 0.9 1", "green": "0.2 0.7 0.3 1", "yellow": "0.9 0.8 0.1 1"}


def load_arm_config(path: Optional[Path] = None) -> dict:
    p = path or REPO_ROOT / "config" / "arm.json"
    return json.loads(Path(p).read_text())


def servo_to_qpos(cfg: dict, deg: List[float]) -> Tuple[float, float, float, float]:
    """Servo degrees -> (base yaw rad, shoulder rad, elbow rad, finger opening m)."""
    b, s, e, g = deg
    go, gc = cfg["gripOpen"], cfg["gripClosed"]
    frac = (g - go) / (gc - go) if gc != go else 0.0
    frac = min(1.0, max(0.0, frac))
    finger = FINGER_OPEN + (FINGER_CLOSED - FINGER_OPEN) * frac
    return math.radians(b - 90), math.radians(s - 90), math.radians(90 - e), finger


def _arm_xml(cfg: dict) -> str:
    lo, hi = cfg["jointMinDeg"], cfg["jointMaxDeg"]
    r_base = f"{math.radians(lo[0] - 90):.4f} {math.radians(hi[0] - 90):.4f}"
    r_sh = f"{math.radians(lo[1] - 90):.4f} {math.radians(hi[1] - 90):.4f}"
    r_el = f"{math.radians(90 - hi[2]):.4f} {math.radians(90 - lo[2]):.4f}"
    return f"""
    <body name="mount" pos="0 0 0">
      <joint name="mount_x" type="slide" axis="1 0 0" stiffness="4000" damping="40" range="-0.02 0.02" limited="true"/>
      <joint name="mount_y" type="slide" axis="0 1 0" stiffness="4000" damping="40" range="-0.02 0.02" limited="true"/>
      <geom name="base_plate" type="cylinder" size="0.055 0.006" pos="0 0 0.007" rgba="0.15 0.15 0.17 1" mass="1.0"/>
      <site name="imu" pos="0.03 0 0.014" size="0.006" rgba="0.1 0.6 0.2 1"/>
      <body name="turret" pos="0 0 0.012">
        <joint name="j_base" type="hinge" axis="0 0 1" range="{r_base}" limited="true" damping="0.08" armature="0.002"/>
        <geom type="cylinder" size="0.03 0.025" pos="0 0 0.025" rgba="0.95 0.55 0.1 1" mass="0.08"/>
        <body name="upper" pos="0 0 {BASE_H - 0.012}">
          <joint name="j_shoulder" type="hinge" axis="0 1 0" range="{r_sh}" limited="true" damping="0.08" armature="0.002"/>
          <geom type="capsule" fromto="0 0 0 0 0 {UPPER}" size="0.011" rgba="0.95 0.55 0.1 1" mass="0.05"/>
          <body name="fore" pos="0 0 {UPPER}">
            <joint name="j_elbow" type="hinge" axis="0 1 0" range="{r_el}" limited="true" damping="0.06" armature="0.002"/>
            <geom type="capsule" fromto="0 0 0 {FORE - 0.008} 0 0" size="0.009" rgba="0.2 0.2 0.22 1" mass="0.04"/>
            <body name="palm" pos="{FORE} 0 0">
              <geom name="palm" type="box" size="0.006 0.032 0.010" rgba="0.2 0.2 0.22 1" mass="0.02"/>
              <site name="grasp" pos="{GRASP} 0 0" size="0.004" rgba="1 1 1 0.4"/>
              <body name="finger_l" pos="0 0 0">
                <joint name="j_finger_l" type="slide" axis="0 1 0" range="0 0.03" limited="true" damping="1"/>
                <geom name="finger_l" type="box" size="0.022 0.004 0.008" pos="0.026 0 0" rgba="0.85 0.85 0.85 1" mass="0.008" friction="1.6 0.02 0.002" condim="4"/>
              </body>
              <body name="finger_r" pos="0 0 0">
                <joint name="j_finger_r" type="slide" axis="0 -1 0" range="0 0.03" limited="true" damping="1"/>
                <geom name="finger_r" type="box" size="0.022 0.004 0.008" pos="0.026 0 0" rgba="0.85 0.85 0.85 1" mass="0.008" friction="1.6 0.02 0.002" condim="4"/>
              </body>
            </body>
          </body>
        </body>
      </body>
    </body>"""


_ACTUATORS = """
  <actuator>
    <position name="a_base" joint="j_base" kp="25" kv="0.6" forcerange="-2 2"/>
    <position name="a_shoulder" joint="j_shoulder" kp="40" kv="0.8" forcerange="-2 2"/>
    <position name="a_elbow" joint="j_elbow" kp="30" kv="0.5" forcerange="-2 2"/>
    <position name="a_finger_l" joint="j_finger_l" kp="300" kv="4" forcerange="-4 4"/>
    <position name="a_finger_r" joint="j_finger_r" kp="300" kv="4" forcerange="-4 4"/>
  </actuator>"""


def _wrap(world: str, cfg: dict, extra_sensors: str = "", extra_assets: str = "") -> str:
    return f"""<mujoco model="pearl-arm">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" gravity="0 0 -9.81" cone="elliptic" impratio="10"/>
  <visual><headlight ambient="0.35 0.35 0.35" diffuse="0.6 0.6 0.6"/><global offwidth="640" offheight="480"/></visual>
  <asset>
    <texture name="grid" type="2d" builtin="checker" rgb1="0.82 0.80 0.76" rgb2="0.76 0.74 0.70" width="300" height="300"/>
    <material name="table" texture="grid" texrepeat="6 6" reflectance="0.05"/>
    {extra_assets}
  </asset>
  <worldbody>
    <light pos="0.1 -0.2 0.8" dir="0 0.2 -1" diffuse="0.7 0.7 0.7"/>
    <geom name="table" type="plane" size="0.6 0.6 0.01" material="table"/>
    <body name="look" pos="0.08 0.04 0.02"/>
    <camera name="overhead" mode="targetbody" target="look" pos="0.42 -0.06 0.30"/>
    {_arm_xml(cfg)}
    {world}
  </worldbody>
  {_ACTUATORS}
  <sensor>
    <accelerometer name="acc" site="imu"/>
    {extra_sensors}
  </sensor>
</mujoco>"""


def grasp_points(cfg: dict) -> Dict[str, Tuple[float, float, float]]:
    """Grasp-point position for every slot's "down" pose, by forward kinematics on the arm alone."""
    m = mujoco.MjModel.from_xml_string(_wrap("", cfg))
    d = mujoco.MjData(m)
    out = {}
    for sid, poses in cfg["slots"].items():
        q = servo_to_qpos(cfg, poses["down"])
        d.qpos[:] = 0
        d.qpos[m.joint("j_base").qposadr[0]] = q[0]
        d.qpos[m.joint("j_shoulder").qposadr[0]] = q[1]
        d.qpos[m.joint("j_elbow").qposadr[0]] = q[2]
        mujoco.mj_kinematics(m, d)
        p = d.site("grasp").xpos
        out[sid] = (float(p[0]), float(p[1]), float(p[2]))
    return out


def build_xml(cfg: dict, colours: Optional[Dict[str, Optional[str]]] = None) -> Tuple[str, dict]:
    """Full scene XML plus a layout dict (slot posts, bin box, ToF position) used by the world for scene reading."""
    colours = colours or SLOT_COLOURS
    gp = grasp_points(cfg)
    parts: List[str] = []
    layout: dict = {"slots": {}, "bin": None, "tof": TOF_POS, "cubes": []}
    for sid in ("A1", "A2", "A3"):
        x, y, z = gp[sid]
        yaw = math.atan2(y, x)
        top = z - CUBE / 2  # post top so the cube centre sits at the grasp point
        if top < 0.004:
            raise ValueError(f"slot {sid}: down pose reaches z={z:.3f} m, too low for a {CUBE} m cube")
        parts.append(
            f'<geom name="post_{sid}" type="box" size="{POST_HALF} {POST_HALF} {top / 2:.4f}" '
            f'pos="{x:.4f} {y:.4f} {top / 2:.4f}" euler="0 0 {yaw:.4f}" rgba="0.55 0.55 0.6 1"/>'
        )
        layout["slots"][sid] = {"x": x, "y": y, "top": top, "yaw": yaw}
        c = colours.get(sid)
        if c:
            parts.append(
                f'<body name="cube_{c}" pos="{x:.4f} {y:.4f} {top + CUBE / 2 + 0.0005:.4f}" euler="0 0 {yaw:.4f}">'
                f'<freejoint/><geom name="cube_{c}" type="box" size="{CUBE / 2} {CUBE / 2} {CUBE / 2}" '
                f'rgba="{RGBA.get(c, "0.5 0.5 0.5 1")}" mass="0.015" friction="1.6 0.02 0.002" condim="4"/></body>'
            )
            layout["cubes"].append(c)
    bx, by, _ = gp["BIN"]
    byaw = math.atan2(by, bx)
    h = BIN_WALL / 2
    t = 0.003
    walls = [
        (0, 0, 0.002, BIN_HALF, BIN_HALF, 0.002),
        (BIN_HALF, 0, h, t, BIN_HALF, h),
        (-BIN_HALF, 0, h, t, BIN_HALF, h),
        (0, BIN_HALF, h, BIN_HALF, t, h),
        (0, -BIN_HALF, h, BIN_HALF, t, h),
    ]
    wall_xml = "".join(
        f'<geom type="box" size="{sx} {sy} {sz}" pos="{px} {py} {pz}" rgba="0.3 0.3 0.35 1"/>' for px, py, pz, sx, sy, sz in walls
    )
    parts.append(f'<body name="bin" pos="{bx:.4f} {by:.4f} 0" euler="0 0 {byaw:.4f}">{wall_xml}</body>')
    layout["bin"] = {"x": bx, "y": by, "yaw": byaw, "half": BIN_HALF, "wall": BIN_WALL}
    tx, ty, tz = TOF_POS
    parts.append(
        f'<geom name="tof_body" type="box" size="0.008 0.006 0.003" pos="{tx} {ty} 0.003" rgba="0.05 0.05 0.05 1" contype="0" conaffinity="0"/>'
        f'<site name="tof" pos="{tx} {ty} 0.0065" size="0.003" rgba="0.9 0.1 0.1 1"/>'
    )
    # operator's hand: a mocap body parked far away; it never collides, the rangefinder still sees it
    parts.append(
        '<body name="op_hand" mocap="true" pos="0.9 0.9 0.3">'
        '<geom name="op_hand" type="box" size="0.045 0.03 0.012" rgba="0.92 0.72 0.6 1" contype="0" conaffinity="0"/>'
        '<geom type="capsule" fromto="0.045 0 0 0.12 0 0.01" size="0.022" rgba="0.92 0.72 0.6 1" contype="0" conaffinity="0"/></body>'
    )
    assets = []
    for name in ("A1", "A2", "A3", "BIN"):
        assets.append(f'<texture name="tx_{name}" type="2d" file="{_label_png(name)}"/>'
                      f'<material name="m_{name}" texture="tx_{name}"/>')
    for sid, sl in layout["slots"].items():
        r = math.hypot(sl["x"], sl["y"]) + 0.040
        lx, ly = r * math.cos(sl["yaw"]), r * math.sin(sl["yaw"])
        parts.append(f'<geom type="box" size="0.012 0.018 0.0005" pos="{lx:.4f} {ly:.4f} 0.0005" '
                     f'euler="0 0 {math.pi / 2:.4f}" material="m_{sid}" contype="0" conaffinity="0"/>')
    parts.append(f'<geom type="box" size="0.012 0.022 0.0005" pos="{bx + BIN_HALF + 0.02:.4f} {by:.4f} 0.0005" '
                 f'euler="0 0 {math.pi / 2:.4f}" material="m_BIN" contype="0" conaffinity="0"/>')
    return _wrap("\n    ".join(parts), cfg, '<rangefinder name="tof" site="tof"/>', "".join(assets)), layout


def _label_png(text: str) -> str:
    """A printed table sticker ("A1", "BIN", ...) as a PNG texture, generated once into sim/mujoco/.cache/."""
    from PIL import Image, ImageDraw, ImageFont

    out = Path(__file__).resolve().parents[1] / ".cache" / f"label_{text}.png"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        img = Image.new("RGB", (256, 128), "white")
        d = ImageDraw.Draw(img)
        font = ImageFont.load_default(size=96)
        box = d.textbbox((0, 0), text, font=font)
        d.text(((256 - (box[2] - box[0])) / 2 - box[0], (128 - (box[3] - box[1])) / 2 - box[1]), text, fill="black", font=font)
        img.save(out)
    return str(out)
