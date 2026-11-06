import { useEffect, useState } from "react";

/**
 * Hash router. Two shells:
 *
 * PUBLIC (top bar: logo · Verify a record · Open the app)
 *   #/                                   landing (pages/Landing.tsx)
 *   #/verify[/<id>[/tamper]]             check any run (/tamper starts the one-byte demo once)
 *
 * APP (left sidebar; the workspace decides the role)
 *   #/app[?demo=owner|insurer]           workspace chooser (?demo enters a demo workspace, then opens it)
 *   #/app/owner                          owner: overview (robot live, latest runs, counters)
 *   #/app/owner/robot                    owner: robot live view + all runs
 *   #/app/owner/run/<id>                 owner: one run's story (id "example" = the built-in sample run)
 *   #/app/owner/claims                   owner: insurance claims
 *   #/app/owner/offline[/courier|/mesh]  owner: works without internet
 *   #/app/owner/settings                 owner: World ID sign-in, unlock key, robot link, payout wallet
 *   #/app/insurer[/claim/<id>]           insurer: claim queue + review
 *   #/app/insurer/pool                   insurer: insurance pool + payouts
 *   #/app/insurer/settings               insurer: wallet sign-in + receiving key
 *
 * Old routes redirect with location.replace (no extra Back entry): see legacyRedirect.
 * Build links with `to.*`; navigate with `go(...parts)` or `location.hash = to.x()`.
 */
export type Workspace = "owner" | "insurer";
export type OwnerPage = "overview" | "robot" | "run" | "claims" | "offline" | "settings";
export type InsurerPage = "claims" | "pool" | "settings";

export type Route =
  | { shell: "public"; page: "landing" }
  | { shell: "public"; page: "verify"; runId?: string; tamper?: boolean }
  | { shell: "public"; page: "kit" }
  | { shell: "app"; page: "chooser"; demo?: Workspace }
  | { shell: "app"; ws: "owner"; page: "overview" }
  | { shell: "app"; ws: "owner"; page: "robot" }
  | { shell: "app"; ws: "owner"; page: "run"; runId: string }
  | { shell: "app"; ws: "owner"; page: "claims" }
  | { shell: "app"; ws: "owner"; page: "offline"; section?: "courier" | "mesh" }
  | { shell: "app"; ws: "owner"; page: "settings" }
  | { shell: "app"; ws: "insurer"; page: "claims"; claimId?: string }
  | { shell: "app"; ws: "insurer"; page: "pool" }
  | { shell: "app"; ws: "insurer"; page: "settings" }
  | { shell: "public" | "app"; page: "notfound"; path: string };

export const href = (...parts: (string | null | undefined)[]) => `#/${parts.filter(Boolean).map((p) => encodeURIComponent(p!)).join("/")}`;
export const go = (...parts: (string | null | undefined)[]) => {
  location.hash = href(...parts);
};

/** Canonical link builders: use these everywhere. */
export const to = {
  landing: () => href(),
  /** the workspace chooser */
  app: () => href("app"),
  /** enter a demo workspace (sample data) from any link */
  demo: (role: Workspace) => `${href("app")}?demo=${role}`,
  // owner workspace
  overview: () => href("app", "owner"),
  robot: () => href("app", "owner", "robot"),
  runs: () => href("app", "owner", "robot"), // the runs list lives on the Robot page
  run: (id: string) => href("app", "owner", "run", id),
  /** the built-in example run (sample data, clearly labelled) */
  exampleRun: () => href("app", "owner", "run", "example"),
  claims: () => href("app", "owner", "claims"),
  offline: (section?: "courier" | "mesh") => href("app", "owner", "offline", section),
  settings: () => href("app", "owner", "settings"),
  // insurer workspace
  insurer: (claimId?: string | null) => href("app", "insurer", claimId ? "claim" : null, claimId),
  pool: () => href("app", "insurer", "pool"),
  insurerSettings: () => href("app", "insurer", "settings"),
  // public
  verify: (id?: string | null, opts?: { tamper?: boolean }) => href("verify", id, id && opts?.tamper ? "tamper" : null),
};

/** Old path → new path (parts in, parts out). Returns null when the path is already canonical. */
export function legacyRedirect(p: string[]): string[] | null {
  const [a, b, c, d] = p;
  const O = ["app", "owner"];
  switch (a) {
    case "home": return [];
    case "robot":
      if (b === "runs" || b === "run") return c ? [...O, "run", c] : [...O, "robot"];
      if (b === "claims") return [...O, "claims"];
      if (b === "setup") return [...O, "settings"];
      return [...O, "robot"];
    case "proof": return ["verify", ...p.slice(1, 3)];
    case "insurance":
      if (b === "insurer") return c ? ["app", "insurer", "claim", c] : ["app", "insurer"];
      return [...O, "claims"];
    case "insurer": return b ? ["app", "insurer", "claim", b] : ["app", "insurer"];
    case "offline": return [...O, "offline", ...(b === "courier" || b === "mesh" ? [b] : [])];
    case "courier": return [...O, "offline", "courier"];
    case "mesh": return [...O, "offline", "mesh"];
    case "account": case "setup": return [...O, "settings"];
    case "app":
      if (b === "owner" && c === "runs") return d ? [...O, "run", d] : [...O, "robot"];
      if (b === "owner" && c === "run" && !d) return [...O, "robot"];
      if (b === "insurer" && c === "claims") return ["app", "insurer"];
      return null;
  }
  return null;
}

export function parseRoute(p: string[], query = ""): Route {
  const [a, b, c, d] = p;
  if (!a) return { shell: "public", page: "landing" };
  if (a === "verify") return { shell: "public", page: "verify", runId: b, tamper: c === "tamper" };
  if (a === "kit") return { shell: "public", page: "kit" };
  if (a !== "app") return { shell: "public", page: "notfound", path: p.join("/") };
  const nf: Route = { shell: "app", page: "notfound", path: p.join("/") };
  if (!b) {
    const demo = new URLSearchParams(query).get("demo");
    return { shell: "app", page: "chooser", demo: demo === "owner" || demo === "insurer" ? demo : undefined };
  }
  if (b === "owner") {
    switch (c ?? "") {
      case "": return { shell: "app", ws: "owner", page: "overview" };
      case "robot": return { shell: "app", ws: "owner", page: "robot" };
      case "run": return d ? { shell: "app", ws: "owner", page: "run", runId: d } : nf;
      case "claims": return { shell: "app", ws: "owner", page: "claims" };
      case "offline": return { shell: "app", ws: "owner", page: "offline", section: d === "courier" || d === "mesh" ? d : undefined };
      case "settings": return { shell: "app", ws: "owner", page: "settings" };
    }
    return nf;
  }
  if (b === "insurer") {
    switch (c ?? "") {
      case "": return { shell: "app", ws: "insurer", page: "claims" };
      case "claim": return { shell: "app", ws: "insurer", page: "claims", claimId: d };
      case "pool": return { shell: "app", ws: "insurer", page: "pool" };
      case "settings": return { shell: "app", ws: "insurer", page: "settings" };
    }
  }
  return nf;
}

/** The hash split into path parts and the query after "?" (e.g. #/app?demo=owner). */
const split = (hash: string) => {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const parts = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  return { parts, query: q >= 0 ? raw.slice(q + 1) : "" };
};

/** Applies a legacy redirect if needed; returns the canonical parts + query. */
function canonical(): { parts: string[]; query: string } {
  const s = split(location.hash);
  const r = legacyRedirect(s.parts);
  if (r) {
    location.replace(href(...r));
    return { parts: r, query: "" };
  }
  return s;
}

/** Raw path parts of the current hash (after redirects), e.g. ["app", "owner", "run", "ep_…"]. */
export function useRoute(): { parts: string[]; query: string } {
  const [p, setP] = useState(canonical);
  useEffect(() => {
    const f = () => setP(canonical());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return p;
}

/** The current route, typed. */
export function useRouteInfo(): Route {
  const { parts, query } = useRoute();
  return parseRoute(parts, query);
}

/** True when the current hash is the public landing page (demo routing stays off there: it always shows real data). */
export const onLanding = () => split(location.hash).parts.length === 0;
