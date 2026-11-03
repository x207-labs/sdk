import { encodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryVoucherStateStore,
  NoPayableRequirementsError,
  X207PaymentClient,
  X207SchemeClient,
  type HeadroomSource,
} from "@x207/scheme";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys;
const SEED = Buffer.from(keys.kA.seed, "hex");
const PAYER = "translator.x207-circle.near";
const PAYEE = "summarizer.x207-circle.near";
const CIRCLE = "x207-circle.near";
const RESOURCE = "https://summarizer.example/api/summarize";

const REQ: PaymentRequirements = {
  scheme: "batch-settlement",
  network: "x207:agents-main",
  amount: "20000",
  asset: "USD",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42 },
};
const EXACT: PaymentRequirements = {
  scheme: "exact",
  network: "near:mainnet",
  amount: "20000",
  asset: "usdt.tether-token.near",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};
const required = (accepts: PaymentRequirements[], error?: string): PaymentRequired => ({
  x402Version: 2,
  ...(error ? { error } : {}),
  resource: { url: RESOURCE },
  accepts,
});

const exactScheme = () => ({
  scheme: "exact" as const,
  // Seperti klien `exact` NEAR sungguhan: aset USDT dikenal supaya spend controls x402 meloloskannya.
  findDefaultAsset: (asset: string) =>
    asset === "usdt.tether-token.near" ? { asset, decimals: 6, symbol: "USDT" } : undefined,
  createPaymentPayload: vi.fn(async () => ({ x402Version: 2, payload: { transfer: "exact" } })),
});

function setup(headroom: string | null | Error, options: { now?: () => number } = {}) {
  const source = vi.fn<HeadroomSource>(async () => {
    if (headroom instanceof Error) throw headroom;
    return headroom;
  });
  const store = new MemoryVoucherStateStore();
  const client = new X207PaymentClient({ payer: PAYER, secretKey: SEED, headroom: source, store, ...options });
  const exact = exactScheme();
  client.register("near:*", exact);
  return { client, source, store, exact };
}

afterEach(() => vi.restoreAllMocks());

describe("SD-019 pemilihan entri", () => {
  it("TC-SD-019-01 enough headroom picks x207", async () => {
    const { client, exact } = setup("40000000");
    const payload = await client.createPaymentPayload(required([REQ, EXACT]));
    expect(payload.accepted.network).toBe("x207:agents-main");
    expect(exact.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("TC-SD-019-02 headroom 0 picks exact without signing a voucher", async () => {
    const spy = vi.spyOn(X207SchemeClient.prototype, "createPaymentPayload");
    const { client, store, exact } = setup("0");
    const payload = await client.createPaymentPayload(required([REQ, EXACT]));
    expect(payload.accepted.scheme).toBe("exact");
    expect(exact.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(await store.get({ payer: PAYER, payee: PAYEE, epoch: 42 })).toEqual({ seq: 0, cumulativeAmount: "0" });
  });

  it("TC-SD-019-03 exact limit picks x207", async () => {
    const { client } = setup("20000");
    expect((await client.createPaymentPayload(required([REQ, EXACT]))).accepted.scheme).toBe("batch-settlement");
  });

  it("TC-SD-019-04 a non-member picks exact", async () => {
    const { client } = setup(null);
    expect((await client.createPaymentPayload(required([REQ, EXACT]))).accepted.scheme).toBe("exact");
  });

  it("TC-SD-019-05 falls back to exact after insufficient_credit, one fetch function", async () => {
    const { client, exact } = setup("40000000");
    const paid: string[] = [];
    const server = vi.fn(async (input: Request) => {
      const signature = input.headers.get("PAYMENT-SIGNATURE");
      if (!signature) return paymentRequiredResponse(required([REQ, EXACT], "PAYMENT-SIGNATURE header is required"));
      const accepted = JSON.parse(Buffer.from(signature, "base64").toString("utf8")).accepted.scheme as string;
      paid.push(accepted);
      if (accepted === "batch-settlement") return paymentRequiredResponse(required([REQ, EXACT], "insufficient_credit"));
      return new Response("ok", { status: 200 });
    });
    const fetchWithPayment = wrapFetchWithPayment(server as unknown as typeof fetch, client);
    const response = await fetchWithPayment(RESOURCE);
    expect(response.status).toBe(200);
    expect(paid).toEqual(["batch-settlement", "exact"]);
    expect(exact.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(server).toHaveBeenCalledTimes(3);
  });

  it("TC-SD-019-06 only x207 and headroom 0 throws without signing", async () => {
    const spy = vi.spyOn(X207SchemeClient.prototype, "createPaymentPayload");
    const { client } = setup("0");
    await expect(client.createPaymentPayload(required([REQ]))).rejects.toBeInstanceOf(NoPayableRequirementsError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("TC-SD-019-07 headroom from the view, 60 second cache, reduced by payments", async () => {
    let t = 1_000_000;
    const { client, source } = setup("50000", { now: () => t });
    const first = await client.createPaymentPayload(required([REQ, EXACT]));
    expect(first.accepted.scheme).toBe("batch-settlement");
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith(CIRCLE, PAYER);
    // dua pembayaran berhasil: 50000 - 2 x 20000 = 10000 < 20000
    for (let i = 0; i < 2; i++) {
      const payload = i === 0 ? first : await client.createPaymentPayload(required([REQ, EXACT]));
      await client.handlePaymentResponse({
        paymentPayload: payload,
        requirements: payload.accepted,
        settleResponse: { success: true, transaction: "t", network: "x207:agents-main" },
      });
    }
    t += 30_000;
    expect((await client.createPaymentPayload(required([REQ, EXACT]))).accepted.scheme).toBe("exact");
    expect(source).toHaveBeenCalledTimes(1);
    t += 31_000; // total 61 detik: cache dibaca ulang, headroom pulih
    expect((await client.createPaymentPayload(required([REQ, EXACT]))).accepted.scheme).toBe("batch-settlement");
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("headroom view fails: still tries x207, the server decides", async () => {
    const { client } = setup(new Error("rpc down"));
    expect((await client.createPaymentPayload(required([REQ, EXACT]))).accepted.scheme).toBe("batch-settlement");
  });
});

function paymentRequiredResponse(body: PaymentRequired): Response {
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body), "content-type": "application/json" },
  });
}
