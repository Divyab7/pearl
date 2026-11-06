/**
 * The device's own identity (rev 5, device-first). On hardware the key lives in the ESP32's NVS; in sim the simulated
 * arm gets a test key of its own, generated once with a cryptographic RNG and kept in data/keys/ (gitignored).
 * The device signs the head of every episode log (EIP-191 personal_sign, ethers 6 Wallet.signMessage:
 * https://docs.ethers.org/v6/api/wallet/#BaseWallet-signMessage), so anyone can check which device produced a log.
 * Testnet keys only: anyone holding the board (or this laptop, in sim) can read them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import { REPO_ROOT, loadEnv } from "./env.js";
import { isPrivateKey, safeName } from "./util.js";

export interface DeviceSigner {
  address: string;
  sign(message: string): Promise<string>;
}

/** The exact text a device signs for an episode; the verifier rebuilds it from the log. */
export function headMessage(episodeId: string, headHash: string): string {
  return `Pearl episode ${episodeId} head ${headHash}`;
}

/**
 * The exact text a device signs to link itself to a dashboard account (pairing). It names the owner's key fingerprint:
 * from then on the robot locks every run key for that key only.
 */
export function linkMessage(accountId: string, nonce: string, ownerKid: string): string {
  return `Pearl link to account ${accountId} nonce ${nonce} owner key ${ownerKid}`;
}

export function deviceKeyPath(deviceId: string): string {
  return resolve(REPO_ROOT, "data", "keys", `${safeName(deviceId)}.json`);
}

/** DEVICE_PRIVATE_KEY if set; otherwise the sim device's own test key (created on first use). */
export function loadDeviceWallet(deviceId: string): ethers.Wallet {
  loadEnv();
  const env = process.env.DEVICE_PRIVATE_KEY ?? "";
  if (isPrivateKey(env)) return new ethers.Wallet(env);
  const p = deviceKeyPath(deviceId);
  if (existsSync(p)) return new ethers.Wallet((JSON.parse(readFileSync(p, "utf8")) as { privateKey: string }).privateKey);
  const w = ethers.Wallet.createRandom(); // ethers uses the platform CSPRNG
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ deviceId, address: w.address, privateKey: w.privateKey, note: "testnet only" }, null, 2), { mode: 0o600 });
  return new ethers.Wallet(w.privateKey);
}

export function signerFor(wallet: ethers.Wallet): DeviceSigner {
  return { address: wallet.address, sign: (m) => wallet.signMessage(m) };
}

/** Recovers the signer of a device signature; null when the signature is malformed. */
export function recoverDevice(message: string, signature: string): string | null {
  try {
    return ethers.verifyMessage(message, signature);
  } catch {
    return null;
  }
}
