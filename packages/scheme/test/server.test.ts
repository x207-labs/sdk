import { parsePaymentRequirements } from "@x402/core/schemas";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import {
  X207ExtraSource,
  X207SchemeServer,
  buildPaymentRequirements,
  priceToAmount,
} from "@x207/scheme";

const B = "summarizer.x207-circle.near";
const NETWORK = "x207:agents-main" as const;
const RESOURCE = "https://summarizer.example/api/summarize";

const supportedBody = (epoch: number) => ({
  kinds: [
    { x402Version: 2, scheme: "batch-settlement", network: NETWORK, extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch } },
    { x402Version: 2, scheme: "exact", network: "near:mainnet" },
  ],
  extensions: [],
  signers: {},
});

function source(options: { epochs?: number[]; now?: () => number } = {}) {
  const epochs = [...(options.epochs ?? [42])];
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(supportedBody(epochs.length > 1 ? epochs.shift()! : epochs[0]!)), { status: 200 }),
  );
  const extra = new X207ExtraSource({ facilitatorUrl: "http://facilitator.test/", fetch: fetchMock as unknown as typeof fetch, ...(options.now ? { now: options.now } : {}) });
  return { extra, fetchMock };
}

const MODEL_DATA_REQ: PaymentRequirements = {
  scheme: "batch-settlement",
  network: NETWORK,
  amount: "20000",
  asset: "USD",
  payTo: B,
  maxTimeoutSeconds: 60,
  extra: { circleContract: "x207-circle.near", unit: "credit", decimals: 6, epoch: 42 },
};

describe("SD-016 parsePrice and buildPaymentRequirements", () => {
  it("TC-SD-016-01 harga string", async () => {
    const { extra } = source();
    const result = await new X207SchemeServer({ extra }).parsePrice("$0.02", NETWORK);
    expect(result).toEqual({ amount: "20000", asset: "USD", extra: MODEL_DATA_REQ.extra });
  });

  it("TC-SD-016-02 harga number", async () => {
    expect((await new X207SchemeServer().parsePrice(0.02, NETWORK)).amount).toBe("20000");
  });

  it("TC-SD-016-03 presisi float", () => {
    expect(priceToAmount(0.29)).toBe("290000");
    expect(priceToAmount("$0.29")).toBe("290000");
    expect(priceToAmount(1.1)).toBe("1100000");
    expect(priceToAmount("$12")).toBe("12000000");
  });

  it("TC-SD-016-04 pembulatan ke bawah", () => {
    expect(priceToAmount(0.0000019)).toBe("1");
    expect(priceToAmount("0.0000019")).toBe("1");
  });

  it("TC-SD-016-05 a zero, zero and negative result is rejected", () => {
    for (const price of [0.0000009, 0, -0.02, "$-1", "abc", "", Number.NaN, "$0", "1e-3"]) {
      expect(() => priceToAmount(price), String(price)).toThrow();
    }
  });

  it("an asset that is not USD is rejected, a network with a dot is rejected", async () => {
    const server = new X207SchemeServer();
    await expect(server.parsePrice({ amount: "1", asset: "usdt.tether-token.near" }, NETWORK)).rejects.toThrow(/USD/);
    await expect(server.parsePrice("$0.02", "x207:x207-circle.near")).rejects.toThrow();
    expect(await server.parsePrice({ amount: "5", asset: "USD" }, NETWORK)).toMatchObject({ amount: "5", asset: "USD" });
  });

  it("TC-SD-016-06 two entries in a row", async () => {
    const { extra } = source();
    const accepts = await buildPaymentRequirements({ circleId: "agents-main", payTo: B, price: "$0.02", resource: RESOURCE, extra });
    expect(accepts).toHaveLength(2);
    expect(accepts[0]).toEqual(MODEL_DATA_REQ);
    expect(accepts[1]).toMatchObject({
      scheme: "exact", network: "near:mainnet", amount: "20000", asset: "usdt.tether-token.near", payTo: B,
    });
    expect(accepts.map((a) => a.maxTimeoutSeconds)).toEqual([60, 60]);
  });

  it("TC-SD-016-07 extra from GET /supported", async () => {
    const { extra, fetchMock } = source({ epochs: [42] });
    expect(await extra.get(NETWORK)).toEqual(MODEL_DATA_REQ.extra);
    expect(fetchMock).toHaveBeenCalledWith("http://facilitator.test/supported");
    await expect(extra.get("x207:other")).rejects.toThrow(/does not support/);
  });

  it("TC-SD-016-08 cache of at most 60 seconds", async () => {
    let t = 0;
    const { extra, fetchMock } = source({ epochs: [42, 43], now: () => t });
    expect((await extra.get(NETWORK)).epoch).toBe(42);
    t = 30_000;
    expect((await extra.get(NETWORK)).epoch).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t = 61_000;
    expect((await extra.get(NETWORK)).epoch).toBe(43);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("TC-SD-016-09 lolos validasi skema @x402/core 2.28.0", async () => {
    const { extra } = source();
    for (const requirements of await buildPaymentRequirements({ circleId: "agents-main", payTo: B, price: "$0.02", extra })) {
      expect(() => parsePaymentRequirements(requirements)).not.toThrow();
    }
  });

  it("enhancePaymentRequirements completes extra from supportedKind and keeps the dynamic epoch", async () => {
    const server = new X207SchemeServer();
    expect(server.dynamicExtraFields).toEqual(["epoch"]);
    const enhanced = await server.enhancePaymentRequirements(
      { ...MODEL_DATA_REQ, extra: {} },
      { x402Version: 2, scheme: "batch-settlement", network: NETWORK, extra: MODEL_DATA_REQ.extra },
      [],
    );
    expect(enhanced).toEqual(MODEL_DATA_REQ);
  });

  it("a broken extra /supported is rejected", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ kinds: [{ scheme: "batch-settlement", network: NETWORK, extra: { epoch: "42" } }] })));
    const extra = new X207ExtraSource({ facilitatorUrl: "http://f.test", fetch: fetchMock as unknown as typeof fetch });
    await expect(extra.get(NETWORK)).rejects.toThrow(/not valid/);
  });
});
