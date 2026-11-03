// Load on the chain RPC per paid call (UM-032 follow-up): how many JSON-RPC requests do the facilitator (/verify and /settle) and the
// buyer make for one payment, per method and per contract view? A real contract in near-sandbox, 96 payments of one pair through the
// seller and the facilitator, requests counted at the `fetch` of each side. The counts are printed (and written to X207_RPC_LOAD_OUT).
// Run: X207_SANDBOX=1 npx vitest run apps/facilitator/test/rpc-load.sandbox.test.ts
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { appendFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { createBuyerFetch } from "../../../examples/buyer/src/buyer.js";
import { createSeller } from "../../../examples/seller/src/seller.js";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { PendingStore, NearRpc, createApp, createFacilitatorService } from "../src/index.js";

const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

/** `fetch` that counts JSON-RPC requests by method (and by contract view name for `call_function`). */
function counting(rpcUrl: string, counts: Map<string, number>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === rpcUrl && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { method: string; params?: { request_type?: string; method_name?: string } };
      const key = body.params?.request_type === "call_function" ? `view ${body.params.method_name}` : `rpc ${body.method}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return fetch(input, init);
  }) as typeof fetch;
}

const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
const table = (counts: Map<string, number>, payments: number) =>
  [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}: ${n} (${(n / payments).toFixed(2)} per payment)`).join("; ");

describe.skipIf(!sandboxAvailable)("RPC requests per paid call in near-sandbox", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("counts the JSON-RPC requests of the facilitator and of the buyer for 96 payments", async () => {
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
    const members = { translator: await onboard("translator"), summarizer: await onboard("summarizer"), scraper: await onboard("scraper") };
    type Name = keyof typeof members;
    // six pairs in a cycle of calls: every member pays both others
    const pairs: Array<[Name, Name]> = [["translator", "summarizer"], ["summarizer", "scraper"], ["scraper", "translator"], ["translator", "scraper"], ["scraper", "summarizer"], ["summarizer", "translator"]];

    const facilitatorCounts = new Map<string, number>();
    const buyerCounts = new Map<string, number>();
    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000, fetch: counting(fx.sandbox.rpcUrl, facilitatorCounts) });
    const circle = defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId });
    const cache = process.env.X207_RPC_CACHE === "off" ? undefined : {};
    const service = createFacilitatorService({
      circles: [circle], rpc, pending: new PendingStore(":memory:"), signers: ["relayer.test.near"], ...(cache ? { chainCache: cache } : {}),
    } as Parameters<typeof createFacilitatorService>[0]);
    const facilitator = await listen(createApp(service).fetch);
    servers.push(facilitator.server);
    const sellers = {} as Record<Name, string>;
    for (const name of Object.keys(members) as Name[]) {
      const seller = await listen(createSeller({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: members[name].account.accountId }).fetch);
      servers.push(seller.server);
      sellers[name] = seller.url;
    }
    const buyers = Object.fromEntries(
      (Object.keys(members) as Name[]).map((name) => [name, createBuyerFetch({ accountId: members[name].account.accountId, secretKey: members[name].secretKey, rpcUrls: [fx.sandbox.rpcUrl], fetch: counting(fx.sandbox.rpcUrl, buyerCounts) })]),
    ) as Record<Name, typeof fetch>;
    const pay = async (i: number) => {
      const [from, to] = pairs[i % pairs.length]!;
      const response = await buyers[from](`${sellers[to]}/api/summarize`);
      expect(response.status, `payment ${i + 1} ${from} -> ${to}`).toBe(200);
    };

    // the first round (one payment per pair) fills the caches; 90 payments follow at about 5 a second
    const payments = 96;
    for (let i = 0; i < pairs.length; i += 1) await pay(i);
    const [firstFacilitator, firstBuyer] = [total(facilitatorCounts), total(buyerCounts)];
    for (let i = pairs.length; i < payments; i += 1) {
      await pay(i);
      await new Promise((r) => setTimeout(r, 200));
    }

    const [laterFacilitator, laterBuyer] = [(total(facilitatorCounts) - firstFacilitator) / (payments - pairs.length), (total(buyerCounts) - firstBuyer) / (payments - pairs.length)];
    const report = [
      `cache ${cache ? "on" : "off"}: ${payments} payments`,
      `facilitator: first round (6 payments) ${firstFacilitator} requests, later payments ${laterFacilitator.toFixed(2)} on average; ${table(facilitatorCounts, payments)}`,
      `buyer: first round (6 payments) ${firstBuyer} requests, later payments ${laterBuyer.toFixed(2)} on average; ${table(buyerCounts, payments)}`,
    ].join("\n");
    console.log(report);
    if (process.env.X207_RPC_LOAD_OUT) appendFileSync(process.env.X207_RPC_LOAD_OUT, `${report}\n\n`);
    if (cache) {
      expect(laterFacilitator, "facilitator requests per payment after the first").toBeLessThan(1);
      expect(laterBuyer, "buyer requests per payment after the first").toBeLessThan(1);
    }
  }, 300_000);
});
