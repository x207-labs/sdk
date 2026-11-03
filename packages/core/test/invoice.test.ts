import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvoiceError, MAX_INSTALLMENTS, catchUpVoucher, catchUpVoucherFromChain, epochForTime, generateVoucherKeypair, installmentState, installmentVoucher, invoiceHash, invoiceResource, invoiceVoucher,
  parseInvoiceResource, planInstallments, serializeInvoice, signInstallments, signInvoiceVoucher, validateUnsignedVoucher, verifyVoucher, type InvoiceDocument,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const DEBTOR = "maker.x207-circle.near";
const ISSUER = "supplier.x207-circle.near";
const doc: InvoiceDocument = { id: "INV-2026-001", issuer: ISSUER, debtor: DEBTOR, amount: "100000000", memo: "components, October batch" };
const key = generateVoucherKeypair();
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof InvoiceError ? e.code : `other: ${String(e)}`;
  }
};

describe("SD-065 invoice document, hash and resource", () => {
  it("TC-SD-065-01 the canonical JSON has fixed key order and no spaces, and the hash is its sha256 (the vector)", () => {
    const text = '{"id":"INV-2026-001","issuer":"supplier.x207-circle.near","debtor":"maker.x207-circle.near","amount":"100000000","memo":"components, October batch"}';
    expect(serializeInvoice(doc)).toBe(text);
    expect(serializeInvoice({ memo: doc.memo, amount: doc.amount, debtor: doc.debtor, issuer: doc.issuer, id: doc.id })).toBe(text);
    expect(invoiceHash(doc)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(invoiceHash({ ...doc, amount: "100000001" })).not.toBe(invoiceHash(doc));
    expect(invoiceHash({ ...doc, memo: "other" })).not.toBe(invoiceHash(doc));
  });

  it("TC-SD-065-02 resource is x207:invoice:<hash>, parsed back, and anything else is not an invoice resource", () => {
    const hash = invoiceHash(doc);
    expect(invoiceResource(hash)).toBe(`x207:invoice:${hash}`);
    expect(parseInvoiceResource(`x207:invoice:${hash}`)).toBe(hash);
    expect(parseInvoiceResource(`invoice:${hash}`)).toBeNull(); // the old format of the first scenario
    expect(parseInvoiceResource("x207:grant:7")).toBeNull();
    expect(parseInvoiceResource("x207:invoice:ABC")).toBeNull();
    expect(code(() => invoiceResource("xyz"))).toBe("invoice_bad_resource");
  });

  it("TC-SD-065-03 a bad document is refused with the code of the field", () => {
    expect(code(() => invoiceHash({ ...doc, id: "" }))).toBe("invoice_bad_id");
    expect(code(() => invoiceHash({ ...doc, id: "a b" }))).toBe("invoice_bad_id");
    expect(code(() => invoiceHash({ ...doc, issuer: "Bad Account" }))).toBe("invoice_bad_account");
    expect(code(() => invoiceHash({ ...doc, debtor: DEBTOR.toUpperCase() }))).toBe("invoice_bad_account");
    expect(code(() => invoiceHash({ ...doc, debtor: ISSUER }))).toBe("invoice_same_party");
    for (const amount of ["0", "01", "-5", "1.5", "", "340282366920938463463374607431768211456"]) expect(code(() => invoiceHash({ ...doc, amount })), amount).toBe("invoice_bad_amount");
    expect(code(() => invoiceHash({ ...doc, memo: "café" }))).toBe("invoice_bad_memo");
    expect(code(() => invoiceHash({ ...doc, memo: "x".repeat(257) }))).toBe("invoice_bad_memo");
    expect(code(() => invoiceHash({ ...doc, memo: "" }))).toBe("no error");
  });
});

describe("SD-065 voucher of an invoice", () => {
  it("TC-SD-065-04 the debtor signs a normal voucher: payer debtor, payee issuer, unit credit, cumulative of the pair plus the amount, next seq", () => {
    const v = invoiceVoucher({ circle: CIRCLE, doc, epoch: 7, state: { seq: 2, cumulativeAmount: "30000000" } });
    expect(v).toEqual({
      circle: CIRCLE, payer: DEBTOR, payee: ISSUER, epoch: 7, seq: 3, cumulativeAmount: "130000000", unit: "credit", resource: invoiceResource(invoiceHash(doc)),
    });
    expect(validateUnsignedVoucher(v).ok).toBe(true);
    const signed = signInvoiceVoucher(v, key.secretKey);
    expect(verifyVoucher(signed, key.publicKey)).toBe(true);
    expect(verifyVoucher({ ...signed, cumulativeAmount: "1" }, key.publicKey)).toBe(false);
    expect(invoiceVoucher({ circle: CIRCLE, doc, epoch: 7, state: { seq: 0, cumulativeAmount: "0" } })).toMatchObject({ seq: 1, cumulativeAmount: "100000000" });
    expect(code(() => invoiceVoucher({ circle: CIRCLE, doc, epoch: 0, state: { seq: 0, cumulativeAmount: "0" } }))).toBe("installment_bad_epoch");
    expect(code(() => invoiceVoucher({ circle: CIRCLE, doc, epoch: 1, state: { seq: -1, cumulativeAmount: "0" } }))).toBe("installment_bad_state");
  });

  it("TC-SD-065-05 a date maps to the epoch that is open then, on the nominal schedule, and not before the open epoch", () => {
    const clock = { epoch: 10, openedAt: 1_000_000, epochLength: 3600 };
    expect(epochForTime(1_000_000, clock)).toBe(10);
    expect(epochForTime(1_003_599, clock)).toBe(10);
    expect(epochForTime(1_003_600, clock)).toBe(11);
    expect(epochForTime(1_000_000 + 3 * 3600 + 5, clock)).toBe(13);
    expect(code(() => epochForTime(999_999, clock))).toBe("installment_bad_epoch");
    expect(code(() => epochForTime(1_000_001, { ...clock, epochLength: 0 }))).toBe("installment_bad_epoch");
  });
});

describe("SD-065 installments signed in advance (ADR-44)", () => {
  const plan = planInstallments({ circle: CIRCLE, doc, firstEpoch: 20, count: 3 });

  it("TC-SD-065-06 a plan of three epochs: consecutive epochs, amounts that add up exactly, remainder to the first ones", () => {
    expect(plan.installments).toEqual([
      { index: 1, epoch: 20, amount: "33333334" }, { index: 2, epoch: 21, amount: "33333333" }, { index: 3, epoch: 22, amount: "33333333" },
    ]);
    expect(plan.installments.reduce((n, i) => n + BigInt(i.amount), 0n)).toBe(BigInt(doc.amount));
    expect(plan.resource).toBe(`x207:invoice:${invoiceHash(doc)}`);
    const even = planInstallments({ circle: CIRCLE, doc: { ...doc, amount: "90" }, firstEpoch: 5, count: 3 });
    expect(even.installments.map((i) => i.amount)).toEqual(["30", "30", "30"]);
    expect(planInstallments({ circle: CIRCLE, doc, firstEpoch: 5, count: 1 }).installments).toEqual([{ index: 1, epoch: 5, amount: doc.amount }]);
  });

  it("TC-SD-065-07 every installment voucher is seq 1 of the pair in its epoch with the cumulative of that installment alone, all signed at once", () => {
    const signed = signInstallments(plan, key.secretKey);
    expect(signed).toHaveLength(3);
    signed.forEach((v, i) => {
      expect(v).toMatchObject({ payer: DEBTOR, payee: ISSUER, epoch: 20 + i, seq: 1, cumulativeAmount: plan.installments[i]!.amount, unit: "credit", resource: plan.resource });
      expect(verifyVoucher(v, key.publicKey)).toBe(true);
    });
    expect(new Set(signed.map((v) => v.epoch)).size).toBe(3);
    expect(installmentVoucher(plan, 2)).toMatchObject({ epoch: 21, seq: 1, cumulativeAmount: "33333333" });
  });

  it("TC-SD-065-08 an ordinary voucher of the pair in the epoch of an installment starts at seq 2 with a cumulative that already holds the installment", () => {
    const { epoch, state } = installmentState(plan, 2);
    expect(epoch).toBe(21);
    expect(state).toEqual({ seq: 1, cumulativeAmount: "33333333" });
    const other: InvoiceDocument = { ...doc, id: "INV-2026-002", amount: "5000000" };
    expect(invoiceVoucher({ circle: CIRCLE, doc: other, epoch, state })).toMatchObject({ seq: 2, cumulativeAmount: "38333333" });
  });

  it("TC-SD-065-09 there is no spare voucher in advance: the catch-up voucher needs the state of the pair that exists after the failure, and only works once", () => {
    // installment 1 failed in epoch 20 (no headroom); epoch 21 already holds its own installment 2 registered: seq 1, 33333333
    const state = { seq: 1, cumulativeAmount: "33333333" };
    const v = catchUpVoucher(plan, 1, state, false);
    expect(v).toMatchObject({ epoch: 21, seq: 2, cumulativeAmount: "66666667", resource: plan.resource, payer: DEBTOR, payee: ISSUER });
    expect(verifyVoucher(signInvoiceVoucher(v, key.secretKey), key.publicKey)).toBe(true);
    // the last installment shifts to the epoch after the plan, where the pair has no voucher yet
    expect(catchUpVoucher(plan, 3, { seq: 0, cumulativeAmount: "0" }, false)).toMatchObject({ epoch: 23, seq: 1, cumulativeAmount: "33333333" });
    // a second failure is a miss: the SDK does not make another voucher
    expect(code(() => catchUpVoucher(plan, 1, state, true))).toBe("installment_already_shifted");
    expect(code(() => catchUpVoucher(plan, 9, state, false))).toBe("installment_not_found");
    expect(code(() => catchUpVoucher(plan, 1, { seq: 1, cumulativeAmount: "x" }, false))).toBe("installment_bad_state");
    // the signing of the plan makes exactly one voucher per installment, never a second one for the same epoch
    expect(signInstallments(plan, key.secretKey).map((s) => `${s.epoch}:${s.seq}`)).toEqual(["20:1", "21:1", "22:1"]);
  });

  it("TC-SD-065-10 limits of a plan: count 1 to 24, each installment at least one smallest unit, first epoch at least 1", () => {
    expect(code(() => planInstallments({ circle: CIRCLE, doc, firstEpoch: 1, count: 0 }))).toBe("installment_count");
    expect(code(() => planInstallments({ circle: CIRCLE, doc, firstEpoch: 1, count: MAX_INSTALLMENTS + 1 }))).toBe("installment_count");
    expect(code(() => planInstallments({ circle: CIRCLE, doc, firstEpoch: 1, count: MAX_INSTALLMENTS }))).toBe("no error");
    expect(code(() => planInstallments({ circle: CIRCLE, doc: { ...doc, amount: "2" }, firstEpoch: 1, count: 3 }))).toBe("installment_amount_too_small");
    expect(code(() => planInstallments({ circle: CIRCLE, doc, firstEpoch: 0, count: 2 }))).toBe("installment_bad_epoch");
    expect(code(() => planInstallments({ circle: CIRCLE, doc, firstEpoch: 1, count: 2.5 }))).toBe("installment_count");
  });

  it("TC-SD-065-11 [F9] catchUpVoucherFromChain reads the state of the pair from the contract itself: the epoch after the installment, the debtor and the issuer", async () => {
    const asked: unknown[] = [];
    const view = async (a: { epoch: number; debtor: string; creditor: string }) => (asked.push(a), a.epoch === 21 ? { cumulative: "33333333", last_seq: 1 } : null);
    const v = await catchUpVoucherFromChain(plan, 1, view, false);
    expect(asked).toEqual([{ epoch: 21, debtor: DEBTOR, creditor: ISSUER }]);
    expect(v).toMatchObject({ epoch: 21, seq: 2, cumulativeAmount: "66666667" });
    // a pair with no voucher yet in that epoch: seq 1
    expect(await catchUpVoucherFromChain(plan, 3, view, false)).toMatchObject({ epoch: 23, seq: 1, cumulativeAmount: "33333333" });
    await expect(catchUpVoucherFromChain(plan, 1, view, true)).rejects.toMatchObject({ code: "installment_already_shifted" });
  });
});
