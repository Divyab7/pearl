import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { headMessage } from "../shared/deviceKey.js";
import { newRunKey, sealEpisode, sealedBytes } from "../shared/seal.js";
import { sha256Hex } from "../shared/hash.js";
import { verifyPublic } from "../verify/verifier.js";
import { readRelay, relayEpisode } from "./relay.js";

async function sealedRun(wallet: ethers.HDNodeWallet) {
  const rec = new EpisodeRecorder("ep_relay_1", "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  rec.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: {} });
  const log = rec.close("ABORTED");
  log.device = { address: wallet.address, signature: await wallet.signMessage(headMessage(log.episodeId, log.headHash)) };
  return sealEpisode(log, newRunKey(), { incident: false, severity: 0, origin: null });
}

const rootOf = async (b: Uint8Array) => `0x${sha256Hex(b)}`;
const fakeUpload = async (bytes: Uint8Array) => ({ rootHash: await rootOf(bytes), txHash: "0xtx", txSeq: 7, ms: 1 });

describe("storage relay (R5)", () => {
  it("relays the robot's locked file once, and the public check labels its root as relayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-relay-"));
    const dev = ethers.Wallet.createRandom();
    const sealed = await sealedRun(dev);
    let uploads = 0;
    let sent: Uint8Array = new Uint8Array();
    const up = async (b: Uint8Array) => { uploads++; sent = b; return fakeUpload(b); };
    const r = await relayEpisode(sealed, dev.address, up, dir);
    expect(r).toMatchObject({ episodeId: sealed.episodeId, device: dev.address });
    await relayEpisode(sealed, dev.address, up, dir);
    expect(uploads).toBe(1);
    expect(Buffer.from(sent).equals(Buffer.from(sealedBytes(sealed)))).toBe(true); // exactly the locked file, nothing readable
    expect(readRelay(sealed.episodeId, dir)?.rootHash).toBe(r.rootHash);
    const v = await verifyPublic(sealed.episodeId, {
      device: dev.address, anchorOn: false, zerobotOn: false, fallbackRoot: r.rootHash, downloadStorage: async () => sent,
    });
    expect(v.checks.find((c) => c.id === 2)).toMatchObject({ status: "PASS", detail: expect.stringContaining("relayed root") });
  });

  it("refuses the wrong device and a forged signature", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-relay-"));
    const dev = ethers.Wallet.createRandom();
    const sealed = await sealedRun(dev);
    await expect(relayEpisode(sealed, ethers.Wallet.createRandom().address, fakeUpload, dir)).rejects.toThrow(/expected device/);
    const forged = { ...sealed, headHash: "f".repeat(64) };
    await expect(relayEpisode(forged, dev.address, fakeUpload, dir)).rejects.toThrow(/refused/);
  });
});
