import { describe, expect, it } from "vitest";
import { loadArmConfig } from "./armConfig.js";
import { compareFirmwareConfig, parseDefines, readFirmwareHeader } from "./firmwareConfig.js";

describe("firmware config.h matches config/arm.json", () => {
  const cfg = loadArmConfig();
  const header = readFirmwareHeader();

  it("every shared number is identical", () => {
    expect(compareFirmwareConfig(cfg, header)).toEqual([]);
  });

  it("a recalibrated value changed in only one place is caught", () => {
    const edited = header.replace("#define HAND_ZONE_MM 120", "#define HAND_ZONE_MM 150");
    expect(compareFirmwareConfig(cfg, edited)).toEqual(["HAND_ZONE_MM: config.h 150 ≠ arm.json 120"]);
    const joints = header.replace("#define SAFE_DEG { 90, 120, 60, 10 }", "#define SAFE_DEG { 90, 110, 60, 10 }");
    expect(compareFirmwareConfig(cfg, joints)[0]).toMatch(/^SAFE_DEG/);
  });

  it("parses array and comment forms", () => {
    const d = parseDefines("#define A { 1, 2 }   // note\n#define B 1.8\n");
    expect(d.get("A")).toBe("{ 1, 2 }");
    expect(d.get("B")).toBe("1.8");
  });
});
