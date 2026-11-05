import { useEffect, useState } from "react";
import { get, short } from "../api";

function Row({ name, m, children }) {
  const s = m?.status ?? "—";
  return (
    <tr>
      <td>{name}</td>
      <td><span className={`badge mod-${s}`}>{s}</span></td>
      <td>{s === "ok" ? children : <span className="muted">{m?.error ?? m?.missing ?? (s === "off" ? "switched off" : "")}</span>}</td>
    </tr>
  );
}

export function Proof({ episodeId, tick }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    if (episodeId) get(`/api/episodes/${episodeId}/meta`).then(setMeta).catch(() => setMeta(null));
  }, [episodeId, tick]);
  return (
    <section className="panel proof">
      <header><h2>Proof</h2><span className="muted">where this episode was written</span></header>
      {!meta && <p className="muted">Pick an episode.</p>}
      {meta && (
        <table>
          <tbody>
            <Row name="0G Storage" m={meta.storage}>
              <a href={meta.storage?.url} target="_blank" rel="noreferrer" className="mono">root {short(meta.storage?.rootHash, 14)}</a>
              <div className="mono muted">tx {short(meta.storage?.txHash, 14)}</div>
            </Row>
            <Row name="0G Chain anchor" m={meta.anchor}>
              <span className="mono">{short(meta.anchor?.txHash, 14)}</span>
            </Row>
            <Row name="Arkiv index" m={meta.arkiv}>
              <span className="mono">{short(meta.arkiv?.entityKey, 14)}</span>
            </Row>
            {meta.zerobot && (
              <Row name="zerobot receipt" m={meta.zerobot}>
                <a href={meta.zerobot?.link} target="_blank" rel="noreferrer">command #{meta.zerobot?.nonce}</a>
              </Row>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
