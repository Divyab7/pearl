import { existsSync, rmSync } from "node:fs";
import { ethers } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import { deviceKeyPath, headMessage, loadDeviceWallet, recoverDevice, signerFor } from "./deviceKey.js";

const id = `test-device-${process.pid}`;
afterAll(() => rmSync(deviceKeyPath(id), { force: true }));

describe("device key", () => {
  it("creates a test key once and reuses it", () => {
    delete process.env.DEVICE_PRIVATE_KEY;
    const a = loadDeviceWallet(id);
    expect(existsSync(deviceKeyPath(id))).toBe(true);
    expect(loadDeviceWallet(id).address).toBe(a.address);
  });

  it("signs a log head that recovers to the device address", async () => {
    const s = signerFor(loadDeviceWallet(id));
    const msg = headMessage("ep_1", "ab".repeat(32));
    expect(recoverDevice(msg, await s.sign(msg))).toBe(s.address);
    expect(recoverDevice(headMessage("ep_1", "cd".repeat(32)), await s.sign(msg))).not.toBe(s.address);
    expect(recoverDevice(msg, "0x1234")).toBeNull();
  });

  it("prefers DEVICE_PRIVATE_KEY (the hardware's provisioned key)", () => {
    const w = ethers.Wallet.createRandom();
    process.env.DEVICE_PRIVATE_KEY = w.privateKey;
    expect(loadDeviceWallet("any").address).toBe(w.address);
    delete process.env.DEVICE_PRIVATE_KEY;
  });
});
