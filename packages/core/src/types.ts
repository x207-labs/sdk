// Tipe publik x207 (Spec Binding x402 bagian 5.1, Model Data, ADR-26).
// Bentuk kabel x402 turunan tipe `@x402/core`, sehingga nilainya tetap assignable ke tipe SDK.
import type {
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse as X402SettleResponse,
} from "@x402/core/types";
import type { CREDIT_DECIMALS, CREDIT_UNIT } from "./constants.js";

export type AccountId = string;
/** Bilangan bulat satuan terkecil (6 desimal), string desimal tanpa nol di depan. */
export type U128String = string;
/** Jumlah bertanda di laporan 207, mis. `"-35000000"` atau `"+35000000"`. */
export type SignedAmountString = string;
export type CircleNetwork = `x207:${string}`;
export type Ed25519Signature = `ed25519:${string}`;

export type X207Extra = {
  circleContract: AccountId;
  unit: typeof CREDIT_UNIT;
  decimals: typeof CREDIT_DECIMALS;
  epoch: number;
  /**
   * Endpoint grant F8 (SD-053): grant yang dibayar. `payTo` tetap pemberi grant, bukan akun broker, dan `resource` voucher menjadi
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

export type Voucher = UnsignedVoucher & { signature: Ed25519Signature };

/**
 * Payload voucher x207. `bundleId` (SD-048, interface 0.0.4) menandai voucher leg bundle F5: bytes voucher tidak berubah, hanya
 * jalur registrasinya (`register_in_bundle`) yang memakai headroom cadangan leg, bukan headroom bebas.
 */
export type X207Payload = { voucher: UnsignedVoucher; signature: Ed25519Signature; bundleId?: number };

export type CommitmentId = `${AccountId}:${AccountId}:${number}:${number}`;

/** Urutan key = urutan kanonik voucher (Spec Antarmuka Kontrak 3.3). */
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
/** Status registrasi di kabel. */
export type RegistrationState = (typeof REGISTRATION_STATES)[number];
/** Status baris pending store; `failed` hanya internal, tidak pernah di kabel (K-31). */
export type PendingRowState = RegistrationState | "failed";

/** `extensions.x207` pada `/settle` sukses (ADR-31). */
export type X207SettleExtension = {
  epoch: number;
  seq: number;
  cumulativeAmount: U128String;
  registration: RegistrationState;
};

/** `extensions.x207` resinkronisasi pada penolakan (K-29). */
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

/** Entri per anggota; field tambahan mengikuti `status` (Spec API Backend 4.2). */
export type ClearingReportMember = ClearingReportMemberBase &
  (
    | { status: 200; settlement?: "paid" | "claimed" | null }
    | { status: 402; settlement?: "due"; due: string }
    | { status: 202; settlement?: "claimable"; claimable: boolean }
    | { status: 409; settlement?: "defaulted"; stakeSlashed: U128String }
  );

/**
 * Laporan kliring `GET /x207/circles/{circle}/epochs/{n}`. Inti dari Model Data; sisanya dari
 * Spec API Backend 4.3. `cleared` dan `clearedRatio` `null` sebelum commit atau pembagi nol (K-38).
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
