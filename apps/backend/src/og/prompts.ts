import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "../shared/hash.js";
import { REPO_ROOT } from "../shared/env.js";
import type { Checkpoint } from "../shared/types.js";

const FILES: Record<Checkpoint, string> = {
  PLAN: "plan.txt",
  VERIFY_GRASP: "verify_grasp.txt",
  VERIFY_PLACE: "verify_place.txt",
  INCIDENT: "incident.txt",
};

export interface SystemPrompt {
  text: string;
  hash: string; // sha256 of the exact bytes sent, recorded in every decision as promptHash
}

const cache = new Map<Checkpoint, SystemPrompt>();

export function systemPrompt(cp: Checkpoint): SystemPrompt {
  let p = cache.get(cp);
  if (!p) {
    const text = readFileSync(resolve(REPO_ROOT, "prompts", FILES[cp]), "utf8");
    p = { text, hash: sha256Hex(text) };
    cache.set(cp, p);
  }
  return p;
}
