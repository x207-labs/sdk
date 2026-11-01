// Facilitator `settle` (flow `authorization`): jalankan ulang `verify`, simpan voucher terbaru pasangan
// ke pending store D3, jawab dengan commitment id (Spec Binding x402 4, 5.4, 8.2; ADR-17, ADR-31).
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  validateX207Payload,
  type AccountId,
  type Ed25519Signature,
  type RegistrationState,
  type U128String,
  type UnsignedVoucher,
} from "@x207/core";
import type { CircleConfig } from "../shared/circle.js";
import { computeBase } from "./headroom.js";
import { verifyPayment, type VerifyOptions } from "./verify.js";

/** Baris pending store D3 yang dibutuhkan `settle`. */
export type PendingVoucherRecord = {
  seq: number;
  cumulativeAmount: U128String;
  signature: Ed25519Signature;
  registeredSeq: number;
  /** Percobaan registrasi yang gagal. */
  attempts: number;
};

export interface PendingWriter {
  /** Simpan hanya bila `seq` lebih besar dari yang tersimpan; `false` bila tidak ada perubahan. */
  save(voucher: UnsignedVoucher, signature: Ed25519Signature): boolean | Promise<boolean>;
  get(payer: AccountId, payee: AccountId, epoch: number): PendingVoucherRecord | null | Promise<PendingVoucherRecord | null>;
}

export type SettleOptions = VerifyOptions & { store: PendingWriter };

/** Penolakan yang membawa data resinkronisasi klien (K-29). */
const RESYNC_REASONS = new Set(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"]);

/** `registered` bila `registered_seq` sudah menyusul, `retrying` sejak percobaan gagal pertama (K-31). */
export function registrationState(row: PendingVoucherRecord): RegistrationState {
  if (row.registeredSeq >= row.seq) return "registered";
  return row.attempts >= 1 ? "retrying" : "pending";
}

const commitmentId = (v: UnsignedVoucher) => `${v.payer}:${v.payee}:${v.epoch}:${v.seq}` as const;

function succeeded(circle: CircleConfig, voucher: UnsignedVoucher, row: PendingVoucherRecord): SettleResponse {
  return {
    success: true,
    transaction: commitmentId(voucher),
    network: circle.network,
    payer: voucher.payer,
    extensions: {
      x207: {
        epoch: voucher.epoch,
        seq: voucher.seq,
        cumulativeAmount: voucher.cumulativeAmount,
        registration: registrationState(row),
      },
    },
  };
}

export async function settlePayment(
  circle: CircleConfig,
  options: SettleOptions,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const failed = (errorReason: string, payer?: AccountId, resync?: Record<string, unknown>): SettleResponse => ({
    success: false,
    errorReason,
    transaction: "",
    network: circle.network,
    ...(payer === undefined ? {} : { payer }),
    ...(resync ? { extensions: { x207: resync } } : {}),
  });

  const parsed = validateX207Payload(payload.payload);
  if (parsed.ok) {
    // Idempoten per commitment id: payload yang persis sama dengan baris tersimpan menjawab hasil yang sama.
    const { voucher, signature } = parsed.value;
    const stored = await options.store.get(voucher.payer, voucher.payee, voucher.epoch);
    if (
      stored &&
      stored.seq === voucher.seq &&
      stored.cumulativeAmount === voucher.cumulativeAmount &&
      stored.signature === signature
    ) {
      return succeeded(circle, voucher, stored);
    }
  }

  const verdict = await verifyPayment(circle, options, payload, requirements);
  if (!verdict.isValid) {
    const reason = verdict.invalidReason ?? "invalid_payload";
    let resync: Record<string, unknown> | undefined;
    if (parsed.ok && RESYNC_REASONS.has(reason)) {
      const { voucher } = parsed.value;
      const base = await computeBase(voucher.payer, voucher.payee, voucher.epoch, options.chain);
      resync = { epoch: voucher.epoch, lastSeq: base.seq, lastCumulativeAmount: base.cumulativeAmount };
    }
    return failed(reason, verdict.payer, resync);
  }

  if (!parsed.ok) throw new Error("payload lolos verify tetapi gagal skema X207Payload");
  const { voucher, signature } = parsed.value;
  if (!(await options.store.save(voucher, signature))) {
    // Settle paralel untuk pasangan yang sama sudah menyimpan seq yang sama atau lebih tinggi.
    const base = await computeBase(voucher.payer, voucher.payee, voucher.epoch, options.chain);
    return failed("seq_not_increasing", voucher.payer, {
      epoch: voucher.epoch,
      lastSeq: base.seq,
      lastCumulativeAmount: base.cumulativeAmount,
    });
  }
  const row = await options.store.get(voucher.payer, voucher.payee, voucher.epoch);
  if (!row) throw new Error("baris pending hilang setelah disimpan");
  return succeeded(circle, voucher, row);
}
