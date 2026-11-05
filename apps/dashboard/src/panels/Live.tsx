import { useEffect, useState } from "react";
import { post } from "../api";
import { ArmView, ringClass } from "./ArmView";

const NAMES = ["base", "shoulder", "elbow", "gripper"];

const LABEL = { sim: "simulated arm", mujoco: "MuJoCo physics arm", serial: "hardware (USB)", ws: "hardware (Wi-Fi)" };

/** The camera the decisions use, refreshed twice a second (MuJoCo render or the phone camera). */
function LiveCamera() {
  const [t, setT] = useState(Date.now());
  const [ok, setOk] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (!ok) return null;
  return <img className="live-cam" alt="table camera" src={`/api/camera/live.jpg?t=${t}`} onError={() => setOk(false)} />;
}


export function Live({ tel, status, cut0g, deviceKind, cameraKind, modules }) {
  const [color, setColor] = useState("red");
  const [from, setFrom] = useState("A2");
  const [msg, setMsg] = useState("");
  const act = (p, body) => post(p, body).then((r) => setMsg(r.note ?? r.episodeId ?? "ok")).catch((e) => setMsg(e.message));
  const st = tel?.state ?? "—";
  return (
    <section className="panel live">
      <header>
        <h2>Live</h2>
        <span className={`badge state-${st}`}>{st}</span>
        <span className="muted">{status?.phase ?? ""}</span>
      </header>
      <ArmView joints={tel?.joints} scene={tel?.scene} ring={ringClass(tel?.status?.ring)} label={LABEL[deviceKind] ?? "arm"} />
      {cameraKind && cameraKind !== "none" && <LiveCamera />}
      <div className="bars">
        {NAMES.map((n, i) => (
          <div key={n} className="bar">
            <span>{n}</span>
            <meter min={0} max={180} value={tel?.joints?.[i] ?? 0} />
            <b>{tel?.joints?.[i] ?? "—"}°</b>
          </div>
        ))}
      </div>
      <dl className="sensors">
        <dt>ToF</dt><dd>{tel ? `${tel.tofMm} mm` : "—"}</dd>
        <dt>accel</dt><dd>{tel ? `${tel.accG.toFixed(2)} g` : "—"}</dd>
        <dt>heartbeat</dt><dd>{tel ? `${tel.hbAgeMs} ms` : "—"}</dd>
        <dt>ring</dt><dd>{tel?.status?.ring ?? "—"}</dd>
        <dt>buzzer</dt><dd>{tel?.status?.buzzer ?? "—"}</dd>
      </dl>
      <div className="controls">
        <label>colour <select value={color} onChange={(e) => setColor(e.target.value)}><option>red</option><option>blue</option></select></label>
        <label>from <select value={from} onChange={(e) => setFrom(e.target.value)}><option>A1</option><option>A2</option><option>A3</option></select></label>
        <button className="primary" onClick={() => act("/api/episode/start", { color, from })}>Start episode</button>
        {modules?.robotZerobot === "on" && (
          <button onClick={() => act("/api/zerobot/dispatch", { color, from })} title="dispatches RUN_EPISODE through 0G zerobot on Galileo">Start via zerobot</button>
        )}
      </div>
      <div className="controls">
        <button onClick={() => act("/api/control/stop")}>Stop</button>
        <button onClick={() => act("/api/control/safe")}>Safe</button>
        <button onClick={() => act("/api/control/reset")}>Reset</button>
        <button className={cut0g ? "danger on" : "danger"} onClick={() => act("/api/control/cut0g", { on: !cut0g })}>{cut0g ? "0G is CUT" : "Cut 0G"}</button>
      </div>
      {(deviceKind === "sim" || deviceKind === "mujoco") && (
        <div className="controls">
          <span className="muted">inject:</span>
          <button onClick={() => act("/api/sim/inject", { kind: "hand", ms: 2500 })}>Hand</button>
          <button onClick={() => act("/api/sim/inject", { kind: "bump" })}>Bump</button>
          <button onClick={() => act("/api/sim/inject", { kind: "nohb" })}>No heartbeat</button>
          {deviceKind === "mujoco" && <button onClick={() => act("/api/sim/reset-table")}>Reset table</button>}
        </div>
      )}
      {msg && <p className="msg">{msg}</p>}
    </section>
  );
}
