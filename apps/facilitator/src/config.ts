// Konfigurasi facilitator dari environment. Semua variabel yang dibaca harus ada di .env.example (TC-SD-021-09).
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
  /** Lingkaran yang dilayani: `x207:<circleId>` -> akun kontrak. */
  circles: CircleConfig[];
  rpcUrls: string[];
  /** Timeout panggilan RPC (ADR-25: 10 detik). */
  rpcTimeoutMs: number;
  pendingDbPath: string;
  /** Mode registrasi: `cumulative` (default, ADR-17). `per_request` (SD-029) belum didukung. */
  registerMode: "cumulative";
  /** Akun relayer untuk `register_cumulative`; dipakai SD-028. */
  relayer?: { accountId: string; privateKey: string };
};

type Env = Record<string, string | undefined>;

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

function parseCircles(raw: string): CircleConfig[] {
  const circles = raw.split(",").map((part) => {
    const [circleId, contract, ...rest] = part.trim().split("=");
    if (!circleId || !contract || rest.length > 0) {
      throw new ConfigError(`X207_CIRCLES salah format "${part.trim()}"; pakai <circleId>=<akun kontrak>`);
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
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} harus bilangan bulat > 0, dapat "${raw}"`);
  return value;
}

export function loadConfig(env: Env = process.env): FacilitatorConfig {
  const circlesRaw = env.X207_CIRCLES;
  if (!circlesRaw) {
    throw new ConfigError("variabel wajib X207_CIRCLES kosong; contoh: X207_CIRCLES=agents-main=x207-circle.near");
  }
  const rpcRaw = env.NEAR_RPC_URLS;
  const rpcUrls = rpcRaw ? rpcRaw.split(",").map((u) => u.trim()).filter(Boolean) : [...RPC_URLS];
  if (rpcUrls.length === 0) throw new ConfigError("NEAR_RPC_URLS tidak berisi URL");

  const accountId = env.X207_RELAYER_ACCOUNT_ID;
  const privateKey = env.X207_RELAYER_PRIVATE_KEY;
  if (Boolean(accountId) !== Boolean(privateKey)) {
    throw new ConfigError("X207_RELAYER_ACCOUNT_ID dan X207_RELAYER_PRIVATE_KEY harus diisi bersama");
  }

  const mode = env.X207_REGISTER_MODE;
  if (mode === "per_request") throw new ConfigError("X207_REGISTER_MODE=per_request belum didukung (SD-029)");
  if (mode !== undefined && mode !== "" && mode !== "cumulative") {
    throw new ConfigError(`X207_REGISTER_MODE harus "cumulative" atau "per_request", dapat "${mode}"`);
  }

  return {
    port: parsePositiveInt(env, "PORT", 8080),
    circles: parseCircles(circlesRaw),
    rpcUrls,
    rpcTimeoutMs: parsePositiveInt(env, "RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS),
    pendingDbPath: env.X207_PENDING_DB || "./pending.sqlite",
    registerMode: "cumulative",
    ...(accountId && privateKey ? { relayer: { accountId, privateKey } } : {}),
  };
}
