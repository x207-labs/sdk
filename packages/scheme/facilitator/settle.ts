// Facilitator `settle` (`authorization` flow): re-run `verify`, store the latest voucher of the pair
// to the D3 pending store, answer with the commitment id (Spec Binding x402 4, 5.4, 8.2; ADR-17, ADR-31).
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

/** D3 pending store row needed by `settle`. */
export type PendingVoucherRecord = {
  seq: number;
  cumulativeAmount: U128String;
  signature: Ed25519Signature;
  registeredSeq: number;
  /** Failed registration attempts. */
  attempts: number;
  bundleId?: number | null;
};

export interface PendingWriter {
  /** Store only if `seq` is greater than the stored one; `false` if nothing changed. */
  save(voucher: UnsignedVoucher, signature: Ed25519Signature, bundleId?: number): boolean | Promise<boolean>;
  get(payer: AccountId, payee: AccountId, epoch: number): PendingVoucherRecord | null | Promise<PendingVoucherRecord | null>;
}

export type SettleOptions = VerifyOptions & { store: PendingWriter };

/** Rejection that carries client resync data (K-29). */
const RESYNC_REASONS = new Set(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"]);

/** `registered` if `registered_seq` has caught up, `retrying` since the first failed attempt (K-31). */
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
    // Idempotent per commitment id: a payload identical to the stored row answers with the same result.
    const { voucher, signature, bundleId } = parsed.value;
    const stored = await options.store.get(voucher.payer, voucher.payee, voucher.epoch);
    if (
      stored &&
      stored.seq === voucher.seq &&
      stored.cumulativeAmount === voucher.cumulativeAmount &&
      stored.signature === signature &&
      (stored.bundleId ?? undefined) === bundleId
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

  if (!parsed.ok) throw new Error("payload passed verify but failed the X207Payload schema");
  const { voucher, signature, bundleId } = parsed.value;
  if (!(await (bundleId === undefined ? options.store.save(voucher, signature) : options.store.save(voucher, signature, bundleId)))) {
    // A parallel settle for the same pair has already stored the same seq or a higher one.
    const base = await computeBase(voucher.payer, voucher.payee, voucher.epoch, options.chain);
    return failed("seq_not_increasing", voucher.payer, {
      epoch: voucher.epoch,
      lastSeq: base.seq,
      lastCumulativeAmount: base.cumulativeAmount,
    });
  }
  const row = await options.store.get(voucher.payer, voucher.payee, voucher.epoch);
  if (!row) throw new Error("pending row is missing after it was saved");
  return succeeded(circle, voucher, row);
}
