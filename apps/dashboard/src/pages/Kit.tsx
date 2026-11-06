// #/kit — living reference of the building blocks (not in the nav). Page agents: copy patterns from here.
import { useState } from "react";
import { EmptyState, ErrorState, InfoTip, PageHeader, RoleCard, RunRow, Section, Skeleton, Stat, StatusPill, StepStrip, TechDetails } from "../components/blocks";
import { Callout, Chip, Dl, Verdict } from "../components/ui";
import { to } from "../router";
import { HOW_IT_WORKS, OUTCOME_TONE, TIP, outcomeWord } from "../lib/words";

export function Kit() {
  const [n, setN] = useState(12);
  return (
    <div className="page">
      <PageHeader display title="Design kit" description="Every building block in both themes. Not linked from the app." actions={<button type="button" className="btn primary" onClick={() => setN(n + 1)}>One primary action</button>} />

      <Section title="Status" info={TIP.og} description="StatusPill tones: ok, warn, bad, info, neutral.">
        <div className="row">
          <StatusPill tone="ok" pulse sub="mujoco-arm-01">Online</StatusPill>
          <StatusPill tone="warn">Needs attention</StatusPill>
          <StatusPill tone="bad">Offline</StatusPill>
          <StatusPill tone="info">In review</StatusPill>
          <StatusPill>Idle</StatusPill>
          <StatusPill tone="warn" size="sm">Claimable</StatusPill>
        </div>
      </Section>

      <Section title="Verdict">
        <Verdict kind="ok" />
        <div className="two-up">
          <Verdict kind="incomplete" compact title="Original" />
          <Verdict kind="bad" compact title="Edited copy" />
        </div>
        <Verdict kind={null} pending />
      </Section>

      <Section title="How it works" description="StepStrip with HOW_IT_WORKS.">
        <StepStrip steps={HOW_IT_WORKS} active={1} />
      </Section>

      <Section title="Choose a role">
        <div className="grid-3">
          <RoleCard icon="robot" title="I own a robot" body="Watch it live and read its runs." href={to.robot()} primary />
          <RoleCard icon="wallet" title="I'm an insurer" body="Review claims and pay from the pool." href={to.insurance("insurer")} />
          <RoleCard icon="shield" title="Check a record" body="Anyone can check a run is untouched." href={to.proof()} />
        </div>
      </Section>

      <Section title="Latest runs" boxed actions={<a className="btn ghost" href={to.runs()}>See all</a>}>
        <ul className="rrows">
          <li><RunRow time="17:37" outcome={outcomeWord("DONE")} tone={OUTCOME_TONE.DONE} verdict="ok" href={to.run("ep_demo1")} /></li>
          <li><RunRow time="12:07" outcome={outcomeWord("TRIPPED")} tone={OUTCOME_TONE.TRIPPED} verdict="ok" claimable note="Hand entered the safety zone" href={to.run("ep_demo2")} /></li>
          <li><RunRow time="11:31" outcome={outcomeWord("FAILSAFE")} tone={OUTCOME_TONE.FAILSAFE} verdict="incomplete" href={to.run("ep_demo3")} /></li>
        </ul>
        <TechDetails>
          <Chip label="Fingerprint" value="0x8f3a9c1e2b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a" />
          <Dl rows={[["Run id", <code className="mono">ep_20261106120717_dbea</code>], ["Record on 0G Chain", "block 4 812 331"]]} />
        </TechDetails>
      </Section>

      <Section title="Counters">
        <div className="stats">
          <Stat value={n} label="Runs locked" info={TIP.locked} />
          <Stat value="100%" label="Untouched" tone="ok" />
          <Stat value={2} label="Safety trips" tone="bad" hint="today" />
          <Stat value="0.040 0G" label="Paid out" />
        </div>
      </Section>

      <Section title="States">
        <div className="grid-3">
          <EmptyState title="No runs yet" action={<a className="btn primary" href={to.robot()}>Start a run</a>}>Runs appear here when the robot finishes a task.</EmptyState>
          <ErrorState title="Couldn't reach the robot" onRetry={() => {}}>It may be offline. Its records are safe on the robot.</ErrorState>
          <div className="stack"><Skeleton height={28} width="50%" /><Skeleton lines={3} /></div>
        </div>
        <Callout tone="info" title="Callout"><p>Plain explanation with a tip <InfoTip text={TIP.worldId} /></p></Callout>
      </Section>
    </div>
  );
}
