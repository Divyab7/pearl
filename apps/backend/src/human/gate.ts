/**
 * Human check (rev 5): a fresh World ID verification that the backend has validated. The dashboard asks for one before
 * a reward claim (dashboard/rewards.ts); it is not in the arm's loop. Anything other than a validated success (denied,
 * cancelled, expired, invalid, provider unreachable) fails the check. The gate never approves on its own.
 *
 * Callers only see this interface; the World ID Agent Pass implementation is in worldid.ts.
 */

export type HumanCheckFailure = "denied" | "cancelled" | "expired" | "invalid" | "error";

export interface HumanCheckRequest {
  reason: string; // what the person is approving (sign-in, or a claim on a named incident)
}

/** What the person is asked to do, as the dashboard shows it. */
export interface HumanCheckPrompt {
  attemptId: string;
  provider: string;
  /** URL the person opens (or the QR code encodes). */
  verificationUri: string;
  /** Short code to type if the URL is opened without it (device flow). */
  userCode: string | null;
  expiresAt: string; // ISO time
}

export type HumanCheckResult =
  | {
      ok: true;
      attemptId: string;
      provider: string;
      issuer: string;
      subject: string; // pairwise subject: same person → same value for this app's sector
      acr: string | null;
      amr: string[] | null;
      authTime: number; // seconds since epoch
      idTokenSha256: string; // hash of the validated ID token, kept in the log instead of the token
    }
  | { ok: false; attemptId: string; provider: string; reason: HumanCheckFailure; detail: string };

export interface HumanGate {
  readonly provider: string;
  /** Starts a verification; `onPrompt` fires once the person can act. Resolves when it succeeds or fails. */
  verify(req: HumanCheckRequest, onPrompt: (p: HumanCheckPrompt) => void): Promise<HumanCheckResult>;
  /** Operator cancels the pending attempt (dashboard "Cancel"): the attempt fails with reason "cancelled". */
  cancel(attemptId: string): boolean;
}
