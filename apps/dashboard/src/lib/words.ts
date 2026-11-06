// Plain-language vocabulary for every user-facing string. One source of truth: pages read their words from here so
// the same thing is never called two names. Technical terms (hashes, "anchor", "root hash", "episode") appear ONLY
// inside <TechDetails>; everywhere else use the plain word below.

/** The product in one sentence: the first thing anyone reads. */
export const PRODUCT_LINE = "A tamper-proof black box for robots: an AI decides every move, every moment is sealed as proof, and that proof gets out even without internet.";
export const PRODUCT_SHORT = "A tamper-proof black box for robots.";
export const PRODUCT_TAIL = "An AI decides every move, every moment is sealed as proof, and that proof gets out even without internet.";

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
  FAILSAFE: "Stopped safely (AI unreachable)",
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
  WAITING: "Asking the AI",
  FROZEN_HAND: "Paused: hand in the way",
  SAFE: "In safe pose",
  TRIPPED: "Safety trip",
};

/** Proof verdicts: the big word and its one-line explanation. */
export const VERDICT_WORDS = {
  ok: { word: "Untouched", explain: "Matches exactly what the robot signed and recorded. Nobody has changed it." },
  incomplete: { word: "Not verified", explain: "Part of the proof is missing, so we can't confirm it yet. Nothing shows it was changed." },
  bad: { word: "Tampered", explain: "This doesn't match what the robot signed. Someone changed it after the fact." },
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
  { title: "AI decides", body: "At each checkpoint an AI model on 0G looks through the camera and picks the next move." },
  { title: "Locked and signed", body: "Every moment is locked, signed by the robot's own key and fingerprinted on 0G Chain." },
  { title: "Searchable", body: "Public labels on Arkiv let anyone find a run. Its contents stay locked." },
  { title: "Insured", body: "After an incident the owner claims, proven a real person by World ID. The insurer reviews and the pool pays." },
] as const;

export const OFFLINE_LINE = "Works without internet: nearby phones and robots carry the sealed proof out. They can't read it or change it.";
export const OFFLINE_DETAIL = "No signal? Nearby phones and robots carry the sealed proof out until one gets online. They can't read it or change it.";

/** One-line ⓘ explanations, for <InfoTip text={TIP.x} />. */
export const TIP = {
  og: "0G is the decentralised AI network the robot asks for each decision.",
  ogCompute: "0G Compute runs the AI model that looks through the camera and decides the robot's next move.",
  ogStorage: "0G Storage keeps the robot's locked records. Only the owner, and the insurer for a claim, can open them.",
  ogChain: "0G Chain is a public ledger. A fingerprint of every run is written there, so any later change is caught.",
  arkiv: "Arkiv holds the public labels (time, outcome, incident) so anyone can find a run without reading it.",
  worldId: "World ID proves a claim comes from a real, unique person, without revealing who they are.",
  fingerprint: "A short code computed from the whole record. Change one letter and the fingerprint changes completely.",
  locked: "Encrypted on the robot before it leaves. Only the owner's key can open it.",
  signed: "The robot signs every record with its own key, so nobody else can pretend to be it.",
  carried: "When there is no internet, nearby phones and robots carry the sealed package until one gets online.",
  sealedPackage: "A run's locked record plus its signature, packed so anyone can carry it but nobody can read or change it.",
  claimable: "This run had an incident, so its owner can claim insurance for it.",
  pool: "Money set aside on 0G Chain that pays approved claims automatically.",
  untouched: "We recomputed the fingerprint and it matches the one the robot recorded on 0G Chain.",
} as const;

/** Page names, used by the shell (nav + document title). */
export const PAGE = {
  home: "Home",
  robot: "Robot",
  proof: "Proof",
  insurance: "Insurance",
  offline: "Works without internet",
  account: "Account",
} as const;

// ---------------------------------------------------------------- Insurance page (additive, pages/Insurance.tsx)
/** The owner's claim, in five plain steps (StepStrip input on #/insurance/owner). */
export const CLAIM_STEPS = [
  { title: "Pick an incident", body: "Any incident of severity 2 or more. The amount is fixed by severity." },
  { title: "Prove it's you", body: "A fresh World ID check, so someone with your laptop can't claim for you." },
  { title: "Prove you're one person", body: "One person, one claim: no fake accounts. Nobody learns who you are." },
  { title: "Insurer reviews", body: "A person at the insurer opens this one incident and decides." },
  { title: "Paid", body: "From the insurance pool on 0G Chain, straight to your payout wallet." },
] as const;

export const INS_TIP = {
  agentPass: "World ID asks you to approve in World App right now, so only the account's real owner can start a claim.",
  proofOfHuman: "World ID proves you are a unique human without revealing who you are. Each person can claim an incident once.",
  publicRecord: "Each claim has a public record on Arkiv, updated as it moves: status and amount only, never who claimed.",
  receivingKey: "Owners lock the incident they claim for this key. It stays in this browser; the server only has the public half.",
  shareOne: "Claiming shares this one incident with the insurer. Your other runs stay locked.",
} as const;
