import { describe, expect, it, vi } from "vitest";
import {
  A, B, NETWORK, REQ, REQ_EXACT, SETTLED, URL_, facilitator, paymentResponse, payloadOf, required, setup, sign,
} from "./helpers/middleware-fixtures.js";

describe("SD-027 header PAYMENT-RESPONSE", () => {
  it("TC-SD-027-01 200 carries the header with commitment id and registration pending", async () => {
    const { run } = setup();
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(200);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe(Buffer.from(JSON.stringify(SETTLED)).toString("base64"));
    expect(paymentResponse(response)).toMatchObject({
      transaction: `${A}:${B}:42:1`, extensions: { x207: { registration: "pending" } },
    });
    expect(await response.json()).toEqual({ summary: "ok" });
  });

  it("TC-SD-027-03 settle fails: 402 with a PAYMENT-RESPONSE holding errorReason and lastSeq", async () => {
    const failed = { success: false, errorReason: "seq_not_increasing", transaction: "", network: NETWORK, payer: A, extensions: { x207: { epoch: 42, lastSeq: 137, lastCumulativeAmount: "2740000" } } };
    const { run } = setup({ settle: () => failed });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(paymentResponse(response)).toEqual(failed);
    expect(required(response).error).toBe("seq_not_increasing");
  });

  it("TC-SD-027-04 settlement_pending: 200 with handler and PAYMENT-RESPONSE", async () => {
    const pending = { success: false, errorReason: "settlement_pending", transaction: "", network: NETWORK, payer: A };
    const { run, handler } = setup({ settle: () => pending });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(paymentResponse(response)).toEqual(pending);
  });

  it("TC-SD-027-06 the exact path is unchanged: no extensions.x207", async () => {
    const exactSettled = { success: true, transaction: "txhash123", network: "near:mainnet", payer: A };
    const { run } = setup({ settle: () => exactSettled });
    const response = await run(sign(payloadOf(REQ_EXACT)));
    expect(response.status).toBe(200);
    expect(paymentResponse(response)).toEqual(exactSettled);
  });

  it.each(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"])(
    "TC-SD-027-07 resync after /verify rejects %s",
    async (reason) => {
      const { run, calls } = setup({ verify: () => ({ isValid: false, invalidReason: reason, payer: A }) });
      const response = await run(sign(payloadOf()));
      expect(response.status).toBe(402);
      expect(required(response).error).toBe(reason);
      expect(paymentResponse(response)).toEqual({
        success: false, errorReason: reason, transaction: "", network: NETWORK, payer: A,
        extensions: { x207: { epoch: 42, lastSeq: 137, lastCumulativeAmount: "2740000" } },
      });
      const pair = calls.find((c) => c.path === "/x207/pair-state");
      expect(pair).toBeDefined();
    },
  );

  it("TC-SD-027-07 pair-state timeout: 402 without PAYMENT-RESPONSE", async () => {
    const { run } = setup({ verify: () => ({ isValid: false, invalidReason: "seq_not_increasing" }), hang: ["/x207/pair-state"] }, { timeoutMs: 30 });
    const response = await run(sign(payloadOf()));
    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
  });

  it("another reason does not call pair-state", async () => {
    const { run, calls } = setup({ verify: () => ({ isValid: false, invalidReason: "insufficient_credit" }) });
    await run(sign(payloadOf()));
    expect(calls.some((c) => c.path === "/x207/pair-state")).toBe(false);
  });
});
