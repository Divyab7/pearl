// A run, seen by anyone (public check) and by a key holder (unlock → full check → replay).
import { useEffect, useRef, useState } from "react";
import { get, post, short, useConfig } from "../api";
import { fullCheck, type FullCheck } from "../lib/fullcheck";
import { ArmView3D } from "./ArmView3D";
import { Badge, Callout, Card, CheckList, Chip, CopyButton, Dl, DotLabel, Empty, Icon, Spinner, Verdict, verdictOf, type Tone } from "./ui";

export const OUTCOME_TONE: Record<string, Tone> = { DONE: "neutral", ABORTED: "warn", FAILSAFE: "warn", TRIPPED: "bad" };
export const OUTCOME_WORD: Record<string, string> = { DONE: "Completed", ABORTED: "Aborted", FAILSAFE: "Failsafe stop", TRIPPED: "Safety trip" };

/** Result in words; a run that finished after a safety pause says so. */
export const resultWord = (outcome?: string, incident?: boolean) =>
  outcome === "DONE" && incident ? "Completed · paused" : (OUTCOME_WORD[outcome ?? ""] ?? outcome ?? "");

export function Outcome({ outcome, incident }: { outcome?: string; incident?: boolean }) {
  if (!outcome) return null;
  return <DotLabel tone={OUTCOME_TONE[outcome] ?? "neutral"}>{resultWord(outcome, incident)}</DotLabel>;
}

export const SEVERITY_WORD = ["none", "low", "minor", "serious"];

/** Severity pill for incidents only (0–3, from the 0G model). */
export function Severity({ value, incident, short = false }: { value?: number; incident?: boolean; short?: boolean }) {
  if (!incident) return null;
  return <span className={`badge sev sev-${value ?? 0}`} title="How serious the AI judged the incident: 1 low, 2 minor, 3 serious"><i aria-hidden />{short ? "S" : "Severity "}{value ?? 0} · {SEVERITY_WORD[value ?? 0] ?? ""}</span>;
}

/** "11:26" today, "6 Nov, 11:26" otherwise. */
export const shortWhen = (t?: number | string | null) => {
  if (!t) return "—";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
/** "6 Nov 2026, 10:40 GMT+5:30": one absolute local format everywhere (ISO in title attributes). */
export const fullWhen = (t?: number | string | null) => {
  if (!t) return "—";
  const d = new Date(t);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
export const dayOf = (t?: number | string | null) => {
  if (!t) return "";
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today.getTime() - 86400_000);
  const label = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return d.toDateString() === today.toDateString() ? `Today · ${label}` : d.toDateString() === y.toDateString() ? `Yesterday · ${label}` : label;
};
/** ep_20261106055600_c5b1 → …c5b1: the last 4 characters are unique per run. */
export const shortRun = (id: string) => `…${id.slice(-4)}`;

function failedNames(v: any) {
  return v.checks.filter((c: any) => c.status === "FAIL").map((c: any) => `“${c.name}”`);
}

/** One sentence under the verdict. */
function verdictLine(v: any) {
  const k = verdictOf(v);
  const robotNote = v.source === "robot" ? " The locked file was read from the robot itself, because 0G Storage could not serve it." : "";
  const ran = v.checks.filter((c: any) => c.status !== "SKIPPED").length;
  const passed = v.checks.filter((c: any) => c.status === "PASS").length;
  const notNeeded = v.checks.length - ran;
  if (k === "ok") return `${passed} of ${ran} public checks passed${notNeeded ? ` · ${notNeeded} not needed` : ""}. This run matches what the robot signed and recorded on 0G Chain.${robotNote}`;
  if (k === "incomplete") return `${passed} of ${ran} public checks passed. Nothing contradicts the robot's record, but ${failedNames(v).join(", ")} ${failedNames(v).length > 1 ? "are" : "is"} not available.${robotNote}`;
  return `Does not match the robot's record: ${failedNames(v).join(", ")}.`;
}

/** The public check: verdict, the checks, and the fingerprints anyone can follow on 0G Chain and 0G Storage. */
export function PublicResult({ v, compact = false, title, noVerdict = false }: { v: any; compact?: boolean; title?: string; noVerdict?: boolean }) {
  const cfg = useConfig();
  const addr = (a?: string | null) => (a && cfg.explorer ? `${cfg.explorer}/address/${a}` : null);
  const h = v.sealed;
  const recorded = v.anchor ? new Date(v.anchor.anchoredAt * 1000) : null;
  return (
    <div className="stack">
      {!noVerdict && <Verdict kind={verdictOf(v)} title={title} compact={compact} label={v.tampered ? <>We changed {v.tampered}. Its fingerprint no longer matches the one recorded on 0G Chain.</> : verdictLine(v)} />}
      {!noVerdict && <CheckList checks={v.checks} only={v.tampered ? "failed" : undefined} />}
      {!compact && (
        <>
          <div className="fp-head"><span className="h4">Fingerprints</span>{recorded && <span className="muted small">Recorded on 0G Chain · <time dateTime={recorded.toISOString()} title={recorded.toISOString()}>{fullWhen(recorded.getTime())}</time></span>}</div>
          <div className="chips">
            <Chip label="Robot" value={v.device} href={addr(v.device)} />
            <Chip label="Run fingerprint" value={h?.headHash} />
            <Chip label="0G Storage file" value={v.rootHash} href={v.rootHash && cfg.storageIndexer ? `${cfg.storageIndexer}/file?root=${v.rootHash}` : null} />
            <Chip label="Record contract" value={v.anchor?.address ?? null} href={addr(v.anchor?.address)} />
          </div>
        </>
      )}
    </div>
  );
}

/** Camera-frame-aware decision card (unlocked runs show photos; the live feed shows them as locked). */
export function DecisionCard({ r, frame }: { r: any; frame?: string | null }) {
  if (r.kind !== "decision") return null;
  const failsafe = r.source !== "0g";
  const parsed = r.parsed ?? {};
  return (
    <article className={`decision ${failsafe ? "is-failsafe" : ""}`}>
      <header>
        <b>{CP_WORD[r.checkpoint] ?? r.checkpoint}</b>
        <Badge tone={failsafe ? "bad" : "accent"}>{failsafe ? "Failsafe" : "0G decision"}</Badge>
        {parsed.action && <Badge title={r.override ? `Not followed: ${r.override}` : undefined}>0G said “{String(parsed.action).toLowerCase()}”</Badge>}
        {r.override && <Badge tone="bad" title={r.override}>Overridden by safety rule</Badge>}
        <span className="muted small push tabular">decided in {(r.latencyMs / 1000).toFixed(2)} s</span>
      </header>
      {parsed.reason && <p className="decision-reason">“{parsed.reason}”</p>}
      {r.override && <p className="small decision-error">The arm's safety rule kept it stopped: {String(r.override).replace(/^hard trip: /, "")}.</p>}
      {r.error && <p className="decision-error">{r.error}</p>}
      <div className="decision-body">
        <Dl rows={[
          ["Model", r.model ?? <span className="muted">none (failsafe)</span>],
          ["0G request", r.requestId ? <code className="mono" title={r.requestId}>{short(r.requestId, 14)}</code> : <span className="muted">none</span>],
          ["Secure enclave", r.teeVerified ? <DotLabel tone="ok">verified</DotLabel> : r.teeVerified === false ? <DotLabel tone="warn">not verified</DotLabel> : "—"],
          ["Safety policy", r.policy],
          ["Moves sent", r.commandsSent.length ? <span className="cmds">{r.commandsSent.map((c: string, i: number) => <code key={i} className="cmd">{c}</code>)}</span> : <span className="muted">none</span>],
          ["Record", <code className="mono" title={r.recordHash}>#{r.idx} · {short(r.recordHash, 10)}</code>],
        ]} />
        {r.frameRoot && (frame
          ? <img className="frame" src={frame} alt={`Camera photo at ${r.checkpoint.toLowerCase()}`} />
          : frame === undefined ? <p className="muted small frame-locked"><Icon name="lock" size={12} /> Camera photo locked</p> : null)}
      </div>
    </article>
  );
}

/**
 * Expands the moves sent into joint keyframes, starting from home, and rebuilds the table from the task: the task's
 * cube starts in its slot, is lifted at the first grip:close and lands in the bin (or its target) at the next
 * grip:open. Each keyframe remembers its decision so the scrubber can say which checkpoint it is at.
 */
function keyframes(log: any, gripOpen = 10, gripClosed = 80) {
  const task = log.task ?? {};
  const color = task.color === "blue" ? "blue" : "red";
  const scene = (slot: string | null, holding: boolean, inBin: boolean) => ({
    slots: { A1: slot === "A1" ? color : null, A2: slot === "A2" ? color : null, A3: slot === "A3" ? color : null },
    bin: inBin ? [color] : [],
    holding: holding ? color : null,
  });
  let j = [90, 90, 90, 10];
  let where: { slot: string | null; holding: boolean; inBin: boolean } = { slot: task.from ?? null, holding: false, inBin: false };
  const frames = [{ joints: j, idx: -1, cp: "Start", scene: scene(where.slot, false, false) }];
  for (const r of log.records) {
    if (r.kind !== "decision") continue;
    for (const c of r.commandsSent) {
      if (c.startsWith("move:")) j = JSON.parse(c.slice(5));
      else if (c === "grip:close") {
        j = [j[0]!, j[1]!, j[2]!, gripClosed];
        if (where.slot) where = { slot: null, holding: true, inBin: false };
      } else if (c === "grip:open") {
        j = [j[0]!, j[1]!, j[2]!, gripOpen];
        if (where.holding) where = { slot: task.to && task.to !== "BIN" ? task.to : null, holding: false, inBin: !task.to || task.to === "BIN" };
      } else if (c === "safe") j = [90, 120, 60, 10];
      else continue;
      frames.push({ joints: j, idx: r.idx, cp: r.checkpoint, scene: scene(where.slot, where.holding, where.inBin) });
    }
  }
  return frames;
}

const CONTENT_CHECKS = 5;
export const CP_WORD: Record<string, string> = { PLAN: "Plan", VERIFY_GRASP: "Check the grip", VERIFY_PLACE: "Check the drop", INCIDENT: "Incident", Start: "Start" };
const EVENT_WORD: Record<string, string> = { trip_bump: "Bump detected", trip_watchdog: "Heartbeat lost", sensor_fault: "Sensor fault", hand_in_zone: "Hand in the work zone", hand_clear: "Work zone clear" };

export function Replay({ log, frames, startAtIncident = false }: { log: any; frames: Record<number, string>; startAtIncident?: boolean }) {
  const [pos, setPos] = useState(0);
  const started = useRef(false);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<any>(null);
  const kf = keyframes(log);
  useEffect(() => () => clearInterval(timer.current), []);
  const play = () => {
    clearInterval(timer.current);
    let p = pos >= kf.length - 1 ? 0 : pos;
    setPlaying(true);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setInterval(() => {
      p += reduce ? 1 : 0.05;
      if (p >= kf.length - 1) {
        p = kf.length - 1;
        clearInterval(timer.current);
        setPlaying(false);
      }
      setPos(p);
    }, reduce ? 600 : 50);
  };
  const pause = () => {
    clearInterval(timer.current);
    setPlaying(false);
  };
  const i = Math.floor(pos);
  const a = kf[i]?.joints ?? [90, 90, 90, 10];
  const b = kf[Math.min(i + 1, kf.length - 1)]?.joints ?? a;
  const f = pos - i;
  const joints = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  const currentIdx = kf[Math.min(i + 1, kf.length - 1)]?.idx;
  const incDecision = log.records.find((r: any) => r.kind === "decision" && r.checkpoint === "INCIDENT");
  const marks = log.records.filter((r: any) => r.kind === "event" && EVENT_WORD[r.ev]);
  const sev = log.records.reduce((m: number, r: any) => (r.kind === "decision" && r.checkpoint === "INCIDENT" ? Math.max(m, r.parsed?.severity ?? 0) : m), 0);
  const sevCls = sev >= 3 ? "bad" : sev >= 2 ? "warn" : "neutral";
  // the keyframe step at which each event happened (first move after it)
  const stepOf = (recIdx: number) => {
    const k = kf.findIndex((x) => x.idx > recIdx);
    return k < 0 ? kf.length - 1 : Math.max(0, k - 1);
  };
  const last = Math.max(1, kf.length - 1);
  const incident = marks.find((e: any) => e.ev !== "hand_clear");
  useEffect(() => {
    if (startAtIncident && incident && !started.current) {
      started.current = true;
      setPos(stepOf(incident.idx));
    }
  }, [startAtIncident, incident?.idx]);
  const atIncident = !!incident && Math.round(pos) === stepOf(incident.idx);
  const decision = (atIncident && incDecision) || log.records.find((r: any) => r.idx === currentIdx) || log.records.find((r: any) => r.kind === "decision");
  return (
    <div className="replay">
      <div className="replay-stage">
        <ArmView3D joints={joints} scene={kf[Math.min(Math.round(pos), kf.length - 1)]?.scene ?? null} ring="" label={`${OUTCOME_WORD[log.outcome] ?? log.outcome} · ${kf.length - 1} steps`} />
        <div className="replay-side">
          <div className="replay-bar" style={{ ["--marks" as any]: "" }}>
            <button type="button" className="btn primary" onClick={playing ? pause : play} disabled={kf.length < 2}>
              {playing ? "Pause" : pos > 0 && pos < kf.length - 1 ? "Resume" : "Play"}
            </button>
            <div className="scrub">
              <input type="range" aria-label="Replay position" min={0} max={Math.max(0, kf.length - 1)} step={0.01} value={pos} onChange={(e) => { pause(); setPos(Number(e.target.value)); }} />
              {kf.map((k, n) => (n > 1 && kf[n - 1]!.idx !== k.idx ? <span key={`d${n}`} className="tick cp" style={{ left: `${((n - 1) / last) * 100}%` }} title={CP_WORD[k.cp] ?? k.cp} /> : null))}
              {marks.map((e: any) => <span key={e.idx} className={`tick ${e.ev === "hand_clear" ? "ok" : sevCls}`} style={{ left: `${(stepOf(e.idx) / last) * 100}%` }} title={EVENT_WORD[e.ev]} />)}
            </div>
            <span className="small tabular">Step {Math.min(i + 1, kf.length - 1)} of {kf.length - 1} · <b>{atIncident ? "Incident" : CP_WORD[kf[Math.min(i + 1, kf.length - 1)]?.cp ?? ""] ?? ""}</b></span>
            {incident && <button type="button" className="btn small-btn jump" onClick={() => { pause(); setPos(stepOf(incident.idx)); }}>Go to the incident (step {stepOf(incident.idx)})</button>}
          </div>
          {marks.length > 0 && (
            <ul className="event-list">
              {marks.map((e: any) => <li key={e.idx} className={`${e.ev === "hand_clear" ? "ok" : `sev-${sevCls}`} ${pos + 0.01 >= stepOf(e.idx) ? "" : "later"}`}><Icon name={e.ev === "hand_clear" ? "check" : "alert"} size={14} /> <b>{EVENT_WORD[e.ev]}</b> <span className="muted tabular">at step {stepOf(e.idx)} · {new Date(e.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span></li>)}
            </ul>
          )}
        </div>
      </div>
      {decision && <DecisionCard r={decision} frame={frames[decision.idx] ?? null} />}
    </div>
  );
}

/** Header shared by every place a single run is shown. */
export function RunHeader({ id, sealed }: { id: string; sealed?: any }) {
  return (
    <div className="run-head">
      <div className="stack-tight">
        <div className="eyebrow">Run</div>
        <h3 className="run-title">{sealed ? <time dateTime={sealed.endedAt}>{fullWhen(sealed.endedAt)}</time> : "Loading…"}</h3>
        <div className="row">
          {sealed && <Outcome outcome={sealed.outcome} incident={sealed.incident} />}
          {sealed && <Severity value={sealed.severity} incident={sealed.incident} />}
          <span className="id-chip"><code className="mono" title={id}>{id}</code><CopyButton value={id} label="Copy run id" /></span>
        </div>
      </div>
    </div>
  );
}

/**
 * One run in full. Everyone sees the public check; a key holder can unlock it in this browser and re-check its
 * content. `unlock` returns this run's key (owner: from the robot; insurer: from the claim).
 */
export function RunDetail({ episodeId, device, unlock, lockedReason, lockedAction, unlockLabel = "Unlock and check", tick, onPublic, onFull, startAtIncident = false }: {
  /** The robot whose record to check (lets the check run while that robot is offline). */
  device?: string | null;
  /** Shown in the locked box when the viewer can't unlock (e.g. an owner sign-in button). */
  lockedAction?: React.ReactNode;
  startAtIncident?: boolean;
  episodeId: string;
  unlock?: (() => Promise<Uint8Array>) | null;
  lockedReason?: string;
  unlockLabel?: string;
  tick?: number;
  onPublic?: (v: any) => void;
  onFull?: (fc: FullCheck | null) => void;
}) {
  const [pub, setPub] = useState<any>(null);
  const [pubErr, setPubErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [fc, setFc] = useState<FullCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [arm, setArm] = useState<any>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setPubErr("");
    setFc(null);
    onFull?.(null);
    setErr("");
    get(`/api/verify/${encodeURIComponent(episodeId)}${device ? `?device=${encodeURIComponent(device)}` : ""}`)
      .then((v) => live && (setPub(v), onPublic?.(v)))
      .catch((e) => live && (setPub(null), setPubErr(e.message)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [episodeId, device, tick]);

  const doUnlock = async () => {
    if (!unlock) return;
    setBusy(true);
    setErr("");
    try {
      const key = await unlock();
      const a = arm ?? (await get("/api/arm"));
      setArm(a);
      const r = await fullCheck(pub, key, a);
      setFc(r);
      onFull?.(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pubPassed = pub ? pub.checks.filter((c: any) => c.status === "PASS").length : 0;
  const pubRan = pub ? pub.checks.filter((c: any) => c.status !== "SKIPPED").length : 0;
  const fcPassed = fc ? fc.checks.filter((c) => c.status === "PASS").length : 0;
  const fcRan = fc ? fc.checks.filter((c) => c.status !== "SKIPPED").length : 0;
  const combined = pub ? (fc ? (fc.result === "VALID" && pub.result === "VALID" ? "ok" : fc.result !== "VALID" ? "bad" : verdictOf(pub)) : verdictOf(pub)) : null;
  const summary = !pub ? "" : fc
    ? (combined === "ok" ? `${pubPassed} of ${pubRan} public checks and ${fcPassed} of ${fcRan} content checks passed. Everything the robot signed and recorded matches, inside and out.` : "Some checks failed. See the failing checks below.")
    : verdictLine(pub);
  const contentsLine = !pub || fc ? null : unlock ? `Contents: locked · unlock below to run ${CONTENT_CHECKS} more checks` : "Contents: locked · only the owner, or the insurer for a claimed incident, can read them";
  return (
    <div className="run-detail stack">
      <Card className="inset">
        <RunHeader id={episodeId} sealed={pub?.sealed} />
        {loading && <p className="muted"><Spinner /> Checking 0G Chain and 0G Storage…</p>}
        {combined && <Verdict kind={combined} label={summary} />}
        {contentsLine && unlock && <p className="contents-line"><Icon name="lock" size={14} /> {contentsLine}</p>}
      </Card>
      <Card title="Public check" sub="Anyone can run this. It needs no key and reveals nothing inside the run." className="inset">
        {pubErr && <Callout tone="bad" title="Could not check this run">{pubErr}</Callout>}
        {pub && <><CheckList checks={pub.checks} /><PublicResult v={pub} noVerdict compact={false} /></>}
      </Card>

      <Card
        title={<><Icon name={fc ? "unlock" : "lock"} /> Contents</>}
        sub={fc ? "Unlocked in this browser only. Nothing readable was sent to the server." : "Locked on the robot before upload. Only the key holder can read it."}
        className="inset"
        actions={!fc && unlock && pub?.sealed ? (
          <button type="button" className="btn primary" onClick={doUnlock} disabled={busy}>{busy ? <><Spinner /> Unlocking…</> : <><Icon name="key" /> {unlockLabel}</>}</button>
        ) : null}
      >
        {!fc && !unlock && <Empty title="Locked" action={lockedAction}>{lockedReason ?? "Only the robot's owner, and the insurer for a claimed incident, can unlock this run."}</Empty>}
        {!fc && unlock && !busy && !err && <p className="muted small">Unlocking downloads the locked run, opens it with your key on this device and re-checks every record, AI decision and camera photo.</p>}
        {err && <Callout tone="bad" title="Could not unlock">{err}</Callout>}
        {fc && (
          <div className="stack">
            <CheckList checks={fc.checks} collapse foldLabel={`Show all ${fc.checks.length} content checks (${fcPassed} passed${fc.checks.length > fcRan ? `, ${fc.checks.length - fcRan} not used` : ""})`} />
            <h4 className="h4">Replay</h4>
            <Replay log={fc.log} frames={fc.frames} startAtIncident={startAtIncident} />
          </div>
        )}
      </Card>
    </div>
  );
}

/** Lists runs (public labels only), grouped by day: time, result, incident severity. */
export function RunList({ items, selected, onSelect, source, note }: { items: any[]; selected?: string | null; onSelect: (id: string) => void; source?: string; note?: string }) {
  if (!items.length) return <Empty title="No runs yet">{note ?? "Runs appear here when the robot finishes a task."}</Empty>;
  const groups: [string, any[]][] = [];
  for (const e of items) {
    const d = dayOf(e.ts);
    const g = groups.at(-1);
    if (g && g[0] === d) g[1].push(e);
    else groups.push([d, [e]]);
  }
  return (
    <div className="runlist-wrap">
      <div className="runlist-head" aria-hidden><span>Time</span><span>Result</span><span>Incident</span></div>
      {groups.map(([day, rows]) => (
        <section key={day} aria-label={day}>
          <h4 className="runlist-day">{day}</h4>
          <ul className="runlist" aria-label={`Runs on ${day}${source ? `, read from ${source}` : ""}`}>
            {rows.map((e) => (
              <li key={e.episodeId}>
                <button type="button" className={`runrow ${selected === e.episodeId ? "sel" : ""}`} aria-current={selected === e.episodeId ? "true" : undefined} onClick={() => onSelect(e.episodeId)} title={e.episodeId}>
                  <span className="runrow-time tabular">{e.ts ? new Date(e.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                  <span className="runrow-main">
                    <Outcome outcome={e.outcome} incident={e.kind === "incident"} />
                    {e.locked === false && <span className="muted small">older run, not locked</span>}
                  </span>
                  <span className="runrow-sev">{e.kind === "incident" ? <Severity value={e.severity} incident /> : <span className="muted">—</span>}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const NOTE_COPY: Record<string, string> = {
  "INDEX_ARKIV=off": "Search index is off. Showing runs read directly from the robot.",
  "device address unknown": "The robot's address is unknown, so the search index can't be read. Showing runs from the robot.",
};
/** Turns backend notes into plain copy (never shows raw env names). */
export const noteCopy = (n?: string) => (!n ? "" : NOTE_COPY[n] ?? (n.startsWith("Arkiv read failed") ? "Search index unreachable. Showing runs read directly from the robot." : n.includes("unreachable") ? "The robot is unreachable and no search index is available." : n));

/** Where the run list came from, as a quiet badge: healthy Arkiv says so; a fallback is neutral, never an alarm. */
export function IndexBadge({ runs }: { runs: any }) {
  if (runs.source === "arkiv") return <DotLabel tone="ok" title="Public labels written by the robot's own key">Indexed on Arkiv · {runs.items.length} runs</DotLabel>;
  if (runs.source === "device") return <span className="source-note" title={noteCopy(runs.note)}>Read from the robot</span>;
  return null;
}

export function useRuns(tick: number, kind?: string) {
  const [list, setList] = useState<any>({ items: [], source: null });
  const [err, setErr] = useState("");
  useEffect(() => {
    get(`/api/episodes${kind ? `?kind=${kind}` : ""}`).then((l) => { setList(l); setErr(""); }).catch((e) => setErr(e.message));
  }, [tick, kind]);
  return { ...list, err };
}

export async function tamperPublic(id: string) {
  return post(`/api/verify/${encodeURIComponent(id)}/tamper`);
}
