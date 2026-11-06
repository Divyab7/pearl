/**
 * The robot's own key memory (device program only, never the dashboard): one random run key per episode, and the
 * public key of the owner the robot is linked to. On hardware these live in the ESP32's NVS; in sim under
 * data/keys/ (gitignored, mode 0600). The robot keeps each run key so it can lock that run for its owner again, e.g.
 * after the owner replaces a lost key and re-links. Keys never leave the robot unwrapped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.js";
import { keyId, newRunKey, runContext, wrapRunKey, type PublicJwk, type WrappedKey } from "./seal.js";
import { readJson, safeName, writeJson } from "./util.js";

export interface OwnerKey {
  accountId: string;
  publicJwk: PublicJwk;
  kid: string;
  setAt: string;
}

export class RobotKeys {
  private readonly mem = new Map<string, Uint8Array>();
  constructor(
    readonly deviceId: string,
    /** false in tests: keys stay in memory only */
    private readonly persist = true,
    private readonly dir = process.env.KEYS_DIR ?? resolve(REPO_ROOT, "data", "keys"),
  ) {}

  private runPath(episodeId: string) {
    return resolve(this.dir, "runs", safeName(this.deviceId), `${safeName(episodeId)}.key`);
  }
  private ownerPath() {
    return resolve(this.dir, `owner-${safeName(this.deviceId)}.json`);
  }

  /** A fresh run key for a new episode, kept before the first record is written. */
  createRunKey(episodeId: string): Uint8Array {
    const k = newRunKey();
    this.mem.set(episodeId, k);
    if (this.persist) {
      const p = this.runPath(episodeId);
      mkdirSync(resolve(p, ".."), { recursive: true });
      writeFileSync(p, Buffer.from(k).toString("hex"), { mode: 0o600 });
    }
    return k;
  }

  runKey(episodeId: string): Uint8Array | null {
    const m = this.mem.get(episodeId);
    if (m) return m;
    if (!this.persist) return null;
    const p = this.runPath(episodeId);
    return existsSync(p) ? new Uint8Array(Buffer.from(readFileSync(p, "utf8").trim(), "hex")) : null;
  }

  private ownerMem: OwnerKey | null = null;
  owner(): OwnerKey | null {
    if (this.ownerMem) return this.ownerMem;
    return this.persist ? readJson<OwnerKey | null>(this.ownerPath(), null) : null;
  }
  setOwner(accountId: string, publicJwk: PublicJwk): OwnerKey {
    const o: OwnerKey = { accountId, publicJwk, kid: keyId(publicJwk), setAt: new Date().toISOString() };
    this.ownerMem = o;
    if (this.persist) writeJson(this.ownerPath(), o, 0o600);
    return o;
  }

  /** The run key locked for the current owner; null when there is no owner yet or the run key is unknown. */
  async wrapForOwner(deviceAddress: string, episodeId: string): Promise<WrappedKey | null> {
    const o = this.owner();
    const k = this.runKey(episodeId);
    if (!o || !k) return null;
    return wrapRunKey(k, o.publicJwk, runContext(deviceAddress, episodeId));
  }
}
