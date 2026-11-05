import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import type { TaskSpec } from "../shared/types.js";
import { ZerobotOperator, type ZerobotOrigin } from "./operator.js";
import { DISPATCHER_ABI, REGISTRY_ABI, decodeResult, encodeResult, robotIdOf } from "./zerobot.js";
import { fakeChain } from "./testing.js";

function operator(chain: ReturnType<typeof fakeChain>, opts: { busy?: () => boolean; refuse?: string; now?: () => number } = {}) {
  const started: { task: TaskSpec; origin: ZerobotOrigin }[] = [];
  const op = new ZerobotOperator({
    chain,
    busy: opts.busy ?? (() => false),
    startEpisode: (task, origin) => {
      if (opts.refuse) throw new Error(opts.refuse);
      started.push({ task, origin });
      return { episodeId: `ep_${started.length}` };
    },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { op, started };
}

describe("zerobot operator", () => {
  it("runs a RUN_EPISODE command as an episode, with the command recorded as its origin", async () => {
    const chain = fakeChain();
    await chain.dispatch(1, JSON.stringify({ color: "red", from: "A2" }), "pick red A2");
    const { op, started } = operator(chain);
    await op.poll();
    expect(started).toHaveLength(1);
    expect(started[0]!.task).toEqual({ task: "pick", color: "red", from: "A2", to: "BIN" });
    expect(started[0]!.origin).toMatchObject({ kind: "zerobot", robotId: chain.robotId, nonce: 0, sender: "0xsender" });
    expect(chain.receipts.size).toBe(0); // the receipt comes after the episode is published
    await op.poll();
    expect(started).toHaveLength(1); // never started twice
  });

  it("fails unknown apiIds, bad parameters and expired commands with a receipt, in nonce order", async () => {
    let t = 1_000_000;
    const chain = fakeChain(() => t);
    await chain.dispatch(1, '{"color":"red","from":"A2"}', "old"); // dispatched 301 s before the operator looks
    t += 301;
    await chain.dispatch(7, "{}", "dance");
    await chain.dispatch(1, '{"color":"red","from":"Z9"}', "bad slot");
    await chain.dispatch(1, "not json", "garbage");
    const { op, started } = operator(chain, { now: () => t });
    await op.poll();
    expect(started).toHaveLength(0);
    expect(chain.receipts.get(0)).toMatchObject({ success: false, resultData: "Command expired" });
    expect(chain.receipts.get(1)).toMatchObject({ success: false, resultData: expect.stringContaining("unknown apiId 7") });
    expect(chain.receipts.get(2)).toMatchObject({ success: false, resultData: expect.stringContaining("bad parameters") });
    expect(chain.receipts.get(3)).toMatchObject({ success: false, resultData: expect.stringContaining("not JSON") });
  });

  it("waits while the arm is busy, and fails the command when the arm refuses (tripped / disconnected)", async () => {
    const chain = fakeChain();
    await chain.dispatch(1, '{"color":"red","from":"A2"}', "a");
    let busy = true;
    const { op, started } = operator(chain, { busy: () => busy });
    await op.poll();
    expect(started).toHaveLength(0);
    expect(chain.receipts.size).toBe(0);
    busy = false;
    await op.poll();
    expect(started).toHaveLength(1);

    const chain2 = fakeChain();
    await chain2.dispatch(1, '{"color":"red","from":"A2"}', "a");
    const r = operator(chain2, { refuse: "device is TRIPPED: operator reset required" });
    await r.op.poll();
    expect(chain2.receipts.get(0)).toMatchObject({ success: false, resultData: expect.stringContaining("TRIPPED") });
  });

  it("receipt result round-trips and rejects anything that is not a Pearl result", () => {
    const r = { v: 1 as const, episodeId: "ep_1", outcome: "DONE", headHash: "a".repeat(64), rootHash: "0xabc" };
    expect(decodeResult(encodeResult(r))).toEqual(r);
    expect(decodeResult("Command expired")).toBeNull();
    expect(decodeResult('{"v":1,"episodeId":"x","headHash":"short"}')).toBeNull();
  });

  it("ABI fragments parse and match the selectors of the deployed contracts (checked 4 Nov 2026)", () => {
    const reg = new ethers.Interface(REGISTRY_ABI);
    const dis = new ethers.Interface(DISPATCHER_ABI);
    expect(reg.getFunction("registerRobot")!.selector).toBe("0x557fec73");
    expect(dis.getFunction("dispatchCommand")!.selector).toBe("0x8eecdd6b");
    expect(dis.getFunction("submitReceipt")!.selector).toBe("0xd2261ed6");
    expect(dis.getFunction("getCommand")!.selector).toBe("0x26cd3c44");
    expect(dis.getFunction("getRobotNonce")!.selector).toBe("0xf3fa944b");
    expect(dis.getEvent("CommandExecuted")!.topicHash).toBe("0xa46fd06b4b7712f3d6b9151751ff8c5ac563fdaf2f288b42c0a5af277b69c9b4");
    expect(robotIdOf("x")).toBe(ethers.keccak256(ethers.toUtf8Bytes("x")));
  });
});

