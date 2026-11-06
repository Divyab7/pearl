/**
 * PUBLIC episode check (owner decisions 5–6 Nov 2026): anyone can confirm a run is untouched without being able to
 * read it. Runs on the dashboard server and needs no key and no help from the robot:
 *
 *  1 anchor      the robot's own record for this run exists on 0G Chain (EpisodeAnchor, keyed by the robot's address)
 *  2 storage     the locked file at the anchored 0G Storage root downloads with proof (any edit changes its root)
 *  3 header      the locked file's public header names this run and robot and matches the anchor: head hash, outcome,
 *                severity, incident
 *  4 signature   the head in the header is signed by the robot's key (EIP-191), the expected robot when one is given
 *  5 zerobot     for a run started by a zerobot command: that command's on-chain receipt carries this run and head
 *
 * Checks 6–10 need the unlocked log and run in the key holder's browser (verify/content.ts). A check whose module is
 * off is SKIPPED and says why; a SKIPPED check never counts as a pass for a module that is on.
 */
import { ethers } from "ethers";
import { envFlag } from "../shared/env.js";
import { headMessage, recoverDevice } from "../shared/deviceKey.js";
import { parseSealed, sealedBytes, type SealedEpisode } from "../shared/seal.js";
import { downloadBytes, localRoot, storageConfigFromEnv } from "../og/storage.js";
import { anchorConfigFromEnv, OUTCOME_CODE, readAnchor, type OnChainAnchor } from "../og/anchor.js";
import { decodeResult, ethersZerobot, ZEROBOT_MISSING, zerobotConfigFromEnv, zerobotConfigured } from "../zerobot/zerobot.js";
import type { EpisodeOutcome } from "../shared/types.js";
import { errMsg } from "../shared/util.js";
import type { CheckResult, CheckStatus } from "./content.js";

export type { CheckResult, CheckStatus } from "./content.js";

export interface PublicVerifyResult {
  episodeId: string;
  device: string;
  result: "VALID" | "REJECTED";
  failed: number[];
  checks: CheckResult[];
  /** The 0G Storage root the locked file was read from (anchored, or relayed when the robot's own upload failed). */
  rootHash: string | null;
  /** Where the locked file came from: 0G Storage, or the robot's memory when 0G Storage could not serve it. */
  source: "0g-storage" | "robot" | null;
  sealed: SealedEpisode | null;
  anchor: (OnChainAnchor & { address: string }) | null;
  /** Set when this result is for a deliberately edited copy ("Edit 1 byte"). */
  tampered?: string;
  /** The edited copy's own 0G Storage fingerprint (root), to show next to the stored one. */
  editedRoot?: string;
}

export interface PublicVerifyDeps {
  /** The robot this run must come from (the robot linked to the account, or the robot this dashboard serves). */
  device: string;
  anchorOn?: boolean;
  anchorAddress?: string;
  readAnchor?: (device: string, episodeId: string) => Promise<OnChainAnchor | null>;
  downloadStorage?: (rootHash: string) => Promise<Uint8Array>;
  rootOf?: (bytes: Uint8Array) => Promise<string>;
  /** A root recorded off-chain: the robot's own meta, or the dashboard's relay record (R5 backup). */
  fallbackRoot?: string | null;
  /** The robot's own copy of the locked file, used only when 0G Storage cannot serve it (shown as such). */
  robotCopy?: () => Promise<SealedEpisode | null>;
  /** "Edit 1 byte": verify this edited copy instead of the stored file. */
  editedCopy?: { bytes: Uint8Array; where: string };
  zerobotOn?: boolean;
  readZerobotReceipt?: (nonce: number) => Promise<{ success: boolean; resultData: string; txHash: string } | null>;
}

const ZERO_ROOT = ethers.ZeroHash;

export async function verifyPublic(episodeId: string, deps: PublicVerifyDeps): Promise<PublicVerifyResult> {
  const checks: CheckResult[] = [];
  const TECH: Record<number, string> = { 1: "0G Chain anchor", 2: "0G Storage", 3: "public header", 4: "device signature", 5: "zerobot receipt" };
  const add = (id: number, name: string, status: CheckStatus, detail: string, missing = false) =>
    checks.push({ id, name, status, detail, tech: TECH[id]!, ...(status === "FAIL" && missing ? { missing: true } : {}) });
  const device = deps.device;

  // 1 anchor
  const anchorOn = deps.anchorOn ?? envFlag("OG_CHAIN_ANCHOR", "on");
  const ac = anchorConfigFromEnv();
  const anchorAddr = deps.anchorAddress ?? ac.address;
  let anchor: PublicVerifyResult["anchor"] = null;
  if (!anchorOn) add(1, "Recorded on 0G Chain", "SKIPPED", "OG_CHAIN_ANCHOR=off");
  else if (!ethers.isAddress(anchorAddr)) add(1, "Recorded on 0G Chain", "FAIL", "no EpisodeAnchor contract is configured, so the record cannot be read", true);
  else if (!ethers.isAddress(device)) add(1, "Recorded on 0G Chain", "FAIL", "robot address unknown, so its record cannot be located", true);
  else {
    try {
      const read = deps.readAnchor ?? ((d: string, id: string) => readAnchor({ rpcUrl: ac.rpcUrl, address: anchorAddr }, d, id));
      const a = await read(device, episodeId);
      if (!a) add(1, "Recorded on 0G Chain", "FAIL", `robot ${device.slice(0, 10)}… has no record for this run on 0G Chain`);
      else {
        anchor = { ...a, address: anchorAddr };
        add(1, "Recorded on 0G Chain", "PASS", `robot ${device.slice(0, 6)}…${device.slice(-4)} recorded this run in its own 0G Chain record`);
      }
    } catch (e) {
      add(1, "Recorded on 0G Chain", "FAIL", `could not read 0G Chain: ${errMsg(e)}`, true);
    }
  }

  // 2 storage: the locked file at the anchored root (a root not in the anchor is shown as such)
  const anchoredRoot = anchor && anchor.rootHash !== ZERO_ROOT ? anchor.rootHash : null;
  const root = anchoredRoot ?? deps.fallbackRoot ?? null;
  let sealed: SealedEpisode | null = null;
  let source: PublicVerifyResult["source"] = null;
  const rootOf = deps.rootOf ?? localRoot;
  let editedRoot: string | undefined;
  const sh = (h: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "none");
  if (deps.editedCopy) {
    try {
      const r = await rootOf(deps.editedCopy.bytes);
      editedRoot = r;
      sealed = parseSealedOrNull(deps.editedCopy.bytes);
      source = "0g-storage";
      add(2, "Stored copy on 0G Storage", r === root ? "PASS" : "FAIL",
        r === root ? "The edited copy has the stored fingerprint (impossible for a real edit)." : `The edited copy's fingerprint ${sh(r)} differs from the stored one ${sh(root)}.`);
    } catch (e) {
      add(2, "Stored copy on 0G Storage", "FAIL", `edited copy: ${errMsg(e)}`);
    }
  } else if (!root) {
    add(2, "Stored copy on 0G Storage", "FAIL", anchor ? "the locked file never reached 0G Storage (the robot's upload failed), so the stored copy cannot be checked" : "no 0G Storage copy is recorded for this run", true);
  } else {
    try {
      const dl = deps.downloadStorage ?? ((r: string) => downloadBytes(storageConfigFromEnv(), r));
      const bytes = await dl(root);
      sealed = parseSealed(bytes);
      source = "0g-storage";
      const kb = (bytes.length / 1024).toFixed(1);
      add(2, "Stored copy on 0G Storage", "PASS", anchoredRoot
        ? `Downloaded the locked file (${kb} KB) with proof. It is the exact file recorded on 0G Chain.`
        : `Downloaded the locked file (${kb} KB) by its relayed root. The dashboard uploaded it as a backup, so this root is not in the 0G Chain record.`);
    } catch (e) {
      add(2, "Stored copy on 0G Storage", "FAIL", `could not download the stored copy: ${errMsg(e)}`, true);
    }
  }
  if (!sealed && deps.robotCopy && !deps.editedCopy) {
    sealed = await deps.robotCopy().catch(() => null);
    if (sealed) source = "robot";
  }

  // 3 header vs anchor
  if (!sealed) add(3, "Run summary matches the record", "FAIL", "no locked file to read", true);
  else {
    const problems: string[] = [];
    if (sealed.episodeId !== episodeId) problems.push(`names run ${sealed.episodeId}`);
    if (sealed.device.address.toLowerCase() !== device.toLowerCase()) problems.push(`names robot ${sealed.device.address}`);
    if (anchor) {
      if (anchor.headHash !== sealed.headHash) problems.push(`head ${sealed.headHash.slice(0, 12)}… ≠ anchored ${anchor.headHash.slice(0, 12)}…`);
      if (anchor.outcome !== OUTCOME_CODE[sealed.outcome as EpisodeOutcome]) problems.push("outcome differs from the anchor");
      if (anchor.severity !== sealed.severity || anchor.incident !== sealed.incident) problems.push("incident or severity differs from the anchor");
    }
    if (problems.length) add(3, "Run summary matches the record", "FAIL", problems.join("; "));
    else add(3, "Run summary matches the record", anchor ? "PASS" : "SKIPPED",
      anchor ? `run, robot, fingerprint, result and ${sealed.incident ? `incident severity ${sealed.severity}` : "no incident"} match the 0G Chain record` : "no 0G Chain record to compare with");
  }

  // 4 robot signature
  if (!sealed) add(4, "Signed by this robot", "FAIL", "no locked file to read", true);
  else {
    const who = recoverDevice(headMessage(sealed.episodeId, sealed.headHash), sealed.device.signature);
    if (!who) add(4, "Signed by this robot", "FAIL", "signature is malformed");
    else if (who.toLowerCase() !== device.toLowerCase()) add(4, "Signed by this robot", "FAIL", `signed by ${who}, expected robot ${device}`);
    else add(4, "Signed by this robot", "PASS", `the run's fingerprint carries robot ${who.slice(0, 6)}…${who.slice(-4)}'s own signature`);
  }

  // 5 zerobot receipt
  const origin = sealed?.origin ?? null;
  const zbOn = deps.zerobotOn ?? envFlag("ROBOT_ZEROBOT", "on");
  if (!origin) add(5, "Remote command receipt", "SKIPPED", sealed ? "not used: the run was started at the robot, not by a remote command" : "no locked file to read");
  else if (!zbOn) add(5, "Remote command receipt", "SKIPPED", "ROBOT_ZEROBOT=off");
  else {
    try {
      const read = deps.readZerobotReceipt ?? (() => {
        const zc = zerobotConfigFromEnv();
        if (!zerobotConfigured(zc)) throw new Error(`ROBOT_ZEROBOT=on but not configured: ${ZEROBOT_MISSING}`);
        return (n: number) => ethersZerobot(zc).receipt(n);
      })();
      const rc = await read(origin.nonce);
      const res = rc ? decodeResult(rc.resultData) : null;
      if (!rc) add(5, "Remote command receipt", "FAIL", `no receipt for command #${origin.nonce}`);
      else if (!res) add(5, "Remote command receipt", "FAIL", `receipt for #${origin.nonce} has no Pearl result`);
      else if (res.episodeId !== episodeId || res.headHash !== sealed!.headHash) add(5, "Remote command receipt", "FAIL", `receipt #${origin.nonce} names another run or head`);
      else if (rc.success !== (sealed!.outcome === "DONE")) add(5, "Remote command receipt", "FAIL", `receipt success=${rc.success} but outcome ${sealed!.outcome}`);
      else add(5, "Remote command receipt", "PASS", `command #${origin.nonce} receipt ${rc.txHash.slice(0, 12)}… carries this head`);
    } catch (e) {
      add(5, "Remote command receipt", "FAIL", errMsg(e));
    }
  }

  const failed = checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  return {
    episodeId, device, result: failed.length ? "REJECTED" : "VALID", failed, checks, rootHash: root, source, sealed, anchor,
    ...(deps.editedCopy ? { tampered: deps.editedCopy.where, ...(editedRoot ? { editedRoot } : {}) } : {}),
  };
}

function parseSealedOrNull(b: Uint8Array): SealedEpisode | null {
  try {
    return parseSealed(b);
  } catch {
    return null;
  }
}

/** "Edit 1 byte" on the public page: a copy of the locked file with one character of its locked data changed. */
export function editedSealedCopy(s: SealedEpisode): { bytes: Uint8Array; where: string } {
  const d = s.cipher.data;
  const i = Math.min(10, d.length - 3);
  const c = d[i] === "A" ? "B" : "A";
  const copy: SealedEpisode = { ...s, cipher: { ...s.cipher, data: d.slice(0, i) + c + d.slice(i + 1) } };
  return { bytes: sealedBytes(copy), where: `1 byte of the locked data (position ${i} → "${c}")` };
}
