import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { ArmView } from "./ArmView";
import { DecisionCard } from "./Decisions";

/** Expands commandsSent into joint keyframes (move:[...] and grip:open|close), starting from home. */
function keyframes(log, gripOpen = 10, gripClosed = 80) {
  let j = [90, 90, 90, 10];
  const frames = [{ joints: j, idx: -1 }];
  for (const r of log.records) {
    if (r.kind !== "decision") continue;
    for (const c of r.commandsSent) {
      if (c.startsWith("move:")) j = JSON.parse(c.slice(5));
      else if (c === "grip:close") j = [j[0], j[1], j[2], gripClosed];
      else if (c === "grip:open") j = [j[0], j[1], j[2], gripOpen];
      else if (c === "safe") j = [90, 120, 60, 10];
      else continue;
      frames.push({ joints: j, idx: r.idx });
    }
  }
  return frames;
}

export function Replay({ episodeId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [pos, setPos] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    if (!episodeId) return;
    setData(null);
    setErr("");
    setPos(0);
    get(`/api/replay/${episodeId}`)
      .then((r) => setData({ from: `0G Storage root ${r.rootHash}`, log: r.log }))
      .catch((e) =>
        get(`/api/episodes/${episodeId}`).then((log) => {
          setErr(`not from 0G Storage: ${e.message}`);
          setData({ from: "local copy", log });
        }),
      );
  }, [episodeId]);

  const frames = data ? keyframes(data.log) : [];
  const play = () => {
    clearInterval(timer.current);
    setPos(0);
    let p = 0;
    timer.current = setInterval(() => {
      p += 0.05;
      if (p >= frames.length - 1) {
        p = frames.length - 1;
        clearInterval(timer.current);
      }
      setPos(p);
    }, 50);
  };
  useEffect(() => () => clearInterval(timer.current), []);

  const i = Math.floor(pos);
  const a = frames[i]?.joints ?? [90, 90, 90, 10];
  const b = frames[Math.min(i + 1, frames.length - 1)]?.joints ?? a;
  const f = pos - i;
  const joints = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  const currentIdx = frames[Math.min(i + 1, frames.length - 1)]?.idx;
  const decision = data?.log.records.find((r) => r.idx === currentIdx);

  return (
    <section className="panel replay">
      <header><h2>Replay</h2><span className="muted">{episodeId ?? "select an episode"}</span></header>
      {!episodeId && <p className="muted">Pick an episode from the list.</p>}
      {data && (
        <>
          <p className={err ? "warn" : "ok"}>{err || `downloaded from ${data.from}`}</p>
          <ArmView joints={joints} scene={null} ring="" label={`${data.log.outcome} · ${frames.length - 1} moves`} />
          <div className="controls">
            <button className="primary" onClick={play} disabled={frames.length < 2}>Play</button>
            <input type="range" min={0} max={Math.max(0, frames.length - 1)} step={0.01} value={pos} onChange={(e) => setPos(Number(e.target.value))} />
          </div>
          {decision && <DecisionCard r={decision} />}
        </>
      )}
    </section>
  );
}
