/**
 * Accounts and robot linking (rev 5, R6). A person signs in with World ID Agent Pass (World IdP OIDC; the existing
 * device-grant client in human/worldid.ts). The account is keyed on (iss, sub): the pairwise subject is stable for this
 * app and reveals nothing else (https://auth.world.org/docs/guides/id-token). A robot is linked only with proof of
 * possession: the DEVICE signs a link message for this account with its own key, so nobody can claim someone else's
 * robot by typing its address. Sessions are random tokens held server-side; nothing secret reaches the browser.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { REPO_ROOT } from "../shared/env.js";
import { linkMessage, recoverDevice } from "../shared/deviceKey.js";
import { readJson, writeJson } from "../shared/util.js";

export interface LinkedRobot {
  address: string; // the device's own key
  deviceId: string;
  deviceUrl: string;
  linkedAt: string;
  linkSignature: string;
}

export interface Account {
  accountId: string; // sha256(iss|sub), first 32 hex
  issuer: string;
  subject: string; // pairwise sub
  createdAt: string;
  wallet: string | null; // where approved rewards are paid
  robots: LinkedRobot[];
}

export const accountIdOf = (issuer: string, subject: string) =>
  createHash("sha256").update(`${issuer}|${subject}`).digest("hex").slice(0, 32);

/** The exact text a device signs to join an account (the device refuses to sign anything else for linking). */

export class AccountStore {
  constructor(private readonly path = process.env.ACCOUNTS_FILE ?? resolve(REPO_ROOT, "data", "accounts.json")) {}

  private all(): Account[] {
    return readJson<Account[]>(this.path, []);
  }
  private save(a: Account[]) {
    writeJson(this.path, a);
  }
  get(accountId: string): Account | undefined {
    return this.all().find((a) => a.accountId === accountId);
  }
  /** Finds or creates the account for a validated World ID subject. */
  upsertFromIdentity(issuer: string, subject: string): Account {
    const id = accountIdOf(issuer, subject);
    const existing = this.get(id);
    if (existing) return existing;
    const a: Account = { accountId: id, issuer, subject, createdAt: new Date().toISOString(), wallet: null, robots: [] };
    this.save([...this.all(), a]);
    return a;
  }
  update(accountId: string, f: (a: Account) => Account): Account {
    const all = this.all();
    const i = all.findIndex((a) => a.accountId === accountId);
    if (i < 0) throw new Error("no such account");
    all[i] = f(all[i]!);
    this.save(all);
    return all[i]!;
  }
  setWallet(accountId: string, wallet: string): Account {
    if (!ethers.isAddress(wallet)) throw new Error("not a valid wallet address");
    return this.update(accountId, (a) => ({ ...a, wallet: ethers.getAddress(wallet) }));
  }
  /** Adds a robot after checking the device's own signature over the link message. */
  linkRobot(accountId: string, r: Omit<LinkedRobot, "linkedAt">, nonce: string): Account {
    const who = recoverDevice(linkMessage(accountId, nonce), r.linkSignature);
    if (!who || who.toLowerCase() !== r.address.toLowerCase()) throw new Error("the device did not sign this link");
    return this.update(accountId, (a) => ({
      ...a,
      robots: [...a.robots.filter((x) => x.address.toLowerCase() !== r.address.toLowerCase()), { ...r, address: ethers.getAddress(r.address), linkedAt: new Date().toISOString() }],
    }));
  }
}

/** Server-side sessions: random token → accountId, expiring. */
export class Sessions {
  private map = new Map<string, { accountId: string; expires: number }>();
  constructor(private readonly ttlMs = 12 * 3600_000) {}
  create(accountId: string): string {
    const t = randomBytes(32).toString("base64url");
    this.map.set(t, { accountId, expires: Date.now() + this.ttlMs });
    return t;
  }
  get(token: string | undefined): string | null {
    if (!token) return null;
    const s = this.map.get(token);
    if (!s || s.expires < Date.now()) {
      if (s) this.map.delete(token);
      return null;
    }
    return s.accountId;
  }
  end(token: string | undefined) {
    if (token) this.map.delete(token);
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
