// SD-020: the client's local spending limit is checked before the voucher is signed, even if the contract headroom is sufficient.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { verifyVoucher, voucherPublicKey, type X207Payload } from "@x207/core";
import { MemoryVoucherStateStore, SpendLimitError, X207SchemeClient, X207_NETWORK_FAMILY, type SpendLimit } from "@x207/scheme";

const SEED = Buffer.from(JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed, "hex");
const PUBKEY = voucherPublicKey(SEED);
const PAYER = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";

const req = (o: { payTo?: string; epoch?: number; amount?: string } = {}) =>
  ({
    scheme: "batch-settlement", network: "x207:agents-main", amount: o.amount ?? "20000", asset: "USD", payTo: o.payTo ?? B, maxTimeoutSeconds: 60,
    extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: o.epoch ?? 42 },
  }) satisfies PaymentRequirements;

function setup(spendLimit?: SpendLimit) {
  const store = new MemoryVoucherStateStore();
  const scheme = new X207SchemeClient({ payer: PAYER, secretKey: SEED, store, ...(spendLimit ? { spendLimit } : {}) });
  const client = new x402Client().register(X207_NETWORK_FAMILY, scheme);
  const pay = (r: PaymentRequirements = req()) => client.createPaymentPayload({ x402Version: 2, resource: { url: "https://seller.example/api" }, accepts: [r] });
  const respond = (p: PaymentPayload, success: boolean) =>
    client.handlePaymentResponse({ paymentPayload: p, requirements: p.accepted, settleResponse: { success, transaction: "x", network: p.accepted.network, ...(success ? {} : { errorReason: "insufficient_credit" }) } as never });
  return { scheme, store, pay, respond };
}
const voucherOf = (p: PaymentPayload) => (p.payload as unknown as X207Payload).voucher;

describe("SD-020 client spend controls", () => {
  it("TC-SD-020-01 per call: exceeding the limit is rejected, the voucher is not signed and the state does not advance", async () => {
    const { pay, store, scheme } = setup({ maxPerCall: "20000" });
    await expect(pay(req({ amount: "20001" }))).rejects.toThrow(SpendLimitError);
    await expect(pay(req({ amount: "20001" }))).rejects.toMatchObject({ limit: "per_call", amount: "20001", max: "20000" });
    expect(await store.get({ payer: PAYER, payee: B, epoch: 42 })).toEqual({ seq: 0, cumulativeAmount: "0" });
    expect(scheme.spentInEpoch(42)).toBe(0n);
    const ok = await pay(req({ amount: "20000" }));
    expect(voucherOf(ok).cumulativeAmount).toBe("20000");
    expect(verifyVoucher({ ...voucherOf(ok), signature: (ok.payload as unknown as X207Payload).signature }, PUBKEY)).toBe(true);
  });

  it("TC-SD-020-02 per epoch across payees: a payment that passes the total is rejected, other epochs are not affected", async () => {
    const { pay, respond, scheme } = setup({ maxPerEpoch: "50000" });
    await respond(await pay(req({ payTo: B })), true);
    await respond(await pay(req({ payTo: C })), true);
    expect(scheme.spentInEpoch(42)).toBe(40_000n);
    const err = await pay(req({ payTo: B })).catch((e) => e);
    expect(err).toBeInstanceOf(SpendLimitError);
    expect(err).toMatchObject({ limit: "per_epoch", spent: "40000", max: "50000" });
    // the next epoch starts from zero
    expect(voucherOf(await pay(req({ epoch: 43 }))).epoch).toBe(43);
  });

  it("TC-SD-020-03 rejected by the server: the budget is returned and the voucher state does not advance", async () => {
    const { pay, respond, scheme, store } = setup({ maxPerEpoch: "20000" });
    await respond(await pay(), false);
    expect(scheme.spentInEpoch(42)).toBe(0n);
    expect(await store.get({ payer: PAYER, payee: B, epoch: 42 })).toEqual({ seq: 0, cumulativeAmount: "0" });
    const again = await pay();
    expect(voucherOf(again).seq).toBe(1);
  });

  it("TC-SD-020-04 parallel payments do not pass the epoch limit", async () => {
    const { pay } = setup({ maxPerEpoch: "60000" });
    const results = await Promise.allSettled([pay(req({ payTo: B })), pay(req({ payTo: C })), pay(req({ payTo: "image.x207-circle.near" })), pay(req({ payTo: "gpu.x207-circle.near" }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("TC-SD-020-05 without a limit the old behavior stays: no rejection", async () => {
    const { pay, respond } = setup();
    // without spendLimit there is no rejection from the x207 client (x402Client itself has a default limit of $1 per payment)
    for (let i = 0; i < 5; i += 1) await respond(await pay(req({ amount: "900000" })), true);
  });
});
