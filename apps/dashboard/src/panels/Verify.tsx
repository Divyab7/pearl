import { useEffect, useState } from "react";
import { get, post } from "../api";

export function Verify({ episodeId, tick }) {
  const [v, setV] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = (tamper) => {
    if (!episodeId) return;
    setBusy(true);
    setErr("");
    (tamper ? post(`/api/verify/${episodeId}/tamper`) : get(`/api/verify/${episodeId}`))
      .then(setV)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    setV(null);
    run(false);
  }, [episodeId, tick]);
  return (
    <section className="panel verify">
      <header>
        <h2>Verify</h2>
        {v && <span className={`badge verdict-${v.result}`}>{v.result}</span>}
        {v?.tampered && <span className="warn">edited copy: {v.tampered}</span>}
      </header>
      {!episodeId && <p className="muted">Pick an episode.</p>}
      {err && <p className="warn">{err}</p>}
      {v && (
        <ol className="checks">
          {v.checks.map((c) => (
            <li key={c.id} className={`check ${c.status}`}>
              <b>{c.status}</b> {c.name}
              <div className="muted">{c.detail}</div>
            </li>
          ))}
        </ol>
      )}
      <div className="controls">
        <button onClick={() => run(false)} disabled={!episodeId || busy}>Re-verify</button>
        <button className="danger" onClick={() => run(true)} disabled={!episodeId || busy}>Edit log (1 byte)</button>
      </div>
    </section>
  );
}
