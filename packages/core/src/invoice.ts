// Invoice and installment format (SD-065, pipeline P8, ADR-44). An invoice is the issuer's claim on the debtor outside x207. If the debtor signs it as a plain voucher, the claim
// becomes a D2 edge `debtor -> issuer` and takes part in F3 clearing; the contract does not change. What the debtor signs is the existing voucher: `payer = debtor`, `payee = issuer`,
// `unit = "credit"`, `resource = "x207:invoice:<hash>"`, and `cumulativeAmount` = the pair's previous cumulative + the invoice amount (CT-076).
//
// Installments (ADR-44): n vouchers in n consecutive epochs, ALL signed by the debtor up front, each with `seq` 1 of the pair in its epoch and a cumulative equal to that installment.
// A plain debtor-to-issuer voucher in the same epoch only starts at `seq` 2 with a cumulative that already includes the installment (`installmentState`). There is no backup voucher ahead:
// the issuer could register it even though the original installment was paid, so the debtor would pay twice. An installment that fails (headroom exhausted) is shifted ONCE to the next epoch with
// a catch-up voucher (`catchUpVoucher`) signed by the debtor after the failure; failing again becomes `missed`, with no automatic penalty.
//
// ACKNOWLEDGED LIMIT (not a guarantee): the contract only rejects a `seq` that does not increase per (payer, payee, epoch) and allows `seq` gaps. A debtor can block an installment voucher by
// first registering a higher-`seq` voucher to the issuer; installment `seq` 1 is then rejected. The up-front signature is evidence, not a payment guarantee. The countermeasures live outside
// this format: the `blocked_by_debtor` status and reputation (backend), and the CT-094 guarantee for large invoices. A full guarantee needs cross-epoch headroom locking in the contract.
import { createHash } from "node:crypto";
import { CREDIT_UNIT } from "./constants.js";
import type { AccountId, U128String, UnsignedVoucher, Voucher } from "./types.js";
import { signVoucher, type VoucherSecretKey } from "./voucher.js";

export type InvoiceErrorCode =
  | "invoice_bad_id" | "invoice_bad_account" | "invoice_same_party" | "invoice_bad_amount" | "invoice_bad_memo" | "invoice_bad_resource"
  | "installment_count" | "installment_amount_too_small" | "installment_bad_epoch" | "installment_not_found" | "installment_already_shifted" | "installment_bad_state";

export class InvoiceError extends Error {
  constructor(readonly code: InvoiceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "InvoiceError";
  }
}

/** Invoice document. Only its hash goes on-chain (in `resource`); the content and `memo` stay off-chain. */
export type InvoiceDocument = { id: string; issuer: AccountId; debtor: AccountId; amount: U128String; memo: string };

export const INVOICE_RESOURCE_PREFIX = "x207:invoice:";
/** Maximum installments per invoice: one voucher per epoch, and each epoch uses the debtor's headroom. */
export const MAX_INSTALLMENTS = 24;

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const AMOUNT = /^[1-9]\d*$/;
const ID = /^[A-Za-z0-9._:/-]{1,64}$/;
const U128_MAX = 340282366920938463463374607431768211455n;
const fail = (code: InvoiceErrorCode, message: string): never => {
  throw new InvoiceError(code, message);
};

function checkDocument(doc: InvoiceDocument): void {
  if (typeof doc.id !== "string" || !ID.test(doc.id)) fail("invoice_bad_id", "id must be 1 to 64 characters [A-Za-z0-9._:/-]");
  for (const [name, value] of [["issuer", doc.issuer], ["debtor", doc.debtor]] as const) {
    if (typeof value !== "string" || value.length < 2 || value.length > 64 || !ACCOUNT.test(value)) fail("invoice_bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
  }
  if (doc.issuer === doc.debtor) fail("invoice_same_party", "issuer and debtor must be different accounts");
  if (typeof doc.amount !== "string" || !AMOUNT.test(doc.amount) || BigInt(doc.amount) > U128_MAX) fail("invoice_bad_amount", `amount must be a decimal integer > 0 (smallest unit), got ${JSON.stringify(doc.amount)}`);
  if (typeof doc.memo !== "string" || doc.memo.length > 256 || !/^[\x20-\x7e]*$/.test(doc.memo)) fail("invoice_bad_memo", "memo must be ASCII text of at most 256 characters");
}

/** Canonical JSON `{id, issuer, debtor, amount, memo}` (fixed key order, no whitespace); the same as the AG-021 format. */
export function serializeInvoice(doc: InvoiceDocument): string {
  checkDocument(doc);
  const { id, issuer, debtor, amount, memo } = doc;
  return JSON.stringify({ id, issuer, debtor, amount, memo });
}

/** sha256 of the canonical JSON; 64 lowercase hex characters. */
export function invoiceHash(doc: InvoiceDocument): string {
  return createHash("sha256").update(serializeInvoice(doc)).digest("hex");
}

/** `x207:invoice:<hash>`. */
export function invoiceResource(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) fail("invoice_bad_resource", "invoice hash must be 64 lowercase hex characters");
  return `${INVOICE_RESOURCE_PREFIX}${hash}`;
}

/** Hash from a voucher's `resource`, or `null` if not an invoice resource. */
export function parseInvoiceResource(resource: string): string | null {
  if (!resource.startsWith(INVOICE_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(INVOICE_RESOURCE_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/** State of the (debtor, issuer) pair in one epoch: the last `seq` and the cumulative already registered (0 and "0" if no voucher yet). */
export type InvoicePairState = { seq: number; cumulativeAmount: U128String };

const checkState = (state: InvoicePairState): void => {
  if (!Number.isSafeInteger(state.seq) || state.seq < 0 || !/^(0|[1-9]\d*)$/.test(state.cumulativeAmount)) fail("installment_bad_state", `invalid pair state: ${JSON.stringify(state)}`);
};

/** Plain invoice voucher (single payment): continues the pair state in epoch `epoch`. */
export function invoiceVoucher(args: { circle: AccountId; doc: InvoiceDocument; epoch: number; state: InvoicePairState }): UnsignedVoucher {
  checkState(args.state);
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("installment_bad_epoch", `epoch must be an integer >= 1, got ${args.epoch}`);
  return {
    circle: args.circle, payer: args.doc.debtor, payee: args.doc.issuer, epoch: args.epoch, seq: args.state.seq + 1,
    cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(args.doc.amount)).toString(), unit: CREDIT_UNIT, resource: invoiceResource(invoiceHash(args.doc)),
  };
}

export const signInvoiceVoucher = (voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Voucher => signVoucher(voucher, secretKey);

/** Epoch schedule: the currently running epoch, when it opened (unix seconds), and `epoch_length` (seconds). */
export type EpochClock = { epoch: number; openedAt: number; epochLength: number };

/**
 * The epoch running at `time` (unix seconds) according to the nominal schedule `openedAt + n × epochLength`. This is an estimate: the contract opens the next epoch when `close_epoch` is called,
 * so the real epoch may drift; the issuer must still register before that epoch's `cutoff_at`. Times before `openedAt` are rejected.
 */
export function epochForTime(time: number, clock: EpochClock): number {
  if (!Number.isFinite(time) || !Number.isSafeInteger(clock.epoch) || clock.epoch < 1 || !(clock.epochLength > 0) || time < clock.openedAt) {
    return fail("installment_bad_epoch", "time must not be earlier than the opening of the running epoch, with epochLength > 0");
  }
  return clock.epoch + Math.floor((time - clock.openedAt) / clock.epochLength);
}

export type Installment = { index: number; epoch: number; amount: U128String };
export type InstallmentPlan = { circle: AccountId; doc: InvoiceDocument; hash: string; resource: string; installments: Installment[] };

/**
 * Plan of `count` installments in epochs `firstEpoch`, `firstEpoch + 1`, ... The amount is divided evenly; the remainder is distributed one smallest unit at a time to the first installments, so the sum of all installments
 * is exactly the invoice amount. `count` is 1 to `MAX_INSTALLMENTS`, and each installment is at least 1 smallest unit.
 */
export function planInstallments(args: { circle: AccountId; doc: InvoiceDocument; firstEpoch: number; count: number }): InstallmentPlan {
  const { circle, doc, firstEpoch, count } = args;
  const hash = invoiceHash(doc);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INSTALLMENTS) fail("installment_count", `count must be an integer from 1 to ${MAX_INSTALLMENTS}, got ${count}`);
  if (!Number.isSafeInteger(firstEpoch) || firstEpoch < 1) fail("installment_bad_epoch", `firstEpoch must be an integer >= 1, got ${firstEpoch}`);
  const total = BigInt(doc.amount);
  if (total < BigInt(count)) fail("installment_amount_too_small", `amount ${doc.amount} is not enough for ${count} installments`);
  const base = total / BigInt(count);
  const extra = Number(total % BigInt(count));
  return {
    circle, doc, hash, resource: invoiceResource(hash),
    installments: Array.from({ length: count }, (_, i) => ({ index: i + 1, epoch: firstEpoch + i, amount: (base + (i < extra ? 1n : 0n)).toString() })),
  };
}

const installmentAt = (plan: InstallmentPlan, index: number): Installment =>
  plan.installments.find((i) => i.index === index) ?? fail("installment_not_found", `installment ${index} does not exist; this plan has ${plan.installments.length}`);

/**
 * Voucher for installment `index`, signed up front: `seq` 1 of the pair in its epoch and a cumulative equal to that installment. Only correct if the pair has no voucher yet in that epoch;
 * there is no state parameter because that is the rule.
 */
export function installmentVoucher(plan: InstallmentPlan, index: number): UnsignedVoucher {
  const item = installmentAt(plan, index);
  return {
    circle: plan.circle, payer: plan.doc.debtor, payee: plan.doc.issuer, epoch: item.epoch, seq: 1, cumulativeAmount: item.amount, unit: CREDIT_UNIT, resource: plan.resource,
  };
}

/** All signed installment vouchers, one per epoch, in a single up-front signature. */
export const signInstallments = (plan: InstallmentPlan, secretKey: VoucherSecretKey): Voucher[] =>
  plan.installments.map((i) => signVoucher(installmentVoucher(plan, i.index), secretKey));

/**
 * Pair state in the epoch of installment `index` after that installment is registered: a plain debtor-to-issuer voucher in that epoch starts at `seq` 2 with a cumulative that already includes the installment.
 * To fill the client's `VoucherStateStore` so the next voucher does not use `seq` 1 again.
 */
export function installmentState(plan: InstallmentPlan, index: number): { epoch: number; state: InvoicePairState } {
  const item = installmentAt(plan, index);
  return { epoch: item.epoch, state: { seq: 1, cumulativeAmount: item.amount } };
}

/**
 * Catch-up voucher for installment `index` that failed to register because headroom ran out: shifted ONCE to the next epoch (installment `epoch` + 1), continuing the pair state in that
 * epoch (`state`, what is registered now, including that epoch's own installment if any). Call only after the failure has happened; do NOT sign this voucher up front.
 * `alreadyShifted` true means this installment was already shifted once: failing again becomes `missed`, and this function refuses.
 *
 * WARNING (BE-062 review, F9): this function signs on top of WHATEVER `state` it is given. `state` must be read from the CONTRACT by the signer itself (the `obligation` view),
 * never from the collector or the backend: an inflated state makes the debtor pay the difference to the collector. Use `catchUpVoucherFromChain` when possible, which reads that state itself.
 */
export function catchUpVoucher(plan: InstallmentPlan, index: number, state: InvoicePairState, alreadyShifted: boolean): UnsignedVoucher {
  const item = installmentAt(plan, index);
  if (alreadyShifted) fail("installment_already_shifted", `installment ${index} was already shifted once; failing again means missed`);
  checkState(state);
  return {
    circle: plan.circle, payer: plan.doc.debtor, payee: plan.doc.issuer, epoch: item.epoch + 1, seq: state.seq + 1,
    cumulativeAmount: (BigInt(state.cumulativeAmount) + BigInt(item.amount)).toString(), unit: CREDIT_UNIT, resource: plan.resource,
  };
}

/** The contract's `obligation` view for one pair in one epoch (result of `ObligationView`, or `null` if the pair has no voucher in that epoch). */
export type ViewObligationFn = (args: { epoch: number; debtor: AccountId; creditor: AccountId }) => Promise<{ cumulative: string; last_seq: number } | null>;

/**
 * Like `catchUpVoucher`, but the pair state in the target epoch is read from the contract itself via `viewObligation` (F9): the signer cannot be given a fake state by another party.
 */
export async function catchUpVoucherFromChain(plan: InstallmentPlan, index: number, viewObligation: ViewObligationFn, alreadyShifted: boolean): Promise<UnsignedVoucher> {
  const item = installmentAt(plan, index);
  const row = await viewObligation({ epoch: item.epoch + 1, debtor: plan.doc.debtor, creditor: plan.doc.issuer });
  return catchUpVoucher(plan, index, { seq: row?.last_seq ?? 0, cumulativeAmount: row?.cumulative ?? "0" }, alreadyShifted);
}
