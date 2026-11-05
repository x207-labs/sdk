// SD-100: the EVM agent signs the eight-field Action for contracts 0.0.14 and 0.0.15 and, with the option `maxFee`, the nine-field Action of 0.0.16. No network: a fake fetch plays the relayer and the NEAR RPC.
import { describe, expect, it } from "vitest";
import { verifyEvmAction } from "@x207/core/evm";
import { generatePrivateKey } from "viem/accounts";
import { createEvmAgent } from "../src/agent.js";

const CIRCLE = "x207-v016.testnet";
const NOW = 1_800_000_000_000;

function setup(maxFee?: bigint | number | string) {
  const posts: Array<{ path: string; body: Record<string, any> }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/evm/")) {
      posts.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, method: "x", txHash: "h" }), { status: 200 });
    }
    // the NEAR RPC: `evm_signer` of a member that has acted twice
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: Array.from(Buffer.from(JSON.stringify({ address: "0x", sponsor: "s.testnet", nonce: "2" }))) } }), { status: 200 });
  }) as unknown as typeof fetch;
  const agent = createEvmAgent({ privateKey: generatePrivateKey(), relayerUrl: "http://relayer.test", circleContract: CIRCLE, rpcUrls: ["http://rpc.test"], fetch: fakeFetch, now: () => NOW, ...(maxFee === undefined ? {} : { maxFee }) });
  return { agent, posts };
}

describe("SD-100 EVM agent maxFee", () => {
  it("TC-SD-100-06 without maxFee every action is the eight-field Action and no body has maxFee (contracts 0.0.14 and 0.0.15)", async () => {
    const { agent, posts } = setup();
    await agent.claim(7, "payout.testnet");
    await agent.withdrawStake("payout.testnet");
    await agent.exit();
    await agent.setAutoSettle(true);
    expect(posts.map((p) => p.path)).toEqual(["/evm/claim", "/evm/withdraw", "/evm/exit", "/evm/auto-settle"]);
    for (const p of posts) expect(p.body).not.toHaveProperty("maxFee");
    const claim = posts[0]!.body;
    const message = { circle: CIRCLE, member: agent.id, action: "claim" as const, epoch: 7, receiver: "payout.testnet", termsHash: "", nonce: 2, deadline: NOW + 600_000 };
    expect(await verifyEvmAction(message, claim.signature)).toBe(true);
    expect(await verifyEvmAction({ ...message, maxFee: 0 }, claim.signature)).toBe(false);
  });

  it("TC-SD-100-07 with maxFee claim and withdraw sign it and send it as a decimal string; join, exit and auto-settle sign 0 and send none (contract 0.0.16)", async () => {
    const { agent, posts } = setup(250_000n);
    await agent.claim(7, "payout.testnet");
    await agent.withdrawStake("payout.testnet", { maxFee: 100_000 });
    await agent.exit();
    await agent.setAutoSettle(false);
    const [claim, withdraw, exit, auto] = posts.map((p) => p.body);
    expect(claim!.maxFee).toBe("250000");
    expect(withdraw!.maxFee).toBe("100000"); // the option of the call wins
    expect(exit).not.toHaveProperty("maxFee");
    expect(auto).not.toHaveProperty("maxFee");
    const base = { circle: CIRCLE, member: agent.id, termsHash: "", nonce: 2, deadline: NOW + 600_000 };
    expect(await verifyEvmAction({ ...base, action: "claim", epoch: 7, receiver: "payout.testnet", maxFee: "250000" }, claim!.signature)).toBe(true);
    expect(await verifyEvmAction({ ...base, action: "claim", epoch: 7, receiver: "payout.testnet", maxFee: "250001" }, claim!.signature)).toBe(false);
    expect(await verifyEvmAction({ ...base, action: "withdraw_stake", epoch: 0, receiver: "payout.testnet", maxFee: 100_000 }, withdraw!.signature)).toBe(true);
    expect(await verifyEvmAction({ ...base, action: "request_exit", epoch: 0, receiver: "", maxFee: 0 }, exit!.signature)).toBe(true);
    expect(await verifyEvmAction({ ...base, action: "auto_settle_off", epoch: 0, receiver: "", maxFee: 0 }, auto!.signature)).toBe(true);
    // the eight-field message is another digest
    expect(await verifyEvmAction({ ...base, action: "request_exit", epoch: 0, receiver: "" }, exit!.signature)).toBe(false);
  });
});
