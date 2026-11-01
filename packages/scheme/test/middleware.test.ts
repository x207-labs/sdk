import { describe, expect, it, vi } from "vitest";
import { x207Middleware } from "@x207/scheme";
import {
  A, B, NETWORK, REQ, REQ_EXACT, SETTLED, URL_, facilitator, paymentResponse, payloadOf, required, setup, sign,
} from "./helpers/middleware-fixtures.js";

describe("SD-017 middleware server", () => {
  it("TC-SD-017-01 tanpa pembayaran: 402 dengan dua entri, handler tidak dipanggil", async () => {
    const { run, handler } = setup();
    const response = await run();
    expect(response.status).toBe(402);
    const body = required(response);
    expect(body).toMatchObject({ x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: "https://summarizer.example/api/summarize" } });
    expect(body.accepts).toEqual([REQ, REQ_EXACT]);
    expect(await response.json()).toEqual(body);
    expect(handler).not.toHaveBeenCalled();
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull(); // TC-SD-027-05
  });

  it("TC-SD-017-02 voucher sah: verify, handler, settle, 200", async () => {
    const { run, handler, calls } = setup();
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
    const verify = calls.find((c) => c.path === "/verify")!;
    expect(verify.body).toEqual({ x402Version: 2, paymentPayload: payloadOf(), paymentRequirements: REQ });
    expect(calls.map((c) => c.path).filter((p) => p !== "/supported")).toEqual(["/verify", "/settle"]);
  });

  it("TC-SD-017-03 pembayaran exact sah: 200", async () => {
    const { run, handler, calls } = setup();
    const response = await run(sign(payloadOf(REQ_EXACT)));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.path === "/verify")!.body.paymentRequirements).toEqual(REQ_EXACT);
  });

  it("TC-SD-017-04 insufficient_credit: 402 kedua tetap menawarkan exact", async () => {
    const { run, handler, calls } = setup({ verify: () => ({ isValid: false, invalidReason: "insufficient_credit", payer: A }) });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    const body = required(response);
    expect(body.error).toBe("insufficient_credit");
    expect(body.accepts).toContainEqual(REQ_EXACT);
    expect(handler).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/settle")).toBe(false);
  });

  it("TC-SD-017-05 penolakan lain: 402 dengan alasan", async () => {
    const { run, handler } = setup({ verify: () => ({ isValid: false, invalidReason: "invalid_signature" }) });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_signature");
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-017-06 handler gagal 5xx: /settle tidak dipanggil, status diteruskan", async () => {
    const { calls, handler } = setup();
    const { fetchMock } = facilitator();
    const middleware = x207Middleware({
      routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const response = await middleware(new Request(URL_, { headers: sign(payloadOf()) }), failing);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("boom");
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/settle"))).toBe(false);
    void calls; void handler;
  });

  it("TC-SD-017-07 facilitator lambat: 503 Retry-After 5, handler tidak dipanggil", async () => {
    const { run, handler } = setup({ hang: ["/verify"] }, { timeoutMs: 30 });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-017-08 facilitator 5xx: 503 Retry-After 5", async () => {
    const { run, handler } = setup({ status: { "/verify": 503 } });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-017-09 header rusak: 402 invalid_payload tanpa memanggil facilitator", async () => {
    const { run, calls } = setup();
    const response = await run({ "PAYMENT-SIGNATURE": "%%%" });
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_payload");
    expect(calls.some((c) => c.path === "/verify")).toBe(false);
  });

  it("TC-SD-017-10 rute tanpa harga diteruskan ke handler", async () => {
    const { run, handler, calls } = setup();
    const response = await run({}, "/health");
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("payload dengan entri yang tidak ditawarkan: 402 invalid_payload", async () => {
    const { run } = setup();
    const response = await run(sign(payloadOf({ ...REQ, network: "x207:other-circle" })));
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_payload");
  });

  it("/supported tidak terjangkau: 503", async () => {
    const { run } = setup({ supportedFails: true });
    expect((await run()).status).toBe(503);
  });
});

