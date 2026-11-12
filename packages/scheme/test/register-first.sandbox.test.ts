// SD-121 in near-sandbox: one buyer signs vouchers to two sellers, each behind its OWN facilitator (both say /verify valid), and the sum is above the limit of the buyer.
// The real contract is first come, first served: the first voucher registers, the second is refused with ERR_INSUFFICIENT_CREDIT. A seller in "register-first" mode does
// not serve the refused voucher; a seller in the default mode does (that is the gap the option closes). Skipped when the near-sandbox binary or the wasm files are missing.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ContractAbi, buildRegisterVoucherCall, createCircleViewFn, onboardMember, registerRefusal, signVoucher, type ContractCall,
} from "@x207/core";
import { x207Middleware, type RegisterVoucherFn } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { facilitator } from "./helpers/middleware-fixtures.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe.skipIf(!sandboxAvailable)("SD-121 register-first in near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-121-20 two sellers, two facilitators, total above the limit: the refused voucher is not served by the register-first seller, and is by the default seller", async () => {
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const joined = await onboardMember(
        {
          sendCall: async (c: ContractCall) => {
            const r = await account.call(c);
            if (r.failures.length > 0) throw new Error(r.failures.join("; "));
            return r.value;
          },
          view, pollIntervalMs: 200, timeoutMs: 30_000,
        },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "100000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, id: account.accountId, secretKey: joined.secretKey };
    };
    const buyer = await onboard("buyer");
    const [seller1, seller2, seller3] = [await onboard("seller1"), await onboard("seller2"), await onboard("seller3")];
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;
    const headroom = BigInt(await fx.sandbox.view<string>(fx.circle.accountId, "headroom", { account_id: buyer.id }));
    expect(headroom).toBeGreaterThan(0n);
    const each = (headroom * 6n) / 10n; // two of these are above the headroom, one is not
    expect(each * 2n).toBeGreaterThan(headroom);

    const network = `x207:${fx.circleId}`;
    const accepted = { scheme: "batch-settlement", network, amount: String(each), asset: "USD", maxTimeoutSeconds: 60, extra: {} };
    const voucherTo = (seller: { id: string }) =>
      signVoucher({ circle: fx.circle.accountId, payer: buyer.id, payee: seller.id, epoch, seq: 1, cumulativeAmount: String(each), unit: "credit", resource: "https://seller.example/api/summarize" }, buyer.secretKey);
    const header = (seller: { id: string }) => {
      const { signature, ...fields } = voucherTo(seller);
      return { "PAYMENT-SIGNATURE": b64({ x402Version: 2, resource: { url: "https://seller.example/api/summarize" }, accepted: { ...accepted, payTo: seller.id }, payload: { voucher: fields, signature } }) };
    };

    // the seller sends register_voucher from its own account; a contract refusal becomes { ok: false, reason }
    const registerFrom = (seller: { account: { call: (c: ContractCall, w?: string) => Promise<{ failures: string[] }> } }): RegisterVoucherFn => async ({ voucher, signature }) => {
      const r = await seller.account.call(buildRegisterVoucherCall({ circleContract: fx.circle.accountId, voucher, signature }), "FINAL");
      if (r.failures.length === 0) return { ok: true };
      const refusal = registerRefusal(new Error(r.failures.join("; ")));
      if (refusal === null) throw new Error(r.failures.join("; "));
      return refusal;
    };
    const seller = (s: { id: string; account: any }, registerFirst: boolean) => {
      const { fetchMock } = facilitator({}); // each seller has its own facilitator, which has not seen the other voucher
      const handler = vi.fn(async () => new Response("served", { status: 200 }));
      const middleware = x207Middleware({
        routes: { "/api/summarize": { price: "$0.02" } }, facilitatorUrl: "http://facilitator.test", circleId: fx.circleId, payTo: s.id,
        fetch: fetchMock as unknown as typeof fetch,
        ...(registerFirst ? { settleMode: "register-first" as const, registerVoucher: registerFrom(s) } : {}),
      });
      return { handler, run: (h: Record<string, string>) => middleware(new Request("https://seller.example/api/summarize", { headers: h }), handler) };
    };
    const first = seller(seller1, true);
    const second = seller(seller2, true);
    const legacy = seller(seller3, false);

    const ok = await first.run(header(seller1));
    expect(ok.status, ok.headers.get("PAYMENT-RESPONSE") ? Buffer.from(ok.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8") : await ok.text()).toBe(200);
    expect(first.handler).toHaveBeenCalledOnce();

    const refused = await second.run(header(seller2));
    expect(refused.status).toBe(402);
    expect(second.handler).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.from(refused.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"))).toMatchObject({ extensions: { x207: { contractCode: "ERR_INSUFFICIENT_CREDIT" } } });

    // default mode: the facilitator of seller3 says valid, the seller serves, and the contract would refuse this voucher too
    const served = await legacy.run(header(seller3));
    expect(served.status).toBe(200);
    expect(legacy.handler).toHaveBeenCalledOnce();
    const late = voucherTo(seller3);
    const { signature, ...fields } = late;
    const onChain = await seller3.account.call(buildRegisterVoucherCall({ circleContract: fx.circle.accountId, voucher: fields, signature }), "FINAL");
    expect(onChain.failures.join(" ")).toContain("ERR_INSUFFICIENT_CREDIT");
  }, 600_000);
});
