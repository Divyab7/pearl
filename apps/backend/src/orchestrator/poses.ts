/**
 * Named actions → pose sequences, from the calibration table only (prompt §8.3: the model never outputs angles).
 * Slot poses define base/shoulder/elbow; the gripper value is set here explicitly: open on the way down, closed while
 * carrying (see the comment in config/arm.json).
 */
import type { ArmConfig, SlotName } from "../shared/armConfig.js";
import type { Joints } from "../shared/types.js";

export type Step =
  | { kind: "move"; joints: Joints }
  | { kind: "grip"; close: boolean }
  | { kind: "safe" }
  | { kind: "resume" };

export function fmtStep(s: Step): string {
  switch (s.kind) {
    case "move":
      return `move:[${s.joints.join(",")}]`;
    case "grip":
      return `grip:${s.close ? "close" : "open"}`;
    default:
      return s.kind;
  }
}

function withGrip(pose: readonly number[], grip: number): Joints {
  return [pose[0]!, pose[1]!, pose[2]!, grip] as Joints;
}

export class Poses {
  constructor(private readonly cfg: ArmConfig) {}

  private open = () => this.cfg.gripOpen;
  private closed = () => this.cfg.gripClosed;

  /** above (open) → down (open) → close → back above (closed). */
  grasp(slot: Exclude<SlotName, "BIN">): Step[] {
    const s = this.cfg.slots[slot];
    return [
      { kind: "move", joints: withGrip(s.above, this.open()) },
      { kind: "move", joints: withGrip(s.down, this.open()) },
      { kind: "grip", close: true },
      { kind: "move", joints: withGrip(s.above, this.closed()) },
    ];
  }

  /** From above the slot with an empty, closed claw: open → down → close → back above. */
  regrasp(slot: Exclude<SlotName, "BIN">): Step[] {
    const s = this.cfg.slots[slot];
    return [
      { kind: "grip", close: false },
      { kind: "move", joints: withGrip(s.down, this.open()) },
      { kind: "grip", close: true },
      { kind: "move", joints: withGrip(s.above, this.closed()) },
    ];
  }

  /** Carry over the bin (closed) → release → lift to home (open). */
  place(): Step[] {
    return [
      { kind: "move", joints: withGrip(this.cfg.slots.BIN.above, this.closed()) },
      { kind: "grip", close: false },
      { kind: "move", joints: withGrip(this.cfg.home, this.open()) },
    ];
  }
}
