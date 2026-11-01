// `onboardMember` (SD-013): keypair voucher, join, stake lewat ft_transfer_call, tunggu `pending` jadi `active`.
import { generateVoucherKeypair, voucherPublicKey } from "../voucher.js";
import type { AccountId, U128String } from "../types.js";
import { buildJoinCall, buildStakeTransferCall, getMember, type CircleViewFn } from "./client.js";
import type { ContractCall } from "./settlement.js";
import type { MemberView } from "./types.generated.js";

export class OnboardTimeoutError extends Error {
  constructor(readonly status: string | null, timeoutMs: number) {
    super(`anggota belum active setelah ${timeoutMs} ms (status terakhir: ${status ?? "bukan anggota"})`);
    this.name = "OnboardTimeoutError";
  }
}

/** `ft_transfer_call` mengembalikan jumlah yang dipakai kontrak; kurang dari `amount` berarti sebagian di-refund. */
export class StakeRejectedError extends Error {
  constructor(readonly used: string, readonly amount: string) {
    super(`stake ditolak kontrak: terpakai ${used} dari ${amount} (sisanya di-refund; cek status anggota dan msg)`);
    this.name = "StakeRejectedError";
  }
}

export type OnboardDeps = {
  /** Kirim transaksi dari akun anggota dan kembalikan nilai sukses receipt (JSON). Melempar bila transaksi gagal. */
  sendCall(call: ContractCall): Promise<unknown>;
  view: CircleViewFn;
  /** Interval polling `member` (default 1000 ms). */
  pollIntervalMs?: number;
  /** Batas menunggu `active` (default 60000 ms). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type OnboardInput = {
  circleContract: AccountId;
  circleId: string;
  accountId: AccountId;
  /** sha256 hex huruf kecil dari syarat lingkaran. */
  termsHash: string;
  /** Jumlah USDT (satuan terkecil) yang dikunci sebagai stake. */
  stakeAmount: U128String;
  /** Kunci voucher yang sudah ada; bila kosong dibuat baru. */
  secretKey?: `ed25519:${string}`;
  usdtTokenId?: AccountId;
};

export type OnboardResult = { secretKey: `ed25519:${string}`; publicKey: `ed25519:${string}`; member: MemberView };

export async function onboardMember(deps: OnboardDeps, input: OnboardInput): Promise<OnboardResult> {
  const { secretKey, publicKey } = input.secretKey
    ? { secretKey: input.secretKey, publicKey: voucherPublicKey(input.secretKey) }
    : generateVoucherKeypair();

  await deps.sendCall(
    buildJoinCall({
      circleContract: input.circleContract, circleId: input.circleId, pubkeyVoucher: publicKey, termsHash: input.termsHash,
    }),
  );

  const used = await deps.sendCall(
    buildStakeTransferCall({
      circleContract: input.circleContract, amount: input.stakeAmount, memberId: input.accountId,
      ...(input.usdtTokenId ? { usdtTokenId: input.usdtTokenId } : {}),
    }),
  );
  if (typeof used === "string" && /^\d+$/.test(used) && BigInt(used) < BigInt(input.stakeAmount)) {
    throw new StakeRejectedError(used, input.stakeAmount);
  }

  const member = await waitUntilActive(deps, input.accountId);
  if (member.pubkey_voucher !== publicKey) {
    throw new Error(`pubkey_voucher di kontrak (${member.pubkey_voucher}) bukan kunci yang dibuat (${publicKey})`);
  }
  return { secretKey, publicKey, member };
}

async function waitUntilActive(deps: OnboardDeps, accountId: AccountId): Promise<MemberView> {
  const interval = deps.pollIntervalMs ?? 1000;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let last: MemberView | null = null;
  for (;;) {
    last = await getMember(deps.view, accountId);
    if (last?.status === "active") return last;
    if (now() >= deadline) throw new OnboardTimeoutError(last?.status ?? null, timeoutMs);
    await sleep(interval);
  }
}
