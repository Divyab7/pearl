"""Physics checks: a full pick-and-place moves the cube by contact only, the sensors see the hand and the bump."""
import json
import unittest

from pearl_mujoco.firmware import Firmware
from pearl_mujoco.world import World


class WorldTest(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.cfg = self.w.cfg
        self.out = []
        self.fw = Firmware(self.cfg, self.out.append)
        self.fw.boot()
        self.peak = 1.0

    def run_ms(self, ms):
        t = 0
        while t < ms:
            self.fw.receive_line('{"cmd":"hb","seq":1}')
            self.w.set_servos(self.fw.pos)
            g = self.w.step(20)
            self.peak = max(self.peak, abs(g - 1) + 1)
            self.fw.tick(20, self.w.tof_mm(), g)
            t += 20

    def cmd(self, c):
        self.fw.receive_line(json.dumps(c))
        for _ in range(500):
            self.run_ms(20)
            if self.fw.state == "IDLE":
                break
        self.run_ms(300)
        self.assertEqual(self.fw.state, "IDLE", c)

    def pose(self, slot, which, closed):
        p = self.cfg["slots"][slot][which][:3]
        return p + [self.cfg["gripClosed"] if closed else self.cfg["gripOpen"]]

    def test_start_scene(self):
        s = self.w.scene()
        self.assertEqual(s["slots"], {"A1": None, "A2": "red", "A3": "blue"})
        self.assertEqual(s["bin"], [])
        self.assertEqual(self.w.tof_mm(), 2000)

    def test_pick_and_place_by_physics(self):
        self.cmd({"cmd": "move", "id": "1", "joints": self.pose("A2", "above", False)})
        self.cmd({"cmd": "move", "id": "2", "joints": self.pose("A2", "down", False)})
        self.cmd({"cmd": "grip", "id": "3", "close": True})
        self.assertEqual(self.w.scene()["holding"], "red")
        self.cmd({"cmd": "move", "id": "4", "joints": self.pose("A2", "above", True)})
        self.assertGreater(self.w.cube_pos("red")[2], 0.1)  # lifted by friction alone
        self.cmd({"cmd": "move", "id": "5", "joints": self.pose("BIN", "above", True)})
        self.cmd({"cmd": "move", "id": "6", "joints": self.pose("BIN", "down", True)})
        self.cmd({"cmd": "grip", "id": "7", "close": False})
        s = self.w.scene()
        self.assertEqual(s["bin"], ["red"])
        self.assertEqual(s["slots"]["A3"], "blue")
        self.assertLess(self.peak, self.cfg["bumpG"])  # normal motion never looks like a bump
        self.assertTrue(self.w.reset_table())
        self.assertEqual(self.w.scene()["slots"]["A2"], "red")

    def test_hand_seen_by_tof(self):
        self.w.inject_hand(300)
        self.w.step(20)
        self.assertLess(self.w.tof_mm(), self.cfg["handZoneMm"])
        self.w.step(400)
        self.assertEqual(self.w.tof_mm(), 2000)

    def test_bump_seen_by_accelerometer(self):
        self.w.inject_bump()
        g = self.w.step(20)
        self.assertGreater(abs(g - 1), self.cfg["bumpG"])

    def test_camera_frame_is_jpeg(self):
        b = self.w.render_jpeg()
        self.assertEqual(b[:2], b"\xff\xd8")
        self.assertGreater(len(b), 10_000)

    def tearDown(self):
        self.w.close()


if __name__ == "__main__":
    unittest.main()
