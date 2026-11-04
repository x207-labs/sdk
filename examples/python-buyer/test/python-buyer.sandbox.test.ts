// SD-086 E2E near-sandbox: a Python agent (examples/python-buyer/agent.py, the `x207` Python package) pays the TypeScript seller (examples/seller) through the
// facilitator and the real contract. Skipped unless `X207_SANDBOX=1` and python3 exists. `X207_PYTHON` names the interpreter (default: the venv of this folder,
// else python3).
//   cd sdk/examples/python-buyer && python3 -m venv .venv && .venv/bin/pip install ../../python
//   cd ../.. && X207_SANDBOX=1 npx vitest run examples/python-buyer/test/python-buyer.sandbox.test.ts
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createCircleViewFn, onboardMember, type ContractAbi, type ContractCall } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { TERMS_HASH, deployCircle, type CircleFixture } from "../../../test-support/circle.js";
import { sandboxAvailable } from "../../../test-support/sandbox.js";
import { NearRegistrationChain, NearRpc, PendingStore, RegistrationScheduler, createApp, createFacilitatorService } from "../../../apps/facilitator/src/index.js";
import { createSeller } from "../../seller/src/seller.js";

const folder = new URL("..", import.meta.url).pathname;
const venv = `${folder}.venv/bin/python`;
const python = process.env.X207_PYTHON ?? (existsSync(venv) ? venv : "python3");
const hasPython = spawnSync(python, ["--version"]).status === 0;
const run = promisify(execFile);

const listen = (fetchFn: (request: Request) => Response | Promise<Response>) =>
  new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: fetchFn, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });

/** One run of agent.py; the voucher key goes in the environment of that process only. */
async function agent(args: string[], env: Record<string, string>): Promise<Array<Record<string, any>>> {
  const { stdout } = await run(python, [`${folder}agent.py`, ...args], { env: { ...process.env, ...env }, timeout: 120_000 });
  return stdout.trim().split("\n").map((line) => JSON.parse(line));
}

describe.skipIf(!sandboxAvailable || !hasPython)("SD-086 a Python agent pays the TypeScript seller on near-sandbox", () => {
  let fx: CircleFixture;
  const servers: ServerType[] = [];
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await fx?.stop();
  });

  it("three paid calls, an agent restarted without its counters resyncs, the vouchers are registered on chain, and a spend limit stops the next call", async () => {
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
    const payer = await onboard("pyagent");
    const payee = await onboard("summarizer");
    const relayer = await fx.sandbox.createAccount("relayer", "20");

    const pending = new PendingStore(":memory:");
    const rpc = new NearRpc({ urls: [fx.sandbox.rpcUrl], timeoutMs: 30_000 });
    const service = createFacilitatorService({
      circles: [defineCircleConfig({ network: "x207:agents-main", circleContract: fx.circle.accountId })], rpc, pending, signers: [relayer.accountId],
    });
    const facilitator = await listen(createApp(service).fetch);
    servers.push(facilitator.server);
    const seller = await listen(createSeller({ facilitatorUrl: facilitator.url, circleId: "agents-main", payTo: payee.account.accountId }).fetch);
    servers.push(seller.server);
    const epoch = await fx.sandbox.view<ContractAbi.EpochView>(fx.circle.accountId, "get_epoch", {});
    const env = { X207_PAYER: payer.account.accountId, X207_VOUCHER_KEY: payer.secretKey as string };
    const url = `${seller.url}/api/summarize`;

    // 1. three calls from one process: seq 1, 2, 3 and the cumulative amount grows by the price (20000)
    const first = await agent([url, "--calls", "3"], env);
    expect(first.map((r) => [r.status, r.paid, r.body])).toEqual([[200, true, { summary: "summary text" }], [200, true, { summary: "summary text" }], [200, true, { summary: "summary text" }]]);
    expect(first.map((r) => [r.epoch, r.seq, r.cumulativeAmount, r.registration])).toEqual([[epoch.epoch, 1, "20000", "pending"], [epoch.epoch, 2, "40000", "pending"], [epoch.epoch, 3, "60000", "pending"]]);

    // 2. a new process knows nothing of seq 3: its first voucher is stale, the server says where it stands, and the agent pays again from there
    const restarted = await agent([url], env);
    expect(restarted[0]).toMatchObject({ status: 200, paid: true, epoch: epoch.epoch, seq: 4, cumulativeAmount: "80000" });

    // 3. the vouchers are registered by the facilitator's scheduler and the contract holds the same totals
    const scheduler = new RegistrationScheduler({
      circleContract: fx.circle.accountId, store: pending, log: () => {}, registerThreshold: 1n,
      chain: new NearRegistrationChain({ rpc, circleContract: fx.circle.accountId, relayer: { accountId: relayer.accountId, privateKey: relayer.secretKey } }),
    });
    expect(await scheduler.tick()).toMatchObject({ registered: 1 });
    const obligation = await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId });
    expect(obligation).toMatchObject({ cumulative: "80000", last_seq: 4 });

    // 4. the owner's limit per call stops the agent before it signs anything: exit code 1, and the contract total is unchanged
    await expect(agent([url, "--max-per-call", "10000"], env)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("spend limit per call exceeded") });
    expect(await fx.sandbox.view<ContractAbi.ObligationView>(fx.circle.accountId, "obligation", { epoch: epoch.epoch, debtor: payer.account.accountId, creditor: payee.account.accountId })).toMatchObject({ cumulative: "80000" });
  }, 300_000);
});
