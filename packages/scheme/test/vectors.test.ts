import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { validatePaymentPayload, verifyVoucher, type Voucher } from "@x207/core";
import { MemoryVoucherStateStore, X207SchemeClient, X207_NETWORK_FAMILY } from "@x207/scheme";

const read = (path: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../spec/test-vectors/${path}`, import.meta.url)), "utf8"),
  ) as any;

describe("SD-007 test vector voucher di @x207/scheme", () => {
  it("klien menghasilkan voucher dan tanda tangan yang sama dengan voucher/valid.json", async () => {
    const { input } = read("voucher/valid.json");
    const { signature, ...unsigned } = input.voucher as Voucher;
    const seed = Buffer.from(read("keys.json").keys.kA.seed, "hex");
    const store = new MemoryVoucherStateStore();
    await store.commit(
      { payer: unsigned.payer, payee: unsigned.payee, epoch: unsigned.epoch },
      { seq: unsigned.seq - 1, cumulativeAmount: "2720000" },
    );
    const client = new x402Client().register(
      X207_NETWORK_FAMILY,
      new X207SchemeClient({ payer: unsigned.payer, secretKey: seed, store }),
    );
    const payment = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: unsigned.resource },
      accepts: [read("payload/payment_signature_agents_main.json").input.paymentPayload.accepted],
    });
    const made = payment.payload as any;
    expect(made.voucher).toEqual(unsigned);
    expect(made.signature).toBe(signature);
    expect(verifyVoucher({ ...made.voucher, signature: made.signature }, input.publicKey)).toBe(true);
  });

  it("header PAYMENT-SIGNATURE vector terbaca scheme dan sama setelah dibangun ulang", () => {
    const { input, expected } = read("payload/payment_signature_agents_main.json");
    expect(decodePaymentSignatureHeader(expected.header)).toEqual(input.paymentPayload);
    expect(validatePaymentPayload(input.paymentPayload).ok).toBe(true);
    expect(encodePaymentSignatureHeader(input.paymentPayload)).toBe(expected.header);
  });
});
