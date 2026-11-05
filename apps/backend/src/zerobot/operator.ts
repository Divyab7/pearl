/**
 * The arm's zerobot operator: polls the dispatcher for pending commands to our robot, runs RUN_EPISODE commands as
 * Pearl episodes, and answers every command with a receipt. Mirrors the rules of zerobot's own OperatorNode:
 * one command at a time in nonce order, unknown apiIds fail, commands older than 300 s fail with "Command expired".
 * The receipt for an episode is submitted after the episode is published, so it carries the 0G Storage root.
 */
import { parseTask as parseTaskBody } from "../shared/schemas.js";
import type { TaskSpec } from "../shared/types.js";
import { API_RUN_EPISODE, COMMAND_EXPIRY_S, type ZbCommand, type ZerobotChain } from "./zerobot.js";
import { errMsg } from "../shared/util.js";

export interface ZerobotOrigin {
  kind: "zerobot";
  robotId: string;
  nonce: number;
  sender: string;
  dispatchedAt: number; // seconds
}

export interface OperatorDeps {
  chain: ZerobotChain;
  /** Starts an episode for a command; throws when the arm cannot start (busy, tripped, not connected). */
  startEpisode: (task: TaskSpec, origin: ZerobotOrigin) => { episodeId: string };
  /** True while an episode runs (commands wait in the queue meanwhile). */
  busy: () => boolean;
  log?: (line: string) => void;
  now?: () => number; // seconds
}

const parseTask = (parameters: string): TaskSpec | string => {
  let j: unknown;
  try {
    j = JSON.parse(parameters || "{}");
  } catch {
    return "parameters are not JSON";
  }
  const t = parseTaskBody(j);
  return typeof t === "string" ? t.slice(0, 120) : t;
};

export class ZerobotOperator {
  private cursor = 0; // lowest nonce that may still be pending
  private handled = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly d: OperatorDeps) {}

  /** Starts polling. Commands older than the last 10 are past their 300 s expiry window in practice, so skip them. */
  async start(intervalMs = 3000): Promise<void> {
    try {
      this.cursor = Math.max(0, (await this.d.chain.nextNonce()) - 10);
    } catch (e) {
      this.d.log?.(`zerobot: could not read the robot nonce: ${errMsg(e)}`);
    }
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the queue; safe to call directly (tests, or a manual "check now"). */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const cmds = (await this.d.chain.pending(this.cursor, 10)).filter((c) => c.status === 0 && !this.handled.has(c.nonce));
      for (const c of cmds.sort((a, b) => a.nonce - b.nonce)) {
        const done = await this.handle(c);
        if (!done) break; // keep nonce order: later commands wait until this one can run
      }
    } catch (e) {
      this.d.log?.(`zerobot poll failed: ${errMsg(e)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Returns true when the command was consumed (started or answered), false when it must wait. */
  private async handle(c: ZbCommand): Promise<boolean> {
    const now = this.d.now?.() ?? Math.floor(Date.now() / 1000);
    if (now - c.timestamp > COMMAND_EXPIRY_S) return this.fail(c, "Command expired");
    if (c.apiId !== API_RUN_EPISODE) return this.fail(c, `unknown apiId ${c.apiId} (this arm accepts 1 = RUN_EPISODE)`);
    const task = parseTask(c.parameters);
    if (typeof task === "string") return this.fail(c, `bad parameters: ${task}`);
    if (this.d.busy()) return false;
    try {
      const { episodeId } = this.d.startEpisode(task, { kind: "zerobot", robotId: this.d.chain.robotId, nonce: c.nonce, sender: c.sender, dispatchedAt: c.timestamp });
      this.handled.add(c.nonce);
      this.advance();
      this.d.log?.(`zerobot command #${c.nonce} from ${c.sender} → episode ${episodeId}`);
      return true;
    } catch (e) {
      const msg = errMsg(e);
      // a tripped / disconnected arm cannot take the command now; it fails rather than running late without a person
      return this.fail(c, `arm refused: ${msg}`.slice(0, 200));
    }
  }

  private async fail(c: ZbCommand, why: string): Promise<boolean> {
    this.handled.add(c.nonce);
    this.advance();
    try {
      await this.d.chain.submitReceipt(c.nonce, false, why);
      this.d.log?.(`zerobot command #${c.nonce} failed: ${why}`);
    } catch (e) {
      this.d.log?.(`zerobot receipt #${c.nonce} failed: ${errMsg(e)}`);
    }
    return true;
  }

  private advance(): void {
    while (this.handled.has(this.cursor)) this.cursor++;
  }

  /** Lets a restarted backend skip nonces it already answered. */
  seek(nonce: number): void {
    this.cursor = Math.max(this.cursor, nonce);
  }
}
