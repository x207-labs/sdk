// SD-121: middleware option settleMode "register-first". The seller serves only after the voucher is registered on-chain; the facilitator's /verify alone is not enough.
import { describe, expect, it, vi } from "vitest";
import { A, B, NETWORK, REQ_EXACT, SETTLED, paymentResponse, payloadOf, required, setup, sign, type Mock } from "./helpers/middleware-fixtures.js";
import { x207Middleware, type RegisterVoucherFn } from "@x207/scheme";

const ok: RegisterVoucherFn = async () => ({ ok: true });
const mode = (registerVoucher: RegisterVoucherFn | undefined, settleMode: "register-first" | "verify-first" | null = "register-first") =>
  ({ ...(settleMode ? { settleMode } : {}), ...(registerVoucher ? { registerVoucher } : {}) });

describe("SD-121 register-first", () => {
  it("TC-SD-121-01 refuses to be built without registerVoucher", () => {
    expect(() => x207Middleware({ routes: {}, facilitatorUrl: "http://f.test", circleId: "agents-main", payTo: B, settleMode: "register-first" })).toThrow(/registerVoucher/);
  });

  it("TC-SD-121-02 registers the voucher, then runs the handler, and never calls /settle", async () => {
    const register = vi.fn(ok);
    const { run, handler, calls } = setup({}, mode(register));
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    const arg = register.mock.calls[0]![0];
    expect(arg.voucher).toMatchObject({ payer: A, payee: B, epoch: 42, seq: 1 });
    expect(arg.signature).toBe("ed25519:sig");
    expect(calls.map((c) => c.path)).not.toContain("/settle");
    const settled = paymentResponse(response);
    expect(settled).toMatchObject({ success: true, transaction: `${A}:${B}:42:1`, network: NETWORK, payer: A });
    expect(settled.extensions.x207).toMatchObject({ epoch: 42, seq: 1, registration: "registered" });
  });

  it("TC-SD-121-03 a voucher the contract refuses: 402, the handler does not run, the code is in the answer", async () => {
    const { run, handler } = setup({}, mode(async () => ({ ok: false, reason: "ERR_INSUFFICIENT_CREDIT" })));
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(handler).not.toHaveBeenCalled();
    expect(required(response).error).toBe("insufficient_credit");
    expect(paymentResponse(response)).toMatchObject({ success: false, errorReason: "insufficient_credit", extensions: { x207: { contractCode: "ERR_INSUFFICIENT_CREDIT" } } });
  });

  it("TC-SD-121-04 the old mode serves although the contract would refuse (the gap): facilitator says valid, handler runs, registerVoucher is never asked", async () => {
    const register = vi.fn(async () => ({ ok: false, reason: "ERR_INSUFFICIENT_CREDIT" }) as const);
    const { run, handler } = setup({}, mode(register, null));
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(register).not.toHaveBeenCalled();
  });

  it("TC-SD-121-05 /verify invalid: registerVoucher is not called", async () => {
    const register = vi.fn(ok);
    const mock: Mock = { verify: () => ({ isValid: false, invalidReason: "bad_signature" }) };
    const { run, handler } = setup(mock, mode(register));
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(register).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-121-06 registerVoucher throws (RPC down): 503 with Retry-After, handler does not run", async () => {
    const { run, handler } = setup({}, mode(async () => { throw new Error("rpc down"); }));
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(handler).not.toHaveBeenCalled();
  });

  it("TC-SD-121-07 handler error after registration: response passed through, no PAYMENT-RESPONSE", async () => {
    const { fetchMock } = (await import("./helpers/middleware-fixtures.js")).facilitator({});
    const middleware = x207Middleware({
      routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", payTo: B,
      fetch: fetchMock as unknown as typeof fetch, ...mode(ok),
    });
    const response = await middleware(new Request("https://summarizer.example/api/summarize", { headers: sign(payloadOf()) }), async () => new Response("boom", { status: 500 }));
    expect(response.status).toBe(500);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });

  it("TC-SD-121-08 a payment for the exact entry is not registered by the middleware (x207 entry only)", async () => {
    const register = vi.fn(ok);
    const { run, calls } = setup({ settle: () => SETTLED }, mode(register));
    const response = await run(sign({ ...payloadOf(REQ_EXACT), payload: { transaction: "x" } }));
    expect(register).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toContain("/verify");
    expect([200, 402]).toContain(response.status);
  });

  it("TC-SD-121-09 two sellers, two facilitators, total above the limit: the second voucher is refused by the contract and that seller does not serve", async () => {
    // contract model: limit 30000 credit units for the payer; first come, first served
    let used = 0;
    const limit = 30_000;
    const contract: RegisterVoucherFn = async ({ voucher }) => {
      const amount = Number(voucher.cumulativeAmount);
      if (used + amount > limit) return { ok: false, reason: "ERR_INSUFFICIENT_CREDIT" };
      used += amount;
      return { ok: true };
    };
    const first = setup({}, mode(contract));
    const second = setup({}, mode(contract));
    const oldMode = setup({}, mode(undefined, null));
    const v = (cumulative: string) => ({ ...payloadOf(), payload: { ...payloadOf().payload, voucher: { ...payloadOf().payload.voucher, cumulativeAmount: cumulative } } });
    expect((await first.run(sign(v("20000")))).status).toBe(200);
    const late = await second.run(sign(v("20000")));
    expect(late.status).toBe(402);
    expect(second.handler).not.toHaveBeenCalled();
    // the old mode, behind its own facilitator that has not seen the first voucher, serves the same late voucher: that is the risk
    expect((await oldMode.run(sign(v("20000")))).status).toBe(200);
    expect(oldMode.handler).toHaveBeenCalledOnce();
  });
});
