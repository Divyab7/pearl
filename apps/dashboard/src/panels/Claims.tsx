// Reward claims: an incident on your robot → fresh World ID Agent Pass → IDKit Proof of Human → insurer → RewardPool.
// The browser never sees a secret: it gets the Agent Pass link/code and an IDKit request signed by the backend, and it
// forwards IDKit's result (or its error code) to the backend, which validates everything before anything is paid.
import { useEffect, useRef, useState } from "react";
import { IDKit, proofOfHuman } from "@worldcoin/idkit-core";
import { get, post } from "../api";
import { WorldPrompt } from "./Account";

function IdkitStep({ claim, onDone }) {
  const [uri, setUri] = useState("");
  const [err, setErr] = useState("");
  const abort = useRef(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const cfg = await get(`/api/claims/${claim.claimId}/idkit`);
        const request = await IDKit.request({
          app_id: cfg.app_id,
          action: cfg.action,
          rp_context: cfg.rp_context,
          allow_legacy_proofs: false,
          environment: cfg.environment,
          action_description: `Claim the reward for incident ${claim.episodeId}`,
        }).preset(proofOfHuman({ signal: cfg.signal }));
        if (!live) return;
        setUri(request.connectorURI);
        abort.current = new AbortController();
        const out = await request.pollUntilCompletion({ signal: abort.current.signal });
        const body = out.success ? { result: out.result } : { error: String(out.error) };
        onDone(await post(`/api/claims/${claim.claimId}/idkit`, body));
      } catch (e) {
        if (live) setErr(e.message);
      }
    })();
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [claim.claimId]);
  return (
    <div className="human-check">
      <b>Prove you are a unique human (IDKit, Proof of Human)</b>
      {uri ? <p>Open <a href={uri} target="_blank" rel="noreferrer">this World App link</a> to approve. One claim per person per incident.</p> : <p className="muted">Preparing the request…</p>}
      {err && <p className="warn">{err}</p>}
      <button className="danger" onClick={() => abort.current?.abort()}>Cancel</button>
    </div>
  );
}

export function Claims({ tick, account }) {
  const [claims, setClaims] = useState([]);
  const [claimable, setClaimable] = useState([]);
  const [msg, setMsg] = useState("");
  const timer = useRef(null);
  const load = () => {
    if (!account) return;
    get("/api/claims").then(setClaims).catch(() => {});
    get("/api/claimable").then((r) => setClaimable(r.items)).catch(() => {});
  };
  useEffect(load, [tick, account?.accountId, account?.robots?.length]);
  useEffect(() => {
    clearInterval(timer.current);
    if (claims.some((c) => c.status === "AGENT_PASS" || c.status === "PAYING")) timer.current = setInterval(load, 2000);
    return () => clearInterval(timer.current);
  }, [claims.map((c) => c.status).join()]);

  const start = (episodeId) => post("/api/claims", { episodeId }).then(() => { setMsg(""); load(); }).catch((e) => setMsg(e.message));
  const cancel = (id) => post(`/api/claims/${id}/cancel`).then(load).catch((e) => setMsg(e.message));
  const open = new Set(claims.filter((c) => c.status !== "FAILED").map((c) => c.episodeId));

  return (
    <section className="panel claims">
      <header><h2>Claims</h2><span className="muted">incident → World ID → IDKit → insurer → RewardPool</span></header>
      {!account && <p className="muted">Sign in with World ID to claim rewards for incidents on your robot.</p>}
      {account && (
        <>
          <h3>Incidents on your robots</h3>
          {claimable.length === 0 && <p className="muted">None yet. A bump the model rates severity ≥ 2 becomes claimable.</p>}
          <ul className="events">
            {claimable.map((i) => (
              <li key={i.episodeId}>
                <span className="mono">{i.episodeId}</span> <span className={`badge out-${i.outcome}`}>{i.outcome}</span> severity {i.severity}{" "}
                {i.claimable && !open.has(i.episodeId)
                  ? <button className="primary" onClick={() => start(i.episodeId)}>Claim reward</button>
                  : <span className="muted">{i.claimable ? "claim in progress" : "below severity 2"}</span>}
              </li>
            ))}
          </ul>
          {claims.map((c) => (
            <article key={c.claimId} className="claim">
              <header><b className="mono">{c.claimId}</b> <span className="muted">{c.episodeId}</span><span className={`badge claim-${c.status}`}>{c.status}</span></header>
              {c.status === "AGENT_PASS" && <WorldPrompt prompt={c.agentPass?.prompt} onCancel={() => cancel(c.claimId)} label="Confirm it is you: fresh World ID Agent Pass" />}
              {c.status === "IDKIT" && <IdkitStep claim={c} onDone={load} />}
              {c.failure && <p className="warn">Not paid: {c.failure}</p>}
              {c.payout && <p className="ok">Paid {Number(c.payout.amountWei) / 1e18} test 0G · tx <span className="mono">{c.payout.txHash.slice(0, 14)}…</span></p>}
              <ol className="timeline">{c.history.map((h, k) => <li key={k}><b>{h.status}</b> {h.note}</li>)}</ol>
            </article>
          ))}
        </>
      )}
      {msg && <p className="warn">{msg}</p>}
    </section>
  );
}
