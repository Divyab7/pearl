// Thin client for the backend API (proxied by Vite to :8080) and the SSE live stream.
import { useEffect, useRef, useState } from "react";

export async function get(path) {
  const r = await fetch(path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function post(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error ?? `HTTP ${r.status}`);
  return out;
}

/** Live state: telemetry, orchestrator status, records of the running episode, and /api/state (refreshed on changes). */
export function useLive() {
  const [tel, setTel] = useState(null);
  const [status, setStatus] = useState(null);
  const [records, setRecords] = useState([]);
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0); // bumps when episodes, meta or zerobot change
  const [state, setState] = useState(null);
  const [cut0g, setCut0g] = useState(false);
  const episodeRef = useRef(null);

  useEffect(() => {
    if (tick > 0) get("/api/state").then(setState).catch(() => {});
  }, [tick]);

  useEffect(() => {
    get("/api/state").then((s) => {
      setState(s);
      setTel(s.device ? { ...s.device, status: s.status, scene: s.scene } : null);
      setStatus(s.orchestrator);
      setCut0g(!!s.cut0g);
    }).catch(() => {});
    const es = new EventSource("/api/stream");
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

export const short = (s, n = 10) => (s ? (s.length > n + 2 ? `${s.slice(0, n)}…` : s) : "—");
