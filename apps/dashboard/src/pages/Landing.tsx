// Public landing page (#/): sells Pearl to insurers first, robot owners second, anyone verifying third.
// Own top bar + footer (no app sidebar). Sections: hero → seal-to-payout story (scroll-driven) → for insurers →
// for owners & fleets → live proof (real /api/stats + newest run) → built on → footer.
// Motion: transform/opacity only, ≤400 ms ease-out, staggered reveals; prefers-reduced-motion → static frames.
// `?reveal` in the URL shows every reveal-on-scroll element at once (screenshots, audits).
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ago, get } from "../api";
import { Icon } from "../components/ui";
// the 3D arm (three.js) loads only when its section comes near, so the landing page ships light
const ArmView3D = lazy(() => import("../components/ArmView3D").then((m) => ({ default: m.ArmView3D })));
import { BUILT_ON } from "../lib/words";
import arm from "../../../../config/arm.json";
import planImg from "../example/plan.jpg";
import incidentImg from "../example/incident.jpg";
import "./landing.css";

/** Links the landing hands to the app. `?demo=` is read by the app shell (APP agent) to enter a demo workspace. */
export const LANDING_LINKS = {
  insurerDemo: "#/app?demo=insurer",
  ownerDemo: "#/app?demo=owner",
  app: "#/app",
  verify: (id?: string | null, tamper = false) => (id ? `#/verify/${encodeURIComponent(id)}${tamper ? "/tamper" : ""}` : "#/verify"),
  offline: "#/app/owner/offline",
  github: "https://github.com/Divyab7/pearl",
};

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealAll = () => typeof location !== "undefined" && /[?&]reveal\b/.test(location.search + location.hash);

function useTheme() {
  const [t, setT] = useState<string>(() => localStorage.getItem("pearl.theme") ?? "light");
  useEffect(() => {
    document.documentElement.dataset.theme = t;
    localStorage.setItem("pearl.theme", t);
  }, [t]);
  return [t, () => setT(t === "dark" ? "light" : "dark")] as const;
}

/** Adds `is-in` to every `.rv` inside the root once it scrolls into view (one observer for the page). */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>(".rv") ?? [])];
    if (revealAll() || reduced() || typeof IntersectionObserver === "undefined") {
      els.forEach((e) => e.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [root]);
}

/** True once the element has come near the viewport (for lazy, heavy things like the 3D arm). */
function useNear<T extends HTMLElement>(margin = "200px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!ref.current || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

/** Counts from 0 to `to` over ~700 ms when `run` turns true (immediately under reduced motion). */
function useCountUp(to: number, run: boolean, ms = 700) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (reduced()) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, run, ms]);
  return v;
}

const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });

// ---------------------------------------------------------------- page

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const [theme, toggle] = useTheme();
  useReveal(root);
  useEffect(() => {
    document.title = "Pearl · Evidence nobody can fake, for robot insurance";
  }, []);
  const latest = useLatestRun();

  return (
    <div className="landing" ref={root}>
      <a className="skip" href="#lp-main" onClick={(e) => { e.preventDefault(); document.getElementById("lp-main")?.focus(); }}>Skip to content</a>
      <header className="lp-bar">
        <div className="lp-wrap lp-bar-in">
          <a className="brand" href="#/" aria-label="Pearl home"><span className="brand-mark" aria-hidden />Pearl</a>
          <nav className="lp-nav" aria-label="Page sections">
            <button type="button" onClick={() => scrollToId("lp-story")}>How it works</button>
            <button type="button" onClick={() => scrollToId("lp-insurers")}>Insurers</button>
            <button type="button" onClick={() => scrollToId("lp-owners")}>Robot owners</button>
          </nav>
          <div className="lp-bar-side">
            <a className="lp-link lp-hide-sm" href={LANDING_LINKS.verify()}>Verify a record</a>
            <a className="btn primary lp-btn-sm" href={LANDING_LINKS.app}>Open the app</a>
            <button type="button" className="btn ghost icon-only lp-theme" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`${theme === "dark" ? "Light" : "Dark"} theme`}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            </button>
          </div>
        </div>
      </header>

      <main id="lp-main" tabIndex={-1}>
        <Hero />
        <Story />
        <Insurers />
        <Owners />
        <LiveProof latestId={latest} />
        <BuiltOn />
        <FinalCta />
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <div className="lp-foot-brand">
            <a className="brand" href="#/" aria-label="Pearl home"><span className="brand-mark" aria-hidden />Pearl</a>
            <p>A tamper-proof black box for robots.</p>
          </div>
          <nav className="lp-foot-links" aria-label="Footer">
            <a href={LANDING_LINKS.app}>Open the app</a>
            <a href={LANDING_LINKS.verify()}>Verify a record</a>
            <a href={LANDING_LINKS.offline}>Works without internet</a>
            <a href={LANDING_LINKS.github} target="_blank" rel="noreferrer">GitHub <Icon name="ext" size={13} /></a>
          </nav>
          <p className="lp-foot-note">Built at ETHGlobal Mumbai, 2026. Photos: Unsplash (see /img/CREDITS.txt). Demo workspaces use clearly labelled sample data.</p>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- hero

function Hero() {
  return (
    <section className="lp-hero" aria-labelledby="lp-hero-h">
      <div className="lp-wrap lp-hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow rv">Evidence for robot insurance</p>
          <h1 id="lp-hero-h" className="lp-display rv" style={{ "--d": 1 } as React.CSSProperties}>Insure robots with evidence nobody can fake.</h1>
          <p className="lp-lead rv" style={{ "--d": 2 } as React.CSSProperties}>
            Pearl is a black box for robots. Every AI decision and camera frame is sealed and signed on the robot, then
            recorded on 0G. When something goes wrong, claims settle on facts, not on whoever tells the better story.
          </p>
          <div className="lp-ctas rv" style={{ "--d": 3 } as React.CSSProperties}>
            <a className="btn primary lg" href={LANDING_LINKS.insurerDemo}>Try the insurer demo <Icon name="arrow" size={16} /></a>
            <a className="btn lg lp-btn-quiet" href={LANDING_LINKS.ownerDemo}>See the owner demo</a>
          </div>
          <p className="lp-hero-sub rv" style={{ "--d": 4 } as React.CSSProperties}>
            <a className="lp-link" href={LANDING_LINKS.verify()}><Icon name="shield" size={15} /> Verify a record</a>
            <span aria-hidden className="lp-hide-sm">·</span>
            <span>No sign-up. Demos use labelled sample data.</span>
          </p>
        </div>
        <div className="lp-hero-visual rv" style={{ "--d": 2 } as React.CSSProperties}>
          <figure className="lp-photo">
            <img
              src="/img/factory-1600.webp"
              srcSet="/img/factory-800.webp 800w, /img/factory-1600.webp 1600w"
              sizes="(max-width: 900px) 100vw, 600px"
              width={1600}
              height={1067}
              alt="Orange industrial robot arms working along an assembly line"
              fetchPriority="high"
              decoding="async"
            />
            <span className="lp-scan" aria-hidden />
          </figure>
          <SealCard />
        </div>
      </div>
    </section>
  );
}

/** The hero's "proof sealing" overlay: a record being fingerprinted, locked and recorded, on a calm loop. */
function SealCard() {
  return (
    <div className="lp-seal" role="img" aria-label="A robot decision being sealed: fingerprinted, signed by the robot and recorded on 0G Chain">
      <div className="lp-seal-head">
        <span className="lp-seal-lock" aria-hidden>
          <svg viewBox="0 0 24 24" width="18" height="18"><path className="lp-shackle" d="M8 11V8a4 4 0 0 1 8 0v3" /><rect x="5.5" y="11" width="13" height="9" rx="2" /></svg>
        </span>
        <div>
          <b>Decision 14 · place cube in bin</b>
          <span>Camera frame + AI reasoning</span>
        </div>
      </div>
      <div className="lp-seal-fp" aria-hidden>
        {"7cd2f3cf6e1d1828413c".split("").map((c, i) => <i key={i} style={{ "--i": i } as React.CSSProperties}>{c}</i>)}
        <i className="lp-ell">…</i>
      </div>
      <ul className="lp-seal-steps" aria-hidden>
        <li style={{ "--i": 0 } as React.CSSProperties}><Icon name="check" size={13} /> Sealed on the robot</li>
        <li style={{ "--i": 1 } as React.CSSProperties}><Icon name="check" size={13} /> Signed by its own key</li>
        <li style={{ "--i": 2 } as React.CSSProperties}><Icon name="check" size={13} /> Recorded on 0G Chain</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- story

const STEPS: { k: string; title: string; body: string }[] = [
  { k: "Act", title: "The robot gets to work", body: "A camera watches the table. At each checkpoint the robot stops and asks what to do next." },
  { k: "Decide", title: "An AI on 0G decides the move", body: "The camera frame goes to an AI model on 0G Compute. It answers with the next move and the reason for it." },
  { k: "Seal", title: "The moment is sealed and signed", body: "Frame and decision are encrypted on the robot and signed with its own key, before anything leaves it." },
  { k: "Record", title: "Recorded where nobody can rewrite it", body: "The sealed record goes to 0G Storage, its fingerprint to 0G Chain, and public search labels to Arkiv. Change one byte later and the fingerprint no longer matches." },
  { k: "Incident", title: "Something goes wrong", body: "A hand enters the work area. The robot stops safely, and that moment is sealed like every other one." },
  { k: "Claim", title: "The owner proves they are human", body: "World ID shows the claim comes from one real, unique person. One person, one claim, and nobody learns who they are." },
  { k: "Review", title: "The insurer reviews locked evidence", body: "Only the insurer of this claim, and the owner, can open the incident. The insurer checks it against the chain and approves." },
  { k: "Pay", title: "The pool pays out", body: "The insurance pool on 0G Chain pays the owner's wallet directly. Every step leaves a public, checkable trace." },
];

function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    // the step crossing the band ~40% down the viewport is the active one
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: 0 },
    );
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);

  return (
    <section className="lp-story" id="lp-story" aria-labelledby="lp-story-h">
      <div className="lp-wrap">
        <header className="lp-sec-head rv">
          <p className="lp-eyebrow">How it works</p>
          <h2 id="lp-story-h" className="lp-h2">From the robot's decision to the payout.</h2>
          <p className="lp-sub">Eight moments, each one sealed, checkable and impossible to quietly change.</p>
        </header>
        <div className="lp-story-grid">
          <div className="lp-stage-col">
            <Stage active={active} />
          </div>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.k} data-i={i} ref={(el) => { refs.current[i] = el; }} className={`lp-step ${i === active ? "on" : ""}`} aria-current={i === active ? "step" : undefined}>
                <span className="lp-step-n">{String(i + 1).padStart(2, "0")} · {s.k}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** The sticky visual of the story: one frame, one panel per step, cross-faded (transform/opacity only). */
function Stage({ active }: { active: number }) {
  const paid = useCountUp(0.05, active === 7, 900);
  const p = (i: number) => `lp-panel ${i === active ? "on" : i < active ? "past" : ""}`;
  return (
    <div className="lp-stage">
      <div className="lp-stage-top" aria-hidden>
        {STEPS.map((s, i) => <span key={s.k} className={i <= active ? "on" : ""} />)}
      </div>
      <p className="sr-only" aria-live="polite">Step {active + 1} of {STEPS.length}: {STEPS[active]!.title}</p>

      {/* 0 act */}
      <div className={p(0)} aria-hidden={active !== 0}>
        <Frame src={planImg} tag="Camera · checkpoint 1" />
        <div className="lp-chip lp-chip-float"><span className="lp-dot ok" /> Moving · reaching slot A2</div>
      </div>

      {/* 1 decide */}
      <div className={p(1)} aria-hidden={active !== 1}>
        <Frame src={planImg} tag="Camera · checkpoint 1" dim />
        <div className="lp-bubble">
          <span className="lp-bubble-k">AI on 0G Compute</span>
          <b>Pick the red cube at A2</b>
          <span>“Red cube clearly visible at slot A2; the path to the bin is clear.”</span>
          <span className="lp-bubble-meta">confidence 0.94 · 1.2 s</span>
        </div>
      </div>

      {/* 2 seal */}
      <div className={p(2)} aria-hidden={active !== 2}>
        <div className="lp-sealbig">
          <div className="lp-sealbig-pkg">
            <span className="lp-mini-frame" style={{ backgroundImage: `url(${planImg})` }} />
            <span className="lp-mini-lines"><i /><i /><i /></span>
          </div>
          <div className="lp-sealbig-lock" aria-hidden>
            <svg viewBox="0 0 24 24" width="40" height="40"><path className="lp-shackle" d="M8 11V8a4 4 0 0 1 8 0v3" /><rect x="5.5" y="11" width="13" height="9" rx="2" /></svg>
          </div>
          <code className="lp-sealbig-fp">fingerprint 7cd2f3cf…ebd82809b</code>
          <span className="lp-chip"><Icon name="key" size={14} /> Signed by robot 0x5d3e…B1E1</span>
        </div>
      </div>

      {/* 3 record */}
      <div className={p(3)} aria-hidden={active !== 3}>
        <div className="lp-net">
          <div className="lp-net-src"><Icon name="lock" size={18} /> Sealed record</div>
          <div className="lp-net-rows">
            <div className="lp-net-row" style={{ "--i": 0 } as React.CSSProperties}><i className="lp-wire" /><div><b>0G Storage</b><span>the locked record itself</span></div></div>
            <div className="lp-net-row" style={{ "--i": 1 } as React.CSSProperties}><i className="lp-wire" /><div><b>0G Chain</b><span>its fingerprint, on a public ledger</span></div></div>
            <div className="lp-net-row" style={{ "--i": 2 } as React.CSSProperties}><i className="lp-wire" /><div><b>Arkiv</b><span>labels: time · outcome · incident</span></div></div>
          </div>
        </div>
      </div>

      {/* 4 incident */}
      <div className={p(4)} aria-hidden={active !== 4}>
        <Frame src={incidentImg} tag="Camera · checkpoint 4" alert />
        <div className="lp-chip lp-chip-float bad"><span className="lp-dot bad" /> Safety trip · severity 2 · sealed</div>
      </div>

      {/* 5 world id */}
      <div className={p(5)} aria-hidden={active !== 5}>
        <div className="lp-human">
          <div className="lp-orb" aria-hidden><span /><span /><span /></div>
          <b>Verified with World ID</b>
          <span>Real, unique person · identity not shared</span>
          <span className="lp-chip ok"><Icon name="check" size={14} /> One person, one claim</span>
        </div>
      </div>

      {/* 6 review */}
      <div className={p(6)} aria-hidden={active !== 6}>
        <div className="lp-review">
          <div className="lp-review-head"><b>Claim · incident on arm-1</b><span className="lp-chip">With the insurer</span></div>
          <ul>
            {["Signed by the robot's key", "Fingerprint matches 0G Chain", "Frames decrypt for this insurer only", "Claimant is a unique human"].map((t, i) => (
              <li key={t} style={{ "--i": i } as React.CSSProperties}><Icon name="check" size={14} /> {t}</li>
            ))}
          </ul>
          <span className="lp-stamp">Approved</span>
        </div>
      </div>

      {/* 7 pay */}
      <div className={p(7)} aria-hidden={active !== 7}>
        <div className="lp-pay">
          <span className="lp-pay-k">Paid from the insurance pool · 0G Chain</span>
          <b className="lp-pay-amt">{paid.toFixed(3)} <small>0G</small></b>
          <span className="lp-chip ok"><Icon name="check" size={14} /> In the owner's wallet</span>
        </div>
      </div>
    </div>
  );
}

function Frame({ src, tag, dim, alert }: { src: string; tag: string; dim?: boolean; alert?: boolean }) {
  return (
    <div className={`lp-frame ${dim ? "dim" : ""} ${alert ? "alert" : ""}`}>
      <img src={src} alt="" width={640} height={480} loading="lazy" decoding="async" />
      <span className="lp-frame-tag"><span className="lp-rec" /> {tag}</span>
      <span className="lp-corners" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------- insurers

const INSURER_POINTS: { icon: string; title: string; body: string }[] = [
  { icon: "shield", title: "Evidence that can't be faked", body: "Every frame and decision is signed on the robot and fingerprinted on 0G Chain. Alter one byte and the check fails, in public." },
  { icon: "user", title: "One person, one claim", body: "World ID proves each claimant is a real, unique human. Duplicate accounts and claim farming stop at the door." },
  { icon: "spark", title: "Settle in minutes, not months", body: "Review verified facts, not competing statements. Approve, and the pool on 0G Chain pays automatically." },
  { icon: "lock", title: "Private by default", body: "Records stay locked. Only the owner, and the insurer of a claimed incident, can open that one incident." },
];

function Insurers() {
  return (
    <section className="lp-sec" id="lp-insurers" aria-labelledby="lp-ins-h">
      <div className="lp-wrap">
        <header className="lp-sec-head rv">
          <p className="lp-eyebrow">For insurers</p>
          <h2 id="lp-ins-h" className="lp-h2">Underwrite robots on facts you can check yourself.</h2>
          <p className="lp-sub">Robots that decide with AI are hard to insure: after an accident, nobody can prove what the machine saw or why it moved. Pearl makes that record trustworthy.</p>
        </header>
        <ul className="lp-cards">
          {INSURER_POINTS.map((b, i) => (
            <li key={b.title} className="lp-card rv" style={{ "--d": i } as React.CSSProperties}>
              <span className="lp-card-ic"><Icon name={b.icon} size={20} /></span>
              <h3>{b.title}</h3>
              <p>{b.body}</p>
            </li>
          ))}
        </ul>
        <div className="lp-sec-cta rv">
          <a className="btn primary lg" href={LANDING_LINKS.insurerDemo}>Try the insurer demo <Icon name="arrow" size={16} /></a>
          <span className="lp-muted">Review a sample claim, check its evidence and approve the payout.</span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- owners

const POSES: number[][] = [arm.home, arm.slots.A2.above, arm.slots.A2.down, [...arm.slots.A2.above.slice(0, 3), arm.gripClosed], [...arm.slots.BIN.above.slice(0, 3), arm.gripClosed], arm.slots.BIN.above, arm.home];

/** A gentle scripted loop through the pick-and-place poses (no live data on the landing). */
function useScriptedJoints(on: boolean) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!on || reduced()) return;
    const t = setInterval(() => setI((x) => (x + 1) % POSES.length), 1600);
    return () => clearInterval(t);
  }, [on]);
  const holding = i >= 3 && i <= 4;
  return { joints: POSES[i]!, scene: { slots: { A1: null, A2: holding || i >= 5 ? null : "red", A3: "blue" }, bin: i >= 5 ? ["red"] : [], holding: holding ? "red" : null } };
}

const OWNER_POINTS: { icon: string; title: string; body: ReactNode }[] = [
  { icon: "doc", title: "Prove what happened", body: "Every run is a sealed, signed story of what the robot saw and decided. Share one incident, keep the rest private." },
  { icon: "wallet", title: "Get insured, get paid", body: "Claim an incident in a few taps. The insurer reviews evidence it can trust, and the pool pays your wallet." },
  { icon: "offline", title: "Works without internet", body: <>No signal on the floor? Nearby phones and robots carry the sealed proof out. They can't read it or change it. <a href={LANDING_LINKS.offline}>See it work</a></> },
];

function Owners() {
  const [ref, near] = useNear<HTMLDivElement>();
  const { joints, scene } = useScriptedJoints(near);
  return (
    <section className="lp-sec lp-owners" id="lp-owners" aria-labelledby="lp-own-h">
      <div className="lp-wrap">
        <div className="lp-owners-grid">
          <div className="lp-arm rv" ref={ref}>
            {near ? <Suspense fallback={<div className="lp-arm-ph" aria-hidden />}><ArmView3D joints={joints} scene={scene} showAngles={false} /></Suspense> : <div className="lp-arm-ph" aria-hidden />}
            <p className="lp-arm-cap"><span className="lp-dot ok" /> The Pearl arm, modelled live · drag to turn</p>
          </div>
          <div className="lp-owners-copy">
            <header className="lp-sec-head left rv">
              <p className="lp-eyebrow">For robot owners &amp; fleets</p>
              <h2 id="lp-own-h" className="lp-h2">A black box your insurer will believe.</h2>
            </header>
            <ul className="lp-points">
              {OWNER_POINTS.map((b, i) => (
                <li key={b.title} className="rv" style={{ "--d": i } as React.CSSProperties}>
                  <span className="lp-card-ic"><Icon name={b.icon} size={18} /></span>
                  <div><h3>{b.title}</h3><p>{b.body}</p></div>
                </li>
              ))}
            </ul>
            <div className="lp-sec-cta rv">
              <a className="btn primary lg" href={LANDING_LINKS.ownerDemo}>See the owner demo <Icon name="arrow" size={16} /></a>
            </div>
          </div>
        </div>
        <div className="lp-photos">
          <figure className="lp-photo-tile rv">
            <img src="/img/warehouse-1400.webp" srcSet="/img/warehouse-700.webp 700w, /img/warehouse-1400.webp 1400w" sizes="(max-width: 900px) 100vw, 700px" width={1400} height={786} alt="An automated warehouse with conveyor lines and storage racks" loading="lazy" decoding="async" />
            <figcaption>Warehouses and fleets</figcaption>
          </figure>
          <figure className="lp-photo-tile rv" style={{ "--d": 1 } as React.CSSProperties}>
            <img src="/img/service-hand-1200.webp" srcSet="/img/service-hand-600.webp 600w, /img/service-hand-1200.webp 1200w" sizes="(max-width: 900px) 100vw, 500px" width={1200} height={864} alt="A white service robot holding out its open hand" loading="lazy" decoding="async" />
            <figcaption>Service robots around people</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- live proof

type Stats = { runs?: number | null; runsCapped?: boolean; incidents?: number | null; claimsPaid?: number | null; paidWei?: string | null; lastRunAt?: number | null };

function useLatestRun() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    get("/api/episodes").then((r) => setId(r?.items?.[0]?.episodeId ?? null)).catch(() => setId(null));
  }, []);
  return id;
}

function LiveProof({ latestId }: { latestId: string | null }) {
  const [s, setS] = useState<Stats | null | undefined>(undefined);
  const [ref, near] = useNear<HTMLElement>("0px");
  useEffect(() => {
    get("/api/stats").then(setS).catch(() => setS(null));
  }, []);
  const paidOg = s?.paidWei && s.paidWei !== "0" ? Number(BigInt(s.paidWei)) / 1e18 : null;
  const tiles: { v: number; label: string; fmt?: (n: number) => string; suffix?: string }[] = [];
  if (s?.runs != null) tiles.push({ v: s.runs, label: "runs recorded", suffix: s.runsCapped ? "+" : "" });
  if (s?.incidents != null) tiles.push({ v: s.incidents, label: "incidents sealed" });
  if (s?.claimsPaid != null) tiles.push({ v: s.claimsPaid, label: "claims paid" });
  if (paidOg != null) tiles.push({ v: paidOg, label: "paid out", fmt: (n) => `${n.toFixed(3)} 0G` });

  return (
    <section className="lp-sec lp-live" aria-labelledby="lp-live-h" ref={ref}>
      <div className="lp-wrap">
        <div className="lp-live-card rv">
          <div className="lp-live-copy">
            <p className="lp-eyebrow"><span className="lp-dot ok pulse" /> Live from the Pearl arm</p>
            <h2 id="lp-live-h" className="lp-h2">Don't trust us. Check a record.</h2>
            <p className="lp-sub">
              These numbers come from public labels on Arkiv and the pool on 0G Chain
              {s?.lastRunAt ? <>, last run {ago(s.lastRunAt)}</> : null}. Anyone can verify any run, no sign-in needed.
            </p>
            <div className="lp-ctas">
              <a className="btn primary lg" href={LANDING_LINKS.verify(latestId)}><Icon name="shield" size={16} /> Verify the latest run</a>
              <a className="btn lg lp-btn-quiet" href={LANDING_LINKS.verify(latestId, !!latestId)} title="Changes one byte of a copy of the record so you can watch the check catch it"><Icon name="alert" size={16} /> Try altering a record</a>
            </div>
          </div>
          {s === undefined ? (
            <div className="lp-stats" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="lp-stat lp-stat-ph" />)}</div>
          ) : tiles.length > 0 ? (
            <dl className="lp-stats">
              {tiles.map((t) => <StatTile key={t.label} {...t} run={near} />)}
            </dl>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StatTile({ v, label, fmt, suffix = "", run }: { v: number; label: string; fmt?: (n: number) => string; suffix?: string; run: boolean }) {
  const n = useCountUp(v, run || revealAll());
  const shown = fmt ? fmt(n) : Math.round(n).toLocaleString();
  return (
    <div className="lp-stat">
      <dt>{label}</dt>
      <dd><span className="sr-only">{fmt ? fmt(v) : v.toLocaleString()}{suffix}</span><span aria-hidden>{shown}{suffix}</span></dd>
    </div>
  );
}

// ---------------------------------------------------------------- built on + final CTA

const SPONSOR_MARK: Record<string, string> = { "0G": "0G", Arkiv: "Ar", "World ID": "ID" };

function BuiltOn() {
  return (
    <section className="lp-sec" aria-labelledby="lp-built-h">
      <div className="lp-wrap">
        <header className="lp-sec-head rv">
          <p className="lp-eyebrow">Under the hood</p>
          <h2 id="lp-built-h" className="lp-h2">Built on 0G · Arkiv · World ID</h2>
        </header>
        <ul className="lp-built">
          {BUILT_ON.map((b, i) => (
            <li key={b.name} className="rv" style={{ "--d": i } as React.CSSProperties}>
              <span className="lp-built-mark" aria-hidden>{SPONSOR_MARK[b.name] ?? b.name.slice(0, 2)}</span>
              <h3>{b.name}</h3>
              <p>{b.role}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="lp-final" aria-labelledby="lp-final-h">
      <div className="lp-wrap lp-final-in rv">
        <h2 id="lp-final-h" className="lp-h2">See a claim go from incident to payout.</h2>
        <p className="lp-sub">Two demo workspaces with labelled sample data. Nothing to install, no account needed.</p>
        <div className="lp-ctas center">
          <a className="btn primary lg" href={LANDING_LINKS.insurerDemo}>Try the insurer demo <Icon name="arrow" size={16} /></a>
          <a className="btn lg lp-btn-quiet" href={LANDING_LINKS.ownerDemo}>See the owner demo</a>
        </div>
      </div>
    </section>
  );
}
