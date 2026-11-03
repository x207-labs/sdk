// SD-074 in near-sandbox: the facilitator takes no new voucher from or to a member that the DAO froze (ADR-43, CT-095). The freeze is proposed, waits its timelock, is applied, and `/verify`
// answers `account_frozen` for the frozen payer and the frozen payee, while a pair that does not include the frozen member still passes; lifting the freeze lets vouchers in again.
// The clock of `verify` is held before the cutoff of the first epoch, so the test looks only at the freeze (the epoch is not rotated while the chain clock jumps 24 hours).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, signVoucher, type ContractAbi, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { PendingStore } from "../src/pending-store.js";
import { NearRpc } from "../src/rpc.js";
import { createVerify } from "../src/chain.js";

describe.skipIf(!sandboxAvailable)("SD-074 a frozen member in near-sandbox", () => {
  let fx: CircleFixture;
  beforeAll(async () => {
    fx = await deployCircle();
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-074-03 vouchers from or to the frozen member are refused account_frozen, the others pass, and an unfrozen member is accepted again", async () => {
    const contract = fx.circle.accountId;
    const view = createCircleViewFn({ circleContract: contract, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const sendCall = async (call: ContractCall) => {
        const result = await account.call(call);
        if (result.failures.length > 0) throw new Error(result.failures.join("; "));
        return result.value;
      };
      return { account, ...(await onboardMember({ sendCall, view, pollIntervalMs: 200, timeoutMs: 20_000 }, { circleContract: contract, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId })) };
    };
    const step = (name: string) => console.log(`SD-074 step: ${name}`);
    step("onboard");
    const [frozen, partner, other] = [await onboard("translator"), await onboard("summarizer"), await onboard("scraper")];
    const dao = await fx.sandbox.createAccount("dao", "10");
    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(contract, "get_epoch", {});
    const startMs = await fx.sandbox.blockTimestampMs();

    const live = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    // the epoch is not rotated while the chain clock jumps 24 hours, so after the jump the contract no longer calls it open: `verify` reads the epoch as it was before the jump
    const rpc = { view: (c: string, method: string, args: object) => (method === "get_epoch" ? Promise.resolve(epoch) : live.view(c, method, args)) } as unknown as NearRpc;
    const circle = defineCircleConfig({ network: "x207:agents-main", circleContract: contract });
    const verify = createVerify([circle], rpc, new PendingStore(":memory:"), { now: () => startMs });
    const ask = async (from: typeof frozen, to: typeof frozen) => {
      const requirements = { scheme: "batch-settlement", network: "x207:agents-main", amount: "20000", asset: "USD", payTo: to.account.accountId, maxTimeoutSeconds: 60, extra: { circleContract: contract, unit: "credit", decimals: 6, epoch: epoch.epoch } };
      const { signature, ...voucher } = signVoucher(
        { circle: contract, payer: from.account.accountId, payee: to.account.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://summarizer.example/api" },
        from.secretKey,
      );
      return verify({ paymentPayload: { x402Version: 2, resource: { url: "https://summarizer.example/api" }, accepted: requirements, payload: { voucher, signature } }, paymentRequirements: requirements } as never);
    };
    // a fresh account object for every call: after the clock jumps 24 hours the block hash that an old one holds is too old (`Transaction expired`)
    const call = async (method: string, args: object) => {
      const r = await fx.sandbox.accountFrom(dao.accountId, dao.secretKey).call({ receiverId: contract, methodName: method, args, deposit: 0n }, "FINAL");
      expect(r.failures, method).toEqual([]);
    };

    step("first verify");
    expect(await ask(frozen, partner)).toMatchObject({ isValid: true });
    step("propose_freeze");
    // proposed: the member is still free during the timelock
    await call("propose_freeze", { account_id: frozen.account.accountId, reason_hash: null });
    expect(await fx.sandbox.view<boolean>(contract, "is_frozen", { account_id: frozen.account.accountId })).toBe(false);
    expect(await ask(frozen, partner)).toMatchObject({ isValid: true });
    step("advance 24 h");
    // applied after the timelock of 24 hours
    // the sandbox moves in steps of at most 4000 blocks, so 24 hours takes minutes: the timeout of this test is 15 minutes
    const t0 = Date.now();
    await fx.sandbox.advanceTo((await fx.sandbox.blockTimestampMs()) + 24 * 3600_000 + 5_000);
    step(`advanced in ${Math.round((Date.now() - t0) / 1000)} s`);
    await new Promise((r) => setTimeout(r, 3_000));
    step("apply_freeze");
    await call("apply_freeze", { account_id: frozen.account.accountId });
    expect(await fx.sandbox.view<boolean>(contract, "is_frozen", { account_id: frozen.account.accountId })).toBe(true);
    expect(await ask(frozen, partner)).toMatchObject({ isValid: false, invalidReason: "account_frozen" });
    expect(await ask(partner, frozen)).toMatchObject({ isValid: false, invalidReason: "account_frozen" });
    expect(await ask(partner, other)).toMatchObject({ isValid: true }); // a pair without the frozen member
    // lifted: accepted again
    await call("unfreeze_member", { account_id: frozen.account.accountId });
    expect(await ask(frozen, partner)).toMatchObject({ isValid: true });
  }, 900_000);
});
