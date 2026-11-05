/**
 * Integration test against a local Foundry chain (anvil), skipped when Foundry is not installed. Keys below are anvil's
 * default development accounts: public, local-only, holding no real funds.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../shared/env.js";
import { anchorEpisode, deployAnchor, deployPool, payReward, readAnchor, requestIdsHash } from "./anchor.js";

const bin = (n: string) => [resolve(homedir(), ".foundry/bin", n), n].find((p) => p === n || existsSync(p))!;
const hasFoundry = spawnSync(bin("anvil"), ["--version"]).status === 0;
const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const DEVICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;

describe.skipIf(!hasFoundry)("EpisodeAnchor v2 + RewardPool on a local chain", () => {
  let anvil: ChildProcess;
  let anchorAddr = "";
  let poolAddr = "";
  const provider = new ethers.JsonRpcProvider(RPC);

  beforeAll(async () => {
    const b = spawnSync(bin("forge"), ["build"], { cwd: resolve(REPO_ROOT, "contracts") });
    if (b.status !== 0) throw new Error(`forge build failed: ${b.stderr}`);
    anvil = spawn(bin("anvil"), ["--port", String(PORT), "--silent"]);
    for (let i = 0; i < 50; i++) {
      try {
        await provider.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    anchorAddr = (await deployAnchor(RPC, OPERATOR_KEY)).address;
    poolAddr = (await deployPool(RPC, OPERATOR_KEY, anchorAddr, ethers.parseEther("0.05"))).address;
    const op = new ethers.Wallet(OPERATOR_KEY, provider);
    await (await op.sendTransaction({ to: poolAddr, value: ethers.parseEther("1") })).wait();
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("the device anchors its own incident; the pool pays a verified human once", async () => {
    const device = new ethers.Wallet(DEVICE_KEY).address;
    const cfg = { rpcUrl: RPC, address: anchorAddr, privateKey: DEVICE_KEY, explorer: "" };
    const ep = {
      episodeId: "ep_20261105_test", headHash: "ab".repeat(32), rootHash: `0x${"cd".repeat(32)}`,
      requestIds: ["rid-1", "rid-2"], outcome: "TRIPPED" as const, severity: 2, incident: true,
    };
    const r = await anchorEpisode(cfg, ep);
    expect(r.device).toBe(device);
    expect(await readAnchor(cfg, device, ep.episodeId)).toMatchObject({
      headHash: ep.headHash, rootHash: ep.rootHash, requestIdsHash: requestIdsHash(ep.requestIds), outcome: 3, severity: 2, incident: true,
    });
    await expect(anchorEpisode(cfg, { ...ep, headHash: "ef".repeat(32) })).rejects.toThrow(); // write-once
    expect(await readAnchor(cfg, ethers.Wallet.createRandom().address, ep.episodeId)).toBeNull(); // per device

    const human = ethers.Wallet.createRandom().address;
    const pool = { rpcUrl: RPC, address: poolAddr, operatorKey: OPERATOR_KEY };
    const claimant = ethers.id("nullifier-of-a-human");
    await payReward(pool, { device, episodeId: ep.episodeId, claimant, to: human, amountWei: ethers.parseEther("0.02") });
    expect(await provider.getBalance(human)).toBe(ethers.parseEther("0.02"));
    await expect(payReward(pool, { device, episodeId: ep.episodeId, claimant, to: human, amountWei: ethers.parseEther("0.02") })).rejects.toThrow();
    await expect(payReward(pool, { device, episodeId: "ep_never", claimant, to: human, amountWei: 1n })).rejects.toThrow();
  }, 60_000);
});
