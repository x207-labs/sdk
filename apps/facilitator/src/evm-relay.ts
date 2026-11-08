// Relayer for EVM agents (SD-089): `POST /evm/join`, `/evm/claim`, `/evm/exit`, `/evm/withdraw`. The agent holds only a `0x` key. It signs an EIP-712 `Action` (design note "x207 - Desain Agent EVM"),
// sends the signature here, and this relayer sends the NEAR transaction `join_evm`, `claim_evm`, `request_exit_evm` or `withdraw_stake_evm` and pays the gas. For a join it also attaches the
// storage deposit (0.35 NEAR); the contract records the relayer account as `sponsor` and returns the deposit to it when the member has left.
//
// Why a request cannot drain the relayer: (1) the signature is checked here with viem before anything is sent, so a forged request costs nothing; (2) a rate limit per address and per client;
// (3) a cap on sponsored joins per hour for the whole relayer (each join costs 0.35 NEAR of deposit that comes back only on exit); (4) a signature has a `deadline` and a `nonce`, so a replay is refused
// by the contract itself (`ERR_EVM_NONCE`, `ERR_EVM_EXPIRED`) after it has cost one failed transaction, which the per-address limit bounds.
import { verifyEvmAction, isEvmMemberId, type EvmAction } from "@x207/core/evm";
import { EIP712_SIGNATURE_PATTERN, type AccountId } from "@x207/core";
import { RateLimiter } from "./exact-guard.js";

/** Deposit that `join_evm` needs and the relayer attaches: 0.35 NEAR in yoctoNEAR (`JOIN_STORAGE_DEPOSIT` of the contract). */
export const EVM_JOIN_DEPOSIT = 350_000_000_000_000_000_000_000n;
export const EVM_RELAY_GAS = 100_000_000_000_000n;

/** Sends one transaction from the relayer account and waits for final. Throws an `Error` whose message holds the contract `ERR_*` text on failure. */
export interface EvmCaller {
  /** `receiverId` defaults to the circle contract; the stake goes to the token contract. */
  call(method: string, args: Record<string, unknown>, deposit: bigint, receiverId?: string): Promise<{ hash: string }>;
}

export type EvmRelayOptions = {
  circleContract: AccountId;
  caller: EvmCaller;
  now?: () => number;
  /** Requests per address per window, default 10 per minute. */
  perAddress?: { max: number; windowMs?: number };
  /** Most joins the relayer sponsors in one hour (default 20). */
  maxJoinsPerHour?: number;
  /**
   * Security review M3: a signed `request_exit` (or any action) stays valid until its `deadline`, so a deadline far in the future is a long-lived exit ticket in the wrong hands.
   * With this set (ms), a deadline more than this far ahead of now is refused as `deadline_too_far`. Off when absent (`main.ts` turns it on, 15 minutes by default).
   */
  maxDeadlineMs?: number;
  /**
   * Testnet and sandbox: after `join_evm` the relayer stakes `amount` of `tokenId` (a mock USDT it holds) for the new member (`ft_transfer_call` with `member_id`), so the member is `active`
   * in the same request. On mainnet the stake comes through Intents instead (design note, "Rute dana dari EVM"), so this is off by default.
   */
  stake?: { tokenId: AccountId; amount: string };
  /**
   * SD-100: the circle is contract 0.0.16, where every signed `Action` has the ninth field `maxFee`. `claim` and `withdraw` then need `maxFee` in the body (a decimal string of the credit unit),
   * which is checked against the signature and passed on as the argument `max_fee`; the other routes verify with `maxFee` 0 (the contract signs 0 for them) and a `maxFee` in their body is refused.
   * Off (default) for 0.0.14 and 0.0.15: the eight-field `Action`, and a `maxFee` in the body is refused.
   * A-SD-01 (contract 0.0.17): `"all"` also takes `maxFee` on `exit` and `autoSettle` (`request_exit_evm` and `set_auto_settle_evm` have the required argument `max_fee`);
   * only `join` signs 0. `true` stays the 0.0.16 behaviour (claim and withdraw only). `feeModeFor(interface_version)` picks the value from the circle.
   */
  withMaxFee?: boolean | "all";
};

/** A-SD-01: the `withMaxFee` option for the `interface_version` view of a circle: 0.0.17 and later `"all"`, 0.0.16 `true`, older `false`. Unknown text gives `false`. */
export function feeModeFor(interfaceVersion: string): boolean | "all" {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(interfaceVersion);
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major > 0 || minor > 0 || patch >= 17) return "all";
  return patch === 16 ? true : false;
}

export class EvmRelayError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 502 | 503, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "EvmRelayError";
  }
}

export type EvmRelayResult = { ok: true; method: string; txHash: string; stakeTxHash?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TERMS_HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_U64_SAFE = Number.MAX_SAFE_INTEGER;

function address(body: Record<string, unknown>, field: string): `0x${string}` {
  const value = body[field];
  if (!isEvmMemberId(value)) throw new EvmRelayError(400, "invalid_request", `${field} must be a lower-case 0x address (42 characters)`);
  return value;
}
function uint(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_U64_SAFE) throw new EvmRelayError(400, "invalid_request", `${field} must be an integer >= 0`);
  return value;
}
function account(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !ACCOUNT.test(value)) throw new EvmRelayError(400, "invalid_request", `${field} must be a NEAR account id`);
  return value;
}
function signature(body: Record<string, unknown>): `eip712:0x${string}` {
  const value = body.signature;
  if (typeof value !== "string" || !EIP712_SIGNATURE_PATTERN.test(value)) throw new EvmRelayError(400, "invalid_request", "signature must be eip712:0x followed by 130 hex characters");
  return value as `eip712:0x${string}`;
}

/** Contract panic text to HTTP answer. */
function failure(error: unknown): EvmRelayError {
  const text = error instanceof Error ? error.message : String(error);
  const table: Array<[string, EvmRelayError["status"], string]> = [
    ["ERR_BAD_EVM_SIG", 400, "bad_signature"], ["ERR_EVM_EXPIRED", 400, "expired"], ["ERR_BAD_EVM_ADDRESS", 400, "invalid_request"],
    ["ERR_BAD_TERMS_HASH", 400, "invalid_request"], ["ERR_BAD_EVM_RECEIVER", 400, "bad_receiver"], ["ERR_EVM_NONCE", 409, "bad_nonce"],
    ["ERR_ALREADY_MEMBER", 409, "already_member"], ["ERR_NOT_EVM_MEMBER", 404, "not_evm_member"], ["ERR_MAX_MEMBERS", 409, "circle_full"],
  ];
  for (const [marker, status, code] of table) if (text.includes(marker)) return new EvmRelayError(status, code, text.slice(0, 300));
  const other = /ERR_[A-Z_]+/.exec(text)?.[0];
  return new EvmRelayError(502, other ? `contract_${other.toLowerCase()}` : "relay_failed", text.slice(0, 300));
}

export class EvmRelay {
  readonly #o: EvmRelayOptions;
  readonly #now: () => number;
  readonly #perAddress: RateLimiter;
  readonly #joins: number[] = [];

  constructor(options: EvmRelayOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#perAddress = new RateLimiter({ max: options.perAddress?.max ?? 10, windowMs: options.perAddress?.windowMs ?? 60_000, now: this.#now });
  }

  /** The `maxFee` of the signed message: nothing for 0.0.14/0.0.15; for 0.0.16 `0` unless the route takes a fee (`claim`, `withdraw`), where it must be in the body. */
  #fee(body: Record<string, unknown>, takesFee: boolean): { signed: { maxFee?: string }; arg: { max_fee?: string } } {
    const given = body.maxFee;
    if (!this.#o.withMaxFee) {
      if (given !== undefined) throw new EvmRelayError(400, "invalid_request", "this circle does not take maxFee");
      return { signed: {}, arg: {} };
    }
    if (!takesFee) {
      if (given !== undefined) throw new EvmRelayError(400, "invalid_request", "this route does not take maxFee");
      return { signed: { maxFee: "0" }, arg: {} };
    }
    const text = typeof given === "number" && Number.isSafeInteger(given) && given >= 0 ? String(given) : given;
    if (typeof text !== "string" || !/^(0|[1-9]\d{0,38})$/.test(text)) throw new EvmRelayError(400, "invalid_request", "maxFee must be a non-negative integer (a decimal string)");
    return { signed: { maxFee: text }, arg: { max_fee: text } };
  }

  async #send(who: string, action: EvmAction, expectedSignedBy: Record<string, unknown>, deadline: number, sig: `eip712:0x${string}`, method: string, args: Record<string, unknown>, deposit = 0n): Promise<EvmRelayResult> {
    const wait = this.#perAddress.hit(who);
    if (wait > 0) throw new EvmRelayError(429, "rate_limited", "too many requests for this address", Math.max(1, Math.ceil(wait / 1000)));
    if (this.#now() > deadline) throw new EvmRelayError(400, "expired", "deadline has passed");
    if (this.#o.maxDeadlineMs !== undefined && deadline > this.#now() + this.#o.maxDeadlineMs) throw new EvmRelayError(400, "deadline_too_far", `the deadline must be at most ${Math.round(this.#o.maxDeadlineMs / 1000)} seconds ahead`);
    const ok = await verifyEvmAction({ circle: this.#o.circleContract, action, ...expectedSignedBy } as never, sig);
    if (!ok) throw new EvmRelayError(400, "bad_signature", "the signature is not valid for this action, circle and member");
    try {
      const { hash } = await this.#o.caller.call(method, args, deposit);
      return { ok: true, method, txHash: hash };
    } catch (error) {
      throw failure(error);
    }
  }

  /** Body: `{ address, termsHash, deadline, signature }`. The first action of a new member carries nonce 0. */
  async join(body: unknown): Promise<EvmRelayResult> {
    if (!isRecord(body)) throw new EvmRelayError(400, "invalid_request", "body must be a JSON object");
    const who = address(body, "address");
    const termsHash = body.termsHash;
    if (typeof termsHash !== "string" || !TERMS_HASH.test(termsHash)) throw new EvmRelayError(400, "invalid_request", "termsHash must be 64 lower-case hex characters");
    const deadline = uint(body, "deadline");
    const sig = signature(body);
    const now = this.#now();
    while (this.#joins.length > 0 && now - (this.#joins[0] as number) >= 3_600_000) this.#joins.shift();
    if (this.#joins.length >= (this.#o.maxJoinsPerHour ?? 20)) throw new EvmRelayError(503, "join_budget_used", "this relayer has sponsored its joins for this hour; try later", 600);
    const fee = this.#fee(body, false);
    const result = await this.#send(who, "join", { member: who, epoch: 0, receiver: "", termsHash, nonce: 0, deadline, ...fee.signed }, deadline, sig, "join_evm", { address: who, terms_hash: termsHash, deadline, signature: sig }, EVM_JOIN_DEPOSIT);
    this.#joins.push(now);
    const stake = this.#o.stake;
    if (stake === undefined) return result;
    try {
      const staked = await this.#o.caller.call("ft_transfer_call", { receiver_id: this.#o.circleContract, amount: stake.amount, msg: JSON.stringify({ action: "stake", member_id: who }) }, 1n, stake.tokenId);
      return { ...result, stakeTxHash: staked.hash };
    } catch (error) {
      throw new EvmRelayError(502, "stake_failed", `joined, but the stake transfer failed: ${(error as Error).message}`.slice(0, 300));
    }
  }

  /** Body: `{ member, epoch, receiver, nonce, deadline, signature }`. */
  async claim(body: unknown): Promise<EvmRelayResult> {
    if (!isRecord(body)) throw new EvmRelayError(400, "invalid_request", "body must be a JSON object");
    const member = address(body, "member");
    const epoch = uint(body, "epoch");
    const receiver = account(body, "receiver");
    const nonce = uint(body, "nonce");
    const deadline = uint(body, "deadline");
    const sig = signature(body);
    const fee = this.#fee(body, true);
    return this.#send(member, "claim", { member, epoch, receiver, termsHash: "", nonce, deadline, ...fee.signed }, deadline, sig, "claim_evm", { member, epoch, receiver, nonce, deadline, ...fee.arg, signature: sig });
  }

  /** Body: `{ member, nonce, deadline, signature }`. */
  async exit(body: unknown): Promise<EvmRelayResult> {
    if (!isRecord(body)) throw new EvmRelayError(400, "invalid_request", "body must be a JSON object");
    const member = address(body, "member");
    const nonce = uint(body, "nonce");
    const deadline = uint(body, "deadline");
    const sig = signature(body);
    const fee = this.#fee(body, this.#o.withMaxFee === "all");
    return this.#send(member, "request_exit", { member, epoch: 0, receiver: "", termsHash: "", nonce, deadline, ...fee.signed }, deadline, sig, "request_exit_evm", { member, nonce, deadline, ...fee.arg, signature: sig });
  }

  /** Body: `{ member, receiver, nonce, deadline, signature }`. */
  async withdraw(body: unknown): Promise<EvmRelayResult> {
    if (!isRecord(body)) throw new EvmRelayError(400, "invalid_request", "body must be a JSON object");
    const member = address(body, "member");
    const receiver = account(body, "receiver");
    const nonce = uint(body, "nonce");
    const deadline = uint(body, "deadline");
    const sig = signature(body);
    const fee = this.#fee(body, true);
    return this.#send(member, "withdraw_stake", { member, epoch: 0, receiver, termsHash: "", nonce, deadline, ...fee.signed }, deadline, sig, "withdraw_stake_evm", { member, receiver, nonce, deadline, ...fee.arg, signature: sig });
  }

  /** CT-108 (contract 0.0.15). Body: `{ member, enabled, nonce, deadline, signature }`; the signed action is `auto_settle` when `enabled` is true and `auto_settle_off` when false. */
  async autoSettle(body: unknown): Promise<EvmRelayResult> {
    if (!isRecord(body)) throw new EvmRelayError(400, "invalid_request", "body must be a JSON object");
    const member = address(body, "member");
    if (typeof body.enabled !== "boolean") throw new EvmRelayError(400, "invalid_request", "enabled must be true or false");
    const enabled = body.enabled;
    const nonce = uint(body, "nonce");
    const deadline = uint(body, "deadline");
    const sig = signature(body);
    const fee = this.#fee(body, this.#o.withMaxFee === "all");
    return this.#send(member, enabled ? "auto_settle" : "auto_settle_off", { member, epoch: 0, receiver: "", termsHash: "", nonce, deadline, ...fee.signed }, deadline, sig, "set_auto_settle_evm", { member, enabled, nonce, deadline, ...fee.arg, signature: sig });
  }
}
