// SD-083 spike on near-sandbox: one MCP tool paid with an x207 voucher through @x402/mcp 2.29.0. Seller: `createPaymentWrapper` + `x402ResourceServer` with `X207SchemeServer`;
// buyer: `createx402MCPClient` with `X207SchemeClient` for `x207:agents-main`; facilitator: the reference one over HTTP; chain: a real circle contract. Run: `npm run test:sandbox`
// or `X207_SANDBOX=1 npx vitest run examples/mcp-paid-tool`.
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, type ContractAbi, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService } from "../../../apps/facilitator/src/index.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { createPayingMcpClient } from "../src/buyer.js";
import { createPaidToolServer } from "../src/seller.js";

const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

describe.skipIf(!sandboxAvailable)("SD-083 a paid MCP tool, paid with an x207 voucher (@x402/mcp 2.29.0)", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("TC-SD-083-01 a free tool runs without a payment, the paid tool is paid with a voucher before it runs and the voucher is registered on the contract; a refused payment runs nothing", async () => {
    fx = await deployCircle();
    const view = createCircleViewFn({ circleContract: fx.circle.accountId, rpcUrls: [fx.sandbox.rpcUrl] });
    const onboard = async (name: string) => {
      const account = await fx.member(name);
      const sendCall = async (call: ContractCall) => {
        const result = await account.call(call);
        if (result.failures.length > 0) throw new Error(result.failures.join("; "));
        return result.value;
      };
      const joined = await onboardMember(
        { sendCall, view, pollIntervalMs: 200, timeoutMs: 20_000 },
        { circleContract: fx.circle.accountId, circleId: fx.circleId, accountId: account.accountId, termsHash: TERMS_HASH, stakeAmount: "50000000", usdtTokenId: fx.usdt.accountId },
      );
      return { account, ...joined };
    };
    const payer = await onboard("translator");
    const payee = await onboard("summarizer");
    const relayer = await fx.sandbox.createAccount("relayer", "20");

    const pending = new PendingStore(":memory:");
    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const circle = defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId });
    const service = createFacilitatorService({ circles: [circle], rpc, pending, signers: [relayer.accountId] });
    const facilitator = await listen(createApp(service).fetch);
    servers.push(facilitator.server);

    const ran: string[] = [];
    const mcpServer = await createPaidToolServer({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: payee.account.accountId, onRun: (a) => ran.push(a.text) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverSide);
    const asked: Array<{ amount: string; payTo: string }> = [];
    let allow = true;
    const client = createPayingMcpClient({
      accountId: payer.account.accountId, secretKey: payer.secretKey, circleId: "agents-main",
      onPaymentRequested: (amount, payTo) => { asked.push({ amount, payTo }); return allow; },
    });
    await client.connect(clientSide);

    // the free tool: no payment
    const pong = await client.callTool("ping", {});
    expect(pong).toMatchObject({ paymentMade: false });
    expect(asked).toEqual([]);

    // the paid tool: 402 -> the voucher is signed -> verify -> the tool runs -> settle
    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const result = await client.callTool("summarize", { text: "x207 settles agent payments with mutual credit" });
    expect(asked).toEqual([{ amount: "20000", payTo: payee.account.accountId }]);
    expect(result.paymentMade).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "summary: x207 settles agent payme" }]);
    expect(ran).toEqual(["x207 settles agent payments with mutual credit"]);
    expect(result.paymentResponse).toMatchObject({
      success: true, transaction: `${payer.account.accountId}:${payee.account.accountId}:${epoch.epoch}:1`,
      extensions: { x207: { seq: 1, cumulativeAmount: "20000", registration: "pending" } },
    });

    // the voucher is registered on the contract by the relayer
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1 });
    expect(await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId })).toMatchObject({ cumulative: "20000", last_seq: 1 });

    // a payment the owner refuses: the tool does not run and no voucher is signed
    allow = false;
    await expect(client.callTool("summarize", { text: "second call" })).rejects.toThrow();
    expect(ran).toHaveLength(1);
    expect(await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId })).toMatchObject({ cumulative: "20000", last_seq: 1 });
    console.log(["SD-083", `epoch ${epoch.epoch}`, `paid ${result.paymentResponse?.transaction}`, "registered 20000"].join(" | "));
  }, 600_000);
});
