// Page-level building blocks for the four places (Home, Robot, Proof, Insurance) and the side pages. Import from here;
// primitives (Icon, Badge, Card, Callout, Verdict, Chip, Dl, Tabs, Field, Spinner…) stay in ./ui.tsx.
// Rules: one primary action per area · plain words from ../lib/words.ts · hashes and technical names only inside
// <TechDetails> · cards only where grouping matters (prefer <Section>).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type Tone, type VerdictKind } from "./ui";
import { plainError, VERDICT_WORDS } from "../lib/words";

/**
 * PageHeader: the page's title, one plain sentence under it, and actions aligned to the title (right; wraps below
 * on phones). `display` makes the title larger (Home only). `eyebrow` is an optional small caption above.
 */
export function PageHeader({ title, description, actions, eyebrow, display = false, id }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; display?: boolean; id?: string;
}) {
  return (
    <header className={`pagehead ${display ? "display" : ""}`}>
      <div className="pagehead-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="pagehead-title" id={id}>{title}</h1>
        {description && <p className="pagehead-desc">{description}</p>}
      </div>
      {actions && <div className="pagehead-actions">{actions}</div>}
    </header>
  );
}

/**
 * Section: a titled group WITHOUT a box (h2 at --fs-section). Use `boxed` only when the group must stand apart
 * (e.g. a form, a live panel). `info` adds an ⓘ after the title. `actions` sit right of the title.
 */
export function Section({ title, description, actions, info, boxed = false, children, id, className = "" }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; info?: string; boxed?: boolean; children?: ReactNode; id?: string; className?: string;
}) {
  const hid = useId();
  return (
    <section className={`sect ${boxed ? "boxed" : ""} ${className}`} id={id} aria-labelledby={title ? hid : undefined}>
      {(title || actions) && (
        <div className="sect-head">
          <div>
            {title && <h2 className="sect-title" id={hid}>{title}{info && <InfoTip text={info} />}</h2>}
            {description && <p className="sect-desc">{description}</p>}
          </div>
          {actions && <div className="sect-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * StatusPill: a rounded "dot + words" status. tone: ok | warn | bad | info | neutral. `sub` is a dimmer second part
 * (e.g. the robot's name). `pulse` animates the dot (for live). `href` makes it a link. `size="sm"` for rows.
 */
export function StatusPill({ tone = "neutral", children, sub, pulse = false, href, title, size }: {
  tone?: Tone; children: ReactNode; sub?: ReactNode; pulse?: boolean; href?: string; title?: string; size?: "sm";
}) {
  const cls = `spill tone-${tone} ${pulse ? "pulse" : ""} ${size ?? ""}`;
  const inner = <><i aria-hidden />{children}{sub && <span className="spill-sub">· {sub}</span>}</>;
  return href ? <a className={cls} href={href} title={title}>{inner}</a> : <span className={cls} title={title} role="status">{inner}</span>;
}

/**
 * StepStrip: a compact horizontal explainer of 3–5 steps (stacks on phones). Each step: title, optional body and
 * icon. `active` (0-based) highlights a step; `compact` hides the bodies. Feed it HOW_IT_WORKS from lib/words.ts.
 */
export function StepStrip({ steps, active, compact = false, label = "How it works" }: {
  steps: readonly { title: ReactNode; body?: ReactNode; icon?: string; info?: string }[]; active?: number; compact?: boolean; label?: string;
}) {
  return (
    <ol className={`steps ${compact ? "compact" : ""}`} style={{ ["--n" as any]: steps.length }} aria-label={label}>
      {steps.map((s, i) => (
        <li key={i} className={active === i ? "on" : ""} aria-current={active === i ? "step" : undefined}>
          <span className="steps-n">{s.icon ? <Icon name={s.icon} size={14} /> : null}{String(i + 1).padStart(2, "0")}</span>
          <span className="steps-title">{s.title}{s.info && <InfoTip text={s.info} />}</span>
          {s.body && <span className="steps-body">{s.body}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * RoleCard: a big tappable choice ("I own a robot", "I'm an insurer", "Check a record"). Renders a link when `href`
 * is given, else a button with `onClick`. `primary` marks the suggested choice.
 */
export function RoleCard({ icon, title, body, href, onClick, primary = false }: {
  icon: string; title: ReactNode; body?: ReactNode; href?: string; onClick?: () => void; primary?: boolean;
}) {
  const inner = (
    <>
      <span className="rolecard-icon" aria-hidden><Icon name={icon} size={22} /></span>
      <span>
        <span className="rolecard-title">{title}</span>
        {body && <span className="rolecard-body" style={{ display: "block" }}>{body}</span>}
      </span>
      <span className="rolecard-go" aria-hidden><Icon name="arrow" size={18} /></span>
    </>
  );
  const cls = `rolecard ${primary ? "primary" : ""}`;
  return href ? <a className={cls} href={href}>{inner}</a> : <button type="button" className={cls} onClick={onClick}>{inner}</button>;
}

/**
 * RunRow: one run as a sentence: time · outcome in words · verdict · optional "Claimable". Wrap rows in
 * <ul className="rrows"><li>…</li></ul>. Use outcomeWord()/OUTCOME_TONE from lib/words.ts for `outcome`/`tone`.
 * `href` makes it a link (preferred: to.run(id) / to.proof(id)); otherwise `onClick`. `note` is a dim second line.
 */
export function RunRow({ time, outcome, tone = "neutral", verdict, claimable = false, note, href, onClick, selected = false, side, title }: {
  time: ReactNode; outcome: ReactNode; tone?: Tone; verdict?: VerdictKind | null; claimable?: boolean; note?: ReactNode;
  href?: string; onClick?: () => void; selected?: boolean; side?: ReactNode; title?: string;
}) {
  const inner = (
    <>
      <span className="rrow-time tabular">{time}</span>
      <span className="rrow-main">
        <span className={`rrow-outcome tone-${tone}`}><i aria-hidden />{outcome}</span>
        {note && <span className="rrow-note">{note}</span>}
      </span>
      <span className="rrow-side">
        {claimable && <StatusPill tone="warn" size="sm" title="This run had an incident: its owner can claim insurance">Claimable</StatusPill>}
        {verdict && <StatusPill tone={verdict === "ok" ? "ok" : verdict === "bad" ? "bad" : "warn"} size="sm">{VERDICT_WORDS[verdict].word}</StatusPill>}
        {side}
      </span>
    </>
  );
  const cls = `rrow ${selected ? "sel" : ""}`;
  return href
    ? <a className={cls} href={href} aria-current={selected ? "true" : undefined} title={title}>{inner}</a>
    : <button type="button" className={cls} onClick={onClick} aria-current={selected ? "true" : undefined} title={title}>{inner}</button>;
}

/**
 * TechDetails: a closed-by-default "Technical details" disclosure. The ONLY place hashes, addresses, transaction
 * links and technical names (root hash, anchor, episode id…) may appear. Put <Chip>/<Dl> inside. `label` overrides
 * the summary text; `open` starts it open; `boxless` drops the top divider.
 */
export function TechDetails({ children, label = "Technical details", open = false, boxless = false }: { children: ReactNode; label?: ReactNode; open?: boolean; boxless?: boolean }) {
  return (
    <details className={`tech ${boxless ? "boxless" : ""}`} open={open}>
      <summary><Icon name="chevron" size={14} />{label}</summary>
      <div className="tech-body">{children}</div>
    </details>
  );
}

/**
 * InfoTip: an ⓘ button that shows one plain sentence on hover, focus or tap (Esc closes). Keyboard accessible; the
 * text is also the button's accessible description. Texts live in lib/words.ts TIP. `below` flips the bubble down.
 */
export function InfoTip({ text, label = "What is this?", below = false }: { text: string; label?: string; below?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("keydown", close);
    addEventListener("pointerdown", close);
    return () => {
      removeEventListener("keydown", close);
      removeEventListener("pointerdown", close);
    };
  }, [open]);
  return (
    <span className="itip" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="itip-btn" aria-label={label} aria-describedby={id} aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <Icon name="info" size={15} />
      </button>
      <span id={id} role="tooltip" className={`itip-bubble ${below ? "below" : ""}`} hidden={!open}>{text}</span>
    </span>
  );
}

/** EmptyState: nothing here yet. Title, one line, optional single action (one primary button at most). */
export function EmptyState({ title, children, action, icon = "doc", plain = false }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: string; plain?: boolean }) {
  return (
    <div className={`state ${plain ? "plain" : ""}`}>
      <span className="state-icon" aria-hidden><Icon name={icon} size={20} /></span>
      <div className="state-title">{title}</div>
      {children && <div className="state-body">{children}</div>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** ErrorState: something failed. Say what happened in plain words; offer `onRetry` (renders a "Try again" button). */
export function ErrorState({ title = "Something went wrong", children, onRetry, action }: { title?: ReactNode; children?: ReactNode; onRetry?: () => void; action?: ReactNode }) {
  return (
    <div className="state error" role="alert">
      <span className="state-icon" aria-hidden><Icon name="alert" size={20} /></span>
      <div className="state-title">{title}</div>
      {children && <div className="state-body">{children}</div>}
      {(onRetry || action) && <div className="state-action row center">{onRetry && <button type="button" className="btn" onClick={onRetry}>Try again</button>}{action}</div>}
    </div>
  );
}

/**
 * PlainError: a failure told in plain words. `fallback` is what we say when the raw message is technical; the raw text
 * (if any) sits under "Technical details". `onRetry` adds "Try again". `inline` renders a small line instead of a box.
 */
export function PlainError({ title, raw, fallback, onRetry, inline = false, tone = "bad" }: {
  title?: ReactNode; raw?: unknown; fallback: string; onRetry?: () => void; inline?: boolean; tone?: "bad" | "warn";
}) {
  const text = plainError(raw, fallback);
  const rawText = String((raw as any)?.message ?? raw ?? "").trim();
  const showRaw = !!rawText && rawText !== text && `${rawText}.` !== text;
  return (
    <div className={`perr tone-${tone} ${inline ? "inline" : ""}`} role="alert">
      <Icon name="alert" size={inline ? 14 : 16} />
      <div className="perr-main">
        {title && <b className="perr-title">{title}</b>}
        <span className="perr-text">{text}</span>
        {(onRetry || showRaw) && (
          <div className="perr-foot">
            {onRetry && <button type="button" className="btn sm" onClick={onRetry}>Try again</button>}
            {showRaw && <TechDetails boxless><code className="mono small perr-raw">{rawText}</code></TechDetails>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Skeleton: shimmering placeholder while loading. `lines` renders N text lines; otherwise one block of `height`
 * (and optional `width`). Screen readers get one "Loading" status.
 */
export function Skeleton({ lines, height = 16, width, label = "Loading" }: { lines?: number; height?: number | string; width?: number | string; label?: string }) {
  if (lines) {
    return (
      <div className="skel-lines" role="status" aria-label={label}>
        {Array.from({ length: lines }, (_, i) => <span key={i} className="skel skel-line" style={{ width: i === lines - 1 && lines > 1 ? "60%" : "100%" }} />)}
      </div>
    );
  }
  return <span className="skel" role="status" aria-label={label} style={{ height, width: width ?? "100%" }} />;
}

/** Stat: a counter. value (number or text), label, optional hint line, tone colours the value, info adds ⓘ. */
export function Stat({ value, label, hint, tone, info, size }: { value: ReactNode; label: ReactNode; hint?: ReactNode; tone?: Tone; info?: string; size?: "sm" }) {
  return (
    <div className={`stat ${tone ? `tone-${tone}` : ""} ${size ?? ""}`}>
      <span className="stat-value">{value ?? "—"}</span>
      <span className="stat-label">{label}{info && <InfoTip text={info} />}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}
