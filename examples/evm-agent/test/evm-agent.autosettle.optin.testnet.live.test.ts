// SD-094: turn the auto-settle opt-in of the demo agent back on (set_auto_settle_evm through the relayer, signature only), so the final state on x207-v015.testnet matches the demo.
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/evm-agent/test/evm-agent.autosettle.optin.testnet.live.test.ts   (from sdk/)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createCircleViewFn } from "@x207/core";
import { defineCircleConfig } from "@x207/scheme";
import { EvmRelay, NearContractCaller, NearRpc, PendingStore, createApp, createFacilitatorService } from "../../../apps/facilitator/src/index.js";
import { createEvmAgent } from "../src/agent.js";

const CIRCLE = "x207-v015.testnet";
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd094-auto-settle-run.json");

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-094 opt-in back on (x207-v015.testnet)", () => {
  it("TC-SD-094-07 set_auto_settle_evm enabled true through the relayer", async () => {
    const agentKey = readFileSync(join(demoDir, "evm-agent-v015.key"), "utf8").trim();
    const helper = JSON.parse(readFileSync(join(demoDir, "testnet", "x207-demo-helper.testnet.json"), "utf8")) as { account_id: string; secret_key: string };
    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const pending = new PendingStore(":memory:");
    const service = createFacilitatorService({ circles: [defineCircleConfig({ network: "x207:agents-main", circleContract: CIRCLE })], rpc, pending, signers: [] });
    const caller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: { accountId: helper.account_id, privateKey: helper.secret_key } });
    const relay = new EvmRelay({ circleContract: CIRCLE, maxDeadlineMs: 900_000, caller });
    const server = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = serve({ fetch: createApp(service, { evm: relay, rateLimit: false }).fetch, port: 0, hostname: "127.0.0.1" }, ({ port }) => resolve({ url: `http://127.0.0.1:${port}`, close: () => s.close() }));
    });
    const agent = createEvmAgent({ privateKey: agentKey, relayerUrl: server.url, circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const isOn = async () => (await view("is_auto_settle" as never, { account_id: agent.id } as never)) as unknown as boolean;
    console.log("is_auto_settle before", await isOn());
    const answer = await agent.setAutoSettle(true);
    console.log("set_auto_settle_evm", answer.txHash);
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await isOn()).toBe(true);
    const file = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { hashes: Record<string, string>; rlpExecute?: { note: string } }) : { hashes: {} };
    file.hashes["set_auto_settle_evm (enabled true again, relayer, after the rlp_execute toggles)"] = answer.txHash as string;
    if (file.rlpExecute) file.rlpExecute.note += " The opt-in was switched on again afterwards with set_auto_settle_evm (see hashes), so it is ON at the end.";
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    pending.close();
    server.close();
  }, 180_000);
});
