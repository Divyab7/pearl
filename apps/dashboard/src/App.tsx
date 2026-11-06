import { useEffect, useState } from "react";
import { useLive } from "./api";
import { href, useRoute } from "./router";
import { Icon } from "./components/ui";
import { Courier } from "./pages/Courier";
import { Insurer } from "./pages/Insurer";
import { MyRobot } from "./pages/MyRobot";
import { Verify } from "./pages/Verify";
import { Welcome } from "./pages/Welcome";
import "./styles.css";

const MOD_LABEL: Record<string, string> = { ogChainAnchor: "0G Chain anchor", indexArkiv: "Arkiv index", robotZerobot: "zerobot" };

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

export function App() {
  const live = useLive();
  const route = useRoute();
  const [theme, toggle] = useTheme();
  const page = route[0] ?? "";
  const nav = [
    { id: "robot", label: "My robot" },
    { id: "insurer", label: "Insurer" },
    { id: "verify", label: "Verify" },
    { id: "courier", label: "Courier" },
  ];
  const mods = live.state?.modules ?? {};
  // show services only when one is degraded; "off" means switched off on purpose and is not shown
  const degraded = Object.entries(mods).filter(([, v]) => v === "not_configured" || v === "failed");
  useEffect(() => {
    const names: Record<string, string> = { robot: "My robot", insurer: "Insurer", verify: "Verify", courier: "Courier" };
    document.title = names[page] ? `${names[page]} · Pearl` : "Pearl";
  }, [page]);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <a className="brand" href={href()} aria-label="Pearl home"><span className="brand-mark" aria-hidden />Pearl</a>
        <nav className="nav" aria-label="Main">
          {nav.map((n) => <a key={n.id} href={href(n.id)} className={page === n.id ? "on" : ""} aria-current={page === n.id ? "page" : undefined}>{n.label}</a>)}
        </nav>
        <div className="topbar-side">
          <span className={`live-dot ${live.connected ? "on" : live.connected === false ? "off" : ""}`} role="status" title={live.state?.deviceAddress ? `Robot ${live.state.deviceAddress}` : undefined}>
            {live.connected ? "Robot online" : live.connected === false ? "Robot offline" : "Connecting"}
            {live.state?.deviceId && <span className="hide-sm"> · {live.state.deviceId}</span>}
          </span>
          <button type="button" className="btn ghost icon-only" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Theme">
            <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
        </div>
      </header>
      {degraded.length > 0 && page !== "" && (
        <div className="modstrip" role="status">
          <Icon name="alert" size={14} /> {degraded.map(([k, v]) => `${MOD_LABEL[k] ?? k} ${v === "failed" ? "is failing" : "is not set up"}`).join(" · ")}. Runs still work; that record is skipped.
        </div>
      )}
      {live.connected === false && page === "robot" && (
        <div className="banner" role="alert"><Icon name="alert" size={14} /> Live stream lost. Values below are frozen until the robot reconnects.</div>
      )}
      <main id="main" tabIndex={-1}>
        {page === "robot" ? <MyRobot live={live} sub={route[1]} runId={route[2]} />
          : page === "insurer" ? <Insurer tick={live.tick} claimId={route[1]} />
            : page === "verify" ? <Verify tick={live.tick} runId={route[1]} />
              : page === "courier" ? <Courier />
              : <Welcome />}
      </main>
      {page === "" && <footer className="foot muted small">Pearl · locked on the robot, checkable by anyone</footer>}
    </div>
  );
}
