import { useEffect, useState } from "react";
import { useLive } from "./api";
import { Claims } from "./panels/Claims";
import { Account, useAccount } from "./panels/Account";
import { Decisions } from "./panels/Decisions";
import { Episodes } from "./panels/Episodes";
import { Proof } from "./panels/Proof";
import { Live } from "./panels/Live";
import { Replay } from "./panels/Replay";
import { Verify } from "./panels/Verify";
import "./styles.css";

export function App() {
  const { tel, status, records, connected, tick, cut0g, state } = useLive();
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (status?.episodeId && ["DONE", "ABORTED", "FAILSAFE_STOPPED", "TRIPPED"].includes(status.phase)) setSelected(status.episodeId);
  }, [status?.phase, status?.episodeId]);
  const mods = state?.modules ?? {};
  const { account, refresh } = useAccount(tick);
  return (
    <div className="app">
      <header className="top">
        <h1>Pearl</h1>
        <span className="muted">0G decides · the arm keeps people safe · every decision is provable</span>
        <span className={`dot ${connected ? "on" : "off"}`}>{connected ? "live" : "offline"}</span>
        <span className="mods">
          {Object.entries(mods).map(([k, v]) => <span key={k} className={`badge mod-${v}`}>{k} {v}</span>)}
        </span>
      </header>
      <main className="grid">
        <Live tel={tel} status={status} cut0g={cut0g} deviceKind={state?.deviceKind} cameraKind={state?.cameraKind} modules={state?.modules} />
        <Decisions records={records} />
        <Episodes tick={tick} selected={selected} onSelect={setSelected} />
        <Replay episodeId={selected} />
        <Verify episodeId={selected} tick={tick} />
        <Proof episodeId={selected} tick={tick} />
        <Account account={account} refresh={refresh} />
        <Claims tick={tick} account={account} />
      </main>
    </div>
  );
}
