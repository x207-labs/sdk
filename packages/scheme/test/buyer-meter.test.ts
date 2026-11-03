import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, verifyVoucher, type UnsignedVoucher, type X207Payload } from "@x207/core";
import { BuyerMeter, MemoryVoucherStateStore, MeterOverbilledError, X207SchemeClient, X207_NETWORK_FAMILY } from "@x207/scheme";

const SEED = Buffer.from(JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed, "hex");
const PAYER = "translator.x207-circle.near";
const PAYEE = "summarizer.x207-circle.near";
const keys = generateVoucherKeypair();

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof MeterOverbilledError ? e.code : `other: ${String(e)}`;
  }
};
const voucher = (cumulativeAmount: string): UnsignedVoucher => ({
  circle: "x207-circle.near", payer: PAYER, payee: PAYEE, epoch: 42, seq: 1, cumulativeAmount, unit: "credit", resource: "job:j1",
});
// 0.02 credit per GB = 20000 smallest units
const gb = () => new BuyerMeter({ epoch: 42, unit: "GB", unitPrice: 0.02 });

describe("SD-068 buyer-side count", () => {
  it("TC-SD-068-01 a bill of 10 GB for 2 GB gets no voucher above 2 GB: after use, and in advance", () => {
    const m = gb();
    m.recordBytes(2_000_000_000n);
    expect(m.received).toBe("2");
    expect(m.ceiling()).toBe(40_000n);
    expect(code(() => m.checkVoucher("200000", 42))).toBe("meter_overbilled"); // 10 GB
    expect(code(() => m.checkVoucher("40001", 42))).toBe("meter_overbilled");
    expect(code(() => m.checkVoucher("40000", 42))).toBe("no error");
    expect(code(() => m.sign(voucher("200000"), keys.secretKey))).toBe("meter_overbilled");
    expect(verifyVoucher(m.sign(voucher("40000"), keys.secretKey), keys.publicKey)).toBe(true);
    // in advance: the buyer asked for 2 GB, the 402 says 10 GB
    const asked = gb();
    asked.expect(2);
    expect(code(() => asked.authorize({ unit: "GB", quantity: "10", unit_price: "20000" }, "200000"))).toBe("meter_quantity_over_expected");
    expect(code(() => asked.checkVoucher("200000", 42))).toBe("meter_overbilled");
    expect(code(() => asked.authorize({ unit: "GB", quantity: "2", unit_price: "20000" }, "40000"))).toBe("no error");
  });

  it("TC-SD-068-02 the 402 must match what was agreed: unit, price per unit, quantity, total, and a missing announcement", () => {
    const m = gb();
    m.expect("2.5");
    const ok = { unit: "GB", quantity: "2.5", unit_price: "20000" };
    expect(code(() => m.authorize(ok, "50000"))).toBe("no error");
    expect(code(() => m.authorize(undefined, "50000"))).toBe("meter_missing");
    expect(code(() => m.authorize({ ...ok, unit: "minute" }, "50000"))).toBe("meter_unit_mismatch");
    expect(code(() => m.authorize({ ...ok, unit_price: "20001" }, "50003"))).toBe("meter_price_too_high");
    expect(code(() => m.authorize({ ...ok, unit_price: "10000", quantity: "2.5" }, "25000"))).toBe("no error"); // cheaper is fine
    expect(code(() => m.authorize(ok, "50001"))).toBe("meter_amount_mismatch");
    expect(code(() => m.authorize({ ...ok, quantity: "2.500001" }, "50001"))).toBe("meter_quantity_over_expected");
  });

  it("TC-SD-068-03 without an expectation the ceiling per request applies; with neither only the price is checked", () => {
    const capped = new BuyerMeter({ epoch: 42, unit: "call", unitPrice: 0.001, maxQuantityPerRequest: 100 });
    expect(code(() => capped.authorize({ unit: "call", quantity: "100", unit_price: "1000" }, "100000"))).toBe("no error");
    expect(code(() => capped.authorize({ unit: "call", quantity: "101", unit_price: "1000" }, "101000"))).toBe("meter_quantity_over_expected");
    const open = new BuyerMeter({ epoch: 42, unit: "call", unitPrice: 0.001 });
    expect(code(() => open.authorize({ unit: "call", quantity: "5000", unit_price: "1000" }, "5000000"))).toBe("no error");
  });

  it("TC-SD-068-04 the count: bytes become GB, milliseconds become minutes or days, calls are integers; a count in the wrong unit is refused", () => {
    const m = gb();
    m.recordBytes(1_500_000_000);
    m.recordBytes(500_000_000);
    expect(m.received).toBe("2");
    const minutes = new BuyerMeter({ epoch: 42, unit: "minute", unitPrice: 0.01 });
    minutes.recordMillis(90_000);
    expect(minutes.received).toBe("1.5");
    expect(minutes.ceiling()).toBe(15_000n);
    const days = new BuyerMeter({ epoch: 42, unit: "day", unitPrice: 1 });
    days.recordMillis(43_200_000);
    expect(days.received).toBe("0.5");
    const calls = new BuyerMeter({ epoch: 42, unit: "call", unitPrice: 0.002 });
    calls.recordCalls();
    calls.recordCalls(4);
    expect(calls.received).toBe("5");
    expect(code(() => calls.recordCalls(1.5))).toBe("meter_bad_count");
    expect(code(() => calls.recordBytes(10))).toBe("meter_unit_mismatch");
    expect(code(() => m.recordMillis(10))).toBe("meter_unit_mismatch");
    expect(code(() => m.recordBytes(-1))).toBe("meter_bad_count");
    expect(code(() => m.record("1.1234567"))).toBe("meter_bad_count");
  });

  it("TC-SD-068-05 the ceiling rounds up to the smallest credit unit, a record reduces what was expected, and nothing counted gives a ceiling of 0", () => {
    const m = new BuyerMeter({ epoch: 42, unit: "GB", unitPrice: "$0.000003" });
    expect(m.ceiling()).toBe(0n);
    expect(code(() => m.checkVoucher("1", 42))).toBe("meter_overbilled");
    m.expect(1);
    m.expect(1);
    expect(m.pending).toBe("2");
    m.record("0.5");
    expect(m.pending).toBe("1.5");
    expect(m.received).toBe("0.5");
    expect(m.ceiling()).toBe(6n); // 2 GB x 3 = 6
    m.record(10);
    expect(m.pending).toBe("0");
    expect(m.ceiling()).toBe(32n); // 10.5 GB x 3 = 31.5, rounded up
  });

  it("TC-SD-068-06 inside the client: a 402 that bills more than asked is refused before any voucher is signed, and a right one is signed", async () => {
    const meter = gb();
    const store = new MemoryVoucherStateStore();
    const scheme = new X207SchemeClient({ payer: PAYER, secretKey: SEED, store, meter });
    const client = new x402Client().register(X207_NETWORK_FAMILY, scheme);
    const req = (quantity: string, amount: string, withMeter = true): PaymentRequirements => ({
      scheme: "batch-settlement", network: "x207:agents-main", amount, asset: "USD", payTo: PAYEE, maxTimeoutSeconds: 60,
      extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42, ...(withMeter ? { meter: { unit: "GB", quantity, unit_price: "20000" } } : {}) },
    });
    const pay = (r: PaymentRequirements) => client.createPaymentPayload({ x402Version: 2, resource: { url: "https://seller.example/api" }, accepts: [r] });
    meter.expect(2);
    await expect(pay(req("10", "200000"))).rejects.toThrow(MeterOverbilledError);
    await expect(pay(req("2", "40000", false))).rejects.toMatchObject({ code: "meter_missing" });
    expect(await store.get({ payer: PAYER, payee: PAYEE, epoch: 42 })).toEqual({ seq: 0, cumulativeAmount: "0" });
    const ok = await pay(req("2", "40000"));
    expect((ok.payload as unknown as X207Payload).voucher.cumulativeAmount).toBe("40000");
  });

  it("TC-SD-068-07 [F3] the ceiling is per epoch: what was received in epoch 1 does not cover a voucher of epoch 2, and the base of the pair is added", () => {
    const m = new BuyerMeter({ epoch: 1, unit: "call", unitPrice: "1" });
    m.recordCalls(10); // 10 credit received and paid in epoch 1
    expect(code(() => m.checkVoucher("10000000", 1))).toBe("no error");
    expect(code(() => m.checkVoucher("10000000", 2))).toBe("meter_wrong_epoch"); // the voucher of another epoch is refused until startEpoch
    m.startEpoch(2, "0");
    expect(m.epoch).toBe(2);
    expect(m.received).toBe("0");
    expect(code(() => m.checkVoucher("10000000", 2))).toBe("meter_overbilled"); // nothing received in epoch 2: no voucher of 10 credit
    m.recordCalls(3);
    expect(code(() => m.checkVoucher("3000000", 2))).toBe("no error");
    expect(code(() => m.checkVoucher("3000001", 2))).toBe("meter_overbilled");
    // a pair that already holds 5 credit in the epoch: the ceiling is the base plus the price of what was received
    const second = new BuyerMeter({ epoch: 7, unit: "call", unitPrice: "1", baseCumulative: "5000000" });
    second.recordCalls(2);
    expect(second.ceiling()).toBe(7_000_000n);
    expect(code(() => second.checkVoucher("7000000", 7))).toBe("no error");
    expect(code(() => second.checkVoucher("7000001", 7))).toBe("meter_overbilled");
    expect(code(() => second.checkVoucher("1000000", 6))).toBe("meter_wrong_epoch");
  });

  it("TC-SD-068-08 [F3] the epoch only goes forward and the base is a decimal whole number", () => {
    const m = new BuyerMeter({ epoch: 5, unit: "call", unitPrice: "1" });
    expect(code(() => m.startEpoch(5))).toBe("meter_wrong_epoch");
    expect(code(() => m.startEpoch(4))).toBe("meter_wrong_epoch");
    expect(code(() => m.startEpoch(6, "0x10"))).toBe("meter_bad_count");
    expect(code(() => new BuyerMeter({ epoch: 0, unit: "call", unitPrice: "1" }))).toBe("meter_wrong_epoch");
    expect(code(() => new BuyerMeter({ epoch: 1, unit: "call", unitPrice: "1", baseCumulative: "-1" }))).toBe("meter_bad_count");
    expect(code(() => m.sign(voucher("1000000"), keys.secretKey))).toBe("meter_wrong_epoch"); // the voucher helper is for epoch 42
  });
});
