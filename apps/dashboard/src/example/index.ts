/// <reference types="vite/client" />
// The built-in EXAMPLE run: bundled SAMPLE DATA shaped exactly like an unlocked run (the log the robot's recorder
// writes + its camera photos), so a visitor who isn't the owner can see what unlocking reveals. It is never presented
// as a live run and makes no verification claims: RunStory's `example` mode labels it everywhere.
import type { FullCheck } from "../lib/fullcheck";
import log from "./run.json";
import plan from "./plan.jpg";
import grasp from "./verify_grasp.jpg";
import incident from "./incident.jpg";

const PHOTO: Record<string, string> = { "example-plan": plan, "example-grasp": grasp, "example-incident": incident };
const frames: Record<number, string> = {};
for (const r of (log as any).records) if (r.frameRoot && PHOTO[r.frameRoot]) frames[r.idx] = PHOTO[r.frameRoot]!;

export const EXAMPLE_ID = "example";
export const EXAMPLE = {
  /** the public part, as /api/verify would describe it (no checks: there is nothing real to verify) */
  pub: {
    example: true,
    device: null,
    sealed: { outcome: "TRIPPED", incident: true, severity: 2, startedAt: (log as any).startedAt, endedAt: (log as any).endedAt, origin: null },
    checks: [],
    anchor: null,
    rootHash: null,
  },
  meta: { frames: Object.keys(frames) },
  fc: { log, frames, checks: [], result: "VALID" } as FullCheck,
};
