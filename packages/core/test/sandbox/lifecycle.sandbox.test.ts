// TC-SD-011-17: log nyata dari near-sandbox untuk event siklus hidup epoch. Dengan X207_UPDATE_FIXTURES=1 log disimpan
// ke spec/test-vectors/events/sandbox/<event>.log; event.fixtures.test.ts mem-parse berkas itu tanpa sandbox.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildClaimCall, buildSettleTransferCall, createCircleViewFn, onboardMember, parseEventLog, signVoucher,
  type ContractAbi, type ContractCall,
} from "@x207/core";
import { SHORT_PARAMS, TERMS_HASH, deployCircle, type CircleFixture } from "../../../../test-support/circle.js";
import { sandboxAvailable, type SandboxAccount } from "../../../../test-support/sandbox.js";

const OUT = fileURLToPath(new URL("../../../../spec/test-vectors/events/sandbox/", import.meta.url));

describe.skipIf(!sandboxAvailable)("SD-011 epoch lifecycle on near-sandbox", () => {
  let fx: CircleFixture;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-SD-011-17 every lifecycle event that can be triggered parses and is stored as a fixture", async () => {
    fx = await deployCircle();
    const lines = new Map<string, string>();
    const seen = new Set<string>();
    const collect = (logs: string[]) => {
      for (const line of logs) {
        for (const event of parseEventLog(line) ?? []) {
          seen.add(event.event);
          if (!lines.has(event.event)) lines.set(event.event, line);
        }
      }
    };
    const call = async (account: SandboxAccount, c: Pick<ContractCall, "receiverId" | "methodName" | "args" | "deposit" | "gas">) => {
      const result = await account.call(c, "EXECUTED_OPTIMISTIC");
      expect(result.failures, c.methodName).toEqual([]);
      collect(result.logs);
      return result;
    };
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const result = await onboardMember(
        {
          sendCall: async (c) => {
            const r = await account.call(c);
            collect(r.logs);
            if (r.failures.length > 0) throw new Error(r.failures.join("; "));
            return r.value;
          },
          view, pollIntervalMs: 200, timeoutMs: 30_000,
        },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, ...result };
    };
    const payer = await onboard("translator");
    const payee = await onboard("summarizer");
    const defaulter = await onboard("scraper");
    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});

    // voucher_registered: 10 credit dari payer ke payee
    const { signature, ...voucher } = signVoucher(
      { circle: fx.circle.accountId, payer: payer.account.accountId, payee: payee.account.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: "10000000", unit: "credit", resource: "https://seller.example/api" },
      payer.secretKey,
    );
    await call(payer.account, { receiverId: fx.circle.accountId, methodName: "register_cumulative", args: { voucher, signature }, deposit: 0n, gas: 100_000_000_000_000n });
    // Arah sebaliknya 4 credit, supaya kliring membentuk siklus dua simpul dengan sisa 6 credit.
    const back = signVoucher(
      { circle: fx.circle.accountId, payer: payee.account.accountId, payee: payer.account.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: "4000000", unit: "credit", resource: "https://seller.example/api" },
      payee.secretKey,
    );
    const { signature: backSignature, ...backVoucher } = back;
    await call(payee.account, { receiverId: fx.circle.accountId, methodName: "register_cumulative", args: { voucher: backVoucher, signature: backSignature }, deposit: 0n, gas: 100_000_000_000_000n });

    // Debtor ketiga berutang 5 credit dan tidak membayar, supaya finalize_epoch menghasilkan member_defaulted.
    const owed = signVoucher(
      { circle: fx.circle.accountId, payer: defaulter.account.accountId, payee: payee.account.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: "5000000", unit: "credit", resource: "https://seller.example/api" },
      defaulter.secretKey,
    );
    const { signature: owedSignature, ...owedVoucher } = owed;
    await call(defaulter.account, { receiverId: fx.circle.accountId, methodName: "register_cumulative", args: { voucher: owedVoucher, signature: owedSignature }, deposit: 0n, gas: 100_000_000_000_000n });

    const fresh = (account: SandboxAccount) => fx.sandbox.accountFrom(account.accountId, account.secretKey);
    const at = async (ns: string | null | undefined) => {
      await fx.sandbox.advanceTo(Number(BigInt(ns!) / 1_000_000n) + 1_000);
      await new Promise((r) => setTimeout(r, 3_000));
    };

    // params_updated: pemilik (dao) menjadwalkan params baru, berlaku saat close_epoch membuka epoch berikutnya.
    const dao = await fx.sandbox.createAccount("dao", "5");
    await call(dao, { receiverId: fx.circle.accountId, methodName: "set_params", args: { params: { ...SHORT_PARAMS, limit_cap: "900000000" } }, deposit: 0n });

    await at(epoch.cutoff_at);
    await call(fresh(payer.account), { receiverId: fx.circle.accountId, methodName: "close_epoch", args: { epoch: epoch.epoch }, deposit: 0n });
    const closing = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", { epoch: epoch.epoch });

    await call(fresh(payee.account), { receiverId: fx.circle.accountId, methodName: "submit_clearing", args: {
      epoch: epoch.epoch,
      edges: [
        { debtor: payer.account.accountId, creditor: payee.account.accountId, cleared: "4000000" },
        { debtor: payee.account.accountId, creditor: payer.account.accountId, cleared: "4000000" },
      ],
    }, deposit: 0n, gas: 100_000_000_000_000n });
    await at(closing.proposal_deadline);
    await call(fresh(payee.account), { receiverId: fx.circle.accountId, methodName: "commit_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: 200_000_000_000_000n });
    const paying = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", { epoch: epoch.epoch });

    // residual_paid: payer melunasi 10 credit dalam payment window
    await call(fresh(payer.account), buildSettleTransferCall({ circleContract: fx.circle.accountId, amount: "6000000", epoch: epoch.epoch, usdtTokenId: fx.usdt.accountId }));
    await at(paying.payment_deadline);
    await call(fresh(payer.account), { receiverId: fx.circle.accountId, methodName: "finalize_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: 200_000_000_000_000n });
    await call(fresh(payee.account), buildClaimCall({ circleContract: fx.circle.accountId, epoch: epoch.epoch, destination: "near" }));

    for (const name of [
      "member_joined", "stake_added", "voucher_registered", "epoch_cutoff", "clearing_submitted", "clearing_applied", "epoch_committed", "limits_updated",
      "residual_paid", "epoch_finalized", "residual_claimed", "member_defaulted", "params_updated",
    ]) {
      expect(seen.has(name), `${name} appears in the sandbox log`).toBe(true);
    }
    if (process.env.X207_UPDATE_FIXTURES === "1") {
      mkdirSync(dirname(OUT + "x"), { recursive: true });
      for (const [name, line] of lines) writeFileSync(`${OUT}${name}.log`, `${line}\n`);
    }
  }, 600_000);
});
