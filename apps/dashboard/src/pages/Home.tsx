// Home (#/): what Pearl is in one line, who you are (owner / insurer / anyone checking), the real robot live, its
// latest runs with a real check of each, how it works, the counters and the offline story. One screen on desktop.
import { useEffect, useState, type FormEvent } from "react";
import { ago, get, og, post, type useLive } from "../api";
import { go, to } from "../router";
import { ArmView3D } from "../components/ArmView3D";
import { ringClass } from "../components/ArmView";
import { shortWhen, useRuns } from "../components/run";
import { EmptyState, ErrorState, InfoTip, RoleCard, RunRow, Skeleton, Stat, StatusPill, StepStrip } from "../components/blocks";
import { Icon, Spinner, verdictOf, type VerdictKind } from "../components/ui";
import { useAccount, useInsurerSession } from "../lib/account";
import { HOW_IT_WORKS, OFFLINE_LINE, OUTCOME_TONE, PRODUCT_SHORT, ROBOT_STATE, TIP, outcomeWord } from "../lib/words";
import "./home.css";

type Live = ReturnType<typeof useLive>;

/** Run phase (orchestrator `phase`) → what the robot is doing now, in words. */
const PHASE_NOW: Record<string, string> = {
  PLANNING: "Asking the AI for a plan",
  MOVING_TO_PICK: "Reaching for the cube",
  VERIFYING_GRASP: "Checking the grip",
  MOVING_TO_PLACE: "Carrying the cube to the bin",
  VERIFYING_PLACE: "Checking the drop",
  INCIDENT_DECIDING: "Something happened: the AI is judging it",
};
const ENDED = ["DONE", "ABORTED", "FAILSAFE_STOPPED", "TRIPPED"];
const ENDED_OUTCOME: Record<string, string> = { DONE: "DONE", ABORTED: "ABORTED", FAILSAFE_STOPPED: "FAILSAFE", TRIPPED: "TRIPPED" };

/** The 4 how-it-works steps: titles from HOW_IT_WORKS, one short plain line each (no tech names), and an ⓘ that
 *  names the technology behind the step. */
const STEP_LINE = [
  "An AI looks through the camera and picks each move.",
  "Every moment is locked and signed by the robot itself.",
  "Anyone can find a run and check it. Its contents stay locked.",
  "After an incident the owner claims and the insurer pays.",
];
const STEP_TECH = [TIP.ogCompute, `${TIP.ogStorage} ${TIP.ogChain}`, TIP.arkiv, `${TIP.worldId} ${TIP.pool}`];
const STEPS = HOW_IT_WORKS.map((s, i) => ({ title: s.title, body: STEP_LINE[i], info: STEP_TECH[i] }));

const RUN_ID = /^ep_[A-Za-z0-9_-]+$/;

export function Home({ live }: { live: Live }) {
  const [retry, setRetry] = useState(0);
  const runs = useRuns(live.tick + retry);
  const stats = useStats(live.tick + retry);
  const latest: any[] = (runs.items ?? []).slice(0, 4);
  const runsLoading = !runs.source && !runs.err && latest.length === 0;

  return (
    <div className="page home">
      <header className="home-hero">
        <h1 className="home-title">{PRODUCT_SHORT}</h1>
        <p className="home-tagline">
          <span>An AI decides every move</span><span aria-hidden className="home-dot">·</span>
          <span>every moment is sealed as proof</span><span aria-hidden className="home-dot">·</span>
          <span>it gets out even without internet</span>
        </p>
      </header>

      <Roles tick={live.tick} />

      <div className="home-grid">
        <LivePanel live={live} latestId={latest[0]?.episodeId} />

        <section className="home-runs" aria-labelledby="home-runs-title">
          <div className="home-runs-head">
            <h2 className="sect-title" id="home-runs-title">Latest runs</h2>
            <a className="home-more" href={to.runs()}>All runs <Icon name="arrow" size={14} /></a>
          </div>
          {runs.err && latest.length === 0
            ? <ErrorState title="Couldn't load the runs" onRetry={() => setRetry((r) => r + 1)}>The list of runs isn't reachable right now.</ErrorState>
            : runsLoading
              ? <Skeleton lines={4} label="Loading runs" />
              : latest.length === 0
                ? <EmptyState title="No runs yet" icon="robot" plain>Start a run and it shows up here, sealed.</EmptyState>
                : (
                  <ul className="rrows home-rrows">
                    {latest.map((r) => <li key={r.episodeId}><HomeRunRow run={r} /></li>)}
                  </ul>
                )}
          <p className="home-source small">
            {runs.source === "arkiv" ? "Found through public labels on Arkiv" : runs.source ? "Read from the robot" : " "}
            {runs.source && <InfoTip text={TIP.arkiv} label="Where this list comes from" />}
          </p>
          <Counters stats={stats} />
        </section>
      </div>

      <section className="home-how" aria-labelledby="home-how-title">
        <h2 className="sr-only" id="home-how-title">How it works</h2>
        <StepStrip steps={STEPS} />
      </section>

      <a className="home-offline" href={to.offline()}>
        <span className="home-offline-icon" aria-hidden><Icon name="offline" size={18} /></span>
        <span>{OFFLINE_LINE}</span>
        <span className="home-offline-go">See how <Icon name="arrow" size={14} /></span>
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ who are you? */

function Roles({ tick }: { tick: number }) {
  const { account } = useAccount(tick);
  const insurer = useInsurerSession(tick);
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    if (!insurer?.signedIn) return setWaiting(null);
    get("/api/insurer/claims").then((cs: any[]) => setWaiting(cs.filter((c) => c.status === "INSURER_REVIEW").length)).catch(() => setWaiting(null));
  }, [insurer?.signedIn, tick]);

  return (
    <nav className="home-roles" aria-label="Choose what you came to do">
      <RoleCard icon="robot" href={to.robot()} primary title="I own a robot"
        body={account ? "You're signed in. Watch it live, see runs, claim incidents." : "Watch it live, see runs, claim incidents."} />
      <RoleCard icon="wallet" href={to.insurance("insurer")}
        title={<>I'm an insurer{waiting ? <span className="home-new">{waiting} new</span> : null}</>}
        body="Review claims, check the proof, approve and pay." />
      <CheckRecord />
    </nav>
  );
}

/** The third role: check any run by its code, right here. */
function CheckRecord() {
  const [id, setId] = useState("");
  const [err, setErr] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = id.trim();
    if (!v) return go("proof");
    if (!RUN_ID.test(v)) return setErr("A run code starts with ep_, like ep_20261106061500_ab12.");
    go("proof", v);
  };
  return (
    <form className="rolecard home-check" onSubmit={submit} role="search" aria-labelledby="home-check-title">
      <span className="rolecard-icon" aria-hidden><Icon name="shield" size={22} /></span>
      <span className="home-check-main">
        <span className="rolecard-title" id="home-check-title">Check a record</span>
        <span className="home-check-row">
          <label htmlFor="home-run-id" className="sr-only">Run code</label>
          <input id="home-run-id" className="mono" value={id} placeholder="ep_…" spellCheck={false} autoComplete="off"
            onChange={(e) => { setId(e.target.value); setErr(""); }} aria-invalid={!!err} aria-describedby={err ? "home-check-err" : "home-check-hint"} />
          <button type="submit" className="btn">Check</button>
        </span>
        {err
          ? <span className="home-check-err small" id="home-check-err" role="alert">{err}</span>
          : <span className="rolecard-body" id="home-check-hint">Anyone, no sign-in. Contents stay locked.</span>}
      </span>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------------ the live robot */

function LivePanel({ live, latestId }: { live: Live; latestId?: string }) {
  const { tel, status, records, connected, state } = live;
  const [access, setAccess] = useState<any>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad: boolean; text: string } | null>(null);
  useEffect(() => {
    get("/api/access").then(setAccess).catch(() => setAccess(null));
  }, [live.tick]);

  const phase: string | undefined = status?.phase;
  const running = !!status?.episodeId && !!phase && phase !== "IDLE" && !ENDED.includes(phase);
  // the cube to pick: the first one on the table (MuJoCo / simulator report the scene), else the robot page default
  const slots = Object.entries(tel?.scene?.slots ?? {}).filter(([, c]) => c) as [string, string][];
  const task = slots.length ? { from: slots[0]![0], color: slots[0]![1] } : tel?.scene ? null : { from: "A2", color: "red" };

  const lastDecision = [...records].reverse().find((r: any) => r.kind === "decision" && r.episodeId === status?.episodeId);
  const conf = lastDecision?.parsed?.confidence;
  const frozen = tel?.state === "FROZEN_HAND" || tel?.state === "TRIPPED" || tel?.state === "SAFE";
  const now = frozen ? ROBOT_STATE[tel.state]
    : running ? PHASE_NOW[phase!] ?? ROBOT_STATE[tel?.state] ?? "Working"
      : phase && ENDED.includes(phase) ? `Ready · last run: ${outcomeWord(ENDED_OUTCOME[phase]).toLowerCase()}`
        : "Ready for a task";

  const start = () => {
    if (!task) return;
    setBusy(true);
    setMsg(null);
    post("/api/episode/start", task)
      .then(() => setMsg({ bad: false, text: `Started: picking the ${task.color} cube. Watch it here.` }))
      .catch((e) => setMsg({ bad: true, text: `Couldn't start: ${e.message}` }))
      .finally(() => setBusy(false));
  };

  const canStart = access?.allowed === true;
  return (
    <section className="home-live sect boxed" aria-labelledby="home-live-title">
      <div className="home-live-head">
        <h2 className="sect-title" id="home-live-title">The robot, live</h2>
        <StatusPill tone={connected ? "ok" : connected === false ? "bad" : "neutral"} pulse={!!connected} sub={state?.deviceId}>
          {connected ? "Live" : connected === false ? "Offline" : "Connecting"}
        </StatusPill>
      </div>

      <div className="home-stage">
        {connected === false && !tel
          ? <ErrorState title="Can't reach the robot right now" onRetry={() => location.reload()}>Runs it already sealed are still listed and checkable.</ErrorState>
          : !tel
            ? <Skeleton height="100%" label="Loading the robot" />
            : <ArmView3D joints={tel.joints} scene={tel.scene} ring={ringClass(tel.status?.ring)} showAngles={false} />}
      </div>

      <div className="home-now" aria-live="polite">
        <span className="home-now-label">Now</span>
        <span className="home-now-text">{tel ? now : "—"}</span>
        {running && typeof conf === "number" && lastDecision?.source === "0g" && (
          <span className="home-conf" title="How sure the AI was about its last decision">
            AI {Math.round(conf * 100)}% sure<InfoTip text={TIP.ogCompute} label="Which AI?" />
          </span>
        )}
        {running && lastDecision && lastDecision.source !== "0g" && <span className="home-conf warn">AI unreachable: stopping safely</span>}
        {running && status?.records ? <span className="home-sealed"><Icon name="lock" size={13} /> {status.records} moments sealed</span> : null}
      </div>

      <div className="home-actions">
        {access === undefined ? null : canStart ? (
          <button type="button" className="btn primary" onClick={start} disabled={busy || running || !task || connected === false}
            title={!task ? "No cube on the table: reset it on the Robot page" : undefined}>
            {busy ? <Spinner label="Starting" /> : null}{running ? "Run in progress" : "Start a run"}
          </button>
        ) : (
          <StatusPill tone="neutral" title={access?.why ?? undefined}>View only</StatusPill>
        )}
        {latestId && <a className="btn" href={to.proof(latestId)}><Icon name="alert" size={15} /> Try tampering</a>}
        <a className="home-more push" href={to.robot()}>Open the robot <Icon name="arrow" size={14} /></a>
      </div>
      {!task && canStart && !running && <p className="small muted">No cube on the table. Put one back from the Robot page.</p>}
      <div aria-live="polite" className="small">{msg && <span className={msg.bad ? "home-msg bad" : "home-msg"}>{msg.text}</span>}</div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ runs + counters */

/** One run: time, outcome in words and a real public check of it (Untouched / Not verified / Tampered). */
function HomeRunRow({ run }: { run: any }) {
  const [verdict, setVerdict] = useState<VerdictKind | null | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    get(`/api/verify/${encodeURIComponent(run.episodeId)}`).then((v) => !stop && setVerdict(verdictOf(v))).catch(() => !stop && setVerdict(null));
    return () => {
      stop = true;
    };
  }, [run.episodeId]);
  const incident = run.kind === "incident" || run.severity > 0;
  return (
    <RunRow
      href={to.run(run.episodeId)}
      time={<time dateTime={new Date(run.ts).toISOString()} title={new Date(run.ts).toLocaleString()}>{shortWhen(run.ts)}</time>}
      outcome={outcomeWord(run.outcome, incident)}
      tone={OUTCOME_TONE[run.outcome] ?? "neutral"}
      claimable={run.kind === "incident"}
      verdict={verdict ?? undefined}
      side={verdict === undefined ? <span className="home-checking small">Checking…</span> : null}
      title="Open this run's story"
    />
  );
}

type Stats = { runs: number | null; runsCapped: boolean; incidents: number | null; claimsPaid: number | null; paidWei: string | null; lastRunAt: number | null };

function useStats(tick: number) {
  const [s, setS] = useState<Stats | null | undefined>(undefined);
  useEffect(() => {
    get("/api/stats").then(setS).catch(() => setS(null));
  }, [tick]);
  return s;
}

function Counters({ stats }: { stats: Stats | null | undefined }) {
  if (stats === null) return null; // unknown: hide rather than show wrong numbers
  if (stats === undefined) return <div className="home-stats"><Skeleton height={56} label="Loading counters" /></div>;
  const paid = stats.paidWei && stats.paidWei !== "0" ? og(stats.paidWei) : undefined;
  return (
    <div className="home-stats stats" aria-label="Totals">
      {stats.runs != null && <Stat size="sm" value={`${stats.runs}${stats.runsCapped ? "+" : ""}`} label="runs recorded" hint={stats.lastRunAt ? `last ${ago(stats.lastRunAt)}` : undefined} />}
      {stats.incidents != null && <Stat size="sm" value={stats.incidents} label="incidents" tone={stats.incidents > 0 ? "warn" : undefined} />}
      {stats.claimsPaid != null && <Stat size="sm" value={stats.claimsPaid} label="claims paid" hint={paid} info={TIP.pool} />}
    </div>
  );
}
