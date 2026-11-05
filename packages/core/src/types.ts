// x207 public types (Spec Binding x402 section 5.1, Data Model, ADR-26).
// x402 wire shapes derived from the `@x402/core` types, so values stay assignable to SDK types.
import type {
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse as X402SettleResponse,
} from "@x402/core/types";
import type { CREDIT_DECIMALS, CREDIT_UNIT } from "./constants.js";

export type AccountId = string;
/** Integer in the smallest unit (6 decimals), a decimal string without leading zeros. */
export type U128String = string;
/** Signed amount in the 207 report, e.g. `"-35000000"` or `"+35000000"`. */
export type SignedAmountString = string;
export type CircleNetwork = `x207:${string}`;
export type Ed25519Signature = `ed25519:${string}`;
/** EVM agent signature (SD-088): `eip712:0x` + 130 hex characters (r, s, v). */
export type Eip712Signature = `eip712:0x${string}`;
export type Signature = Ed25519Signature | Eip712Signature;
export const EIP712_SIGNATURE_PATTERN = /^eip712:0x[0-9a-fA-F]{130}$/;

export type X207Extra = {
  circleContract: AccountId;
  unit: typeof CREDIT_UNIT;
  decimals: typeof CREDIT_DECIMALS;
  epoch: number;
  /**
   * F8 grant endpoint (SD-053): the grant being paid. `payTo` stays the grantor, not the broker account, and the voucher `resource` becomes
   * `x207:grant:<grantId>`.
   */
  grantId?: number;
};

export type UnsignedVoucher = {
  circle: AccountId;
  payer: AccountId;
  payee: AccountId;
  epoch: number;
  seq: number;
  cumulativeAmount: U128String;
  unit: typeof CREDIT_UNIT;
  resource: string;
};

export type Voucher = UnsignedVoucher & { signature: Signature };

/**
 * x207 voucher payload. `bundleId` (SD-048, interface 0.0.4) marks an F5 bundle leg voucher: the voucher bytes do not change, only
 * its registration path (`register_in_bundle`) uses the leg's reserved headroom, not free headroom.
 */
export type X207Payload = { voucher: UnsignedVoucher; signature: Signature; bundleId?: number };

export type CommitmentId = `${AccountId}:${AccountId}:${number}:${number}`;

/** Key order = canonical voucher order (Contract Interface Spec 3.3). */
export const UNSIGNED_VOUCHER_KEYS = [
  "circle",
  "payer",
  "payee",
  "epoch",
  "seq",
  "cumulativeAmount",
  "unit",
  "resource",
] as const satisfies readonly (keyof UnsignedVoucher)[];

export const VOUCHER_KEYS = [
  ...UNSIGNED_VOUCHER_KEYS,
  "signature",
] as const satisfies readonly (keyof Voucher)[];

export const X207_EXTRA_KEYS = [
  "circleContract",
  "unit",
  "decimals",
  "epoch",
] as const satisfies readonly (keyof X207Extra)[];

export type PaymentRequirements = Omit<
  X402PaymentRequirements,
  "scheme" | "network" | "asset" | "extra"
> & {
  scheme: "batch-settlement";
  network: CircleNetwork;
  asset: "USD";
  extra: X207Extra;
};

export type PaymentPayload = Omit<X402PaymentPayload, "x402Version" | "accepted" | "payload"> & {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: X207Payload;
};

export const REGISTRATION_STATES = ["pending", "registered", "retrying"] as const;
/** Registration status on the wire. */
export type RegistrationState = (typeof REGISTRATION_STATES)[number];
/** Pending store row status; `failed` is internal only, never on the wire (K-31). */
export type PendingRowState = RegistrationState | "failed";

/** `extensions.x207` on a successful `/settle` (ADR-31). */
export type X207SettleExtension = {
  epoch: number;
  seq: number;
  cumulativeAmount: U128String;
  registration: RegistrationState;
};

/** `extensions.x207` resync on rejection (K-29). */
export type X207ResyncExtension = {
  epoch: number;
  lastSeq: number;
  lastCumulativeAmount: U128String;
};

export type SettleResponse = Omit<X402SettleResponse, "network" | "extensions"> & {
  network: CircleNetwork;
  extensions?: { x207: X207SettleExtension | X207ResyncExtension };
};

export type PairState = {
  network: CircleNetwork;
  payer: AccountId;
  payee: AccountId;
  epoch: number;
  lastSeq: number;
  lastCumulativeAmount: U128String;
  source: "pending" | "onchain" | "none";
};

export const EPOCH_PHASES = [
  "open",
  "cutoff",
  "clearing",
  "commit",
  "payment_window",
  "finalized",
] as const;
export type EpochPhase = (typeof EPOCH_PHASES)[number];

export const MEMBER_STATUSES = ["pending", "active", "suspended", "exited"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const SETTLEMENT_STATUSES = ["due", "paid", "defaulted", "claimable", "claimed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const REPORT_MEMBER_STATUSES = [200, 402, 202, 409] as const;
export type ReportMemberStatus = (typeof REPORT_MEMBER_STATUSES)[number];

type ClearingReportMemberBase = {
  account: AccountId;
  net: SignedAmountString;
  cleared?: U128String;
  amount?: U128String;
  haircut?: U128String;
};

/** Entry per member; extra fields follow `status` (Backend API Spec 4.2). */
export type ClearingReportMember = ClearingReportMemberBase &
  (
    | { status: 200; settlement?: "paid" | "claimed" | null }
    | { status: 402; settlement?: "due"; due: string }
    | { status: 202; settlement?: "claimable"; claimable: boolean }
    | { status: 409; settlement?: "defaulted"; stakeSlashed: U128String }
  );

/**
 * Clearing report `GET /x207/circles/{circle}/epochs/{n}`. The core of the Data Model; the rest from
 * Backend API Spec 4.3. `cleared` and `clearedRatio` are `null` before commit or on a zero divisor (K-38).
 */
export type ClearingReport207 = {
  epoch: number;
  cleared: U128String | null;
  clearedRatio: number | null;
  members: ClearingReportMember[];
  circle?: string;
  network?: CircleNetwork;
  phase?: EpochPhase;
  committed?: boolean;
  finalized?: boolean;
  unit?: typeof CREDIT_UNIT;
  decimals?: typeof CREDIT_DECIMALS;
  totalObligation?: U128String;
  committedAt?: string;
  paymentDeadline?: string;
};
