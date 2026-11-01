// Helper pelunasan residual dan klaim (SD-014): msg `ft_transfer_call` aksi `settle` dan argumen `claim`.
// Bentuk dan nama persis Spec Antarmuka Kontrak 4.1 dan bagian method `claim` (ADR-19, ADR-24).
import { USDT_TOKEN_ID } from "../constants.js";
import type { AccountId, U128String } from "../types.js";

/** Gas minimal yang harus dilampirkan pada `claim` (100 TGas, Spec Antarmuka Kontrak; disetel di CT-043). */
export const CLAIM_MIN_GAS = 100_000_000_000_000n;
export const CLAIM_DESTINATIONS = ["near", "intents"] as const;
export type ClaimDestination = (typeof CLAIM_DESTINATIONS)[number];

/** Panggilan function call NEAR yang siap ditandatangani; `gas` kosong berarti penanda tangan yang memilih. */
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
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`epoch harus integer >= 1, dapat ${epoch}`);
}

/** `{"action":"settle","epoch":N}` atau dengan `member_id` untuk membayar atas nama anggota lain. */
export function buildSettleMsg(input: { epoch: number; memberId?: AccountId }): string {
  assertEpoch(input.epoch);
  if (input.memberId === undefined) return JSON.stringify({ action: "settle", epoch: input.epoch });
  if (!isAccount(input.memberId)) throw new Error(`memberId bukan akun NEAR: ${input.memberId}`);
  return JSON.stringify({ action: "settle", epoch: input.epoch, member_id: input.memberId });
}

/** `ft_transfer_call` USDT ke kontrak lingkaran dengan msg `settle` (deposit 1 yoctoNEAR, standar NEP-141). */
export function buildSettleTransferCall(input: {
  circleContract: AccountId;
  amount: U128String;
  epoch: number;
  memberId?: AccountId;
  usdtTokenId?: AccountId;
}): ContractCall {
  if (!/^[1-9]\d*$/.test(input.amount)) throw new Error(`amount harus string bilangan bulat > 0, dapat ${input.amount}`);
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

/** Argumen JSON `claim`; `destination` `near` (akun NEAR) atau `intents` (saldo Intents). */
export function buildClaimArgs(epoch: number, destination: ClaimDestination): { epoch: number; destination: ClaimDestination } {
  assertEpoch(epoch);
  if (!CLAIM_DESTINATIONS.includes(destination)) {
    throw new Error(`destination harus "near" atau "intents", dapat ${JSON.stringify(destination)}`);
  }
  return { epoch, destination };
}

/** Panggilan `claim`: deposit tepat 1 yoctoNEAR dan gas minimal `CLAIM_MIN_GAS`. */
export function buildClaimCall(input: { circleContract: AccountId; epoch: number; destination: ClaimDestination }): ContractCall {
  return {
    receiverId: input.circleContract,
    methodName: "claim",
    args: buildClaimArgs(input.epoch, input.destination),
    deposit: 1n,
    gas: CLAIM_MIN_GAS,
  };
}
