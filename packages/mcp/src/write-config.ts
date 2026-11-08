// Configuration and guards of the WRITE tools of the x207 MCP server (SD-082). Write tools exist only on stdio, only when X207_MCP_WRITE=1, and every key comes from the
// environment: nothing here prints, logs or returns a key.
//
//   X207_MCP_WRITE=1                  turns the write tools on (default off: the server is read-only)
//   X207_AGENT_ACCOUNT                the NEAR account of the agent (a member of the circle). With X207_EVM_PRIVATE_KEY it is optional and, if set, must be the lower-case 0x address of that key
//   X207_AGENT_VOUCHER_KEY            ed25519 voucher secret key of the agent: signs vouchers, listings, offers, acceptances and order notices. It is not a NEAR key.
//   X207_EVM_PRIVATE_KEY             SD-088, instead of X207_AGENT_VOUCHER_KEY: the 0x private key of an EVM agent. Its lower-case 0x address is the member id; x207_pay_request signs EIP-712 vouchers with it.
//                                     The other write tools stay off (joining, claiming and exiting go through the relayer /evm/*, not through this server). Not allowed together with X207_AGENT_VOUCHER_KEY.
//   X207_AGENT_NEAR_KEY               ed25519 secret key of the NEAR account: signs the transactions of x207_join, x207_settle and x207_claim only
//   X207_MAX_SPEND_SESSION            largest total (credit units, 6 decimals) the agent may commit in one session of the server; default 1000000 (1 credit)
//   X207_MAX_PRICE_PER_CALL           largest amount of one payment, offer or milestone; default 100000 (0.1 credit)
//   X207_ALLOWED_COUNTERPARTIES       comma separated accounts the agent may deal with; empty: any ACTIVE member of the circle
//   X207_ALLOW_OUTFLOWS=1             turns on the tools that move USDT or NEAR out of the agent account into the circle (x207_join, x207_settle); default off
//   X207_ALLOW_PRIVATE_URLS=1         lets x207_pay_request fetch a URL on this machine or in a private network; default off, because the URL comes from a model (SSRF)
//   X207_ALLOW_FULL_ACCESS_KEY=1      lets the NEAR key be a full-access key. Why this exists: a function-call key cannot attach a deposit, and join, stake, settle and claim all
//                                     attach one (NEAR protocol rule), so the tools that send those transactions need a full-access key of the AGENT account; without this flag they are off.
import { voucherPublicKey } from "@x207/core";
import { evmSignerFromPrivateKey, isEvmPrivateKey } from "@x207/core/evm";
import { ConfigError } from "./config.js";

export interface WriteConfig {
  account: string;
  voucherKey: `ed25519:${string}` | null;
  nearKey: `ed25519:${string}` | null;
  /** SD-088: EVM agent private key; `account` is then its 0x address. */
  evmKey?: `0x${string}` | null;
  maxSpendSession: bigint;
  maxPricePerCall: bigint;
  allowedCounterparties: readonly string[];
  allowOutflows: boolean;
  allowFullAccessKey: boolean;
  /** `X207_ALLOW_PRIVATE_URLS=1`: x207_pay_request may fetch a URL on this machine or in a private network (a seller you run yourself). Default off (SSRF guard). */
  allowPrivateUrls: boolean;
}

const ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/;
const AMOUNT = /^[1-9]\d{0,37}$/;

const amount = (env: Record<string, string | undefined>, name: string, dflt: string): bigint => {
  const raw = env[name]?.trim() || dflt;
  if (!AMOUNT.test(raw)) throw new ConfigError(`${name} must be a positive integer (credit units, 6 decimals), got ${JSON.stringify(raw.length > 40 ? "…" : raw)}`);
  return BigInt(raw);
};

/** `null` when the write tools are off. A bad value stops the server with a message that never contains a key. */
export function writeConfigFromEnv(env: Record<string, string | undefined> = process.env): WriteConfig | null {
  if (env.X207_MCP_WRITE?.trim() !== "1") return null;
  let account = env.X207_AGENT_ACCOUNT?.trim() ?? "";
  const rawEvm = env.X207_EVM_PRIVATE_KEY?.trim() ?? "";
  let evmKey: `0x${string}` | null = null;
  if (rawEvm !== "") {
    if (!isEvmPrivateKey(rawEvm)) throw new ConfigError("X207_EVM_PRIVATE_KEY must be 0x followed by 64 hex characters; the value is not shown");
    if ((env.X207_AGENT_VOUCHER_KEY?.trim() ?? "") !== "") throw new ConfigError("set X207_EVM_PRIVATE_KEY or X207_AGENT_VOUCHER_KEY, not both");
    evmKey = rawEvm;
    const address = evmSignerFromPrivateKey(rawEvm).id;
    if (account !== "" && account !== address) throw new ConfigError(`X207_AGENT_ACCOUNT must be ${address}, the address of X207_EVM_PRIVATE_KEY, or be left out`);
    account = address;
  } else if (!ACCOUNT.test(account)) {
    throw new ConfigError("X207_MCP_WRITE=1 needs X207_AGENT_ACCOUNT, the NEAR account of the agent");
  }
  const key = (name: string): `ed25519:${string}` | null => {
    const v = env[name]?.trim();
    if (v === undefined || v === "") return null;
    if (!KEY.test(v)) throw new ConfigError(`${name} is not an ed25519 secret key (ed25519:<base58>); the value is not shown`);
    return v as `ed25519:${string}`;
  };
  const voucherKey = key("X207_AGENT_VOUCHER_KEY");
  if (voucherKey !== null) {
    try {
      voucherPublicKey(voucherKey);
    } catch {
      throw new ConfigError("X207_AGENT_VOUCHER_KEY is not a usable ed25519 secret key; the value is not shown");
    }
  }
  const allowed = (env.X207_ALLOWED_COUNTERPARTIES ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const a of allowed) if (!ACCOUNT.test(a)) throw new ConfigError(`X207_ALLOWED_COUNTERPARTIES: ${JSON.stringify(a)} is not an account id`);
  return {
    account, voucherKey, nearKey: key("X207_AGENT_NEAR_KEY"), evmKey,
    maxSpendSession: amount(env, "X207_MAX_SPEND_SESSION", "1000000"),
    maxPricePerCall: amount(env, "X207_MAX_PRICE_PER_CALL", "100000"),
    allowedCounterparties: allowed,
    allowOutflows: env.X207_ALLOW_OUTFLOWS?.trim() === "1",
    allowFullAccessKey: env.X207_ALLOW_FULL_ACCESS_KEY?.trim() === "1",
    allowPrivateUrls: env.X207_ALLOW_PRIVATE_URLS?.trim() === "1",
  };
}

/**
 * A-SD-06: an unexpected error ("all RPC endpoints failed (https://rpc.example/v2/KEY: HTTP 500)") names the RPC URLs of the configuration, and those often carry an API key in the path or the query.
 * The model gets the origin only (user name, password, path and query are dropped), enough to tell which host failed.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)"',;]+/gi, (match) => {
    const tail = /[:.]+$/.exec(match)?.[0] ?? "";
    try {
      return `${new URL(match.slice(0, match.length - tail.length)).origin}${tail}`;
    } catch {
      return `<url>${tail}`;
    }
  });
}

/** Takes every secret of the write configuration out of a text, for the error of a tool and for the log. */
export function scrub(text: string, cfg: WriteConfig | null): string {
  let out = text;
  for (const secret of [cfg?.voucherKey, cfg?.nearKey, cfg?.evmKey]) if (secret) out = out.split(secret).join("[key]");
  return out.replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}/g, "[key]").replace(/0x[0-9a-fA-F]{64}/g, "[key]");
}
