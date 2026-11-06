import { useEffect, useState } from "react";

/**
 * Hash router. Four places + two side pages:
 *
 *   #/                                  home
 *   #/robot                             robot: live view + runs list
 *   #/robot/run/<id>                    robot: one run's story (#/robot/run with no id and old #/robot/runs → #/robot)
 *   #/proof        #/proof/<id>         proof: check any run
 *   #/insurance                         insurance (owner side by default)
 *   #/insurance/owner                   insurance: owner side (claim)
 *   #/insurance/insurer[/<claimId>]     insurance: insurer side (review), optionally one claim selected
 *   #/offline[/courier|/mesh]           works without internet (carrier relay + robot mesh), optional section
 *   #/account                           account: sign-in, unlock key, robot link, payout wallet
 *
 * Old routes redirect (location.replace, so Back still works): see LEGACY below.
 * Build links with `to.*` (preferred) or `href(...parts)`; navigate with `go(...parts)` or `location.hash = to.x()`.
 */
export type Route =
  | { page: "home" }
  | { page: "robot"; runId?: string; runs?: boolean }
  | { page: "proof"; runId?: string }
  | { page: "insurance"; side: "owner" | "insurer"; claimId?: string }
  | { page: "offline"; section?: "courier" | "mesh" }
  | { page: "account" }
  | { page: "kit" }
  | { page: "notfound"; path: string };

export const href = (...parts: (string | null | undefined)[]) => `#/${parts.filter(Boolean).map((p) => encodeURIComponent(p!)).join("/")}`;
export const go = (...parts: (string | null | undefined)[]) => {
  location.hash = href(...parts);
};

/** Canonical link builders: use these in new code. */
export const to = {
  home: () => href(),
  robot: () => href("robot"),
  runs: () => href("robot"), // the runs list lives on the Robot page
  run: (id: string) => href("robot", "run", id),
  proof: (id?: string | null) => href("proof", id),
  insurance: (side?: "owner" | "insurer", claimId?: string | null) => href("insurance", side, side === "insurer" ? claimId : null),
  offline: (section?: "courier" | "mesh") => href("offline", section),
  account: () => href("account"),
};

/** Old path → new path (parts in, parts out). Returns null when the path is already canonical. */
export function legacyRedirect(p: string[]): string[] | null {
  const [a, b, c] = p;
  if (a === "robot") {
    if (b === "live") return ["robot"];
    if (b === "runs") return c ? ["robot", "run", c] : ["robot"];
    if (b === "run" && !c) return ["robot"];
    if (b === "claims") return ["insurance", "owner"];
    if (b === "setup") return ["account"];
  }
  if (a === "insurer") return b ? ["insurance", "insurer", b] : ["insurance", "insurer"];
  if (a === "verify") return b ? ["proof", b] : ["proof"];
  if (a === "courier") return ["offline", "courier"];
  if (a === "mesh") return ["offline", "mesh"];
  if (a === "setup") return ["account"];
  return null;
}

export function parseRoute(p: string[]): Route {
  const [a, b, c] = p;
  switch (a ?? "") {
    case "": return { page: "home" };
    case "robot": return b === "run" ? (c ? { page: "robot", runId: c } : { page: "robot", runs: true }) : { page: "robot" };
    case "proof": return { page: "proof", runId: b };
    case "insurance": return { page: "insurance", side: b === "insurer" ? "insurer" : "owner", claimId: b === "insurer" ? c : undefined };
    case "offline": return { page: "offline", section: b === "courier" || b === "mesh" ? b : undefined };
    case "account": return { page: "account" };
    case "kit": return { page: "kit" };
    default: return { page: "notfound", path: p.join("/") };
  }
}

const partsOf = (hash: string) => hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

/** Applies a legacy redirect if needed; returns the canonical parts. */
function canonicalParts(): string[] {
  const p = partsOf(location.hash);
  const r = legacyRedirect(p);
  if (r) {
    location.replace(href(...r));
    return r;
  }
  return p;
}

/** Raw path parts of the current hash (after redirects), e.g. ["robot", "run", "ep_…"]. */
export function useRoute(): string[] {
  const [p, setP] = useState(canonicalParts);
  useEffect(() => {
    const f = () => setP(canonicalParts());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return p;
}

/** The current route, typed. */
export function useRouteInfo(): Route {
  return parseRoute(useRoute());
}
