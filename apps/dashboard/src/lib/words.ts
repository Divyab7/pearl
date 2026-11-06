// Plain-language vocabulary for every user-facing string. One source of truth: pages read their words from here so
// the same thing is never called two names. Technical terms (hashes, "anchor", "root hash", "episode") appear ONLY
// inside <TechDetails>; everywhere else use the plain word below.

/** The product in one sentence: the first thing anyone reads. */
export const PRODUCT_LINE = "A tamper-proof black box for robots: an AI on 0G decides every move, every run is sealed on 0G and listed on Arkiv, and World ID makes sure one real owner claims.";
export const PRODUCT_SHORT = "A tamper-proof black box for robots.";
/** Home hero subline: the problem, then how Pearl answers it. */
export const PRODUCT_WHY = "When a robot has an accident, who can prove what happened?";
/** The hero subline: all three sponsors, each with its real role, in two short sentences. */
export const PRODUCT_HOW = "An AI on 0G decides every move, and each run is sealed and stored on 0G. Every run and every claim is a searchable public record on Arkiv, and World ID makes sure one real owner claims, once.";

/** The sponsors Pearl is built on: a short tag, one line, and what each one really does (Built on, sign-in panel). */
export const BUILT_ON = [
  {
    name: "0G", tag: "AI, proof and payouts",
    role: "The robot's AI runs on 0G, and 0G keeps the proof and pays the claims.",
    points: [
      "0G Compute: a TEE-verified AI model looks through the camera and decides every move.",
      "0G Storage: each run, encrypted and signed on the robot, is stored here.",
      "0G Chain: each run's fingerprint is recorded here, and the insurance pool pays approved claims.",
    ],
  },
  {
    name: "Arkiv", tag: "The searchable public record",
    role: "Every run and every claim is a live, public Arkiv record that anyone can query.",
    points: [
      "The robot writes its own Arkiv entry for every run: outcome, incident, severity and time. Never the contents.",
      "Run lists and your claimable incidents are live Arkiv queries, so they work even when the robot is offline.",
      "Each claim is an Arkiv record updated at every step: filed, human-checked, reviewed, paid.",
      "Entries expire by design (runs after 30 days, claims after 90). The permanent proof stays on 0G.",
    ],
  },
  {
    name: "World ID", tag: "One real owner, one claim",
    role: "World ID proves the person claiming is the robot's real owner, and one person, anonymously.",
    points: [
      "Agent Pass: a fresh check that it's really the owner, so someone with their laptop can't claim.",
      "IDKit Proof of Human: one person, one claim per incident. Nobody learns who you are.",
    ],
  },
] as const;

/** One line per sponsor, for compact places (hero strip, sign-in panel, verify). */
export const SPONSOR_LINE = {
  og: "AI decides every move · proof stored and recorded · pool pays",
  arkiv: "every run and claim, searchable by anyone",
  world: "one real owner, one claim",
} as const;

/** Verdict badge words (short, for pills). */
export const VERDICT_BADGE = { ok: "Verified ✓ · not altered", incomplete: "Not verified", bad: "Altered" } as const;

/**
 * A raw error message → something a person can read. Plain sentences from our own server pass through; anything that
 * looks technical (hex, RPC, stack-ish text, codes) is replaced by `fallback`. Show the raw text under TechDetails.
 */
export function plainError(raw: unknown, fallback: string): string {
  const m = String((raw as any)?.message ?? raw ?? "").trim();
  if (!m) return fallback;
  const techy = /0x[0-9a-f]{4,}|\bhex\b|rpc|json|econn|etimedout|enotfound|http \d|status code|revert|nonce|\bgas\b|undefined|null|typeerror|failed to fetch|networkerror|signing key|invalid|abi|exception|stack|[{}[\]<>]|_[a-z]+_|::|\b[a-z]+[A-Z][a-zA-Z]+\b|preview:/i;
  if (techy.test(m) || m.length > 180 || !/^[A-Z]/.test(m)) return fallback;
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
/** True when plainError would hide the raw text (so it's worth showing under TechDetails). */
export const isTechy = (raw: unknown) => plainError(raw, "\u0000") === "\u0000" && !!String((raw as any)?.message ?? raw ?? "").trim();

/** The robot's friendly display name from its kind; the technical id stays in a title / TechDetails. */
export const ROBOT_KIND: Record<string, string> = { mujoco: "Pearl arm · physics simulation", sim: "Pearl arm · simulator" };
export const robotName = (kind?: string | null) => (kind ? ROBOT_KIND[kind] ?? "Pearl arm" : "Pearl arm");

export const PRODUCT_TAIL = "An AI on 0G decides every move, every moment is sealed as proof, and that proof gets out even without internet.";

/** Technical term → the word users see. */
export const WORD = {
  episode: "run",
  episodes: "runs",
  anchor: "record on 0G Chain",
  anchored: "recorded on 0G Chain",
  rootHash: "fingerprint",
  sealed: "locked",
  seal: "lock",
  bundle: "sealed package",
  bundles: "sealed packages",
  relay: "carried",
  relayer: "carrier",
  courier: "carrier",
  mesh: "nearby robots",
  checkpoint: "checkpoint",
  decision: "decision",
  signature: "the robot's signature",
  owner: "owner",
  insurer: "insurer",
  claim: "claim",
  pool: "insurance pool",
  verify: "check",
} as const;

/** Run outcomes (robot log `outcome`) in words. */
export const OUTCOME: Record<string, string> = {
  DONE: "Completed",
  ABORTED: "Stopped early",
  FAILSAFE: "Stopped safely · AI offline",
  TRIPPED: "Safety trip",
};
export const outcomeWord = (outcome?: string | null, incident?: boolean) =>
  outcome === "DONE" && incident ? "Completed after a pause" : OUTCOME[outcome ?? ""] ?? outcome ?? "Unknown";
/** Tone for an outcome, matching StatusPill / DotLabel tones. */
export const OUTCOME_TONE: Record<string, "neutral" | "ok" | "warn" | "bad"> = { DONE: "ok", ABORTED: "warn", FAILSAFE: "warn", TRIPPED: "bad" };

/** Live robot state (telemetry `state`) in words. */
export const ROBOT_STATE: Record<string, string> = {
  IDLE: "Idle",
  MOVING: "Moving",
  WAITING: "Asking the AI on 0G",
  FROZEN_HAND: "Paused: hand in the way",
  SAFE: "In safe pose",
  TRIPPED: "Safety trip",
};

/** Proof verdicts: the big word and its one-line explanation. */
export const VERDICT_WORDS = {
  ok: { word: "Verified", explain: "Matches exactly what the robot signed and recorded. Nobody has altered it." },
  incomplete: { word: "Not verified", explain: "Part of the proof is missing, so we can't confirm it yet. Nothing shows it was changed." },
  bad: { word: "Altered", explain: "This doesn't match what the robot signed. Someone changed it after the fact." },
} as const;

/** Claim status (backend `status`) in words + tone. Same words as components/claims.tsx ClaimBadge. */
export const CLAIM_STATE: Record<string, { word: string; tone: "info" | "ok" | "bad" | "neutral" }> = {
  AGENT_PASS: { word: "Confirm it's you", tone: "info" },
  IDKIT: { word: "Unique-human check", tone: "info" },
  INSURER_REVIEW: { word: "With the insurer", tone: "info" },
  PAYING: { word: "Paying", tone: "info" },
  PAID: { word: "Paid", tone: "ok" },
  DENIED: { word: "Declined", tone: "bad" },
  FAILED: { word: "Not paid", tone: "bad" },
};

/** Robot connection status for the top bar. */
export const ROBOT_LINK = { online: "Online", offline: "Offline", connecting: "Connecting" } as const;

/** The 4-step "how it works" in plain words (StepStrip input). */
export const HOW_IT_WORKS = [
  { title: "AI decides", body: "At each checkpoint an AI model on 0G Compute looks through the camera and picks the next move." },
  { title: "Sealed and signed", body: "Every moment is encrypted and signed on the robot, stored on 0G Storage and fingerprinted on 0G Chain." },
  { title: "Searchable", body: "The robot lists each run on Arkiv (outcome, incident, severity, time), so anyone can find it. Its contents stay locked." },
  { title: "Insured", body: "After an incident the owner claims, proven the real owner and one person by World ID. The insurer reviews, Arkiv tracks the claim, and the pool on 0G Chain pays." },
] as const;

export const OFFLINE_LINE = "Works without internet: nearby phones and robots carry the sealed proof out. They can't read it or change it.";
export const OFFLINE_DETAIL = "No signal? Nearby phones and robots carry the sealed proof out until one gets online. They can't read it or change it.";

/** One-line ⓘ explanations, for <InfoTip text={TIP.x} />. */
export const TIP = {
  og: "0G is the decentralised AI network the robot asks for each decision. It also stores the proof and pays claims.",
  ogCompute: "0G Compute runs the AI model, inside a verified secure enclave (TEE), that looks through the camera and decides the robot's next move.",
  ogStorage: "0G Storage keeps the robot's locked records. Only the owner, and the insurer for a claim, can open them.",
  ogChain: "0G Chain is a public ledger. A fingerprint of every run is written there, so any later change is caught.",
  arkiv: "Arkiv is the public, searchable record. The robot writes its own entry for every run (outcome, incident, severity, time), so anyone can find it without reading it. Entries expire after 30 days; the proof stays on 0G.",
  arkivClaims: "Every claim is a live Arkiv record kept by the insurer desk, updated at each step (filed, human-checked, reviewed, paid). Status and amount only, never who claimed. It expires after 90 days.",
  arkivQuery: "This list is a live Arkiv query, so it works even when the robot is offline. Anyone can run the same query.",
  worldId: "World ID proves a claim comes from the robot's real owner and one unique person, without revealing who they are.",
  fingerprint: "A short code computed from the whole record. Change one letter and the fingerprint changes completely.",
  locked: "Encrypted on the robot before it leaves. Only the owner's key can open it.",
  signed: "The robot signs every record with its own key, so nobody else can pretend to be it.",
  carried: "When there is no internet, nearby phones and robots carry the sealed package until one gets online.",
  sealedPackage: "A run's locked record plus its signature, packed so anyone can carry it but nobody can read or change it.",
  claimable: "This run had an incident, so its owner can claim insurance for it.",
  pool: "Test 0G tokens set aside on 0G Chain. The pool pays approved claims automatically.",
  failsafe: "The AI couldn't be reached, so the robot's safety rule stopped the arm instead of guessing. That's the safety feature working.",
  untouched: "We recomputed the fingerprint and it matches the one the robot recorded on 0G Chain.",
} as const;

/** Page names, used by the shell (nav + document title). */
export const PAGE = {
  home: "Home",
  robot: "Robot",
  proof: "Proof",
  insurance: "Insurance",
  offline: "Offline",
  account: "Account",
} as const;

// ---------------------------------------------------------------- Insurance page (additive, pages/Insurance.tsx)
/** The owner's claim, in five plain steps (StepStrip input on #/insurance/owner). */
export const CLAIM_STEPS = [
  { title: "Pick an incident", body: "Any incident of severity 2 (minor) or more. The payout is fixed by severity." },
  { title: "Prove it's you", body: "A fresh World ID check, so someone with your laptop can't claim for you." },
  { title: "Prove you're one person", body: "One person, one claim: no fake accounts. Nobody learns who you are." },
  { title: "Insurer reviews", body: "A person at the insurer opens this one incident and decides." },
  { title: "Paid", body: "From the insurance pool on 0G Chain, straight to your payout wallet." },
] as const;

export const INS_TIP = {
  agentPass: "World ID asks you to approve in World App right now, so only the account's real owner can start a claim.",
  proofOfHuman: "World ID proves you are a unique human without revealing who you are. Each person can claim an incident once.",
  publicRecord: "Each claim is a live public record on Arkiv, updated at every step (filed, human-checked, reviewed, paid). Status and amount only, never who claimed.",
  receivingKey: "Owners lock the incident they claim for this key. It stays in this browser; the server only has the public half.",
  shareOne: "Claiming shares this one incident with the insurer. Your other runs stay locked.",
} as const;
