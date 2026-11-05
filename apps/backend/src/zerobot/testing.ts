/** Test double for zerobot's contracts (used by unit and app tests; never by the running backend). */
import { robotIdOf, type ZbCommand, type ZerobotChain } from "./zerobot.js";

/** In-memory dispatcher with the contract's rules: receipts only for Pending commands, once. */
export function fakeChain(now = () => Math.floor(Date.now() / 1000)) {
  const cmds: ZbCommand[] = [];
  const receipts = new Map<number, { success: boolean; resultData: string; txHash: string }>();
  const chain: ZerobotChain & { cmds: ZbCommand[]; receipts: typeof receipts } = {
    robotId: robotIdOf("test-arm"),
    address: "0x000000000000000000000000000000000000bEEF",
    cmds,
    receipts,
    async robot() {
      return { owner: chain.address, name: "test-arm", robotType: "pearl_4servo_arm", active: true };
    },
    async register() {
      return { txHash: "0xreg" };
    },
    async reportStatus() {
      return { txHash: "0xstatus" };
    },
    async dispatch(apiId, parameters, note) {
      const nonce = cmds.length;
      cmds.push({ nonce, sender: "0xsender", apiId, parameters, note, timestamp: now(), status: 0 });
      return { txHash: `0xdispatch${nonce}`, nonce };
    },
    async pending(from, count) {
      return cmds.filter((c) => c.nonce >= from && c.nonce < from + count && c.status === 0);
    },
    async nextNonce() {
      return cmds.length;
    },
    async submitReceipt(nonce, success, resultData) {
      const c = cmds[nonce];
      if (!c || c.status !== 0) throw new Error("Command already processed");
      c.status = success ? 1 : 2;
      const txHash = `0xreceipt${nonce}`;
      receipts.set(nonce, { success, resultData, txHash });
      return { txHash };
    },
    async receipt(nonce) {
      return receipts.get(nonce) ?? null;
    },
  };
  return chain;
}

