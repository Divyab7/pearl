// RunStory: one run told as a short story. Reusable by Robot (owner), Proof (public) and Insurance (insurer).
//
//   <RunStory episodeId="ep_…" mode="owner" | "insurer" | "public"
//             device?        robot address whose record to check (lets the check run while that robot is offline)
//             unlock?        () => Promise<run key>; null/undefined = can't unlock (owner/insurer see `lockedReason`)
//             lockedReason?  plain sentence shown in the locked part when `unlock` is missing (owner/insurer)
//             lockedAction?  a button/link next to that sentence (e.g. "Owner sign-in")
//             unlockLabel?   header button text (default "Unlock details")
//             titleAs?       "h1" when the story is the page (Robot), "h2" when embedded (default)
//             startAtIncident? replay opens at the incident
//             autoUnlock?    unlock as soon as the public check is in (e.g. the insurer opening a claim)
//             tick?          bump to re-check · onPublic?(v) · onFull?(fc|null) · actions? extra header actions />
//
// What anyone sees: the verdict, outcome, incident and severity, timing, and steps 5–6 (locked and signed by the robot,
// recorded on 0G Chain · 0G Storage · Arkiv). The task, the AI's decisions and the camera photos are encrypted: they
// show as one locked placeholder until a key holder unlocks the run in this browser; then the full story, the 3D
// replay and the content checks fill in. Hashes and ids only inside "Technical details".
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, short, useConfig } from "../api";
import { fullCheck, type FullCheck } from "../lib/fullcheck";
import { to } from "../router";
import { outcomeWord, OUTCOME_TONE, TIP, VERDICT_WORDS } from "../lib/words";
import { ArmView3D } from "./ArmView3D";
import { ErrorState, InfoTip, Skeleton, StatusPill, TechDetails } from "./blocks";
import { ARKIV_EXPLORER } from "./claims";
import { CheckList, Chip, CopyButton, Icon, Spinner, verdictOf, type Tone, type VerdictKind } from "./ui";
import "./runstory.css";

export type RunStoryMode = "owner" | "insurer" | "public";

export interface RunStoryProps {
  episodeId: string;
  mode: RunStoryMode;
  device?: string | null;
  unlock?: (() => Promise<Uint8Array>) | null;
  lockedReason?: string;
  lockedAction?: ReactNode;
  unlockLabel?: string;
  titleAs?: "h1" | "h2" | "h3";
  startAtIncident?: boolean;
  autoUnlock?: boolean;
  tick?: number;
  actions?: ReactNode;
  onPublic?: (v: any) => void;
  onFull?: (fc: FullCheck | null) => void;
}

export const SEVERITY_WORD = ["none", "low", "minor", "serious"] as const;
export const severityTone = (s?: number): "bad" | "warn" | "info" => ((s ?? 0) >= 3 ? "bad" : (s ?? 0) >= 2 ? "warn" : "info");

/** "12:07" today, "6 Nov, 12:07" otherwise. */
export const runTime = (t?: number | string | null) => {
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "—";
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const clock = (t?: string | number) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const seconds = (a?: string, b?: string) => {
  if (!a || !b) return null;
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return isFinite(s) && s >= 0 ? (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`) : null;
};

// ---------------------------------------------------------------- story steps from an unlocked log
type StepTone = "ok" | "warn" | "bad" | "info" | "neutral";
interface StoryStep {
  key: string;
  icon: string;
  title: ReactNode;
  body?: ReactNode;
  quote?: string;
  confidence?: number;
  photo?: string | null;
  tone: StepTone;
  recIdx?: number;
  time?: string;
  incident?: boolean;
}

const TASK_SLOT: Record<string, string> = { BIN: "the bin" };
function taskLine(task: any) {
  if (!task) return "No task recorded";
  const cube = `${task.color ?? "the"} cube`;
  return `Pick the ${cube} from ${task.from ?? "its slot"} and drop it in ${TASK_SLOT[task.to ?? "BIN"] ?? task.to}`;
}

const EVENT_STEP: Record<string, { title: string; body: string; tone: StepTone; icon: string; incident?: boolean }> = {
  trip_bump: { title: "Bump detected", body: "The arm stopped itself.", tone: "bad", icon: "alert", incident: true },
  trip_watchdog: { title: "Heartbeat lost", body: "The arm stopped itself.", tone: "bad", icon: "alert", incident: true },
  sensor_fault: { title: "Sensor fault", body: "The arm stopped itself.", tone: "bad", icon: "alert", incident: true },
  hand_in_zone: { title: "Hand in the work zone", body: "The arm paused until it was clear.", tone: "warn", icon: "alert", incident: true },
  hand_clear: { title: "Work zone clear", body: "The arm carried on.", tone: "ok", icon: "check" },
  operator_stop: { title: "Stopped by the operator", body: "Someone pressed Stop.", tone: "warn", icon: "x" },
};

function decisionStep(r: any, photo: string | null | undefined): StoryStep {
  const p = r.parsed ?? {};
  const a = String(p.action ?? "").toUpperCase();
  const base = { key: `r${r.idx}`, recIdx: r.idx, time: r.ts, photo, quote: p.reason, confidence: typeof p.confidence === "number" ? p.confidence : undefined };
  if (r.source !== "0g") {
    return { ...base, icon: "alert", tone: "bad", title: "AI unreachable", body: "The robot couldn't reach the AI, so it stopped safely on its own.", quote: undefined };
  }
  const override = r.override ? " A safety rule kept the arm stopped." : "";
  switch (r.checkpoint) {
    case "PLAN":
      return { ...base, icon: "eye", tone: a === "ABORT" ? "warn" : "info", title: a === "ABORT" ? "AI looked and refused the task" : "AI looked and planned the pick", body: override || undefined };
    case "VERIFY_GRASP":
      return { ...base, icon: "check", tone: a === "CONTINUE" ? "ok" : a === "RETRY" ? "warn" : "bad", title: a === "CONTINUE" ? "Grip confirmed" : a === "RETRY" ? "Grip missed, trying again" : "Grip failed, stopped", body: override || undefined };
    case "VERIFY_PLACE":
      return { ...base, icon: "check", tone: a === "DONE" ? "ok" : a === "RETRY" ? "warn" : "bad", title: a === "DONE" ? "In the bin" : a === "RETRY" ? "Drop missed, trying again" : "Drop failed, stopped", body: override || undefined };
    case "INCIDENT": {
      const sev = p.severity ?? 0;
      return {
        ...base, icon: "alert", tone: severityTone(sev), incident: true,
        title: <>AI judged the incident: severity {sev} ({SEVERITY_WORD[sev] ?? "?"})</>,
        body: (a === "RESUME" ? "Safe to carry on." : "Stay stopped in the safe pose.") + override,
      };
    }
    default:
      return { ...base, icon: "spark", tone: "info", title: String(r.checkpoint).toLowerCase() };
  }
}

function storyOf(log: any, frames: Record<number, string>): StoryStep[] {
  const steps: StoryStep[] = [{ key: "task", icon: "doc", tone: "neutral", title: "Task", body: taskLine(log.task), time: log.startedAt, recIdx: -1 }];
  for (const r of log.records ?? []) {
    if (r.kind === "decision") steps.push(decisionStep(r, r.frameRoot ? frames[r.idx] ?? null : undefined));
    else if (r.kind === "event" && EVENT_STEP[r.ev]) {
      const e = EVENT_STEP[r.ev]!;
      steps.push({ key: `r${r.idx}`, recIdx: r.idx, time: r.ts, icon: e.icon, tone: e.tone, title: e.title, body: e.body, incident: e.incident });
    }
  }
  return steps;
}

// ---------------------------------------------------------------- replay keyframes (same rules as components/run.tsx)
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
  const frames = [{ joints: j, idx: -1, scene: scene(where.slot, false, false) }];
  for (const r of log.records ?? []) {
    if (r.kind !== "decision") continue;
    for (const c of r.commandsSent ?? []) {
      if (c.startsWith("move:")) j = JSON.parse(c.slice(5));
      else if (c === "grip:close") {
        j = [j[0]!, j[1]!, j[2]!, gripClosed];
        if (where.slot) where = { slot: null, holding: true, inBin: false };
      } else if (c === "grip:open") {
        j = [j[0]!, j[1]!, j[2]!, gripOpen];
        if (where.holding) where = { slot: task.to && task.to !== "BIN" ? task.to : null, holding: false, inBin: !task.to || task.to === "BIN" };
      } else if (c === "safe") j = [90, 120, 60, 10];
      else continue;
      frames.push({ joints: j, idx: r.idx, scene: scene(where.slot, where.holding, where.inBin) });
    }
  }
  return frames;
}

function useReplay(kf: ReturnType<typeof keyframes>) {
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<any>(null);
  const posRef = useRef(0);
  posRef.current = pos;
  useEffect(() => () => clearInterval(timer.current), []);
  const last = Math.max(0, kf.length - 1);
  const pause = () => {
    clearInterval(timer.current);
    setPlaying(false);
  };
  const play = () => {
    clearInterval(timer.current);
    let p = posRef.current >= last ? 0 : posRef.current;
    setPlaying(true);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setInterval(() => {
      p += reduce ? 1 : 0.05;
      if (p >= last) {
        p = last;
        clearInterval(timer.current);
        setPlaying(false);
      }
      setPos(p);
    }, reduce ? 700 : 50);
  };
  const seek = (p: number) => {
    pause();
    setPos(Math.max(0, Math.min(last, p)));
  };
  return { pos, playing, play, pause, seek, last };
}

// ---------------------------------------------------------------- component
export function RunStory({
  episodeId, mode, device, unlock, lockedReason, lockedAction, unlockLabel = "Unlock details", titleAs = "h2",
  startAtIncident = false, autoUnlock = false, tick, actions, onPublic, onFull,
}: RunStoryProps) {
  const cfg = useConfig();
  const [pub, setPub] = useState<any>(null);
  const [pubErr, setPubErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [meta, setMeta] = useState<any>(null);
  const [fc, setFc] = useState<FullCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const armRef = useRef<any>(null);
  const autoDone = useRef(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setPubErr("");
    get(`/api/verify/${encodeURIComponent(episodeId)}${device ? `?device=${encodeURIComponent(device)}` : ""}`)
      .then((v) => { if (live) { setPub(v); onPublic?.(v); } })
      .catch((e) => { if (live) { setPub(null); setPubErr(e.message); } })
      .finally(() => live && setLoading(false));
    // where the run went (robot side record): only when the robot is reachable; optional
    get(`/api/episodes/${encodeURIComponent(episodeId)}/meta`).then((m) => live && setMeta(m)).catch(() => live && setMeta(null));
    return () => {
      live = false;
    };
  }, [episodeId, device, tick, retry]);

  // a new run: forget the previous run's unlocked contents
  useEffect(() => {
    setFc(null);
    onFull?.(null);
    setErr("");
    autoDone.current = false;
  }, [episodeId]);

  const doUnlock = async () => {
    if (!unlock || !pub) return;
    setBusy(true);
    setErr("");
    try {
      const key = await unlock();
      armRef.current ??= await get("/api/arm");
      const r = await fullCheck(pub, key, armRef.current);
      setFc(r);
      onFull?.(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoUnlock && unlock && pub?.sealed && !fc && !autoDone.current) {
      autoDone.current = true;
      void doUnlock();
    }
  }, [autoUnlock, !!unlock, pub, fc]);

  const H = titleAs;
  const s = pub?.sealed;

  if (loading && !pub) {
    return (
      <article className="rs" aria-busy="true">
        <div className="rs-head"><div className="rs-head-text"><div className="eyebrow">Run</div><Skeleton height={34} width={260} label="Loading the run" /></div></div>
        <div className="rs-grid"><Skeleton height={300} /><Skeleton lines={6} /></div>
        <p className="muted small"><Spinner label="Checking" /> Checking 0G Chain and 0G Storage…</p>
      </article>
    );
  }
  if (!pub) {
    return (
      <article className="rs">
        <ErrorState title="Couldn't check this run" onRetry={() => setRetry((n) => n + 1)}>
          {/not found|no run|404/i.test(pubErr) ? "We couldn't find this run. The link may be old or mistyped." : "The proof services didn't answer. This doesn't mean anything was changed."}
        </ErrorState>
        {pubErr && <TechDetails><p className="small muted">{pubErr}</p><RunIdRow id={episodeId} /></TechDetails>}
      </article>
    );
  }

  // ---- verdict (public checks, plus content checks once unlocked)
  const pubKind: VerdictKind = verdictOf(pub);
  const kind: VerdictKind = fc ? (fc.result !== "VALID" ? "bad" : pubKind) : pubKind;
  const verdictTone: Tone = kind === "ok" ? "ok" : kind === "bad" ? "bad" : "warn";
  const pubPassed = pub.checks.filter((c: any) => c.status === "PASS").length;
  const pubRan = pub.checks.filter((c: any) => c.status !== "SKIPPED").length;
  const fcPassed = fc ? fc.checks.filter((c) => c.status === "PASS").length : 0;
  const fcRan = fc ? fc.checks.filter((c) => c.status !== "SKIPPED").length : 0;
  const verdictLine = kind === "ok"
    ? (fc ? `Matches exactly what the robot signed and recorded, inside and out (${pubPassed + fcPassed} of ${pubRan + fcRan} checks passed).` : `${VERDICT_WORDS.ok.explain} (${pubPassed} of ${pubRan} public checks passed.)`)
    : kind === "incomplete" ? VERDICT_WORDS.incomplete.explain : VERDICT_WORDS.bad.explain;

  // ---- public facts
  const incident = !!s?.incident;
  const sev: number = s?.severity ?? 0;
  const outcome: string | undefined = s?.outcome;
  const took = seconds(s?.startedAt, s?.endedAt);
  const photos = Array.isArray(meta?.frames) ? meta.frames.length : null;
  const canUnlock = mode !== "public" && !!unlock && !!s && !fc;
  const story = fc ? storyOf(fc.log, fc.frames) : null;
  const firstIncident = story?.find((x) => x.incident);
  const stepNo = (st?: StoryStep) => (st && story ? story.indexOf(st) + 1 : 0);

  const incidentLine = !incident ? null
    : firstIncident ? <>{firstIncident.title} at step {stepNo(firstIncident)}{outcome === "TRIPPED" ? <> → the arm stopped itself</> : outcome === "DONE" ? <> → paused, then finished</> : null}</>
      : outcome === "TRIPPED" ? "A safety sensor fired and the arm stopped itself."
        : outcome === "DONE" ? "A safety sensor fired; the arm paused, then finished the task."
          : "A safety sensor fired during this run.";

  return (
    <article className={`rs ${incident ? "has-incident" : ""}`} aria-labelledby={`rs-t-${episodeId}`}>
      <header className="rs-head">
        <div className="rs-head-text">
          <div className="eyebrow">Run{s?.origin ? " · started remotely" : ""}</div>
          <H className="rs-title" id={`rs-t-${episodeId}`}>
            <span>Run <time dateTime={s?.endedAt ?? undefined}>{runTime(s?.endedAt ?? s?.startedAt)}</time></span>
          </H>
          <div className="rs-pills">
            {outcome && <StatusPill tone={OUTCOME_TONE[outcome] ?? "neutral"}>{outcomeWord(outcome, incident)}</StatusPill>}
            <StatusPill tone={verdictTone} title={VERDICT_WORDS[kind].explain}>
              {VERDICT_WORDS[kind].word}
            </StatusPill>
            {incident && <StatusPill tone={severityTone(sev)} title="How serious the AI judged the incident: 1 low, 2 minor, 3 serious">Severity {sev} · {SEVERITY_WORD[sev]}</StatusPill>}
          </div>
          <p className="rs-verdict">{verdictLine}</p>
        </div>
        <div className="rs-head-actions">
          {actions}
          {canUnlock && (
            <button type="button" className="btn primary" onClick={doUnlock} disabled={busy}>
              {busy ? <><Spinner label="Unlocking" /> Unlocking…</> : <><Icon name="lock" /> {unlockLabel}</>}
            </button>
          )}
          {fc && <span className="rs-unlocked"><Icon name="unlock" size={14} /> Unlocked in this browser only</span>}
        </div>
      </header>

      {err && <div className="rs-alert tone-bad" role="alert"><Icon name="alert" size={16} /> <span><b>Couldn't unlock.</b> {err}</span></div>}
      {incident && (
        <div className={`rs-alert tone-${severityTone(sev)}`}>
          <Icon name="alert" size={16} />
          <span><b>Incident.</b> {incidentLine}{mode === "owner" && sev >= 2 ? <> · This run can be claimed. <a href={to.insurance("owner")}>Claim insurance</a></> : null}</span>
        </div>
      )}

      {story ? (
        <UnlockedBody log={fc!.log} story={story} startAtIncident={startAtIncident} tail={(n) => <>
          <SignedItem pub={pub} n={n} />
          <RecordedItem pub={pub} meta={meta} cfg={cfg} n={n + 1} />
        </>} />
      ) : (
        <div className="rs-grid">
          <div className="rs-locked-stage">
            <div className="rs-locked-arm" aria-hidden><ArmView3D joints={[90, 90, 90, 10]} scene={null} ring="" showAngles={false} /></div>
            <div className="rs-locked-over"><Icon name="lock" size={22} /><span>Replay locked</span></div>
          </div>
          <ol className="rs-steps" aria-label="What happened, step by step">
            <li className="rs-step rs-step-locked">
              <span className="rs-n" aria-hidden><Icon name="lock" size={14} /></span>
              <div className="rs-step-main">
                <div className="rs-step-title">The task, the AI's decisions{photos ? <> and {photos} camera {photos === 1 ? "photo" : "photos"}</> : " and the camera photos"} are locked</div>
                <p className="rs-step-body">
                  {mode === "public" ? "Only the owner, or the insurer for a claimed incident, can open them."
                    : unlock ? `Only a key holder can open them, in this browser. Choose “${unlockLabel}” to see what the AI saw and decided.`
                      : lockedReason ?? "Only the owner, or the insurer for a claimed incident, can open them."}
                  <InfoTip text={TIP.locked} />
                </p>
                {mode !== "public" && !unlock && lockedAction && <div className="rs-step-action">{lockedAction}</div>}
              </div>
            </li>
            {s && (
              <li className="rs-step tone-neutral">
                <span className="rs-n" aria-hidden><Icon name="robot" size={14} /></span>
                <div className="rs-step-main">
                  <div className="rs-step-title">Ran {clock(s.startedAt)} – {clock(s.endedAt)}{took ? <span className="rs-time">took {took}</span> : null}</div>
                  <p className="rs-step-body">{outcomeWord(outcome, incident)}{incident ? ` · incident, severity ${sev}` : ""}</p>
                </div>
              </li>
            )}
            <SignedItem pub={pub} />
            <RecordedItem pub={pub} meta={meta} cfg={cfg} />
          </ol>
        </div>
      )}

      <TechDetails>
        <div className="stack">
          <RunIdRow id={episodeId} />
          <div className="chips">
            <Chip label="Robot" value={pub.device} href={pub.device && cfg.explorer ? `${cfg.explorer}/address/${pub.device}` : null} />
            <Chip label="Run fingerprint" value={s?.headHash ?? null} />
            <Chip label="0G Storage file" value={pub.rootHash ?? null} href={pub.rootHash && cfg.storageIndexer ? `${cfg.storageIndexer}/file?root=${pub.rootHash}` : null} />
            <Chip label="Record contract" value={pub.anchor?.address ?? null} href={pub.anchor?.address && cfg.explorer ? `${cfg.explorer}/address/${pub.anchor.address}` : null} />
            {meta?.anchor?.txHash && <Chip label="0G Chain transaction" value={meta.anchor.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${meta.anchor.txHash}` : null} />}
            {meta?.arkiv?.entityKey && <Chip label="Arkiv label" value={meta.arkiv.entityKey} href={`${ARKIV_EXPLORER}/entity/${meta.arkiv.entityKey}`} />}
          </div>
          <div>
            <h3 className="h4">The {pub.checks.length} public checks</h3>
            <CheckList checks={pub.checks} />
          </div>
          {fc ? (
            <div>
              <h3 className="h4">Content checks (in this browser)</h3>
              <CheckList checks={fc.checks} />
            </div>
          ) : <p className="muted small"><Icon name="lock" size={12} /> After unlocking, more checks run in this browser: every record, AI answer and camera photo is re-checked against the fingerprint.</p>}
          {fc && <DecisionTech log={fc.log} />}
        </div>
      </TechDetails>
    </article>
  );
}

function RunIdRow({ id }: { id: string }) {
  return <div className="row small"><span className="muted">Run id</span><code className="mono">{id}</code><CopyButton value={id} label="Copy run id" /></div>;
}

function StoryItem({ n, st, now, onSeek }: { n: number; st: StoryStep; now: boolean; onSeek: () => void }) {
  return (
    <li className={`rs-step tone-${st.tone} ${st.incident ? "is-incident" : ""} ${now ? "now" : ""}`} aria-current={now ? "step" : undefined}>
      <button type="button" className="rs-n" onClick={onSeek} aria-label={`Show step ${n} in the replay`} title="Show in the replay">{n}</button>
      <div className="rs-step-main">
        <div className="rs-step-title"><Icon name={st.icon} size={15} /> {st.title}{st.time && <span className="rs-time">{clock(st.time)}</span>}</div>
        {st.body && <p className="rs-step-body">{st.body}</p>}
        {(st.quote || st.photo !== undefined) && (
          <div className="rs-saw">
            {st.photo ? <img src={st.photo} alt={`What the camera saw at step ${n}`} className="rs-photo" /> : st.photo === null ? <span className="rs-photo none">Photo unavailable</span> : null}
            {st.quote && (
              <blockquote className="rs-quote">
                “{st.quote}”
                {st.confidence !== undefined && <span className="rs-conf">{Math.round(st.confidence * 100)}% sure</span>}
              </blockquote>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function SignedItem({ pub, n }: { pub: any; n?: number }) {
  const sig = pub.checks.find((c: any) => c.id === 4);
  const head = pub.checks.find((c: any) => c.id === 3);
  const ok = sig?.status === "PASS" && head?.status !== "FAIL";
  const missing = !pub.sealed;
  return (
    <li className={`rs-step tone-${missing ? "warn" : ok ? "ok" : "bad"}`}>
      <span className="rs-n" aria-hidden>{n ?? <Icon name="lock" size={14} />}</span>
      <div className="rs-step-main">
        <div className="rs-step-title">{n ? <Icon name="lock" size={15} /> : null} Locked and signed by the robot<InfoTip text={TIP.signed} /></div>
        <p className="rs-step-body">{missing ? "The locked record couldn't be read yet." : ok ? "Encrypted on the robot and signed with its own key before it left." : "The robot's signature doesn't match this record."}</p>
      </div>
    </li>
  );
}

function RecordedItem({ pub, meta, cfg, n }: { pub: any; meta: any; cfg: any; n?: number }) {
  const chain = pub.checks.find((c: any) => c.id === 1);
  const storage = pub.checks.find((c: any) => c.id === 2);
  const chainHref = meta?.anchor?.txHash && cfg.explorer ? `${cfg.explorer}/tx/${meta.anchor.txHash}` : pub.anchor?.address && cfg.explorer ? `${cfg.explorer}/address/${pub.anchor.address}` : null;
  const storageHref = pub.rootHash && cfg.storageIndexer ? `${cfg.storageIndexer}/file?root=${pub.rootHash}` : null;
  const arkivHref = meta?.arkiv?.entityKey ? `${ARKIV_EXPLORER}/entity/${meta.arkiv.entityKey}` : null;
  const okChain = chain?.status === "PASS";
  const okStorage = storage?.status === "PASS";
  const arkivOk = meta?.arkiv?.status === "ok";
  const tone = okChain && okStorage ? "ok" : chain?.status === "FAIL" && !chain.missing ? "bad" : "warn";
  const relay = meta?.relay;
  const place = (label: string, ok: boolean | null, href: string | null, tip: string) => (
    <span className={`rs-place ${ok === false ? "miss" : ""}`}>
      {ok === false ? <Icon name="minus" size={13} /> : ok ? <Icon name="check" size={13} /> : null}
      {href ? <a href={href} target="_blank" rel="noreferrer" aria-label={`${label} (opens in a new tab)`}>{label} <Icon name="ext" size={12} /></a> : label}
      <InfoTip text={tip} />
    </span>
  );
  return (
    <li className={`rs-step tone-${tone}`}>
      <span className="rs-n" aria-hidden>{n ?? <Icon name="db" size={14} />}</span>
      <div className="rs-step-main">
        <div className="rs-step-title">{n ? <Icon name="db" size={15} /> : null} Recorded{pub.anchor?.anchoredAt ? <span className="rs-time">{clock(pub.anchor.anchoredAt * 1000)}</span> : null}</div>
        <div className="rs-places">
          {place("0G Chain", okChain, chainHref, TIP.ogChain)}
          {place("0G Storage", okStorage, storageHref, TIP.ogStorage)}
          {place("Arkiv", meta ? arkivOk : null, arkivHref, TIP.arkiv)}
        </div>
        {relay?.via === "laptop" && <p className="rs-step-body rs-relay"><Icon name="offline" size={14} /> Delivered without internet (carried by the laptop)<InfoTip text={TIP.carried} /></p>}
        {relay?.via === "self" && <p className="rs-step-body rs-relay"><Icon name="offline" size={14} /> Kept on the robot while offline, sent once it was back online</p>}
        {relay && !relay.via && ["queued", "sent", "submitting"].includes(relay.state) && <p className="rs-step-body rs-relay"><Icon name="offline" size={14} /> No internet yet: waiting for a carrier to take it out</p>}
        {!okChain && chain && <p className="rs-step-body">{chain.missing ? "Not recorded on 0G Chain yet." : "The 0G Chain record doesn't match."}</p>}
      </div>
    </li>
  );
}

/** Per-decision technical facts (model, request, secure enclave, timing), only inside Technical details. */
function DecisionTech({ log }: { log: any }) {
  const ds = (log.records ?? []).filter((r: any) => r.kind === "decision");
  if (!ds.length) return null;
  return (
    <div>
      <h3 className="h4">AI calls</h3>
      <div className="rs-table-wrap">
        <table className="rs-table">
          <thead><tr><th scope="col">Record</th><th scope="col">Checkpoint</th><th scope="col">Model</th><th scope="col">0G request</th><th scope="col">Secure enclave</th><th scope="col">Time</th><th scope="col">Moves</th></tr></thead>
          <tbody>
            {ds.map((r: any) => (
              <tr key={r.idx}>
                <td>#{r.idx}</td>
                <td>{r.checkpoint}</td>
                <td>{r.model ?? "failsafe"}</td>
                <td><code className="mono" title={r.requestId ?? ""}>{r.requestId ? short(r.requestId, 12) : "—"}</code></td>
                <td>{r.teeVerified ? "verified" : r.teeVerified === false ? "not verified" : "—"}</td>
                <td className="tabular">{((r.latencyMs ?? 0) / 1000).toFixed(2)} s</td>
                <td><code className="mono">{(r.commandsSent ?? []).join(" ") || "—"}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Unlocked: the 3D replay beside the full story. The step being played is highlighted; a step's number seeks there. */
function UnlockedBody({ log, story, startAtIncident, tail }: { log: any; story: StoryStep[]; startAtIncident: boolean; tail: (n: number) => ReactNode }) {
  const kf = useMemo(() => keyframes(log), [log]);
  const r = useReplay(kf);
  const i = Math.floor(r.pos);
  const a = kf[i]?.joints ?? [90, 90, 90, 10];
  const b = kf[Math.min(i + 1, r.last)]?.joints ?? a;
  const f = r.pos - i;
  const joints = a.map((v, k) => Math.round(v + (b[k]! - v) * f));
  const at = Math.min(Math.round(r.pos), r.last);
  // the frame at which a record happened: the last frame before the first move made after it
  const posOf = (recIdx?: number) => {
    if (recIdx === undefined || recIdx < 0) return 0;
    const k = kf.findIndex((x) => x.idx >= recIdx);
    return k < 0 ? r.last : Math.max(0, k - 1);
  };
  const incident = story.find((s) => s.incident);
  const started = useRef(false);
  useEffect(() => {
    if (startAtIncident && incident && !started.current) {
      started.current = true;
      r.seek(posOf(incident.recIdx));
    }
  }, [startAtIncident, incident?.recIdx]);
  // the latest story step whose moment the replay has reached
  const current = r.pos >= r.last && r.last > 0 ? story.at(-1) : [...story].reverse().find((s) => posOf(s.recIdx) <= r.pos + 0.001);
  const curStep = current ? story.indexOf(current) + 1 : 1;
  return (
    <div className="rs-grid">
    <div className="rs-replay">
      <div className="rs-stage">
        <ArmView3D joints={joints} scene={kf[at]?.scene ?? null} ring="" showAngles={false} />
      </div>
      <div className="rs-bar">
        <button type="button" className="btn primary rs-play" onClick={r.playing ? r.pause : r.play} disabled={kf.length < 2} aria-label={r.playing ? "Pause the replay" : "Play the replay"}>
          {r.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className="rs-scrub">
          <input type="range" aria-label="Replay position" aria-valuetext={`Step ${curStep} of ${story.length}`} min={0} max={r.last} step={0.01} value={r.pos} onChange={(e) => r.seek(Number(e.target.value))} />
          {story.filter((s) => s.incident).map((s) => <span key={s.key} className={`rs-tick tone-${s.tone}`} style={{ left: `${(posOf(s.recIdx) / Math.max(1, r.last)) * 100}%` }} aria-hidden />)}
        </div>
        <span className="small muted tabular rs-at">Step {curStep} of {story.length}</span>
      </div>
      {incident && <button type="button" className="btn rs-jump" onClick={() => r.seek(posOf(incident.recIdx))}><Icon name="alert" size={14} /> Go to the incident</button>}
    </div>
    <ol className="rs-steps" aria-label="What happened, step by step">
      {story.map((st, n) => <StoryItem key={st.key} n={n + 1} st={st} now={st === current} onSeek={() => r.seek(posOf(st.recIdx))} />)}
      {tail(story.length + 1)}
    </ol>
    </div>
  );
}

const PlayIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M5 3.5v9l7-4.5z" fill="currentColor" /></svg>;
const PauseIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor" /></svg>;
