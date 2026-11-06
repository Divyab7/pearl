// Claim status words, and the claim's public record on Arkiv (one entity per claim, updated as the claim moves).
import { useEffect, useState } from "react";
import { get, og, short, useConfig, when } from "../api";
import { Amount, Badge, Card, Chip, Icon, Spinner } from "./ui";

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";

const CLAIM_WORD: Record<string, [string, any]> = {
  AGENT_PASS: ["Confirm it's you", "info"], IDKIT: ["Unique-human check", "info"], INSURER_REVIEW: ["With the insurer", "info"],
  PAYING: ["Paying", "info"], PAID: ["Paid", "ok"], DENIED: ["Denied", "bad"], FAILED: ["Not paid", "bad"],
};
export function ClaimBadge({ status }: { status: string }) {
  const [w, t] = CLAIM_WORD[status] ?? [status, "neutral"];
  return <Badge tone={t}>{w}</Badge>;
}

/** One line under a claim: where its public record on Arkiv stands. */
export function ArkivRecord({ arkiv }: { arkiv?: { entityKey: string | null; status: string | null; writes: { status: string; txHash: string }[]; error: string | null } | null }) {
  if (!arkiv) return <p className="muted small"><Spinner /> Writing the public record to Arkiv…</p>;
  return (
    <div className="stack-tight">
      {arkiv.entityKey && (
        <div className="row">
          <span className="muted small"><Icon name="db" size={12} /> Public record on Arkiv: <ClaimBadge status={arkiv.status ?? ""} /> · {arkiv.writes.length} update{arkiv.writes.length === 1 ? "" : "s"}</span>
          <Chip label="Arkiv record" value={arkiv.entityKey} href={`${ARKIV_EXPLORER}/entity/${arkiv.entityKey}`} />
        </div>
      )}
      {arkiv.error && <p className="small warn-text"><Icon name="alert" size={12} /> {arkiv.error}</p>}
    </div>
  );
}

/** Public: every claim on a run, read from Arkiv (records written by the insurer desk's wallet only). */
export function RunClaimsOnArkiv({ episodeId, tick }: { episodeId: string; tick?: number }) {
  const cfg = useConfig();
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setR(null);
    setErr("");
    get(`/api/arkiv/claims?episodeId=${encodeURIComponent(episodeId)}`).then((x) => live && setR(x)).catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [episodeId, tick]);
  if (r && !r.configured) return null;
  return (
    <Card title="Claims on this run" sub={<>Read from Arkiv: the insurer desk's public records. Status, amount and payout only, never who claimed.</>}>
      {err && <p className="small warn-text"><Icon name="alert" size={12} /> {err}</p>}
      {!r && !err && <p className="muted"><Spinner /> Reading Arkiv…</p>}
      {r && !r.items.length && <p className="muted">No claims on this run.</p>}
      {r?.items.map((c: any) => (
        <div key={c.entityKey} className="claim">
          <div className="row">
            <ClaimBadge status={c.status} />
            <Amount wei={c.amountWei} paid={c.status === "PAID"} />
            <span className="muted small" title={og(c.amountWei)}>severity {c.severity} · updated {when(c.ts)}</span>
          </div>
          <div className="row">
            <Chip label="Arkiv record" value={c.entityKey} href={`${ARKIV_EXPLORER}/entity/${c.entityKey}`} />
            {c.payoutTx && <Chip label="Payout" value={c.payoutTx} href={cfg.explorer ? `${cfg.explorer}/tx/${c.payoutTx}` : null} tone="ok" />}
          </div>
        </div>
      ))}
      {r?.query && (
        <details className="disclosure">
          <summary>Arkiv query</summary>
          <pre className="code">{r.query}</pre>
          <p className="muted small">Owner (the desk wallet): <code className="mono">{short(r.writer)}</code></p>
        </details>
      )}
    </Card>
  );
}
