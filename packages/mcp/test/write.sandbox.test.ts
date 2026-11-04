// SD-082 in near-sandbox: the write tools of @x207/mcp against a real circle contract, a real seller and a real facilitator, with the REAL NEAR sender (no injected one).
//   agent  x207_join (join + stake) -> x207_pay_request (three voucher payments to the seller) -> epoch lifecycle -> x207_settle (the residual)
//   seller x207_claim (what it is owed after clearing)
// and the guards that need a chain: a function-call key cannot join, a session budget stops a payment. Skipped unless X207_SANDBOX=1 (npm run test:sandbox).
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, generateVoucherKeypair, onboardMember, signVoucher, type ContractAbi, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { createSeller } from "../../../examples/seller/src/seller.js";
import { PendingStore, RegistrationScheduler, NearRegistrationChain, NearRpc, createApp, createFacilitatorService } from "../../../apps/facilitator/src/index.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import type { McpConfig } from "../src/config.js";
import { createX207McpServer } from "../src/server.js";
import type { WriteConfig } from "../src/write-config.js";

const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

describe.skipIf(!sandboxAvailable)("SD-082 write tools in near-sandbox", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("TC-SD-082-20 join, pay three requests, settle the residual and claim, all through MCP tools; the guards hold on the chain", async () => {
    fx = await deployCircle();
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const config: McpConfig = { circleContract: fx.circle.accountId, circleId: fx.circleId, rpcUrls: [fx.sandbox.rpcUrl], backendUrl: null, timeoutMs: 30_000 };
    const connect = async (write: WriteConfig) => {
      const server = createX207McpServer(config, "stdio", { write });
      const client = new Client({ name: "sandbox", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      return async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
        const text = r.content[0]!.text;
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          // an error text
        }
        return { isError: r.isError === true, text, json };
      };
    };
    const base = (account: string, voucherKey: `ed25519:${string}`, nearKey: string, over: Partial<WriteConfig> = {}): WriteConfig => ({
      account, voucherKey, nearKey: nearKey as `ed25519:${string}`, maxSpendSession: 50_000_000n, maxPricePerCall: 100_000n, allowedCounterparties: [], allowOutflows: true, allowFullAccessKey: true, allowPrivateUrls: true, ...over, // the seller of this test runs on 127.0.0.1
    });

    // the seller: an ordinary member with its own tools of the test; the agent joins through MCP
    const sellerAccount = await fx.member("summarizer");
    const sellerJoined = await onboardMember(
      { sendCall: async (c: ContractCall) => { const r = await sellerAccount.call(c); if (r.failures.length > 0) throw new Error(r.failures.join("; ")); return r.value; }, view, pollIntervalMs: 200, timeoutMs: 20_000 },
      { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: sellerAccount.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
    );
    const agent = await fx.member("translator");
    const agentVoucher = generateVoucherKeypair();

    // guard on the chain: a function-call key on the agent account cannot join (it cannot attach the deposit), and nothing is sent
    const fck = await agent.withFunctionCallKey(fx.circle.accountId);
    const withFck = await connect(base(agent.accountId, agentVoucher.secretKey, fck.secretKey));
    const refused = await withFck("x207_join", { terms_hash: TERMS_HASH, stake_amount: "50000000" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/function-call key, which cannot attach the deposit that x207_join needs; no transaction was sent/);
    expect(await view("member", { account_id: agent.accountId })).toBeNull();

    // x207_join with the real sender and the full-access key of the agent account
    const asAgent = await connect(base(agent.accountId, agentVoucher.secretKey, agent.secretKey));
    const joined = await asAgent("x207_join", { terms_hash: TERMS_HASH, stake_amount: "50000000" });
    expect(joined.isError, joined.text).toBe(false);
    expect(joined.json).toMatchObject({ account: agent.accountId, member: { status: "active", stake: "50000000" }, session: { spent: "50000000", remaining: "0" } });
    expect(JSON.stringify(joined)).not.toContain(agent.secretKey);

    // facilitator and seller; x207_pay_request three times (20000 each)
    const relayer = await fx.sandbox.createAccount("relayer", "20");
    const pending = new PendingStore(":memory:");
    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const circle = defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId });
    const facilitator = await listen(createApp(createFacilitatorService({ circles: [circle], rpc, pending, signers: [relayer.accountId], now: () => Date.now() })).fetch);
    servers.push(facilitator.server);
    const sellerApp = await listen(createSeller({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: sellerAccount.accountId }).fetch);
    servers.push(sellerApp.server);

    // a budget of 70000: three payments of 20000 fit (60000), a fourth does not
    const payer = await connect(base(agent.accountId, agentVoucher.secretKey, agent.secretKey, { maxSpendSession: 70_000n, allowOutflows: false }));
    for (let i = 1; i <= 3; i++) {
      const r = await payer("x207_pay_request", { url: `${sellerApp.url}/api/summarize` });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ status: 200, paid: true, session: { spent: String(i * 20_000) } });
    }
    const over = await payer("x207_pay_request", { url: `${sellerApp.url}/api/summarize` });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/would take this session to 80000, above X207_MAX_SPEND_SESSION \(70000\)/);

    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1 });
    const owed = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch: epoch.epoch, debtor: agent.accountId, creditor: sellerAccount.accountId });
    expect(owed).toMatchObject({ cumulative: "60000", last_seq: 3 });

    // the seller owes the agent 20000 back, so clearing cancels 20000 and the agent owes the residual 40000
    const { signature, ...back } = signVoucher(
      { circle: fx.circle.accountId, payer: sellerAccount.accountId, payee: agent.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "https://seller.example/back" },
      sellerJoined.secretKey,
    );
    const registered = await sellerAccount.call({ receiverId: fx.circle.accountId, methodName: "register_cumulative", args: { voucher: back, signature }, deposit: 0n, gas: 100_000_000_000_000n });
    expect(registered.failures).toEqual([]);

    // epoch lifecycle by anybody (the relayer)
    const as = (a: { accountId: string; secretKey: string }) => fx.sandbox.accountFrom(a.accountId, a.secretKey);
    const at = async (ns: string | null | undefined) => {
      await fx.sandbox.advanceTo(Number(BigInt(ns!) / 1_000_000n) + 1_000);
      await new Promise((r) => setTimeout(r, 3_000));
    };
    const step = async (methodName: string, args: Record<string, unknown>, gas = 100_000_000_000_000n) => {
      const r = await as(relayer).call({ receiverId: fx.circle.accountId, methodName, args, deposit: 0n, gas }, "EXECUTED_OPTIMISTIC");
      expect(r.failures, methodName).toEqual([]);
    };
    await at(epoch.cutoff_at);
    await step("close_epoch", { epoch: epoch.epoch });
    const closing = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", { epoch: epoch.epoch });
    await step("submit_clearing", { epoch: epoch.epoch, edges: [
      { debtor: agent.accountId, creditor: sellerAccount.accountId, cleared: "20000" },
      { debtor: sellerAccount.accountId, creditor: agent.accountId, cleared: "20000" },
    ] });
    await at(closing.proposal_deadline);
    await step("commit_epoch", { epoch: epoch.epoch }, 200_000_000_000_000n);
    const paying = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", { epoch: epoch.epoch });

    // x207_settle: the agent pays what it owes; asking for more than due is refused
    const position = await fx.sandbox.view<ContractAbi.PositionView>(fx.circle.accountId, "net_position", { epoch: epoch.epoch, account_id: agent.accountId });
    expect(position).toMatchObject({ role: "debtor", status: "due" });
    // the tools read the `final` head; the lifecycle steps above answered at EXECUTED_OPTIMISTIC, so wait until the final view has the position
    for (let i = 0; i < 60 && (await view("net_position", { epoch: epoch.epoch, account_id: agent.accountId })) === null; i++) await new Promise((r) => setTimeout(r, 500));
    const settleTool = await connect(base(agent.accountId, agentVoucher.secretKey, agent.secretKey, { maxSpendSession: 10_000n }));
    const tooLittle = await settleTool("x207_settle", { epoch: epoch.epoch });
    expect(tooLittle.isError).toBe(true);
    expect(tooLittle.text).toMatch(new RegExp(`above X207_MAX_SPEND_SESSION \\(10000\\)`)); // the budget guard stops a payment the session cannot cover
    const settleAll = await connect(base(agent.accountId, agentVoucher.secretKey, agent.secretKey, { maxSpendSession: 100_000_000n }));
    expect((await settleAll("x207_settle", { epoch: epoch.epoch, amount: String(BigInt(position.amount) + 1n) })).text).toMatch(/is more than the .* due/);
    const paid = await settleAll("x207_settle", { epoch: epoch.epoch });
    expect(paid.isError, paid.text).toBe(false);
    expect(paid.json).toMatchObject({ epoch: epoch.epoch, paid: position.amount, due: position.amount });
    expect(await fx.sandbox.view<ContractAbi.PositionView>(fx.circle.accountId, "net_position", { epoch: epoch.epoch, account_id: agent.accountId })).toMatchObject({ status: "paid" });

    for (let i = 0; i < 60 && ((await view("net_position", { epoch: epoch.epoch, account_id: agent.accountId })) as ContractAbi.PositionView | null)?.status !== "paid"; i++) await new Promise((r) => setTimeout(r, 500));
    await at(paying.payment_deadline);
    await step("finalize_epoch", { epoch: epoch.epoch }, 200_000_000_000_000n);

    for (let i = 0; i < 60 && ((await view("net_position", { epoch: epoch.epoch, account_id: sellerAccount.accountId })) as ContractAbi.PositionView | null)?.status !== "claimable"; i++) await new Promise((r) => setTimeout(r, 500));
    // x207_claim by the seller, with a second MCP server for the seller's account
    const asSeller = await connect(base(sellerAccount.accountId, sellerJoined.secretKey, sellerAccount.secretKey, { allowOutflows: false }));
    const claimed = await asSeller("x207_claim", { epoch: epoch.epoch, destination: "near" });
    expect(claimed.isError, claimed.text).toBe(false);
    expect(claimed.json).toMatchObject({ epoch: epoch.epoch, destination: "near", claimable: position.amount });
    expect(await fx.sandbox.view<ContractAbi.PositionView>(fx.circle.accountId, "net_position", { epoch: epoch.epoch, account_id: sellerAccount.accountId })).toMatchObject({ role: "creditor", status: "claimed" });
    // claiming again: nothing left
    expect((await asSeller("x207_claim", { epoch: epoch.epoch })).text).toMatch(/nothing to claim for epoch/);
  }, 900_000);
});
