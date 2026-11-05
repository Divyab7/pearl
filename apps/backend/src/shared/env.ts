/** Loads the repo-root .env once (dotenv 17: `quiet` silences its startup log line; see node_modules/dotenv/lib/main.d.ts). */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  config({ path: resolve(REPO_ROOT, ".env"), quiet: true });
  loaded = true;
}

export function envFlag(name: string, dflt: "on" | "off"): boolean {
  const v = (process.env[name] ?? dflt).trim().toLowerCase();
  if (v !== "on" && v !== "off") throw new Error(`${name} must be "on" or "off", got "${v}"`);
  return v === "on";
}
