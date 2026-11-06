// Interactive 3D model of the arm on its table (three.js), driven by the same joints and scene as the flat ArmView.
// three.js is loaded on first use (its own chunk); the flat ArmView shows while it loads, if WebGL is missing, or if
// the 3D view fails for any reason.
import { Component, lazy, Suspense, type ReactNode } from "react";
import arm from "../../../../config/arm.json";
import { ArmView } from "./ArmView";

export type ArmProps = { joints?: number[] | null; scene?: any; ring?: string; label?: string; showAngles?: boolean };

const Scene3D = lazy(() => import("./ArmScene3D"));

let webgl: boolean | undefined;
function hasWebGL() {
  if (webgl === undefined) {
    try {
      const c = document.createElement("canvas");
      webgl = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

class Fallback extends Component<{ flat: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.flat : this.props.children;
  }
}

const SLOTS = arm.slots as Record<string, { above: number[]; down: number[] }>;

/** One sentence for screen readers: what the arm is doing and what is on the table. */
export function describePose(joints?: number[] | null, scene?: any) {
  const [b, s, , g] = joints ?? arm.home;
  let near = "";
  let best = 16;
  for (const [id, p] of Object.entries(SLOTS)) {
    const d = Math.abs(p.above[0]! - b!);
    if (d < best) [best, near] = [d, id];
  }
  const lowered = near && s! >= (SLOTS[near]!.above[1]! + SLOTS[near]!.down[1]!) / 2;
  const is = (p: number[]) => p.slice(0, 3).every((v, i) => Math.abs(v - (joints ?? arm.home)[i]!) < 2);
  const at = is(arm.home) ? " at home" : is(arm.safe) ? " in the safe pose" : !near ? "" : near === "BIN" ? (lowered ? " down at the bin" : " above the bin") : lowered ? ` down at ${near}` : ` above ${near}`;
  const doing = scene?.holding ? `holding the ${scene.holding} cube` : g! > (arm.gripOpen + arm.gripClosed) / 2 ? "with the gripper closed" : "with the gripper open";
  let table = "";
  if (scene) {
    const on = Object.entries(scene.slots ?? {}).filter(([, c]) => c).map(([id, c]) => `${c} cube on ${id}`);
    const bin = scene.bin?.length ? `${scene.bin.join(" and ")} in the bin` : "bin empty";
    table = ` Table: ${[...on, bin].join(", ")}.`;
  }
  return `Arm ${doing}${at}.${table}`;
}

export function ArmView3D(props: ArmProps) {
  const flat = <ArmView {...props} />;
  if (typeof document === "undefined" || !hasWebGL()) return flat;
  return (
    <Fallback flat={flat}>
      <Suspense fallback={flat}>
        <Scene3D {...props} description={describePose(props.joints, props.scene)} />
      </Suspense>
    </Fallback>
  );
}
