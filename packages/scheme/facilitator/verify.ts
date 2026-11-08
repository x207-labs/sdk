// Facilitator `verify`: 19 sequential checks, stops at the first rejection, without changing state
// (x402 Binding Spec section 7, x402 v2 §7).
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  grantResource,
  validatePaymentRequirements,
  validateX207Payload,
  verifyVoucher,
  type AccountId,
  type ContractAbi,
  type Voucher,
  type X207Payload,
} from "@x207/core";
import { isEip712Signature, verifyEvmVoucher } from "@x207/core/evm";
import { X207_SCHEME, type CircleConfig } from "../shared/circle.js";
import { computeBase, computeHeadroom, type HeadroomSources } from "./headroom.js";

/** On-chain reads needed by `verify`; RPC failures must be thrown errors. */
export interface VerifyChain extends HeadroomSources {
  member(account: AccountId): Promise<ContractAbi.MemberView | null>;
  /** View `get_epoch` with no arguments: the current epoch. */
  getEpoch(): Promise<ContractAbi.EpochView | null>;
  /** View `get_bundle(bundle_id)` (interface 0.0.4); needed only for bundle leg vouchers (SD-048). */
  bundle?(bundleId: number): Promise<ContractAbi.BundleView | null>;
  /** View `is_frozen(account_id)` (interface 0.0.12, CT-095, SD-074); without this function freezing is not checked (contract 0.0.11 or older). */
  isFrozen?(account: AccountId): Promise<boolean>;
}

export type VerifyOptions = {
  chain: VerifyChain;
  /** Unix ms. */
  now?: () => number;
  /** Window before `cutoff_at` when new vouchers are rejected (default 120 seconds). */
  flushLeadSeconds?: number;
};

export const DEFAULT_FLUSH_LEAD_SECONDS = 120;
/** This many registration failures or more hold the payer's new vouchers (ADR-23). */
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

/**
 * A-SD-12: the checks of `verifyPayment` that need no chain and no store (version, scheme, network, requirements equal to what was accepted, circle, payee, no self payment).
 * The idempotent shortcut of `settle` answers success for a stored row only when these hold, so a custom seller that never called `/verify` gets the same refusal.
 */
export function requirementsMatch(circle: CircleConfig, payload: PaymentPayload, requirements: PaymentRequirements): boolean {
  const accepted = payload.accepted as unknown as Record<string, unknown> | undefined;
  if (payload.x402Version !== 2 || accepted?.scheme !== X207_SCHEME || accepted.network !== circle.network) return false;
  if (!deepEqual(accepted, requirements)) return false;
  if (typeof requirements.amount !== "string" || !POSITIVE_UINT.test(requirements.amount)) return false;
  const checkedRequirements = validatePaymentRequirements(requirements);
  if (!checkedRequirements.ok) return false;
  const { extra, payTo } = checkedRequirements.value;
  const checkedPayload = validateX207Payload(payload.payload);
  if (!checkedPayload.ok) return false;
  const { voucher } = checkedPayload.value as X207Payload;
  if (voucher.circle !== extra.circleContract || extra.circleContract !== circle.circleContract) return false;
  if (voucher.payee !== payTo || voucher.payer === voucher.payee) return false;
  return !(extra.grantId !== undefined && voucher.resource !== grantResource(extra.grantId));
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
  const { voucher, signature, bundleId } = checkedPayload.value as X207Payload;
  const payer = voucher.payer;
  // 5
  if (voucher.circle !== extra.circleContract || extra.circleContract !== circle.circleContract) {
    return reject("circle_mismatch", payer);
  }
  // 6 (unit and resource ASCII already guarded by the schema in check 4)
  if (voucher.payee !== payTo) return reject("payee_mismatch", payer);
  // F8 grant endpoint (SD-053): the voucher pays the grant named in the requirements, not the broker URL
  if (extra.grantId !== undefined && voucher.resource !== grantResource(extra.grantId)) return reject("grant_resource_mismatch", payer);
  // 7
  if (voucher.payer === voucher.payee) return reject("self_payment", payer);

  // 8
  const epoch = await chain.getEpoch();
  if (!epoch) throw new Error("view get_epoch returned null");
  if (voucher.epoch !== extra.epoch || extra.epoch !== epoch.epoch) return reject("epoch_mismatch", payer);
  // 9
  const cutoffMs = Number(BigInt(epoch.cutoff_at) / 1_000_000n);
  if (epoch.phase !== "open" || now() >= cutoffMs - flushLeadMs) return reject("epoch_closing", payer);

  // 10-13
  const [payerMember, payeeMember] = await Promise.all([chain.member(payer), chain.member(voucher.payee)]);
  if (!payerMember) return reject("member_not_found", payer);
  if (payerMember.status !== "active") return reject("member_not_active", payer);
  if (!payeeMember || payeeMember.status !== "active") return reject("payee_not_active", payer);
  // SD-074 (ADR-43): the contract still accepts old vouchers of a frozen account until the cutoff, but the facilitator takes no new voucher from or to a frozen account, also in the epoch of the freeze
  if (chain.isFrozen) {
    const [payerFrozen, payeeFrozen] = await Promise.all([chain.isFrozen(payer), chain.isFrozen(voucher.payee)]);
    if (payerFrozen || payeeFrozen) return reject("account_frozen", payer);
  }
  if (
    (payerMember.exit_requested_epoch ?? null) !== null ||
    (payeeMember.exit_requested_epoch ?? null) !== null
  ) {
    return reject("member_exiting", payer);
  }
  // 14
  // SD-088: an `eip712:` signature comes from an EVM agent, whose member id is its `0x` address; every other signature is ed25519 against `pubkey_voucher`
  const signedOk = isEip712Signature(signature)
    ? await verifyEvmVoucher({ ...voucher, signature } as Voucher)
    : verifyVoucher({ ...voucher, signature } as Voucher, payerMember.pubkey_voucher);
  if (!signedOk) {
    return reject("invalid_signature", payer);
  }
  // 15
  const pending = await chain.pendingByPayer(payer, voucher.epoch);
  if (pending.some((row) => (row.attempts ?? 0) >= REGISTRATION_RETRY_BLOCK_ATTEMPTS)) {
    return reject("registration_retry_pending", payer);
  }
  // SD-048: a bundle leg voucher is checked against the D8 leg limit, not free headroom
  let legMax: bigint | undefined;
  if (bundleId !== undefined) {
    if (!chain.bundle) throw new Error("VerifyChain.bundle is required for a bundle leg voucher");
    const bundle = await chain.bundle(bundleId);
    if (!bundle) return reject("bundle_unknown", payer);
    if (bundle.status !== "active" || bundle.epoch !== voucher.epoch) return reject("bundle_epoch_mismatch", payer);
    const leg = bundle.legs.find((l) => l.payer === payer && l.payee === voucher.payee);
    if (!leg) return reject("not_a_bundle_leg", payer);
    legMax = BigInt(leg.max_amount);
    if (BigInt(voucher.cumulativeAmount) > legMax) return reject("bundle_leg_exceeded", payer);
  }
  // 16, 17
  const base = await computeBase(payer, voucher.payee, voucher.epoch, chain);
  if (voucher.seq <= base.seq) return reject("seq_not_increasing", payer);
  const increment = BigInt(voucher.cumulativeAmount) - BigInt(base.cumulativeAmount);
  if (increment < 0n) return reject("cumulative_decreased", payer);
  // 18
  if (increment !== BigInt(requirements.amount)) return reject("amount_mismatch", payer);
  // 19 (a bundle leg voucher uses the leg reserve, already checked above)
  if (legMax === undefined && increment > BigInt(await computeHeadroom(payer, voucher.epoch, chain))) {
    return reject("insufficient_credit", payer);
  }
  return { isValid: true, payer };
}
