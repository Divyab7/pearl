import { short } from "../api";

export function DecisionCard({ r }) {
  if (r.kind !== "decision") return null;
  return (
    <article className={`decision ${r.source}`}>
      <header>
        <b>{r.checkpoint}</b>
        <span className={`badge src-${r.source}`}>{r.source === "0g" ? "0G" : "FAILSAFE"}</span>
        <span className="muted">{r.latencyMs} ms</span>
      </header>
      <dl>
        <dt>model</dt><dd>{r.model ?? "null"}</dd>
        <dt>request id</dt><dd className="mono" title={r.requestId ?? ""}>{r.requestId ?? "null"}</dd>
        <dt>tee verified</dt><dd>{r.teeVerified === null ? "—" : String(r.teeVerified)}</dd>
        <dt>policy</dt><dd>{r.policy}</dd>
        {r.override && (<><dt>override</dt><dd className="warn">{r.override}</dd></>)}
        {r.error && (<><dt>error</dt><dd className="warn">{r.error}</dd></>)}
        <dt>commands</dt><dd className="mono">{r.commandsSent.length ? r.commandsSent.join("  ") : "none"}</dd>
        <dt>record</dt><dd className="mono">#{r.idx} {short(r.recordHash, 12)}</dd>
      </dl>
      {r.frameRoot && <img className="frame" src={`/api/frames/${r.episodeId}/${r.idx}`} alt={`camera frame for ${r.checkpoint}`} loading="lazy" />}
      {r.parsed && <pre>{JSON.stringify(r.parsed, null, 1)}</pre>}
    </article>
  );
}

export function Decisions({ records }) {
  const ds = records.filter((r) => r.kind === "decision");
  const evs = records.filter((r) => r.kind === "event" && !["episode_start"].includes(r.ev));
  return (
    <section className="panel decisions">
      <header><h2>Decisions</h2><span className="muted">current episode</span></header>
      {ds.length === 0 && <p className="muted">Start an episode to see each 0G decision here.</p>}
      {ds.map((r) => <DecisionCard key={r.idx} r={r} />)}
      {evs.length > 0 && (
        <ul className="events">
          {evs.map((e) => <li key={e.idx}><span className="mono">#{e.idx}</span> {e.ev} <span className="muted">{JSON.stringify(e.data)}</span></li>)}
        </ul>
      )}
    </section>
  );
}
