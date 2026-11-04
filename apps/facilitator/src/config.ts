// Facilitator configuration from the environment. Every variable read must be in .env.example (TC-SD-021-09).
import { RPC_URLS } from "@x207/core";
import { defineCircleConfig, type CircleConfig } from "@x207/scheme";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type FacilitatorConfig = {
  port: number;
  /** Circles served: `x207:<circleId>` -> contract account. */
  circles: CircleConfig[];
  rpcUrls: string[];
  /** RPC call timeout (ADR-25: 10 seconds). */
  rpcTimeoutMs: number;
  pendingDbPath: string;
  /** Registration mode: `cumulative` (default, ADR-17) or `per_request` (demo mode, SD-029). */
  registerMode: "cumulative" | "per_request";
  /** Relayer gas key for parallel registration (NEP-611, SD-031); `lanes` is the number of nonce lanes used. Without it registration is sequential. */
  gasKey?: { privateKey: string; lanes: number };
  /** How long `/settle` waits for `per_request` registration before answering `settlement_pending` (ADR-25: 10 seconds). */
  settleTimeoutMs: number;
  /** Relayer account for `register_cumulative`; used by SD-028. */
  relayer?: { accountId: string; privateKey: string };
};

type Env = Record<string, string | undefined>;

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

function parseCircles(raw: string): CircleConfig[] {
  const circles = raw.split(",").map((part) => {
    const [circleId, contract, ...rest] = part.trim().split("=");
    if (!circleId || !contract || rest.length > 0) {
      throw new ConfigError(`X207_CIRCLES bad format "${part.trim()}"; use <circleId>=<contract account>`);
    }
    try {
      return defineCircleConfig({ network: `x207:${circleId}`, circleContract: contract });
    } catch (error) {
      throw new ConfigError(`X207_CIRCLES: ${(error as Error).message}`);
    }
  });
  return circles;
}

function parsePositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} must be an integer > 0, got "${raw}"`);
  return value;
}

export function loadConfig(env: Env = process.env): FacilitatorConfig {
  const circlesRaw = env.X207_CIRCLES;
  if (!circlesRaw) {
    throw new ConfigError("required variable X207_CIRCLES is empty; example: X207_CIRCLES=agents-main=x207-circle.near");
  }
  const rpcRaw = env.NEAR_RPC_URLS;
  const rpcUrls = rpcRaw ? rpcRaw.split(",").map((u) => u.trim()).filter(Boolean) : [...RPC_URLS];
  if (rpcUrls.length === 0) throw new ConfigError("NEAR_RPC_URLS contains no URL");

  const accountId = env.X207_RELAYER_ACCOUNT_ID;
  const privateKey = env.X207_RELAYER_PRIVATE_KEY;
  if (Boolean(accountId) !== Boolean(privateKey)) {
    throw new ConfigError("X207_RELAYER_ACCOUNT_ID and X207_RELAYER_PRIVATE_KEY must be set together");
  }

  const gasKeyPrivate = env.X207_GAS_KEY_PRIVATE_KEY;
  const gasKeyLanes = env.X207_GAS_KEY_LANES;
  if (Boolean(gasKeyPrivate) !== Boolean(gasKeyLanes)) throw new ConfigError("X207_GAS_KEY_PRIVATE_KEY and X207_GAS_KEY_LANES must be set together");
  if (gasKeyPrivate && !accountId) throw new ConfigError("the gas key needs X207_RELAYER_ACCOUNT_ID: that key is attached to the relayer account");
  const lanes = gasKeyLanes ? parsePositiveInt(env, "X207_GAS_KEY_LANES", 1) : 0;
  if (lanes > 1024) throw new ConfigError(`X207_GAS_KEY_LANES must be 1..1024, got ${lanes}`);

  const mode = env.X207_REGISTER_MODE;
  if (mode !== undefined && mode !== "" && mode !== "cumulative" && mode !== "per_request") {
    throw new ConfigError(`X207_REGISTER_MODE must be "cumulative" or "per_request", got "${mode}"`);
  }

  if (mode === "per_request" && !accountId) {
    throw new ConfigError("X207_REGISTER_MODE=per_request needs X207_RELAYER_ACCOUNT_ID and X207_RELAYER_PRIVATE_KEY");
  }

  return {
    port: parsePositiveInt(env, "PORT", 8080),
    circles: parseCircles(circlesRaw),
    rpcUrls,
    rpcTimeoutMs: parsePositiveInt(env, "RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS),
    pendingDbPath: env.X207_PENDING_DB || "./pending.sqlite",
    registerMode: mode === "per_request" ? "per_request" : "cumulative",
    settleTimeoutMs: parsePositiveInt(env, "X207_SETTLE_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS),
    ...(gasKeyPrivate && lanes > 0 ? { gasKey: { privateKey: gasKeyPrivate, lanes } } : {}),
    ...(accountId && privateKey ? { relayer: { accountId, privateKey } } : {}),
  };
}
