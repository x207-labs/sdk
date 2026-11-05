// SD-090: E2E on near-sandbox with contract 0.0.14. An agent that holds only a 0x key (no NEAR account) joins through the relayer (the relayer stakes for it), pays a seller through
// x402 with an EIP-712 voucher (seller -> facilitator /verify and /settle -> relayer registers the voucher), is paid by a native member, the epoch reaches finalized, and the agent claims
// with a signature only. Skipped if the near-sandbox binary or the contract wasm is missing, or the wasm has no `join_evm`.
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSettleTransferCall, createCircleViewFn, onboardMember, signVoucher, type ContractAbi, type ContractCall, type UnsignedVoucher,
} from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { CIRCLE_WASM, sandboxAvailable, type SandboxAccount } from "../../../test-support/sandbox.js";
import {
  EvmRelay, NearContractCaller, NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService,
} from "../../../apps/facilitator/src/index.js";
import { createSeller } from "../../seller/src/seller.js";
import { createEvmAgent } from "../src/agent.js";

const hasEvm = (): boolean => {
  try {
    return readFileSync(CIRCLE_WASM).includes(Buffer.from("join_evm"));
  } catch {
    return false;
  }
};
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat test key
const GAS = 200_000_000_000_000n;
const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

describe.skipIf(!sandboxAvailable || !hasEvm())("SD-090 EVM agent E2E on near-sandbox", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("TC-SD-090-05 join with the relayer, paid call with eip712, registration, finalized epoch, claim", async () => {
    fx = await deployCircle();
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const chainView = <T>(method: string, args: object = {}) => fx.sandbox.view<T>(fx.circle.accountId, method, args);
    const usdt = async (id: string) => BigInt(await fx.sandbox.view<string>(fx.usdt.accountId, "ft_balance_of", { account_id: id }));
    const send = (who: SandboxAccount, call: Pick<ContractCall, "receiverId" | "methodName" | "args" | "deposit" | "gas">) =>
      fx.sandbox.accountFrom(who.accountId, who.secretKey).call(call, "EXECUTED_OPTIMISTIC");
    const at = async (ns: string | null | undefined) => {
      await fx.sandbox.advanceTo(Number(BigInt(ns!) / 1_000_000n) + 1_000);
      await new Promise((r) => setTimeout(r, 3_000));
    };

    // the seller is a native member; the relayer is a plain NEAR account with mock USDT; the wallet is where the agent wants its payout
    const sellerAccount = await fx.member("summarizer");
    const sendCall = async (call: ContractCall) => {
      const r = await sellerAccount.call(call);
      if (r.failures.length > 0) throw new Error(r.failures.join("; "));
      return r.value;
    };
    const sellerJoined = await onboardMember(
      { sendCall, view, pollIntervalMs: 200, timeoutMs: 30_000 },
      { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: sellerAccount.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
    );
    const relayer = await fx.member("evmrelayer");
    const wallet = await fx.sandbox.createAccount("agentwallet", "5");

    // facilitator with the EVM relayer routes, the seller, and the clock of the sandbox
    const pending = new PendingStore(":memory:");
    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const clock = { offsetMs: 0 };
    let blockNow = await fx.sandbox.blockTimestampMs();
    const service = createFacilitatorService({
      circles: [defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId })], rpc, pending, signers: [relayer.accountId], now: () => Date.now() + clock.offsetMs,
    });
    const relay = new EvmRelay({
      circleContract: fx.circle.accountId, now: () => blockNow, stake: { tokenId: fx.usdt.accountId, amount: "50000000" },
      caller: new NearContractCaller({ rpc, circleContract: fx.circle.accountId, account: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    const facilitator = await listen(createApp(service, { evm: relay, rateLimit: false }).fetch);
    servers.push(facilitator.server);
    const seller = await listen(createSeller({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: sellerAccount.accountId }).fetch);
    servers.push(seller.server);

    // 1. the agent joins with its 0x key; the relayer stakes for it
    const agent = createEvmAgent({ privateKey: KEY, relayerUrl: facilitator.url, circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl], now: () => blockNow });
    const joined = await agent.join(TERMS_HASH);
    expect(joined).toMatchObject({ ok: true, method: "join_evm" });
    expect(joined.stakeTxHash).toBeTruthy();
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await chainView<ContractAbi.MemberView>("member", { account_id: agent.id })).toMatchObject({ status: "active" });
    expect(await agent.nextNonce()).toBe(0);

    // 2. a paid call: eip712 voucher, verified by the facilitator through ecrecover, stored, registered on chain
    const epoch = await chainView<ContractAbi.EpochView>("get_epoch", {});
    const response = await agent.payFetch()(`${seller.url}/api/summarize`);
    expect(response.status).toBe(200);
    const settled = JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));
    expect(settled).toMatchObject({ success: true, transaction: `${agent.id}:${sellerAccount.accountId}:${epoch.epoch}:1`, extensions: { x207: { seq: 1, cumulativeAmount: "20000" } } });
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1 });
    expect(await chainView<ContractAbi.ObligationView>("obligation", { epoch: epoch.epoch, debtor: agent.id, creditor: sellerAccount.accountId })).toMatchObject({ cumulative: "20000", last_seq: 1 });

    // 3. the seller owes the agent more (a native voucher, registered by the relayer): the agent ends up a creditor of 80000
    const back: UnsignedVoucher = { circle: fx.circle.accountId, payer: sellerAccount.accountId, payee: agent.id, epoch: epoch.epoch, seq: 1, cumulativeAmount: "100000", unit: "credit", resource: "https://agent.example/api" };
    const chain = new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } });
    await chain.register(back, signVoucher(back, sellerJoined.secretKey).signature, "cumulative");

    // 4. epoch: cutoff, close, commit, the debtor pays, finalize
    await at(epoch.cutoff_at);
    blockNow = await fx.sandbox.blockTimestampMs();
    expect((await send(sellerAccount, { receiverId: fx.circle.accountId, methodName: "close_epoch", args: { epoch: epoch.epoch }, deposit: 0n })).failures).toEqual([]);
    await at((await chainView<ContractAbi.EpochView>("get_epoch", { epoch: epoch.epoch })).proposal_deadline);
    expect((await send(sellerAccount, { receiverId: fx.circle.accountId, methodName: "commit_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: GAS })).failures).toEqual([]);
    const paying = await chainView<ContractAbi.EpochView>("get_epoch", { epoch: epoch.epoch });
    expect((await send(sellerAccount, buildSettleTransferCall({ circleContract: fx.circle.accountId, amount: "80000", epoch: epoch.epoch, usdtTokenId: fx.usdt.accountId }))).failures).toEqual([]);
    await at(paying.payment_deadline);
    blockNow = await fx.sandbox.blockTimestampMs();
    expect((await send(sellerAccount, { receiverId: fx.circle.accountId, methodName: "finalize_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: GAS })).failures).toEqual([]);
    expect((await chainView<ContractAbi.EpochView>("get_epoch", { epoch: epoch.epoch })).phase).toBe("finalized");

    // 5. the agent claims with a signature only; the payout reaches the NEAR wallet
    const before = await usdt(wallet.accountId);
    const claimed = await agent.claim(epoch.epoch, wallet.accountId);
    expect(claimed).toMatchObject({ ok: true, method: "claim_evm" });
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await usdt(wallet.accountId)) - before).toBe(80_000n);
    expect(await agent.nextNonce()).toBe(1);
    console.log(JSON.stringify({ evmAgent: agent.id, joinTx: joined.txHash, stakeTx: joined.stakeTxHash, claimTx: claimed.txHash }));
    pending.close();
  }, 900_000);
});
