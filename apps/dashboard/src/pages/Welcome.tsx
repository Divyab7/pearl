import { href } from "../router";
import { Icon } from "../components/ui";

const DOORS = [
  { to: href("robot"), icon: "robot", title: "My robot", body: "Operate the arm at its site. Owners sign in with World ID to unlock their robot's runs and claim after incidents." },
  { to: href("insurer"), icon: "wallet", title: "Insurer", body: "Review claimed incidents and approve or deny them. Sign in with the insurance company's wallet." },
  { to: href("verify"), icon: "shield", title: "Verify", body: "Check that any run is untouched. Public, no sign-in. Its contents stay locked." },
];

export function Welcome() {
  return (
    <div className="page welcome">
      <div className="hero">
        <h1>A flight recorder for robots.</h1>
        <p className="lead">The robot decides with an AI model on 0G, keeps people safe, and signs and locks its own record. Anyone can check the record is untouched. Only its owner can read it.</p>
      </div>
      <nav className="doors" aria-label="Choose where to go">
        {DOORS.map((d) => (
          <a key={d.title} className="door" href={d.to}>
            <Icon name={d.icon} size={22} />
            <h2>{d.title}</h2>
            <p>{d.body}</p>
            <span className="door-go">Open <Icon name="arrow" size={14} /></span>
          </a>
        ))}
      </nav>
      <ol className="flow" aria-label="How it works">
        <li><b>1 · Decide</b><span>At every checkpoint the robot asks an AI model on 0G what to do, and its safety rules check the answer.</span></li>
        <li><b>2 · Sign and lock</b><span>When a run ends, the robot signs its log, locks it for its owner and records the fingerprint on 0G Chain.</span></li>
        <li><b>3 · Anyone verifies</b><span>Anyone can confirm the record is untouched. Only the owner, and the insurer for a claimed incident, can read it.</span></li>
      </ol>
      <ul className="trust">
        <li><Icon name="lock" size={14} /> Runs locked on the robot before upload</li>
        <li><Icon name="lock" size={14} /> Fingerprints recorded on 0G Chain</li>
        <li><Icon name="lock" size={14} /> Locked files kept on 0G Storage</li>
        <li><Icon name="eye" size={14} /> Only search labels public, on Arkiv</li>
      </ul>
    </div>
  );
}
