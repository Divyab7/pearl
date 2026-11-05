/**
 * zerobot hook (0G track, owner decision 4 Nov 2026). zerobot is 0G's open-source robot control stack:
 * https://github.com/0gfoundation/zerobot. Its two contracts on 0G Galileo give our arm an on-chain identity and a
 * public command queue:
 *   RobotRegistry          0x291162e93D7A80Eb8F738882a28a7a8A5FBA73bb  registerRobot, operators, status
 *   RobotCommandDispatcher 0x418bA7C231dac8Ef58b534BeE6adC50E703AA753  dispatchCommand → CommandDispatched,
 *                                                                      submitReceipt → CommandExecuted
 * We call them directly with ethers (their SDK's robot transport is Go2-specific). On-chain apiId and parameters are
 * opaque to the contracts, so the arm defines its own: apiId 1 = RUN_EPISODE, parameters {"color","from"}.
 * Each episode started from zerobot ends with submitReceipt(success = outcome DONE, resultData = the episode's chain
 * head and 0G Storage root), so the robot's public command history points at its Pearl record.
 *
 * ABI fragments derived from github.com/0gfoundation/zerobot (contracts/contracts/*.sol), Copyright 2026 0G Foundation,
 * Apache-2.0. Checked against the deployed implementations' selectors on 4 Nov 2026 (the contracts are not verified on
 * chainscan-galileo). Notes from the source: submitReceipt stores only the status; resultData lives in the event.
 * Command expiry (300 s) is not enforced on-chain; operators enforce it, as their OperatorNode does.
 */
import { ethers } from "ethers";
import { envFlag, loadEnv } from "../shared/env.js";
import { galileoExplorer, galileoRpc } from "../og/config.js";
import { isPrivateKey } from "../shared/util.js";

export const REGISTRY_ABI = [
  "function registerRobot(bytes32 robotId, string name, string robotType, bytes32 storageRoot)",
  "function addOperator(bytes32 robotId, address operator)",
  "function isOperator(bytes32 robotId, address caller) view returns (bool)",
  "function isAuthorized(bytes32 robotId, address caller) view returns (bool)",
  "function reportStatus(bytes32 robotId, bool online, bool robotConnected, uint8 battery)",
  "function getRobot(bytes32 robotId) view returns (tuple(address owner, string name, string robotType, bytes32 storageRoot, bool active, bool publicCommands, uint256 registeredAt))",
  "function getCommandPrice(bytes32 robotId) view returns (uint256)",
  "event RobotRegistered(bytes32 indexed robotId, address indexed owner, string name, string robotType)",
];

export const DISPATCHER_ABI = [
  "function dispatchCommand(bytes32 robotId, uint32 apiId, string parameters, string note) payable",
  "function submitReceipt(bytes32 robotId, uint256 nonce, bool success, string resultData)",
  "function getCommand(bytes32 robotId, uint256 nonce) view returns (tuple(bytes32 robotId, address sender, uint32 apiId, string parameters, string note, uint256 value, uint256 timestamp, uint256 nonce, uint8 status))",
  "function getRobotNonce(bytes32 robotId) view returns (uint256)",
  "function getPendingCommands(bytes32 robotId, uint256 fromNonce, uint256 count) view returns (tuple(bytes32 robotId, address sender, uint32 apiId, string parameters, string note, uint256 value, uint256 timestamp, uint256 nonce, uint8 status)[])",
  "event CommandDispatched(bytes32 indexed robotId, uint256 indexed nonce, address indexed sender, uint32 apiId, string parameters, string note, uint256 value)",
  "event CommandExecuted(bytes32 indexed robotId, uint256 indexed nonce, bool success, string resultData)",
];

export const API_RUN_EPISODE = 1;
export const COMMAND_EXPIRY_S = 300;
export const ROBOT_TYPE = "pearl_4servo_arm";

export interface ZerobotConfig {
  rpcUrl: string;
  registry: string;
  dispatcher: string;
  privateKey: string;
  robotName: string;
  explorer: string;
}

export function zerobotConfigFromEnv(): ZerobotConfig {
  loadEnv();
  return {
    rpcUrl: galileoRpc(),
    registry: process.env.ZEROBOT_REGISTRY ?? "0x291162e93D7A80Eb8F738882a28a7a8A5FBA73bb",
    dispatcher: process.env.ZEROBOT_DISPATCHER ?? "0x418bA7C231dac8Ef58b534BeE6adC50E703AA753",
    // the same Galileo wallet that uploads to 0G Storage and anchors episodes, unless a separate one is given
    privateKey: process.env.ZEROBOT_PRIVATE_KEY || process.env.OG_STORAGE_PRIVATE_KEY || "",
    robotName: process.env.ZEROBOT_ROBOT_NAME ?? "",
    explorer: galileoExplorer(),
  };
}

export const zerobotConfigured = (c: ZerobotConfig) =>
  isPrivateKey(c.privateKey) && c.robotName.length > 0 && ethers.isAddress(c.registry) && ethers.isAddress(c.dispatcher);

/** What to set when zerobot is on but not configured. */
export const ZEROBOT_MISSING = "ZEROBOT_ROBOT_NAME and a Galileo key (ZEROBOT_PRIVATE_KEY, or OG_STORAGE_PRIVATE_KEY)";

/** The zerobot connection from .env: null when ROBOT_ZEROBOT=off or it is not configured. */
export function zerobotFromEnv(): ZerobotChain | null {
  const c = zerobotConfigFromEnv();
  return envFlag("ROBOT_ZEROBOT", "on") && zerobotConfigured(c) ? ethersZerobot(c) : null;
}

/** Same id convention as zerobot's dashboard: keccak256(utf8(name)). */
export const robotIdOf = (name: string) => ethers.id(name);

export interface ZbCommand {
  nonce: number;
  sender: string;
  apiId: number;
  parameters: string;
  note: string;
  timestamp: number; // seconds
  status: number; // 0 Pending, 1 Executed, 2 Failed, 3 Expired
}

/** What Pearl puts in a receipt: enough to find and check the record, under one event. */
export interface ReceiptResult {
  v: 1;
  episodeId: string;
  outcome: string;
  headHash: string; // sha256 chain head, 64 hex
  rootHash: string | null; // 0G Storage root of the log
}

export const encodeResult = (r: ReceiptResult) => JSON.stringify(r);

export function decodeResult(s: string): ReceiptResult | null {
  try {
    const j = JSON.parse(s) as ReceiptResult;
    return j && j.v === 1 && typeof j.episodeId === "string" && /^[0-9a-f]{64}$/.test(j.headHash) ? j : null;
  } catch {
    return null;
  }
}

/** Everything the operator loop and the routes need from the chain; tests substitute a fake. */
export interface ZerobotChain {
  readonly robotId: string;
  readonly address: string;
  robot(): Promise<{ owner: string; name: string; robotType: string; active: boolean } | null>;
  register(): Promise<{ txHash: string }>;
  reportStatus(online: boolean, robotConnected: boolean): Promise<{ txHash: string }>;
  dispatch(apiId: number, parameters: string, note: string): Promise<{ txHash: string; nonce: number }>;
  pending(fromNonce: number, count: number): Promise<ZbCommand[]>;
  /** The nonce the next dispatched command will get. */
  nextNonce(): Promise<number>;
  submitReceipt(nonce: number, success: boolean, resultData: string): Promise<{ txHash: string }>;
  /** The receipt event for a command, if one was submitted. */
  receipt(nonce: number): Promise<{ success: boolean; resultData: string; txHash: string } | null>;
}

function toCmd(c: ethers.Result): ZbCommand {
  return {
    nonce: Number(c.nonce ?? c[7]),
    sender: String(c.sender ?? c[1]),
    apiId: Number(c.apiId ?? c[2]),
    parameters: String(c.parameters ?? c[3]),
    note: String(c.note ?? c[4]),
    timestamp: Number(c.timestamp ?? c[6]),
    status: Number(c.status ?? c[8]),
  };
}

export function ethersZerobot(c: ZerobotConfig): ZerobotChain {
  const provider = new ethers.JsonRpcProvider(c.rpcUrl);
  const wallet = new ethers.Wallet(c.privateKey, provider);
  const reg = new ethers.Contract(c.registry, REGISTRY_ABI, wallet);
  const dis = new ethers.Contract(c.dispatcher, DISPATCHER_ABI, wallet);
  const robotId = robotIdOf(c.robotName);
  const send = async (p: Promise<ethers.ContractTransactionResponse>) => {
    const tx = await p;
    const r = await tx.wait();
    if (!r || r.status !== 1) throw new Error(`zerobot tx ${tx.hash} failed`);
    return r;
  };
  return {
    robotId,
    address: wallet.address,
    async robot() {
      const r = await reg.getFunction("getRobot")(robotId);
      const owner = String(r.owner ?? r[0]);
      if (owner === ethers.ZeroAddress) return null;
      return { owner, name: String(r.name ?? r[1]), robotType: String(r.robotType ?? r[2]), active: Boolean(r.active ?? r[4]) };
    },
    async register() {
      const r = await send(reg.getFunction("registerRobot")(robotId, c.robotName, ROBOT_TYPE, ethers.ZeroHash));
      return { txHash: r.hash };
    },
    async reportStatus(online, robotConnected) {
      const r = await send(reg.getFunction("reportStatus")(robotId, online, robotConnected, 255));
      return { txHash: r.hash };
    },
    async dispatch(apiId, parameters, note) {
      const price = (await reg.getFunction("getCommandPrice")(robotId)) as bigint;
      const r = await send(dis.getFunction("dispatchCommand")(robotId, apiId, parameters, note, { value: price }));
      for (const log of r.logs) {
        const ev = (() => {
          try {
            return dis.interface.parseLog(log);
          } catch {
            return null;
          }
        })();
        if (ev?.name === "CommandDispatched") return { txHash: r.hash, nonce: Number(ev.args.nonce) };
      }
      throw new Error(`zerobot dispatch ${r.hash}: no CommandDispatched event`);
    },
    async pending(fromNonce, count) {
      const list = (await dis.getFunction("getPendingCommands")(robotId, fromNonce, count)) as ethers.Result[];
      return list.map(toCmd).filter((x) => x.timestamp > 0);
    },
    async nextNonce() {
      return Number(await dis.getFunction("getRobotNonce")(robotId));
    },
    async submitReceipt(nonce, success, resultData) {
      const r = await send(dis.getFunction("submitReceipt")(robotId, nonce, success, resultData));
      return { txHash: r.hash };
    },
    async receipt(nonce) {
      const filter = dis.filters.CommandExecuted!(robotId, nonce);
      const logs = await dis.queryFilter(filter, 0, "latest");
      const l = logs[0] as ethers.EventLog | undefined;
      if (!l) return null;
      return { success: Boolean(l.args.success), resultData: String(l.args.resultData), txHash: l.transactionHash };
    },
  };
}

export const txLink = (c: Pick<ZerobotConfig, "explorer">, txHash: string) => `${c.explorer}/tx/${txHash}`;
