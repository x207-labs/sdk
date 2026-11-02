// Validasi runtime tipe publik x207. Tanda tangan hanya dicek bentuknya; isinya diperiksa
// `verifyVoucher`, karena string rusak harus berakhir `invalid_signature`, bukan `invalid_payload`.
import { CREDIT_DECIMALS, CREDIT_UNIT } from "./constants.js";
import {
  EPOCH_PHASES,
  MEMBER_STATUSES,
  REGISTRATION_STATES,
  REPORT_MEMBER_STATUSES,
  SETTLEMENT_STATUSES,
  UNSIGNED_VOUCHER_KEYS,
  VOUCHER_KEYS,
  type ClearingReport207,
  type EpochPhase,
  type MemberStatus,
  type PaymentPayload,
  type PaymentRequirements,
  type ReportMemberStatus,
  type SettleResponse,
  type SettlementStatus,
  type UnsignedVoucher,
  type Voucher,
  type X207Extra,
  type X207Payload,
} from "./types.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; message: string };

type Issue = { field: string; message: string };
type Check = (value: unknown) => Issue | null;

const U128_MAX = 340282366920938463463374607431768211455n;
const NEAR_ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const UINT_STRING = /^(?:0|[1-9]\d*)$/;
const SIGNED_STRING = /^[+-]?(?:0|[1-9]\d*)$/;
const CIRCLE_NETWORK = /^x207:[-_a-zA-Z0-9]{1,32}$/;
const COMMITMENT_ID = /^[^:]+:[^:]+:\d+:\d+$/;
const ASCII = /^[\x00-\x7f]*$/;

const issue = (field: string, message: string): Issue => ({ field, message });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeUint = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const isU128String = (value: unknown): value is string =>
  typeof value === "string" && UINT_STRING.test(value) && BigInt(value) <= U128_MAX;

const isAccountId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 2 &&
  value.length <= 64 &&
  NEAR_ACCOUNT.test(value);

const isSignatureString = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("ed25519:") && value.length > "ed25519:".length;

const includes = <T>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

export const isEpochPhase = (value: unknown): value is EpochPhase =>
  includes(EPOCH_PHASES, value);
export const isMemberStatus = (value: unknown): value is MemberStatus =>
  includes(MEMBER_STATUSES, value);
export const isSettlementStatus = (value: unknown): value is SettlementStatus =>
  includes(SETTLEMENT_STATUSES, value);
export const isReportMemberStatus = (value: unknown): value is ReportMemberStatus =>
  includes(REPORT_MEMBER_STATUSES, value);
export const isCircleNetwork = (value: unknown): value is `x207:${string}` =>
  typeof value === "string" && CIRCLE_NETWORK.test(value);

/** Issue pertama dari daftar `[field, valid, pesan]`. */
function firstIssue(rules: readonly (readonly [string, boolean, string])[]): Issue | null {
  for (const [field, valid, message] of rules) {
    if (!valid) return issue(field, message);
  }
  return null;
}

const nested = (prefix: string, found: Issue | null): Issue | null =>
  found && issue(found.field ? `${prefix}.${found.field}` : prefix, found.message);

/** Voucher menolak key asing: field di luar byte kanonik tidak ikut ditandatangani. */
function checkKeys(value: Record<string, unknown>, allowed: readonly string[]): Issue | null {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  return unknownKey === undefined ? null : issue(unknownKey, "field tidak dikenal");
}

function checkVoucherFields(v: Record<string, unknown>): Issue | null {
  return firstIssue([
    ["circle", isAccountId(v.circle), "harus akun NEAR"],
    ["payer", isAccountId(v.payer), "harus akun NEAR"],
    ["payee", isAccountId(v.payee), "harus akun NEAR"],
    ["epoch", isSafeUint(v.epoch, 1), "harus integer >= 1"],
    ["seq", isSafeUint(v.seq, 1), "harus integer >= 1"],
    ["cumulativeAmount", isU128String(v.cumulativeAmount), "harus string U128 desimal tanpa nol di depan"],
    ["unit", v.unit === CREDIT_UNIT, 'harus "credit"'],
    ["resource", typeof v.resource === "string" && ASCII.test(v.resource), "harus string ASCII"],
  ]);
}

const checkUnsignedVoucher: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return checkVoucherFields(value) ?? checkKeys(value, UNSIGNED_VOUCHER_KEYS);
};

const checkVoucher: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return (
    checkVoucherFields(value) ??
    firstIssue([["signature", isSignatureString(value.signature), "harus ed25519:<base58>"]]) ??
    checkKeys(value, VOUCHER_KEYS)
  );
};

const checkExtra: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return firstIssue([
    ["circleContract", isAccountId(value.circleContract), "harus akun NEAR"],
    ["unit", value.unit === CREDIT_UNIT, 'harus "credit"'],
    ["decimals", value.decimals === CREDIT_DECIMALS, "harus 6"],
    ["epoch", isSafeUint(value.epoch, 1), "harus integer >= 1"],
  ]);
};

const checkRequirements: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return (
    firstIssue([
      ["scheme", value.scheme === "batch-settlement", 'harus "batch-settlement"'],
      ["network", isCircleNetwork(value.network), "harus x207:<circleId> yang lolos regex CAIP-2"],
      ["amount", isU128String(value.amount) && value.amount !== "0", "harus string bilangan bulat > 0"],
      ["asset", value.asset === "USD", 'harus "USD"'],
      ["payTo", isAccountId(value.payTo), "harus akun NEAR"],
      ["maxTimeoutSeconds", isSafeUint(value.maxTimeoutSeconds, 1), "harus integer >= 1"],
    ]) ?? nested("extra", checkExtra(value.extra))
  );
};

const checkPayload: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return (
    nested("voucher", checkUnsignedVoucher(value.voucher)) ??
    firstIssue([
      ["signature", isSignatureString(value.signature), "harus ed25519:<base58>"],
      ["bundleId", value.bundleId === undefined || isSafeUint(value.bundleId, 0), "harus integer >= 0 bila ada"],
    ])
  );
};

const checkPaymentPayload: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  return (
    firstIssue([["x402Version", value.x402Version === 2, "harus 2"]]) ??
    nested("accepted", checkRequirements(value.accepted)) ??
    nested("payload", checkPayload(value.payload))
  );
};

const checkSettleExtension = (value: unknown, success: boolean): Issue | null => {
  if (!isRecord(value)) return issue("", "harus objek");
  if (success || "registration" in value) {
    return firstIssue([
      ["epoch", isSafeUint(value.epoch, 1), "harus integer >= 1"],
      ["seq", isSafeUint(value.seq, 1), "harus integer >= 1"],
      ["cumulativeAmount", isU128String(value.cumulativeAmount), "harus string U128"],
      ["registration", includes(REGISTRATION_STATES, value.registration), "harus pending, registered, atau retrying"],
    ]);
  }
  return firstIssue([
    ["epoch", isSafeUint(value.epoch, 1), "harus integer >= 1"],
    ["lastSeq", isSafeUint(value.lastSeq, 0), "harus integer >= 0"],
    ["lastCumulativeAmount", isU128String(value.lastCumulativeAmount), "harus string U128"],
  ]);
};

const checkSettleResponse: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  const success = value.success === true;
  const found = firstIssue([
    ["success", typeof value.success === "boolean", "harus boolean"],
    ["network", isCircleNetwork(value.network), "harus x207:<circleId>"],
    [
      "transaction",
      success
        ? typeof value.transaction === "string" && COMMITMENT_ID.test(value.transaction)
        : typeof value.transaction === "string",
      success ? "harus commitment id <payer>:<payee>:<epoch>:<seq>" : "harus string",
    ],
    ["payer", value.payer === undefined || isAccountId(value.payer), "harus akun NEAR"],
    ["errorReason", success || typeof value.errorReason === "string", "wajib saat success false"],
  ]);
  if (found) return found;
  if (value.extensions === undefined) {
    return success ? issue("extensions.x207", "wajib saat success true") : null;
  }
  if (!isRecord(value.extensions)) return issue("extensions", "harus objek");
  return nested("extensions.x207", checkSettleExtension(value.extensions.x207, success));
};

const checkReportMember: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  const optionalU128 = (field: unknown) => field === undefined || isU128String(field);
  const status = value.status;
  const settlement = value.settlement;
  const settlementOf: readonly unknown[] =
    status === 200 ? [undefined, null, "paid", "claimed"]
    : status === 402 ? [undefined, "due"]
    : status === 202 ? [undefined, "claimable"]
    : [undefined, "defaulted"];
  return firstIssue([
    ["account", isAccountId(value.account), "harus akun NEAR"],
    ["status", isReportMemberStatus(status), "harus 200, 402, 202, atau 409"],
    ["net", typeof value.net === "string" && SIGNED_STRING.test(value.net), "harus string bilangan bulat bertanda"],
    ["settlement", settlementOf.includes(settlement), "tidak cocok dengan status"],
    ["cleared", optionalU128(value.cleared), "harus string U128"],
    ["amount", optionalU128(value.amount), "harus string U128"],
    ["haircut", optionalU128(value.haircut), "harus string U128"],
    ["due", status !== 402 || typeof value.due === "string", "wajib saat status 402"],
    ["claimable", status !== 202 || typeof value.claimable === "boolean", "wajib saat status 202"],
    ["stakeSlashed", status !== 409 || isU128String(value.stakeSlashed), "wajib saat status 409"],
  ]);
};

const checkClearingReport: Check = (value) => {
  if (!isRecord(value)) return issue("", "harus objek");
  const found = firstIssue([
    ["epoch", isSafeUint(value.epoch, 1), "harus integer >= 1"],
    ["cleared", value.cleared === null || isU128String(value.cleared), "harus string U128 atau null"],
    [
      "clearedRatio",
      value.clearedRatio === null ||
        (typeof value.clearedRatio === "number" && value.clearedRatio >= 0 && value.clearedRatio <= 1),
      "harus angka 0..1 atau null",
    ],
    ["phase", value.phase === undefined || isEpochPhase(value.phase), "bukan EpochPhase"],
    ["network", value.network === undefined || isCircleNetwork(value.network), "harus x207:<circleId>"],
    ["unit", value.unit === undefined || value.unit === CREDIT_UNIT, 'harus "credit"'],
    ["decimals", value.decimals === undefined || value.decimals === CREDIT_DECIMALS, "harus 6"],
    ["members", Array.isArray(value.members), "harus array"],
  ]);
  if (found) return found;
  const members = value.members as unknown[];
  for (const [index, member] of members.entries()) {
    const memberIssue = nested(`members[${index}]`, checkReportMember(member));
    if (memberIssue) return memberIssue;
  }
  return null;
};

function validator<T>(check: Check): (value: unknown) => ValidationResult<T> {
  return (value) => {
    const found = check(value);
    return found ? { ok: false, ...found } : { ok: true, value: value as T };
  };
}

export const validateUnsignedVoucher = validator<UnsignedVoucher>(checkUnsignedVoucher);
export const validateVoucher = validator<Voucher>(checkVoucher);
export const validateX207Extra = validator<X207Extra>(checkExtra);
export const validatePaymentRequirements = validator<PaymentRequirements>(checkRequirements);
export const validateX207Payload = validator<X207Payload>(checkPayload);
export const validatePaymentPayload = validator<PaymentPayload>(checkPaymentPayload);
export const validateSettleResponse = validator<SettleResponse>(checkSettleResponse);
export const validateClearingReport207 = validator<ClearingReport207>(checkClearingReport);
