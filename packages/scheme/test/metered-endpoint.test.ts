import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_QUANTITY, METERED_KINDS, METERED_PRESETS, METERED_UNITS, MeterRejection, createMeteredEndpoint, type MeteredKind } from "@x207/scheme";
import { B, EXTRA, REQ, facilitator, payloadOf, required, sign } from "./helpers/middleware-fixtures.js";

const mount = (endpoint: ReturnType<typeof createMeteredEndpoint>) => {
  const { fetchMock, calls } = facilitator();
  const run = endpoint.mount("/api/work", { facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B, fetch: fetchMock as unknown as typeof fetch });
  return { run, calls, call: (query: string, headers: Record<string, string> = {}) => run(new Request(`https://provider.example/api/work${query}`, { headers })) };
};
const reject = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof MeterRejection ? e.message : `other: ${String(e)}`;
  }
};

describe("SD-064 createMeteredEndpoint", () => {
  it("TC-SD-064-01 twelve kinds, each built with one line of configuration, with a distinct catalog asset type, class D and a default unit the listing knows", () => {
    expect(METERED_KINDS).toHaveLength(12);
    const seen = new Set<string>();
    for (const kind of METERED_KINDS) {
      const e = createMeteredEndpoint({ kind, unitPrice: "$0.01", handler: () => new Response("ok") });
      expect(e.assetClass).toBe("D");
      expect(e.assetType).toBe(METERED_PRESETS[kind].assetType);
      expect(METERED_UNITS).toContain(e.unit);
      expect(e.unitPriceAtomic).toBe("10000");
      expect(e.maxQuantity).toBe(String(DEFAULT_MAX_QUANTITY[e.unit]));
      expect(e.warnings.length).toBeGreaterThan(0);
      seen.add(e.assetType);
    }
    expect(seen.size).toBe(12);
    expect(METERED_PRESETS["proxy-bandwidth"].warnings.join(" ")).toMatch(/hukum setempat/);
    expect(METERED_PRESETS["home-device"].warnings.join(" ")).toMatch(/Listrik/);
  });

  it("TC-SD-064-02 a kind accepts only units that fit it; an unknown kind, a unit of another kind and a bad price are refused", () => {
    const ok = (kind: MeteredKind, unit: (typeof METERED_UNITS)[number]) => reject(() => createMeteredEndpoint({ kind, unit, unitPrice: 1, handler: () => new Response() }));
    expect(ok("cpu", "job")).toBe("no error");
    expect(ok("storage", "GB")).toBe("no error");
    expect(ok("cpu", "GB")).toMatch(/tidak cocok untuk cpu/);
    expect(ok("fine-tuning", "minute")).toMatch(/tidak cocok/);
    expect(reject(() => createMeteredEndpoint({ kind: "nuclear" as MeteredKind, unitPrice: 1, handler: () => new Response() }))).toMatch(/jenis tidak dikenal/);
    expect(reject(() => createMeteredEndpoint({ kind: "cpu", unitPrice: "abc", handler: () => new Response() }))).toMatch(/harga tidak sah/);
    expect(reject(() => createMeteredEndpoint({ kind: "cpu", unitPrice: 0, handler: () => new Response() }))).toMatch(/menghasilkan 0/);
  });

  it("TC-SD-064-03 two kinds with different units: a CPU job per minute and a data feed per call give the metered 402, and the handler does not run before payment", async () => {
    const handler = vi.fn(() => new Response("done"));
    const cpu = mount(createMeteredEndpoint({ kind: "cpu", unitPrice: "$0.01", handler }));
    const response = await cpu.call("?quantity=30");
    expect(response.status).toBe(402);
    expect(required(response).accepts[0]).toMatchObject({ amount: "300000", extra: { meter: { unit: "minute", quantity: "30", unit_price: "10000", max_quantity: "1440" } } });
    const feed = mount(createMeteredEndpoint({ kind: "data-feed", unitPrice: 0.002, handler }));
    expect(required(await feed.call("")).accepts[0]).toMatchObject({ amount: "2000", extra: { meter: { unit: "call", quantity: "1", unit_price: "2000", max_quantity: "1000" } } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-064-04 above the ceiling the request is refused 413 before any 402; the ceiling can be set per endpoint", async () => {
    const e = mount(createMeteredEndpoint({ kind: "cdn", unitPrice: 0.02, handler: () => new Response("x") }));
    expect((await e.call("?quantity=1000.000001")).status).toBe(413);
    expect((await e.call("?quantity=1000")).status).toBe(402);
    const tight = mount(createMeteredEndpoint({ kind: "cdn", unitPrice: 0.02, maxQuantity: 5, handler: () => new Response("x") }));
    expect((await tight.call("?quantity=6")).status).toBe(413);
    const job = mount(createMeteredEndpoint({ kind: "fine-tuning", unitPrice: 2, handler: () => new Response("x") }));
    expect((await job.call("?quantity=2")).status).toBe(413); // one job per request: longer jobs use MeteredJob
    expect((await job.call("?quantity=abc")).status).toBe(400);
  });

  it("TC-SD-064-05 a valid voucher runs the handler once with the unit and the quantity that were paid", async () => {
    const seen: unknown[] = [];
    const e = mount(createMeteredEndpoint({ kind: "storage", unitPrice: 0.02, handler: (_r, ctx) => (seen.push(ctx), new Response("stored")) }));
    const accepted = { ...REQ, amount: "50000", extra: { ...EXTRA, meter: { unit: "GB", quantity: "2.5", unit_price: "20000", max_quantity: "1000" } } };
    const payload = payloadOf(accepted);
    payload.payload.voucher.cumulativeAmount = "50000";
    const response = await e.call("?quantity=2.5", sign(payload));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ unit: "GB", quantity: "2.5", kind: "storage" }]);
  });

  it("TC-SD-064-06 listingDetail is the flat JSON of BE-050 and refuses an endpoint that is not https or that carries a credential", () => {
    const e = createMeteredEndpoint({ kind: "gpu", unitPrice: "$0.5", handler: () => new Response() });
    expect(JSON.parse(e.listingDetail("https://gpu.example.com/run"))).toEqual({ kind: "gpu", unit: "minute", unit_price: "500000", endpoint: "https://gpu.example.com/run" });
    for (const bad of ["http://gpu.example.com", "https://u:p@gpu.example.com", "https://gpu.example.com/run?api_key=1", "https://gpu.example.com/#x", "nope"]) {
      expect(reject(() => e.listingDetail(bad)), bad).toMatch(/endpoint/);
    }
  });
});
