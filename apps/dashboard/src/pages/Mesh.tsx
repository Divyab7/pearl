// Robot mesh: a simulated day of robots passing sealed records hand to hand until one reaches the internet.
import { useEffect, useMemo, useRef, useState } from "react";
import { Callout, Card, Empty, Spinner, Tabs } from "../components/ui";
import { endOf, FAKE_MESH, fetchMesh, SCENARIOS, stateAt, type MeshEvent, type MeshSim, type Scenario } from "../lib/mesh";

const PALETTE = ["#8fa8ff", "#3dd68c", "#f2b544", "#c792ea", "#5cc8ff", "#ff9f6b"];
const W = 820;
const H = 500;
const CHAIN = { x: 735, y: 235 };
const FX = 1; // seconds of sim time a hop or refusal stays on screen
const REAL_SECONDS = 24; // a whole scenario plays in about this long

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function useSim(scenario: Scenario, practice: boolean) {
  const [sim, setSim] = useState<MeshSim | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stop = false;
    setSim(null);
    setErr("");
    fetchMesh(scenario, 1, practice).then((s) => !stop && setSim(s)).catch((e) => !stop && setErr(e.message));
    return () => {
      stop = true;
    };
  }, [scenario, practice]);
  return { sim, err };
}

export function Mesh() {
  const [scenario, setScenario] = useState<Scenario>("three-owners");
  const [practice, setPractice] = useState(FAKE_MESH);
  const { sim, err } = useSim(scenario, practice);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const end = sim ? endOf(sim) : 1;
  const reduce = useMemo(reduceMotion, []);

  useEffect(() => {
    setT(0);
    setPlaying(!!sim && !reduce);
  }, [sim, reduce]);

  useEffect(() => {
    if (!playing || !sim) return;
    let last = performance.now();
    let raf = 0;
    const rate = end / REAL_SECONDS;
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => {
        const n = Math.min(end, x + dt * rate);
        if (n >= end) setPlaying(false);
        return n;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, sim, end]);

  const blurb = SCENARIOS.find((s) => s.id === scenario)!.blurb;
  return (
    <div className="stack mesh">
      {practice && <span className="small muted">Built-in example</span>}
      <Tabs label="What happens" active={scenario} onChange={(id) => setScenario(id as Scenario)} tabs={SCENARIOS.map((s) => ({ id: s.id, label: s.label }))} />
      {err && (
        <Callout tone="warn" title="The simulator isn't available on this server yet">
          <div className="row">
            <span>You can watch the built-in example instead; it follows the same rules.</span>
            <button type="button" className="btn small-btn" onClick={() => setPractice(true)}>Show the built-in example</button>
          </div>
        </Callout>
      )}
      {!sim && !err && <Card><p className="muted"><Spinner /> Running the simulation…</p></Card>}
      {sim && <Player sim={sim} t={t} setT={setT} playing={playing} setPlaying={setPlaying} end={end} reduce={reduce} blurb={blurb} />}
    </div>
  );
}

function Player({ sim, t, setT, playing, setPlaying, end, reduce, blurb }: {
  sim: MeshSim; t: number; setT: (n: number) => void; playing: boolean; setPlaying: (b: boolean) => void; end: number; reduce: boolean; blurb: string;
}) {
  const owners = useMemo(() => [...new Set(sim.nodes.map((n) => n.owner))], [sim]);
  const colour = (owner?: string) => PALETTE[Math.max(0, owners.indexOf(owner ?? "")) % PALETTE.length];
  const nodeById = useMemo(() => new Map(sim.nodes.map((n) => [n.id, n])), [sim]);
  const bundleById = useMemo(() => new Map(sim.bundles.map((b) => [b.bundleId, b])), [sim]);
  const pos = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    sim.nodes.forEach((n, i) => {
      const a = -Math.PI / 2 + (i / sim.nodes.length) * Math.PI * 2;
      out[n.id] = { x: 330 + Math.cos(a) * 250, y: 235 + Math.sin(a) * 170 };
    });
    return out;
  }, [sim]);
  const s = useMemo(() => stateAt(sim, t), [sim, t]);
  const recent = sim.events.filter((e) => e.t <= t && t < e.t + FX);
  const valid = sim.result.total || sim.bundles.filter((b) => b.valid).length;
  // never print "?" or a raw id: unknown ids read as a plain phrase
  const name = (id?: string) => nodeById.get(id ?? "")?.label ?? (id === "chain" ? "the internet" : "a robot nearby");
  const ownerOfOrigin = (e: MeshEvent) => nodeById.get(e.origin ?? bundleById.get(e.bundleId ?? "")?.origin ?? "")?.owner;
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, k: number) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  const prog = (e: MeshEvent) => (reduce ? 1 : Math.min(1, (t - e.t) / FX));
  const log = sim.events.filter((e) => e.t <= t && e.type !== "link-down").slice(-9).reverse();
  const flash = recent.some((e) => e.type === "delivered");

  return (
    <div className="mesh-grid">
      <Card className="mesh-stage-card" sub={blurb}>
        <svg viewBox={`0 0 ${W} ${H}`} className="mesh-svg" role="img" aria-label={`Simulation at ${Math.round(t)} seconds: ${s.delivered.size} of ${valid} records delivered`}>
          {/* internet: dashed lines to the chain */}
          {sim.nodes.filter((n) => s.alive[n.id] && s.internet[n.id]).map((n) => (
            <line key={`net-${n.id}`} x1={pos[n.id].x} y1={pos[n.id].y} x2={CHAIN.x} y2={CHAIN.y} className="mesh-net" />
          ))}
          {/* Bluetooth links */}
          {[...s.links].map((k) => {
            const [a, b] = k.split("|");
            if (!pos[a] || !pos[b]) return null;
            return <line key={k} x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y} className="mesh-link" />;
          })}
          {recent.filter((e) => e.type === "refused" && e.from && e.to).map((e, i) => (
            <line key={`rl${i}`} x1={pos[e.from!].x} y1={pos[e.from!].y} x2={pos[e.to!].x} y2={pos[e.to!].y} className="mesh-refused-line" />
          ))}
          {/* the chain */}
          <g className={`mesh-chain ${flash ? "flash" : ""}`}>
            <rect x={CHAIN.x - 62} y={CHAIN.y - 46} width={124} height={92} rx={12} />
            <text x={CHAIN.x} y={CHAIN.y - 18} textAnchor="middle" className="mesh-chain-title">Delivered online</text>
            <text x={CHAIN.x} y={CHAIN.y + 12} textAnchor="middle" className="mesh-chain-count">{s.delivered.size} / {valid}</text>
            <text x={CHAIN.x} y={CHAIN.y + 32} textAnchor="middle" className="mesh-small">records</text>
          </g>
          {/* nodes */}
          {sim.nodes.map((n) => {
            const p = pos[n.id];
            const alive = s.alive[n.id];
            const held = s.holds[n.id] ?? [];
            return (
              <g key={n.id} className={`mesh-node ${alive ? "" : "dead"}`}>
                <circle cx={p.x} cy={p.y} r={30} className="mesh-node-body" style={{ stroke: colour(n.owner) }} />
                <text x={p.x} y={p.y + 6} textAnchor="middle" className="mesh-node-label" aria-hidden>{n.owner.charAt(0)}</text>
                <text x={p.x} y={p.y + 50} textAnchor="middle" className="mesh-small mesh-name">{n.label}</text>
                <text x={p.x} y={p.y + 64} textAnchor="middle" className={`mesh-small ${alive ? (s.internet[n.id] ? "on" : "") : "bad"}`}>{alive ? (s.internet[n.id] ? "internet" : "no internet") : "broken"}</text>
                {!alive && <path d={`M${p.x - 14} ${p.y - 14}L${p.x + 14} ${p.y + 14}M${p.x + 14} ${p.y - 14}L${p.x - 14} ${p.y + 14}`} className="mesh-x" />}
                {held.map((id, i) => {
                  const b = bundleById.get(id);
                  // fan the held records over the top half only, so they never cover the name below the circle
                  const a = -Math.PI / 2 + (i - (held.length - 1) / 2) * Math.min(0.42, Math.PI / Math.max(1, held.length));
                  const bx = p.x + Math.cos(a) * 42;
                  const by = p.y + Math.sin(a) * 42;
                  return (
                    <circle key={id} cx={bx} cy={by} r={6} className={`mesh-bundle ${b?.valid === false ? "forged" : ""} ${b && b.severity > 0 ? "incident" : ""}`}
                      style={b?.valid === false ? undefined : { fill: colour(nodeById.get(b?.origin ?? "")?.owner) }}>
                      <title>{b ? `${b.valid ? "" : "Forged "}record from ${name(b.origin)}${b.severity > 0 ? ` · incident, severity ${b.severity}` : ""}` : id}</title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
          {/* moving things: hops, deliveries, pings, refusals */}
          {recent.map((e, i) => {
            const k = prog(e);
            if ((e.type === "pull" || e.type === "ping") && e.from && e.to && pos[e.from] && pos[e.to]) {
              const q = lerp(pos[e.from], pos[e.to], k);
              return e.type === "pull"
                ? <circle key={i} cx={q.x} cy={q.y} r={8} className="mesh-hop" style={{ fill: colour(ownerOfOrigin(e)) }} />
                : <circle key={i} cx={q.x} cy={q.y} r={5} className="mesh-ping" />;
            }
            if (e.type === "submit" && e.from && pos[e.from]) {
              const q = lerp(pos[e.from], CHAIN, k);
              return <circle key={i} cx={q.x} cy={q.y} r={8} className="mesh-hop" style={{ fill: colour(ownerOfOrigin(e)) }} />;
            }
            if (e.type === "refused" && e.to && pos[e.to]) {
              const p = lerp(pos[e.to], pos[e.from ?? e.to] ?? pos[e.to], 0.35);
              return (
                <g key={i} className="mesh-refused">
                  <circle cx={p.x} cy={p.y} r={11} />
                  <path d={`M${p.x - 5} ${p.y - 5}L${p.x + 5} ${p.y + 5}M${p.x + 5} ${p.y - 5}L${p.x - 5} ${p.y + 5}`} />
                </g>
              );
            }
            return null;
          })}
        </svg>
        <div className="mesh-controls">
          <button type="button" className="btn primary" onClick={() => { if (t >= end) setT(0); setPlaying(!playing); }} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "Pause" : t >= end ? "Replay" : "Play"}
          </button>
          <input type="range" min={0} max={end} step={0.1} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Time in the simulation" />
          <span className="small muted tabular nowrap">{Math.floor(t)} s of {Math.round(end)} s</span>
        </div>
        {reduce && <p className="small muted">Motion is reduced: press Play or drag the slider to step through.</p>}
      </Card>
      <div className="stack">
        <Card title={`Delivered ${s.delivered.size} of ${valid}`} sub={s.refused ? `${s.refused} forged ${s.refused === 1 ? "offer" : "offers"} refused` : "Every genuine record should arrive exactly once."}>
          <ul className="mesh-legend">
            {owners.map((o) => <li key={o}><i style={{ background: colour(o) }} /> {o}</li>)}
            <li><i className="lg-incident" /> Incident record</li>
            <li><i className="lg-forged" /> Forged record</li>
            <li><i className="lg-link" /> In Bluetooth range</li>
            <li><i className="lg-net" /> Has internet</li>
          </ul>
          {t >= end && <Callout tone={sim.result.delivered === valid ? "ok" : "warn"}>{sim.result.delivered === valid ? `All ${valid} genuine records were delivered, each exactly once.` : `${sim.result.delivered} of ${valid} genuine records were delivered.`}{sim.result.refused ? ` ${sim.result.refused} forged offers were refused.` : ""}</Callout>}
        </Card>
        <Card title="What just happened">
          {log.length === 0 ? <Empty title="Nothing yet">Press Play.</Empty> : (
            <ol className="mesh-log">
              {log.map((e, i) => <li key={`${e.t}-${i}`} className={e.type === "refused" ? "bad" : e.type === "delivered" ? "ok" : ""}><span className="tabular muted">{Math.floor(e.t)} s</span> {cap(describe(e, name, bundleById))}</li>)}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function describe(e: MeshEvent, name: (id?: string) => string, bundles: Map<string, { origin: string; severity: number; valid: boolean }>) {
  const b = bundles.get(e.bundleId ?? "");
  const whose = b ? `${b.valid ? "" : "a forged copy of "}${name(e.origin ?? b.origin)}'s ${b.severity > 0 ? "incident record" : "record"}` : "a record";
  switch (e.type) {
    case "link-up": return `${name(e.from)} and ${name(e.to)} are in Bluetooth range`;
    case "link-down": return `${name(e.from)} and ${name(e.to)} moved apart`;
    case "ping": { const who = e.to ? name(e.to) : ""; return `${name(e.from)} told ${who && who !== "a robot nearby" ? who : "everyone nearby"} about its latest run`; }
    case "pull": return `${name(e.to)} picked up ${whose} from ${name(e.from)}`;
    case "refused": return `${name(e.to)} refused ${b && !b.valid ? whose : "a forged record"} offered by ${name(e.from)}: the signature doesn't match`;
    case "submit": return `${name(e.from)} has internet and sends ${whose}`;
    case "delivered": return `${whose.charAt(0).toUpperCase() + whose.slice(1)} is delivered`;
    case "drop": return `${name(e.from)} let go of ${whose}${e.detail ? ` (${e.detail})` : ""}`;
    case "internet-up": return `${name(e.from)} got internet`;
    case "internet-down": return `${name(e.from)} lost internet`;
    case "node-dead": return `${name(e.from)} stopped working`;
    default: return "Something happened nearby";
  }
}


