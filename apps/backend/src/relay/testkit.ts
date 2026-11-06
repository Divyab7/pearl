/** Tests and the mesh simulator (fake chains only): a robot wallet, a primed pre-sign cache and a bundle input, for the relay tests. */
import { ethers } from "ethers";
import { emptyCache, type PresignCache } from "./cache.js";
import type { BundleInput } from "./bundle.js";
import { FAKE_FLOW, FAKE_PRICE } from "./fakeNet.js";

export const ANCHOR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export function primedCache(device: string, nonces: { g?: number; a?: number } = {}): PresignCache {
  const c = emptyCache(device);
  c.chains["0g-galileo"] = { ...c.chains["0g-galileo"], nextNonce: nonces.g ?? 0, gasPrice: "4000000000", tip: "0" };
  c.chains["arkiv-rabdi"] = { ...c.chains["arkiv-rabdi"], nextNonce: nonces.a ?? 0, gasPrice: "1000000000", tip: "0" };
  c.storage = { flow: FAKE_FLOW, pricePerSector: FAKE_PRICE.toString() };
  c.updatedAt = "2026-11-06T00:00:00.000Z";
  return c;
}

const bytesOf = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, k) => (k * 31 + seed) % 251);

export function sampleInput(over: Partial<BundleInput> = {}): BundleInput {
  return {
    episodeId: "ep_20261106093000_ab12",
    armId: "arm-1",
    endedAtMs: Date.parse("2026-11-06T09:30:00.000Z"),
    outcome: "TRIPPED",
    incident: true,
    severity: 2,
    headHash: "ab".repeat(32),
    requestIds: ["req-1", "req-2"],
    log: bytesOf(8700, 1),
    frames: [{ idx: 3, bytes: bytesOf(26000, 7) }],
    anchorAddress: ANCHOR,
    arkivLifetimeDays: 30,
    ...over,
  };
}

export const newWallet = () => new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
