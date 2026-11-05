import { ethers } from "ethers";
import { envFlag, loadEnv } from "../shared/env.js";
import type { RouterConfig, TrustMode } from "./router.js";

export function routerConfigFromEnv(overrides: Partial<RouterConfig> = {}): RouterConfig {
  loadEnv();
  const trust = (process.env.OG_TRUST_MODE ?? "verified") as TrustMode;
  if (!["standard", "verified", "private"].includes(trust)) {
    throw new Error(`OG_TRUST_MODE must be standard|verified|private, got ${trust}`);
  }
  return {
    baseUrl: process.env.OG_BASE_URL ?? "https://router-api.0g.ai/v1",
    apiKey: process.env.OG_API_KEY ?? "",
    model: process.env.OG_MODEL ?? "",
    trustMode: trust,
    timeoutMs: Number(process.env.OG_TIMEOUT_MS ?? 30000),
    verifyTee: envFlag("OG_VERIFY_TEE", "on"),
    maxTokens: Number(process.env.OG_MAX_TOKENS ?? 1000),
    ...overrides,
  };
}

/** 0G Galileo testnet (chain 16602): storage, EpisodeAnchor, RewardPool and zerobot all live here. */
export const galileoRpc = (): string => process.env.OG_CHAIN_RPC ?? "https://evmrpc-testnet.0g.ai";
export const galileoExplorer = (): string => process.env.OG_CHAIN_EXPLORER ?? "https://chainscan-galileo.0g.ai";

/** A wallet connected to the given RPC (Galileo by default). */
export function chainWallet(privateKey: string, rpcUrl = galileoRpc()): ethers.Wallet {
  return new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(rpcUrl));
}
