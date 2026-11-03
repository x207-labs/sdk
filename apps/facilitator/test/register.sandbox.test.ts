// TC-SD-028-19: 50 voucher A ke B (total 1000000) di near-sandbox menghasilkan satu register_cumulative.
// Dilewati bila binary near-sandbox atau wasm kontrak tidak ada (lihat test-support/sandbox.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, parseEventLog, signVoucher, type ContractAbi, type ContractCall } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable, type SandboxAccount } from "../../../test-support/sandbox.js";
import { PendingStore } from "../src/pending-store.js";
import { NearRegistrationChain } from "../src/relay.js";
import { NearRpc } from "../src/rpc.js";
import { RegistrationScheduler } from "../src/scheduler.js";

const STAKE = "50000000";

describe.skipIf(!sandboxAvailable)("SD-028 registrasi di near-sandbox", () => {
  let fx: CircleFixture;
  let relayer: SandboxAccount;

  beforeAll(async () => {
    fx = await deployCircle();
    relayer = await fx.sandbox.createAccount("relayer", "20");
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-028-19 50 vouchers totaling 1000000 become one register_cumulative before cutoff_at", async () => {
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const sendCall = async (call: ContractCall) => {
        const result = await account.call(call);
        if (result.failures.length > 0) throw new Error(result.failures.join("; "));
        return result.value;
      };
      return {
        account,
        ...(await onboardMember(
          { sendCall, view, pollIntervalMs: 200, timeoutMs: 20_000 },
          {
            circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId,
            termsHash: TERMS_HASH, stakeAmount: STAKE, usdtTokenId: fx.usdt.accountId,
          },
        )),
      };
    };
    const payer = await onboard("translator");
    const payee = await onboard("summarizer");

    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const cutoffMs = Number(BigInt(epoch.cutoff_at) / 1_000_000n);

    const store = new PendingStore(":memory:");
    for (let seq = 1; seq <= 50; seq++) {
      const { signature, ...voucher } = signVoucher(
        {
          circle: fx.circle.accountId, payer: payer.account.accountId, payee: payee.account.accountId, epoch: epoch.epoch,
          seq, cumulativeAmount: String(seq * 20_000), unit: "credit", resource: "https://summarizer.example/api/summarize",
        },
        payer.secretKey,
      );
      store.upsert(fx.circle.accountId, voucher, signature);
    }

    const logs: string[][] = [];
    const chain = new NearRegistrationChain({
      rpc: new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 }),
      circleContract: fx.circle.accountId,
      relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey },
      onLogs: (l) => logs.push(l),
    });
    const sentAt = await fx.sandbox.blockTimestampMs();
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store, chain, log: () => {}, now: () => Date.now(),
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ registered: 1, retrying: 0, dropped: 0 });
    expect(sentAt).toBeLessThan(cutoffMs);
    expect(logs).toHaveLength(1);
    const events = logs[0]!.flatMap((log) => parseEventLog(log) ?? []);
    expect(events.find((e) => e.event === "voucher_registered")).toMatchObject({
      payer: payer.account.accountId, payee: payee.account.accountId, seq: 50, cumulative_amount: "1000000", mode: "cumulative",
    });
    const obligation = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", {
      epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId,
    });
    expect(obligation.cumulative).toBe("1000000");
    expect(obligation.last_seq).toBe(50);
    expect(store.listOpen(fx.circle.accountId)).toEqual([]);
    store.close();
  }, 300_000);
});
