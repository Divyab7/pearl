// My robot: operate it at its site (Live), read its locked runs and claim after incidents (owner, World ID).
import { useEffect, useRef, useState } from "react";
import { IDKit, proofOfHuman } from "@worldcoin/idkit-core";
import { get, og, post, short, useConfig, when } from "../api";
import { to, to as toR } from "../router";
import { ringClass } from "../components/ArmView";
import { ArmView3D, type ArmProps } from "../components/ArmView3D";
import { KeySetup, WorldPrompt } from "../components/KeySetup";
import { DecisionCard, IndexBadge, RunDetail, RunList, Severity, shortWhen, useRuns } from "../components/run";
import { Amount, Badge, Callout, Card, Chip, Dl, DotLabel, Empty, Field, Icon, Spinner, Stepper, Tabs, type Step } from "../components/ui";
import { loadKey } from "../lib/keys";
import { useAccount } from "../lib/account";
export { useAccount };
import { runContext, wrapRunKey } from "../lib/core";
import { unwrapWith } from "../lib/fullcheck";
import { ArkivRecord, ClaimBadge } from "../components/claims";

const DEVICE_LABEL: Record<string, string> = { sim: "Simulated arm", mujoco: "MuJoCo physics arm", serial: "Hardware arm (USB)", ws: "Hardware arm (Wi-Fi)" };
const STATE_TONE: Record<string, any> = { IDLE: "neutral", MOVING: "accent", WAITING: "accent", FROZEN_HAND: "warn", SAFE: "bad", TRIPPED: "bad" };
const STATE_WORD: Record<string, string> = { IDLE: "Idle", MOVING: "Moving", WAITING: "Waiting for 0G", FROZEN_HAND: "Frozen: hand in zone", SAFE: "Safe pose", TRIPPED: "Tripped" };

/** Interim host for the Robot, Insurance (owner side) and Account places. `bare` renders one section without the page
 *  header and tabs (used by #/insurance and #/account until their own pages replace it). */
export function MyRobot({ live, sub, runId, bare = false }: { live: any; sub?: string; runId?: string; bare?: boolean }) {
  const { account, refresh } = useAccount(live.tick);
  const tab = sub && ["live", "runs", "claims", "setup"].includes(sub) ? sub : "live";
  const st = live.state;
  const tel = live.tel;
  const linked = !!account?.robots?.some((r: any) => r.address.toLowerCase() === st?.deviceAddress?.toLowerCase());
  const setupDone = !!(account && account.key && account.wallet && linked);
  const panel = (
    <>
      {tab === "live" && <LiveTab live={live} />}
      {tab === "runs" && <RunsTab live={live} account={account} linked={linked} runId={runId} />}
      {tab === "setup" && <SetupTab live={live} account={account} refresh={refresh} linked={linked} />}
    </>
  );
  if (bare) return panel;
  const TAB_HREF: Record<string, string> = { live: to.robot(), runs: to.runs(), claims: to.insurance("owner"), setup: to.account() };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">My robot</div>
          <h1>{st?.deviceId ?? "Robot"}</h1>
          <div className="row muted small">
            <span>{DEVICE_LABEL[st?.deviceKind] ?? "Arm"}</span>
            {st?.deviceAddress && <><span aria-hidden>·</span><code className="mono" title={st.deviceAddress}>{short(st.deviceAddress, 8)}</code></>}
            {tel?.state && <DotLabel tone={STATE_TONE[tel.state] ?? "neutral"}>{STATE_WORD[tel.state] ?? tel.state}</DotLabel>}
          </div>
        </div>
        <div className="page-head-side">
          {account
            ? (
              <div className="account-ctl">
                <span className="signed-in"><Icon name="check" size={14} /> Signed in · World ID</span>
                {!setupDone && <a className="small" href={to.account()}>Finish setup</a>}
                <button type="button" className="btn ghost small-btn" onClick={() => post("/api/auth/logout").then(refresh)}>Sign out</button>
              </div>
            )
            : account === null ? <a className="btn" href={to.account()}>Owner sign-in</a> : null}
        </div>
      </div>
      <Tabs
        label="My robot sections"
        active={tab}
        onChange={(t) => (location.hash = TAB_HREF[t] ?? to.robot())}
        tabs={[{ id: "live", label: "Live" }, { id: "runs", label: "Runs" }, { id: "claims", label: "Claims" }, { id: "setup", label: setupDone || !account ? "Setup" : <>Setup <span className="dot-warn" role="img" aria-label="not finished" title="Setup not finished" /></> }]}
      />
      <div role="tabpanel">{panel}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Live
const VIEW0 = { az: 150, el: -32, dist: 0.55 };

/**
 * The robot's table camera, refreshed a few times a second (fetched off-screen, swapped in when loaded: no flicker).
 * With the MuJoCo arm it is also a 3D view: drag to orbit, scroll to zoom, double-click to reset. "3D model" draws the
 * arm in the browser from telemetry (no frames fetched); "AI camera" shows the fixed camera the 0G model decides from.
 */
function LiveCamera({ label, phase, orbit, arm }: { label: string; phase?: string; orbit: boolean; arm: ArmProps }) {
  const [src, setSrc] = useState<string | null>(null);
  const [down, setDown] = useState(false);
  const [mode, setMode] = useState<"3d" | "model" | "ai">(orbit ? "3d" : "ai");
  const [diagram, setDiagram] = useState(false);
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
      if (modeRef.current === "model") {
        timer = setTimeout(next, 250);
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
      // faster while dragging, a few frames a second otherwise
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
  const views: [typeof mode, string][] = [...(orbit ? [["3d", "3D view"] as [typeof mode, string]] : []), ["model", "3D model"], ["ai", "AI camera"]];
  return (
    <>
    <figure className={`cam ${is3d ? "orbit" : ""}`}>
      {mode === "model"
        ? <ArmView3D {...arm} label={undefined} showAngles={false} />
        : (
          <div className="cam-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel} onDoubleClick={() => (view.current = { ...VIEW0 })}>
            {src ? <img className="live-cam" alt={is3d ? "3D view of the robot's table: drag to rotate" : "The camera the 0G model decides from"} src={src} draggable={false} /> : <div className="cam-wait"><Spinner /> Connecting to the camera…</div>}
          </div>
        )}
      <figcaption className="cam-tags">
        <span className={`cam-live ${down && mode !== "model" ? "off" : ""}`}>{down && mode !== "model" ? "Camera offline" : "Live"}</span>
        <span className="cam-tag">{label}</span>
        {phase && phase !== "IDLE" && <span className="cam-tag">{phase.replaceAll("_", " ").toLowerCase()}</span>}
      </figcaption>
      <div className="cam-bar">
        <div className="seg" role="group" aria-label="Camera">
          {views.map(([id, word]) => <button key={id} type="button" className={mode === id ? "on" : ""} aria-pressed={mode === id} onClick={() => setMode(id)}>{word}</button>)}
        </div>
        <span className="muted small">{mode === "ai" ? "The fixed camera the 0G model decides from" : mode === "model" ? "Drawn from telemetry · drag to rotate · scroll to zoom · double-click to reset" : "Drag to rotate · scroll to zoom · double-click to reset"}</span>
      </div>
    </figure>
    {mode !== "model" && (
      <details className="disclosure" onToggle={(e) => setDiagram((e.target as HTMLDetailsElement).open)}>
        <summary>Arm model</summary>
        {diagram && <ArmView3D {...arm} />}
      </details>
    )}
    </>
  );
}

const JOINTS = ["Base", "Shoulder", "Elbow", "Gripper"];

function LiveTab({ live }: { live: any }) {
  const { tel, status, records, cut0g, state } = live;
  const [color, setColor] = useState("red");
  const [from, setFrom] = useState("A2");
  const [msg, setMsg] = useState<{ tone: any; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const act = (label: string, p: string, body?: unknown) => {
    setBusy(label);
    post(p, body)
      .then((r) => setMsg({ tone: "ok", text: r.note ?? (r.episodeId ? `Run ${r.episodeId} started.` : `${label}: done.`) }))
      .catch((e) => setMsg({ tone: "bad", text: `${label}: ${e.message}` }))
      .finally(() => setBusy(""));
  };
  const sim = state?.deviceKind === "sim" || state?.deviceKind === "mujoco";
  const [netPick, setNetOff] = useState<boolean | null>(null);
  const netOff = netPick ?? state?.net === "offline";
  useEffect(() => setNetOff(null), [state?.net]);
  const hasCam = !!state?.cameraKind && state.cameraKind !== "none";
  const [access, setAccess] = useState<any>(null);
  useEffect(() => {
    get("/api/access").then(setAccess).catch(() => setAccess(null));
  }, [live.tick]);
  const locked = access && !access.allowed;
  const running = status?.episodeId && !["DONE", "ABORTED", "FAILSAFE_STOPPED", "TRIPPED", "IDLE"].includes(status.phase);
  const finished = status?.episodeId && ["DONE", "ABORTED", "FAILSAFE_STOPPED", "TRIPPED"].includes(status.phase);
  const ds = records.filter((r: any) => r.kind === "decision").slice().reverse();
  const evs = records.filter((r: any) => r.kind === "event" && r.ev !== "episode_start");
  const arm: ArmProps = { joints: tel?.joints, scene: tel?.scene, ring: ringClass(tel?.status?.ring), label: DEVICE_LABEL[state?.deviceKind] ?? "arm", showAngles: false };
  return (
    <div className="grid-2">
      <div className="stack">
        <Card title={hasCam ? "Table camera" : "Arm"} sub={status?.phase && status.phase !== "IDLE" ? `Run phase: ${status.phase.replaceAll("_", " ").toLowerCase()}` : "No run in progress"}>
          {hasCam
            ? <LiveCamera label={state?.deviceKind === "mujoco" ? "MuJoCo physics" : DEVICE_LABEL[state?.deviceKind] ?? "Camera"} phase={status?.phase} orbit={state?.deviceKind === "mujoco"} arm={arm} />
            : <ArmView3D {...arm} />}
          <div className="meters">
            {JOINTS.map((n, i) => (
              <div key={n} className="meter-row">
                <span>{n}</span>
                <div className="meter" role="meter" aria-label={`${n} angle`} aria-valuemin={0} aria-valuemax={180} aria-valuenow={tel?.joints?.[i] ?? 0}>
                  <div style={{ width: `${((tel?.joints?.[i] ?? 0) / 180) * 100}%` }} />
                </div>
                <b className="tabular">{tel?.joints?.[i] ?? "—"}°</b>
              </div>
            ))}
          </div>
          <Dl rows={[
            ["Distance sensor", tel ? `${tel.tofMm} mm` : "—"],
            ["Acceleration", tel ? `${tel.accG.toFixed(2)} g` : "—"],
            ["Heartbeat", tel ? `${tel.hbAgeMs} ms ago` : "—"],
            ["Status light", tel?.status?.ring ?? "—"],
          ]} />
        </Card>
      </div>
      <div className="stack">
        <Card title="Controls" sub={access?.as === "owner" ? "Signed in as the robot's owner. The robot can refuse any request that is not safe." : "At the robot's site. The robot can refuse any request that is not safe."}>
          {locked && <Callout tone="neutral" title="View only">{access.why} <a href={to.account()}>Owner sign-in</a></Callout>}
          <fieldset className="plain" disabled={!!locked}>
          <button type="button" className="btn stop" onClick={() => act("Stop", "/api/control/stop")}><Icon name="x" size={18} /> Stop the robot</button>
          <div className="form-row">
            <Field label="Cube colour"><select value={color} onChange={(e) => setColor(e.target.value)}><option value="red">Red</option><option value="blue">Blue</option></select></Field>
            <Field label="From slot"><select value={from} onChange={(e) => setFrom(e.target.value)}><option>A1</option><option>A2</option><option>A3</option></select></Field>
            <button type="button" className="btn primary" disabled={!!busy || running} onClick={() => act("Start", "/api/episode/start", { color, from })}>{busy === "Start" ? <Spinner /> : null} Start run</button>
            {state?.modules?.robotZerobot === "on" && (
              <button type="button" className="btn" disabled={!!busy || running} onClick={() => act("Start via zerobot", "/api/zerobot/dispatch", { color, from })} title="Sends the task as a command on 0G Chain; the robot picks it up">Start remotely (zerobot)</button>
            )}
          </div>
          <div className="divider" />
          <div className="row">
            <button type="button" className="btn" onClick={() => act("Safe pose", "/api/control/safe")}>Move to safe pose</button>
            <button type="button" className="btn" onClick={() => act("Reset", "/api/control/reset")} title="On hardware, also press BOOT on the arm within 10 s">Reset after a trip</button>
          </div>
          <fieldset className="sim-box">
            <legend>Fault drills{sim ? " · simulation" : ""}</legend>
            <div className="row">
              <button type="button" className={`btn drill-n ${cut0g ? "on" : ""}`} aria-pressed={cut0g} title="Simulate losing the connection to the 0G AI: the robot must stop safely" onClick={() => act(cut0g ? "Restore 0G" : "Cut 0G", "/api/control/cut0g", { on: !cut0g })}>{cut0g ? "0G cut · restore" : "Cut 0G"}</button>
              <button type="button" className={`btn drill-n ${netOff ? "on" : ""}`} aria-pressed={netOff} title="Simulate the robot losing its internet: it keeps its records and hands them to the laptop or a nearby phone" onClick={() => post("/api/sim/net", { online: netOff }).then(() => { setNetOff(!netOff); setMsg({ tone: "ok", text: netOff ? "Internet restored: the robot sends what it kept." : "Internet cut: the robot keeps its records and hands them to the laptop or a nearby phone." }); }).catch((e) => setMsg({ tone: "bad", text: `${netOff ? "Restore internet" : "Cut internet"}: ${e.message}` }))}>{netOff ? "Internet cut · restore" : "Cut internet"}</button>
              {sim && <>
                <button type="button" className="btn" onClick={() => act("Hand", "/api/sim/inject", { kind: "hand", ms: 2500 })}>Hand in zone</button>
                <button type="button" className="btn" onClick={() => act("Bump", "/api/sim/inject", { kind: "bump" })}>Bump</button>
                <button type="button" className="btn" onClick={() => act("No heartbeat", "/api/sim/inject", { kind: "nohb" })}>Drop heartbeat</button>
                {state?.deviceKind === "mujoco" && <button type="button" className="btn" onClick={() => act("Reset table", "/api/sim/reset-table")}>Reset table</button>}
              </>}
            </div>
          </fieldset>
          </fieldset>
          <div aria-live="polite">{msg && <Callout tone={msg.tone}>{msg.text}</Callout>}</div>
        </Card>
        <Card
          title="Decisions"
          sub={status?.episodeId ? <>Run <code className="mono">{status.episodeId}</code></> : "Each 0G decision appears here as it is made."}
          actions={finished ? <a className="btn primary" href={to.run(status.episodeId)}>Open run <Icon name="arrow" /></a> : null}
        >
          {ds.length === 0 && (
            <Empty title="Waiting for a run">
              At each checkpoint the robot pauses and asks 0G what to do:
              <ol className="cp-steps"><li>Plan</li><li>Check the grip</li><li>Check the drop</li><li>Incident, if a safety sensor fires</li></ol>
            </Empty>
          )}
          <div className="stack">{ds.map((r: any) => <DecisionCard key={r.idx} r={r} />)}</div>
          {evs.length > 0 && (
            <ul className="event-list">
              {evs.map((e: any) => <li key={e.idx}><code className="mono">#{e.idx}</code> <b>{e.ev.replaceAll("_", " ")}</b></li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Runs
function useOwnerUnlock(live: any, account: any, linked: boolean) {
  const rec = account ? loadKey("owner", account.accountId) : null;
  const robotOf = (device?: string | null): string => device || live.state?.deviceAddress || account?.robots?.[0]?.address || "";
  // the robot may be offline (no live address): then any robot linked to the account counts, and the run's key comes
  // from the copy the robot locked for the owner inside the stored file
  const offline = !live.state?.deviceAddress;
  const owns = linked || (offline && !!account?.robots?.length);
  const ready = !!(account && account.key && rec && rec.kid === account.key.kid && owns);
  const reason = !account ? "Sign in as the robot's owner to unlock its runs."
    : !account.key ? "Set up your unlock key in Setup first."
      : !rec || rec.kid !== account.key.kid ? "Your unlock key is not on this browser. Restore it from your backup in Setup."
        : !owns ? "Link this robot to your account in Setup first." : "";
  const unlock = ready
    ? async (episodeId: string, device?: string | null) => {
      const wrap = await get(`/api/episodes/${encodeURIComponent(episodeId)}/key`);
      return unwrapWith(wrap, rec!, robotOf(device), episodeId);
    }
    : null;
  return { unlock, reason, rec, robotOf };
}

function RunsTab({ live, account, linked, runId }: { live: any; account: any; linked: boolean; runId?: string }) {
  const [incidents, setIncidents] = useState(false);
  const runs = useRuns(live.tick, incidents ? "incident" : undefined);
  const { unlock, reason } = useOwnerUnlock(live, account, linked);
  const selected = runId ?? null;
  return (
    <div className="split">
      <Card
        title="Runs"
        sub={<IndexBadge runs={runs} />}
        actions={<label className="toggle"><input type="checkbox" checked={incidents} onChange={(e) => setIncidents(e.target.checked)} /> Incidents only</label>}
      >
        {runs.err && <Callout tone="bad">{runs.err}</Callout>}
        <RunList items={runs.items} selected={selected} onSelect={(id) => (location.hash = to.run(id))} source={runs.source} />
        {runs.query && (
          <details className="disclosure">
            <summary>Arkiv query</summary>
            <pre className="code">{runs.query}</pre>
          </details>
        )}
      </Card>
      <div>
        {selected
          ? <RunDetail episodeId={selected} device={runs.device || null} unlock={unlock ? () => unlock(selected, runs.device) : null} lockedReason={reason} lockedAction={!account ? <a className="btn" href={to.account()}>Owner sign-in</a> : !unlock ? <a className="btn" href={to.account()}>Go to Setup</a> : null} unlockLabel="Unlock with my key" tick={live.tick} />
          : <Card><Empty title="Pick a run">Select a run to check it and, as the owner, unlock its contents.</Empty></Card>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Setup
function SetupTab({ live, account, refresh, linked }: { live: any; account: any; refresh: () => void; linked: boolean }) {
  const [prompt, setPrompt] = useState<any>(null);
  const [msg, setMsg] = useState<{ tone: any; text: string } | null>(null);
  const [wallet, setWallet] = useState("");
  const [editWallet, setEditWallet] = useState(false);
  const [busy, setBusy] = useState("");
  const timer = useRef<any>(null);
  useEffect(() => () => clearInterval(timer.current), []);

  const signIn = async () => {
    setMsg(null);
    try {
      const p = await post("/api/auth/start");
      setPrompt(p);
      clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const s = await get(`/api/auth/status/${p.attemptId}`).catch((e) => ({ status: "failed", reason: e.message }));
        if (s.status === "pending") return;
        clearInterval(timer.current);
        setPrompt(null);
        if (s.status === "ok") refresh();
        else setMsg({ tone: "bad", text: `Sign-in ${s.reason}${s.detail ? `: ${s.detail}` : ""}. You are not signed in.` });
      }, 2000);
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
    }
  };
  const act = (label: string, p: string, body?: unknown) => {
    setBusy(label);
    return post(p, body).then(() => { setMsg(null); refresh(); }).catch((e) => setMsg({ tone: "bad", text: e.message })).finally(() => setBusy(""));
  };

  if (account === undefined) return <Card><p className="muted"><Spinner /> Loading…</p></Card>;
  if (!account) {
    return (
      <div className="setup-grid">
        <Card title="Sign in as the robot's owner" sub="With World ID. Owners read their robot's locked runs and claim after incidents.">
          {!prompt && <button type="button" className="btn primary lg" onClick={signIn}>Sign in with World ID</button>}
          <WorldPrompt prompt={prompt} onCancel={() => post(`/api/auth/cancel/${prompt.attemptId}`).catch(() => {})} label="Approve the sign-in in World App" />
          {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
          <p className="muted small">Operating the arm on the Live tab needs no sign-in at the robot's site.</p>
          <ol className="setup-next">
            <li>Unlock key</li><li>Payout wallet</li><li>Link this robot</li>
          </ol>
          <p className="muted small">After you sign in, these three steps finish the setup.</p>
        </Card>
        <PrivacyAside />
      </div>
    );
  }
  const items = [
    { done: true, title: "Signed in with World ID", body: <span className="muted small">Verified human. The dashboard keeps only an anonymous account id (<code className="mono">{account.accountId.slice(0, 4)}…{account.accountId.slice(-4)}</code>), never your World ID.</span> },
    {
      done: !!account.key, title: "Unlock key",
      body: <KeySetup embedded role="owner" who={account.accountId} registeredKid={account.key?.kid ?? null} register={(publicJwk) => post("/api/account/key", { publicJwk }).then(refresh)} afterReplace="Link the robot again so it re-locks your runs for the new key." />,
    },
    {
      done: !!account.wallet, title: "Payout wallet",
      body: (
        <div className="stack">
          {account.wallet && !editWallet && <div className="row"><Chip label="Wallet" value={account.wallet} /><button type="button" className="btn" onClick={() => setEditWallet(true)}>Change</button></div>}
          {(!account.wallet || editWallet) && <>
          <div className="form-row">
            <Field label={account.wallet ? "Change wallet" : "Wallet address"}>
              <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
            </Field>
            <button type="button" className="btn" disabled={!/^0x[0-9a-fA-F]{40}$/.test(wallet.trim()) || !!busy} onClick={() => act("wallet", "/api/account/wallet", { address: wallet.trim() }).then(() => { setWallet(""); setEditWallet(false); })}>Save</button>
          </div>
          <span className="field-hint">{wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet.trim()) ? "Enter a full 0x address (42 characters)." : "Approved rewards are paid to this address on 0G Chain."}</span>
          </>}
        </div>
      ),
    },
    {
      done: linked, title: "Link this robot",
      body: (
        <div className="stack">
          {account.robots.map((r: any) => (
            <div key={r.address} className="row small">
              <Icon name="robot" /> <b>{r.deviceId}</b> <code className="mono">{short(r.address, 8)}</code>
              <span className="muted">linked {when(r.linkedAt)}</span>
              {account.key && r.ownerKid !== account.key.kid && <Badge tone="warn">uses an older key · link again</Badge>}
            </div>
          ))}
          <div className="row">
            <button type="button" className={`btn ${linked ? "" : "primary"}`} disabled={!account.key || !!busy} onClick={() => act("link", "/api/robots/link")}>
              {busy === "link" ? <><Spinner /> Waiting for the robot…</> : linked ? "Link again" : "Link this robot"}
            </button>
            <span className="muted small">{!account.key ? "Set up your unlock key first." : linked ? "Link again after replacing your key, so the robot re-locks your runs for it." : "The robot signs the link with its own key and locks every run for your unlock key."}</span>
          </div>
        </div>
      ),
    },
  ];
  return (
    <div className="setup-grid">
      <div className="stack">
      <ol className="setup">
        {items.map((it, i) => (
          <li key={it.title} className={`setup-item ${it.done ? "done" : ""}`}>
            <span className="setup-mark">{it.done ? <Icon name="check" size={14} /> : i + 1}</span>
            <div className="setup-body">
              <h3>{it.title}</h3>
              {it.body}
            </div>
          </li>
        ))}
      </ol>
      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
      </div>
      <PrivacyAside />
    </div>
  );
}

function PrivacyAside() {
  return (
    <aside className="card inset setup-aside">
        <h2>What the dashboard can see</h2>
        <ul className="ticks">
          <li><Icon name="check" size={14} /> Your anonymous account id and payout wallet</li>
          <li><Icon name="check" size={14} /> The public half of your unlock key</li>
          <li><Icon name="check" size={14} /> Each run's public labels: result, incident, time</li>
        </ul>
        <h2>What it can't see</h2>
        <ul className="ticks no">
          <li><Icon name="lock" size={14} /> Your private unlock key: it stays in this browser and your backup file</li>
          <li><Icon name="lock" size={14} /> Inside your runs: decisions, camera photos, moves</li>
          <li><Icon name="lock" size={14} /> Your World ID</li>
        </ul>
    </aside>
  );
}

/** One way to name a run everywhere: its time and short id, linked to the run. */
export function RunRef({ id, ts, to = "robot", label }: { id: string; ts?: number | string; to?: "robot" | "verify"; label?: string }) {
  // ep_YYYYMMDDhhmmss_xxxx carries its start time; use it when no end time is given
  const m = id.match(/^ep_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/);
  const t = ts ?? (m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined);
  return (
    <a className="runref" href={to === "verify" ? toR.proof(id) : toR.run(id)} title={`Open run ${id}`}>
      {label && <span>{label}</span>}
      {label && t ? <span aria-hidden>·</span> : null}
      {t ? <span className="tabular">{shortWhen(t)}</span> : null}
      {!label && <code className="mono">…{id.slice(-4)}</code>}
    </a>
  );
}
