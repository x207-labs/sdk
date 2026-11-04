import { describe, expect, it, vi } from "vitest";
import { MeterRejection, meterAmount, resolvePrice, x207Middleware, type PriceFn } from "@x207/scheme";
import { A, B, EXTRA, REQ, URL_, facilitator, payloadOf, required, sign } from "./helpers/middleware-fixtures.js";

/** A route whose price is a function of the request: `?gb=` gigabytes at 0.02 credit each. */
function metered(price: PriceFn, options: { maxQuantity?: number | string } = {}) {
  const { fetchMock, calls } = facilitator();
  const middleware = x207Middleware({
    routes: { "/api/download": { price, ...options } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
    fetch: fetchMock as unknown as typeof fetch,
  });
  const handler = vi.fn(async () => new Response("bytes", { status: 200 }));
  const run = (query: string, headers: Record<string, string> = {}) => middleware(new Request(`https://summarizer.example/api/download${query}`, { headers }), handler);
  return { run, handler, calls };
}
const perGb: PriceFn = (request) => ({ unit: "GB", quantity: new URL(request.url).searchParams.get("gb") ?? "1", unitPrice: "$0.02" });

describe("SD-062 metered price per request", () => {
  it("TC-SD-062-01 the amount is unitPrice x quantity and the 402 announces unit, quantity, unit price in extra.meter; the static price still works", async () => {
    const { run, handler } = metered(perGb);
    const response = await run("?gb=2.5");
    expect(response.status).toBe(402);
    const body = required(response);
    expect(body.accepts[0]).toMatchObject({ scheme: "batch-settlement", amount: "50000", extra: { ...EXTRA, meter: { unit: "GB", quantity: "2.5", unit_price: "20000" } } });
    expect(body.accepts[1]).toMatchObject({ scheme: "exact", amount: "50000", extra: {} }); // the exact entry carries the same amount and no meter
    expect(handler).not.toHaveBeenCalled();
    // the old static price is untouched: no meter, the amount of the fixture
    const { fetchMock } = facilitator();
    const fixed = x207Middleware({ routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B, fetch: fetchMock as unknown as typeof fetch });
    const old = required(await fixed(new Request(URL_), async () => new Response("x")));
    expect(old.accepts[0]).toEqual(REQ);
    expect(old.accepts[0].extra).not.toHaveProperty("meter");
  });

  it("TC-SD-062-02 per second and per job: other units, whole and fractional quantities, rounded up to the smallest credit unit", async () => {
    const perSecond = metered(() => ({ unit: "second", quantity: 90, unitPrice: 0.0003 }));
    expect(required(await perSecond.run("")).accepts[0]).toMatchObject({ amount: "27000", extra: { meter: { unit: "second", quantity: "90", unit_price: "300" } } });
    const perJob = metered(() => ({ unit: "job", quantity: "1", unitPrice: "$1.5" }));
    expect(required(await perJob.run("")).accepts[0]).toMatchObject({ amount: "1500000", extra: { meter: { unit: "job", quantity: "1", unit_price: "1500000" } } });
    // 0.5 of a unit that costs 0.000003 is 1.5 smallest units: rounded up to 2
    expect(meterAmount("3", 500000n)).toBe("2");
    expect(meterAmount("3", 1_000_000n)).toBe("3");
    expect(meterAmount("1", 1n)).toBe("1");
  });

  it("TC-SD-062-03 above the ceiling the request is refused 413 before any 402 and before the handler, with the unit and the limit", async () => {
    const { run, handler, calls } = metered(perGb, { maxQuantity: 10 });
    const refused = await run("?gb=10.000001");
    expect(refused.status).toBe(413);
    expect(refused.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(await refused.json()).toMatchObject({ error: "quantity_over_limit", unit: "GB", quantity: "10.000001", max_quantity: "10" });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/verify" || c.path === "/settle")).toBe(false);
    // at the ceiling it is a normal 402 that announces the limit
    const atLimit = required(await run("?gb=10"));
    expect(atLimit.accepts[0]).toMatchObject({ amount: "200000", extra: { meter: { quantity: "10", max_quantity: "10" } } });
  });

  it("TC-SD-062-08 [F8] meterAmount refuses a price that is not a decimal whole number above 0", () => {
    for (const bad of ["0x10", " 12 ", "", "-1", "1.5", "0"]) expect(() => meterAmount(bad, 1_000_000n), JSON.stringify(bad)).toThrow(MeterRejection);
    expect(meterAmount("20000", 1_000_000n)).toBe("20000");
  });

  it("TC-SD-062-04 the smaller of the ceiling of the route and the one of the quote applies", async () => {
    const quote: PriceFn = () => ({ unit: "GB", quantity: 6, unitPrice: 0.02, maxQuantity: 8 });
    expect((await metered(quote, { maxQuantity: 5 }).run("")).status).toBe(413);
    expect((await metered(quote, { maxQuantity: 9 }).run("")).status).toBe(402);
    const tight: PriceFn = () => ({ unit: "GB", quantity: 6, unitPrice: 0.02, maxQuantity: 4 });
    expect((await metered(tight, { maxQuantity: 9 }).run("")).status).toBe(413);
    expect(required(await metered(quote, { maxQuantity: 9 }).run("")).accepts[0].extra.meter.max_quantity).toBe("8");
  });

  it("TC-SD-062-05 invalid quotes are refused 400 before the 402: a bad unit, zero, negative or too many decimals, and a MeterRejection of the price function", async () => {
    const cases: Array<[string, PriceFn]> = [
      ["unit with a space", () => ({ unit: "per GB", quantity: 1, unitPrice: 0.02 })],
      ["empty unit", () => ({ unit: "", quantity: 1, unitPrice: 0.02 })],
      ["quantity 0", () => ({ unit: "GB", quantity: 0, unitPrice: 0.02 })],
      ["negative quantity", () => ({ unit: "GB", quantity: -1, unitPrice: 0.02 })],
      ["seven decimals", () => ({ unit: "GB", quantity: "0.1234567", unitPrice: 0.02 })],
      ["not a number", () => ({ unit: "GB", quantity: "lots", unitPrice: 0.02 })],
      ["rejected by the function", () => { throw new MeterRejection("gb is required"); }],
    ];
    for (const [name, price] of cases) {
      const { run, handler } = metered(price);
      const response = await run("");
      expect(response.status, name).toBe(400);
      expect(await response.json(), name).toMatchObject({ error: "invalid_quantity" });
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("TC-SD-062-06 a price function that fails for another reason is not hidden as a 400, and an async function works", async () => {
    const broken = metered(() => { throw new Error("database down"); });
    await expect(broken.run("")).rejects.toThrow("database down");
    const slow = metered(async (request) => ({ unit: "job", quantity: 1, unitPrice: new URL(request.url).searchParams.get("price") ?? "0.5" }));
    expect(required(await slow.run("?price=0.25")).accepts[0]).toMatchObject({ amount: "250000" });
  });

  it("TC-SD-062-07 a valid voucher for the metered amount is served: verify gets the metered requirement, the handler runs once, settle follows", async () => {
    const { run, handler, calls } = metered(perGb);
    const accepted = { ...REQ, amount: "40000", extra: { ...EXTRA, meter: { unit: "GB", quantity: "2", unit_price: "20000" } } };
    const payload = payloadOf(accepted);
    payload.payload.voucher.cumulativeAmount = "40000";
    const response = await run("?gb=2", sign(payload));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.path === "/verify")!.body.paymentRequirements).toEqual(accepted);
    expect(calls.some((c) => c.path === "/settle")).toBe(true);
    void A;
  });

  it("TC-SD-062-08 resolvePrice on its own: a static price has no announcement, a function gives amount and meter", async () => {
    expect(await resolvePrice("$0.02", new Request(URL_))).toEqual({ amount: "20000" });
    expect(await resolvePrice(0.5, new Request(URL_))).toEqual({ amount: "500000" });
    expect(await resolvePrice(() => ({ unit: "GB", quantity: "0.5", unitPrice: "$0.04" }), new Request(URL_))).toEqual({
      amount: "20000", meter: { unit: "GB", quantity: "0.5", unit_price: "40000" },
    });
    await expect(resolvePrice("$0", new Request(URL_))).rejects.toThrow(/0 unit/);
  });
});
