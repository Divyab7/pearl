// The owner's unlock for one run: their key (this browser) opens the run key the robot locked for them.
// Same logic as MyRobot's useOwnerUnlock (kept separate so the Insurance page does not depend on the Robot page).
import { get } from "../api";
import { unwrapWith } from "./fullcheck";
import { loadKey } from "./keys";

export function useOwnerUnlock(live: any, account: any, linked: boolean) {
  const rec = account ? loadKey("owner", account.accountId) : null;
  const robotOf = (device?: string | null): string => device || live.state?.deviceAddress || account?.robots?.[0]?.address || "";
  // the robot may be offline (no live address): then any robot linked to the account counts
  const offline = !live.state?.deviceAddress;
  const owns = linked || (offline && !!account?.robots?.length);
  const ready = !!(account && account.key && rec && rec.kid === account.key.kid && owns);
  const reason = !account ? "Sign in as the robot's owner first."
    : !account.key ? "Set up your unlock key in Account first."
      : !rec || rec.kid !== account.key.kid ? "Your unlock key is not on this browser. Restore it from your backup in Account."
        : !owns ? "Link this robot to your account in Account first." : "";
  const unlock = ready
    ? async (episodeId: string, device?: string | null) => {
      const wrap = await get(`/api/episodes/${encodeURIComponent(episodeId)}/key`);
      return unwrapWith(wrap, rec!, robotOf(device), episodeId);
    }
    : null;
  return { unlock, reason, rec, robotOf };
}
