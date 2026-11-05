/**
 * pnpm anchor:deploy — deploys EpisodeAnchor v2 and RewardPool to OG_CHAIN_RPC (Galileo by default) with the dashboard
 * operator key (OG_OPERATOR_PRIVATE_KEY), which also becomes the pool's operator. Fund the pool afterwards by sending
 * test 0G to its address. REWARD_MAX_0G sets the largest single payout (default 0.05).
 */
import { ethers } from "ethers";
import { loadEnv } from "../shared/env.js";
import { deployAnchor, deployPool } from "../og/anchor.js";
import { galileoRpc } from "../og/config.js";
import { isPrivateKey } from "../shared/util.js";

loadEnv();
const rpc = galileoRpc();
const key = process.env.OG_OPERATOR_PRIVATE_KEY ?? "";
if (!isPrivateKey(key)) {
  console.error("Set OG_OPERATOR_PRIVATE_KEY (dashboard wallet with test 0G from faucet.0g.ai) in .env first.");
  process.exit(2);
}
if (process.env.OG_ANCHOR_ADDRESS || process.env.OG_REWARD_POOL_ADDRESS) {
  console.error("OG_ANCHOR_ADDRESS / OG_REWARD_POOL_ADDRESS already set; clear them to deploy new contracts.");
  process.exit(2);
}
const max = ethers.parseEther(process.env.REWARD_MAX_0G ?? "0.05");
const a = await deployAnchor(rpc, key);
console.log(`EpisodeAnchor ${a.address} (tx ${a.txHash})`);
const p = await deployPool(rpc, key, a.address, max);
console.log(`RewardPool    ${p.address} (tx ${p.txHash}), max payout ${ethers.formatEther(max)} 0G`);
console.log(`\nAdd to .env:\nOG_ANCHOR_ADDRESS=${a.address}\nOG_REWARD_POOL_ADDRESS=${p.address}\n\nThen send some test 0G to ${p.address} to fund rewards.`);
