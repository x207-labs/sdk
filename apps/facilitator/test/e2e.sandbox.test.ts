// E2E near-sandbox: buyer (examples/buyer) -> seller (examples/seller) -> facilitator -> real contract.
// Covers TC-SD-035-01, TC-SD-027-02, TC-SD-016-10, and on-chain registration of one pair.
// Skipped unless `npm run test:sandbox` (see test-support/sandbox.ts).
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRequestExitCall, onboardMember, createCircleViewFn, parseEventLog, type ContractAbi, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { createBuyerFetch } from "../../../examples/buyer/src/buyer.js";
import { createSeller } from "../../../examples/seller/src/seller.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { PendingStore, RegistrationScheduler, NearRegistrationChain, NearRpc, createApp, createFacilitatorService } from "../src/index.js";

const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

describe.skipIf(!sandboxAvailable)("E2E buyer, seller, facilitator, contract on near-sandbox", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("one paid call with a voucher, then on-chain registration", async () => {
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
    const clock = { offsetMs: 0 };
    const service = createFacilitatorService({
      circles: [circle], rpc, pending, signers: [relayer.accountId], now: () => Date.now() + clock.offsetMs,
    });
    const facilitator = await listen(createApp(service).fetch);
    servers.push(facilitator.server);
    const seller = await listen(
      createSeller({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: payee.account.accountId }).fetch,
    );
    servers.push(seller.server);

    // TC-SD-016-10 (part without epoch jump): extra.epoch from /supported = contract epoch.
    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const supported = (await (await fetch(`${facilitator.url}/supported`)).json()) as { kinds: Array<{ network: string; extra?: { epoch: number } }> };
    expect(supported.kinds.find((k) => k.network === "x207:agents-main")?.extra?.epoch).toBe(epoch.epoch);

    const paid = createBuyerFetch({ accountId: payer.account.accountId, secretKey: payer.secretKey, rpcUrls: [fx.sandbox.rpcUrl] });
    const response = await paid(`${seller.url}/api/summarize`);
    expect(response.status).toBe(200);
    const settled = JSON.parse(Buffer.from(response.headers.get("PAYMENT-RESPONSE")!, "base64").toString("utf8"));
    expect(settled).toMatchObject({
      success: true, transaction: `${payer.account.accountId}:${payee.account.accountId}:${epoch.epoch}:1`,
      extensions: { x207: { seq: 1, cumulativeAmount: "20000", registration: "pending" } },
    });

    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1 });
    const obligation = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", {
      epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId,
    });
    expect(obligation).toMatchObject({ cumulative: "20000", last_seq: 1 });

    // TC-SD-054-14: the payer calls request_exit and then a new voucher is rejected member_exiting; the exit_requested event is parsed.
    const exit = await payer.account.call(buildRequestExitCall(fx.circle.accountId));
    expect(exit.failures).toEqual([]);
    expect(exit.logs.flatMap((log) => parseEventLog(log) ?? [])).toContainEqual(
      expect.objectContaining({ event: "exit_requested", account_id: payer.account.accountId }),
    );
    const challenges: string[] = [];
    const spying = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      const header = response.headers.get("PAYMENT-REQUIRED");
      if (response.status === 402 && header) challenges.push(JSON.parse(Buffer.from(header, "base64").toString("utf8")).error);
      return response;
    }) as typeof fetch;
    await createBuyerFetch({ accountId: payer.account.accountId, secretKey: payer.secretKey, rpcUrls: [fx.sandbox.rpcUrl], fetch: spying })(
      `${seller.url}/api/summarize`,
    ).catch(() => undefined);
    expect(challenges).toContain("member_exiting");

    // TC-SD-016-10: close_epoch advances the epoch; /supported follows after the 60-second cache expires.
    await fx.sandbox.advanceTo(Number(BigInt(epoch.cutoff_at) / 1_000_000n) + 1_000);
    await new Promise((r) => setTimeout(r, 3_000));
    const closed = await fx.sandbox.accountFrom(relayer.accountId, relayer.secretKey).call({ receiverId: fx.circle.accountId, methodName: "close_epoch", args: { epoch: epoch.epoch }, deposit: 0n }, "EXECUTED_OPTIMISTIC");
    expect(closed.failures).toEqual([]);
    const cutoffEvent = closed.logs.flatMap((log) => parseEventLog(log) ?? []).find((e) => e.event === "epoch_cutoff");
    expect(cutoffEvent).toMatchObject({ epoch: epoch.epoch, next_epoch: epoch.epoch + 1 });
    clock.offsetMs += 61_000;
    // close_epoch is answered at EXECUTED_OPTIMISTIC; wait for the final head to catch up before the `final` view is used by /supported.
    let next = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    for (let i = 0; i < 40 && next.epoch !== epoch.epoch + 1; i++) {
      await new Promise((r) => setTimeout(r, 500));
      next = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    }
    expect(next.epoch).toBe(epoch.epoch + 1);
    await new Promise((r) => setTimeout(r, 3_000));
    const after = (await (await fetch(`${facilitator.url}/supported`)).json()) as { kinds: Array<{ network: string; extra?: { epoch: number } }> };
    expect(after.kinds.find((k) => k.network === "x207:agents-main")?.extra?.epoch).toBe(epoch.epoch + 1);
  }, 300_000);
});
