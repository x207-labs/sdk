import { describe, expect, it, vi } from "vitest";
import { x207Middleware } from "@x207/scheme";
import {
  A, B, NETWORK, REQ, REQ_EXACT, SETTLED, URL_, facilitator, paymentResponse, payloadOf, required, setup, sign,
} from "./helpers/middleware-fixtures.js";

describe("SD-017 server middleware", () => {
  it("TC-SD-017-01 no payment: 402 with two entries, handler not called", async () => {
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

  it("TC-SD-017-04 insufficient_credit: the second 402 still offers exact", async () => {
    const { run, handler, calls } = setup({ verify: () => ({ isValid: false, invalidReason: "insufficient_credit", payer: A }) });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    const body = required(response);
    expect(body.error).toBe("insufficient_credit");
    expect(body.accepts).toContainEqual(REQ_EXACT);
    expect(handler).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/settle")).toBe(false);
  });

  it("TC-SD-017-05 other rejection: 402 with a reason", async () => {
    const { run, handler } = setup({ verify: () => ({ isValid: false, invalidReason: "invalid_signature" }) });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_signature");
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-017-06 handler fails 5xx: /settle is not called, status passed through", async () => {
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

  it("TC-SD-017-07 slow facilitator: 503 Retry-After 5, handler not called", async () => {
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

  it("TC-SD-017-09 broken header: 402 invalid_payload without calling the facilitator", async () => {
    const { run, calls } = setup();
    const response = await run({ "PAYMENT-SIGNATURE": "%%%" });
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_payload");
    expect(calls.some((c) => c.path === "/verify")).toBe(false);
  });

  it("TC-SD-017-10 a route without a price goes to the handler", async () => {
    const { run, handler, calls } = setup();
    const response = await run({}, "/health");
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("payload with an entry that was not offered: 402 invalid_payload", async () => {
    const { run } = setup();
    const response = await run(sign(payloadOf({ ...REQ, network: "x207:other-circle" })));
    expect(response.status).toBe(402);
    expect(required(response).error).toBe("invalid_payload");
  });

  it("/supported unreachable: 503", async () => {
    const { run } = setup({ supportedFails: true });
    expect((await run()).status).toBe(503);
  });

  it("TC-SD-017-30 one voucher pays one request at a time: parallel requests with one voucher serve the resource once (R1)", async () => {
    const { fetchMock } = facilitator();
    const middleware = x207Middleware({
      routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response("served", { status: 200 });
    });
    const headers = sign(payloadOf());
    const responses = await Promise.all(Array.from({ length: 5 }, () => middleware(new Request(URL_, { headers }), slow)));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(slow).toHaveBeenCalledTimes(1);
    const refused = responses.filter((r) => r.status === 409);
    expect(refused).toHaveLength(4);
    expect(await refused[0]!.json()).toMatchObject({ error: "voucher_in_flight" });
  });

  it("TC-SD-017-31 the voucher is given back after the request, also when the handler fails or the facilitator is down; another voucher is never blocked", async () => {
    const { fetchMock } = facilitator();
    const middleware = x207Middleware({
      routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const ok = vi.fn(async () => new Response("served", { status: 200 }));
    const headers = sign(payloadOf());
    expect((await middleware(new Request(URL_, { headers }), failing)).status).toBe(500);
    expect((await middleware(new Request(URL_, { headers }), ok)).status).toBe(200); // the failed handler made no obligation, so the same voucher may be tried again
    expect((await middleware(new Request(URL_, { headers: sign(payloadOf(REQ, 2)) }), ok)).status).toBe(200);
    const down = setup({ supportedFails: true });
    expect((await down.run(sign(payloadOf()))).status).toBe(503);
    expect((await down.run(sign(payloadOf()))).status).toBe(503); // 503 again, not 409: the failed request gave the voucher back
  });

  it("TC-SD-017-32 an injected guard decides: a shared store can say that the voucher is held elsewhere", async () => {
    const taken: string[] = [];
    const guard = { acquire: (id: string) => (taken.push(id), false), release: () => undefined };
    const { run, handler } = setup({}, { inFlight: guard });
    expect((await run(sign(payloadOf()))).status).toBe(409);
    expect(taken).toEqual([`${A}:${B}:42:1`]);
    expect(handler).not.toHaveBeenCalled();
  });
});
