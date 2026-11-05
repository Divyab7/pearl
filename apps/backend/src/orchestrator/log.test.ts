import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZERO_HASH } from "../shared/hash.js";
import type { EpisodeLog } from "../shared/types.js";
import { EpisodeRecorder, listEpisodeIds, readEpisode, recordHashOf, verifyChain, writeEpisode } from "./log.js";

function sampleLog(): EpisodeLog {
  const r = new EpisodeRecorder("ep_test_1", "sim-arm-01", "arm-1", { task: "pick", color: "red", from: "A2", to: "BIN" });
  r.addEvent({ ts: "2026-11-05T21:00:00.000Z", ev: "episode_start", data: { note: "x" } });
  r.addDecision({
    checkpoint: "PLAN",
    ts: "2026-11-05T21:00:01.000Z",
    source: "0g",
    model: "glm-5.3-flash",
    requestId: "rid-1",
    httpRequestId: "rid-1",
    clientRequestId: "ep_test_1:1:PLAN",
    clientRequestIdEchoed: true,
    provider: "0xabc",
    providerIdentity: null,
    teeVerified: true,
    cost: "3",
    zgResKey: null,
    reasoning: null,
    promptHash: "a".repeat(64),
    frameHash: null,
    frameRoot: null,
    telemetry: { state: "WAITING", joints: [90, 90, 90, 10], tofMm: 600, accG: 1 },
    raw: '{"action":"PICK"}',
    parsed: { action: "PICK", slot: "A2", reason: "red cube at A2", confidence: 0.9 },
    error: null,
    policy: "PICK A2",
    override: null,
    commandsSent: ["move:[90,100,80,10]"],
    latencyMs: 812,
  });
  r.addEvent({ ts: "2026-11-05T21:00:02.000Z", ev: "hand_in_zone", data: { tofMm: 80 } });
  return r.close("DONE");
}

describe("episode hash chain", () => {
  it("links records and verifies clean", () => {
    const log = sampleLog();
    expect(log.records[0]!.prevHash).toBe(ZERO_HASH);
    expect(log.records[1]!.prevHash).toBe(log.records[0]!.recordHash);
    expect(log.headHash).toBe(log.records[2]!.recordHash);
    expect(verifyChain(log)).toMatchObject({ ok: true, badIdx: null });
  });

  it("one changed byte in a reason breaks the chain at that record", () => {
    const log = sampleLog();
    const tampered = structuredClone(log);
    (tampered.records[1] as any).parsed.reason = "red cube at A3";
    const c = verifyChain(tampered);
    expect(c.ok).toBe(false);
    expect(c.badIdx).toBe(1);
    expect(c.reason).toMatch(/recordHash/);
  });

  it("re-hashing a tampered record still breaks the next link", () => {
    const log = sampleLog();
    const t = structuredClone(log);
    (t.records[0] as any).data.note = "y";
    const { recordHash: _drop, ...rest } = t.records[0]!;
    (t.records[0] as any).recordHash = recordHashOf(rest);
    const c = verifyChain(t);
    expect(c.ok).toBe(false);
    expect(c.badIdx).toBe(1);
    expect(c.reason).toMatch(/prevHash/);
  });

  it("dropping the last record is caught by the headHash", () => {
    const t = structuredClone(sampleLog());
    t.records.pop();
    expect(verifyChain(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/headHash/) });
  });

  it("is idempotent and survives a JSON file round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "pearl-"));
    const log = sampleLog();
    writeEpisode(log, dir);
    const back = readEpisode(log.episodeId, dir);
    expect(back).toEqual(log);
    expect(verifyChain(back).ok).toBe(true);
    expect(listEpisodeIds(dir)).toEqual(["ep_test_1"]);
  });

  it("refuses records after close and non-JSON values", () => {
    const r = new EpisodeRecorder("ep_t", "d", "a", { task: "pick", color: "red", from: "A1", to: "BIN" });
    expect(() => r.addEvent({ ts: "t", ev: "x", data: { n: Number.NaN } })).toThrow();
    r.close("ABORTED");
    expect(() => r.addEvent({ ts: "t", ev: "x", data: {} })).toThrow(/closed/);
  });
});
