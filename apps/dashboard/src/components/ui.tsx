// Shared primitives: one look for every page (tokens in styles.css). Page-level building blocks (PageHeader, Section,
// StatusPill, StepStrip, RoleCard, RunRow, TechDetails, InfoTip, EmptyState, ErrorState, Skeleton, Stat) live in
// ./blocks.tsx. Words come from ../lib/words.ts.
import { useState, type ReactNode } from "react";
import { VERDICT_WORDS } from "../lib/words";

const PATHS: Record<string, string> = {
  check: "M3.5 8.5l3 3 6-7",
  x: "M4 4l8 8M12 4l-8 8",
  minus: "M4 8h8",
  lock: "M5 7V5a3 3 0 0 1 6 0v2M4 7h8v6H4z",
  unlock: "M5 7V5a3 3 0 0 1 5.8-1M4 7h8v6H4z",
  copy: "M5 5h7v8H5zM3 3h7v1M3 3v8h1",
  ext: "M9 3h4v4M13 3L7 9M11 9v4H3V5h4",
  key: "M10.5 2.5a3 3 0 1 1-2.6 4.5L2.5 12.4V14H5v-1.5h1.5V11H8l1-1M11.5 4.5h.01",
  shield: "M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z",
  alert: "M8 2l6.5 11h-13zM8 6v3.5M8 11.5v.5",
  info: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7v4M8 5v.5",
  arrow: "M3 8h10M9 4l4 4-4 4",
  download: "M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10",
  upload: "M8 10V2M4.5 5.5L8 2l3.5 3.5M3 13h10",
  wallet: "M2 4h11v9H2zM10 8h3M2 4l8-2v2",
  robot: "M5 5h6v6H5zM8 2v3M3 8h2M11 8h2M6.5 7.5v1M9.5 7.5v1",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  sun: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  db: "M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  chevron: "M6 4l4 4-4 4",
  down: "M4 6l4 4 4-4",
  user: "M8 8a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 0 0 8 8zM2.5 14c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4",
  offline: "M2 6.5a9 9 0 0 1 12 0M4.3 9a5.5 5.5 0 0 1 7.4 0M6.6 11.4a2 2 0 0 1 2.8 0M8 13.5h.01M2.5 2.5l11 11",
  signal: "M2 6.5a9 9 0 0 1 12 0M4.3 9a5.5 5.5 0 0 1 7.4 0M6.6 11.4a2 2 0 0 1 2.8 0M8 13.5h.01",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6L14 14",
  spark: "M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2",
  logout: "M6 3H3v10h3M10 5l3 3-3 3M13 8H6",
  doc: "M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4",
};

export function Icon({ name, size = 16, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="icon" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      <path d={PATHS[name] ?? PATHS.info} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge tone-${tone}`} title={title}>{children}</span>;
}

/** Money: the figure and its unit set apart, so "0.020 0G" never reads as one number. */
export function Amount({ wei, paid = false }: { wei?: string | number | bigint | null; paid?: boolean }) {
  if (wei === null || wei === undefined) return <span className="amount">—</span>;
  const v = Number(BigInt(wei)) / 1e18;
  return (
    <span className={`amount ${paid ? "paid" : ""}`}>
      <span className="amount-num">{v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 })}</span>
      <span className="amount-unit" title="0G testnet tokens">test 0G</span>
    </span>
  );
}

/** A neutral label with a small coloured dot: status without shouting. */
export function DotLabel({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`dotlabel tone-${tone}`} title={title}><i aria-hidden />{children}</span>;
}

export function Card({ title, sub, actions, children, className = "", id }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={id && title ? `${id}-title` : undefined}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 id={id ? `${id}-title` : undefined}>{title}</h2>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Callout({ tone = "info", title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: string }) {
  const ic = icon ?? (tone === "bad" || tone === "warn" ? "alert" : tone === "ok" ? "check" : "info");
  return (
    <div className={`callout tone-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon name={ic} />
      <div>
        {title && <b>{title}</b>}
        {children && <div className="callout-body">{children}</div>}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <div className="empty-body">{children}</div>}
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost icon-only"
      aria-label={done ? "Copied" : `${label}: ${value}`}
      title={done ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}

/** 0x1234…abcd: the same 6+4 shape for every hash and address. */
export const hashShort = (v: string) => (v.length > 14 ? `${v.slice(0, v.startsWith("0x") ? 6 : 6)}…${v.slice(-4)}` : v);

/** A fingerprint with copy and an optional explorer link. `display` shows a friendlier form of the value. */
export function Chip({ label, value, href, display, tone }: { label: string; value?: string | null; href?: string | null; display?: string; n?: number; tone?: Tone }) {
  return (
    <div className={`chip ${tone ? `tone-${tone}` : ""}`}>
      <span className="chip-label">{label}</span>
      {value ? (
        <>
          <code className="mono" title={value}>{display ?? hashShort(value)}</code>
          <CopyButton value={value} label={`Copy ${label}`} />
          {href && (
            <a className="btn ghost icon-only" href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label} in explorer`} title="Open in explorer">
              <Icon name="ext" size={14} />
            </a>
          )}
        </>
      ) : (
        <span className="chip-missing"><Icon name="alert" size={12} /> not recorded</span>
      )}
    </div>
  );
}

export type VerdictKind = "ok" | "incomplete" | "bad";
const VERDICT: Record<VerdictKind, { word: string; explain: string; tone: Tone; icon: string }> = {
  ok: { ...VERDICT_WORDS.ok, tone: "ok", icon: "shield" },
  incomplete: { ...VERDICT_WORDS.incomplete, tone: "warn", icon: "alert" },
  bad: { ...VERDICT_WORDS.bad, tone: "bad", icon: "x" },
};

/** VALID → untouched; REJECTED only because something is missing → not verified; any real mismatch → tampered. */
export function verdictOf(v: { result: "VALID" | "REJECTED"; checks: { status: string; missing?: boolean }[] }): VerdictKind {
  if (v.result === "VALID") return "ok";
  const fails = v.checks.filter((c) => c.status === "FAIL");
  return fails.length && fails.every((c) => c.missing) ? "incomplete" : "bad";
}

/**
 * Verdict: the big, plain answer to "has this been changed?". Words come from lib/words.ts VERDICT_WORDS:
 * ok → "Untouched", incomplete → "Not verified", bad → "Tampered", each with a default one-line explanation.
 * Props: kind (null renders nothing; pass `pending` to show a "Checking…" placeholder instead), label (replaces the
 * default explanation), title (small caption above the word, e.g. "Edited copy"), compact (smaller, for side-by-side).
 */
export function Verdict({ kind, label, title, compact = false, pending = false }: { kind: VerdictKind | null; label?: ReactNode; title?: string; compact?: boolean; pending?: boolean }) {
  if (!kind) {
    if (!pending) return null;
    return (
      <div className={`verdict pending ${compact ? "compact" : ""}`} role="status" aria-busy="true">
        <span className="verdict-icon"><Spinner label="Checking" /></span>
        <div>
          {title && <div className="verdict-title">{title}</div>}
          <div className="verdict-word">Checking…</div>
          <div className="verdict-sub">Recomputing the fingerprint and comparing it with 0G Chain.</div>
        </div>
      </div>
    );
  }
  const d = VERDICT[kind];
  return (
    <div className={`verdict tone-${d.tone} ${compact ? "compact" : ""}`} role="status">
      <span className="verdict-icon" aria-hidden><Icon name={d.icon} size={compact ? 18 : 28} /></span>
      <div>
        {title && <div className="verdict-title">{title}</div>}
        <div className="verdict-word">{d.word}</div>
        <div className="verdict-sub">{label ?? d.explain}</div>
      </div>
    </div>
  );
}

type Check = { id: number; name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail: string; tech?: string; missing?: boolean };
const word = (c: Check) => (c.status === "PASS" ? "Pass" : c.status === "SKIPPED" ? "Not used" : c.missing ? "Not available" : "Fail");
const cls = (c: Check) => (c.status === "FAIL" && c.missing ? "s-MISSING" : `s-${c.status}`);
const mark = (c: Check) => (c.status === "PASS" ? "check" : c.status === "SKIPPED" ? "minus" : c.missing ? "alert" : "x");

function Rows({ checks }: { checks: Check[] }) {
  return (
    <ol className="checks">
      {checks.map((c) => (
        <li key={c.id} className={`check ${cls(c)}`}>
          <span className="check-mark" aria-hidden><Icon name={mark(c)} size={14} /></span>
          <div>
            <div className="check-name" title={c.tech ? `Technical name: ${c.tech}` : undefined}>{c.name}</div>
            <div className="check-detail">{c.detail.charAt(0).toUpperCase() + c.detail.slice(1)}</div>
          </div>
          <span className="check-status">{word(c)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The checks; with `collapse`, an all-passing list folds into one line that opens on click. */
export function CheckList({ checks, collapse = false, only, foldLabel }: { checks: Check[]; collapse?: boolean; only?: "failed"; foldLabel?: string }) {
  const shown = only === "failed" ? checks.filter((c) => c.status === "FAIL") : checks;
  const passed = checks.filter((c) => c.status === "PASS").length;
  const ran = checks.filter((c) => c.status !== "SKIPPED").length;
  if (collapse && !checks.some((c) => c.status === "FAIL")) {
    return (
      <details className="disclosure checks-fold">
        <summary>{foldLabel ?? `Show all ${checks.length} checks (${passed} passed${checks.length > ran ? `, ${checks.length - ran} not used` : ""})`}</summary>
        <Rows checks={checks} />
      </details>
    );
  }
  return (
    <>
      <Rows checks={shown} />
      {only === "failed" && checks.length > shown.length && <p className="muted small">{checks.length - shown.length} other checks unchanged.</p>}
    </>
  );
}

export function Tabs({ tabs, active, onChange, label }: { tabs: { id: string; label: ReactNode; count?: number }[]; active: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active === t.id}
          className={`tab ${active === t.id ? "on" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface Step {
  label: string;
  /** "safe": stopped on purpose by a safety rule (amber, not a failure) */
  state: "done" | "active" | "todo" | "failed" | "safe";
  note?: string;
  title?: string;
}

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s.label} className={`step st-${s.state}`} aria-current={s.state === "active" ? "step" : undefined} title={s.title}>
          <span className="step-dot">{s.state === "done" ? <Icon name="check" size={12} /> : s.state === "failed" ? <Icon name="x" size={12} /> : s.state === "safe" ? <Icon name="shield" size={12} /> : i + 1}</span>
          <span className="step-label">{s.label}</span>
          {s.note && <span className="step-note">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

export function Spinner({ label = "Working" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Dl({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="dl">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
