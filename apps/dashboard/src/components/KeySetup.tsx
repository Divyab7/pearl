// Unlock-key setup for the owner and the insurer: create in this browser, download a backup, restore from a backup.
import { useRef, useState } from "react";
import { createKey, downloadBackup, loadKey, publicOf, restoreFromFile, type KeyRecord, type Role } from "../lib/keys";
import { Badge, Callout, Icon, Spinner } from "./ui";

export function KeySetup({ role, who, registeredKid, register, afterReplace, embedded = false, quiet = false, onKeyChange }: {
  /** Hide the key fingerprint and the "kept in this browser" note (the host page shows them elsewhere). */
  quiet?: boolean;
  /** Called after the key on this browser changes (created, restored, backed up). */
  onKeyChange?: () => void;
  /** Inside a titled section: no own heading. */
  embedded?: boolean;
  role: Role;
  who: string;
  registeredKid: string | null;
  register: (publicJwk: ReturnType<typeof publicOf>) => Promise<unknown>;
  /** Shown after creating a key that replaces an older one (e.g. "link the robot again"). */
  afterReplace?: string;
}) {
  const [rec, setRec] = useState<KeyRecord | null>(() => loadKey(role, who));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(() => (rec ? localStorage.getItem(`pearl.backup.${rec.kid}`) : null));
  const [confirmReplace, setConfirmReplace] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const matches = rec && registeredKid && rec.kid === registeredKid;
  const who_ = role === "owner" ? "your runs" : "claimed incidents";

  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const replacing = !!registeredKid;
      const r = await createKey(role, who);
      await register(publicOf(r));
      setRec(r);
      setSaved(null);
      setConfirmReplace(false);
      onKeyChange?.();
      setMsg({ tone: replacing ? "warn" : "ok", text: replacing && afterReplace ? `New key ready. ${afterReplace}` : "Key ready. Download the backup now." });
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const restore = async (f: File) => {
    setMsg(null);
    try {
      const r = await restoreFromFile(f, role, who);
      if (registeredKid && r.kid !== registeredKid) {
        setMsg({ tone: "warn", text: `Restored key ${r.kid}, but the key on record is ${registeredKid}. Use the matching backup, or create a new key.` });
      } else {
        if (!registeredKid) await register(publicOf(r));
        setMsg({ tone: "ok", text: "Key restored on this browser." });
      }
      setRec(r);
      onKeyChange?.();
    } catch (e: any) {
      setMsg({ tone: "bad", text: e.message });
    }
  };

  return (
    <div className="keysetup stack">
      <div className="row">
        {!embedded && <><Icon name="key" /><b>{role === "owner" ? "Unlock key" : "Receiving key"}</b></>}
        {matches ? <Badge tone="ok">Ready on this browser</Badge> : registeredKid ? <Badge tone="warn">Not on this browser</Badge> : <Badge tone="neutral">Not set up</Badge>}
        {registeredKid && !quiet && <span className="muted small">Fingerprint <code className="mono">{registeredKid}</code></span>}
      </div>
      {!quiet && <p className="muted small">
        {role === "owner"
          ? "Your robot locks every run for this key. It is created and kept in this browser; the server only ever gets the public half."
          : "Owners lock each claimed incident for this key. It is created and kept in this browser; the server only ever gets the public half."}
      </p>}
      {!registeredKid && (
        <button type="button" className="btn primary" onClick={create} disabled={busy}>{busy ? <><Spinner /> Creating…</> : "Create my unlock key"}</button>
      )}
      {matches && (
        <div className="row">
          {saved && <span className="small"><Icon name="check" size={12} /> Backup downloaded {new Date(saved).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
          <button type="button" className={`btn ${saved ? "small-btn" : "primary"}`} onClick={() => { downloadBackup(rec!); const now = new Date().toISOString(); localStorage.setItem(`pearl.backup.${rec!.kid}`, now); setSaved(now); onKeyChange?.(); }}>
            <Icon name="download" /> {saved ? "Download again" : "Download backup file"}
          </button>
          {!saved && <span className="muted small">Without a backup, clearing this browser loses access to {who_}.</span>}
        </div>
      )}
      {registeredKid && !matches && (
        <div className="row">
          <button type="button" className="btn primary" onClick={() => file.current?.click()}><Icon name="upload" /> Restore from backup</button>
          {!confirmReplace
            ? <button type="button" className="btn" onClick={() => setConfirmReplace(true)}>I lost it: create a new key</button>
            : (
              <>
                <button type="button" className="btn danger" onClick={create} disabled={busy}>Replace the key</button>
                <button type="button" className="btn ghost" onClick={() => setConfirmReplace(false)}>Keep the old key</button>
              </>
            )}
        </div>
      )}
      {confirmReplace && (
        <Callout tone="warn" title="Replace your unlock key?">
          {role === "owner"
            ? "The robot keeps each run's key, so after you link it again it re-locks past runs for the new key. Incidents you already shared with the insurer stay shared."
            : "Claims already locked for the old key can no longer be opened here; their owners must claim again."}
        </Callout>
      )}
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
    </div>
  );
}

/** World App approval prompt (Agent Pass device grant). */
export function WorldPrompt({ prompt, onCancel, label }: { prompt: any; onCancel: () => void; label: string }) {
  if (!prompt) return null;
  const url = prompt.verificationUri;
  return (
    <div className="world-prompt" role="status">
      <div className="row"><Spinner label="Waiting for World App" /><b>{label}</b></div>
      <ol className="muted">
        <li>Open <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, "")}</a> on your phone or here.</li>
        {prompt.userCode && <li>Enter the code <code className="code-big">{prompt.userCode}</code></li>}
        <li>Approve in World App. This page updates by itself.</li>
      </ol>
      <button type="button" className="btn ghost danger" onClick={onCancel}>Cancel</button>
    </div>
  );
}
