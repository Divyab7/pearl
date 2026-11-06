// The shell: top bar (Pearl · Home · Robot · Proof · Insurance · robot status · theme · account menu), service and
// connection banners, and the route → page switch. Routes and redirects live in router.ts; words in lib/words.ts.
import { useEffect, useRef, useState } from "react";
import { post, short, useLive } from "./api";
import { to, useRouteInfo, type Route } from "./router";
import { Icon } from "./components/ui";
import { EmptyState, PageHeader, StatusPill } from "./components/blocks";
import { useAccount, useInsurerSession } from "./lib/account";
import { PAGE, ROBOT_LINK, robotName } from "./lib/words";
import { Home } from "./pages/Home";
import { Insurance } from "./pages/Insurance";
import { Robot } from "./pages/Robot";
import { Offline } from "./pages/Offline";
import { Proof } from "./pages/Proof";
import { Account } from "./pages/Account";
import { Kit } from "./pages/Kit";
import { Landing } from "./pages/Landing"; // LANDING-TEMP: APP agent wires #/ → Landing at merge
import "./styles.css";

/** Services that can be degraded, in plain words. */
const MOD_LABEL: Record<string, string> = { ogChainAnchor: "Recording on 0G Chain", indexArkiv: "Search labels on Arkiv", robotZerobot: "The zerobot service" };

// ?demo=1 enlarges everything a little for screen recordings
if (new URLSearchParams(location.search).has("demo")) document.documentElement.classList.add("demo");

function useTheme() {
  const [t, setT] = useState<string>(() => localStorage.getItem("pearl.theme") ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("pearl.theme", t);
  }, [t]);
  return [t, () => setT(t === "dark" ? "light" : "dark")] as const;
}

const NAV: { page: Route["page"]; label: string; href: string }[] = [
  { page: "home", label: PAGE.home, href: to.home() },
  { page: "robot", label: PAGE.robot, href: to.robot() },
  { page: "proof", label: PAGE.proof, href: to.proof() },
  { page: "insurance", label: PAGE.insurance, href: to.insurance() },
  { page: "offline", label: PAGE.offline, href: to.offline() },
];

// LANDING-TEMP (landing worktree only): #/ shows the public Landing without the app shell. The APP agent owns the
// real wiring (router + shell) and replaces this at merge.
export function App() {
  const route = useRouteInfo();
  return route.page === "home" ? <Landing /> : <AppShell />;
}

function AppShell() {
  const live = useLive();
  const route = useRouteInfo();
  const [theme, toggle] = useTheme();
  const mods = live.state?.modules ?? {};
  // show services only when one is degraded; "off" means switched off on purpose and is not shown
  const degraded = Object.entries(mods).filter(([, v]) => v === "not_configured" || v === "failed");
  const robotLabel = live.state ? robotName(live.state.deviceKind) : undefined;

  useEffect(() => {
    const name = route.page === "home" || route.page === "notfound" || route.page === "kit" ? "" : PAGE[route.page];
    document.title = name ? `${name} · Pearl` : "Pearl";
  }, [route.page]);
  // new page → start at the top (sections inside a page handle their own scrolling)
  const key = route.page;
  useEffect(() => { scrollTo({ top: 0 }); }, [key]);

  return (
    <div className="shell">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <header className="topbar">
        <a className="brand" href={to.home()} aria-label="Pearl home"><span className="brand-mark" aria-hidden />Pearl</a>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => {
            const on = route.page === n.page;
            return <a key={n.page} href={n.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>{n.label}</a>;
          })}
        </nav>
        <div className="topbar-side">
          <StatusPill
            href={to.robot()}
            tone={live.connected ? "ok" : live.connected === false ? "bad" : "neutral"}
            pulse={!!live.connected}
            sub={robotLabel}
            title={live.state?.deviceId ? `Robot ${live.state.deviceId}${live.state.deviceAddress ? ` · ${live.state.deviceAddress}` : ""}` : "Robot status"}
          >
            {live.connected ? ROBOT_LINK.online : live.connected === false ? ROBOT_LINK.offline : ROBOT_LINK.connecting}
          </StatusPill>
          <button type="button" className="btn ghost icon-only" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} theme`}>
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
          <AccountMenu tick={live.tick} routeKey={JSON.stringify(route)} />
        </div>
      </header>
      {degraded.length > 0 && route.page !== "home" && (
        <div className="modstrip" role="status">
          <Icon name="alert" size={14} /> {degraded.map(([k, v]) => `${MOD_LABEL[k] ?? k} ${v === "failed" ? "is failing" : "is not set up"}`).join(" · ")}. Runs still work; that step is skipped.
        </div>
      )}
      {live.connected === false && route.page === "robot" && (
        <div className="banner" role="alert"><Icon name="alert" size={14} /> Lost the live connection to the robot. What you see is frozen until it reconnects.</div>
      )}
      <main id="main" tabIndex={-1}>
        <Page route={route} live={live} />
      </main>
      {route.page === "home" && (
        <footer className="foot muted small">
          Pearl · locked on the robot, checkable by anyone · <a href={to.offline()}>Works without internet</a>
        </footer>
      )}
    </div>
  );
}

/**
 * Route → page. INTERIM: the new places reuse the existing page components until their page agents replace them.
 * Replace one branch at a time; keep the others working.
 */
function Page({ route, live }: { route: Route; live: ReturnType<typeof useLive> }) {
  switch (route.page) {
    case "home":
      return <Home live={live} />;
    case "robot":
      return <Robot live={live} runId={route.runId} />;
    case "proof":
      return <Proof tick={live.tick} runId={route.runId} tamper={route.tamper} />;
    case "insurance":
      return <Insurance live={live} side={route.side} claimId={route.claimId} />;
    case "offline":
      return <Offline section={route.section} />;
    case "account":
      return <Account live={live} />;
    case "kit":
      return <Kit />;
    default:
      return (
        <div className="page narrow">
          <EmptyState title="This page doesn't exist" icon="search" action={<a className="btn primary" href={to.home()}>Go home</a>}>
            The link may be old or mistyped.
          </EmptyState>
        </div>
      );
  }
}

/** Account menu: "Sign in" or the signed-in identity; opens Account, Insurance review, Works without internet, Sign out. */
function AccountMenu({ tick, routeKey }: { tick: number; routeKey: string }) {
  const { account, refresh } = useAccount(tick);
  const insurer = useInsurerSession(tick);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [routeKey]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("keydown", onKey);
    addEventListener("pointerdown", onDown);
    ref.current?.querySelector<HTMLElement>(".menu-item")?.focus();
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const owner = !!account;
  const asInsurer = !!insurer?.signedIn;
  // the ACTIVE identity, the same words the pages use ("Signed in as the insurer")
  const name = owner && asInsurer ? "Owner + Insurer" : owner ? "Owner" : asInsurer ? "Insurer" : "Sign in";
  const detail = owner && asInsurer ? `Owner: verified human · ${short(account.accountId, 4)} · Insurer: ${short(insurer.address)}`
    : owner ? `Verified human · ${short(account.accountId, 4)}` : asInsurer ? short(insurer.address) : "Owners sign in with World ID, insurers with their wallet.";
  return (
    <div className="menu" ref={ref}>
      <button ref={btn} type="button" className="menu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`Account menu: ${owner || asInsurer ? `signed in as ${name}` : "not signed in"}`}>
        <span className={`avatar ${owner || asInsurer ? "on" : ""}`} aria-hidden><Icon name={owner || asInsurer ? "check" : "user"} size={15} /></span>
        <span className="menu-name">{name}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label="Account">
          <div className="menu-head">
            <b>{owner && asInsurer ? "Signed in as the owner and the insurer" : owner ? "Signed in as the owner" : asInsurer ? "Signed in as the insurer" : "Not signed in"}</b>
            <span>{detail}</span>
          </div>
          <a role="menuitem" className="menu-item" href={to.account()}><Icon name="user" />{owner ? "Account and keys" : "Owner sign-in"}<small>World ID</small></a>
          <a role="menuitem" className="menu-item" href={to.insurance("insurer")}><Icon name="wallet" />{asInsurer ? "Review claims" : "Insurer sign-in"}<small>Wallet</small></a>
          <div className="menu-sep" role="separator" />
          <a role="menuitem" className="menu-item" href={to.offline()}><Icon name="offline" />Works without internet</a>
          {owner && (
            <>
              <div className="menu-sep" role="separator" />
              <button role="menuitem" type="button" className="menu-item" onClick={() => post("/api/auth/logout").then(refresh).finally(() => setOpen(false))}><Icon name="logout" />Sign out</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
