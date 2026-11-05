// Configuration of the x207 MCP server (SD-081). Everything comes from the environment; nothing here is a secret, and the read tools never need a key.
import { RPC_URLS } from "@x207/core";

export interface McpConfig {
  /** The circle contract account, e.g. `x207-v013.testnet`. */
  circleContract: string;
  /** The circle id in the paths of the read API, e.g. `agents-main`. */
  circleId: string;
  /** NEAR JSON-RPC endpoints, tried in order. */
  rpcUrls: readonly string[];
  /** Base URL of the x207 read API (`/x207/circles/{circle}/...`). Without it the tools that need it say so, and the tools that can use the contract views fall back to them. */
  backendUrl: string | null;
  /** Timeout of one RPC or read API call in ms. */
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Tried in order: a public endpoint that answers 429 hands over to the next. `rpc.testnet.near.org` is deprecated and answers 429 to every transaction, so dRPC is the second one (UM-191). Same list as `TESTNET_RPC_URLS` of `@x207/core` (kept here so this package does not need the newest core). */
export const TESTNET_RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"] as const;

const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CIRCLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ConfigError extends Error {}

/** `X207_CIRCLE_CONTRACT` (required), `X207_CIRCLE_ID` (default `agents-main`), `X207_RPC_URL` (comma separated; default by network), `X207_BACKEND_URL` (optional), `X207_TIMEOUT_MS`. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): McpConfig {
  const circleContract = env.X207_CIRCLE_CONTRACT?.trim() ?? "";
  if (!ACCOUNT.test(circleContract)) throw new ConfigError("X207_CIRCLE_CONTRACT must be the circle contract account, e.g. x207-v013.testnet");
  const circleId = env.X207_CIRCLE_ID?.trim() || "agents-main";
  if (!CIRCLE_ID.test(circleId)) throw new ConfigError("X207_CIRCLE_ID must be a circle id such as agents-main");
  const explicit = (env.X207_RPC_URL ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const url of explicit) if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError(`X207_RPC_URL: ${JSON.stringify(url)} is not an http(s) URL`);
  // a testnet circle must not read from mainnet endpoints by default
  const rpcUrls = explicit.length > 0 ? explicit : circleContract.endsWith(".testnet") ? [...TESTNET_RPC_URLS] : [...RPC_URLS];
  const backend = env.X207_BACKEND_URL?.trim().replace(/\/+$/, "") ?? "";
  if (backend !== "" && !/^https?:\/\/[^\s]+$/.test(backend)) throw new ConfigError("X207_BACKEND_URL must be an http(s) URL");
  const timeoutMs = env.X207_TIMEOUT_MS === undefined ? 10_000 : Number(env.X207_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new ConfigError("X207_TIMEOUT_MS must be an integer from 100 to 120000");
  return { circleContract, circleId, rpcUrls, backendUrl: backend === "" ? null : backend, timeoutMs };
}
