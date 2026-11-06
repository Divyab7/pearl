import { ethers } from "ethers";
import { envFlag, loadEnv } from "../shared/env.js";
import type { RouterConfig, TrustMode } from "./router.js";

/**
 * Default fallback models (live GET /v1/models, 6 Nov 2026): image input + response_format, cheapest first. Neither lists
 * a TEE tier today, so under trust mode "verified" they answer 503 no_provider_for_trust_mode (about 1 s, not billed) and
 * the run still ends in FAILSAFE; they take over as soon as 0G gives them a verified provider.
 */
export const DEFAULT_FALLBACK_MODELS = ["qwen2.5-vl-72b-instruct", "gemini-2.5-flash-lite"];

/** OG_MODEL_FALLBACKS: comma list; unset → the default list; set but empty ("") → no fallbacks. */
export function parseFallbacks(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_FALLBACK_MODELS];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

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
    fallbackModels: parseFallbacks(process.env.OG_MODEL_FALLBACKS),
    trustMode: trust,
    allowStandardFallback: envFlag("OG_ALLOW_STANDARD_FALLBACK", "on"),
    ...(process.env.OG_API_KEY_STANDARD ? { standardApiKey: process.env.OG_API_KEY_STANDARD } : {}),
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
