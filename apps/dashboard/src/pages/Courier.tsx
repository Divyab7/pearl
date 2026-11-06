// Courier: when a robot has no internet, this browser collects its sealed records over Bluetooth and delivers them.
import { useEffect, useRef, useState } from "react";
import { ago, short, useConfig } from "../api";
import { ARKIV_EXPLORER } from "../components/claims";
import { Outcome, Severity, shortRun } from "../components/run";
import { TechDetails } from "../components/blocks";
import { Badge, Callout, Card, Chip, DotLabel, Empty, Icon, Spinner, Stepper, type Step, type Tone } from "../components/ui";
import {
  bluetoothSupport, changes, checkPing, checkPings, collect, listServable, readReceipts, type HeardPing, type Receipt, type ServeEntry, CourierError, deliver, FAKE_RELAY, FAKE_ROBOT, findRobot, forget, listCarried, relay,
  startCarrier, stepDone, stepFailed, stepGroup, type BundleCheck, type Carried, type Ping, type RelayStatus, type RelayStep, type RobotInfo,
  type RobotLink, type Support,
} from "../lib/courier";

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

const FIND_ERROR: Record<CourierError["kind"], { tone: Tone; title: string; body: string }> = {
  cancelled: { tone: "neutral", title: "No robot picked", body: "Make sure the robot is switched on and within a few metres, then try again." },
  denied: { tone: "bad", title: "Bluetooth is blocked for this page", body: "Allow Bluetooth for this site in the browser's settings, then try again." },
  "out-of-range": { tone: "warn", title: "Lost the robot", body: "It may be out of range. Move closer and try again. Anything already collected stays on this device." },
  protocol: { tone: "bad", title: "That device didn't answer like a Pearl robot", body: "Pick a device whose name starts with Pearl-." },
  invalid: { tone: "bad", title: "The record arrived incomplete", body: "Try collecting it again." },
};

function Unsupported({ why }: { why: Exclude<Support, { ok: true }>["why"] }) {
  if (why === "insecure") return <Callout tone="warn" title="Bluetooth needs a secure page">Browsers only allow Bluetooth on secure pages. Open this page on the laptop at localhost, or at its https address.</Callout>;
  if (why === "adapter-off") return <Callout tone="warn" title="Bluetooth is off">Turn on Bluetooth on this device, then reload the page.</Callout>;
  return (
    <Callout tone="warn" title="This browser can't reach robots over Bluetooth">
      Use Chrome or Edge on a computer or an Android phone. Safari, every browser on iPhone and iPad, and Firefox don't support Bluetooth from a web page.
    </Callout>
  );
}

const PURPOSE_WORD = (p: string) =>
  p === "storage:log" ? "Log upload" : p.startsWith("storage:frame:") ? `Photo #${p.split(":")[2]} upload` : p === "anchor" ? "Anchor" : p === "arkiv" ? "Arkiv labels" : p;

/** The three public records a run ends up in, from the relay's per-transaction steps. */
function relaySteps(c: { state: string; relay?: RelayStatus | null }): Step[] {
  const steps = c.relay?.steps ?? [];
  const groups: [string, "storage" | "anchor" | "arkiv"][] = [["Stored copy", "storage"], ["Fingerprint recorded", "anchor"], ["Search labels", "arkiv"]];
  return groups.map(([label, g]) => {
    const mine = steps.filter((s) => stepGroup(s.purpose) === g);
    const done = mine.filter((s) => stepDone(s.status)).length;
    const state: Step["state"] = mine.some((s) => stepFailed(s.status)) ? "failed"
      : mine.length && done === mine.length ? "done"
        : mine.some((s) => s.txHash) || (c.state === "sending" && mine.length) ? "active" : "todo";
    return { label, state, note: mine.length > 1 ? `${done} of ${mine.length}` : undefined };
  });
}

function TxChips({ steps, explorer }: { steps: RelayStep[]; explorer?: string }) {
  const withTx = steps.filter((s) => s.txHash);
  if (!withTx.length) return null;
  return (
    <TechDetails label="Transactions" boxless>
    <div className="chips">
      {withTx.map((s) => {
        const base = stepGroup(s.purpose) === "arkiv" ? ARKIV_EXPLORER : explorer;
        return <Chip key={s.purpose} label={PURPOSE_WORD(s.purpose)} value={s.txHash} href={base ? `${base}/tx/${s.txHash}` : null} tone={stepFailed(s.status) ? "bad" : undefined} />;
      })}
    </div>
    </TechDetails>
  );
}

const STATE_WORD: Record<string, { tone: Tone; word: string }> = {
  received: { tone: "info", word: "Received" },
  submitting: { tone: "info", word: "Delivering" },
  sending: { tone: "info", word: "Delivering" },
  done: { tone: "ok", word: "Delivered" },
  failed: { tone: "bad", word: "Failed" },
  stale: { tone: "warn", word: "Needs re-signing" },
};
const stateLabel = (s: string) => STATE_WORD[s] ?? { tone: "neutral" as Tone, word: s };

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const f = () => setOn(navigator.onLine);
    addEventListener("online", f);
    addEventListener("offline", f);
    return () => {
      removeEventListener("online", f);
      removeEventListener("offline", f);
    };
  }, []);
  return on;
}

function useCarried() {
  const [items, setItems] = useState<Carried[] | null>(null);
  useEffect(() => {
    const load = () => listCarried().then(setItems).catch(() => setItems([]));
    load();
    changes.addEventListener("change", load);
    return () => changes.removeEventListener("change", load);
  }, []);
  return items;
}

function useRelayList() {
  const [list, setList] = useState<RelayStatus[] | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () => relay.list().then((l) => { if (!stop) { setList(l); setDown(false); } }).catch(() => { if (!stop) setDown(true); });
    load();
    const t = setInterval(load, 5000);
    changes.addEventListener("change", load);
    return () => {
      stop = true;
      clearInterval(t);
      changes.removeEventListener("change", load);
    };
  }, []);
  return { list, down };
}

/** Announcements the robot heard from any robot, passed hand to hand, each checked here against its signature. */
function IncidentsNearby({ heard, self }: { heard: HeardPing[]; self?: string }) {
  const shown = heard.filter((h) => !h.ok || h.p.severity > 0 || h.p.outcome !== "DONE");
  const refused = heard.filter((h) => !h.ok).length;
  return (
    <Card title="Incidents nearby" sub="Short signed announcements robots pass to each other, so news of an incident spreads before its full record arrives.">
      {shown.length === 0 ? <Empty title="No incidents announced">This robot hasn't heard of any incident from robots around it.</Empty> : (
        <ul className="list">
          {shown.map((h) => (
            <li key={`${h.p.device}|${h.p.episodeId}`} className="list-row">
              <div>
                <span className="row">
                  <code className="mono" title={h.p.episodeId}>Run {shortRun(h.p.episodeId ?? "")}</code>
                  <Outcome outcome={h.p.outcome} incident={h.p.severity > 0} />
                  <Severity value={h.p.severity} incident={h.p.severity > 0} />
                </span>
                <span className="small muted">{self && h.p.device?.toLowerCase() === self.toLowerCase() ? "this robot" : `robot ${short(h.p.device)}`} · {ago(h.p.ts)}</span>
              </div>
              <div className="list-side">
                {h.ok ? <Badge tone="ok" title="The signature matches the robot it names">✓ Signed by that robot</Badge>
                  : <Badge tone="bad" title="The signature does not match the robot it names, so it is ignored">✕ Forged · ignored</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {refused > 0 && <p className="small muted">{refused} {refused === 1 ? "announcement doesn't" : "announcements don't"} match the robot named in it and {refused === 1 ? "is" : "are"} ignored.</p>}
    </Card>
  );
}

export function Courier() {
  const cfg = useConfig();
  const online = useOnline();
  const carried = useCarried();
  const relayList = useRelayList();
  const [support, setSupport] = useState<Support | null>(null);
  const [link, setLink] = useState<RobotLink | null>(null);
  const [info, setInfo] = useState<RobotInfo | null>(null);
  const [ping, setPing] = useState<{ p: Ping; ok: boolean } | null>(null);
  const [serve, setServe] = useState<ServeEntry[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [heard, setHeard] = useState<HeardPing[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [err, setErr] = useState<{ kind: CourierError["kind"]; detail?: string } | null>(null);
  const [lost, setLost] = useState(false);
  const [progress, setProgress] = useState<Record<string, { got: number; total: number }>>({});
  const [results, setResults] = useState<Record<string, BundleCheck | { error: string }>>({});
  const linkRef = useRef<RobotLink | null>(null);

  useEffect(() => {
    startCarrier();
    bluetoothSupport().then(setSupport);
    return () => linkRef.current?.disconnect();
  }, []);

  const showPing = async (p: Ping | null) => setPing(p ? { p, ok: await checkPing(p) } : null);

  const find = async () => {
    setFinding(true);
    setErr(null);
    setLost(false);
    try {
      linkRef.current?.disconnect();
      const l = await findRobot();
      linkRef.current = l;
      l.onDisconnect(() => setLost(true));
      l.onPing((p) => void showPing(p));
      const i = await l.info();
      const p = await l.ping();
      // one Bluetooth request at a time: listing, then receipts, then the pings it heard
      const list = await listServable(l, i);
      const rec = await readReceipts(l);
      const hp = await checkPings(await l.pings());
      setLink(l);
      setInfo(i);
      setServe(list);
      setReceipts(rec);
      setHeard(hp);
      await showPing(p);
    } catch (e: any) {
      setErr({ kind: e instanceof CourierError ? e.kind : "protocol", detail: e?.message });
    } finally {
      setFinding(false);
    }
  };

  const collectOne = async (bundleId: string) => {
    const p = serve.find((x) => x.bundleId === bundleId);
    if (!link || !p) return;
    setResults((r) => {
      const { [bundleId]: _, ...rest } = r;
      return rest;
    });
    try {
      const check = await collect(link, p, (got, total) => setProgress((s) => ({ ...s, [bundleId]: { got, total } })));
      setResults((r) => ({ ...r, [bundleId]: check }));
      if (link.connected()) setLost(false);
    } catch (e: any) {
      const k = e instanceof CourierError ? e.kind : "protocol";
      setResults((r) => ({ ...r, [bundleId]: { error: k === "out-of-range" ? "Lost the robot part-way. Move closer and press Collect again: it resumes where it stopped." : FIND_ERROR[k].title } }));
    } finally {
      setProgress((s) => {
        const { [bundleId]: _, ...rest } = s;
        return rest;
      });
    }
  };

  const collectAll = async () => {
    for (const p of collectable) await collectOne(p.bundleId);
  };

  const carriedIds = new Set((carried ?? []).map((c) => c.bundleId));
  const deliveredIds = new Set(receipts.map((r) => r.bundleId.toLowerCase()));
  const collectable = serve.filter((p) => !carriedIds.has(p.bundleId) && !deliveredIds.has(p.bundleId.toLowerCase()));
  const ownCount = serve.filter((p) => p.own).length;
  const carrying = (carried ?? []).filter((c) => c.state === "carrying" || c.state === "sending");
  const settled = (carried ?? []).filter((c) => !(c.state === "carrying" || c.state === "sending"));
  const btOk = support?.ok === true;
  const failedFind = err ? FIND_ERROR[err.kind] : null;

  return (
    <div className="stack courier">
      <div className="courier-status">
        <DotLabel tone={online ? "ok" : "warn"}>{online ? "This device is online" : "This device is offline"}</DotLabel>
        {(FAKE_ROBOT || FAKE_RELAY) && <span className="small muted">Practice robot</span>}
      </div>

      {support && !support.ok && <Unsupported why={support.why} />}

      <div className="grid-2">
        <div className="stack">
          <Card
            title="Nearby robot"
            sub={link ? <>Connected to <b>{link.name}</b> over Bluetooth</> : "Robots without internet keep their records and offer them over Bluetooth."}
            actions={btOk && <button type="button" className={`btn ${link ? "" : "primary"}`} onClick={find} disabled={finding}>{finding ? <Spinner label="Looking" /> : <Icon name="robot" size={14} />} {link ? "Find another" : "Find a robot nearby"}</button>}
          >
            {failedFind && <Callout tone={failedFind.tone} title={failedFind.title}>{failedFind.body}</Callout>}
            {lost && link && <Callout tone="warn" title="Lost the robot">It may be out of range. Move closer and press Collect: downloads resume where they stopped.</Callout>}
            {!link && !failedFind && (
              <Empty title={btOk ? "No robot connected" : support ? "Bluetooth isn't available here" : "Checking Bluetooth…"}>
                {btOk ? "Stand within a few metres of the robot and press Find a robot nearby. Your browser shows the robots it can see; pick the one named Pearl-…" : "Records already collected on this device are still delivered from here."}
              </Empty>
            )}
            {link && info && (
              <div className="stack">
                <div className="chips">
                  <Chip label="Robot" value={info.device} />
                  {info.deviceId && <span className="small muted">{info.deviceId}</span>}
                </div>
                {ping && (
                  <div className="list-row">
                    <div>
                      <span className="small muted">Latest run, as the robot announces it</span>
                      <span className="row">
                        <code className="mono" title={ping.p.episodeId}>{ping.p.episodeId}</code>
                        <Outcome outcome={ping.p.outcome} incident={ping.p.severity > 0} />
                        <Severity value={ping.p.severity} incident={ping.p.severity > 0} />
                      </span>
                      <span className="small muted">{ago(ping.p.ts)}</span>
                    </div>
                    <div className="list-side">
                      {ping.ok ? <Badge tone="ok" title="The signature on this message matches the robot's key">✓ Signed by this robot</Badge>
                        : <Badge tone="bad" title="The signature does not match the robot it names">✕ Signature doesn't match</Badge>}
                    </div>
                  </div>
                )}
                <div className="card-head">
                  <div>
                    <h3 className="h4">Records waiting to be delivered</h3>
                    <p className="card-sub">
                      {serve.length === 0 ? "None: everything on this robot has been delivered."
                        : `${ownCount} of its own${serve.length > ownCount ? `, ${serve.length - ownCount} carried for other robots` : ""}`}
                      {receipts.length > 0 && ` · knows of ${receipts.length} already delivered`}
                    </p>
                  </div>
                  {collectable.length > 1 && <button type="button" className="btn" onClick={collectAll} disabled={Object.keys(progress).length > 0}>Collect all</button>}
                </div>
                {serve.length > 0 && (
                  <ul className="list">
                    {serve.map((p) => {
                      const pr = progress[p.bundleId];
                      const res = results[p.bundleId];
                      const have = carriedIds.has(p.bundleId);
                      const gone = deliveredIds.has(p.bundleId.toLowerCase());
                      return (
                        <li key={p.bundleId} className="list-row">
                          <div style={{ flex: 1 }}>
                            <span className="row">
                              <code className="mono" title={p.episodeId}>Run {shortRun(p.episodeId)}</code>
                              <Outcome outcome={p.outcome} incident={p.severity > 0} />
                              <Severity value={p.severity} incident={p.severity > 0} />
                            </span>
                            <span className="small muted">{kb(p.size)}{p.own ? "" : ` · carried for robot ${short(p.origin)}, ${p.hops} ${p.hops === 1 ? "hop" : "hops"} so far`}</span>
                            {pr && (
                              <div className="meter" role="progressbar" aria-label={`Collecting run ${shortRun(p.episodeId)}`} aria-valuemin={0} aria-valuemax={pr.total} aria-valuenow={pr.got}>
                                <div style={{ width: `${Math.min(100, (pr.got / Math.max(1, pr.total)) * 100)}%` }} />
                              </div>
                            )}
                            {res && "error" in res && <span className="small warn-text">{res.error}</span>}
                            {res && "checks" in res && !res.ok && <span className="small warn-text">Not carried: {res.checks.filter((c) => !c.ok).map((c) => `${c.name.toLowerCase()} (${c.detail})`).join("; ")}</span>}
                          </div>
                          <div className="list-side">
                            {pr ? <span className="small muted tabular">{Math.round((pr.got / Math.max(1, pr.total)) * 100)}%</span>
                              : have ? <Badge tone="ok"><Icon name="check" size={12} /> Collected</Badge>
                                : gone ? <Badge title="Another device already delivered it">Already delivered</Badge>
                                : <button type="button" className="btn" onClick={() => collectOne(p.bundleId)}><Icon name="download" size={14} /> Collect</button>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {Object.values(results).some((r) => "checks" in r && r.ok) && (
                  <p className="small muted"><Icon name="shield" size={12} /> Checked in this browser: signed by the robot, every transaction pre-signed by the robot's own key, every file complete.</p>
                )}
              </div>
            )}
          </Card>
          {link && heard && <IncidentsNearby heard={heard} self={info?.device} />}
        </div>

        <div className="stack">
          <Card title="Carrying" sub="Kept on this device until the relay confirms them. Closing the page is fine: they send next time it opens online.">
            {carried === null ? <p className="muted"><Spinner /> Loading…</p>
              : carrying.length === 0 ? <Empty title="Nothing to carry">Records you collect from a robot wait here until they are delivered.</Empty>
                : (
                  <ul className="list">
                    {carrying.map((c) => (
                      <li key={c.bundleId} className="list-row">
                        <div>
                          <span className="row">
                            <code className="mono" title={c.episodeId}>Run {shortRun(c.episodeId)}</code>
                            <Outcome outcome={c.outcome} incident={c.severity > 0} />
                          </span>
                          <span className="small muted">{kb(c.size)} · from {c.from} · collected {ago(c.collectedAt)}</span>
                          {c.state === "sending" && <Stepper steps={relaySteps(c)} />}
                        </div>
                        <div className="list-side">
                          {c.state === "sending" ? <DotLabel tone="info">Delivering</DotLabel>
                            : c.note === "offline" ? <DotLabel tone="warn" title="The relay could not be reached">Relay unreachable · kept here, will send when online</DotLabel>
                              : <DotLabel tone="neutral">Waiting to send</DotLabel>}
                          {c.state === "carrying" && <button type="button" className="btn small-btn" onClick={() => void deliver(c.bundleId)}>Send now</button>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
          </Card>

          <Card title="Delivered" sub="For each record: its locked copy stored, its fingerprint recorded publicly, its search labels added.">
            {settled.length === 0 ? <Empty title="Nothing delivered yet">Each delivered record shows its transactions here, so you can follow them on the explorer.</Empty> : (
              <ul className="list">
                {settled.map((c) => {
                  const st = stateLabel(c.state);
                  return (
                    <li key={c.bundleId} className="list-row">
                      <div>
                        <span className="row">
                          <code className="mono" title={c.episodeId}>Run {shortRun(c.episodeId)}</code>
                          <Outcome outcome={c.outcome} incident={c.severity > 0} />
                          <DotLabel tone={st.tone}>{st.word}</DotLabel>
                        </span>
                        <Stepper steps={relaySteps(c)} />
                        {c.state === "stale" && <span className="small warn-text">The robot's wallet was used for something else in the meantime. The robot will re-sign this record next time it is online.</span>}
                        {c.state === "failed" && c.note && <span className="small warn-text">The relay refused it: {c.note}</span>}
                        <TxChips steps={c.relay?.steps ?? []} explorer={cfg.explorer} />
                      </div>
                      <div className="list-side">
                        <button type="button" className="btn ghost small-btn" onClick={() => void forget(c.bundleId)} title="Remove from this device's list">Clear</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card title="Arrived at this relay" sub="Records the laptop relay received, from couriers like this page and from robots on its Wi-Fi.">
        {relayList.down ? (
          <Empty title="The relay isn't reachable from here">Records you collect are kept on this device and sent when it is.</Empty>
        ) : relayList.list === null ? <p className="muted"><Spinner /> Loading…</p>
          : relayList.list.length === 0 ? <Empty title="Nothing received yet">When a robot without internet hands over a record, it shows here.</Empty>
            : (
              <ul className="list">
                {relayList.list.map((r) => {
                  const st = stateLabel(r.state);
                  const steps = r.steps ?? [];
                  return (
                    <li key={r.bundleId} className="list-row">
                      <div>
                        <span className="row">
                          <code className="mono" title={r.episodeId}>{r.episodeId ? `Run ${shortRun(r.episodeId)}` : short(r.bundleId)}</code>
                          <DotLabel tone={st.tone}>{st.word}</DotLabel>
                          {r.device && <span className="small muted">robot {short(r.device)}</span>}
                        </span>
                        <Stepper steps={relaySteps({ state: r.state === "submitting" ? "sending" : r.state, relay: r })} />
                        <TxChips steps={steps} explorer={cfg.explorer} />
                      </div>
                      <div className="list-side"><span className="small muted">{ago(r.updatedAt)}</span></div>
                    </li>
                  );
                })}
              </ul>
            )}
      </Card>
    </div>
  );
}
