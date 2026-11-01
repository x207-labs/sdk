// Facilitator `verify`: 19 cek berurutan, berhenti di penolakan pertama, tanpa mengubah state
// (Spec Binding x402 bagian 7, x402 v2 §7).
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  validatePaymentRequirements,
  validateX207Payload,
  verifyVoucher,
  type AccountId,
  type ContractAbi,
  type Voucher,
  type X207Payload,
} from "@x207/core";
import { X207_SCHEME, type CircleConfig } from "../shared/circle.js";
import { computeBase, computeHeadroom, type HeadroomSources } from "./headroom.js";

/** Bacaan on-chain yang dibutuhkan `verify`; kegagalan RPC harus berupa error yang dilempar. */
export interface VerifyChain extends HeadroomSources {
  member(account: AccountId): Promise<ContractAbi.MemberView | null>;
  /** View `get_epoch` tanpa argumen: epoch berjalan. */
  getEpoch(): Promise<ContractAbi.EpochView | null>;
}

export type VerifyOptions = {
  chain: VerifyChain;
  /** Unix ms. */
  now?: () => number;
  /** Jendela sebelum `cutoff_at` saat voucher baru ditolak (default 120 detik). */
  flushLeadSeconds?: number;
};

export const DEFAULT_FLUSH_LEAD_SECONDS = 120;
/** Registrasi gagal sebanyak ini atau lebih menahan voucher baru payer (ADR-23). */
export const REGISTRATION_RETRY_BLOCK_ATTEMPTS = 2;

const POSITIVE_UINT = /^[1-9]\d*$/;

const reject = (invalidReason: string, payer?: AccountId): VerifyResponse => ({
  isValid: false,
  invalidReason,
  ...(payer === undefined ? {} : { payer }),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

export async function verifyPayment(
  circle: CircleConfig,
  options: VerifyOptions,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  const { chain } = options;
  const now = options.now ?? Date.now;
  const flushLeadMs = (options.flushLeadSeconds ?? DEFAULT_FLUSH_LEAD_SECONDS) * 1000;
  const accepted = payload.accepted as unknown as Record<string, unknown> | undefined;

  // 1
  if (payload.x402Version !== 2) return reject("invalid_x402_version");
  // 2
  if (accepted?.scheme !== X207_SCHEME) return reject("unsupported_scheme");
  if (accepted.network !== circle.network) return reject("invalid_network");
  // 3
  if (!deepEqual(accepted, requirements)) return reject("invalid_payment_requirements");
  if (typeof requirements.amount !== "string" || !POSITIVE_UINT.test(requirements.amount)) {
    return reject("invalid_payment_requirements");
  }
  const checkedRequirements = validatePaymentRequirements(requirements);
  if (!checkedRequirements.ok) return reject("invalid_payment_requirements");
  const { extra, payTo } = checkedRequirements.value;
  // 4
  const checkedPayload = validateX207Payload(payload.payload);
  if (!checkedPayload.ok) return reject("invalid_payload");
  const { voucher, signature } = checkedPayload.value as X207Payload;
  const payer = voucher.payer;
  // 5
  if (voucher.circle !== extra.circleContract || extra.circleContract !== circle.circleContract) {
    return reject("circle_mismatch", payer);
  }
  // 6 (unit dan resource ASCII sudah dijaga skema di cek 4)
  if (voucher.payee !== payTo) return reject("payee_mismatch", payer);
  // 7
  if (voucher.payer === voucher.payee) return reject("self_payment", payer);

  // 8
  const epoch = await chain.getEpoch();
  if (!epoch) throw new Error("view get_epoch mengembalikan null");
  if (voucher.epoch !== extra.epoch || extra.epoch !== epoch.epoch) return reject("epoch_mismatch", payer);
  // 9
  const cutoffMs = Number(BigInt(epoch.cutoff_at) / 1_000_000n);
  if (epoch.phase !== "open" || now() >= cutoffMs - flushLeadMs) return reject("epoch_closing", payer);

  // 10-13
  const [payerMember, payeeMember] = await Promise.all([chain.member(payer), chain.member(voucher.payee)]);
  if (!payerMember) return reject("member_not_found", payer);
  if (payerMember.status !== "active") return reject("member_not_active", payer);
  if (!payeeMember || payeeMember.status !== "active") return reject("payee_not_active", payer);
  if (
    (payerMember.exit_requested_epoch ?? null) !== null ||
    (payeeMember.exit_requested_epoch ?? null) !== null
  ) {
    return reject("member_exiting", payer);
  }
  // 14
  if (!verifyVoucher({ ...voucher, signature } as Voucher, payerMember.pubkey_voucher)) {
    return reject("invalid_signature", payer);
  }
  // 15
  const pending = await chain.pendingByPayer(payer, voucher.epoch);
  if (pending.some((row) => (row.attempts ?? 0) >= REGISTRATION_RETRY_BLOCK_ATTEMPTS)) {
    return reject("registration_retry_pending", payer);
  }
  // 16, 17
  const base = await computeBase(payer, voucher.payee, voucher.epoch, chain);
  if (voucher.seq <= base.seq) return reject("seq_not_increasing", payer);
  const increment = BigInt(voucher.cumulativeAmount) - BigInt(base.cumulativeAmount);
  if (increment < 0n) return reject("cumulative_decreased", payer);
  // 18
  if (increment !== BigInt(requirements.amount)) return reject("amount_mismatch", payer);
  // 19
  if (increment > BigInt(await computeHeadroom(payer, voucher.epoch, chain))) {
    return reject("insufficient_credit", payer);
  }
  return { isValid: true, payer };
}
