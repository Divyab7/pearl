// Thin client for the dashboard server (proxied by Vite to :8080) and the robot's live stream. While a demo workspace
// is on, every /api path goes to /demo-api instead (lib/demo.ts apiPath).
import { useEffect, useRef, useState } from "react";
import { apiPath } from "./lib/demo";

export { apiPath };

export async function get(path: string, init?: RequestInit) {
  const r = await fetch(apiPath(path), init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
  return body;
}

export async function post(path: string, body: unknown = {}) {
  const r = await fetch(apiPath(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error ?? `HTTP ${r.status}`), { status: r.status });
  return out;
}

/** Live state: telemetry, orchestrator status, records of the running run, and /api/state (refreshed on changes). */
export function useLive() {
  const [tel, setTel] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0); // bumps when runs, meta or zerobot change
  const [state, setState] = useState<any>(null);
  const [cut0g, setCut0g] = useState(false);
  const episodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (tick > 0) get("/api/state").then(setState).catch(() => {});
  }, [tick]);

  useEffect(() => {
    get("/api/state").then((s) => {
      setState(s);
      setTel(s.device ? { ...s.device, status: s.status, scene: s.scene } : null);
      setStatus(s.orchestrator);
      setCut0g(!!s.cut0g);
    }).catch(() => setConnected(false));
    const es = new EventSource(apiPath("/api/stream"));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("tel", (e) => setTel(JSON.parse(e.data)));
    es.addEventListener("status", (e) => {
      const s = JSON.parse(e.data);
      if (s.episodeId !== episodeRef.current) {
        episodeRef.current = s.episodeId;
        setRecords([]);
      }
      setStatus(s);
    });
    es.addEventListener("record", (e) => {
      const r = JSON.parse(e.data);
      setRecords((rs) => (rs.some((x) => x.idx === r.idx && x.episodeId === r.episodeId) ? rs : [...rs, r]));
    });
    for (const ev of ["episode", "meta", "zerobot"]) es.addEventListener(ev, () => setTick((t) => t + 1));
    es.addEventListener("cut0g", (e) => setCut0g(JSON.parse(e.data).on));
    return () => es.close();
  }, []);

  return { tel, status, records, connected, tick, cut0g, state };
}

/** Public links (explorer, storage indexer, contract addresses). */
export function useConfig() {
  const [c, setC] = useState<any>({});
  useEffect(() => {
    get("/api/config").then(setC).catch(() => {});
  }, []);
  return c;
}

/** One shortening rule everywhere: 0x1234…abcd for hex, first n…last 4 otherwise. */
export const short = (s?: string | null, n = 10) => {
  if (!s) return "—";
  if (/^0x[0-9a-fA-F]{12,}$/.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  return s.length > n + 6 ? `${s.slice(0, n)}…${s.slice(-4)}` : s;
};
export const og = (wei?: string | number | bigint | null) => {
  if (wei === null || wei === undefined) return "—";
  const v = Number(BigInt(wei)) / 1e18;
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 })} test 0G`;
};
export const when = (iso?: string | number | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
export const ago = (iso?: string | number | null) => {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
