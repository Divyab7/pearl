// The browser's unlock keys (owner decisions 5–6 Nov 2026). The private half is created here, kept in this browser's
// storage and in a backup file the person downloads; only the public half is ever sent to the dashboard server.
import { keyId, newRecipientKey } from "./core";

export type Role = "owner" | "insurer";
export interface KeyRecord {
  type: "pearl-unlock-key";
  v: 1;
  role: Role;
  who: string; // account id (owner) or wallet address (insurer)
  kid: string;
  createdAt: string;
  privateJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
}

const slot = (role: Role, who: string) => `pearl.unlock.${role}.${who.toLowerCase()}`;

export function loadKey(role: Role, who: string | null | undefined): KeyRecord | null {
  if (!who) return null;
  try {
    const v = JSON.parse(localStorage.getItem(slot(role, who)) ?? "null");
    return v?.type === "pearl-unlock-key" && v.privateJwk?.d ? v : null;
  } catch {
    return null;
  }
}

export const publicOf = (r: KeyRecord) => ({ kty: "EC" as const, crv: "P-256" as const, x: r.privateJwk.x, y: r.privateJwk.y });

export async function createKey(role: Role, who: string): Promise<KeyRecord> {
  const kp = await newRecipientKey();
  const rec: KeyRecord = { type: "pearl-unlock-key", v: 1, role, who, kid: kp.kid, createdAt: new Date().toISOString(), privateJwk: kp.privateJwk };
  localStorage.setItem(slot(role, who), JSON.stringify(rec));
  return rec;
}

export function downloadBackup(rec: KeyRecord) {
  const body = {
    ...rec,
    warning: "This file unlocks your Pearl records. Keep it private and offline. Anyone holding it can read what it unlocks.",
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `pearl-${rec.role}-unlock-key-${rec.kid}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function restoreFromFile(file: File, role: Role, who: string): Promise<KeyRecord> {
  let rec: KeyRecord;
  try {
    rec = JSON.parse(await file.text());
  } catch {
    throw new Error("That file is not a Pearl key backup.");
  }
  if (rec?.type !== "pearl-unlock-key" || !rec.privateJwk?.d) throw new Error("That file is not a Pearl key backup.");
  if (rec.role !== role) throw new Error(`That backup is an ${rec.role} key, not an ${role} key.`);
  if (keyId(rec.privateJwk) !== rec.kid) throw new Error("That backup is damaged (its fingerprint does not match).");
  const stored = { ...rec, who };
  localStorage.setItem(slot(role, who), JSON.stringify(stored));
  return stored;
}
