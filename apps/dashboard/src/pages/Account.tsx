// Account (#/account): the owner's four-step checklist. 1 sign in with World ID · 2 unlock key (create / back up /
// restore) · 3 link the robot · 4 payout wallet. Each step says done or next, offers one action and a recovery hint.
// Moved here from the old Setup tab of pages/MyRobot.tsx; same API calls.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { get, post } from "../api";
import { to } from "../router";
import { KeySetup, WorldPrompt } from "../components/KeySetup";
import { Chip, Field, Icon, Spinner } from "../components/ui";
import { InfoTip, PageHeader, PlainError, Skeleton, StatusPill, TechDetails } from "../components/blocks";
import { useAccount } from "../lib/account";
import { loadKey } from "../lib/keys";
import { fullWhen } from "../components/run";
import { TIP } from "../lib/words";
import "./account.css";

type StepState = "done" | "next" | "todo" | "attention" | "waiting";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function Step({ n, title, state, why, hint, children, waitingFor }: {
  n: number; title: string; state: StepState; why: ReactNode; hint?: ReactNode; children?: ReactNode; waitingFor?: string;
}) {
  const hid = useId();
  const pill = state === "done" ? <StatusPill tone="ok" size="sm">Done</StatusPill>
    : state === "next" ? <StatusPill tone="info" size="sm">Next</StatusPill>
      : state === "attention" ? <StatusPill tone="warn" size="sm">Needs attention</StatusPill>
        : state === "todo" ? <StatusPill tone="neutral" size="sm">To do</StatusPill>
        : <StatusPill tone="neutral" size="sm">{waitingFor ? `After ${waitingFor}` : "Later"}</StatusPill>;
  return (
    <li className={`ac-step st-${state}`} aria-labelledby={hid} aria-current={state === "next" || state === "attention" ? "step" : undefined}>
      <span className="ac-mark" aria-hidden>{state === "done" ? <Icon name="check" size={14} /> : state === "attention" ? <Icon name="alert" size={14} /> : n}</span>
      <div className="ac-body">
        <div className="ac-head">
          <h2 id={hid} className="ac-title"><span className="sr-only">Step {n}: </span>{title}</h2>
          {pill}
        </div>
        <p className="ac-why">{why}</p>
        {state !== "waiting" && children}
        {hint && state !== "waiting" && <p className="ac-hint"><Icon name="info" size={13} /> {hint}</p>}
      </div>
    </li>
  );
}

export function Account({ live }: { live: any }) {
  const { account, refresh } = useAccount(live.tick);
  const [prompt, setPrompt] = useState<any>(null);
  const [msg, setMsg] = useState<string>("");
  const [wallet, setWallet] = useState("");
  const [walletTouched, setWalletTouched] = useState(false);
  const [editWallet, setEditWallet] = useState(false);
  const [busy, setBusy] = useState("");
  const [, setKeyTick] = useState(0);
  const timer = useRef<any>(null);
  useEffect(() => () => clearInterval(timer.current), []);

  const st = live.state;
  const robotAddr: string | undefined = st?.deviceAddress;
  const robotName: string = st?.deviceId ?? "your robot";
  const linkedRobot = account?.robots?.find((r: any) => r.address.toLowerCase() === robotAddr?.toLowerCase());
  const linked = !!linkedRobot;

  const signIn = async () => {
    setMsg("");
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
        else setMsg(`Sign-in ${s.reason}${s.detail ? `: ${s.detail}` : ""}. You are not signed in; try again.`);
      }, 2000);
    } catch (e: any) {
      setMsg(e.message);
    }
  };
  const cancelSignIn = () => {
    clearInterval(timer.current);
    if (prompt) post(`/api/auth/cancel/${prompt.attemptId}`).catch(() => {});
    setPrompt(null);
  };
  const act = (label: string, p: string, body?: unknown) => {
    setBusy(label);
    setMsg("");
    return post(p, body).then(() => { refresh(); return true; }).catch((e) => { setMsg(e.message); return false; }).finally(() => setBusy(""));
  };
  const signOut = () => post("/api/auth/logout").then(refresh).catch((e) => setMsg(e.message));

  if (account === undefined) {
    return (
      <div className="page account narrowish">
        <PageHeader title="Account" description="Loading your account…" />
        <Skeleton lines={6} label="Loading your account" />
      </div>
    );
  }

  // ---- step states
  const signedIn = !!account;
  const keyRec = signedIn ? loadKey("owner", account.accountId) : null;
  const keyHere = !!(keyRec && account?.key && keyRec.kid === account.key.kid);
  const backedUp = keyHere && !!localStorage.getItem(`pearl.backup.${keyRec!.kid}`);
  const keyDone = keyHere && backedUp;
  const staleLink = !!(linkedRobot && account?.key && linkedRobot.ownerKid !== account.key.kid);
  const linkDone = linked && !staleLink;
  const walletDone = !!account?.wallet;
  const done = [signedIn, keyDone, linkDone, walletDone];
  const doneN = done.filter(Boolean).length;
  const firstOpen = done.findIndex((d) => !d);

  // only the first open step is "Next"; later open ones are "To do"
  const nx = (i: number): StepState => (i === firstOpen ? "next" : "todo");
  const s1: StepState = signedIn ? "done" : "next";
  const s2: StepState = !signedIn ? "waiting" : keyDone ? "done" : account.key && !keyHere ? "attention" : nx(1);
  const s3: StepState = !signedIn || !account.key ? "waiting" : staleLink ? "attention" : linkDone ? "done" : nx(2);
  const s4: StepState = !signedIn ? "waiting" : walletDone ? "done" : nx(3);
  const walletValid = ADDR_RE.test(wallet.trim());

  return (
    <div className="page account">
      <PageHeader
        title="Account"
        description="Four steps so only you can open your robot's records, and insurance payouts reach you."
        actions={<a className="ac-insurer" href={to.insurance("insurer")}><Icon name="wallet" size={14} /> Insurer? Sign in with your wallet</a>}
      />
      <div className="ac-grid">
        <div className="stack">
          <div className="ac-progress" role="group" aria-label="Setup progress">
            <div className="ac-progress-text">
              <b>{doneN === 4 ? "All set" : `${doneN} of 4 done`}</b>
              <span className="muted small">{doneN === 4 ? "Your robot locks every run for your key, and payouts go to your wallet." : firstOpen >= 0 ? `Next: ${["sign in", "your unlock key", "link your robot", "your payout wallet"][firstOpen]}.` : ""}</span>
            </div>
            <div className="ac-bar" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={doneN} aria-valuetext={`${doneN} of 4 steps done`}>
              {done.map((d, i) => <span key={i} className={d ? "on" : ""} />)}
            </div>
          </div>

          <ol className="ac-steps">
            <Step n={1} title="Sign in with World ID" state={s1}
              why={signedIn ? "You're signed in as a verified human. Pearl keeps only an anonymous account number, never who you are." : "Proves you're a real, unique person without revealing who you are. Owners sign in to open their runs and claim insurance."}
              hint={signedIn ? undefined : "You need World App on your phone. Watching and driving the robot at its site needs no sign-in."}>
              {!signedIn && !prompt && <div className="row"><button type="button" className="btn primary" onClick={signIn}>Sign in with World ID</button><InfoTip text={TIP.worldId} /></div>}
              {!signedIn && <WorldPrompt prompt={prompt} onCancel={cancelSignIn} label="Approve the sign-in in World App" />}
              {signedIn && (
                <div className="row">
                  <button type="button" className="btn small-btn" onClick={signOut}><Icon name="logout" /> Sign out</button>
                  <TechDetails boxless label="Account details">
                    <Chip label="Account id" value={account.accountId} />
                  </TechDetails>
                </div>
              )}
            </Step>

            <Step n={2} title="Your unlock key" state={s2} waitingFor="you sign in"
              why={<>Only you can open your robot's records. The robot locks every run for this key; it's made in this browser and never sent to anyone.<InfoTip text={TIP.locked} /></>}
              hint={s2 === "attention" ? "On a new browser? Restore from the backup file you downloaded. Lost it? Create a new key, then link your robot again." : keyDone ? "Keep the backup file somewhere safe and offline. Anyone holding it can read your runs." : "Without a backup, clearing this browser loses access to your runs."}>
              {signedIn && (
                <div className="ac-key">
                  <KeySetup embedded quiet role="owner" who={account.accountId} registeredKid={account.key?.kid ?? null}
                    register={(publicJwk) => post("/api/account/key", { publicJwk }).then(refresh)}
                    afterReplace="Now link your robot again (step 3) so it re-locks your runs for the new key."
                    onKeyChange={() => setKeyTick((t) => t + 1)} />
                  {account.key && (
                    <TechDetails boxless label="Key details">
                      <Chip label="Key fingerprint" value={account.key.kid} display={account.key.kid} />
                    </TechDetails>
                  )}
                </div>
              )}
            </Step>

            <Step n={3} title="Link your robot" state={s3} waitingFor="your unlock key"
              why={linkDone ? <>Linked to <b>{linkedRobot.deviceId}</b> on {fullWhen(linkedRobot.linkedAt)}. It locks every new run for your key.</> : staleLink ? <><b>{linkedRobot.deviceId}</b> still uses your old key. Link it again so it re-locks your runs for the new one.</> : <>Tells <b>{robotName}</b> to lock its runs for your key. The robot signs the link with its own key.</>}
              hint={live.connected === false ? "The robot looks offline. It must be online to sign the link." : linkDone ? "Replaced your key? Link again here." : "The robot must be online. It takes a few seconds."}>
              <div className="row">
                <button type="button" className={`btn ${linkDone ? "" : "primary"}`} disabled={!!busy || !account?.key} onClick={() => act("link", "/api/robots/link")}>
                  {busy === "link" ? <><Spinner /> Waiting for the robot…</> : linkDone ? "Link again" : `Link ${robotName}`}
                </button>
              </div>
              {account?.robots?.length > 0 && (
                <TechDetails boxless label="Linked robots">
                  <ul className="ac-robots">
                    {account.robots.map((r: any) => (
                      <li key={r.address}>
                        <Icon name="robot" /> <b>{r.deviceId}</b> <span className="muted small">linked {fullWhen(r.linkedAt)}</span>
                        <Chip label="Robot address" value={r.address} />
                        {account.key && r.ownerKid !== account.key.kid && <StatusPill tone="warn" size="sm">Older key</StatusPill>}
                      </li>
                    ))}
                  </ul>
                </TechDetails>
              )}
            </Step>

            <Step n={4} title="Payout wallet" state={s4} waitingFor="you sign in"
              why={walletDone && !editWallet ? <>Approved insurance payouts go to your wallet ending <b className="mono">{account.wallet.slice(-4)}</b> on 0G Chain.</> : "Where approved insurance payouts are sent, on 0G Chain."}
              hint={walletDone ? "Changing it only affects future payouts." : "Paste the full address from your wallet app. It starts with 0x."}>
              {walletDone && !editWallet && (
                <div className="row">
                  <button type="button" className="btn" onClick={() => { setEditWallet(true); setWallet(""); setWalletTouched(false); }}>Change wallet</button>
                  <TechDetails boxless label="Wallet address"><Chip label="Wallet" value={account.wallet} /></TechDetails>
                </div>
              )}
              {signedIn && (!walletDone || editWallet) && (
                <form className="ac-wallet" onSubmit={(e) => { e.preventDefault(); setWalletTouched(true); if (walletValid) act("wallet", "/api/account/wallet", { address: wallet.trim() }).then((ok) => { if (ok) { setWallet(""); setEditWallet(false); setWalletTouched(false); } }); }}>
                  <Field label={walletDone ? "New wallet address" : "Wallet address"} hint={walletTouched && wallet && !walletValid ? undefined : "A 0x address, 42 characters."}>
                    <input value={wallet} onChange={(e) => setWallet(e.target.value)} onBlur={() => setWalletTouched(true)} placeholder="0x…" spellCheck={false} autoComplete="off" className="mono"
                      aria-invalid={walletTouched && !!wallet && !walletValid} />
                  </Field>
                  {walletTouched && wallet && !walletValid && <p className="ac-err" role="alert"><Icon name="alert" size={13} /> That isn't a full wallet address. It should start with 0x and be 42 characters long ({wallet.trim().length} now).</p>}
                  <div className="row">
                    <button type="submit" className="btn primary" disabled={!!busy || !wallet.trim()}>{busy === "wallet" ? <Spinner /> : null} Save wallet</button>
                    {editWallet && <button type="button" className="btn ghost" onClick={() => setEditWallet(false)}>Cancel</button>}
                  </div>
                </form>
              )}
            </Step>
          </ol>
          {msg && <PlainError inline raw={msg} fallback="That didn't go through (World ID or the robot didn't answer as expected). Try again." />}
          {doneN === 4 && (
            <div className="ac-done">
              <Icon name="check" size={16} />
              <span>You're all set. <a href={to.robot()}>Go to your robot</a> or <a href={to.insurance("owner")}>see insurance</a>.</span>
            </div>
          )}
        </div>
        <PrivacyAside />
      </div>
    </div>
  );
}

function PrivacyAside() {
  return (
    <aside className="ac-aside" aria-label="Privacy">
      <h2 className="ac-aside-title">What Pearl can see</h2>
      <ul className="ticks">
        <li><Icon name="check" size={14} /> An anonymous account number and your payout wallet</li>
        <li><Icon name="check" size={14} /> The public half of your unlock key</li>
        <li><Icon name="check" size={14} /> Each run's public labels: result, incident, time</li>
      </ul>
      <h2 className="ac-aside-title">What it can't see</h2>
      <ul className="ticks no">
        <li><Icon name="lock" size={14} /> Your unlock key: it stays in this browser and your backup file</li>
        <li><Icon name="lock" size={14} /> Inside your runs: decisions, camera photos, moves</li>
        <li><Icon name="lock" size={14} /> Who you are behind World ID</li>
      </ul>
    </aside>
  );
}
