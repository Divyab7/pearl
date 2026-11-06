// Owner overview (#/app/owner): the robot live, its latest runs with a real check of each, and the counters.
// (What Pearl is and who it's for now lives on the public landing page.)
import { useEffect, useState } from "react";
import { ago, get, og, post, type useLive } from "../api";
import { to } from "../router";
import { ArmView3D } from "../components/ArmView3D";
import { ringClass } from "../components/ArmView";
import { shortWhen, useRuns } from "../components/run";
import { EmptyState, ErrorState, InfoTip, PageHeader, RunRow, Skeleton, Stat, StatusPill } from "../components/blocks";
import { Icon, Spinner, verdictOf, type VerdictKind } from "../components/ui";
import { OUTCOME_TONE, ROBOT_STATE, TIP, outcomeWord, plainError, robotName } from "../lib/words";
import { DEMO_ACTIONS_NOTE, demoActive } from "../lib/demo";
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

export function Overview({ live }: { live: Live }) {
  const [retry, setRetry] = useState(0);
  const runs = useRuns(live.tick + retry);
  const stats = useStats(live.tick + retry);
  const latest: any[] = (runs.items ?? []).slice(0, 5);
  const runsLoading = !runs.source && !runs.err && latest.length === 0;
  const [lastCheck, setLastCheck] = useState<{ kind: VerdictKind; at: number } | null>(null);

  return (
    <div className="page home">
      <PageHeader
        title="Overview"
        description="Your robot right now, its latest sealed runs and the totals. The AI deciding each move runs on 0G; every run is sealed on 0G and listed on Arkiv."
      />
      <Counters stats={stats} tick={live.tick} lastCheck={lastCheck} />

      <div className="home-grid">
        <LivePanel live={live} latestId={latest[0]?.episodeId} />

        <section className="home-runs sect boxed" aria-labelledby="home-runs-title">
          <div className="home-runs-head">
            <h2 className="sect-title" id="home-runs-title">Latest runs</h2>
            <a className="home-more" href={to.runs()}>All runs <Icon name="arrow" size={14} /></a>
          </div>
          {runs.err && latest.length === 0
            ? <ErrorState title="Couldn't load the runs" onRetry={() => setRetry((r) => r + 1)}>The list of runs isn't reachable right now.</ErrorState>
            : runsLoading
              ? <Skeleton lines={4} label="Loading runs" />
              : latest.length === 0
                ? <EmptyState title="No runs yet" icon="robot" plain>Start your first run and it shows up here, sealed on 0G and listed on Arkiv.</EmptyState>
                : (
                  <ul className="rrows home-rrows">
                    {latest.map((r, i) => <li key={r.episodeId}><HomeRunRow run={r} onVerdict={i === 0 ? setLastCheck : undefined} /></li>)}
                  </ul>
                )}
          <p className="home-source small">
            {runs.source === "arkiv" ? "A live Arkiv query of the robot's own entries" : runs.source ? "Read from the robot (Arkiv isn't reachable right now)" : " "}
            {runs.source && <InfoTip text={runs.source === "arkiv" ? TIP.arkivQuery : TIP.arkiv} label="Where this list comes from" />}
          </p>
        </section>
      </div>
    </div>
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
      .catch((e) => demoActive() && e?.status === 409 ? setMsg({ bad: false, text: DEMO_ACTIONS_NOTE }) : setMsg({ bad: true, text: plainError(e, "Couldn't start a run right now. Open the Robot page to see why, or try again.") }))
      .finally(() => setBusy(false));
  };

  const canStart = access?.allowed === true;
  return (
    <section className="home-live sect boxed" aria-labelledby="home-live-title">
      <div className="home-live-head">
        <h2 className="sect-title" id="home-live-title">The robot, live</h2>
        {state && <span className="home-live-name" title={state.deviceId ? `Robot ${state.deviceId}` : undefined}>{robotName(state.deviceKind)}</span>}
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
        {running && lastDecision && lastDecision.source !== "0g" && <span className="home-conf warn" title={TIP.failsafe}>AI offline: stopping safely</span>}
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
        {latestId && <a className="btn" href={to.run(latestId)}><Icon name="doc" size={15} /> Open the latest run</a>}
        <a className="home-more push" href={to.robot()}>Robot controls <Icon name="arrow" size={14} /></a>
      </div>
      {!task && canStart && !running && <p className="small muted">No cube on the table. Put one back from the Robot page.</p>}
      <div aria-live="polite" className="small">{msg && <span className={msg.bad ? "home-msg bad" : "home-msg"}>{msg.text}</span>}</div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ runs + counters */

/** One run: time, outcome in words and a real public check of it (Verified / Not verified / Altered). */
function HomeRunRow({ run, onVerdict }: { run: any; onVerdict?: (c: { kind: VerdictKind; at: number }) => void }) {
  const [verdict, setVerdict] = useState<VerdictKind | null | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    get(`/api/verify/${encodeURIComponent(run.episodeId)}`).then((v) => {
      if (stop) return;
      const k = verdictOf(v);
      setVerdict(k);
      onVerdict?.({ kind: k, at: Date.now() });
    }).catch(() => !stop && setVerdict(null));
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

/** The insurance pool (GET /api/pool): balance when it's set up, null when unknown. */
function usePoolBalance(tick: number) {
  const [p, setP] = useState<{ configured: boolean; balanceWei?: string } | null>(null);
  useEffect(() => {
    get("/api/pool").then(setP).catch(() => setP(null));
  }, [tick]);
  return p;
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Counters({ stats, tick, lastCheck }: { stats: Stats | null | undefined; tick: number; lastCheck: { kind: VerdictKind; at: number } | null }) {
  const pool = usePoolBalance(tick);
  if (stats === null) return null; // unknown: hide rather than show wrong numbers
  if (stats === undefined) return <div className="home-stats"><Skeleton height={56} label="Loading counters" /></div>;
  const paid = stats.paidWei && stats.paidWei !== "0" ? og(stats.paidWei) : undefined;
  const balance = pool?.configured && pool.balanceWei ? og(pool.balanceWei) : null;
  const verified = lastCheck?.kind === "ok" ? `last verified ${hhmm(lastCheck.at)} ✓` : undefined;
  return (
    <div className="home-stats stats" aria-label="Totals">
      {stats.runs != null && <Stat size="sm" value={`${stats.runs}${stats.runsCapped ? "+" : ""}`} label={stats.runs === 1 && !stats.runsCapped ? "run recorded" : "runs recorded"} hint={verified ?? (stats.lastRunAt ? `last ${ago(stats.lastRunAt)}` : undefined)} />}
      {stats.incidents != null && <Stat size="sm" value={stats.incidents} label={stats.incidents === 1 ? "incident" : "incidents"} tone={stats.incidents > 0 ? "warn" : undefined} />}
      {stats.claimsPaid != null && stats.claimsPaid > 0
        ? <Stat size="sm" value={stats.claimsPaid} label={stats.claimsPaid === 1 ? "claim paid" : "claims paid"} hint={balance ? `${balance} left in the pool` : paid} info={TIP.pool} />
        : balance ? <Stat size="sm" value={balance} label="insurance pool" hint="ready to pay claims" info={TIP.pool} /> : null}
    </div>
  );
}
