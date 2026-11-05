/**
 * pnpm zerobot:register
 * Registers the arm in zerobot's RobotRegistry on 0G Galileo (once; owner = the Galileo wallet in .env, robotId =
 * keccak256(ZEROBOT_ROBOT_NAME)), then reports it online. Safe to re-run: an existing registration is only read back.
 */
import { ethersZerobot, robotIdOf, ROBOT_TYPE, txLink, zerobotConfigFromEnv, zerobotConfigured } from "../zerobot/zerobot.js";

const cfg = zerobotConfigFromEnv();
if (!zerobotConfigured(cfg)) {
  console.error("Set ZEROBOT_ROBOT_NAME (a unique name, e.g. pearl-arm-<team>) and ZEROBOT_PRIVATE_KEY (or OG_STORAGE_PRIVATE_KEY: a Galileo wallet with faucet 0G) in .env.");
  process.exit(2);
}
const zb = ethersZerobot(cfg);
console.log(`robot "${cfg.robotName}" → robotId ${robotIdOf(cfg.robotName)}, wallet ${zb.address}`);
const existing = await zb.robot();
if (existing) {
  if (existing.owner.toLowerCase() !== zb.address.toLowerCase()) {
    console.error(`robotId is already registered by ${existing.owner}; choose another ZEROBOT_ROBOT_NAME.`);
    process.exit(1);
  }
  console.log(`already registered: type ${existing.robotType}, active ${existing.active}`);
} else {
  const r = await zb.register();
  console.log(`registered as ${ROBOT_TYPE}: ${txLink(cfg, r.txHash)}`);
}
const s = await zb.reportStatus(true, true);
console.log(`status online: ${txLink(cfg, s.txHash)}`);
console.log(`registry ${cfg.registry} · dispatcher ${cfg.dispatcher} (put these in the README's 0G section)`);
