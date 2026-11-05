"""Firmware-logic rules (no physics): the same cases SimArm.test.ts checks on the TypeScript side."""
import json
import unittest

from pearl_mujoco.firmware import Firmware
from pearl_mujoco.model import load_arm_config

CLEAR = 2000


class FirmwareTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_arm_config()
        self.out = []
        self.fw = Firmware(self.cfg, self.out.append)
        self.fw.boot()

    def send(self, cmd):
        self.fw.receive_line(json.dumps(cmd))

    def run_ms(self, ms, tof=CLEAR, acc=1.0, hb=True):
        t = 0
        while t < ms:
            if hb:
                self.send({"cmd": "hb", "seq": 1})
            self.fw.tick(20, tof, acc)
            t += 20

    def last(self, t):
        return [m for m in self.out if m["t"] == t]

    def test_hello_then_idle(self):
        self.assertEqual(self.out[0]["t"], "hello")
        self.assertEqual(self.out[0]["joints"], self.cfg["home"])
        self.assertEqual(self.fw.state, "IDLE")

    def test_move_ack_done_and_speed_limit(self):
        self.send({"cmd": "move", "id": "m1", "joints": [120, 90, 90, 10]})
        self.assertEqual(self.last("ack")[-1]["id"], "m1")
        self.run_ms(250)
        self.assertLess(self.fw.pos[0], 106)  # 60 deg/s -> at most 15 deg in 250 ms
        self.run_ms(400)
        self.assertEqual(self.last("done")[-1]["id"], "m1")
        self.assertEqual(self.fw.joints(), [120, 90, 90, 10])

    def test_limit_busy_parse_nacks(self):
        self.send({"cmd": "move", "id": "a", "joints": [5, 90, 90, 10]})
        self.assertEqual(self.out[-1], {"t": "nack", "id": "a", "reason": "limit"})
        self.send({"cmd": "move", "id": "b", "joints": [120, 90, 90, 10]})
        self.send({"cmd": "move", "id": "c", "joints": [60, 90, 90, 10]})
        self.assertEqual(self.out[-1], {"t": "nack", "id": "c", "reason": "busy"})
        self.send({"cmd": "move", "id": "d", "joints": [60, 90, 90, 10], "extra": 1})
        self.assertEqual(self.out[-1], {"t": "nack", "id": "d", "reason": "parse"})
        self.fw.receive_line("not json")
        self.assertEqual(self.out[-1], {"t": "nack", "reason": "parse"})

    def test_hand_freezes_and_needs_clear_plus_resume(self):
        self.send({"cmd": "move", "id": "m", "joints": [150, 90, 90, 10]})
        self.run_ms(200)
        self.run_ms(40, tof=70)
        self.assertEqual(self.fw.state, "FROZEN_HAND")
        frozen = list(self.fw.pos)
        self.send({"cmd": "resume"})
        self.assertEqual(self.out[-1], {"t": "nack", "reason": "state"})
        self.run_ms(500)
        self.assertEqual(self.fw.pos, frozen)
        self.run_ms(self.cfg["handClearMs"] + 100)
        self.assertTrue(any(m.get("ev") == "hand_clear" for m in self.out))
        self.send({"cmd": "resume"})
        self.assertEqual(self.fw.state, "IDLE")

    def test_bump_trips_and_freezes(self):
        self.send({"cmd": "move", "id": "m", "joints": [150, 90, 90, 10]})
        self.run_ms(200)
        self.run_ms(20, acc=self.cfg["bumpG"] + 1.5)
        self.assertEqual(self.fw.state, "TRIPPED")
        frozen = list(self.fw.pos)
        self.run_ms(500)
        self.assertEqual(self.fw.pos, frozen)
        self.send({"cmd": "move", "id": "x", "joints": [90, 90, 90, 10]})
        self.assertEqual(self.out[-1], {"t": "nack", "id": "x", "reason": "state"})
        self.send({"cmd": "reset"})
        self.assertEqual(self.fw.state, "SAFE")

    def test_watchdog_trips_to_safe_pose(self):
        self.run_ms(self.cfg["heartbeatTimeoutMs"] + 200, hb=False)
        self.assertEqual(self.fw.state, "TRIPPED")
        self.assertTrue(any(m.get("ev") == "trip_watchdog" for m in self.out))
        self.assertEqual(self.fw.target, [float(x) for x in self.cfg["safe"]])

    def test_telemetry_rate(self):
        self.out.clear()
        self.run_ms(1000)
        n = len(self.last("tel"))
        self.assertTrue(self.cfg["telemetryHz"] - 1 <= n <= self.cfg["telemetryHz"] + 1, n)


if __name__ == "__main__":
    unittest.main()
