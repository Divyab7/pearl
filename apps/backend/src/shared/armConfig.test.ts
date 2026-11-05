import { describe, expect, it } from "vitest";
import { loadArmConfig, parseArmConfig } from "./armConfig.js";

describe("arm config", () => {
  const cfg = loadArmConfig();

  it("loads and validates config/arm.json", () => {
    expect(cfg.joints).toEqual(["base", "shoulder", "elbow", "gripper"]);
    expect(cfg.heartbeatTimeoutMs).toBe(3000);
    expect(cfg.slots.A2.down).toEqual([90, 125, 60, 10]);
  });

  it("round-trips through JSON unchanged", () => {
    expect(parseArmConfig(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
  });

  it("rejects a slot pose outside the joint limits", () => {
    const bad = structuredClone(cfg);
    bad.slots.A1.down = [5, 125, 60, 10]; // base min is 10
    expect(() => parseArmConfig(bad)).toThrow(/A1\.down: base 5° outside/);
  });

  it("rejects a safe pose outside the limits and duplicate channels", () => {
    const bad = structuredClone(cfg);
    bad.safe = [90, 160, 60, 10]; // shoulder max is 150
    bad.channels = [0, 1, 1, 3];
    const r = (() => {
      try {
        parseArmConfig(bad);
        return "";
      } catch (e) {
        return String(e);
      }
    })();
    expect(r).toMatch(/safe: shoulder 160° outside/);
    expect(r).toMatch(/distinct PCA9685 channels/);
  });

  it("rejects unknown keys", () => {
    expect(() => parseArmConfig({ ...cfg, turbo: true })).toThrow();
  });
});
