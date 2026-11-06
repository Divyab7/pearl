// Robot mesh simulation (offline relay spec §7): fetch a simulated timeline from the server, or build the practice
// one in the browser (`?fakeMesh`), and replay it to any moment. Pure logic, no React.

export type Scenario = "three-owners" | "origin-dies" | "tamperer";
export const SCENARIOS: { id: Scenario; label: string; blurb: string }[] = [
  { id: "three-owners", label: "Three owners", blurb: "Robots of three different owners pass each other's records along until one reaches the internet." },
  { id: "origin-dies", label: "A robot dies", blurb: "A robot has an incident, hands its record to a neighbour, then breaks. The record still arrives." },
  { id: "tamperer", label: "A tamperer", blurb: "One device offers forged records. Every robot checks the signature and refuses them." },
];

export interface MeshNode { id: string; label: string; owner: string; internet: boolean; alive: boolean }
export type MeshEventType = "link-up" | "link-down" | "ping" | "pull" | "refused" | "submit" | "delivered" | "drop" | "internet-down" | "internet-up" | "node-dead";
export interface MeshEvent { t: number; type: MeshEventType; from?: string; to?: string; bundleId?: string; origin?: string; detail?: string }
export interface MeshBundle { bundleId: string; origin: string; episodeId: string; severity: number; valid: boolean }
export interface MeshSim { nodes: MeshNode[]; events: MeshEvent[]; bundles: MeshBundle[]; result: { delivered: number; total: number; refused: number } }

export const FAKE_MESH = new URLSearchParams(location.search).has("fakeMesh");

export async function fetchMesh(scenario: Scenario, seed = 1, practice = FAKE_MESH): Promise<MeshSim> {
  if (practice) return practiceSim(scenario);
  const r = await fetch(`/api/mesh/sim?scenario=${encodeURIComponent(scenario)}&seed=${seed}`);
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.nodes || !body?.events) throw Object.assign(new Error(body?.error ?? `HTTP ${r.status}`), { status: r.status });
  body.events.sort((a: MeshEvent, b: MeshEvent) => a.t - b.t);
  return body;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface MeshState {
  links: Set<string>;
  internet: Record<string, boolean>;
  alive: Record<string, boolean>;
  holds: Record<string, string[]>; // node → bundleIds it holds (own outbox + carried)
  delivered: Set<string>;
  refused: number;
}

const holderCache = new WeakMap<MeshSim, Map<string, string>>();
function holderOf(sim: MeshSim, b: MeshBundle): string {
  let m = holderCache.get(sim);
  if (!m) {
    m = new Map();
    for (const x of sim.bundles) {
      const first = x.valid ? null : sim.events.find((e) => e.bundleId === x.bundleId && e.from);
      m.set(x.bundleId, first?.from ?? x.origin);
    }
    holderCache.set(sim, m);
  }
  return m.get(b.bundleId) ?? b.origin;
}

/** Replays every event up to and including time t. */
export function stateAt(sim: MeshSim, t: number): MeshState {
  const s: MeshState = {
    links: new Set(),
    internet: Object.fromEntries(sim.nodes.map((n) => [n.id, n.internet])),
    alive: Object.fromEntries(sim.nodes.map((n) => [n.id, n.alive])),
    // a valid bundle starts at its origin; a forged one at whoever first offers it (it only claims its origin)
    holds: Object.fromEntries(sim.nodes.map((n) => [n.id, sim.bundles.filter((b) => holderOf(sim, b) === n.id).map((b) => b.bundleId)])),
    delivered: new Set(),
    refused: 0,
  };
  const add = (n: string | undefined, id: string | undefined) => {
    if (n && id && s.holds[n] && !s.holds[n].includes(id)) s.holds[n].push(id);
  };
  const remove = (n: string | undefined, id: string | undefined) => {
    if (n && id && s.holds[n]) s.holds[n] = s.holds[n].filter((x) => x !== id);
  };
  for (const e of sim.events) {
    if (e.t > t) break;
    switch (e.type) {
      case "link-up": if (e.from && e.to) s.links.add(pairKey(e.from, e.to)); break;
      case "link-down": if (e.from && e.to) s.links.delete(pairKey(e.from, e.to)); break;
      case "internet-up": if (e.from) s.internet[e.from] = true; break;
      case "internet-down": if (e.from) s.internet[e.from] = false; break;
      case "node-dead":
        if (e.from) {
          s.alive[e.from] = false;
          s.internet[e.from] = false;
          s.holds[e.from] = [];
          for (const k of [...s.links]) if (k.split("|").includes(e.from)) s.links.delete(k);
        }
        break;
      case "pull": add(e.to, e.bundleId); break;
      case "refused": s.refused++; break;
      case "delivered": if (e.bundleId) s.delivered.add(e.bundleId); break;
      case "drop": remove(e.from, e.bundleId); break;
    }
  }
  return s;
}

export const endOf = (sim: MeshSim) => Math.max(10, ...sim.events.map((e) => e.t)) + 2;

// ---------------------------------------------------------------------------------------------------------------------
// Practice timelines: a small store-and-forward engine with the same rules as §7 (verify before accepting, dedupe,
// incidents first, receipts gossip, deliver once). Deterministic; used only with ?fakeMesh or when the page asks.

interface Plan {
  nodes: MeshNode[];
  bundles: (MeshBundle & { tamperedBy?: string })[];
  schedule: MeshEvent[]; // link-up/down, internet-up/down, node-dead
  end: number;
}

function simulate(plan: Plan): MeshSim {
  const events: MeshEvent[] = [];
  const nodes = plan.nodes;
  const holds = new Map(nodes.map((n) => [n.id, new Set(plan.bundles.filter((b) => (b.tamperedBy ?? b.origin) === n.id).map((b) => b.bundleId))]));
  const receipts = new Map(nodes.map((n) => [n.id, new Set<string>()]));
  const refusedBy = new Map(nodes.map((n) => [n.id, new Set<string>()]));
  const pinged = new Set<string>();
  const internet = new Map(nodes.map((n) => [n.id, n.internet]));
  const alive = new Map(nodes.map((n) => [n.id, n.alive]));
  const links = new Set<string>();
  const byId = new Map(plan.bundles.map((b) => [b.bundleId, b]));
  const submitted = new Map<string, number>(); // bundleId → time it lands on chain
  const delivered = new Set<string>();
  const prio = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)!).sort((a, b) => b.severity - a.severity || a.bundleId.localeCompare(b.bundleId));
  const drop = (t: number, n: string, id: string, detail: string) => {
    if (holds.get(n)!.delete(id)) events.push({ t, type: "drop", from: n, bundleId: id, origin: byId.get(id)?.origin, detail });
  };

  for (let t = 0; t <= plan.end; t++) {
    for (const e of plan.schedule.filter((x) => x.t === t)) {
      if (e.type === "link-up" && alive.get(e.from!) && alive.get(e.to!)) links.add(pairKey(e.from!, e.to!));
      else if (e.type === "link-down") links.delete(pairKey(e.from!, e.to!));
      else if (e.type === "internet-up") internet.set(e.from!, true);
      else if (e.type === "internet-down") internet.set(e.from!, false);
      else if (e.type === "node-dead") {
        alive.set(e.from!, false);
        internet.set(e.from!, false);
        holds.get(e.from!)!.clear();
        for (const k of [...links]) if (k.split("|").includes(e.from!)) links.delete(k);
      } else continue;
      events.push({ ...e });
    }
    // deliveries land two seconds after submission; the deliverer keeps a receipt and drops its copy
    for (const [id, at] of submitted) {
      if (at !== t || delivered.has(id)) continue;
      delivered.add(id);
      const node = events.find((e) => e.type === "submit" && e.bundleId === id)!.from!;
      events.push({ t, type: "delivered", from: node, bundleId: id, origin: byId.get(id)!.origin, detail: "anchored on 0G Chain" });
      receipts.get(node)!.add(id);
      drop(t, node, id, "delivered");
    }
    for (const k of links) {
      const [a, b] = k.split("|");
      for (const [from, to] of [[a, b], [b, a]]) {
        // signed pings travel first, once per pair
        if (!pinged.has(`${from}>${to}`)) {
          pinged.add(`${from}>${to}`);
          if (nodes.find((n) => n.id === from)!.owner !== "Courier") events.push({ t, type: "ping", from, to });
        }
        // receipts spread; anyone holding a delivered bundle lets it go
        for (const r of receipts.get(from)!) {
          if (!receipts.get(to)!.has(r)) receipts.get(to)!.add(r);
          drop(t, to, r, "already delivered");
        }
        // one pull per direction per second, incidents first
        const want = prio(holds.get(from)!).find((x) => !holds.get(to)!.has(x.bundleId) && !receipts.get(to)!.has(x.bundleId) && !refusedBy.get(to)!.has(x.bundleId));
        if (!want) continue;
        if (!want.valid) {
          refusedBy.get(to)!.add(want.bundleId);
          events.push({ t, type: "refused", from, to, bundleId: want.bundleId, origin: want.origin, detail: "signature does not match the robot it names" });
        } else {
          holds.get(to)!.add(want.bundleId);
          events.push({ t, type: "pull", from, to, bundleId: want.bundleId, origin: want.origin });
        }
      }
    }
    // nodes with internet submit what they hold, each bundle once
    for (const n of nodes) {
      if (!alive.get(n.id) || !internet.get(n.id)) continue;
      for (const b of prio(holds.get(n.id)!)) {
        if (!b.valid || submitted.has(b.bundleId)) continue;
        submitted.set(b.bundleId, t + 2);
        events.push({ t, type: "submit", from: n.id, bundleId: b.bundleId, origin: b.origin });
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  const valid = plan.bundles.filter((b) => b.valid);
  return {
    nodes,
    events,
    bundles: plan.bundles.map(({ tamperedBy: _t, ...b }) => b),
    result: { delivered: delivered.size, total: valid.length, refused: events.filter((e) => e.type === "refused").length },
  };
}

const node = (id: string, owner: string, internet = false): MeshNode => ({ id, label: id, owner, internet, alive: true });
const bundle = (origin: string, n: number, severity: number, valid = true): MeshBundle => ({
  bundleId: `0x${origin.toLowerCase()}${n}${"0".repeat(8)}${valid ? "a" : "f"}`,
  origin, episodeId: `ep_20261106_${origin.toLowerCase()}${n}`, severity, valid,
});
const ev = (t: number, type: MeshEventType, from: string, to?: string): MeshEvent => ({ t, type, from, ...(to ? { to } : {}) });

export function practiceSim(scenario: Scenario): MeshSim {
  if (scenario === "origin-dies") {
    return simulate({
      nodes: [node("A1", "Asha"), node("A2", "Asha"), node("B1", "Ben"), node("C1", "Chen"), node("Phone", "Courier")],
      bundles: [bundle("A1", 1, 3), bundle("A2", 1, 0), bundle("B1", 1, 1)],
      schedule: [
        ev(2, "link-up", "A1", "B1"), ev(7, "node-dead", "A1"),
        ev(9, "link-up", "B1", "C1"), ev(11, "link-up", "A2", "C1"), ev(14, "link-down", "B1", "C1"),
        ev(17, "link-up", "C1", "Phone"), ev(18, "internet-up", "Phone"), ev(22, "link-down", "C1", "Phone"),
        ev(24, "link-up", "B1", "Phone"), ev(28, "link-up", "A2", "B1"),
      ],
      end: 32,
    });
  }
  if (scenario === "tamperer") {
    const forged = { ...bundle("B1", 9, 3, false), tamperedBy: "X" };
    return simulate({
      nodes: [node("A1", "Asha"), node("B1", "Ben"), node("X", "Unknown"), node("C1", "Chen"), node("B2", "Ben")],
      bundles: [bundle("A1", 1, 2), bundle("B1", 1, 0), bundle("C1", 1, 1), { ...bundle("X", 1, 2, false), tamperedBy: "X" }, forged],
      schedule: [
        ev(2, "link-up", "X", "A1"), ev(4, "link-up", "A1", "B1"), ev(6, "link-up", "X", "B1"), ev(9, "link-down", "X", "A1"),
        ev(10, "link-up", "B1", "C1"), ev(12, "link-up", "X", "C1"), ev(15, "link-up", "C1", "B2"),
        ev(20, "internet-up", "B2"), ev(26, "link-up", "B1", "B2"),
      ],
      end: 30,
    });
  }
  return simulate({
    nodes: [node("A1", "Asha"), node("A2", "Asha"), node("B1", "Ben"), node("B2", "Ben"), node("C1", "Chen"), node("Phone", "Courier")],
    bundles: [bundle("A1", 1, 2), bundle("A2", 1, 0), bundle("B1", 1, 0), bundle("B2", 1, 3), bundle("C1", 1, 1)],
    schedule: [
      ev(2, "link-up", "A1", "A2"), ev(5, "link-up", "A2", "B1"), ev(8, "link-down", "A1", "A2"),
      ev(9, "link-up", "B1", "B2"), ev(12, "link-down", "A2", "B1"), ev(13, "link-up", "B2", "C1"),
      ev(17, "link-up", "C1", "Phone"), ev(18, "internet-up", "Phone"), ev(21, "link-down", "C1", "Phone"),
      ev(22, "internet-up", "B2"), ev(26, "link-up", "A2", "B1"), ev(27, "link-up", "B1", "B2"),
    ],
    end: 32,
  });
}
