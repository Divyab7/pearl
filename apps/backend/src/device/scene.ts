/**
 * Simulated tabletop for DEVICE=sim. The scene changes only as a consequence of arm motion, never by itself:
 *  - the gripper closing at a slot's "down" pose picks up the cube there (unless the grasp-failure roll says otherwise);
 *  - the gripper opening while holding a cube drops it into the BIN when the arm is at a BIN pose, back into the slot at
 *    a slot's "down" pose, or onto the table anywhere else.
 * The model sees this scene as JSON when CAMERA_SOURCE=none; the dashboard draws it.
 */
import type { ArmConfig } from "../shared/armConfig.js";

export type SlotId = "A1" | "A2" | "A3";
export const SLOT_IDS: readonly SlotId[] = ["A1", "A2", "A3"];

export interface SceneState {
  slots: Record<SlotId, string | null>; // cube colour or empty
  bin: string[];
  table: string[]; // cubes dropped outside a slot or the bin
  claw: "open" | "closed";
  holding: string | null;
}

export function defaultScene(): SceneState {
  return { slots: { A1: null, A2: "red", A3: "blue" }, bin: [], table: [], claw: "open", holding: null };
}

const POSE_TOL = 2; // degrees

function near(a: readonly number[], b: readonly number[], joints = 3): boolean {
  for (let i = 0; i < joints; i++) if (Math.abs(a[i]! - b[i]!) > POSE_TOL) return false;
  return true;
}

export class Scene {
  state: SceneState;
  constructor(
    private readonly cfg: ArmConfig,
    initial: SceneState = defaultScene(),
    private readonly graspFailRate = 0,
    private readonly rng: () => number = Math.random,
  ) {
    this.state = structuredClone(initial);
  }

  /** Call after every motion step with the current joint angles. */
  update(joints: readonly number[]): void {
    const g = joints[3]!;
    const mid = (this.cfg.gripOpen + this.cfg.gripClosed) / 2;
    const closed = this.cfg.gripClosed > this.cfg.gripOpen ? g >= mid : g <= mid;
    const s = this.state;
    if (closed && s.claw === "open") {
      s.claw = "closed";
      const slot = SLOT_IDS.find((id) => near(joints, this.cfg.slots[id].down));
      if (slot && s.slots[slot] && !s.holding) {
        if (this.rng() >= this.graspFailRate) {
          s.holding = s.slots[slot];
          s.slots[slot] = null;
        }
      }
    } else if (!closed && s.claw === "closed") {
      s.claw = "open";
      if (s.holding) {
        const atBin = near(joints, this.cfg.slots.BIN.above) || near(joints, this.cfg.slots.BIN.down);
        const slot = SLOT_IDS.find((id) => near(joints, this.cfg.slots[id].down));
        if (atBin) s.bin.push(s.holding);
        else if (slot && !s.slots[slot]) s.slots[slot] = s.holding;
        else s.table.push(s.holding);
        s.holding = null;
      }
    }
  }

  snapshot(): SceneState {
    return structuredClone(this.state);
  }
}
