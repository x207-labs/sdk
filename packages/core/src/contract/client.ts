// Client kontrak `x207-circle` (SD-012): join, stake lewat ft_transfer_call, dan view `member`.
// Hanya membangun panggilan dan membaca view lewat fungsi yang disuntik; penanda tangan transaksi
// dan RPC dipilih pemanggil, sehingga entry ini tidak menarik near-api-js.
import { base58Decode } from "../base58.js";
import { USDT_TOKEN_ID } from "../constants.js";
import type { AccountId, U128String } from "../types.js";
import type { MemberView } from "./types.generated.js";
import type { ContractCall } from "./settlement.js";

/** `JOIN_STORAGE_DEPOSIT`: 0,01 NEAR dalam yoctoNEAR (Spec Antarmuka Kontrak, method `join`). */
export const JOIN_STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n;

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
  if (bytes?.length !== 32) throw new Error(`pubkey_voucher harus ed25519:<base58 32 byte>, dapat ${JSON.stringify(key)}`);
}

/** `join(circle_id, pubkey_voucher, terms_hash)` dengan deposit storage. `circleContract` = akun kontrak penerima. */
export function buildJoinCall(input: {
  circleContract: AccountId;
  circleId: string;
  pubkeyVoucher: string;
  /** sha256 hex huruf kecil (64 karakter) dari syarat lingkaran. */
  termsHash: string;
  /** Lebih dari minimum bila diinginkan; kelebihan dikembalikan kontrak. */
  deposit?: bigint;
}): ContractCall {
  if (!TERMS_HASH.test(input.termsHash)) {
    throw new Error("terms_hash harus 64 karakter hex huruf kecil (sha256)");
  }
  assertVoucherPublicKey(input.pubkeyVoucher);
  const deposit = input.deposit ?? JOIN_STORAGE_DEPOSIT;
  if (deposit < JOIN_STORAGE_DEPOSIT) throw new Error("deposit kurang dari JOIN_STORAGE_DEPOSIT (0,01 NEAR)");
  return {
    receiverId: input.circleContract,
    methodName: "join",
    args: { circle_id: input.circleId, pubkey_voucher: input.pubkeyVoucher, terms_hash: input.termsHash },
    deposit,
  };
}

/** `{"action":"stake"}`, atau dengan `member_id` untuk mendanai stake agent lain. */
export function buildStakeMsg(input: { memberId?: AccountId } = {}): string {
  if (input.memberId === undefined) return JSON.stringify({ action: "stake" });
  if (!isAccount(input.memberId)) throw new Error(`memberId bukan akun NEAR: ${input.memberId}`);
  return JSON.stringify({ action: "stake", member_id: input.memberId });
}

/** `ft_transfer_call` USDT ke kontrak dengan msg `stake`; deposit 1 yoctoNEAR (NEP-141). */
export function buildStakeTransferCall(input: {
  circleContract: AccountId;
  amount: U128String;
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
      msg: buildStakeMsg(input.memberId === undefined ? {} : { memberId: input.memberId }),
    },
    deposit: 1n,
  };
}

/** Memanggil view kontrak: `(nama method, argumen JSON) -> hasil JSON`. */
export type CircleViewFn = (methodName: string, args: object) => Promise<unknown>;

/** View `member(account_id)`; `null` bila bukan anggota (bukan error). */
export async function getMember(view: CircleViewFn, accountId: AccountId): Promise<MemberView | null> {
  const result = await view("member", { account_id: accountId });
  return (result ?? null) as MemberView | null;
}

/** Kode `ERR_*` kontrak dari pesan panic (`ERR_KODE: detail`), atau `null`. */
export function contractErrorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /\bERR_[A-Z0-9_]+\b/.exec(text)?.[0] ?? null;
}
