// Entry: #/ is the landing page (pages/Landing.tsx, its own top bar and footer); every other route loads the shells
// (Shells.tsx: public verify, workspace chooser, app sidebar) on demand, so the landing page ships without them.
import { lazy, Suspense, useEffect } from "react";
import { WakeNotice } from "./api";
import { useRouteInfo } from "./router";
import { demoActive, useDemo } from "./lib/demo";
import { Landing } from "./pages/Landing";
import "./styles.css";

const Shells = lazy(() => import("./Shells"));

// ?demo=1 (in the page URL, not the hash) enlarges everything a little for screen recordings
if (new URLSearchParams(location.search).has("demo")) document.documentElement.classList.add("demo");

export function App() {
  const route = useRouteInfo();
  const demo = useDemo();
  const landing = route.shell === "public" && route.page === "landing";
  useEffect(() => {
    if (landing) document.title = "Pearl · proof insurers can check";
  }, [landing]);
  if (landing) return <><WakeNotice /><Landing /></>;
  // a demo on/off switch reconnects everything (live stream, every page) to the right server
  const demoOn = demo.role !== null && demoActive();
  return (
    <><WakeNotice /><Suspense fallback={<div className="shell-loading" aria-busy="true" aria-label="Loading" />}>
      <Shells key={demoOn ? `demo-${demo.role}` : "real"} route={route} demoRole={demoOn ? demo.role : null} />
    </Suspense></>
  );
}
