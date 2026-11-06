import { describe, expect, it } from "vitest";
import { runMeshSim, SCENARIOS, meshSimView, type MeshEvent } from "./meshsim.js";
import { ANCHOR } from "./testkit.js";

const deliveredOnce = (events: MeshEvent[], ids: Set<string>) => {
  for (const id of ids) expect(events.filter((e) => e.type === "delivered" && e.bundleId === id)).toHaveLength(1);
};
const anchorTxCount = (r: Awaited<ReturnType<typeof runMeshSim>>) =>
  [...r.net.chains["0g-galileo"].txs.values()].filter((t) => t.tx.to === ANCHOR).length;

describe("mesh simulator (spec §7)", () => {
  it("three-owners: every valid bundle is delivered exactly once on-chain, via other owners' robots", async () => {
    const r = await runMeshSim(SCENARIOS["three-owners"]!(), 1);
    expect(r.result).toEqual({ delivered: 4, total: 4, refused: 0 });
    deliveredOnce(r.events, r.validIds);
    expect(anchorTxCount(r)).toBe(4);
    // Alice's incident went Alice → Bob → Carol and Carol submitted it
    const aliceIncident = r.bundles.find((b) => b.origin === "alice-arm" && b.severity === 3)!.bundleId;
    const hops = r.events.filter((e) => e.type === "pull" && e.bundleId === aliceIncident).map((e) => `${e.from}>${e.to}`);
    expect(hops).toEqual(expect.arrayContaining(["alice-arm>bob-arm", "bob-arm>carol-arm"]));
    expect(r.events.find((e) => e.type === "delivered" && e.bundleId === aliceIncident)?.from).toBe("carol-arm");
    // pings spread ahead of bundles, events are time-ordered
    expect(r.events.some((e) => e.type === "ping" && e.to)).toBe(true);
    expect(r.events.every((e, i) => i === 0 || e.t >= r.events[i - 1]!.t)).toBe(true);
  }, 60_000);

  it("origin-dies: a dead robot's incidents still arrive via others", async () => {
    const r = await runMeshSim(SCENARIOS["origin-dies"]!(), 7);
    expect(r.events.some((e) => e.type === "node-dead" && e.from === "alice-arm")).toBe(true);
    expect(r.result).toEqual({ delivered: 2, total: 2, refused: 0 });
    deliveredOnce(r.events, r.validIds);
    const dead = r.events.find((e) => e.type === "node-dead")!.t;
    for (const e of r.events.filter((x) => x.type === "delivered")) {
      expect(e.from).toBe("erin-phone");
      expect(e.t).toBeGreaterThan(dead);
    }
  }, 60_000);

  it("tamperer: edited and forged bundles are refused at every hop; false receipts do not stop delivery", async () => {
    const r = await runMeshSim(SCENARIOS.tamperer!(), 3);
    expect(r.result.total).toBe(1);
    expect(r.result.delivered).toBe(1);
    expect(r.result.refused).toBeGreaterThanOrEqual(2);
    const invalid = new Set(r.bundles.filter((b) => !b.valid).map((b) => b.bundleId));
    expect(invalid.size).toBe(1);
    // no node ever accepted anything that did not verify
    for (const e of r.events.filter((x) => x.type === "pull")) expect(r.validIds.has(e.bundleId!)).toBe(true);
    expect(r.events.filter((e) => e.type === "refused").every((e) => e.from === "mallory-arm")).toBe(true);
    // Bob stopped forwarding on Mallory's false receipt, then found no anchor on-chain and delivered it himself
    expect(r.events.some((e) => e.type === "drop" && e.from === "bob-arm" && /unverified receipt/.test(e.detail ?? ""))).toBe(true);
    expect(r.events.some((e) => e.type === "drop" && /receipt was false/.test(e.detail ?? ""))).toBe(true);
    deliveredOnce(r.events, r.validIds);
    expect(r.events.find((e) => e.type === "delivered")?.from).toBe("bob-arm");
  }, 60_000);

  it("caps and priority hold inside the mesh: with room for one bundle per origin, the incident travels first", async () => {
    const s = SCENARIOS["three-owners"]!();
    const r = await runMeshSim({ ...s, limits: { perOriginBytes: 15_000 } }, 1);
    const alice = r.bundles.filter((b) => b.origin === "alice-arm");
    const incident = alice.find((b) => b.severity === 3)!.bundleId;
    const routine = alice.find((b) => b.severity === 0)!.bundleId;
    const firstPullToBob = r.events.find((e) => e.type === "pull" && e.to === "bob-arm" && e.origin === "alice-arm");
    expect(firstPullToBob?.bundleId).toBe(incident);
    expect(r.events.some((e) => e.type === "drop" && e.bundleId === routine && /full/.test(e.detail ?? ""))).toBe(true);
    deliveredOnce(r.events, new Set([...r.validIds].filter((id) => r.events.some((e) => e.type === "delivered" && e.bundleId === id))));
  }, 60_000);

  it("is deterministic per seed and the public view has the demo shape", async () => {
    const a = await meshSimView("origin-dies", 5);
    const b = await runMeshSim(SCENARIOS["origin-dies"]!(), 5);
    expect(JSON.stringify(a!.events)).toBe(JSON.stringify(b.events));
    expect(Object.keys(a!).sort()).toEqual(["bundles", "durationSec", "events", "nodes", "result", "scenario", "seed"]);
    expect(a!.nodes[0]).toEqual({ id: "alice-arm", label: "Alice's arm", owner: "Alice", internet: false, alive: true });
    expect(meshSimView("nope", 1)).toBeNull();
  }, 60_000);
});
