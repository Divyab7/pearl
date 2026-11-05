import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { EpisodeRecorder } from "../orchestrator/log.js";
import { episodeBytes } from "../orchestrator/pipeline.js";
import { loadArmConfig } from "../shared/armConfig.js";
import { headMessage } from "../shared/deviceKey.js";
import { tamperedCopy, verifyEpisode } from "../verify/verifier.js";
import { readRelay, relayEpisode } from "./relay.js";

async function signedLog(wallet: ethers.HDNodeWallet) {
  const rec = new EpisodeRecorder("ep_relay_1", "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  rec.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: {} });
  const log = rec.close("ABORTED");
  log.device = { address: wallet.address, signature: await wallet.signMessage(headMessage(log.episodeId, log.headHash)) };
  return log;
}

const fakeUpload = async (bytes: Uint8Array) => ({ rootHash: `0x${"ab".repeat(32)}`, txHash: "0xtx", txSeq: 7, ms: 1, len: bytes.length });

describe("storage relay (R5)", () => {
  it("relays a device-signed log once and the verifier labels it relayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-relay-"));
    const dev = ethers.Wallet.createRandom();
    const log = await signedLog(dev);
    let uploads = 0;
    const up = async (b: Uint8Array) => { uploads++; return fakeUpload(b); };
    const r = await relayEpisode(log, dev.address, up, dir);
    expect(r).toMatchObject({ episodeId: log.episodeId, device: dev.address });
    await relayEpisode(log, dev.address, up, dir);
    expect(uploads).toBe(1);
    expect(readRelay(log.episodeId, dir)?.rootHash).toBe(r.rootHash);
    const v = await verifyEpisode(log, { episodeId: log.episodeId, storage: { status: "failed", error: "insufficient funds" } }, {
      arm: loadArmConfig(), anchorOn: false, relayedRoot: r.rootHash, downloadStorage: async () => episodeBytes(log),
    });
    expect(v.checks.find((c) => c.id === 3)).toMatchObject({ status: "PASS", detail: expect.stringContaining("relayed by the dashboard") });
  });

  it("refuses the wrong device, an unsigned log and an edited log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-relay-"));
    const dev = ethers.Wallet.createRandom();
    const log = await signedLog(dev);
    await expect(relayEpisode(log, ethers.Wallet.createRandom().address, fakeUpload, dir)).rejects.toThrow(/expected device/);
    await expect(relayEpisode({ ...log, device: undefined }, dev.address, fakeUpload, dir)).rejects.toThrow(/not device-signed/);
    const { copy } = tamperedCopy(log);
    await expect(relayEpisode(copy, dev.address, fakeUpload, dir)).rejects.toThrow(/refused/);
  });
});
