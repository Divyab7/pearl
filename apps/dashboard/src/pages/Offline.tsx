// Works without internet (#/offline[/mesh|/courier]): one page. A 3-step explainer, then the robot mesh simulation
// and the Bluetooth carrier. #/offline/mesh and #/offline/courier scroll to their section.
import { useEffect } from "react";
import { to } from "../router";
import { PageHeader, Section, StepStrip } from "../components/blocks";
import { Icon } from "../components/ui";
import { PAGE, TIP } from "../lib/words";
import { Courier } from "./Courier";
import { Mesh } from "./Mesh";
import "./offline.css";

const HOW = [
  { title: "The robot packs a sealed package", body: "When a run ends with no signal, the robot locks and signs the record and keeps it, ready to hand over.", info: TIP.sealedPackage },
  { title: "Anyone nearby carries it", body: "Any phone, laptop or robot within Bluetooth range picks it up, whoever owns it. Each one checks the robot's signature first.", info: TIP.carried },
  { title: "The first one online delivers it", body: "It is delivered exactly once. Nobody along the way can read it or change it: a changed copy is refused." },
] as const;

export function Offline({ section }: { section?: "courier" | "mesh" }) {
  useEffect(() => {
    if (!section) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const go = (behavior: ScrollBehavior) => document.getElementById(`offline-${section}`)?.scrollIntoView({ behavior, block: "start" });
    // after the shell's own scroll-to-top (it runs after this page's effects), and once more after the simulation
    // above has loaded and changed the page's height (only if the reader hasn't scrolled away meanwhile)
    let at = -1;
    const t1 = setTimeout(() => { go(smooth ? "smooth" : "auto"); setTimeout(() => (at = scrollY), smooth ? 600 : 0); }, 60);
    const t2 = setTimeout(() => { if (at < 0 || Math.abs(scrollY - at) < 4) go("auto"); }, 1200);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [section]);

  return (
    <div className="page offline">
      <PageHeader
        title={PAGE.offline}
        description="No signal? The proof still gets out. Nearby phones and robots carry it until one of them is online."
        actions={(
          <nav className="offline-jump" aria-label="On this page">
            <a className="btn" href={to.offline("mesh")}>Robot mesh</a>
            <a className="btn" href={to.offline("courier")}>Carry by phone or laptop</a>
          </nav>
        )}
      />

      <StepStrip steps={HOW} label="How records get out without internet" />

      <Section id="offline-mesh" className="offline-sect" title="Robot mesh"
        description="A simulated day: robots with no internet hand each other's sealed records along until one gets online. Pick what happens, then play or drag the slider.">
        <Mesh />
      </Section>

      <Section id="offline-courier" className="offline-sect" title="Carry a robot's records"
        description="Standing near a robot that has no internet? This browser can collect its sealed records over Bluetooth and deliver them. You carry them; you can't read or change them.">
        <Courier />
      </Section>

      <p className="offline-back small muted"><Icon name="lock" size={13} /> Records stay locked and signed by the robot the whole way. <a href={to.proof()}>Check any record</a></p>
    </div>
  );
}
