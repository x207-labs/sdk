// Residual settlement and claim helpers (SD-014): the `ft_transfer_call` msg of the `settle` action and the `claim` arguments.
// Shapes and names exactly as Contract Interface Spec 4.1 and the `claim` method section (ADR-19, ADR-24).
import { USDT_TOKEN_ID } from "../constants.js";
import type { AccountId, U128String } from "../types.js";

/** Minimum gas that must be attached to `claim` (100 TGas, Contract Interface Spec; tuned in CT-043). */
export const CLAIM_MIN_GAS = 100_000_000_000_000n;
export const CLAIM_DESTINATIONS = ["near", "intents"] as const;
export type ClaimDestination = (typeof CLAIM_DESTINATIONS)[number];

/** NEAR function call ready to sign; empty `gas` means the signer chooses. */
export type ContractCall = {
  receiverId: AccountId;
  methodName: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas?: bigint;
};

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (value: string): boolean => value.length >= 2 && value.length <= 64 && ACCOUNT.test(value);

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`epoch must be an integer >= 1, got ${epoch}`);
}

/** `{"action":"settle","epoch":N}` or with `member_id` to pay on behalf of another member. */
export function buildSettleMsg(input: { epoch: number; memberId?: AccountId }): string {
  assertEpoch(input.epoch);
  if (input.memberId === undefined) return JSON.stringify({ action: "settle", epoch: input.epoch });
  if (!isAccount(input.memberId)) throw new Error(`memberId is not a NEAR account: ${input.memberId}`);
  return JSON.stringify({ action: "settle", epoch: input.epoch, member_id: input.memberId });
}

/** `ft_transfer_call` USDT to the circle contract with msg `settle` (deposit 1 yoctoNEAR, NEP-141 standard). */
export function buildSettleTransferCall(input: {
  circleContract: AccountId;
  amount: U128String;
  epoch: number;
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
      msg: buildSettleMsg({ epoch: input.epoch, ...(input.memberId !== undefined ? { memberId: input.memberId } : {}) }),
    },
    deposit: 1n,
  };
}

/** JSON arguments of `claim`; `destination` is `near` (NEAR account) or `intents` (Intents balance). */
export function buildClaimArgs(epoch: number, destination: ClaimDestination): { epoch: number; destination: ClaimDestination } {
  assertEpoch(epoch);
  if (!CLAIM_DESTINATIONS.includes(destination)) {
    throw new Error(`destination must be "near" or "intents", got ${JSON.stringify(destination)}`);
  }
  return { epoch, destination };
}

/** `claim` call: exactly 1 yoctoNEAR deposit and minimum gas `CLAIM_MIN_GAS`. */
export function buildClaimCall(input: { circleContract: AccountId; epoch: number; destination: ClaimDestination }): ContractCall {
  return {
    receiverId: input.circleContract,
    methodName: "claim",
    args: buildClaimArgs(input.epoch, input.destination),
    deposit: 1n,
    gas: CLAIM_MIN_GAS,
  };
}
