import type {
  PaymentPayload as X402PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
  SettleResponse as X402SettleResponse,
} from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  EPOCH_PHASES,
  MEMBER_STATUSES,
  REPORT_MEMBER_STATUSES,
  SETTLEMENT_STATUSES,
  UNSIGNED_VOUCHER_KEYS,
  VOUCHER_KEYS,
  X207_EXTRA_KEYS,
  isEpochPhase,
  isMemberStatus,
  isReportMemberStatus,
  isSettlementStatus,
  validateClearingReport207,
  validatePaymentPayload,
  validatePaymentRequirements,
  validateSettleResponse,
  validateUnsignedVoucher,
  validateVoucher,
  type ClearingReport207,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type UnsignedVoucher,
  type ValidationResult,
  type Voucher,
} from "@x207/core";

// JSON samples copied from the Data Model and Spec Binding x402, `satisfies` is their type-check.
const VOUCHER = {
  circle: "x207-circle.near",
  payer: "translator.x207-circle.near",
  payee: "summarizer.x207-circle.near",
  epoch: 42,
  seq: 137,
  cumulativeAmount: "2740000",
  unit: "credit",
  resource: "https://summarizer.example/api/summarize",
  signature: "ed25519:…",
} satisfies Voucher;

const { signature: _signature, ...UNSIGNED } = VOUCHER;
const UNSIGNED_VOUCHER = UNSIGNED satisfies UnsignedVoucher;

const REQ = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
} satisfies PaymentRequirements;

const REPORT = {
  epoch: 42,
  cleared: "1820000000",
  clearedRatio: 0.71,
  members: [
    { account: "translator.x207-circle.near", status: 200, net: "0" },
    { account: "scraper.x207-circle.near", status: 402, net: "-35000000", due: "2026-11-09T12:00:00Z" },
    { account: "gpu.x207-circle.near", status: 202, net: "+35000000", claimable: false },
  ],
} satisfies ClearingReport207;

const PAYLOAD = {
  x402Version: 2,
  resource: { url: "https://summarizer.example/api/summarize" },
  accepted: REQ,
  payload: { voucher: UNSIGNED_VOUCHER, signature: "ed25519:3sX9…" },
} satisfies PaymentPayload;

const SETTLE = {
  success: true,
  transaction: "translator.x207-circle.near:summarizer.x207-circle.near:42:137",
  network: "x207:agents-main",
  payer: "translator.x207-circle.near",
  extensions: {
    x207: { epoch: 42, seq: 137, cumulativeAmount: "2740000", registration: "pending" },
  },
} satisfies SettleResponse;

// Assignable to the `@x402/core` 2.28.0 types (checked by `npm run typecheck`).
const _x402Requirements: X402PaymentRequirements = REQ as PaymentRequirements;
const _x402Payload: X402PaymentPayload = PAYLOAD as PaymentPayload;
const _x402Settle: X402SettleResponse = SETTLE as SettleResponse;

function expectInvalid(result: ValidationResult<unknown>, field: string) {
  expect(result).toMatchObject({ ok: false, field });
}

describe("SD-004 public types of @x207/core", () => {
  it("TC-SD-004-01 the Data Model voucher example passes", () => {
    expect(validateVoucher(VOUCHER)).toEqual({ ok: true, value: VOUCHER });
  });

  it("TC-SD-004-02 the PaymentRequirements example passes", () => {
    expect(validatePaymentRequirements(REQ)).toEqual({ ok: true, value: REQ });
  });

  it("TC-SD-004-03 the 207 report example passes", () => {
    expect(validateClearingReport207(REPORT)).toEqual({ ok: true, value: REPORT });
  });

  it("TC-SD-004-03 a complete report and the default entry of the Backend API Spec pass", () => {
    const report: ClearingReport207 = {
      circle: "agents-main",
      network: "x207:agents-main",
      epoch: 42,
      phase: "payment_window",
      committed: true,
      finalized: false,
      unit: "credit",
      decimals: 6,
      totalObligation: "2563380000",
      cleared: "1820000000",
      clearedRatio: 0.71,
      committedAt: "2026-11-09T11:30:00Z",
      paymentDeadline: "2026-11-09T12:00:00Z",
      members: [
        { account: "translator.x207-circle.near", status: 200, net: "0", cleared: "310000000", settlement: null, haircut: "0" },
        { account: "scraper.x207-circle.near", status: 402, net: "-35000000", cleared: "296260000", settlement: "due", amount: "35000000", due: "2026-11-09T12:00:00Z", haircut: "0" },
        { account: "gpu.x207-circle.near", status: 202, net: "+45000000", cleared: "375000000", settlement: "claimable", amount: "45000000", claimable: false, haircut: "0" },
        { account: "scraper.x207-circle.near", status: 409, net: "-35000000", settlement: "defaulted", amount: "35000000", stakeSlashed: "35000000", haircut: "0" },
      ],
    };
    expect(validateClearingReport207(report).ok).toBe(true);
  });

  it("an epoch report not yet committed may have no members and null values (K-38)", () => {
    expect(
      validateClearingReport207({ epoch: 42, committed: false, cleared: null, clearedRatio: null, members: [] }).ok,
    ).toBe(true);
  });

  it("TC-SD-004-04 a number cumulativeAmount fails on its field", () => {
    expectInvalid(validateVoucher({ ...VOUCHER, cumulativeAmount: 2740000 }), "cumulativeAmount");
  });

  it("TC-SD-004-05 without a signature it is valid as UnsignedVoucher and fails as Voucher", () => {
    expect(validateUnsignedVoucher(UNSIGNED_VOUCHER).ok).toBe(true);
    expectInvalid(validateVoucher(UNSIGNED_VOUCHER), "signature");
  });

  it("a voucher rejects a field outside the canonical bytes", () => {
    expectInvalid(validateUnsignedVoucher(VOUCHER), "signature");
    expectInvalid(validateVoucher({ ...VOUCHER, grantId: "g1" }), "grantId");
  });

  it("TC-SD-004-06 a wrong unit fails", () => {
    expectInvalid(validateVoucher({ ...VOUCHER, unit: "usd" }), "unit");
  });

  it("TC-SD-004-07 a wrong extra.decimals fails", () => {
    expectInvalid(
      validatePaymentRequirements({ ...REQ, extra: { ...REQ.extra, decimals: 18 } }),
      "extra.decimals",
    );
  });

  it("TC-SD-004-08 a report status outside the set fails", () => {
    expect([...REPORT_MEMBER_STATUSES].sort()).toEqual([200, 202, 402, 409]);
    expect(isReportMemberStatus(500)).toBe(false);
    expectInvalid(
      validateClearingReport207({
        ...REPORT,
        members: [{ account: "translator.x207-circle.near", status: 500, net: "0" }],
      }),
      "members[0].status",
    );
  });

  it("TC-SD-004-09 EpochPhase follows the contract names", () => {
    expect(EPOCH_PHASES).toEqual(["open", "cutoff", "clearing", "commit", "payment_window", "finalized"]);
    for (const phase of EPOCH_PHASES) expect(isEpochPhase(phase)).toBe(true);
    for (const phase of ["payment window", "finality", "closed", 1]) expect(isEpochPhase(phase)).toBe(false);
    expectInvalid(validateClearingReport207({ ...REPORT, phase: "finality" }), "phase");
  });

  it("TC-SD-004-10 member status and settlement ADR-26", () => {
    expect(MEMBER_STATUSES).toEqual(["pending", "active", "suspended", "exited"]);
    expect(SETTLEMENT_STATUSES).toEqual(["due", "paid", "defaulted", "claimable", "claimed"]);
    for (const status of MEMBER_STATUSES) expect(isMemberStatus(status)).toBe(true);
    for (const status of SETTLEMENT_STATUSES) expect(isSettlementStatus(status)).toBe(true);
    expect(isMemberStatus("pending_stake")).toBe(false);
    expect(isSettlementStatus("pending_stake")).toBe(false);
  });

  it("TC-SD-004-11 PaymentPayload separates voucher and signature", () => {
    expect(validatePaymentPayload(PAYLOAD)).toEqual({ ok: true, value: PAYLOAD });
    expectInvalid(
      validatePaymentPayload({ ...PAYLOAD, payload: { voucher: UNSIGNED_VOUCHER } }),
      "payload.signature",
    );
    expectInvalid(
      validatePaymentPayload({
        ...PAYLOAD,
        payload: { ...PAYLOAD.payload, voucher: { ...UNSIGNED_VOUCHER, seq: "1" } },
      }),
      "payload.voucher.seq",
    );
    expectInvalid(validatePaymentPayload({ ...PAYLOAD, x402Version: 1 }), "x402Version");
  });

  it("TC-SD-004-12 SettleResponse and registration", () => {
    expect(validateSettleResponse(SETTLE)).toEqual({ ok: true, value: SETTLE });
    for (const registration of ["pending", "registered", "retrying"]) {
      const x207 = { ...SETTLE.extensions.x207, registration };
      expect(validateSettleResponse({ ...SETTLE, extensions: { x207 } }).ok).toBe(true);
    }
    expectInvalid(
      validateSettleResponse({
        ...SETTLE,
        extensions: { x207: { ...SETTLE.extensions.x207, registration: "failed" } },
      }),
      "extensions.x207.registration",
    );
  });

  it("a SettleResponse with a failed resync (Spec Binding x402 8.2) passes", () => {
    const failed: SettleResponse = {
      success: false,
      errorReason: "seq_not_increasing",
      transaction: "",
      network: "x207:agents-main",
      payer: "translator.x207-circle.near",
      extensions: { x207: { epoch: 42, lastSeq: 137, lastCumulativeAmount: "2740000" } },
    };
    expect(validateSettleResponse(failed).ok).toBe(true);
    const { errorReason: _reason, ...withoutReason } = failed;
    expectInvalid(validateSettleResponse(withoutReason), "errorReason");
  });

  it("TC-SD-004-13 field names equal the glossary", () => {
    expect(VOUCHER_KEYS).toEqual([
      "circle", "payer", "payee", "epoch", "seq", "cumulativeAmount", "unit", "resource", "signature",
    ]);
    expect(UNSIGNED_VOUCHER_KEYS).toEqual(VOUCHER_KEYS.slice(0, 8));
    expect(X207_EXTRA_KEYS).toEqual(["circleContract", "unit", "decimals", "epoch"]);
    expect(Object.keys(VOUCHER)).toEqual([...VOUCHER_KEYS]);
    expect(Object.keys(REQ.extra)).toEqual([...X207_EXTRA_KEYS]);
    expect(Object.keys(REPORT)).toEqual(["epoch", "cleared", "clearedRatio", "members"]);
  });

  it("cumulativeAmount with leading zeros and above U128 is rejected, maximum U128 passes", () => {
    expectInvalid(validateVoucher({ ...VOUCHER, cumulativeAmount: "02740000" }), "cumulativeAmount");
    expectInvalid(
      validateVoucher({ ...VOUCHER, cumulativeAmount: "340282366920938463463374607431768211456" }),
      "cumulativeAmount",
    );
    expect(
      validateVoucher({ ...VOUCHER, cumulativeAmount: "340282366920938463463374607431768211455" }).ok,
    ).toBe(true);
  });

  it("a non-ASCII resource and an invalid amount are rejected (K-30)", () => {
    expectInvalid(validateVoucher({ ...VOUCHER, resource: "https://é.example" }), "resource");
    for (const amount of ["0", "-1", "0.5", 20000]) {
      expectInvalid(validatePaymentRequirements({ ...REQ, amount }), "amount");
    }
  });

  it("a network with a dot is rejected", () => {
    expectInvalid(validatePaymentRequirements({ ...REQ, network: "x207:x207-circle.near" }), "network");
  });
});
