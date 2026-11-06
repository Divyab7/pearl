// The shells, loaded on demand (App.tsx lazy-loads this module, so the landing page ships without it).
// PUBLIC (#/verify): a light top bar (Pearl · Verify a record · Open the app) and a footer.
// APP (#/app/...): a left sidebar per workspace (Owner / Insurer), collapsible on tablets, a top bar + drawer on
// phones; the demo banner when a demo workspace is on. Routes and redirects: router.ts. Demo plumbing: lib/demo.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { post, short, useLive } from "./api";
import { to, type Route, type Workspace } from "./router";
import { Icon, Spinner } from "./components/ui";
import { EmptyState, StatusPill } from "./components/blocks";
import { accountChanged, useAccount, useInsurerSession } from "./lib/account";
import { DemoUnavailable, enterDemo, exitDemo, type DemoRole } from "./lib/demo";
import { ROBOT_LINK, robotName } from "./lib/words";
import { Overview } from "./pages/Overview";
import { InsurerClaimsPage, InsurerPoolPage, InsurerSettingsPage, OwnerClaimsPage } from "./pages/Insurance";
import { Robot } from "./pages/Robot";
import { Offline } from "./pages/Offline";
import { Proof } from "./pages/Proof";
import { Account } from "./pages/Account";
import { Kit } from "./pages/Kit";
import "./shell.css";

type Live = ReturnType<typeof useLive>;

/** Services that can be degraded, in plain words. */
const MOD_LABEL: Record<string, string> = { ogChainAnchor: "Recording on 0G Chain", indexArkiv: "Search labels on Arkiv", robotZerobot: "The zerobot service" };

function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [q]);
  return m;
}

const TITLE: Record<string, string> = {
  "public/verify": "Verify a record", "public/kit": "Kit", "app/chooser": "Choose a workspace",
  "owner/overview": "Overview", "owner/robot": "Robot", "owner/run": "Run", "owner/claims": "Claims", "owner/offline": "Works without internet",
  "owner/settings": "Settings", "insurer/claims": "Claims", "insurer/pool": "Pool", "insurer/settings": "Settings",
};
const routeKey = (r: Route) => ("ws" in r ? `${r.ws}/${r.page}` : `${r.shell}/${r.page}`);

export default function Shells({ route, demoRole }: { route: Route; demoRole: DemoRole | null }) {
  const live = useLive();
  const key = routeKey(route);
  const first = useRef(true);

  useEffect(() => {
    const name = TITLE[key] ?? "Page not found";
    const ws = "ws" in route ? (route.ws === "owner" ? "Owner" : "Insurer") : "";
    document.title = [name, ws, demoRole ? "Demo" : "", "Pearl"].filter(Boolean).join(" · ");
  }, [key, demoRole]);
  // new page → start at the top and move focus to the page's heading (screen readers hear where they are). Sections
  // inside a page (a claim in the queue, an offline section) handle their own scrolling and keep focus.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    scrollTo({ top: 0 });
    const t = setTimeout(() => {
      const h = document.querySelector<HTMLElement>("#main h1");
      const target = h ?? document.getElementById("main");
      if (h && !h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    }, 30);
    return () => clearTimeout(t);
  }, [key]);

  if (route.shell === "public") return <PublicShell route={route} live={live} demoRole={demoRole} />;
  if (route.page === "chooser") return <ChooserShell route={route} live={live} demoRole={demoRole} />;
  return <AppShell route={route} live={live} demoRole={demoRole} />;
}

function SkipLink() {
  return <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>;
}

function Brand({ href = to.landing() }: { href?: string }) {
  return <a className="brand" href={href} aria-label="Pearl home"><span className="brand-mark" aria-hidden />Pearl</a>;
}

/** The unmissable demo banner (every app page + public verify while a demo is on). */
function DemoBanner({ role }: { role: DemoRole }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="demobar" role="region" aria-label="Demo workspace">
      <span className="demobar-text">
        <span className="demobar-tag">Demo</span>
        <span><b>Demo workspace</b> — sample data, not the live robot<span className="demobar-role"> · {role === "owner" ? "owner" : "insurer"} view</span></span>
      </span>
      <button type="button" className="demobar-exit" disabled={busy} onClick={() => { setBusy(true); void exitDemo(); }}>
        {busy ? <Spinner label="Leaving the demo" /> : <Icon name="logout" size={14} />} Exit demo
      </button>
    </div>
  );
}

function ServiceStrips({ live, route }: { live: Live; route: Route }) {
  const mods = live.state?.modules ?? {};
  // show services only when one is degraded; "off" means switched off on purpose and is not shown
  const degraded = Object.entries(mods).filter(([, v]) => v === "not_configured" || v === "failed");
  return (
    <>
      {degraded.length > 0 && (
        <div className="modstrip" role="status">
          <Icon name="alert" size={14} /> {degraded.map(([k, v]) => `${MOD_LABEL[k] ?? k} ${v === "failed" ? "is failing" : "is not set up"}`).join(" · ")}. Runs still work; that step is skipped.
        </div>
      )}
      {live.connected === false && "ws" in route && route.page === "robot" && (
        <div className="banner" role="alert"><Icon name="alert" size={14} /> Lost the live connection to the robot. What you see is frozen until it reconnects.</div>
      )}
    </>
  );
}

// ================================================================ public shell
function PublicTopBar({ current }: { current?: "verify" }) {
  return (
    <header className="topbar pub-top">
      <Brand />
      <nav className="pub-nav" aria-label="Main">
        <a href={to.verify()} className={current === "verify" ? "on" : ""} aria-current={current === "verify" ? "page" : undefined}>Verify a record</a>
      </nav>
      <div className="topbar-side">
        <a className="btn primary" href={to.app()}>Open the app</a>
      </div>
    </header>
  );
}

function PublicShell({ route, live, demoRole }: { route: Route; live: Live; demoRole: DemoRole | null }) {
  return (
    <div className="shell pub">
      <SkipLink />
      <PublicTopBar current={route.page === "verify" ? "verify" : undefined} />
      {demoRole && <DemoBanner role={demoRole} />}
      <main id="main" tabIndex={-1}>
        {route.page === "verify" ? <Proof tick={live.tick} runId={route.runId} tamper={route.tamper} />
          : route.page === "kit" ? <Kit />
            : <NotFound home={to.landing()} />}
      </main>
      <footer className="foot pub-foot small">
        <span><b>Pearl</b> · locked on the robot, checkable by anyone</span>
        <nav aria-label="Footer" className="pub-foot-nav">
          <a href={to.verify()}>Verify a record</a>
          <a href={to.app()}>Open the app</a>
          <a href={to.demo("insurer")}>Insurer demo</a>
          <a href={to.demo("owner")}>Owner demo</a>
        </nav>
      </footer>
    </div>
  );
}

function NotFound({ home }: { home: string }) {
  return (
    <div className="page narrow">
      <EmptyState title="This page doesn't exist" icon="search" action={<a className="btn primary" href={home}>Go back</a>}>
        The link may be old or mistyped.
      </EmptyState>
    </div>
  );
}

// ================================================================ workspace chooser (#/app)
function ChooserShell({ route, live, demoRole }: { route: Extract<Route, { page: "chooser" }>; live: Live; demoRole: DemoRole | null }) {
  return (
    <div className="shell pub">
      <SkipLink />
      <header className="topbar pub-top">
        <Brand />
        <nav className="pub-nav" aria-label="Main"><a href={to.verify()}>Verify a record</a></nav>
      </header>
      {demoRole && <DemoBanner role={demoRole} />}
      <main id="main" tabIndex={-1}>
        <Chooser tick={live.tick} demo={route.demo} demoRole={demoRole} />
      </main>
    </div>
  );
}

function Chooser({ tick, demo, demoRole }: { tick: number; demo?: Workspace; demoRole: DemoRole | null }) {
  const { account } = useAccount(tick);
  const insurer = useInsurerSession(tick);
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [err, setErr] = useState("");
  const start = async (role: DemoRole) => {
    setBusy(role);
    setErr("");
    try {
      await enterDemo(role);
      location.replace(role === "owner" ? to.overview() : to.insurer());
    } catch (e) {
      setErr(e instanceof DemoUnavailable ? "Demo isn't available on this server. You can still sign in, or verify any record." : "The demo didn't start. Try again.");
      setBusy(null);
      history.replaceState(null, "", to.app());
    }
  };
  // #/app?demo=insurer|owner (the landing page's buttons): start that demo straight away
  const started = useRef(false);
  useEffect(() => {
    if (!demo || started.current) return;
    started.current = true;
    if (demoRole === demo) location.replace(demo === "owner" ? to.overview() : to.insurer());
    else void start(demo);
  }, [demo]);

  if (demo && busy) {
    return <div className="page narrow chooser-wait" role="status"><Spinner label="Opening" /> Opening the {demo} demo workspace…</div>;
  }
  const ownerIn = !!account;
  const insurerIn = !!insurer?.signedIn;
  return (
    <div className="page chooser">
      <header className="chooser-head">
        <h1>Choose a workspace</h1>
        <p className="lead">Try either side on sample data, or sign in to the real one.</p>
      </header>
      {err && <div className="chooser-err" role="alert"><Icon name="alert" size={16} /> {err}</div>}
      {demoRole && (
        <div className="chooser-cont">
          <span>You're in the <b>{demoRole} demo</b>.</span>
          <a className="btn primary" href={demoRole === "owner" ? to.overview() : to.insurer()}>Continue the demo <Icon name="arrow" size={14} /></a>
        </div>
      )}
      <section aria-labelledby="ch-demo" className="chooser-group">
        <h2 id="ch-demo" className="chooser-label">Try it on sample data</h2>
        <div className="chooser-grid">
          <WsCard icon="wallet" title="Try the insurer demo" tag="Sample data" busy={busy === "insurer"} disabled={!!busy} onClick={() => start("insurer")}
            body="Review a claimed incident, check its sealed proof, approve it and watch the pool pay." />
          <WsCard icon="robot" title="Try the owner demo" tag="Sample data" busy={busy === "owner"} disabled={!!busy} onClick={() => start("owner")}
            body="See a robot's sealed runs, open an incident and claim the insurance payout." />
        </div>
      </section>
      <section aria-labelledby="ch-real" className="chooser-group">
        <h2 id="ch-real" className="chooser-label">The real workspace</h2>
        <div className="chooser-grid">
          <WsCard icon="user" title={ownerIn ? "Continue as owner" : "Sign in as owner"} tag={ownerIn ? "Signed in" : "World ID"} tone={ownerIn ? "ok" : undefined}
            href={ownerIn ? to.overview() : to.settings()} disabled={!!demoRole}
            body={ownerIn ? `Verified human · ${short(account.accountId, 4)}` : "Watch your robot live, unlock its runs, claim incidents."} />
          <WsCard icon="shield" title={insurerIn ? "Continue as insurer" : "Sign in as insurer"} tag={insurerIn ? "Signed in" : "Wallet"} tone={insurerIn ? "ok" : undefined}
            href={insurerIn ? to.insurer() : to.insurerSettings()} disabled={!!demoRole}
            body={insurerIn ? `Insurer wallet ${short(insurer.address)}` : "Review claims with your insurer wallet and pay from the pool."} />
        </div>
        {demoRole && <p className="muted small">Exit the demo to use the real workspace.</p>}
      </section>
      <p className="chooser-foot muted small">Just checking a record? <a href={to.verify()}>Verify it without signing in</a>.</p>
    </div>
  );
}

function WsCard({ icon, title, body, tag, tone, href, onClick, busy, disabled }: {
  icon: string; title: string; body: string; tag: string; tone?: "ok"; href?: string; onClick?: () => void; busy?: boolean; disabled?: boolean;
}) {
  const inner = (
    <>
      <span className="ws-icon" aria-hidden><Icon name={icon} size={20} /></span>
      <span className="ws-main">
        <span className="ws-title">{title}{busy && <Spinner label="Starting" />}</span>
        <span className="ws-body">{body}</span>
      </span>
      <span className={`ws-tag ${tone ? `tone-${tone}` : ""}`}>{tag}</span>
    </>
  );
  if (href && !disabled) return <a className="wscard" href={href}>{inner}</a>;
  return <button type="button" className="wscard" onClick={onClick} disabled={disabled}>{inner}</button>;
}

// ================================================================ app shell (sidebar)
type NavItem = { id: string; label: string; icon: string; href: string };
const NAV: Record<Workspace, { label: string; items: NavItem[] }[]> = {
  owner: [
    { label: "Workspace", items: [
      { id: "overview", label: "Overview", icon: "spark", href: to.overview() },
      { id: "robot", label: "Robot and runs", icon: "robot", href: to.robot() },
      { id: "claims", label: "Claims", icon: "wallet", href: to.claims() },
    ] },
    { label: "More", items: [
      { id: "offline", label: "Works offline", icon: "offline", href: to.offline() },
      { id: "settings", label: "Settings", icon: "key", href: to.settings() },
    ] },
  ],
  insurer: [
    { label: "Workspace", items: [
      { id: "claims", label: "Claims", icon: "doc", href: to.insurer() },
      { id: "pool", label: "Pool", icon: "db", href: to.pool() },
    ] },
    { label: "More", items: [
      { id: "settings", label: "Settings", icon: "key", href: to.insurerSettings() },
    ] },
  ],
};

function AppShell({ route, live, demoRole }: { route: Exclude<Route, { page: "chooser" }>; live: Live; demoRole: DemoRole | null }) {
  const ws: Workspace = "ws" in route ? route.ws : "owner";
  const mobile = useMedia("(max-width: 760px)");
  const tablet = useMedia("(max-width: 1180px)");
  const [pref, setPref] = useState<string | null>(() => localStorage.getItem("pearl.sidebar"));
  const collapsed = !mobile && (pref ? pref === "collapsed" : tablet);
  const toggleCollapsed = () => {
    const n = collapsed ? "open" : "collapsed";
    localStorage.setItem("pearl.sidebar", n);
    setPref(n);
  };
  const [drawer, setDrawer] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const navKey = JSON.stringify(route);
  useEffect(() => setDrawer(false), [navKey, mobile]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false);
        menuBtn.current?.focus();
      }
      // keep Tab inside the open drawer
      if (e.key === "Tab" && sideRef.current) {
        const f = [...sideRef.current.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")];
        if (!f.length) return;
        const firstEl = f[0]!, lastEl = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };
    addEventListener("keydown", onKey);
    sideRef.current?.querySelector<HTMLElement>("[aria-current='page']")?.focus() ?? sideRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawer]);

  const current = route.page === "run" ? "robot" : route.page;
  const hidden = mobile && !drawer;

  return (
    <div className={`shell app ${collapsed ? "side-collapsed" : ""}`}>
      <SkipLink />
      {mobile && (
        <header className="topbar app-top">
          <button ref={menuBtn} type="button" className="btn ghost icon-only app-menu" aria-label="Open navigation" aria-expanded={drawer} aria-controls="app-side" onClick={() => setDrawer(true)}>
            <MenuIcon />
          </button>
          <Brand href={to.app()} />
          <span className="app-top-ws">{ws === "owner" ? "Owner" : "Insurer"}{demoRole && <span className="ws-demo">Demo data</span>}</span>
        </header>
      )}
      {mobile && drawer && <div className="side-scrim" aria-hidden onClick={() => setDrawer(false)} />}
      {/* a div, not <aside>: role="dialog" isn't allowed on <aside> (axe aria-allowed-role); a complementary landmark otherwise */}
      <div
        id="app-side"
        ref={sideRef}
        className={`side ${drawer ? "open" : ""}`}
        aria-label={`${ws === "owner" ? "Owner" : "Insurer"} workspace`}
        {...(mobile && drawer ? { role: "dialog", "aria-modal": true } : { role: "complementary" })}
        {...(hidden ? { inert: true, "aria-hidden": true } : {})}
      >
        <div className="side-head">
          <Brand href={to.app()} />
          {mobile ? (
            <button type="button" className="btn ghost icon-only" aria-label="Close navigation" onClick={() => { setDrawer(false); menuBtn.current?.focus(); }}><Icon name="x" size={16} /></button>
          ) : (
            <button type="button" className="btn ghost icon-only side-collapse" onClick={toggleCollapsed} aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"} aria-expanded={!collapsed} aria-controls="app-side" title={collapsed ? "Expand" : "Collapse"}>
              <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
        <a className="side-ws" href={to.app()} title="Switch workspace">
          <span className="side-ws-icon" aria-hidden><Icon name={ws === "owner" ? "robot" : "wallet"} size={16} /></span>
          <span className="side-ws-text">
            <span className="side-ws-eyebrow">Workspace</span>
            <span className="side-ws-name">{ws === "owner" ? "Owner" : "Insurer"}</span>
          </span>
          {demoRole && <span className="ws-demo">Demo data</span>}
          <span className="sr-only">. Switch workspace</span>
          <span className="side-ws-caret"><Icon name="down" size={14} /></span>
        </a>
        <nav className="side-nav" aria-label="Pages">
          {NAV[ws].map((g) => (
            <div key={g.label} className="side-group" role="group" aria-labelledby={`sg-${g.label}`}>
              <div className="side-group-label" id={`sg-${g.label}`}>{g.label}</div>
              <ul>
                {g.items.map((n) => {
                  const on = current === n.id;
                  return (
                    <li key={n.id}>
                      <a href={n.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined} title={collapsed ? n.label : undefined}>
                        <Icon name={n.icon} size={17} /><span className="side-label">{n.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <div className="side-group" role="group" aria-labelledby="sg-public">
            <div className="side-group-label" id="sg-public">Public</div>
            <ul>
              <li><a href={to.verify()} title={collapsed ? "Verify a record" : undefined}><Icon name="shield" size={17} /><span className="side-label">Verify a record</span></a></li>
            </ul>
          </div>
        </nav>
        <div className="side-foot">
          {ws === "owner" && <RobotStatus live={live} collapsed={collapsed} />}
          <Identity ws={ws} tick={live.tick} demoRole={demoRole} collapsed={collapsed} />
        </div>
      </div>
      <div className="app-main">
        {demoRole && <DemoBanner role={demoRole} />}
        <ServiceStrips live={live} route={route} />
        <main id="main" tabIndex={-1}>
          <AppPage route={route} live={live} />
        </main>
      </div>
    </div>
  );
}

function MenuIcon() {
  return <svg className="icon" width={18} height={18} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>;
}

function RobotStatus({ live, collapsed }: { live: Live; collapsed: boolean }) {
  const label = live.connected ? ROBOT_LINK.online : live.connected === false ? ROBOT_LINK.offline : ROBOT_LINK.connecting;
  const kind = live.state ? robotName(live.state.deviceKind) : undefined;
  return (
    <a className={`side-robot tone-${live.connected ? "ok" : live.connected === false ? "bad" : "neutral"}`} href={to.robot()}
      title={live.state?.deviceId ? `Robot ${live.state.deviceId}${live.state.deviceAddress ? ` · ${live.state.deviceAddress}` : ""}` : "Robot status"}>
      <i aria-hidden className={live.connected ? "pulse" : ""} />
      <span className={collapsed ? "sr-only" : "side-robot-text"}><b>{label}</b>{kind && <span>{kind}</span>}</span>
    </a>
  );
}

/** Who's signed in for this workspace, with sign-out (or "Exit demo" in a demo). */
function Identity({ ws, tick, demoRole, collapsed }: { ws: Workspace; tick: number; demoRole: DemoRole | null; collapsed: boolean }) {
  const { account, refresh } = useAccount(tick, ws === "owner");
  const insurer = useInsurerSession(tick);
  const signedIn = ws === "owner" ? !!account : !!insurer?.signedIn;
  const name = demoRole ? (ws === "owner" ? "Demo owner" : "Demo insurer") : signedIn ? (ws === "owner" ? "Verified human" : "Insurer wallet") : "Not signed in";
  const detail = ws === "owner" ? (account ? short(account.accountId, 4) : "World ID") : insurer?.signedIn ? short(insurer.address) : "Wallet";
  const signOut = () => (ws === "owner" ? post("/api/auth/logout").then(refresh) : post("/api/insurer/logout").then(accountChanged)).catch(() => {});
  return (
    <div className="side-id">
      <span className={`avatar ${signedIn ? "on" : ""}`} aria-hidden><Icon name={signedIn ? "check" : "user"} size={15} /></span>
      <span className={collapsed ? "sr-only" : "side-id-text"}><b>{name}</b><span>{detail}</span></span>
      {demoRole ? null : signedIn ? (
        <button type="button" className="btn ghost icon-only side-id-act" onClick={signOut} aria-label="Sign out" title="Sign out"><Icon name="logout" size={16} /></button>
      ) : (
        <a className="btn small-btn side-id-act" href={ws === "owner" ? to.settings() : to.insurerSettings()}>{collapsed ? <><Icon name="arrow" size={14} /><span className="sr-only">Sign in</span></> : "Sign in"}</a>
      )}
    </div>
  );
}

function AppPage({ route, live }: { route: Exclude<Route, { page: "chooser" }>; live: Live }): ReactNode {
  if (!("ws" in route)) return <NotFound home={to.app()} />;
  if (route.ws === "owner") {
    switch (route.page) {
      case "overview": return <Overview live={live} />;
      case "robot": return <Robot live={live} />;
      case "run": return <Robot live={live} runId={route.runId} />;
      case "claims": return <OwnerClaimsPage live={live} />;
      case "offline": return <Offline section={route.section} />;
      case "settings": return <Account live={live} />;
    }
  }
  switch (route.page) {
    case "claims": return <InsurerClaimsPage live={live} claimId={route.claimId} />;
    case "pool": return <InsurerPoolPage live={live} />;
    case "settings": return <InsurerSettingsPage live={live} />;
  }
  return <NotFound home={to.app()} />;
}
