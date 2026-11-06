// Owner unlock for a run, in this browser: the owner's private key (localStorage) opens the run key the robot locked
// for them. Works while the robot is offline: then any robot linked to the account counts, and the run's key comes
// from the copy the robot locked for the owner inside the stored file.
import { get } from "../api";
import { unwrapWith } from "./fullcheck";
import { loadKey, type KeyRecord } from "./keys";

export interface OwnerUnlock {
  /** Returns this run's key, or null when the viewer can't unlock (see `reason`). */
  unlock: ((episodeId: string, device?: string | null) => Promise<Uint8Array>) | null;
  /** Plain sentence: why unlocking isn't possible yet ("" when it is). */
  reason: string;
  /** What the owner should do next: "signin" | "setup" | null. */
  next: "signin" | "setup" | null;
  /** The robot address a run belongs to (explicit device, else the live robot, else the first linked robot). */
  robotOf: (device?: string | null) => string;
  /** The live robot is linked to this account. */
  linked: boolean;
  /** The owner's key record in this browser, if any. */
  rec: KeyRecord | null;
}

/** `linked` overrides the computed "live robot is linked to this account" (kept for older callers). */
export function ownerUnlock(live: any, account: any, linkedOverride?: boolean): OwnerUnlock {
  const addr: string | undefined = live?.state?.deviceAddress;
  const linked = linkedOverride ?? !!account?.robots?.some((r: any) => r.address.toLowerCase() === addr?.toLowerCase());
  const rec = account ? loadKey("owner", account.accountId) : null;
  const robotOf = (device?: string | null): string => device || addr || account?.robots?.[0]?.address || "";
  const offline = !addr;
  const owns = linked || (offline && !!account?.robots?.length);
  const ready = !!(account && account.key && rec && rec.kid === account.key.kid && owns);
  const reason = !account ? "Sign in as the robot's owner to unlock its runs."
    : !account.key ? "Set up your unlock key in Settings first."
      : !rec || rec.kid !== account.key.kid ? "Your unlock key is not in this browser. Restore it from your backup in Settings."
        : !owns ? "Link this robot to your account in Settings first." : "";
  const unlock = ready
    ? async (episodeId: string, device?: string | null) => {
      const wrap = await get(`/api/episodes/${encodeURIComponent(episodeId)}/key`);
      return unwrapWith(wrap, rec!, robotOf(device), episodeId);
    }
    : null;
  return { unlock, reason, next: ready ? null : !account ? "signin" : "setup", robotOf, linked, rec };
}

/** Same as ownerUnlock (name used by the Insurance page). */
export const useOwnerUnlock = (live: any, account: any, linked: boolean) => ownerUnlock(live, account, linked);
