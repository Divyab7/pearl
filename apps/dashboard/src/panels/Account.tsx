// Account: Sign in with World ID (Agent Pass), payout wallet, link the robot (the device signs the link itself).
import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";

export function useAccount(tick) {
  const [account, setAccount] = useState(null);
  const refresh = () => get("/api/account").then(setAccount).catch(() => setAccount(null));
  useEffect(() => {
    refresh();
  }, [tick]);
  return { account, refresh };
}

function WorldPrompt({ prompt, onCancel, label }) {
  if (!prompt) return null;
  const url = prompt.verificationUri;
  return (
    <div className="human-check">
      <b>{label}</b>
      <p>
        Open <a href={url} target="_blank" rel="noreferrer">{url}</a> and approve in World App
        {prompt.userCode ? <> with code <code>{prompt.userCode}</code></> : null}.
      </p>
      <button className="danger" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function Account({ account, refresh }) {
  const [prompt, setPrompt] = useState(null);
  const [msg, setMsg] = useState("");
  const [wallet, setWallet] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);

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
        else setMsg(`Sign-in ${s.reason}${s.detail ? `: ${s.detail}` : ""}. You are not signed in.`);
      }, 2000);
    } catch (e) {
      setMsg(e.message);
    }
  };
  const cancel = async () => {
    if (prompt) await post(`/api/auth/cancel/${prompt.attemptId}`).catch(() => {});
  };
  const act = (p, body) => post(p, body).then(() => { setMsg(""); refresh(); }).catch((e) => setMsg(e.message));

  return (
    <section className="panel account">
      <header>
        <h2>Account</h2>
        <span className="muted">World ID Agent Pass</span>
        {account && <button onClick={() => act("/api/auth/logout")}>Sign out</button>}
      </header>
      {!account && !prompt && (
        <>
          <p className="muted">Sign in to link your robot, watch its record and claim rewards after incidents.</p>
          <button className="primary" onClick={signIn}>Sign in with World ID</button>
        </>
      )}
      <WorldPrompt prompt={prompt} onCancel={cancel} label="Approve the sign-in in World App" />
      {account && (
        <>
          <dl className="sensors">
            <dt>account</dt><dd className="mono">{account.accountId.slice(0, 12)}…</dd>
            <dt>wallet</dt><dd className="mono">{account.wallet ?? "not set"}</dd>
          </dl>
          <div className="controls">
            <input placeholder="0x… payout wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} />
            <button onClick={() => act("/api/account/wallet", { address: wallet })}>Save wallet</button>
          </div>
          <div className="controls">
            <button onClick={() => act("/api/robots/link")}>Link this robot</button>
            <span className="muted">the robot signs the link with its own key</span>
          </div>
          <ul className="events">
            {account.robots.map((r) => (
              <li key={r.address}><b>{r.deviceId}</b> <span className="mono">{r.address}</span> <span className="muted">linked {r.linkedAt.slice(0, 16)}</span></li>
            ))}
            {account.robots.length === 0 && <li className="muted">No robot linked yet.</li>}
          </ul>
        </>
      )}
      {msg && <p className="warn">{msg}</p>}
    </section>
  );
}

export { WorldPrompt };
