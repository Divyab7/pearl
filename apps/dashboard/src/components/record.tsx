// Pearl's signature motif: a proof card styled like a flight-recorder tag / sealed ticket. Add `record` (bright band)
// or `record quiet` (outlined band, for lists) to a card and put <RecordStrip> first inside it. The strip carries the
// stencil label, the serial (the short form of the record's fingerprint, in mono) and a small seal; its bottom edge is
// the perforated tear line, with punched notches at both sides. Styles: styles.css, "signature motif".
// The label and seal are decoration: every state they hint at is also said in words by the card itself.

/** "0x7cd2f3cf6e1d…" → "7CD2·F3CF·6E1D": the first 12 hex digits of a fingerprint, grouped like a serial number. */
export function serialOf(...hashes: (string | null | undefined)[]): string | null {
  for (const h of hashes) {
    const m = typeof h === "string" ? /^(?:0x)?([0-9a-f]{12})/i.exec(h.trim()) : null;
    if (m) return m[1]!.toUpperCase().match(/.{4}/g)!.join("·");
  }
  return null;
}

export type SealTone = "ok" | "bad" | "warn" | "neutral";

export function RecordStrip({ serial, label = "Sealed record", seal = "ok" }: { serial?: string | null; label?: string; seal?: SealTone | null }) {
  return (
    <div className="record-strip">
      <span className="record-label">{label}</span>
      {serial && (
        <span className="record-serial" title="The start of this record's fingerprint">
          <span aria-hidden>S/N </span><span className="sr-only">fingerprint </span>{serial}
        </span>
      )}
      {seal && <Seal tone={seal} />}
    </div>
  );
}

/** The small round stamp at the end of the strip: a check (sealed and intact), a cross (broken) or a dash. */
export function Seal({ tone = "ok" }: { tone?: SealTone }) {
  return (
    <span className={`record-seal tone-${tone}`} aria-hidden>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        {tone === "ok" ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : tone === "bad" ? <path d="M7 7l10 10M17 7L7 17" /> : <path d="M7 12h10" />}
      </svg>
    </span>
  );
}
