// Insurer: sign in with the insurance company's wallet, keep a receiving key, review claimed incidents and decide.
import { useEffect, useState } from "react";
import { ago, get, og, post, short, useConfig, when } from "../api";
import { go, href } from "../router";
import { KeySetup } from "../components/KeySetup";
import { RunDetail, Severity } from "../components/run";
import { Amount, Badge, Callout, Card, Chip, CopyButton, Dl, DotLabel, Empty, Field, Icon, Spinner, Tabs } from "../components/ui";
import { loadKey } from "../lib/keys";
import { unwrapWith, type FullCheck } from "../lib/fullcheck";
import { RunRef } from "./MyRobot";
import { ArkivRecord, ClaimBadge } from "../components/claims";

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<any> };
  }
}

export function Insurer({ tick, claimId }: { tick: number; claimId?: string }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState("");
  const load = () => get("/api/insurer").then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [tick]);

  if (err) return <div className="page"><Callout tone="bad" title="Insurer page unavailable">{err}</Callout></div>;
  if (!info) return <div className="page"><p className="muted"><Spinner /> Loading…</p></div>;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Insurer</div>
          <h1>Claims review</h1>
          <p className="muted">Unlock each claimed incident, check it and decide. Approved claims are paid from the insurance pool on 0G Chain, at the fixed amount for their severity.</p>
        </div>
        {info.signedIn && (
          <div className="page-head-side">
            <Chip label="Insurer" value={info.address} />
            <button type="button" className="btn ghost" onClick={() => post("/api/insurer/logout").then(load)}>Sign out</button>
          </div>
        )}
      </div>
      {!info.configured ? (
        <Card><Empty title="The insurer isn't set up on this dashboard">Whoever runs this dashboard needs to name the insurer's wallet before claims can be reviewed.</Empty></Card>
      ) : !info.signedIn ? (
        <SignIn address={info.address} onDone={load} />
      ) : (
        <Signed info={info} reload={load} tick={tick} claimId={claimId} />
      )}
    </div>
  );
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
      if (String(acct).toLowerCase() !== address.toLowerCase()) throw new Error(`Your wallet is on ${short(acct, 8)}. Switch to the insurer wallet ${short(address, 8)} and try again.`);
      const ch = await post("/api/insurer/challenge");
      const signature = await window.ethereum!.request({ method: "personal_sign", params: [ch.message, acct] });
      await post("/api/insurer/signin", { nonce: ch.nonce, signature });
      onDone();
    } catch (e: any) {
      setMsg(e?.code === 4001 ? "You declined the signature. You are not signed in." : e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="narrow">
      <Card title="Sign in with the insurer wallet" sub="You sign a one-time message. It proves you hold the wallet and moves no funds.">
        <Chip label="Expected insurer wallet" value={address} href={cfg.explorer ? `${cfg.explorer}/address/${address}` : null} />
        <button type="button" className="btn primary lg" onClick={signIn} disabled={busy || !hasWallet} aria-describedby={!hasWallet ? "no-wallet" : undefined}>{busy ? <><Spinner /> Waiting for your wallet…</> : <><Icon name="wallet" /> Connect wallet and sign in</>}</button>
        {!hasWallet && <div id="no-wallet"><Callout tone="warn" title="No wallet found in this browser">Open this page in a browser with MetaMask (or another wallet) that holds the insurer account, then reload.</Callout></div>}
        {msg && <Callout tone="bad">{msg}</Callout>}
      </Card>
    </div>
  );
}

/** "10:52" (or "6 Nov 10:52" on another day) from the run id's start time. */
const incidentTime = (id: string) => {
  const m = id.match(/^ep_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/);
  if (!m) return id.slice(-4);
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

function Signed({ info, reload, tick, claimId }: { info: any; reload: () => void; tick: number; claimId?: string }) {
  const [claims, setClaims] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const rec = loadKey("insurer", info.address);
  const keyReady = !!(info.key && rec && rec.kid === info.key.kid);
  const loadClaims = () => get("/api/insurer/claims").then((c) => { setClaims(c); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => {
    void loadClaims();
    const id = setInterval(loadClaims, 5000);
    return () => clearInterval(id);
  }, [tick]);
  const waiting = claims.filter((c) => c.status === "INSURER_REVIEW");
  const done = claims.filter((c) => c.status !== "INSURER_REVIEW");
  const [qtab, setQtab] = useState<"waiting" | "decided">("waiting");
  // open the first waiting claim when none is chosen, so there is never an empty pane while work is waiting
  const sel = claims.find((c) => c.claimId === claimId) ?? (claimId ? null : waiting[0] ?? null);
  const selected = sel;
  // the queue tab follows the open claim (a decided claim opens on the Decided tab)
  useEffect(() => {
    if (sel) setQtab(sel.status === "INSURER_REVIEW" ? "waiting" : "decided");
  }, [sel?.claimId, sel?.status]);

  return (
    <div className="stack">
      {!keyReady && (
        <Card title="Receiving key" sub="Owners lock each claimed incident for this key. You need it on this browser to open them.">
          <KeySetup role="insurer" who={info.address} registeredKid={info.key?.kid ?? null} register={(publicJwk) => post("/api/insurer/key", { publicJwk }).then(reload)} />
        </Card>
      )}
      <PoolCard />
      <div className="split">
        <Card title="Claims">
          <Tabs label="Claim queue" active={qtab} onChange={(t) => setQtab(t as any)} tabs={[{ id: "waiting", label: "Waiting", count: waiting.length }, { id: "decided", label: "Decided", count: done.length }]} />
          {err && <Callout tone="bad">{err}</Callout>}
          {claims.length === 0 ? <Empty title="No claims yet">Claims appear here after the owner passes both World ID checks.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Claims, waiting first</caption>
                <thead><tr><th scope="col">Incident</th><th scope="col">Submitted</th><th scope="col" className="num">Pays</th></tr></thead>
                <tbody>
                  {(qtab === "waiting" ? waiting : done).map((c) => (
                    <tr key={c.claimId} className={sel?.claimId === c.claimId ? "sel" : ""}>
                      <td>
                        <button type="button" className="row-link cell-stack" onClick={() => go("insurer", c.claimId)} title={c.episodeId} aria-current={sel?.claimId === c.claimId ? "true" : undefined}>
                          <span className="row"><span>Incident · {incidentTime(c.episodeId)}</span><Severity value={c.severity} incident /></span>
                          {qtab === "decided" && <InsurerStatus status={c.status} />}
                        </button>
                      </td>
                      <td className="small nowrap tabular" title={ago(c.createdAt)}>{new Date(c.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="num nowrap"><Amount wei={c.amountWei} /></td>
                    </tr>
                  ))}
                  {(qtab === "waiting" ? waiting : done).length === 0 && <tr><td colSpan={3} className="muted small">{qtab === "waiting" ? "Nothing waiting. New claims appear here." : "No decisions yet."}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {info.key && keyReady && <p className="muted small"><Icon name="key" size={12} /> This browser holds the insurer key needed to open claimed incidents.</p>}
        </Card>
        <div>
          {selected ? <Review claim={selected} rec={keyReady ? rec : null} onDecided={loadClaims} /> : <Card><Empty title="Pick a claim">Select a claim to unlock the incident and decide.</Empty></Card>}
        </div>
      </div>
    </div>
  );
}

function Review({ claim, rec, onDecided }: { claim: any; rec: any; onDecided: () => void }) {
  const cfg = useConfig();
  const [fc, setFc] = useState<FullCheck | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "deny" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setFc(null);
    setReason("");
    setConfirm(null);
    setMsg("");
  }, [claim.claimId]);
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
  const verified = fc?.result === "VALID";
  const decision = <DecisionPanel claim={claim} verified={verified} fcDone={!!fc} reason={reason} setReason={setReason} confirm={confirm} setConfirm={setConfirm} busy={busy} msg={msg} decide={decide} cfg={cfg} />;
  return (
    <div className="stack">
      <Card title="Claim" sub={<>Submitted {when(claim.createdAt)}</>} actions={<InsurerStatus status={claim.status} />}>
        <Dl rows={[
          ["Incident", <RunRef id={claim.episodeId} to="verify" label="Incident" />],
          ["Severity", <Severity value={claim.severity} incident />],
          [claim.status === "PAID" ? "Paid" : claim.status === "DENIED" || claim.status === "FAILED" ? "Would have paid" : "Pays if approved", <Amount wei={claim.payout?.amountWei ?? claim.amountWei} paid={claim.status === "PAID"} />],
          ["Payout wallet", <span className="row"><code className="mono" title={claim.wallet}>{claim.wallet.slice(0, 6)}…{claim.wallet.slice(-4)}</code><CopyButton value={claim.wallet} label="Copy payout wallet" /></span>],
          ["Identity", <span className="row small"><DotLabel tone="ok">Robot owner confirmed</DotLabel><DotLabel tone="ok">Unique person (World ID)</DotLabel></span>],
        ]} />
        <ArkivRecord arkiv={claim.arkiv} />
        <details className="disclosure">
          <summary>Technical details</summary>
          <Dl rows={[
            ["Claim", <code className="mono">{claim.claimId}</code>],
            ["Run", <code className="mono">{claim.episodeId}</code>],
            ["Claimant id", <code className="mono" title="World ID nullifier: one per person per incident, reveals no identity">{short(claim.nullifier, 10)}</code>],
            ["Checks passed", "World ID Agent Pass (owner) · IDKit Proof of Human (unique person)"],
          ]} />
        </details>
      </Card>
      <RunDetail
        episodeId={claim.episodeId}
        device={claim.device}
        unlock={rec ? () => unwrapWith(claim.insurerKey, rec, claim.device, claim.episodeId) : null}
        lockedReason="Set up or restore your receiving key to unlock this incident."
        startAtIncident
        unlockLabel="Unlock incident"
        onFull={setFc}
      />
      <div className="decision-dock">{decision}</div>
    </div>
  );
}

function DecisionPanel({ claim, verified, fcDone, reason, setReason, confirm, setConfirm, busy, msg, decide, cfg }: any) {
  const open = claim.status === "INSURER_REVIEW";
  return (
    <>
      {open ? (
        <Card title="Decision" sub="The owner sees your decision and reason.">
          <Field label="Reason" hint="Required. Keep it factual: what you saw in the run.">
            <textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bump at 14:02 matches severity 2; arm stopped as designed." />
          </Field>
          {!confirm ? (
            <div className="row">
              <button type="button" className="btn primary" disabled={!verified || !reason.trim()} onClick={() => setConfirm("approve")}>Approve · pay {og(claim.amountWei)}</button>
              <button type="button" className="btn danger" disabled={!fcDone || !reason.trim()} onClick={() => setConfirm("deny")}>Deny</button>
              <span className="muted small">{!fcDone ? "Unlock the incident above first." : !verified ? "The contents did not check out: you can deny, not approve." : !reason.trim() ? "Write a reason to decide." : ""}</span>
            </div>
          ) : (
            <Callout tone={confirm === "approve" ? "warn" : "bad"} title={confirm === "approve" ? `Pay ${og(claim.amountWei)} to ${short(claim.wallet, 8)}?` : "Deny this claim?"}>
              <p>{confirm === "approve" ? "The dashboard sends the payout from the RewardPool on 0G Chain. This cannot be undone." : "Nothing is paid. The owner sees your reason."}</p>
              <div className="row">
                <button type="button" className={`btn ${confirm === "approve" ? "primary" : "danger"}`} disabled={busy} onClick={() => decide(confirm === "approve")}>
                  {busy ? <><Spinner /> Sending…</> : confirm === "approve" ? "Confirm and pay" : "Confirm denial"}
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Back</button>
              </div>
            </Callout>
          )}
          {msg && <Callout tone="bad">{msg}</Callout>}
        </Card>
      ) : (
        <Card title="Decision">
          {claim.review && <Callout tone={claim.review.decision === "APPROVED" ? "ok" : "bad"} title={`${claim.review.decision === "APPROVED" ? "Approved" : "Denied"} · ${when(claim.review.at)}`}>“{claim.review.reason}”</Callout>}
          {claim.payout && <Chip label="Payout on 0G Chain" value={claim.payout.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${claim.payout.txHash}` : null} />}
          {claim.status === "FAILED" && <Callout tone="bad" title="Not paid">{claim.failure}</Callout>}
        </Card>
      )}
    </>
  );
}

/** Claim status from the insurer's side. */
function InsurerStatus({ status }: { status: string }) {
  const m: Record<string, [string, any]> = {
    INSURER_REVIEW: ["Needs your decision", "accent"], PAYING: ["Paying", "accent"], PAID: ["Approved · paid", "ok"],
    DENIED: ["Denied", "bad"], FAILED: ["Not paid", "bad"],
  };
  const [w, t] = m[status] ?? [status, "neutral"];
  return <Badge tone={t}>{w}</Badge>;
}

/** The reward pool as 0G Chain shows it: what is left to pay, the cap per claim, recent payouts. */
function PoolCard() {
  const cfg = useConfig();
  const [pool, setPool] = useState<any>(null);
  useEffect(() => {
    get("/api/pool").then(setPool).catch((e) => setPool({ configured: true, error: e.message }));
  }, []);
  if (!pool) return null;
  if (!pool.configured) return <Callout tone="neutral" title="Reward pool not deployed">Approved claims cannot be paid until the RewardPool contract is deployed (pnpm anchor:deploy).</Callout>;
  if (pool.error) return <Callout tone="warn" title="Reward pool unreachable">{pool.error}</Callout>;
  return (
    <Card title="Reward pool" sub="Read from 0G Chain" actions={<Chip label="Contract" value={pool.address} href={cfg.explorer ? `${cfg.explorer}/address/${pool.address}` : null} />}>
      <div className="pool-stats">
        <div><span className="muted small">Balance</span><Amount wei={pool.balanceWei} /></div>
        <div><span className="muted small">Pays per severity point</span><Amount wei={pool.perSeverityWei} /></div>
        <div><span className="muted small">Largest single payout</span><Amount wei={pool.maxPayoutWei} /></div>
        <div><span className="muted small">Paid out</span><span className="tabular">{pool.paid.length} claim{pool.paid.length === 1 ? "" : "s"} · <Amount wei={pool.paid.reduce((t: bigint, p: any) => t + BigInt(p.amountWei), 0n).toString()} paid={pool.paid.length > 0} /></span></div>
      </div>
      {pool.paid.length > 0 && (
        <ul className="list">
          {pool.paid.slice(0, 3).map((p: any) => (
            <li key={p.txHash} className="list-row"><Amount wei={p.amountWei} paid /><Chip label="Payout tx" value={p.txHash} href={cfg.explorer ? `${cfg.explorer}/tx/${p.txHash}` : null} /></li>
          ))}
        </ul>
      )}
    </Card>
  );
}
