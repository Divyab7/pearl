// Demo workspaces (owner decision 6 Nov 2026): "Try the insurer demo" / "Try the owner demo" open the app on clearly
// labelled sample data served by the dashboard server at /demo-api (same API surface as /api, isolated, resets on
// restart). While a demo is on (sessionStorage `pearl.demo`), every /api/... call from the app goes to /demo-api/...:
// api.ts get/post/EventSource use apiPath(); direct fetch() and EventSource calls are rewritten by installDemoRouting().
// The landing page (#/) always shows real data.
import { useEffect, useState } from "react";
import { onLanding, to } from "../router";

export type DemoRole = "owner" | "insurer";
const FLAG = "pearl.demo";
const KEYS = "pearl.demo.keys"; // localStorage: what enterDemo put there, so exitDemo can take it away again
const EVT = "pearl-demo";

/** The demo role of this tab, or null. */
export function demoRole(): DemoRole | null {
  try {
    const v = sessionStorage.getItem(FLAG);
    return v === "owner" || v === "insurer" ? v : null;
  } catch {
    return null;
  }
}

/** True when calls should go to /demo-api right now (a demo is on and this isn't the landing page). */
export const demoActive = () => !!demoRole() && !onLanding();

/** /api/x → /demo-api/x while a demo is on; anything else unchanged. */
export function apiPath(path: string): string {
  if (!demoActive()) return path;
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return `/demo-api${path.slice(4)}`;
  return path;
}

/** Patches window.fetch and EventSource once, so direct calls (courier, frames, mesh, camera) follow the demo too. */
export function installDemoRouting() {
  const w = window as any;
  if (w.__pearlDemoRouting) return;
  w.__pearlDemoRouting = true;
  const f = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (typeof input === "string" ? f(apiPath(input), init) : f(input, init))) as typeof fetch;
  const ES = window.EventSource;
  if (ES) {
    window.EventSource = class extends ES {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(typeof url === "string" ? apiPath(url) : url, init);
      }
    } as typeof EventSource;
  }
}

type Stored = { slot: string; prev: string | null }[];
const slot = (role: DemoRole, who: string) => `pearl.unlock.${role}.${who.toLowerCase()}`;

function putKey(stored: Stored, key: string, value: string) {
  stored.push({ slot: key, prev: localStorage.getItem(key) });
  localStorage.setItem(key, value);
}

function removeDemoKeys() {
  try {
    const stored: Stored = JSON.parse(localStorage.getItem(KEYS) ?? "[]");
    // newest first, so a slot written twice ends at its original value
    for (const s of [...stored].reverse()) s.prev === null ? localStorage.removeItem(s.slot) : localStorage.setItem(s.slot, s.prev);
  } catch { /* nothing stored */ }
  localStorage.removeItem(KEYS);
}

/** What a robot action says in a demo (the demo server answers 409 to every robot action). */
export const DEMO_ACTIONS_NOTE = "Actions are off in the demo — the live robot is in the real app.";

const notify = () => dispatchEvent(new Event(EVT));

export class DemoUnavailable extends Error {
  constructor() {
    super("Demo isn't available on this server.");
  }
}

/** Starts a demo workspace: asks the server for a demo session and installs the sample unlock keys in this browser. */
export async function enterDemo(role: DemoRole): Promise<void> {
  let r: Response;
  try {
    r = await fetch("/demo-api/demo/enter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }), credentials: "same-origin" });
  } catch {
    throw new DemoUnavailable();
  }
  const body = r.ok && (r.headers.get("content-type") ?? "").includes("json") ? await r.json().catch(() => null) : null;
  if (!body) throw new DemoUnavailable();
  removeDemoKeys();
  const stored: Stored = [];
  const put = (who: DemoRole, id?: string, rec?: unknown) => {
    if (!id || !rec || typeof rec !== "object") return;
    putKey(stored, slot(who, id), JSON.stringify(rec));
    // the sample key counts as backed up, so the owner checklist isn't nagging about a demo key
    const kid = (rec as any).kid;
    if (kid) putKey(stored, `pearl.backup.${kid}`, new Date().toISOString());
  };
  put("owner", body.owner?.accountId, body.owner?.keyRecord);
  put("insurer", body.insurer?.address, body.insurer?.keyRecord);
  localStorage.setItem(KEYS, JSON.stringify(stored));
  sessionStorage.setItem(FLAG, role);
  notify();
}

/** Leaves the demo: ends the demo session, removes the sample keys, opens the workspace chooser. */
export async function exitDemo(): Promise<void> {
  await fetch("/demo-api/demo/exit", { method: "POST" }).catch(() => {});
  removeDemoKeys();
  sessionStorage.removeItem(FLAG);
  notify();
  location.hash = to.app();
}

/** The demo role of this tab, live. */
export function useDemo() {
  const [role, setRole] = useState(demoRole);
  useEffect(() => {
    const f = () => setRole(demoRole());
    addEventListener(EVT, f);
    return () => removeEventListener(EVT, f);
  }, []);
  return { role, active: !!role, enter: enterDemo, exit: exitDemo };
}
