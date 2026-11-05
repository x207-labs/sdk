// UM-185: the one-line example of the READMEs. An agent that already uses @x402/fetch adds x207 with one `register` call on its x402Client.
// The test runs that line against a fake seller: a 402 that offers the x207 entry, then a 200 for the retry that carries the voucher.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { x402Client } from "@x402/core/client";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { describe, expect, it } from "vitest";
import { verifyVoucher, voucherPublicKey, type X207Payload } from "@x207/core";
import { X207SchemeClient } from "@x207/scheme";

const seed = Buffer.from(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys.kA.seed,
  "hex",
);
const PAYER = "translator.x207-circle.near";
const requirements = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: "summarizer.x207-circle.near",
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
} satisfies PaymentRequirements;

describe("UM-185 the README line: x402Client.register('x207:<circleId>', new X207SchemeClient(...))", () => {
  it("TC-UM-185-01 an @x402/fetch client with that one line pays a 402 that offers the x207 entry with a voucher", async () => {
    // the line of the README
    const client = new x402Client().register("x207:agents-main", new X207SchemeClient({ payer: PAYER, secretKey: seed }));

    const seen: Array<string | null> = [];
    const sellerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const signature = request.headers.get("PAYMENT-SIGNATURE");
      seen.push(signature);
      if (signature === null) {
        const paymentRequired = { x402Version: 2, resource: { url: request.url }, accepts: [requirements] };
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } });
      }
      return new Response("ok", { status: 200 });
    };

    const response = await wrapFetchWithPayment(sellerFetch, client)("https://summarizer.example/api/summarize");
    expect(response.status).toBe(200);
    expect(seen[0]).toBeNull();
    const payload = decodePaymentSignatureHeader(seen[1]!);
    expect(payload.accepted.network).toBe("x207:agents-main");
    const { voucher, signature } = payload.payload as unknown as X207Payload;
    expect(voucher.payer).toBe(PAYER);
    expect(voucher.payee).toBe(requirements.payTo);
    expect(verifyVoucher({ ...voucher, signature }, voucherPublicKey(seed))).toBe(true);
  });
});
