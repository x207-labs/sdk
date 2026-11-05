// SD-094: the creditor (the seller) claims its residual of the epoch where the agent did not pay and `finalize_epoch` took the due from the agent's stake.
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets CLAIM_EPOCH=2 npx vitest run examples/evm-agent/test/evm-agent.autosettle.claim.testnet.live.test.ts   (from sdk/)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildClaimCall, createCircleViewFn, type ContractAbi } from "@x207/core";
import { NearContractCaller, NearRpc } from "../../../apps/facilitator/src/index.js";

const CIRCLE = "x207-v015.testnet";
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"]; // UM-191: rpc.testnet.near.org is deprecated
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-094 creditor claim on x207-v015.testnet", () => {
  it("TC-SD-094-05 the seller claims the epoch after the auto-settle", async () => {
    const epoch = Number(process.env.CLAIM_EPOCH);
    const f = JSON.parse(readFileSync(join(secrets, "testnet-demo", "testnet", "x207-demo-seller.testnet.json"), "utf8")) as { account_id: string; secret_key: string };
    const rpc = new NearRpc({ urls: RPC_URLS, timeoutMs: 30_000 });
    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const position = (await view("net_position" as never, { epoch, account_id: f.account_id } as never)) as unknown as ContractAbi.PositionView | null;
    console.log("seller position", JSON.stringify(position));
    const call = buildClaimCall({ circleContract: CIRCLE, epoch, destination: "near" });
    const caller = new NearContractCaller({ rpc, circleContract: CIRCLE, account: { accountId: f.account_id, privateKey: f.secret_key } });
    const { hash } = await caller.call(call.methodName, call.args as Record<string, unknown>, call.deposit, call.receiverId, call.gas);
    console.log("seller claim", hash);
    expect(hash.length).toBeGreaterThan(10);
  }, 120_000);
});
