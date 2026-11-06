// Insurance: #/insurance/owner (the robot's owner claims after an incident) and #/insurance/insurer[/<claimId>] (a person
// at the insurer reviews and decides). World ID twice (Agent Pass: it's really the owner; IDKit Proof of Human: one
// person, one claim), then the insurer unlocks the one incident, decides, and the RewardPool on 0G Chain pays.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IDKit, proofOfHuman } from "@worldcoin/idkit-core";
import { ago, get, post, useConfig, when } from "../api";
import { to } from "../router";
import { EmptyState, InfoTip, PageHeader, PlainError, Section, ShareProofButton, Skeleton, Stat, StatusPill, StepStrip, TechDetails } from "../components/blocks";
import { Amount, Callout, Chip, CopyButton, Dl, DotLabel, Field, Icon, Spinner, Stepper, Tabs, type Step, type Tone } from "../components/ui";
import { KeySetup, WorldPrompt } from "../components/KeySetup";
import { Severity, shortWhen } from "../components/run";
import { RunStory } from "../components/RunStory";
import { ARKIV_EXPLORER } from "../components/claims";
import { accountChanged, useAccount } from "../lib/account";
import { loadKey } from "../lib/keys";
import { demoActive } from "../lib/demo";
import { runContext, wrapRunKey } from "../lib/core";
import { unwrapWith, type FullCheck } from "../lib/fullcheck";
import { useOwnerUnlock } from "../lib/ownerUnlock";
import { CLAIM_STATE, CLAIM_STEPS, INS_TIP, PAGE, TIP, outcomeWord, plainError } from "../lib/words";
import "./insurance.css";

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<any> };
  }
}

type Live = { tick: number; state?: any; [k: string]: any };

/** Owner workspace → Claims (#/app/owner/claims): claim a payout after an incident. */
export function OwnerClaimsPage({ live }: { live: Live }) {
  const pool = usePool(live.tick);
  return (
    <div className="page ins">
      <PageHeader
        title="Claims"
        description="After an incident, claim an insurance payout. World ID proves it's really you, and one person. Arkiv keeps a live public record of each claim, the insurer checks the incident, and the pool on 0G Chain pays."
        actions={<PoolPill pool={pool.data} />}
      />
      <OwnerSide live={live} />
    </div>
  );
}

/** Insurer workspace → Claims (#/app/insurer[/claim/<id>]): the queue and the review of one claim. */
export function InsurerClaimsPage({ live, claimId }: { live: Live; claimId?: string }) {
  const pool = usePool(live.tick);
  return (
    <div className="page ins">
      <PageHeader
        title="Claims"
        description="Claims from robot owners who passed both World ID checks, each tracked live on Arkiv. Open one, check the sealed incident, then approve or decline."
        actions={<a className="ins-pool-link" href={to.pool()}><PoolPill pool={pool.data} /></a>}
      />
      <InsurerGate tick={live.tick}>
        {(info, reload) => <Desk info={info} reload={reload} tick={live.tick} claimId={claimId} reloadPool={pool.reload} />}
      </InsurerGate>
    </div>
  );
}

/** Insurer workspace → Pool (#/app/insurer/pool): what's left to pay, and every payout. */
export function InsurerPoolPage({ live }: { live: Live }) {
  const pool = usePool(live.tick);
  return (
    <div className="page ins">
      <PageHeader title="Pool" description="The insurance pool on 0G Chain pays approved claims straight to the owner's payout wallet, in test 0G tokens." />
      <PoolCard pool={pool.data} />
      <Payouts pool={pool.data} />
    </div>
  );
}

/** Insurer workspace → Settings (#/app/insurer/settings): wallet sign-in and the receiving key. */
export function InsurerSettingsPage({ live }: { live: Live }) {
  const cfg = useConfig();
  return (
    <div className="page ins ins-settings">
      <PageHeader title="Settings" description="Sign in with the insurer's wallet, and keep the receiving key that opens claimed incidents on this browser." />
      <InsurerGate tick={live.tick}>
        {(info, reload) => {
          const rec = loadKey("insurer", info.address);
          const keyReady = !!(info.key && rec && rec.kid === info.key.kid);
          return (
            <>
              <Section boxed title="Insurer wallet" description="You signed a one-time message with this wallet. It moved no money.">
                <div className="row">
                  <StatusPill tone="ok" size="sm">Signed in</StatusPill>
                  <code className="mono">{info.address}</code>
                  <CopyButton value={info.address} label="Copy the insurer wallet" />
                  <button type="button" className="btn ghost push" onClick={() => post("/api/insurer/logout").then(() => { accountChanged(); reload(); })}><Icon name="logout" /> Sign out</button>
                </div>
                <TechDetails>
                  <Chip label="Insurer wallet" value={info.address} href={cfg.explorer ? `${cfg.explorer}/address/${info.address}` : null} />
                </TechDetails>
              </Section>
              <Section boxed title="Receiving key" info={INS_TIP.receivingKey} description={keyReady ? "Ready on this browser. Owners lock each claimed incident for this key." : "Owners lock each claimed incident for this key. You need it on this browser to open them."}>
                <KeySetup embedded role="insurer" who={info.address} registeredKid={info.key?.kid ?? null} register={(publicJwk) => post("/api/insurer/key", { publicJwk }).then(reload)} />
              </Section>
            </>
          );
        }}
      </InsurerGate>
    </div>
  );
}

/** Every payout the pool has sent (newest first). */
function Payouts({ pool }: { pool: any }) {
  const cfg = useConfig();
  if (!pool || !pool.configured || pool.error) return null;
  const paid: any[] = pool.paid ?? [];
  return (
    <Section boxed title="Payouts" description={paid.length ? `${paid.length} payout${paid.length === 1 ? "" : "s"} sent from the pool.` : undefined}>
      {paid.length === 0 ? (
        <EmptyState plain icon="wallet" title="No payouts yet">When you approve a claim, its payment shows up here.</EmptyState>
      ) : (
        <ul className="ins-payouts">
          {paid.map((p: any) => {
            const at = p.at ?? p.ts ?? p.paidAt ?? p.timestamp;
            return (
              <li key={p.txHash}>
                <span className="ins-payout-main">
                  <Amount wei={p.amountWei} paid />
                  <span className="muted small">{at ? when(typeof at === "number" && at < 1e12 ? at * 1000 : at) : "Paid to the owner's payout wallet"}</span>
                </span>
                {cfg.explorer ? <a className="btn small-btn" href={`${cfg.explorer}/tx/${p.txHash}`} target="_blank" rel="noreferrer">See the payment<span className="sr-only"> (opens a new tab)</span> <Icon name="ext" size={13} /></a>
                  : <code className="mono small">{String(p.txHash ?? "").slice(0, 10)}…</code>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- pool
function usePool(tick: number) {
  const [data, setData] = useState<any>(null);
  const reload = () => get("/api/pool").then(setData).catch((e) => setData({ configured: true, error: e.message }));
  useEffect(() => {
    void reload();
  }, [tick]);
  return { data, reload };
}

function PoolPill({ pool }: { pool: any }) {
  if (!pool) return <span className="ins-pool"><span className="muted">Pool</span><Skeleton width={64} height={16} label="Loading the pool" /></span>;
  if (!pool.configured) return <span className="ins-pool muted">Pool not set up yet</span>;
  if (pool.error) return <span className="ins-pool warn-text"><Icon name="alert" size={14} /> Pool unreachable</span>;
  return (
    <span className="ins-pool">
      <span className="muted">Pool</span>
      <Amount wei={pool.balanceWei} />
      <InfoTip text={`${TIP.pool} It holds what is left to pay.`} label="What is the pool?" below />
    </span>
  );
}

const paidTotal = (pool: any) => (pool?.paid ?? []).reduce((t: bigint, p: any) => t + BigInt(p.amountWei), 0n).toString();

/** The pool in four numbers (insurer side). Contract and payouts only in Technical details. */
function PoolCard({ pool }: { pool: any }) {
  const cfg = useConfig();
  if (!pool) return <Section boxed title="Insurance pool"><Skeleton lines={2} /></Section>;
  if (!pool.configured) return <Callout tone="neutral" title="Insurance pool not set up">Approved claims can't be paid until the pool is deployed on 0G Chain.</Callout>;
  if (pool.error) return <PlainError tone="warn" title="Couldn't read the pool" raw={pool.error} fallback="The insurance pool on 0G Chain didn't answer right now." />;
  return (
    <Section boxed title="Insurance pool" info={TIP.pool} className="ins-poolcard">
      <div className="ins-poolstats">
        <Stat size="sm" value={<Amount wei={pool.balanceWei} />} label="Left to pay" />
        <Stat size="sm" value={<Amount wei={pool.paid.length ? paidTotal(pool) : 0} paid={pool.paid.length > 0} />} label={`Paid out · ${pool.paid.length} claim${pool.paid.length === 1 ? "" : "s"}`} />
        <Stat size="sm" value={<Amount wei={pool.perSeverityWei} />} label="Per severity point" />
        <Stat size="sm" value={<Amount wei={pool.maxPayoutWei ?? pool.maxRewardWei} />} label="Most per claim" />
      </div>
      <TechDetails>
        <Chip label="RewardPool contract" value={pool.address} href={cfg.explorer ? `${cfg.explorer}/address/${pool.address}` : null} />
        {pool.paid.slice(0, 3).map((p: any) => (
          <Chip key={p.txHash} label={`Payout ${Number(BigInt(p.amountWei)) / 1e18} test 0G`} value={p.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${p.txHash}` : null} tone="ok" />
        ))}
      </TechDetails>
    </Section>
  );
}

// ---------------------------------------------------------------- shared bits
/** "10:52" (or "6 Nov, 10:52") from the run id's start time, or a timestamp. */
const incidentTime = (id: string, ts?: number | string) => {
  if (ts) return shortWhen(ts);
  const m = id.match(/^ep_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/);
  return m ? shortWhen(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : "";
};

/** The claim's public record on Arkiv, in one plain line; the record's address only in Technical details. */
function PublicRecord({ arkiv }: { arkiv: any }) {
  if (!arkiv) return <span className="ins-rec"><Spinner label="Writing the public record" /> Writing the public record…</span>;
  return (
    <span className="ins-rec">
      <Icon name="db" size={14} />
      {arkiv.entityKey ? <>Live record on Arkiv · {arkiv.writes.length} update{arkiv.writes.length === 1 ? "" : "s"}</> : "Arkiv record pending"}
      <InfoTip text={INS_TIP.publicRecord} label="What is the Arkiv record?" />
      {arkiv.entityKey && <a href={`${ARKIV_EXPLORER}/entity/${arkiv.entityKey}`} target="_blank" rel="noreferrer">View on Arkiv<span className="sr-only"> (opens a new tab)</span></a>}
      {arkiv.error && <span className="warn-text" title={arkiv.error}><Icon name="alert" size={12} /> {plainError(arkiv.error, "The latest update hasn't reached Arkiv yet; it retries by itself.")}</span>}
    </span>
  );
}

/** The payout moment: the amount, where it came from, the payment link. */
function PaidMoment({ claim, who }: { claim: any; who: "owner" | "insurer" }) {
  const cfg = useConfig();
  const tx = claim.payout?.txHash;
  return (
    <div className="ins-paid appear" role="status">
      <span className="ins-paid-icon" aria-hidden><Icon name="check" size={22} /></span>
      <div className="ins-paid-text">
        <div className="ins-paid-amt"><Amount wei={claim.payout?.amountWei ?? claim.amountWei} paid /> <span>paid</span></div>
        <p>{who === "owner" ? "Paid from the pool on 0G Chain to your payout wallet." : "Paid from the pool on 0G Chain to the owner's payout wallet."}{claim.review?.at ? ` ${when(claim.review.at)}.` : ""}</p>
        {claim.review?.reason && <blockquote>“{claim.review.reason}” <cite>{who === "owner" ? "the insurer" : "your reason"}</cite></blockquote>}
      </div>
      {tx && cfg.explorer && <a className="btn" href={`${cfg.explorer}/tx/${tx}`} target="_blank" rel="noreferrer">See the payment <Icon name="ext" size={14} /></a>}
    </div>
  );
}

/** Why a World ID step exists, in one line. */
function Why({ icon, title, children, info }: { icon: string; title: ReactNode; children: ReactNode; info?: string }) {
  return (
    <div className="ins-why">
      <span className="ins-why-icon" aria-hidden><Icon name={icon} size={18} /></span>
      <div><b>{title}</b>{info && <InfoTip text={info} />}<p>{children}</p></div>
    </div>
  );
}

// ================================================================ OWNER
function OwnerSide({ live }: { live: any }) {
  const { account } = useAccount(live.tick);
  const [claims, setClaims] = useState<any[] | null>(null);
  const linked = !!account?.robots?.some((r: any) => r.address.toLowerCase() === live.state?.deviceAddress?.toLowerCase());
  const open = claims?.find((c) => ["AGENT_PASS", "IDKIT", "INSURER_REVIEW", "PAYING"].includes(c.status));
  const active = !account ? undefined : open ? ({ AGENT_PASS: 1, IDKIT: 2, INSURER_REVIEW: 3, PAYING: 4 } as Record<string, number>)[open.status] : 0;
  return (
    <>
      {account && claims && claims.length > 0 ? (
        // signed in with claims: the explainer folds to one line (it's known by now); opens on click
        <details className="ins-how-fold">
          <summary>
            <Icon name="chevron" size={14} /> <b>How a claim works:</b>
            <span className="muted">{CLAIM_STEPS.map((s) => s.title).join(" → ")}</span>
          </summary>
          <StepStrip steps={CLAIM_STEPS} active={active} label="How a claim works" />
        </details>
      ) : (
        <Section title="How a claim works" className="ins-how">
          <StepStrip steps={CLAIM_STEPS} active={active} label="How a claim works" />
        </Section>
      )}
      {account === undefined ? (
        <Skeleton lines={4} label="Loading your account" />
      ) : !account ? (
        <EmptyState title="Sign in as the robot's owner to claim" icon="user" action={<a className="btn primary" href={to.settings()}>Sign in with World ID</a>}>
          You need your World ID sign-in. Insurer? Open the <a href={to.insurer()}>insurer workspace</a>.
        </EmptyState>
      ) : (
        <OwnerClaims live={live} account={account} linked={linked} claims={claims} setClaims={setClaims} />
      )}
    </>
  );
}

const STEP_OF: Record<string, number> = { AGENT_PASS: 1, IDKIT: 2, INSURER_REVIEW: 3, PAYING: 4, PAID: 4 };
function claimSteps(c: any): Step[] {
  const labels = ["Incident", "It's you", "One person", "Insurer review", "Paid"];
  const failedAt = c.status === "DENIED" ? 3 : c.status === "FAILED"
    ? STEP_OF[[...c.history].reverse().find((h: any) => h.status !== "FAILED")?.status ?? "AGENT_PASS"] ?? 1
    : -1;
  const at = STEP_OF[c.status] ?? failedAt;
  return labels.map((label, i) => {
    if (failedAt >= 0) return { label, state: i < failedAt ? "done" : i === failedAt ? "failed" : "todo" };
    if (c.status === "PAID") return { label, state: "done" };
    return { label, state: i < at ? "done" : i === at ? "active" : "todo", ...(i === at && c.status === "PAYING" ? { note: "paying" } : {}) };
  });
}
const ORDER: Record<string, number> = { AGENT_PASS: 0, IDKIT: 0, INSURER_REVIEW: 1, PAYING: 1, PAID: 2, DENIED: 2, FAILED: 2 };

function OwnerClaims({ live, account, linked, claims, setClaims }: { live: any; account: any; linked: boolean; claims: any[] | null; setClaims: (c: any[]) => void }) {
  const [claimable, setClaimable] = useState<any>(null);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState("");
  const timer = useRef<any>(null);
  const { unlock, reason, robotOf } = useOwnerUnlock(live, account, linked);
  const load = () => {
    get("/api/claims").then((c) => { setClaims(c); setLoadErr(""); }).catch((e) => setLoadErr(e.message));
    get("/api/claimable").then(setClaimable).catch((e) => setLoadErr(e.message));
  };
  useEffect(load, [live.tick, account?.accountId, account?.robots?.length]);
  useEffect(() => {
    clearInterval(timer.current);
    const polled = demoActive() ? ["AGENT_PASS", "IDKIT", "INSURER_REVIEW", "PAYING"] : ["AGENT_PASS", "INSURER_REVIEW", "PAYING"];
    if (claims?.some((c) => polled.includes(c.status))) timer.current = setInterval(load, 2500);
    return () => clearInterval(timer.current);
  }, [claims?.map((c) => c.status).join()]);

  const amountFor = (sev: number) => {
    if (!claimable?.amounts) return null;
    const v = BigInt(claimable.amounts.perSeverityWei) * BigInt(sev);
    const max = BigInt(claimable.amounts.maxWei);
    return v > max ? max : v;
  };
  const start = async (episodeId: string, device?: string) => {
    setBusy(episodeId);
    setMsg(null);
    try {
      if (!unlock) throw new Error(reason);
      if (!account.wallet) throw new Error("Add a payout wallet in Settings first.");
      const ins = await get("/api/insurer");
      if (!ins.key) throw new Error("The insurer hasn't set up its receiving key yet, so it couldn't read this incident. Try again later.");
      // this run's key: unlocked here with your key, then locked for the insurer: for this one incident only
      const runKey = await unlock(episodeId, device);
      const insurerKey = await wrapRunKey(runKey, ins.key.publicJwk, runContext(robotOf(device), episodeId));
      await post("/api/claims", { episodeId, insurerKey });
      load();
      // the Claim button is replaced by "Claimed · view": move focus (and the view) to the new claim so keyboard and
      // screen-reader users aren't dropped back at the top of the page
      setTimeout(() => {
        const el = document.getElementById(`claim-${episodeId}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        (el?.querySelector("h3 a") as HTMLElement | null)?.focus({ preventScroll: true });
      }, 400);
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
    } finally {
      setBusy("");
    }
  };
  const cancel = (id: string) => post(`/api/claims/${id}/cancel`).then(load).catch((e) => setMsg({ tone: "bad", text: e.message }));
  const openSet = new Set((claims ?? []).filter((c) => !["FAILED", "DENIED"].includes(c.status)).map((c) => c.episodeId));
  const outcomeOf = new Map<string, any>((claimable?.items ?? []).map((i: any) => [i.episodeId, i]));
  const blockers = [!unlock ? reason : "", !account.wallet ? "Add a payout wallet, where the payout is sent." : ""].filter(Boolean);
  const showClaim = (episodeId: string) => {
    const el = document.getElementById(`claim-${episodeId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.classList.add("flash");
    setTimeout(() => el?.classList.remove("flash"), 1600);
    (el?.querySelector("h3 a") as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const items = [...(claimable?.items ?? [])].sort((a: any, b: any) => Number(openSet.has(a.episodeId)) - Number(openSet.has(b.episodeId)) || Number(b.claimable) - Number(a.claimable));
  const sorted = [...(claims ?? [])].sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <>
      {loadErr && <PlainError title="Couldn't load your claims" raw={loadErr} fallback="The claims service didn't answer. Your claims are safe." onRetry={load} />}
      <Section title="Incidents you can claim" info={INS_TIP.shareOne} description={<>A live Arkiv query of your linked robots' runs, so it works even when the robot is offline. The payout is fixed by severity.<InfoTip text={TIP.arkivQuery} label="Where this list comes from" /></>}>
        {blockers.length > 0 && (
          <Callout tone="warn" title="Before you can claim">
            <ul className="ins-blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            <a className="btn" href={to.settings()}>Open Settings</a>
          </Callout>
        )}
        {!linked && account.robots?.length === 0 && <p className="muted small">No robot is linked to your account yet.</p>}
        {msg && <PlainError title="Couldn't start the claim" raw={msg.text} fallback="Something went wrong while preparing the claim. Try again." />}
        {!claimable ? <Skeleton lines={2} label="Loading incidents" /> : items.length === 0 ? (
          <EmptyState plain title="No incidents to claim" icon="shield">Good news: nothing has gone wrong. If your robot records an incident of severity 2 or more, you can claim it here.</EmptyState>
        ) : (
          <ul className="ins-rows">
            {items.map((i: any) => {
              const claimed = openSet.has(i.episodeId);
              return (
                <li key={i.episodeId} className={`ins-inc ${i.claimable && !claimed ? "can" : ""}`}>
                  <span className="ins-inc-time tabular">{incidentTime(i.episodeId, i.ts)}</span>
                  <span className="ins-inc-main">
                    <a href={to.run(i.episodeId)}>{outcomeWord(i.outcome, true)}</a>
                    <Severity value={i.severity} incident />
                  </span>
                  <span className="ins-inc-side">
                    {i.claimable && !claimed ? (
                      <>
                        <span className="ins-pays">pays <Amount wei={amountFor(i.severity)} /></span>
                        <button type="button" className="btn primary" disabled={!!busy || blockers.length > 0} onClick={() => start(i.episodeId, i.device)}
                          aria-label={`Claim for the ${outcomeWord(i.outcome, true).toLowerCase()} at ${incidentTime(i.episodeId, i.ts)}`}>
                          {busy === i.episodeId ? <><Spinner /> Preparing…</> : "Claim"}
                        </button>
                      </>
                    ) : i.claimable ? (
                      <button type="button" className="btn ghost" onClick={() => showClaim(i.episodeId)}>Claimed · view</button>
                    ) : <span className="muted small">Too minor to claim</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Your claims" description={claims?.length ? "Each claim is a live record on Arkiv. This page updates by itself as it moves." : undefined}>
        {!claims ? <Skeleton lines={3} label="Loading your claims" /> : claims.length === 0 ? (
          <EmptyState plain title="No claims yet" icon="doc">Pick an incident above and press Claim.</EmptyState>
        ) : (
          <div className="ins-claims">
            {sorted.map((c) => <ClaimCard key={c.claimId} claim={c} incident={outcomeOf.get(c.episodeId)} onChange={load} cancel={cancel} />)}
          </div>
        )}
      </Section>
    </>
  );
}

function ClaimCard({ claim: c, incident, onChange, cancel }: { claim: any; incident?: any; onChange: () => void; cancel: (id: string) => Promise<unknown> }) {
  const cfg = useConfig();
  const hid = useId();
  const [withdraw, setWithdraw] = useState(false);
  const st = CLAIM_STATE[c.status] ?? { word: c.status, tone: "neutral" };
  const name = `${incident?.outcome ? outcomeWord(incident.outcome, true) : "Incident"} · ${incidentTime(c.episodeId, incident?.ts)}`;
  return (
    <article className={`ins-claim is-${c.status.toLowerCase()}`} id={`claim-${c.episodeId}`} aria-labelledby={hid}>
      <header className="ins-claim-head">
        <div className="ins-claim-title">
          <h3 id={hid}><a href={to.run(c.episodeId)}>{name}</a></h3>
          <Severity value={c.severity} incident />
        </div>
        <div className="ins-claim-side">
          <Amount wei={c.payout?.amountWei ?? c.amountWei} paid={!!c.payout} />
          <StatusPill tone={st.tone === "info" ? "info" : st.tone} size="sm">{st.word}</StatusPill>
        </div>
      </header>
      <Stepper steps={claimSteps(c)} />

      <div className="ins-now">
        {c.status === "AGENT_PASS" && (
          <>
            <Why icon="user" title="Prove it's you" info={INS_TIP.agentPass}>A fresh World ID check, so someone with your laptop can't claim for you.</Why>
            {demoActive()
              ? <p className="muted small" role="status"><Spinner label="Checking" /> Checking it's you (demo: simulated)…</p>
              : c.agentPass?.prompt
              ? <WorldPrompt prompt={c.agentPass.prompt} onCancel={() => cancel(c.claimId)} label="Approve in World App" />
              : <p className="muted small"><Spinner label="Asking World ID" /> Asking World ID…</p>}
          </>
        )}
        {c.status === "IDKIT" && (
          <>
            <Why icon="shield" title="Prove you're one person" info={INS_TIP.proofOfHuman}>One person, one claim: no fake accounts. It's anonymous: the insurer never learns who you are.</Why>
            {demoActive()
              // demo: the sample server submits a simulated Proof of Human by itself; never open World App here
              ? <p className="muted small" role="status"><Spinner label="Checking" /> Checking you're one person (demo: simulated)…</p>
              : <IdkitStep claim={c} onDone={onChange} />}
          </>
        )}
        {c.status === "INSURER_REVIEW" && (
          <div className="ins-wait" role="status">
            <Spinner label="With the insurer" />
            <div><b>Both checks passed. The insurer is reviewing.</b><p className="muted">A person at the insurer opens this one incident and decides. Their decision and reason appear here.</p></div>
          </div>
        )}
        {c.status === "PAYING" && (
          <div className="ins-wait" role="status"><Spinner label="Paying" /><div><b>Approved. Paying from the pool on 0G Chain…</b></div></div>
        )}
        {c.status === "PAID" && <PaidMoment claim={c} who="owner" />}
        {c.status === "DENIED" && (
          <Callout tone="bad" title="Declined by the insurer">{c.review?.reason ? <>“{c.review.reason}”</> : "No reason given."}</Callout>
        )}
        {c.status === "FAILED" && <PlainError title="Not paid" raw={c.failure} fallback="This claim couldn't be completed. You can claim this incident again." />}
      </div>

      <footer className="ins-claim-foot">
        <PublicRecord arkiv={c.arkiv} />
        <ShareProofButton episodeId={c.episodeId} small />
        {c.status === "INSURER_REVIEW" && (withdraw ? (
          <span className="ins-withdraw" role="group" aria-label="Confirm withdrawal">
            <span className="small">Withdraw this claim? Nothing is paid.</span>
            <button type="button" className="btn danger" onClick={() => { setWithdraw(false); void cancel(c.claimId); }}>Withdraw</button>
            <button type="button" className="btn ghost" onClick={() => setWithdraw(false)}>Keep it</button>
          </span>
        ) : <button type="button" className="btn ghost danger" onClick={() => setWithdraw(true)}>Withdraw claim…</button>)}
      </footer>
      <TechDetails>
        <Dl rows={[
          ["Claim", <code className="mono">{c.claimId}</code>],
          ["Run", <a href={to.verify(c.episodeId)}><code className="mono">{c.episodeId}</code></a>],
          ["Checks", "World ID Agent Pass (owner) · World IDKit Proof of Human (unique person)"],
        ]} />
        {c.arkiv?.entityKey && <Chip label="Arkiv record" value={c.arkiv.entityKey} href={`${ARKIV_EXPLORER}/entity/${c.arkiv.entityKey}`} />}
        {c.payout && <Chip label="Payout on 0G Chain" value={c.payout.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${c.payout.txHash}` : null} tone="ok" />}
        <ol className="ins-history">{c.history.map((h: any, k: number) => <li key={k}><span className="muted tabular">{when(h.ts)}</span> {h.note}</li>)}</ol>
      </TechDetails>
    </article>
  );
}

/** IDKit Proof of Human: starts the request as soon as the claim reaches this step and waits for World App. */
function IdkitStep({ claim, onDone }: { claim: any; onDone: () => void }) {
  const [uri, setUri] = useState("");
  const [err, setErr] = useState("");
  const [stopped, setStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let live = true;
    setStopped(false);
    setErr("");
    setUri("");
    (async () => {
      try {
        const cfg = await get(`/api/claims/${claim.claimId}/idkit`);
        const request = await IDKit.request({
          app_id: cfg.app_id, action: cfg.action, rp_context: cfg.rp_context, allow_legacy_proofs: true, environment: cfg.environment,
          action_description: `Claim the insurance payout for incident ${claim.episodeId}`,
        }).preset(proofOfHuman({ signal: cfg.signal }));
        if (!live) return;
        setUri(request.connectorURI);
        abort.current = new AbortController();
        const out = await request.pollUntilCompletion({ signal: abort.current.signal });
        await post(`/api/claims/${claim.claimId}/idkit`, out.success ? { result: out.result } : { error: String(out.error) });
        onDone();
      } catch (e: any) {
        if (live) setErr(e.message);
      }
    })();
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [claim.claimId, attempt]);
  return (
    <div className="world-prompt ins-idkit" role="status">
      {err ? <PlainError title="World ID check couldn't finish" raw={err} fallback="World ID check couldn't finish. Try again." onRetry={() => setAttempt((n) => n + 1)} /> : stopped ? (
        <p className="muted">Stopped waiting. <button type="button" className="linkish" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
      ) : uri ? (
        <>
          <div className="row"><a className="btn primary" href={uri} target="_blank" rel="noreferrer"><Icon name="shield" /> Open World App<span className="sr-only"> (opens a new tab)</span></a><span className="muted small"><Spinner label="Waiting for World App" /> Waiting for your approval…</span></div>
          <p className="muted small">On a computer? Open the link on your phone, or scan it from World App. This page updates by itself.</p>
        </>
      ) : <p className="muted"><Spinner label="Preparing" /> Preparing the World ID request…</p>}
      {!err && !stopped && <button type="button" className="btn ghost" onClick={() => { abort.current?.abort(); setStopped(true); }}>Stop waiting</button>}
    </div>
  );
}

// ================================================================ INSURER
/** Loads the insurer session; shows sign-in until the insurer's wallet has signed in, then renders `children`. */
function InsurerGate({ tick, children }: { tick: number; children: (info: any, reload: () => void) => ReactNode }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState("");
  const load = () => get("/api/insurer").then((i) => { setInfo((prev: any) => { if (i?.signedIn !== prev?.signedIn) accountChanged(); return i; }); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [tick]);

  if (err) return <PlainError title="Couldn't open the insurer desk" raw={err} fallback="The insurer desk didn't answer." onRetry={load} />;
  if (!info) return <Skeleton lines={4} label="Loading the insurer desk" />;
  if (!info.configured) return <EmptyState title="No insurer is connected yet" icon="wallet" action={<a className="btn primary" href={to.demo("insurer")}>Explore the insurer demo</a>}>Claims can be reviewed here once your insurance company's wallet is connected to Pearl. Until then, try the insurer desk on sample data.</EmptyState>;
  if (!info.signedIn) return <SignIn address={info.address} onDone={load} />;
  return <>{children(info, load)}</>;
}

function SignIn({ address, onDone }: { address: string; onDone: () => void }) {
  const cfg = useConfig();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const hasWallet = typeof window !== "undefined" && !!window.ethereum;
  const signIn = async () => {
    setBusy(true);
    setMsg("");
    try {
      const [acct] = await window.ethereum!.request({ method: "eth_requestAccounts" });
      if (String(acct).toLowerCase() !== address.toLowerCase()) throw new Error("This wallet isn't the insurer's. Switch to the insurer account in your wallet and try again.");
      const ch = await post("/api/insurer/challenge");
      const signature = await window.ethereum!.request({ method: "personal_sign", params: [ch.message, acct] });
      await post("/api/insurer/signin", { nonce: ch.nonce, signature });
      onDone();
    } catch (e: any) {
      setMsg(e?.code === 4001 ? "You declined the signature. You're not signed in." : e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section boxed className="ins-signin" title="Sign in with the insurer's wallet" description="You need the insurance company's wallet. You sign a one-time message: it proves you hold the wallet and moves no money.">
      <div className="row">
        <button type="button" className="btn primary lg" onClick={signIn} disabled={busy || !hasWallet} aria-describedby={!hasWallet ? "ins-no-wallet" : undefined}>
          {busy ? <><Spinner /> Waiting for your wallet…</> : <><Icon name="wallet" /> Connect wallet and sign in</>}
        </button>
        <span className="muted small">Robot owner? Open the <a href={to.claims()}>owner workspace</a>.</span>
      </div>
      {!hasWallet && <div id="ins-no-wallet"><Callout tone="warn" title="No wallet in this browser">Open this page in a browser with MetaMask (or another wallet) holding the insurer account, then reload.</Callout></div>}
      {msg && <PlainError raw={msg} fallback="Sign-in didn't finish. Try again." />}
      <TechDetails>
        <Chip label="Expected insurer wallet" value={address} href={cfg.explorer ? `${cfg.explorer}/address/${address}` : null} />
      </TechDetails>
    </Section>
  );
}

const INSURER_STATE: Record<string, [string, Tone]> = {
  INSURER_REVIEW: ["Needs your decision", "info"], PAYING: ["Paying", "info"], PAID: ["Approved · paid", "ok"],
  DENIED: ["Declined", "bad"], FAILED: ["Not paid", "bad"],
};
function InsurerStatus({ status }: { status: string }) {
  const [w, t] = INSURER_STATE[status] ?? [status, "neutral"];
  return <StatusPill tone={t} size="sm">{w}</StatusPill>;
}

function Desk({ info, reload, tick, claimId, reloadPool }: { info: any; reload: () => void; tick: number; claimId?: string; reloadPool: () => void }) {
  const [claims, setClaims] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const rec = loadKey("insurer", info.address);
  const keyReady = !!(info.key && rec && rec.kid === info.key.kid);
  const loadClaims = () => get("/api/insurer/claims").then((c) => { setClaims(c); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => {
    void loadClaims();
    const id = setInterval(loadClaims, 5000);
    return () => clearInterval(id);
  }, [tick]);
  const list = claims ?? [];
  const waiting = list.filter((c) => c.status === "INSURER_REVIEW");
  const done = list.filter((c) => c.status !== "INSURER_REVIEW");
  const [qtab, setQtab] = useState<"waiting" | "decided">("waiting");
  // open the first waiting claim when none is chosen, so there is never an empty pane while work is waiting
  const sel = list.find((c) => c.claimId === claimId) ?? (claimId ? null : waiting[0] ?? null);
  useEffect(() => {
    if (sel) setQtab(sel.status === "INSURER_REVIEW" ? "waiting" : "decided");
  }, [sel?.claimId, sel?.status]);
  // phones: the review sits below the queue, so bring it into view when a claim is picked
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (claimId && matchMedia("(max-width: 1080px)").matches) reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [claimId]);
  const rows = qtab === "waiting" ? waiting : done;

  return (
    <>
      <div className="ins-who">
        <span className="ins-who-text"><Icon name="check" size={14} /> Signed in as the insurer</span>
        {keyReady && <span className="muted small ins-who-key"><Icon name="key" size={13} /> Receiving key ready on this browser<InfoTip text={INS_TIP.receivingKey} /></span>}
        <a className="btn ghost" href={to.insurerSettings()}><Icon name="key" /> Wallet and key</a>
      </div>
      {!keyReady && (
        <Section boxed title="Set up your receiving key" info={INS_TIP.receivingKey} description="Owners lock each claimed incident for this key. You need it on this browser to open them." className="ins-keysetup">
          <KeySetup embedded role="insurer" who={info.address} registeredKid={info.key?.kid ?? null} register={(publicJwk) => post("/api/insurer/key", { publicJwk }).then(reload)} />
        </Section>
      )}
      <div className="ins-desk">
        <aside className="ins-desk-side">
          <Section boxed title="Queue" className="ins-queue" actions={<Tabs label="Claim queue" active={qtab} onChange={(t) => setQtab(t as any)} tabs={[{ id: "waiting", label: "Waiting", count: waiting.length }, { id: "decided", label: "Decided", count: done.length }]} />}>
            {err && <PlainError title="Couldn't load claims" raw={err} fallback="The claims list didn't load." onRetry={loadClaims} />}
            {!claims && !err ? <Skeleton lines={3} label="Loading claims" /> : rows.length === 0 ? (
              <EmptyState plain icon={qtab === "waiting" ? "check" : "doc"} title={qtab === "waiting" ? "Nothing waiting" : "No decisions yet"}>
                {qtab === "waiting" ? "You're all caught up. New claims appear here after the owner passes both World ID checks." : "Claims you approve or decline appear here."}
              </EmptyState>
            ) : (
              <ul className="ins-q" aria-label={qtab === "waiting" ? "Claims waiting for you" : "Decided claims"}>
                {rows.map((c) => {
                  const on = sel?.claimId === c.claimId;
                  return (
                    <li key={c.claimId}>
                      <a className={`ins-q-row ${on ? "sel" : ""}`} href={to.insurer(c.claimId)} aria-current={on ? "true" : undefined}>
                        <span className="ins-q-main">
                          <span className="ins-q-title">Incident · {incidentTime(c.episodeId)} <Severity value={c.severity} incident short /></span>
                          <span className="ins-q-sub">{qtab === "decided" ? <InsurerStatus status={c.status} /> : <>Submitted {ago(c.createdAt)}</>}</span>
                        </span>
                        <Amount wei={c.payout?.amountWei ?? c.amountWei} paid={c.status === "PAID"} />
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </aside>
        <div className="ins-desk-main" ref={reviewRef} tabIndex={-1} aria-label="Selected claim">
          {sel ? <Review claim={sel} rec={keyReady ? rec : null} onDecided={() => { void loadClaims(); reloadPool(); }} />
            : claims && claimId ? <EmptyState title="Claim not found" icon="search" action={<a className="btn" href={to.insurer()}>Back to the queue</a>}>It may have been withdrawn by the owner.</EmptyState>
              : claims ? <EmptyState title="Pick a claim" icon="doc">Select a claim to open the incident and decide.</EmptyState>
                : <Skeleton lines={6} label="Loading the claim" />}
        </div>
      </div>
    </>
  );
}

function Review({ claim, rec, onDecided }: { claim: any; rec: any; onDecided: () => void }) {
  const cfg = useConfig();
  const hid = useId();
  const [fc, setFc] = useState<FullCheck | null>(null);
  const [unlockSignal, setUnlockSignal] = useState(0);
  const story = useRef<HTMLDivElement>(null);
  const open = claim.status === "INSURER_REVIEW";
  // the decision panel's "Unlock incident" is the only unlock button; the story below opens in place
  const unlockStory = () => {
    setUnlockSignal((n) => n + 1);
    story.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <section className="ins-review" aria-labelledby={hid}>
      <div className="ins-review-grid">
        <div className="ins-evidence">
          <div className="ins-sum">
            <div className="ins-sum-head">
              <div>
                <div className="eyebrow">Claim · submitted {ago(claim.createdAt)}</div>
                <h2 id={hid} className="ins-sum-title">Incident · {incidentTime(claim.episodeId)} <Severity value={claim.severity} incident /></h2>
              </div>
              <div className="ins-sum-side">
                <InsurerStatus status={claim.status} />
                <ShareProofButton episodeId={claim.episodeId} small />
              </div>
            </div>
            <div className="ins-sum-checks">
              <span className="muted small">Checked by World ID before it reached you</span>
              <span className="ins-check"><DotLabel tone="ok">Agent Pass: it's really the robot's owner</DotLabel><InfoTip text={INS_TIP.agentPass} /></span>
              <span className="ins-check"><DotLabel tone="ok">Proof of Human: one person, one claim</DotLabel><InfoTip text={INS_TIP.proofOfHuman} /></span>
            </div>
            <PublicRecord arkiv={claim.arkiv} />
            <TechDetails>
              <Dl rows={[
                ["Claim", <code className="mono">{claim.claimId}</code>],
                ["Run", <a href={to.verify(claim.episodeId)}><code className="mono">{claim.episodeId}</code></a>],
                ["Payout wallet", <span className="row"><code className="mono">{claim.wallet}</code><CopyButton value={claim.wallet} label="Copy payout wallet" /></span>],
                ["Claimant id", <code className="mono" title="World ID nullifier: one per person per incident, reveals no identity">{claim.nullifier}</code>],
                ["Checks passed", "World ID Agent Pass (owner) · World IDKit Proof of Human (unique person)"],
              ]} />
              {claim.arkiv?.entityKey && <Chip label="Arkiv record" value={claim.arkiv.entityKey} href={`${ARKIV_EXPLORER}/entity/${claim.arkiv.entityKey}`} />}
              {claim.payout && <Chip label="Payout on 0G Chain" value={claim.payout.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${claim.payout.txHash}` : null} tone="ok" />}
            </TechDetails>
          </div>
          <IncidentStory claim={claim} rec={rec} onFull={setFc} containerRef={story} unlockSignal={unlockSignal} />
        </div>
        <aside className="ins-decide" aria-label="Decision">
          <div className="ins-sum-amt">
            <span className="muted small">{claim.status === "PAID" ? "Paid" : claim.status === "DENIED" || claim.status === "FAILED" ? "Would have paid" : "Pays if approved"}</span>
            <Amount wei={claim.payout?.amountWei ?? claim.amountWei} paid={claim.status === "PAID"} />
            <span className="muted small">from the pool on 0G Chain to the owner's payout wallet, fixed by severity</span>
          </div>
          {open ? <DecisionPanel key={claim.claimId} claim={claim} fc={fc} canUnlock={!!rec} onUnlock={unlockStory} onDecided={onDecided} /> : <Decided claim={claim} />}
        </aside>
      </div>
    </section>
  );
}

/**
 * The claimed incident, unlocked with the receiving key, told as a RunStory (insurer mode).
 */
function IncidentStory({ claim, rec, onFull, containerRef, unlockSignal }: { claim: any; rec: any; onFull: (fc: FullCheck | null) => void; containerRef?: React.RefObject<HTMLDivElement | null>; unlockSignal: number }) {
  return (
    <div className="ins-story" ref={containerRef}>
      <RunStory
        episodeId={claim.episodeId}
        mode="insurer"
        titleAs="h3"
        device={claim.device}
        unlock={rec ? () => unwrapWith(claim.insurerKey, rec, claim.device, claim.episodeId) : null}
        lockedReason="Set up or restore your receiving key above to unlock this incident."
        startAtIncident
        unlockLabel="Unlock incident"
        onFull={onFull}
        share={false}
        hideUnlock
        unlockSignal={unlockSignal}
      />
    </div>
  );
}

/** The decision: fixed in the right column while the evidence scrolls on the left.
 *  Locked: its one action is "Unlock incident". Unlocked: reason (required, said so) + Approve / Decline, each confirmed. */
function DecisionPanel({ claim, fc, canUnlock, onUnlock, onDecided }: { claim: any; fc: FullCheck | null; canUnlock: boolean; onUnlock: () => void; onDecided: () => void }) {
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "deny" | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [msg, setMsg] = useState("");
  const verified = fc?.result === "VALID";
  useEffect(() => setUnlocking(false), [fc]);
  const status = !fc
    ? <><Icon name="lock" size={13} /> {canUnlock ? "Unlock the incident to see the evidence and decide" : "Set up your receiving key first"}</>
    : !verified ? <span className="bad-text"><Icon name="alert" size={13} /> The contents failed the check: you can decline, not approve</span>
      : <span className="ok-text"><Icon name="check" size={13} /> Incident unlocked and every record checked</span>;
  const decide = async (approve: boolean) => {
    setBusy(true);
    setMsg("");
    try {
      await post(`/api/insurer/claims/${claim.claimId}/decision`, { approve, reason });
      setConfirm(null);
      onDecided();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ins-dock" role="region" aria-label="Your decision">
      <div className="ins-dock-head">
        <b>Your decision</b>
        <span className="muted small" aria-live="polite">{status}</span>
      </div>
      {!fc ? (
        <div className="ins-dock-lock">
          <button type="button" className="btn primary lg" disabled={!canUnlock || unlocking} onClick={() => { setUnlocking(true); onUnlock(); setTimeout(() => setUnlocking(false), 15000); }}>
            {unlocking ? <><Spinner /> Unlocking…</> : <><Icon name="key" /> Unlock incident</>}
          </button>
          <span className="muted small">Opens this one incident with your receiving key, in this browser only, then replays it and checks every record.</span>
        </div>
      ) : !confirm ? (
        <div className="ins-dock-body">
          <Field label="Your reason (the owner sees it)" hint={<span className={reason.trim() ? "ok-text" : ""} id="ins-reason-hint">{reason.trim() ? <><Icon name="check" size={12} /> Reason added</> : "A reason is required to approve or decline."}</span>}>
            <textarea rows={3} value={reason} maxLength={500} required aria-describedby="ins-reason-hint" onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bump at 14:02 matches severity 2; arm stopped as designed." />
          </Field>
          <div className="ins-dock-actions">
            <button type="button" className="btn primary" disabled={!verified || !reason.trim()} onClick={() => setConfirm("approve")}>Approve · pay <Amount wei={claim.amountWei} /></button>
            <button type="button" className="btn danger" disabled={!reason.trim()} onClick={() => setConfirm("deny")}>Decline</button>
          </div>
        </div>
      ) : (
        <div className={`ins-confirm tone-${confirm === "approve" ? "ok" : "bad"}`} role="alertdialog" aria-label={confirm === "approve" ? "Confirm payment" : "Confirm decline"}>
          <div>
            <b>{confirm === "approve" ? <>Pay <Amount wei={claim.amountWei} /> to the owner?</> : "Decline this claim?"}</b>
            <p className="muted small">{confirm === "approve" ? "Sent from the pool on 0G Chain. This can't be undone." : "Nothing is paid. The owner sees your reason."}</p>
          </div>
          <div className="row">
            <button type="button" className={`btn ${confirm === "approve" ? "primary" : "danger"}`} disabled={busy} onClick={() => decide(confirm === "approve")} autoFocus>
              {busy ? <><Spinner /> Sending…</> : confirm === "approve" ? "Confirm and pay" : "Confirm decline"}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Back</button>
          </div>
        </div>
      )}
      {msg && <PlainError title="Couldn't send the decision" raw={msg} fallback="The decision didn't go through. Nothing was paid. Try again." />}
    </div>
  );
}

function Decided({ claim }: { claim: any }) {
  if (claim.status === "PAID") return <PaidMoment claim={claim} who="insurer" />;
  if (claim.status === "PAYING") return <div className="ins-wait" role="status"><Spinner label="Paying" /><div><b>Approved. Paying from the pool on 0G Chain…</b>{claim.review?.reason && <p className="muted">“{claim.review.reason}”</p>}</div></div>;
  if (claim.status === "DENIED") return <Callout tone="bad" title={`Declined${claim.review?.at ? ` · ${when(claim.review.at)}` : ""}`}>{claim.review?.reason ? <>“{claim.review.reason}”</> : null}</Callout>;
  if (claim.status === "FAILED") return <div className="stack-tight"><PlainError title="Not paid" raw={claim.failure} fallback="The payout couldn't be sent from the pool." />{claim.review?.reason && <p className="muted">Your reason: “{claim.review.reason}”</p>}</div>;
  return null;
}
