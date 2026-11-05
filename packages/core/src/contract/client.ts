// `x207-circle` contract client (SD-012): join, stake via ft_transfer_call, and the `member` view.
// Only builds calls and reads views through injected functions; the transaction signer
// and RPC are chosen by the caller, so this entry does not pull in near-api-js.
import { base58Decode } from "../base58.js";
import { JOIN_STORAGE_DEPOSIT, USDT_TOKEN_ID, formatNear } from "../constants.js";
import type { AccountId, U128String } from "../types.js";
import type { MemberView } from "./types.generated.js";
import type { ContractCall } from "./settlement.js";


const TERMS_HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (value: string): boolean => value.length >= 2 && value.length <= 64 && ACCOUNT.test(value);

function assertVoucherPublicKey(key: string): void {
  let bytes: Uint8Array | undefined;
  try {
    if (key.startsWith("ed25519:")) bytes = base58Decode(key.slice("ed25519:".length));
  } catch {
    bytes = undefined;
  }
  if (bytes?.length !== 32) throw new Error(`pubkey_voucher must be ed25519:<base58 32 bytes>, got ${JSON.stringify(key)}`);
}

/** `join(circle_id, pubkey_voucher, terms_hash)` with storage deposit. `circleContract` = receiving contract account. */
export function buildJoinCall(input: {
  circleContract: AccountId;
  circleId: string;
  pubkeyVoucher: string;
  /** lowercase sha256 hex (64 characters) of the circle terms. */
  termsHash: string;
  /** More than the minimum if desired; the excess is refunded by the contract. */
  deposit?: bigint;
}): ContractCall {
  if (!TERMS_HASH.test(input.termsHash)) {
    throw new Error("terms_hash must be 64 lowercase hex characters (sha256)");
  }
  assertVoucherPublicKey(input.pubkeyVoucher);
  const deposit = input.deposit ?? JOIN_STORAGE_DEPOSIT;
  if (deposit < JOIN_STORAGE_DEPOSIT) throw new Error(`deposit is below JOIN_STORAGE_DEPOSIT (${formatNear(JOIN_STORAGE_DEPOSIT)} NEAR)`);
  return {
    receiverId: input.circleContract,
    methodName: "join",
    args: { circle_id: input.circleId, pubkey_voucher: input.pubkeyVoucher, terms_hash: input.termsHash },
    deposit,
  };
}

/** `{"action":"stake"}`, or with `member_id` to fund another agent's stake. */
export function buildStakeMsg(input: { memberId?: AccountId } = {}): string {
  if (input.memberId === undefined) return JSON.stringify({ action: "stake" });
  if (!isAccount(input.memberId)) throw new Error(`memberId is not a NEAR account: ${input.memberId}`);
  return JSON.stringify({ action: "stake", member_id: input.memberId });
}

/** `ft_transfer_call` USDT to the contract with msg `stake`; deposit 1 yoctoNEAR (NEP-141). */
export function buildStakeTransferCall(input: {
  circleContract: AccountId;
  amount: U128String;
  memberId?: AccountId;
  usdtTokenId?: AccountId;
}): ContractCall {
  if (!/^[1-9]\d*$/.test(input.amount)) throw new Error(`amount must be an integer string > 0, got ${input.amount}`);
  return {
    receiverId: input.usdtTokenId ?? USDT_TOKEN_ID,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: input.circleContract,
      amount: input.amount,
      msg: buildStakeMsg(input.memberId === undefined ? {} : { memberId: input.memberId }),
    },
    deposit: 1n,
  };
}

/** Calls a contract view: `(method name, JSON arguments) -> JSON result`. */
export type CircleViewFn = (methodName: string, args: object) => Promise<unknown>;

/** View `member(account_id)`; `null` if not a member (not an error). */
export async function getMember(view: CircleViewFn, accountId: AccountId): Promise<MemberView | null> {
  const result = await view("member", { account_id: accountId });
  return (result ?? null) as MemberView | null;
}

/**
 * CT-108 (contract 0.0.15): `set_auto_settle(enabled)` for a member with a NEAR account. When on, a member that misses its `due` in the payment window is paid from its own stake by
 * `finalize_epoch` and stays `active` (instead of the default path). EVM members use the relayer route `/evm/auto-settle` with an `Action` signature instead.
 */
export function buildSetAutoSettleCall(input: { circleContract: AccountId; enabled: boolean }): ContractCall {
  return { receiverId: input.circleContract, methodName: "set_auto_settle", args: { enabled: input.enabled }, deposit: 1n, gas: 30_000_000_000_000n };
}

/** View `is_auto_settle(account_id)` (contract 0.0.15); `false` for an account that never opted in. */
export async function getAutoSettle(view: CircleViewFn, accountId: AccountId): Promise<boolean> {
  return (await view("is_auto_settle", { account_id: accountId })) === true;
}

/** The contract `ERR_*` code from a panic message (`ERR_CODE: detail`), or `null`. */
export function contractErrorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /\bERR_[A-Z0-9_]+\b/.exec(text)?.[0] ?? null;
}

/** `request_exit()` with no arguments, deposit 1 yoctoNEAR (ADR-29). */
export function buildRequestExitCall(circleContract: AccountId): ContractCall {
  return { receiverId: circleContract, methodName: "request_exit", args: {}, deposit: 1n };
}

/** `remove_intent(intent_hash)` (interface 0.0.8): the intent owner withdraws it and gets its slot back; not payable. */
export function buildRemoveIntentCall(circleContract: AccountId, intentHashBase58: string): ContractCall {
  return { receiverId: circleContract, methodName: "remove_intent", args: { intent_hash: intentHashBase58 }, deposit: 0n };
}

/**
 * `withdraw_intents_balance()` (interface 0.0.9): permissionless; moves the USDT recorded by `mt_on_transfer` (residual paid through
 * Intents) from the Intents contract to the USDT contract. Needs at least 130 Tgas (`ERR_GAS_TOO_LOW`), so 150 Tgas; other answers:
 * `ERR_WITHDRAW_IN_FLIGHT`, `ERR_NOTHING_TO_WITHDRAW`. Not payable.
 */
export function buildWithdrawIntentsBalanceCall(circleContract: AccountId): ContractCall {
  return { receiverId: circleContract, methodName: "withdraw_intents_balance", args: {}, deposit: 0n, gas: 150_000_000_000_000n };
}

/** `withdraw_stake()` with no arguments, deposit 1 yoctoNEAR (ADR-29); the contract may answer `ERR_EXIT_NOT_READY` or `ERR_HAS_DUE`. */
export function buildWithdrawStakeCall(circleContract: AccountId): ContractCall {
  return { receiverId: circleContract, methodName: "withdraw_stake", args: {}, deposit: 1n, gas: 100_000_000_000_000n };
}

/** View `outstanding_debt(account_id)` as a U128 string. */
export async function getOutstandingDebt(view: CircleViewFn, accountId: AccountId): Promise<U128String> {
  return String(await view("outstanding_debt", { account_id: accountId }));
}
