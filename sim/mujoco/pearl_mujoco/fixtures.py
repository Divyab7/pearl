"""
Renders one camera frame per checkpoint into fixtures/frames/ (CAMERA_SOURCE=file, and `pnpm og:smoke` image tests):
  plan.jpg          red cube on A2, blue on A3, bin empty, arm at home
  verify_grasp.jpg  red cube held in the gripper above A2
  verify_place.jpg  red cube in the bin, gripper open above it
  incident.jpg      red cube held during the carry, the operator's hand in the ToF zone
Every scene is reached by running the arm through the firmware logic and physics; nothing is posed by hand.
Run: pnpm sim:mujoco:fixtures   (replace these with real table photos once the arm is built)
"""
from __future__ import annotations

import json

from .firmware import Firmware
from .model import REPO_ROOT
from .world import World


def main() -> None:
    out_dir = REPO_ROOT / "fixtures" / "frames"
    out_dir.mkdir(parents=True, exist_ok=True)
    w = World()
    cfg = w.cfg
    fw = Firmware(cfg, lambda _m: None)
    fw.boot()

    def run(ms: float) -> None:
        t = 0.0
        while t < ms:
            fw.receive_line('{"cmd":"hb","seq":1}')
            w.set_servos(fw.pos)
            g = w.step(20)
            fw.tick(20, w.tof_mm(), g)
            t += 20

    def cmd(c: dict) -> None:
        fw.receive_line(json.dumps(c))
        for _ in range(500):
            run(20)
            if fw.state == "IDLE":
                break
        run(300)

    def pose(slot: str, which: str, closed: bool) -> list:
        return cfg["slots"][slot][which][:3] + [cfg["gripClosed"] if closed else cfg["gripOpen"]]

    def save(name: str) -> None:
        p = out_dir / f"{name}.jpg"
        p.write_bytes(w.render_jpeg())
        print(f"wrote {p.relative_to(REPO_ROOT)}  scene={json.dumps(w.scene())}")

    run(200)
    save("plan")
    cmd({"cmd": "move", "id": "1", "joints": pose("A2", "above", False)})
    cmd({"cmd": "move", "id": "2", "joints": pose("A2", "down", False)})
    cmd({"cmd": "grip", "id": "3", "close": True})
    cmd({"cmd": "move", "id": "4", "joints": pose("A2", "above", True)})
    save("verify_grasp")
    w.inject_hand(400)
    run(40)
    save("incident")
    run(600)
    fw.receive_line('{"cmd":"resume"}')
    cmd({"cmd": "move", "id": "5", "joints": pose("BIN", "above", True)})
    cmd({"cmd": "move", "id": "6", "joints": pose("BIN", "down", True)})
    cmd({"cmd": "grip", "id": "7", "close": False})
    cmd({"cmd": "move", "id": "8", "joints": pose("BIN", "above", False)})
    save("verify_place")
    w.close()


if __name__ == "__main__":
    main()
