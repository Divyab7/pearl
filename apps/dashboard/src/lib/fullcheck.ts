// The full check, run in the key holder's browser: unlock the run, re-check its content against the signed and
// anchored head, and unlock every camera frame. The dashboard server never sees the key or the readable log.
import { contentChecks, framesOf, openEpisode, runContext, sha256HexPure, tamperedCopy, unlockFrame, unwrapRunKey } from "./core";
import type { KeyRecord } from "./keys";

export const unwrapWith = (wrap: any, rec: KeyRecord, device: string, episodeId: string) =>
  unwrapRunKey(wrap, rec.privateJwk, runContext(device, episodeId));

export interface FullCheck {
  log: any;
  checks: { id: number; name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: string; tech?: string; missing?: boolean }[];
  frames: Record<number, string>;
  result: "VALID" | "REJECTED";
}

export async function fullCheck(pub: any, runKey: Uint8Array, arm: any): Promise<FullCheck> {
  if (!pub?.sealed) throw new Error("No locked file to unlock: the public check could not read it.");
  const log = await openEpisode(pub.sealed, runKey);
  const checks = contentChecks(log, { headerHead: pub.sealed.headHash, anchoredRequestIdsHash: pub.anchor?.requestIdsHash ?? null, arm });
  const frames: Record<number, string> = {};
  const fs = framesOf(log);
  const bad: string[] = [];
  let fromStorage = 0;
  for (const f of fs) {
    try {
      const r = await fetch(`/api/frames/${log.episodeId}/${f.idx}${f.root ? `?root=${f.root}` : ""}`);
      if (!r.ok) throw new Error("not available");
      if (r.headers.get("x-frame-source") === "0g-storage") fromStorage++;
      const jpeg = await unlockFrame(runKey, new Uint8Array(await r.arrayBuffer()));
      if (sha256HexPure(jpeg) !== f.hash) bad.push(`photo at record #${f.idx} differs from its fingerprint`);
      else frames[f.idx] = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    } catch (e: any) {
      bad.push(`photo at record #${f.idx}: ${e.message}`);
    }
  }
  const C10 = { id: 10, name: "Camera photos match", tech: "frames" };
  const photos = (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`;
  const fromRobot = fs.length - fromStorage;
  checks.push(
    fs.length === 0 ? { ...C10, status: "SKIPPED", detail: "no camera photos in this run" }
      : bad.length ? { ...C10, status: "FAIL", detail: bad.join("; ") }
        : { ...C10, status: "PASS", detail: `${photos(fs.length)} unlocked; each matches the fingerprint in the log${fromStorage ? ` (${fromStorage} read from 0G Storage${fromRobot ? `, ${fromRobot} from the robot` : ""})` : " (read from the robot)"}` },
  );
  return { log, checks, frames, result: checks.some((c) => c.status === "FAIL") ? "REJECTED" : "VALID" };
}

/** "Edit 1 byte" on an unlocked copy: the chain no longer reaches the head the robot signed. */
export function editedCheck(pub: any, fc: FullCheck, arm: any) {
  const { copy, where } = tamperedCopy(fc.log);
  const checks = contentChecks(copy, { headerHead: pub.sealed.headHash, anchoredRequestIdsHash: pub.anchor?.requestIdsHash ?? null, arm });
  return { where, checks, result: checks.some((c) => c.status === "FAIL") ? "REJECTED" : "VALID" };
}
