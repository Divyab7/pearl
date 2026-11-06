// Robot (#/robot): watch the robot live, see what it's doing step by step, give it a task, and read its runs.
// One run's story lives at #/robot/run/<id> (components/RunStory.tsx, owner mode; unlock works with the robot offline).
import { useEffect, useRef, useState } from "react";
import { get, post, useLive } from "../api";
import { to } from "../router";
import { ringClass } from "../components/ArmView";
import { ArmView3D, type ArmProps } from "../components/ArmView3D";
import { EmptyState, ErrorState, InfoTip, PageHeader, RunRow, Section, Skeleton, StatusPill, TechDetails } from "../components/blocks";
import { RunStory, runTime, SEVERITY_WORD } from "../components/RunStory";
import { Dl, Icon, Spinner, Stepper, verdictOf, type Step, type VerdictKind } from "../components/ui";
import { useAccount } from "../lib/account";
import { ownerUnlock } from "../lib/ownerUnlock";
import { outcomeWord, OUTCOME_TONE, ROBOT_LINK, ROBOT_STATE, TIP } from "../lib/words";
import "./robot.css";

type Live = ReturnType<typeof useLive>;

const DEVICE_LABEL: Record<string, string> = { sim: "Simulated arm", mujoco: "Physics-simulated arm", serial: "Robot arm (USB)", ws: "Robot arm (Wi-Fi)" };
const STATE_TONE: Record<string, "neutral" | "info" | "warn" | "bad"> = { IDLE: "neutral", MOVING: "info", WAITING: "info", FROZEN_HAND: "warn", SAFE: "bad", TRIPPED: "bad" };
const TERMINAL = ["DONE", "ABORTED", "FAILSAFE_STOPPED", "TRIPPED"];

export function Robot({ live, runId }: { live: Live; runId?: string }) {
  const { account } = useAccount(live.tick);
  if (runId) return <RunPage live={live} account={account} runId={runId} />;
  return <RobotHome live={live} />;
}

// ---------------------------------------------------------------- one run's story (owner)
function RunPage({ live, account, runId }: { live: Live; account: any; runId: string }) {
  const u = ownerUnlock(live, account);
  const action = account === undefined ? null
    : !account ? <a className="btn" href={to.account()}>Owner sign-in</a>
      : u.next === "setup" ? <a className="btn" href={to.account()}>Go to Account</a> : null;
  return (
    <div className="page rb-page">
      <a className="rb-back" href={to.robot()}><Icon name="arrow" size={14} /> <span>Robot and all runs</span></a>
      <RunStory
        episodeId={runId}
        mode="owner"
        titleAs="h1"
        tick={live.tick}
        unlock={u.unlock ? () => u.unlock!(runId) : null}
        lockedReason={account === undefined ? "Checking your sign-in…" : u.reason}
        lockedAction={action}
        actions={<a className="btn ghost" href={to.proof(runId)}>Share proof</a>}
      />
    </div>
  );
}

// ---------------------------------------------------------------- the robot: live + runs
function RobotHome({ live }: { live: Live }) {
  const { tel, status, state } = live;
  const [access, setAccess] = useState<any>(undefined);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    get("/api/access").then(setAccess).catch(() => setAccess(null));
  }, [live.tick]);
  const allowed = !!access?.allowed;
  const online = live.connected !== false && !!state?.device;
  const name: string = state?.deviceId ?? "Robot";

  const act = (label: string, path: string, body?: unknown, done?: string) => {
    setBusy(label);
    setMsg(null);
    return post(path, body)
      .then((r) => setMsg({ tone: "ok", text: done ?? r.note ?? `${label}: done.` }))
      .catch((e) => setMsg({ tone: "bad", text: `${label}: ${e.message}` }))
      .finally(() => setBusy(""));
  };

  const stateWord = tel?.state ? ROBOT_STATE[tel.state] ?? tel.state : null;
  return (
    <div className="page rb-page">
      <PageHeader
        title={<>Robot <span className="rb-name">{name}</span></>}
        description={
          <span className="rb-sub">
            <StatusPill tone={online ? "ok" : live.connected === null && !state ? "neutral" : "bad"} pulse={online}>
              {online ? ROBOT_LINK.online : live.connected === null && !state ? ROBOT_LINK.connecting : ROBOT_LINK.offline}
            </StatusPill>
            {state?.deviceKind && <span>{DEVICE_LABEL[state.deviceKind] ?? "Robot arm"}</span>}
            {online && stateWord && <StatusPill tone={STATE_TONE[tel.state] ?? "neutral"}>{stateWord}</StatusPill>}
          </span>
        }
        actions={online && allowed ? (
          <button type="button" className="btn rb-stop" onClick={() => act("Stop", "/api/control/stop", undefined, "Stop sent. The robot stops where it is.")}>
            <Icon name="x" size={16} /> Stop the robot
          </button>
        ) : null}
      />

      {online ? <LivePanel live={live} access={access} busy={busy} act={act} msg={msg} /> : (
        <section className="rb-offline" aria-label="Live view">
          {live.connected === null && !state ? <Skeleton height={280} label="Connecting to the robot" /> : (
            <EmptyState icon="offline" title="The robot is offline">
              Its runs are still listed below from their public labels, and you can still unlock them with your key.
            </EmptyState>
          )}
        </section>
      )}

      <RunsSection live={live} />
    </div>
  );
}

// ---------------------------------------------------------------- live panel
function LivePanel({ live, access, busy, act, msg }: {
  live: Live; access: any; busy: string; act: (label: string, path: string, body?: unknown, done?: string) => Promise<void>; msg: { tone: "ok" | "bad"; text: string } | null;
}) {
  const { tel, status, records, state, cut0g } = live;
  const hasCam = !!state?.cameraKind && state.cameraKind !== "none";
  const arm: ArmProps = { joints: tel?.joints, scene: tel?.scene, ring: ringClass(tel?.status?.ring), label: DEVICE_LABEL[state?.deviceKind] ?? "arm", showAngles: false };
  const allowed = !!access?.allowed;
  return (
    <div className="rb-live">
      <section className="rb-cam-col" aria-label="Live view">
        {hasCam ? <LiveCamera orbit={state?.deviceKind === "mujoco"} arm={arm} /> : <div className="rb-arm-only"><ArmView3D {...arm} /></div>}
        <TechDetails label="Sensors">
          <Dl rows={[
            ["Joint angles", tel?.joints ? tel.joints.map((j: number) => `${j}°`).join(" · ") : "—"],
            ["Distance sensor", tel ? `${tel.tofMm} mm` : "—"],
            ["Acceleration", tel ? `${Number(tel.accG).toFixed(2)} g` : "—"],
            ["Heartbeat", tel ? `${tel.hbAgeMs} ms ago` : "—"],
            ["Status light", tel?.status?.ring ?? "—"],
          ]} />
        </TechDetails>
      </section>

      <div className="rb-side">
        <section className="rb-doing" aria-labelledby="rb-doing-t">
          <h2 className="sect-title" id="rb-doing-t">What it's doing</h2>
          <LiveStepper live={live} />
          <LatestAnswer records={records} hasCam={hasCam} episodeId={status?.episodeId} />
          <TaskForm live={live} access={access} busy={busy} act={act} />
          <div aria-live="polite" className="rb-msg-wrap">{msg && <p className={`rb-msg tone-${msg.tone}`} role={msg.tone === "bad" ? "alert" : undefined}><Icon name={msg.tone === "ok" ? "check" : "alert"} size={14} /> {msg.text}</p>}</div>
        </section>
        {allowed && <Drills live={live} cut0g={cut0g} act={act} busy={busy} />}
      </div>
    </div>
  );
}

/** The fixed AI camera, a server-rendered 3D view (drag to orbit) or a 3D model drawn from telemetry. */
const VIEW0 = { az: 150, el: -32, dist: 0.55 };
function LiveCamera({ orbit, arm }: { orbit: boolean; arm: ArmProps }) {
  const [src, setSrc] = useState<string | null>(null);
  const [down, setDown] = useState(false);
  const [mode, setMode] = useState<"3d" | "model" | "ai">(orbit ? "3d" : "ai");
  const view = useRef({ ...VIEW0 });
  const drag = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    let alive = true;
    let timer: any;
    let last: string | null = null;
    const next = async () => {
      const t0 = Date.now();
      if (modeRef.current === "model" || document.hidden) {
        timer = setTimeout(next, 300);
        return;
      }
      const v = view.current;
      const url = modeRef.current === "3d"
        ? `/api/camera/view.jpg?az=${v.az.toFixed(1)}&el=${v.el.toFixed(1)}&dist=${v.dist.toFixed(3)}&t=${t0}`
        : `/api/camera/live.jpg?t=${t0}`;
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const obj = URL.createObjectURL(await r.blob());
        if (!alive) return URL.revokeObjectURL(obj);
        setSrc(obj);
        setDown(false);
        if (last) URL.revokeObjectURL(last);
        last = obj;
      } catch {
        if (alive) setDown(true);
      }
      if (alive) timer = setTimeout(next, Math.max(30, (drag.current ? 60 : 250) - (Date.now() - t0)));
    };
    void next();
    return () => {
      alive = false;
      clearTimeout(timer);
      if (last) URL.revokeObjectURL(last);
    };
  }, []);
  const is3d = orbit && mode === "3d";
  const onDown = (e: React.PointerEvent) => {
    if (!is3d) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, az: view.current.az, el: view.current.el };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    view.current.az = d.az - (e.clientX - d.x) * 0.4;
    view.current.el = Math.max(-89, Math.min(-5, d.el - (e.clientY - d.y) * 0.3));
  };
  const onUp = () => (drag.current = null);
  const onWheel = (e: React.WheelEvent) => {
    if (!is3d) return;
    view.current.dist = Math.max(0.2, Math.min(1.5, view.current.dist * (e.deltaY > 0 ? 1.08 : 1 / 1.08)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!is3d) return;
    const v = view.current;
    if (e.key === "ArrowLeft") v.az += 8;
    else if (e.key === "ArrowRight") v.az -= 8;
    else if (e.key === "ArrowUp") v.el = Math.max(-89, v.el - 6);
    else if (e.key === "ArrowDown") v.el = Math.min(-5, v.el + 6);
    else if (e.key === "+" || e.key === "=") v.dist = Math.max(0.2, v.dist / 1.1);
    else if (e.key === "-") v.dist = Math.min(1.5, v.dist * 1.1);
    else if (e.key === "0") view.current = { ...VIEW0 };
    else return;
    e.preventDefault();
  };
  const views: [typeof mode, string][] = [...(orbit ? [["3d", "3D view"] as [typeof mode, string]] : []), ["model", "3D model"], ["ai", "AI camera"]];
  const hint = mode === "ai" ? "The fixed camera the AI decides from" : mode === "model" ? "Drawn in your browser from the robot's sensors" : "Drag or use arrow keys to turn · scroll or +/− to zoom";
  return (
    <figure className={`cam rb-cam ${is3d ? "orbit" : ""}`}>
      {mode === "model"
        ? <ArmView3D {...arm} label={undefined} showAngles={false} />
        : (
          <div className="cam-stage" tabIndex={is3d ? 0 : -1} aria-label={is3d ? "3D view of the robot's table. Arrow keys turn, plus and minus zoom, 0 resets." : undefined}
            onKeyDown={onKey} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} onDoubleClick={() => (view.current = { ...VIEW0 })}>
            {src ? <img className="live-cam" alt={is3d ? "3D view of the robot's table" : "What the AI camera sees right now"} src={src} draggable={false} /> : <div className="cam-wait"><Spinner label="Connecting" /> Connecting to the camera…</div>}
          </div>
        )}
      <figcaption className="cam-tags">
        <span className={`cam-live ${down && mode !== "model" ? "off" : ""}`}>{down && mode !== "model" ? "Camera offline" : "Live"}</span>
      </figcaption>
      <div className="cam-bar">
        <div className="seg" role="group" aria-label="View">
          {views.map(([id, word]) => <button key={id} type="button" className={mode === id ? "on" : ""} aria-pressed={mode === id} onClick={() => setMode(id)}>{word}</button>)}
        </div>
        <span className="muted small">{hint}</span>
      </div>
    </figure>
  );
}

/** Plan → Grip → Drop → Locked → Recorded, from the live phase, the decisions so far and the run's record. */
function LiveStepper({ live }: { live: Live }) {
  const { status, records, tick } = live;
  const phase: string = status?.phase ?? "IDLE";
  const ep: string | null = status?.episodeId ?? null;
  const ended = TERMINAL.includes(phase);
  const [meta, setMeta] = useState<any>(null);
  useEffect(() => {
    if (!ep || !ended) return setMeta(null);
    let alive = true;
    get(`/api/episodes/${encodeURIComponent(ep)}/meta`).then((m) => alive && setMeta(m)).catch(() => {});
    // the record lands a few seconds after the run ends: poll briefly in case an event is missed
    const t = setInterval(() => get(`/api/episodes/${encodeURIComponent(ep)}/meta`).then((m) => alive && setMeta(m)).catch(() => {}), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ep, ended, tick]);

  if (!ep) {
    return <p className="muted rb-idle">No run yet. Give it a task below and each step lights up here as it happens.</p>;
  }
  const has = (cp: string) => records.some((r: any) => r.kind === "decision" && r.checkpoint === cp);
  const incidentNow = phase === "INCIDENT_DECIDING";
  const at = phase === "PLANNING" ? 0 : ["MOVING_TO_PICK", "VERIFYING_GRASP"].includes(phase) ? 1 : ["MOVING_TO_PLACE", "VERIFYING_PLACE"].includes(phase) ? 2
    : incidentNow ? (has("VERIFY_GRASP") ? 2 : has("PLAN") ? 1 : 0) : -1;
  const failedAt = phase === "DONE" || !ended ? -1 : !has("PLAN") ? 0 : !has("VERIFY_GRASP") ? 1 : 2;
  const recorded = meta?.anchor?.status === "ok" || meta?.relay?.state === "done";
  const relayWaiting = meta?.relay && ["queued", "sent", "submitting"].includes(meta.relay.state);
  const recFailed = meta?.anchor?.status === "failed" && !meta?.relay;
  const base = ["Plan", "Grip", "Drop"].map((label, i): Step => {
    if (ended) return { label, state: phase === "DONE" ? "done" : i < failedAt ? "done" : i === failedAt ? "failed" : "todo" };
    // running: if we missed the start (page opened mid-run), infer from the phase
    const done = i < at || (i === 0 && has("PLAN") && at !== 0) || (i === 1 && has("VERIFY_GRASP") && at > 1);
    return { label, state: done ? "done" : i === at ? "active" : "todo", ...(i === at && incidentNow ? { note: "safety pause" } : {}) };
  });
  const steps: Step[] = [
    ...base,
    { label: "Locked", state: ended ? "done" : "todo" },
    { label: "Recorded", state: !ended ? "todo" : recorded ? "done" : recFailed ? "failed" : "active", ...(ended && !recorded && relayWaiting ? { note: "no internet: waiting" } : ended && !recorded && !recFailed ? { note: "sending" } : {}) },
  ];
  const sentence = !ended
    ? (incidentNow ? "Safety pause: the AI is judging what happened." : phase === "PLANNING" ? "Looking at the table and planning the pick." : at === 1 ? "Picking up the cube." : at === 2 ? "Carrying it to the bin." : "Working.")
    : phase === "DONE" ? (recorded ? "Done, locked and recorded." : "Done and locked. Recording it now.")
      : `${outcomeWord(phase === "FAILSAFE_STOPPED" ? "FAILSAFE" : phase)}. The run is still locked and recorded as proof.`;
  return (
    <div className="rb-stepper">
      <Stepper steps={steps} />
      <p className={`rb-sentence ${ended && phase !== "DONE" ? "tone-warn" : ""}`} aria-live="polite">{sentence}</p>
      {ended && (
        <a className="btn rb-story-link" href={to.run(ep)}>Open this run's story <Icon name="arrow" size={14} /></a>
      )}
    </div>
  );
}

const CP_WORD: Record<string, string> = { PLAN: "Planning", VERIFY_GRASP: "Checking the grip", VERIFY_PLACE: "Checking the drop", INCIDENT: "Judging an incident" };

/** The AI's latest answer, in its own words, with a camera snapshot taken as it arrived. */
function LatestAnswer({ records, hasCam, episodeId }: { records: any[]; hasCam: boolean; episodeId?: string | null }) {
  const last = [...records].reverse().find((r) => r.kind === "decision");
  const [snap, setSnap] = useState<{ idx: number; url: string } | null>(null);
  useEffect(() => {
    if (!last || !hasCam) return;
    let alive = true;
    let url = "";
    fetch(`/api/camera/live.jpg?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(b);
        setSnap({ idx: last.idx, url });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [last?.idx, last?.episodeId, hasCam]);
  useEffect(() => () => { if (snap) URL.revokeObjectURL(snap.url); }, [snap?.url]);
  useEffect(() => setSnap(null), [episodeId]);
  if (!last) return null;
  const p = last.parsed ?? {};
  const failsafe = last.source !== "0g";
  return (
    <div className={`rb-answer ${failsafe ? "tone-bad" : ""}`}>
      {snap && snap.idx === last.idx && <img className="rb-snap" src={snap.url} alt="The camera view as the AI answered" />}
      <div className="rb-answer-text">
        <div className="rb-answer-head">
          <span className="eyebrow">{failsafe ? "AI unreachable" : `Latest AI answer · ${CP_WORD[last.checkpoint] ?? last.checkpoint}`}</span>
          <InfoTip text={TIP.ogCompute} />
        </div>
        {failsafe
          ? <p>The robot couldn't reach the AI, so it stopped safely on its own.</p>
          : <blockquote className="rb-quote">“{p.reason ?? String(p.action ?? "").toLowerCase()}”</blockquote>}
        {!failsafe && typeof p.confidence === "number" && <span className="rb-conf">{Math.round(p.confidence * 100)}% sure</span>}
        {last.override && <p className="small rb-override">A safety rule kept the arm stopped.</p>}
      </div>
    </div>
  );
}

function TaskForm({ live, access, busy, act }: { live: Live; access: any; busy: string; act: (label: string, path: string, body?: unknown, done?: string) => Promise<void> }) {
  const { status, state } = live;
  const [color, setColor] = useState("red");
  const [from, setFrom] = useState("A2");
  const running = !!status?.episodeId && !TERMINAL.includes(status.phase) && status.phase !== "IDLE";
  if (access === undefined) return <Skeleton height={44} label="Checking access" />;
  if (!access?.allowed) {
    return (
      <div className="rb-viewonly">
        <StatusPill tone="neutral"><Icon name="eye" size={14} /> View only</StatusPill>
        <span className="muted small">{access?.why ?? "Only the robot's signed-in owner can operate it."} <a href={to.account()}>Owner sign-in</a></span>
      </div>
    );
  }
  return (
    <form className="rb-task" onSubmit={(e) => { e.preventDefault(); void act("Start", "/api/episode/start", { color, from }, "Run started. Watch the steps above."); }}>
      <span className="rb-task-label" id="rb-task-l">Task</span>
      <label className="rb-sel"><span className="sr-only">Cube colour</span>
        <select value={color} onChange={(e) => setColor(e.target.value)} aria-describedby="rb-task-l"><option value="red">Red cube</option><option value="blue">Blue cube</option></select>
      </label>
      <label className="rb-sel"><span className="sr-only">From slot</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-describedby="rb-task-l"><option value="A1">from A1</option><option value="A2">from A2</option><option value="A3">from A3</option></select>
      </label>
      <button type="submit" className="btn primary" disabled={!!busy || running}>{busy === "Start" ? <Spinner label="Starting" /> : null} {running ? "Running…" : "Start run"}</button>
      {state?.modules?.robotZerobot === "on" && (
        <span className="rb-remote">
          <button type="button" className="btn ghost" disabled={!!busy || running} onClick={() => act("Start remotely", "/api/zerobot/dispatch", { color, from }, "Task sent on 0G Chain. The robot picks it up in a few seconds.")}>Start remotely</button>
          <InfoTip text="Sends the task as a signed command on 0G Chain; the robot picks it up from there, so it can be told what to do from anywhere." />
        </span>
      )}
    </form>
  );
}

function Drills({ live, cut0g, act, busy }: { live: Live; cut0g: boolean; act: (label: string, path: string, body?: unknown, done?: string) => Promise<void>; busy: string }) {
  const { state } = live;
  const sim = state?.deviceKind === "sim" || state?.deviceKind === "mujoco";
  const [netPick, setNetPick] = useState<boolean | null>(null);
  const netOff = netPick ?? state?.net === "offline";
  useEffect(() => setNetPick(null), [state?.net]);
  return (
    <div className="rb-drills-row">
      <details className="rb-drills">
        <summary><Icon name="chevron" size={14} /> Drills <span className="muted small">practise what happens when things go wrong</span></summary>
        <div className="rb-drill-grid">
          <button type="button" className={`btn ${cut0g ? "rb-on" : ""}`} aria-pressed={cut0g} disabled={!!busy}
            onClick={() => act(cut0g ? "Restore the AI" : "Cut the AI", "/api/control/cut0g", { on: !cut0g }, cut0g ? "AI connection restored." : "AI cut. The robot must stop safely on its own at the next step.")}>
            {cut0g ? "Restore 0G" : "Cut 0G"}<span>{cut0g ? "the AI is cut" : "lose the AI"}</span>
          </button>
          <button type="button" className={`btn ${netOff ? "rb-on" : ""}`} aria-pressed={netOff} disabled={!!busy}
            onClick={() => act(netOff ? "Restore internet" : "Cut internet", "/api/sim/net", { online: netOff }, netOff ? "Internet restored: the robot sends what it kept." : "Internet cut: the robot keeps its records and hands them to the laptop or a nearby phone.").then(() => setNetPick(!netOff))}>
            {netOff ? "Restore internet" : "Cut internet"}<span>{netOff ? "robot is offline" : "proof still gets out"}</span>
          </button>
          {sim && <>
            <button type="button" className="btn" disabled={!!busy} onClick={() => act("Bump", "/api/sim/inject", { kind: "bump" }, "Bump sent. The arm should stop itself.")}>Bump<span>knock the arm</span></button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => act("Hand in zone", "/api/sim/inject", { kind: "hand", ms: 2500 }, "A hand is in the work zone for 2.5 s.")}>Hand in zone<span>arm should pause</span></button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => act("Drop heartbeat", "/api/sim/inject", { kind: "nohb" }, "Heartbeat dropped. The arm should stop itself.")}>Drop heartbeat<span>lose the link</span></button>
            {state?.deviceKind === "mujoco" && <button type="button" className="btn" disabled={!!busy} onClick={() => act("Reset table", "/api/sim/reset-table", undefined, "Table reset: cubes back in their slots.")}>Reset table<span>cubes back in place</span></button>}
          </>}
        </div>
      </details>
      <div className="rb-secondary">
        <button type="button" className="btn ghost" disabled={!!busy} onClick={() => act("Safe pose", "/api/control/safe", undefined, "Moving to the safe pose.")}>Safe pose</button>
        <button type="button" className="btn ghost" disabled={!!busy} onClick={() => act("Reset after a trip", "/api/control/reset", undefined, "Reset sent.")} title="On a hardware arm, also press BOOT on the arm within 10 s">Reset after a trip</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- runs list
const verdictCache = new Map<string, VerdictKind | "err">();
/** Checks the shown runs in the background (two at a time) and remembers each verdict for this session. */
function useVerdicts(ids: string[], device?: string) {
  const [, bump] = useState(0);
  const key = ids.join();
  useEffect(() => {
    let alive = true;
    const todo = ids.filter((id) => !verdictCache.has(id));
    const worker = async () => {
      while (alive && todo.length) {
        const id = todo.shift()!;
        try {
          const v = await get(`/api/verify/${encodeURIComponent(id)}${device ? `?device=${encodeURIComponent(device)}` : ""}`);
          verdictCache.set(id, verdictOf(v));
        } catch {
          verdictCache.set(id, "err");
        }
        if (alive) bump((n) => n + 1);
      }
    };
    void worker();
    void worker();
    return () => {
      alive = false;
    };
  }, [key, device]);
  return (id: string) => verdictCache.get(id);
}

const PAGE_SIZE = 8;
function RunsSection({ live }: { live: Live }) {
  const [filter, setFilter] = useState<"all" | "incident">("all");
  const [list, setList] = useState<any>(undefined);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    get(`/api/episodes${filter === "incident" ? "?kind=incident" : ""}`)
      .then((l) => { if (alive) { setList(l); setErr(""); } })
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [live.tick, filter, retry]);
  useEffect(() => setShown(PAGE_SIZE), [filter]);
  const items: any[] = list?.items ?? [];
  const visible = items.slice(0, shown);
  const verdict = useVerdicts(visible.map((e) => e.episodeId), list?.device);
  const source = list?.source === "arkiv" ? "Read from Arkiv, the public search labels the robot writes for each run."
    : list?.source === "device" ? "Read from the robot itself (the public search labels aren't available right now)." : null;
  return (
    <Section
      title="Runs"
      info={TIP.arkiv}
      description={source ?? "Every run the robot finished, newest first."}
      actions={
        <div className="seg" role="group" aria-label="Show">
          <button type="button" className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
          <button type="button" className={filter === "incident" ? "on" : ""} aria-pressed={filter === "incident"} onClick={() => setFilter("incident")}>Incidents</button>
        </div>
      }
    >
      {list === undefined && !err ? <Skeleton lines={4} label="Loading runs" />
        : err && !list ? <ErrorState title="Couldn't load the runs" onRetry={() => setRetry((n) => n + 1)}>The list of runs didn't load. The runs themselves are safe.</ErrorState>
          : items.length === 0 ? (
            <EmptyState icon={filter === "incident" ? "shield" : "doc"} title={filter === "incident" ? "No incidents" : "No runs yet"}>
              {filter === "incident" ? "When a safety sensor fires during a run, it shows up here." : "Runs appear here when the robot finishes a task."}
            </EmptyState>
          ) : (
            <>
              <ul className="rrows" aria-label={filter === "incident" ? "Incidents" : "Runs"}>
                {visible.map((e) => {
                  const incident = e.kind === "incident";
                  const v = verdict(e.episodeId);
                  return (
                    <li key={e.episodeId}>
                      <RunRow
                        href={to.run(e.episodeId)}
                        time={runTime(e.ts)}
                        outcome={outcomeWord(e.outcome, incident)}
                        tone={OUTCOME_TONE[e.outcome] ?? "neutral"}
                        note={incident ? `Incident · severity ${e.severity ?? 0} (${SEVERITY_WORD[e.severity ?? 0] ?? ""})` : undefined}
                        verdict={v && v !== "err" ? v : null}
                        side={v === undefined ? <span className="rb-checking"><Spinner label="Checking" /></span> : null}
                        claimable={incident && (e.severity ?? 0) >= 2}
                      />
                    </li>
                  );
                })}
              </ul>
              {items.length > shown && <button type="button" className="btn ghost rb-more" onClick={() => setShown((n) => n + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, items.length - shown)} more</button>}
            </>
          )}
    </Section>
  );
}
