import { useEffect, useState } from "react";
import { get, short } from "../api";

export function Episodes({ tick, selected, onSelect }) {
  const [list, setList] = useState({ source: "local", items: [] });
  const [err, setErr] = useState("");
  const [incidents, setIncidents] = useState(false);
  useEffect(() => {
    const qs = incidents ? "?armId=arm-1&kind=incident" : "";
    get(`/api/episodes${qs}`).then((l) => { setList(l); setErr(""); }).catch((e) => setErr(e.message));
  }, [tick, incidents]);
  return (
    <section className="panel episodes">
      <header>
        <h2>Episodes</h2>
        <span className={`badge ${list.source === "arkiv" ? "mod-ok" : "mod-not_configured"}`}>read from {list.source === "arkiv" ? "Arkiv" : "local files"}</span>
        <label className="muted"><input type="checkbox" checked={incidents} onChange={(e) => setIncidents(e.target.checked)} /> incidents for arm-1</label>
      </header>
      {list.note && <p className="muted">{list.note}</p>}
      {list.query && <pre className="query" title="the exact query the Arkiv node ran">{list.query}</pre>}
      {err && <p className="warn">{err}</p>}
      <table>
        <thead><tr><th>episode</th><th>outcome</th><th>decisions</th><th>head</th></tr></thead>
        <tbody>
          {list.items.map((e) => (
            <tr key={e.episodeId} className={selected === e.episodeId ? "sel" : ""} onClick={() => onSelect(e.episodeId)}>
              <td className="mono">{e.episodeId}{e.kind === "incident" && <span className="badge out-ABORTED"> incident</span>}</td>
              <td><span className={`badge out-${e.outcome}`}>{e.outcome}</span></td>
              <td>{e.n}</td>
              <td className="mono" title={e.entityKey ? `Arkiv entity ${e.entityKey}` : ""}>{short(e.headHash, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
