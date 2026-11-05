// SD-094: the same EVM agent as the auto-settle demo changes its opt-in on x207-v015.testnet WITHOUT any x207 relayer: the 0x key signs an Ethereum transaction (chain id 398, NEP-518 `rlp_execute`
// on its own eth-implicit NEAR account) that calls `set_auto_settle`; the circle sees the 0x account as the caller. Recipe: contracts/docs/spike-nep518.md.
//   X207_TESTNET=1 X207_SECRETS=/path/to/.secrets npx vitest run examples/evm-agent/test/evm-agent.autosettle.rlp.testnet.live.test.ts   (from sdk/)
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, stringToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSetAutoSettleCall, createCircleViewFn } from "@x207/core";

const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(join(process.cwd(), "package.json"))("near-api-js") as typeof import("near-api-js");

const CIRCLE = "x207-v015.testnet";
const RPC_URLS = ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com"];
const secrets = process.env.X207_SECRETS ?? join(process.cwd(), "../../../.secrets");
const demoDir = join(secrets, "testnet-demo");
const out = process.env.RESULT_FILE ?? join(process.cwd(), "../docs/testnet-epochs/sd094-auto-settle-run.json");
const abi = parseAbi(["function functionCall(string receiver_id, string method_name, bytes args, uint64 gas, uint32 yocto_near)"]);

describe.skipIf(process.env.X207_TESTNET !== "1")("SD-094 rlp_execute (NEP-518) set_auto_settle on x207-v015.testnet", () => {
  it("TC-SD-094-06 the 0x key toggles its auto-settle opt-in through rlp_execute, no x207 relayer", async () => {
    const agentKey = readFileSync(join(demoDir, "evm-agent-v015.key"), "utf8").trim() as `0x${string}`;
    const evm = privateKeyToAccount(agentKey);
    const agentId = evm.address.toLowerCase();
    const helper = JSON.parse(readFileSync(join(demoDir, "testnet", "x207-demo-helper.testnet.json"), "utf8")) as { account_id: string; secret_key: string };
    const provider = new JsonRpcProvider({ url: RPC_URLS[1]! });
    const payer = new Account(helper.account_id, provider, KeyPairSigner.fromSecretKey(helper.secret_key as `ed25519:${string}`));
    const hashes: Record<string, string> = {};
    const log = (k: string, v: string) => console.log(`${k}: ${v}`);

    // 1. the eth-implicit account of the agent must exist and hold a little NEAR
    let balance = 0n;
    try {
      balance = BigInt((await provider.viewAccount({ accountId: agentId })).amount);
    } catch {
      balance = 0n;
    }
    if (balance < 200_000_000_000_000_000_000_000n) {
      const sent = await payer.transfer({ receiverId: agentId, amount: 1_000_000_000_000_000_000_000_000n });
      hashes["fund 1 NEAR to the eth-implicit account (relayer account, plain transfer)"] = sent.transaction.hash;
      log("fund", sent.transaction.hash);
      await new Promise((r) => setTimeout(r, 4_000));
    }

    const view = createCircleViewFn({ circleContract: CIRCLE, rpcUrls: RPC_URLS });
    const isOn = async () => (await view("is_auto_settle" as never, { account_id: agentId } as never)) as unknown as boolean;
    const nonceOf = async (): Promise<bigint> => {
      const r = await provider.callFunction({ contractId: agentId, method: "get_nonce", args: {}, blockQuery: { finality: "final" } });
      return BigInt(String(r));
    };

    const toggle = async (enabled: boolean): Promise<string> => {
      const call = buildSetAutoSettleCall({ circleContract: CIRCLE, enabled });
      const data = encodeFunctionData({ abi, functionName: "functionCall", args: [call.receiverId, call.methodName, toHex(stringToBytes(JSON.stringify(call.args))), (call.gas ?? 30_000_000_000_000n), 1] });
      const signed = await evm.signTransaction({
        type: "eip1559", chainId: 398, nonce: Number(await nonceOf()), to: `0x${keccak256(stringToBytes(CIRCLE)).slice(26)}`, value: 0n, data,
        gas: 1_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n,
      });
      const res = await payer.callFunctionRaw({
        contractId: agentId, methodName: "rlp_execute", args: { target: CIRCLE, tx_bytes_b64: Buffer.from(signed.slice(2), "hex").toString("base64") },
        deposit: 0n, gas: 300_000_000_000_000n, waitUntil: "FINAL",
      });
      return res.transaction.hash;
    };

    const before = await isOn();
    log("is_auto_settle before", String(before));
    const off = await toggle(!before);
    hashes[`rlp_execute set_auto_settle {enabled:${!before}} (signed by the 0x key, sent by a plain NEAR account)`] = off;
    log("rlp_execute", off);
    await new Promise((r) => setTimeout(r, 4_000));
    const mid = await isOn();
    log("is_auto_settle after", String(mid));
    expect(mid).toBe(!before);
    const back = await toggle(before);
    hashes[`rlp_execute set_auto_settle {enabled:${before}} (signed by the 0x key)`] = back;
    log("rlp_execute", back);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await isOn()).toBe(before);

    const file = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>) : {};
    file.rlpExecute = { agentAddress: agentId, circle: CIRCLE, chainId: 398, hashes };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  }, 300_000);
});
