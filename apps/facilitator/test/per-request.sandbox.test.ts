// SD-029: mode per_request terhadap kontrak nyata di near-sandbox: register_voucher per request dan jatuh ke register_cumulative bila seq melompat.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, parseEventLog, signVoucher, type ContractAbi, type ContractCall } from "@x207/core";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable, type SandboxAccount } from "../../../test-support/sandbox.js";
import { PendingStore } from "../src/pending-store.js";
import { NearRegistrationChain } from "../src/relay.js";
import { NearRpc } from "../src/rpc.js";
import { RegistrationScheduler } from "../src/scheduler.js";

describe.skipIf(!sandboxAvailable)("SD-029 per_request di near-sandbox", () => {
  let fx: CircleFixture;
  let relayer: SandboxAccount;
  beforeAll(async () => {
    fx = await deployCircle();
    relayer = await fx.sandbox.createAccount("relayer", "20");
  }, 300_000);
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-029-05 tiap voucher menjadi satu transaksi register_voucher; seq melompat jatuh ke register_cumulative", async () => {
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
          { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
        )),
      };
    };
    const payer = await onboard("translator");
    const payee = await onboard("summarizer");
    const epoch = (await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {})).epoch;

    const logs: string[][] = [];
    const store = new PendingStore(":memory:");
    const chain = new NearRegistrationChain({
      rpc: new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 }),
      circleContract: fx.circle.accountId,
      relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey },
      onLogs: (l) => logs.push(l),
    });
    const scheduler = new RegistrationScheduler({ circleContract: fx.circle.accountId, store, chain, mode: "per_request", log: () => {} });
    const key = { payer: payer.account.accountId, payee: payee.account.accountId, epoch };
    const save = (seq: number) => {
      const { signature, ...voucher } = signVoucher(
        { circle: fx.circle.accountId, ...key, seq, cumulativeAmount: String(seq * 20_000), unit: "credit", resource: "https://s.example/api" },
        payer.secretKey,
      );
      store.upsert(fx.circle.accountId, voucher, signature);
    };
    const modes = () => logs.flatMap((l) => l.flatMap((log) => parseEventLog(log) ?? [])).filter((e) => e.event === "voucher_registered").map((e) => `${e.seq}:${e.mode}`);

    for (const seq of [1, 2]) {
      save(seq);
      expect(await scheduler.registerNow(key)).toEqual({ status: "registered" });
    }
    expect(modes()).toEqual(["1:per_request", "2:per_request"]);
    save(5);
    expect(await scheduler.registerNow(key)).toEqual({ status: "registered" });
    expect(modes()).toEqual(["1:per_request", "2:per_request", "5:cumulative"]);
    const obligation = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch, debtor: key.payer, creditor: key.payee });
    expect(obligation).toMatchObject({ cumulative: "100000", last_seq: 5 });
    expect(store.listOpen(fx.circle.accountId)).toEqual([]);
    store.close();
  }, 300_000);
});
