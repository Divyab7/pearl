// The signed-in owner account (World ID) and insurer session, shared by the shell's account menu and the pages.
// Every useAccount() copy stays in sync: refresh() refetches here and tells the other copies to refetch too.
import { useEffect, useState } from "react";
import { get } from "../api";

const EV = "pearl:account";

/** Owner account: undefined while loading, null when signed out, else { accountId, key, wallet, robots[] }.
 *  Call refresh() after anything that changes it (sign-in, sign-out, key, wallet, robot link). */
export function useAccount(tick: number) {
  const [account, setAccount] = useState<any>(undefined);
  const fetchIt = () => get("/api/account").then(setAccount).catch(() => setAccount(null));
  const refresh = () => {
    const p = fetchIt();
    dispatchEvent(new Event(EV));
    return p;
  };
  useEffect(() => {
    fetchIt();
  }, [tick]);
  useEffect(() => {
    const f = () => void fetchIt();
    addEventListener(EV, f);
    return () => removeEventListener(EV, f);
  }, []);
  return { account, refresh };
}

/** Insurer session: undefined while loading, null if unavailable, else { configured, signedIn, address }. */
export function useInsurerSession(tick: number) {
  const [info, setInfo] = useState<any>(undefined);
  const fetchIt = () => get("/api/insurer").then(setInfo).catch(() => setInfo(null));
  useEffect(() => {
    fetchIt();
  }, [tick]);
  useEffect(() => {
    const f = () => void fetchIt();
    addEventListener(EV, f);
    return () => removeEventListener(EV, f);
  }, []);
  return info;
}

/** Tell every account/insurer hook to refetch (e.g. after the insurer signs in or out). */
export const accountChanged = () => dispatchEvent(new Event(EV));
