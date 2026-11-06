// Verify (public): anyone checks a run is untouched. No sign-in; the contents stay locked.
import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { go } from "../router";
import { IndexBadge, PublicResult, RunHeader, RunList, tamperPublic, useRuns } from "../components/run";
import { Callout, Card, Empty, Icon, Spinner, Verdict, verdictOf } from "../components/ui";

/** The stored fingerprint and the edited copy's, with every differing character marked. */
function FingerprintDiff({ a, b }: { a: string; b: string }) {
  const changed = [...b].filter((ch, i) => ch !== a[i]).length;
  return (
    <div className="fpdiff" aria-label="Fingerprints compared">
      <div><span className="fpdiff-label">Locked file's fingerprint, as recorded on 0G Chain</span><code className="mono">{a}</code></div>
      <div>
        <span className="fpdiff-label">Fingerprint of the edited copy · {changed} of {b.length - 2} characters differ</span>
        <code className="mono dim">{[...b].map((ch, i) => (ch === a[i] ? ch : <mark key={i}>{ch}</mark>))}</code>
        <span className="badge tone-bad nomatch">✕ Does not match 0G Chain</span>
      </div>
    </div>
  );
}

export function Verify({ tick, runId }: { tick: number; runId?: string }) {
  const [input, setInput] = useState(runId ?? "");
  const [v, setV] = useState<any>(null);
  const [edited, setEdited] = useState<any>(null);
  const [busy, setBusy] = useState<"" | "check" | "edit">("");
  const [err, setErr] = useState("");
  const runs = useRuns(tick);
  const editedRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // on narrow screens the result sits below the list: bring it into view when a run is picked
  useEffect(() => {
    if (runId && matchMedia("(max-width: 1080px)").matches) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [runId]);
  useEffect(() => {
    if (edited) editedRef.current?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [edited]);

  useEffect(() => {
    setInput(runId ?? "");
    setV(null);
    setEdited(null);
    setErr("");
    if (!runId) return;
    setBusy("check");
    get(`/api/verify/${encodeURIComponent(runId)}`).then(setV).catch((e) => setErr(e.message)).finally(() => setBusy(""));
  }, [runId, tick]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = input.trim();
    if (!/^ep_[A-Za-z0-9_-]+$/.test(id)) {
      setErr("A run id looks like ep_20261106061500_ab12.");
      return;
    }
    go("verify", id);
  };
  const edit = () => {
    if (!runId) return;
    setBusy("edit");
    tamperPublic(runId).then(setEdited).catch((e) => setErr(e.message)).finally(() => setBusy(""));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Verify · public</div>
          <h1>Is this run untouched?</h1>
          <p className="muted">Checks a run against what the robot signed and recorded on 0G Chain and 0G Storage. Needs no sign-in. The run's contents stay locked: only its owner, and the insurer for a claimed incident, can read them.</p>
        </div>
      </div>
      <form className="search" onSubmit={submit} role="search">
        <label htmlFor="run-id" className="sr-only">Run id</label>
        <input id="run-id" className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste a run id, e.g. ep_20261106061500_ab12" spellCheck={false} autoComplete="off" />
        <button type="submit" className="btn primary">Check</button>
      </form>
      {err && <Callout tone="bad">{err}</Callout>}
      <div className="split">
        <Card title="Recent runs" actions={<IndexBadge runs={runs} />}>
          <RunList items={runs.items} selected={runId} onSelect={(id) => go("verify", id)} source={runs.source} />
        </Card>
        <div className="stack" ref={resultRef}>
          {!runId && <Card><Empty title="Pick or paste a run">The result shows here, with every fingerprint you can follow on 0G Chain yourself.</Empty></Card>}
          {runId && (
            <Card>
              <RunHeader id={runId} sealed={v?.sealed} />
              {busy === "check" && <p className="muted"><Spinner /> Checking 0G Chain and 0G Storage…</p>}
              {v && <PublicResult v={v} />}
              {v && (
                <div className="row">
                  <span className="muted small"><Icon name="lock" size={12} /> Contents stay locked: this check reads fingerprints only.</span>
                  {v.sealed && (edited
                    ? <button type="button" className="btn push" onClick={() => setEdited(null)}>Reset the demo</button>
                    : <button type="button" className="btn push" onClick={edit} disabled={!!busy}>{busy === "edit" ? <Spinner /> : null} Edit 1 byte of a copy</button>)}
                </div>
              )}
            </Card>
          )}
          {edited && v && (
            <div ref={editedRef}>
              <Card title="What if someone edits it?" sub={`We changed ${edited.tampered} in a copy of the locked file and checked it again.`}>
                <div className="two-up">
                  <Verdict kind={verdictOf(v)} compact title="Original" label="Same as the result above." />
                  <Verdict kind={verdictOf(edited)} compact title="Edited copy" label="Its fingerprint changed completely, so it no longer matches 0G Chain." />
                </div>
                {v.rootHash && edited.editedRoot && <FingerprintDiff a={v.rootHash} b={edited.editedRoot} />}
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
