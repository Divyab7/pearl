// Verify (public, #/verify/<id>): the page a shared proof link opens. "A sealed robot record shared with you", the
// verdict, what it proves (0G Chain · 0G Storage · the robot's signature · Arkiv), the one-byte tamper demo and the
// claims on this run from Arkiv. No account needed; the contents stay locked. Reached only from "Share proof link"
// (every run and claim) and the landing's "Try altering a record"; with no id it opens the newest verified run.
// Plain words up front; fingerprints, contracts and the five technical checks live in <TechDetails>.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { get, useConfig } from "../api";
import { go, to } from "../router";
import { tamperPublic, useRuns, fullWhen, shortWhen, dayOf } from "../components/run";
import { EmptyState, ErrorState, PlainError, RunRow, Section, Skeleton, StatusPill, TechDetails, InfoTip } from "../components/blocks";
import { Amount, Chip, Icon, Spinner, Verdict, verdictOf, type Tone, type VerdictKind } from "../components/ui";
import { ShareProofButton } from "../components/blocks";
import { ARKIV_EXPLORER } from "../components/claims";
import { CLAIM_STATE, OUTCOME_TONE, TIP, isTechy, outcomeWord } from "../lib/words";
import "./proof.css";

const ID_RE = /^ep_[A-Za-z0-9_-]+$/;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

type Check = { id: number; name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: string; tech?: string; missing?: boolean };

/**
 * The checks as the page reads them. A run with no record on 0G Chain at all is "missing" (we can't prove it), not
 * evidence of an edit: only a real mismatch says Altered.
 */
function normalise(v: any): { checks: Check[]; kind: VerdictKind; notFound: boolean } {
  const checks: Check[] = v.checks.map((c: Check) => (c.id === 1 && c.status === "FAIL" && !v.anchor ? { ...c, missing: true } : c));
  const notFound = !v.anchor && !v.sealed;
  return { checks, kind: verdictOf({ result: v.result, checks }), notFound };
}

/** The three plain checks (summary-match and remote-receipt join them only when they fail). */
const PLAIN: Record<number, { title: string; pass: string; missing: string; fail: string; tip?: string }> = {
  1: {
    title: "Recorded on 0G Chain",
    pass: "Its fingerprint was written to a public ledger when the run ended.",
    missing: "We found no record of this run on the public ledger yet.",
    fail: "The public record doesn't match this run.",
    tip: TIP.ogChain,
  },
  2: {
    title: "Stored copy matches",
    pass: "The locked file on 0G Storage is exactly the one that was recorded.",
    missing: "The stored copy isn't available, so it can't be compared.",
    fail: "The stored copy is different from what was recorded.",
    tip: TIP.ogStorage,
  },
  4: {
    title: "Signed by the robot",
    pass: "Only this robot's own key could have signed it.",
    missing: "There's no locked file to read the signature from.",
    fail: "The signature doesn't belong to this robot.",
    tip: TIP.signed,
  },
  3: { title: "Summary matches", pass: "", missing: "", fail: "The run's summary differs from the public record." },
  5: { title: "Remote command receipt", pass: "", missing: "", fail: "The remote start command doesn't match its receipt." },
};

function PlainChecks({ checks, arkiv }: { checks: Check[]; arkiv: boolean | null }) {
  const shown = checks.filter((c) => c.id === 1 || c.id === 2 || c.id === 4 || (c.status === "FAIL" && !c.missing));
  return (
    <ul className="pf-checks" aria-label="What this proves">
      {shown.map((c) => {
        const p = PLAIN[c.id]!;
        const st = c.status === "PASS" ? "ok" : c.status === "SKIPPED" ? "skip" : c.missing ? "warn" : "bad";
        const line = st === "ok" ? p.pass : st === "warn" ? p.missing : st === "bad" ? p.fail : "Not needed for this run.";
        const word = st === "ok" ? "Yes" : st === "warn" ? "Not available" : st === "bad" ? "No match" : "Not needed";
        return (
          <li key={c.id} className={`pf-check st-${st}`}>
            <span className="pf-check-mark" aria-hidden><Icon name={st === "ok" ? "check" : st === "bad" ? "x" : st === "warn" ? "alert" : "minus"} size={14} /></span>
            <span className="pf-check-text">
              <b>{p.title}{p.tip && <InfoTip text={p.tip} />}</b>
              <span>{line}</span>
            </span>
            <span className="sr-only">: {word}</span>
          </li>
        );
      })}
      {arkiv !== null && (
        <li className={`pf-check st-${arkiv ? "ok" : "skip"}`}>
          <span className="pf-check-mark" aria-hidden><Icon name={arkiv ? "check" : "minus"} size={14} /></span>
          <span className="pf-check-text">
            <b>Listed on Arkiv<InfoTip text={TIP.arkiv} /></b>
            <span>{arkiv ? "The robot wrote its own public, searchable entry for this run. Anyone can query it." : "Not in the Arkiv list right now (entries expire after 30 days). The proof on 0G is permanent."}</span>
          </span>
          <span className="sr-only">: {arkiv ? "Yes" : "Not listed"}</span>
        </li>
      )}
    </ul>
  );
}

/** The five checks with their technical names (inside Technical details only). */
function TechChecks({ checks }: { checks: Check[] }) {
  const word = (c: Check) => (c.status === "PASS" ? "Pass" : c.status === "SKIPPED" ? "Not used" : c.missing ? "Not available" : "Fail");
  return (
    <ol className="checks pf-techchecks">
      {checks.map((c) => (
        <li key={c.id} className={`check ${c.status === "FAIL" && c.missing ? "s-MISSING" : `s-${c.status}`}`}>
          <span className="check-mark" aria-hidden><Icon name={c.status === "PASS" ? "check" : c.status === "SKIPPED" ? "minus" : c.missing ? "alert" : "x"} size={14} /></span>
          <div>
            <div className="check-name">{c.id}. {c.name}{c.tech && <span className="check-tech">{c.tech}</span>}</div>
            <div className="check-detail">{c.detail.charAt(0).toUpperCase() + c.detail.slice(1)}</div>
          </div>
          <span className="check-status">{word(c)}</span>
        </li>
      ))}
    </ol>
  );
}

/** One plain sentence under the big word. */
function verdictLine(kind: VerdictKind, notFound: boolean, checks: Check[], v: any, arkiv: boolean | null) {
  if (notFound) return "We found no record of this run. Check the link is complete; a run that just finished can take a minute to appear.";
  const robot = v.source === "robot" ? " (The stored copy was read from the robot itself.)" : "";
  if (kind === "ok") return `Recorded on 0G Chain, stored on 0G Storage, signed by the robot${arkiv ? " and listed on Arkiv" : ""}. Nobody has altered it.${robot}`;
  if (kind === "incomplete") {
    const gone = checks.filter((c) => c.status === "FAIL").map((c) => PLAIN[c.id]?.title.toLowerCase() ?? c.name);
    return `Part of the proof is missing (${gone.join(", ")}), so we can't confirm it yet. Nothing shows it was changed.`;
  }
  return "This doesn't match what the robot signed and recorded. Someone changed it after the fact.";
}

/** The fingerprint the chain holds vs the edited copy's: the differing characters reveal and light up in turn. */
function FingerprintDiff({ a, b }: { a: string; b: string }) {
  const body = (s: string) => s.replace(/^0x/, "");
  const A = body(a);
  const B = body(b);
  const changed = [...B].filter((ch, i) => ch !== A[i]).length;
  return (
    <figure className="pf-diff" aria-label={`Fingerprints compared: ${changed} of ${B.length} characters differ`}>
      <div className="pf-diff-row">
        <span className="pf-diff-label"><Icon name="shield" size={13} /> Recorded on 0G Chain</span>
        <code className="mono" aria-hidden>{A}</code>
      </div>
      <div className="pf-diff-row edited">
        <span className="pf-diff-label"><Icon name="x" size={13} /> Edited copy</span>
        <code className="mono" aria-hidden>
          {[...B].map((ch, i) => (ch === A[i] ? <span key={i}>{ch}</span> : <mark key={i} style={{ ["--i" as any]: i }}>{ch}</mark>))}
        </code>
      </div>
      <figcaption>
        <b className="pf-diff-count">{changed} of {B.length}</b> characters changed from a single byte. It no longer matches 0G Chain, so the edit is caught.
      </figcaption>
    </figure>
  );
}

/** The hero demo: copy the locked file, change one byte, check the copy the same way. */
function TryIt({ runId, v, kind, autoStart = false }: { runId: string; v: any; kind: VerdictKind; autoStart?: boolean }) {
  const [edited, setEdited] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const result = useRef<HTMLHeadingElement>(null);
  const hid = useId();
  useEffect(() => {
    setEdited(null);
    setErr("");
  }, [runId]);
  useEffect(() => {
    if (!edited) return;
    result.current?.focus({ preventScroll: true });
    result.current?.closest(".pf-try")?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" });
  }, [edited]);
  const run = () => {
    setBusy(true);
    setErr("");
    setEdited(null);
    tamperPublic(runId).then(setEdited).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  const can = !!v.sealed;
  // #/proof/<id>/tamper (Home's "Try tampering"): run the one-byte demo once, then drop the flag so Back/refresh is calm
  const autoRan = useRef("");
  useEffect(() => {
    if (!autoStart || !can || autoRan.current === runId) return;
    autoRan.current = runId;
    history.replaceState(null, "", to.verify(runId));
    run();
  }, [autoStart, can, runId]);
  const editedKind = edited ? normalise(edited).kind : null;
  return (
    <section className={`pf-try ${edited ? "done" : ""}`} aria-labelledby={hid}>
      <div className="pf-try-head">
        <span className="eyebrow">Try it yourself</span>
        <h2 id={hid} className="sect-title">What if someone changes it?</h2>
        <p className="sect-desc">We copy this run's locked file, change a single byte, then check the copy against 0G Chain the same way.</p>
      </div>
      <div className="pf-try-pair">
        <Verdict kind={kind} compact title="Original" label={kind === "ok" ? "Matches 0G Chain." : "Same as the result."} />
        <span className="pf-try-vs" aria-hidden><Icon name="arrow" size={16} /></span>
        {edited
          ? <div className="pf-try-edited"><Verdict kind={editedKind} compact title="Edited copy" label="1 byte changed. Caught." /></div>
          : busy
            ? <Verdict kind={null} pending compact title="Edited copy" />
            : <div className="verdict compact pf-try-ghost"><span className="verdict-icon" aria-hidden><Icon name="doc" size={18} /></span><div><div className="verdict-title">Edited copy</div><div className="verdict-word">?</div><div className="verdict-sub">Not checked yet.</div></div></div>}
      </div>
      {edited && (
        <div className="stack">
          <h3 className="sr-only" tabIndex={-1} ref={result}>Result: the edited copy is {editedKind === "bad" ? "altered" : "not verified"}. We changed {edited.tampered}.</h3>
          {v.rootHash && edited.editedRoot && <FingerprintDiff a={v.rootHash} b={edited.editedRoot} />}
        </div>
      )}
      {err && <PlainError raw={err} fallback="Couldn't make the edited copy right now. Try again." onRetry={run} />}
      <div className="row">
        {!edited
          ? <button type="button" className="btn primary lg" onClick={run} disabled={!can || busy}>{busy ? <><Spinner label="Changing and checking" /> Checking the copy…</> : <>Change one byte <Icon name="arrow" /></>}</button>
          : <button type="button" className="btn" onClick={() => setEdited(null)}>Reset the demo</button>}
        {!can && <span className="muted small">Needs a run whose locked file can be read.</span>}
        {can && !edited && <span className="muted small">Only a copy changes. The real record stays exactly as it is.</span>}
      </div>
    </section>
  );
}

/** Claims on this run, read from the insurer desk's public records on Arkiv. Status and amount only. */
function ClaimsHere({ runId, tick }: { runId: string; tick: number }) {
  const cfg = useConfig();
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setR(null);
    setErr("");
    get(`/api/arkiv/claims?episodeId=${encodeURIComponent(runId)}`).then((x) => live && setR(x)).catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [runId, tick]);
  if (r && !r.configured) return null;
  return (
    <Section title="Claims on this run" description="A live Arkiv query of the insurer desk's claim records." info={TIP.arkivClaims} className="pf-claims">
      {err && <p className="muted small"><Icon name="alert" size={12} /> Couldn't read the claims right now.</p>}
      {!r && !err && <Skeleton lines={1} label="Reading claims" />}
      {r && !r.items.length && <p className="muted">No insurance claims on this run.</p>}
      {r?.items.length > 0 && (
        <ul className="pf-claimlist">
          {r.items.map((c: any) => {
            const s = CLAIM_STATE[c.status] ?? { word: c.status, tone: "neutral" as Tone };
            return (
              <li key={c.entityKey}>
                <StatusPill tone={s.tone} size="sm">{s.word}</StatusPill>
                <Amount wei={c.amountWei} paid={c.status === "PAID"} />
                <span className="muted small">updated {shortWhen(c.ts)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {r?.items.length > 0 && (
        <TechDetails boxless>
          <div className="chips">
            {r.items.map((c: any) => (
              <div key={c.entityKey} className="stack-tight">
                <Chip label="Arkiv record" value={c.entityKey} href={`${ARKIV_EXPLORER}/entity/${c.entityKey}`} />
                {c.payoutTx && <Chip label="Payout" value={c.payoutTx} href={cfg.explorer ? `${cfg.explorer}/tx/${c.payoutTx}` : null} tone="ok" />}
              </div>
            ))}
          </div>
          {r.query && <pre className="code">{r.query}</pre>}
        </TechDetails>
      )}
    </Section>
  );
}

/** Recent runs from Arkiv (or the robot), as plain rows. */
function RecentRuns({ runs, selected, onPick, limit }: { runs: any; selected?: string; onPick?: () => void; limit?: number }) {
  if (runs.err && !runs.items.length) return <p className="muted small"><Icon name="alert" size={12} /> Couldn't load recent runs. You can still paste a run id.</p>;
  if (!runs.source && !runs.items.length) return <Skeleton lines={3} label="Loading recent runs" />;
  if (!runs.items.length) return <p className="muted">No runs yet. They appear here when a robot finishes a task.</p>;
  const items = limit ? runs.items.slice(0, limit) : runs.items;
  return (
    <ul className="rrows pf-recent" onClick={onPick}>
      {items.map((e: any) => (
        <li key={e.episodeId}>
          <RunRow
            href={to.verify(e.episodeId)}
            selected={selected === e.episodeId}
            time={e.ts ? shortWhen(e.ts) : "—"}
            outcome={outcomeWord(e.outcome, e.kind === "incident")}
            tone={OUTCOME_TONE[e.outcome] ?? "neutral"}
            note={e.ts ? dayOf(e.ts) : undefined}
            claimable={e.kind === "incident"}
            title={`Check this run`}
          />
        </li>
      ))}
    </ul>
  );
}

function SearchBar({ runId, runs }: { runId?: string; runs: any }) {
  const [input, setInput] = useState(runId ?? "");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const errId = useId();
  const popId = useId();
  useEffect(() => {
    setInput(runId ?? "");
    setErr("");
    setOpen(false);
  }, [runId]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    wrap.current?.querySelector<HTMLElement>(".pf-pop .rrow")?.focus();
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const raw = input.trim();
    const id = raw.match(/ep_[A-Za-z0-9_-]+/)?.[0] ?? raw; // a pasted link to #/proof/<id> works too
    if (!raw) return setErr("Paste a run id, or pick a recent run.");
    if (!ID_RE.test(id)) return setErr("That doesn't look like a run id. A run id looks like ep_20261106061500_ab12.");
    setErr("");
    go("verify", id);
  };
  return (
    <div className="pf-search" ref={wrap}>
      <form onSubmit={submit} role="search" aria-label="Check a run" noValidate>
        <div className="pf-search-row">
          <label htmlFor="pf-run-id" className="sr-only">Run id</label>
          <div className="pf-input">
            <Icon name="search" />
            <input id="pf-run-id" className="mono" value={input} onChange={(e) => { setInput(e.target.value); if (err) setErr(""); }}
              placeholder="Paste a run id, or pick a recent one" spellCheck={false} autoComplete="off"
              aria-invalid={!!err} aria-describedby={err ? errId : undefined} />
            <button ref={toggle} type="button" className="btn ghost pf-recent-btn" aria-expanded={open} aria-controls={popId} onClick={() => setOpen((o) => !o)}>
              Recent<Icon name="down" size={14} />
            </button>
          </div>
          <button type="submit" className="btn primary">Check</button>
        </div>
        {err && <p className="pf-field-err" id={errId} role="alert"><Icon name="alert" size={13} /> {err}</p>}
      </form>
      {open && (
        <div className="pf-pop" id={popId} role="region" aria-label="Recent runs">
          <div className="pf-pop-head"><span className="h4">Recent runs</span>{runs.source === "arkiv" && <span className="muted small">from Arkiv</span>}</div>
          <RecentRuns runs={runs} selected={runId} onPick={() => setOpen(false)} limit={8} />
        </div>
      )}
    </div>
  );
}

export function Proof({ tick, runId, tamper = false }: { tick: number; runId?: string; tamper?: boolean }) {
  const runs = useRuns(tick);
  const cfg = useConfig();
  const [v, setV] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [again, setAgain] = useState(0);
  const lastId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!runId) {
      setV(null);
      setErr("");
      return;
    }
    let live = true;
    // a new run clears the result; a refresh of the same run keeps showing the old one until the new one lands
    if (lastId.current !== runId) setV(null);
    lastId.current = runId;
    setErr("");
    setLoading(true);
    get(`/api/verify/${encodeURIComponent(runId)}`)
      .then((x) => live && setV(x))
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [runId, tick, again]);

  const n = v ? normalise(v) : null;
  const listed = runId ? runs.items.find((e: any) => e.episodeId === runId) : null;
  const recorded = v?.anchor ? new Date(v.anchor.anchoredAt * 1000) : null;
  const addr = (a?: string | null) => (a && cfg.explorer ? `${cfg.explorer}/address/${a}` : null);

  // no id: open the newest VERIFIED run, so the first view shows what success looks like
  const [auto, setAuto] = useState<"finding" | "none" | null>(null);
  useEffect(() => {
    if (runId) return setAuto(null);
    if (!runs.items.length) {
      if (runs.source || runs.err) setAuto("none");
      return;
    }
    let live = true;
    setAuto("finding");
    (async () => {
      for (const e of runs.items.slice(0, 8)) {
        try {
          const x = await get(`/api/verify/${encodeURIComponent(e.episodeId)}`);
          if (verdictOf(x) === "ok") {
            if (live) location.replace(to.verify(e.episodeId));
            return;
          }
        } catch { /* try the next one */ }
      }
      if (live) setAuto("none");
    })();
    return () => {
      live = false;
    };
  }, [runId, runs.items.length, !!runs.source]);
  // shown only when this run is in the Arkiv list we read (the list is the recent runs, so absence proves nothing)
  const arkiv: boolean | null = runs.source === "arkiv" && listed ? true : null;

  return (
    <div className="page proof">
      <header className="pagehead pf-head">
        <div className="pagehead-text">
          <div className="eyebrow">Shared proof · no account needed</div>
          <h1 className="pagehead-title">{runId ? "A sealed robot record shared with you" : "Check a sealed robot record"}</h1>
          <p className="pagehead-desc">An AI on 0G ran the robot and this run was sealed on it, then recorded on 0G and listed on Arkiv. Here anyone can check it hasn't been altered. Its contents stay locked.</p>
        </div>
        {runId && v?.sealed && <div className="pagehead-actions"><ShareProofButton episodeId={runId} /></div>}
      </header>

      {!runId && auto !== "none" && (
        <div className="pf-grid" role="status" aria-label="Finding the newest verified run">
          <div className="pf-card"><Verdict kind={null} pending /><Skeleton lines={3} /></div>
          <div className="pf-card"><Skeleton lines={4} /></div>
        </div>
      )}

      {!runId && auto === "none" && (
        <div className="pf-grid">
          <Section title="Pick a recent run" description="Or paste a run id below." actions={runs.source === "arkiv" ? <span className="muted small">Listed on Arkiv<InfoTip text={TIP.arkiv} /></span> : undefined} boxed>
            <RecentRuns runs={runs} limit={6} />
          </Section>
          <div className="pf-side">
            <EmptyState title="The answer shows here" icon="shield">
              One clear word: <b>Verified</b>, <b>Not verified</b> or <b>Altered</b>. Then change a single byte and watch the check catch it.
            </EmptyState>
          </div>
        </div>
      )}

      {runId && err && !v && (
        <ErrorState title="Couldn't check this run" onRetry={() => setAgain((a) => a + 1)}>
          {/not found|404/i.test(err) ? "We couldn't find this run. Check the run ID; a run that just finished can take a minute to appear." : "The check service didn't answer. The record itself is unaffected."}
          {isTechy(err) && <TechDetails boxless><code className="mono small">{err}</code></TechDetails>}
        </ErrorState>
      )}

      {runId && !err && !v && (
        <div className="pf-grid">
          <div className="pf-card"><Verdict kind={null} pending /><Skeleton lines={3} /></div>
          <div className="pf-card"><Skeleton lines={4} /></div>
        </div>
      )}

      {runId && v && n && (
        <div className="pf-grid">
          <section className="pf-card pf-result" aria-label="Result">
            <Verdict kind={n.kind} word={n.kind === "ok" ? "Verified ✓ · not altered" : undefined} label={verdictLine(n.kind, n.notFound, n.checks, v, arkiv)} />
            {v.sealed && (
              <p className="pf-runline">
                <span>Run finished <time dateTime={v.sealed.endedAt}>{fullWhen(v.sealed.endedAt)}</time></span>
                <span aria-hidden>·</span>
                <span className={`dotlabel tone-${OUTCOME_TONE[v.sealed.outcome] ?? "neutral"}`}><i aria-hidden />{outcomeWord(v.sealed.outcome, v.sealed.incident)}</span>
                {loading && <Spinner label="Re-checking" />}
              </p>
            )}
            {!n.notFound && <PlainChecks checks={n.checks} arkiv={arkiv} />}
            <div className="pf-result-foot">
              <span className="muted small"><Icon name="lock" size={12} /> Contents stay locked: this check reads fingerprints only.</span>
              <span className="muted small"><Icon name="spark" size={12} /> The AI that ran it: a TEE-verified model on 0G Compute<InfoTip text={TIP.ogCompute} /></span>
              {v.sealed && <a className="pf-story" href={to.run(runId)}>Your robot? Open the full run story <Icon name="arrow" size={14} /></a>}
            </div>
            <TechDetails>
              <div className="stack">
                <div className="chips">
                  <Chip label="Run id" value={runId} display={runId} />
                  <Chip label="Robot" value={v.device} href={addr(v.device)} />
                  <Chip label="Run fingerprint" value={v.sealed?.headHash ?? v.anchor?.headHash ?? null} />
                  <Chip label="0G Storage file" value={v.rootHash} href={v.rootHash && cfg.storageIndexer ? `${cfg.storageIndexer}/file?root=${v.rootHash}` : null} />
                  <Chip label="Record contract" value={v.anchor?.address ?? null} href={addr(v.anchor?.address)} />
                  {listed?.anchorTx && <Chip label="Recording tx" value={listed.anchorTx} href={cfg.explorer ? `${cfg.explorer}/tx/${listed.anchorTx}` : null} />}
                </div>
                <p className="muted small">
                  {recorded ? <>Recorded on 0G Chain <time dateTime={recorded.toISOString()} title={recorded.toISOString()}>{fullWhen(recorded.getTime())}</time></> : "Not recorded on 0G Chain."}
                  {v.source && <> · stored copy read from {v.source === "robot" ? "the robot" : "0G Storage"}</>}
                </p>
                <h4 className="h4">The 5 public checks</h4>
                <TechChecks checks={n.checks} />
              </div>
            </TechDetails>
          </section>
          <div className="pf-side">
            {v.sealed ? <TryIt runId={runId} v={v} kind={n.kind} autoStart={tamper} /> : (
              <section className="pf-try">
                <span className="eyebrow">Try it</span>
                <p className="muted">The one-byte demo needs a run whose locked file can be read. Pick another run below to try it.</p>
              </section>
            )}
            {!n.notFound && <ClaimsHere runId={runId} tick={tick} />}
          </div>
        </div>
      )}

      {(runId || auto === "none") && (
        <section className="pf-another" aria-labelledby="pf-another-h">
          <h2 id="pf-another-h" className="sect-title">Check another run</h2>
          <SearchBar runId={runId} runs={runs} />
        </section>
      )}
    </div>
  );
}
