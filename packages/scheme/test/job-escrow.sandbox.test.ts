// SD-067 in near-sandbox: the contract takes the terms of a job budget. A bundle with one leg is refused (`ERR_BAD_BUNDLE`), the two-leg terms of `JobBudget` commit with the
// same `terms_hash` as the SDK, the budget is reserved for the buyer, and the voucher of each chunk registers against the leg until the budget is reached and not beyond.
// Skipped when the near-sandbox binary or the contract wasm is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContractAbi, createCircleViewFn, onboardMember, signBundle, signVoucher, type ContractCall } from "@x207/core";
import { JobBudget, BuyerJob } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";

const CREDIT = 1_000_000n;

describe.skipIf(!sandboxAvailable)("SD-067 job budget in near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-067-20 one leg is refused, the two-leg terms commit with the hash of the SDK, and vouchers register chunk by chunk up to the budget", async () => {
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
    const [buyer, seller] = [await onboard("buyer"), await onboard("seller")];
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;
    const budget = new JobBudget({ jobId: "j1", unit: "minute", chunkQuantity: 10, unitPrice: "$0.1", chunks: 4, circle: fx.circle.accountId, buyer: buyer.id, seller: seller.id, epoch });
    expect(budget.budget).toBe(4n * CREDIT); // 4 chunks of 1 credit
    const commit = (terms = budget.terms(), args = budget.commitArgs(), signed = true) =>
      seller.account.call(
        {
          receiverId: fx.circle.accountId, methodName: "commit_bundle", deposit: 0n, gas: 200_000_000_000_000n,
          args: {
            bundle: args,
            signatures: !signed
              ? []
              : [buyer, seller].map((m) => {
                  const s = signBundle(terms, m.id, m.secretKey);
                  return { account_id: s.account, signature: s.signature };
                }),
          },
        },
        "FINAL",
      );

    // the budget leg alone is not a bundle on this contract (the SDK refuses to sign it, so it is sent raw; the shape is checked before the signatures)
    const single = { ...budget.terms(), legs: [budget.terms().legs[0]!] };
    const refused = await commit(single, { epoch, legs: single.legs }, false);
    expect(refused.failures.join(" ")).toContain("ERR_BAD_BUNDLE");

    const ok = await commit();
    expect(ok.failures).toEqual([]);
    const bundleId = Number(ok.value);
    budget.attach(bundleId);
    const stored = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: bundleId });
    expect(stored?.terms_hash).toBe(budget.termsHash());
    expect(stored?.legs.map((l) => l.max_amount)).toEqual([String(4n * CREDIT), "1"]);

    // vouchers of the chunks, one after the other, as the buyer would sign them
    const buyerJob = new BuyerJob(budget);
    for (let chunk = 1; chunk <= 4; chunk++) {
      const { voucher } = buyerJob.signNext(buyer.secretKey);
      const { signature, ...fields } = voucher;
      const r = await seller.account.call(
        { receiverId: fx.circle.accountId, methodName: "register_in_bundle", deposit: 0n, gas: 100_000_000_000_000n, args: { bundle_id: bundleId, voucher: fields, signature } },
        "FINAL",
      );
      expect(r.failures, `chunk ${chunk}`).toEqual([]);
      buyerJob.confirm(chunk);
      const now = await fx.sandbox.view<ContractAbi.BundleView | null>(fx.circle.accountId, "get_bundle", { bundle_id: bundleId });
      expect(now?.legs[0]?.registered).toBe(String(BigInt(chunk) * CREDIT));
    }
    // above the budget the contract refuses, whatever the buyer signed
    const over = signVoucher({ ...budget.voucherFor(4), seq: 5, cumulativeAmount: String(4n * CREDIT + 1n) }, buyer.secretKey);
    const { signature, ...fields } = over;
    const refusedOver = await seller.account.call(
      { receiverId: fx.circle.accountId, methodName: "register_in_bundle", deposit: 0n, gas: 100_000_000_000_000n, args: { bundle_id: bundleId, voucher: fields, signature } },
      "FINAL",
    );
    expect(refusedOver.failures.join(" ")).toMatch(/ERR_/);
  }, 600_000);
});
