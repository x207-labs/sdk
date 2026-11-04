// Runtime validation of x207 public types. Signatures are checked for shape only; their content is checked by
// `verifyVoucher`, because a broken string must end in `invalid_signature`, not `invalid_payload`.
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

/** The first issue from a list of `[field, valid, message]`. */
function firstIssue(rules: readonly (readonly [string, boolean, string])[]): Issue | null {
  for (const [field, valid, message] of rules) {
    if (!valid) return issue(field, message);
  }
  return null;
}

const nested = (prefix: string, found: Issue | null): Issue | null =>
  found && issue(found.field ? `${prefix}.${found.field}` : prefix, found.message);

/** The voucher rejects foreign keys: fields outside the canonical bytes are not signed. */
function checkKeys(value: Record<string, unknown>, allowed: readonly string[]): Issue | null {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  return unknownKey === undefined ? null : issue(unknownKey, "unknown field");
}

function checkVoucherFields(v: Record<string, unknown>): Issue | null {
  return firstIssue([
    ["circle", isAccountId(v.circle), "must be a NEAR account"],
    ["payer", isAccountId(v.payer), "must be a NEAR account"],
    ["payee", isAccountId(v.payee), "must be a NEAR account"],
    ["epoch", isSafeUint(v.epoch, 1), "must be an integer >= 1"],
    ["seq", isSafeUint(v.seq, 1), "must be an integer >= 1"],
    ["cumulativeAmount", isU128String(v.cumulativeAmount), "must be a decimal U128 string with no leading zeros"],
    ["unit", v.unit === CREDIT_UNIT, 'must be "credit"'],
    ["resource", typeof v.resource === "string" && ASCII.test(v.resource), "must be an ASCII string"],
  ]);
}

const checkUnsignedVoucher: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return checkVoucherFields(value) ?? checkKeys(value, UNSIGNED_VOUCHER_KEYS);
};

const checkVoucher: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return (
    checkVoucherFields(value) ??
    firstIssue([["signature", isSignatureString(value.signature), "must be ed25519:<base58>"]]) ??
    checkKeys(value, VOUCHER_KEYS)
  );
};

const checkExtra: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return firstIssue([
    ["circleContract", isAccountId(value.circleContract), "must be a NEAR account"],
    ["unit", value.unit === CREDIT_UNIT, 'must be "credit"'],
    ["decimals", value.decimals === CREDIT_DECIMALS, "must be 6"],
    ["epoch", isSafeUint(value.epoch, 1), "must be an integer >= 1"],
    ["grantId", value.grantId === undefined || isSafeUint(value.grantId, 1), "must be an integer >= 1 if present"],
  ]);
};

const checkRequirements: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return (
    firstIssue([
      ["scheme", value.scheme === "batch-settlement", 'must be "batch-settlement"'],
      ["network", isCircleNetwork(value.network), "must be x207:<circleId> matching the CAIP-2 regex"],
      ["amount", isU128String(value.amount) && value.amount !== "0", "must be an integer string > 0"],
      ["asset", value.asset === "USD", 'must be "USD"'],
      ["payTo", isAccountId(value.payTo), "must be a NEAR account"],
      ["maxTimeoutSeconds", isSafeUint(value.maxTimeoutSeconds, 1), "must be an integer >= 1"],
    ]) ?? nested("extra", checkExtra(value.extra))
  );
};

const checkPayload: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return (
    nested("voucher", checkUnsignedVoucher(value.voucher)) ??
    firstIssue([
      ["signature", isSignatureString(value.signature), "must be ed25519:<base58>"],
      ["bundleId", value.bundleId === undefined || isSafeUint(value.bundleId, 0), "must be an integer >= 0 if present"],
    ])
  );
};

const checkPaymentPayload: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  return (
    firstIssue([["x402Version", value.x402Version === 2, "must be 2"]]) ??
    nested("accepted", checkRequirements(value.accepted)) ??
    nested("payload", checkPayload(value.payload))
  );
};

const checkSettleExtension = (value: unknown, success: boolean): Issue | null => {
  if (!isRecord(value)) return issue("", "must be an object");
  if (success || "registration" in value) {
    return firstIssue([
      ["epoch", isSafeUint(value.epoch, 1), "must be an integer >= 1"],
      ["seq", isSafeUint(value.seq, 1), "must be an integer >= 1"],
      ["cumulativeAmount", isU128String(value.cumulativeAmount), "must be a U128 string"],
      ["registration", includes(REGISTRATION_STATES, value.registration), "must be pending, registered, or retrying"],
    ]);
  }
  return firstIssue([
    ["epoch", isSafeUint(value.epoch, 1), "must be an integer >= 1"],
    ["lastSeq", isSafeUint(value.lastSeq, 0), "must be an integer >= 0"],
    ["lastCumulativeAmount", isU128String(value.lastCumulativeAmount), "must be a U128 string"],
  ]);
};

const checkSettleResponse: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  const success = value.success === true;
  const found = firstIssue([
    ["success", typeof value.success === "boolean", "must be a boolean"],
    ["network", isCircleNetwork(value.network), "must be x207:<circleId>"],
    [
      "transaction",
      success
        ? typeof value.transaction === "string" && COMMITMENT_ID.test(value.transaction)
        : typeof value.transaction === "string",
      success ? "must be the commitment id <payer>:<payee>:<epoch>:<seq>" : "must be a string",
    ],
    ["payer", value.payer === undefined || isAccountId(value.payer), "must be a NEAR account"],
    ["errorReason", success || typeof value.errorReason === "string", "required when success is false"],
  ]);
  if (found) return found;
  if (value.extensions === undefined) {
    return success ? issue("extensions.x207", "required when success is true") : null;
  }
  if (!isRecord(value.extensions)) return issue("extensions", "must be an object");
  return nested("extensions.x207", checkSettleExtension(value.extensions.x207, success));
};

const checkReportMember: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  const optionalU128 = (field: unknown) => field === undefined || isU128String(field);
  const status = value.status;
  const settlement = value.settlement;
  const settlementOf: readonly unknown[] =
    status === 200 ? [undefined, null, "paid", "claimed"]
    : status === 402 ? [undefined, "due"]
    : status === 202 ? [undefined, "claimable"]
    : [undefined, "defaulted"];
  return firstIssue([
    ["account", isAccountId(value.account), "must be a NEAR account"],
    ["status", isReportMemberStatus(status), "must be 200, 402, 202, or 409"],
    ["net", typeof value.net === "string" && SIGNED_STRING.test(value.net), "must be a signed integer string"],
    ["settlement", settlementOf.includes(settlement), "does not match status"],
    ["cleared", optionalU128(value.cleared), "must be a U128 string"],
    ["amount", optionalU128(value.amount), "must be a U128 string"],
    ["haircut", optionalU128(value.haircut), "must be a U128 string"],
    ["due", status !== 402 || typeof value.due === "string", "required when status is 402"],
    ["claimable", status !== 202 || typeof value.claimable === "boolean", "required when status is 202"],
    ["stakeSlashed", status !== 409 || isU128String(value.stakeSlashed), "required when status is 409"],
  ]);
};

const checkClearingReport: Check = (value) => {
  if (!isRecord(value)) return issue("", "must be an object");
  const found = firstIssue([
    ["epoch", isSafeUint(value.epoch, 1), "must be an integer >= 1"],
    ["cleared", value.cleared === null || isU128String(value.cleared), "must be a U128 string or null"],
    [
      "clearedRatio",
      value.clearedRatio === null ||
        (typeof value.clearedRatio === "number" && value.clearedRatio >= 0 && value.clearedRatio <= 1),
      "must be a number 0..1 or null",
    ],
    ["phase", value.phase === undefined || isEpochPhase(value.phase), "is not an EpochPhase"],
    ["network", value.network === undefined || isCircleNetwork(value.network), "must be x207:<circleId>"],
    ["unit", value.unit === undefined || value.unit === CREDIT_UNIT, 'must be "credit"'],
    ["decimals", value.decimals === undefined || value.decimals === CREDIT_DECIMALS, "must be 6"],
    ["members", Array.isArray(value.members), "must be an array"],
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
