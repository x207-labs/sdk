// SD-031 on NEAR testnet: four transactions sent at the same time from one gas key (NEP-611) of x207b-relayer.testnet, each on its own
// nonce lane, are all accepted; each lane nonce advances and the other lanes do not. The call is `ft_total_supply` of the mock token
// (a function call without effect). The gas key was added and funded by the network demo (DEMO_GAS_KEY_LANES) and its secret is read from
// the keys directory, never printed. Hashes go to X207_DEMO_RECORD.
// Run: X207_TESTNET=1 X207_DEMO_RECORD=... X207_KEYS_DIR=... npx vitest run apps/facilitator/test/gas-key-testnet.live.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { base58Decode } from "@x207/core";
import { describe, expect, it } from "vitest";
import { NearRpc } from "../src/rpc.js";
import { GasKeyLanes, signGasKeyTransaction } from "../src/gas-key.js";
import { recordStep } from "../../../test-support/demo-record.js";

const ENABLED = process.env.X207_TESTNET === "1";
const RPCS = (process.env.RPC_URLS ?? "https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org").split(",");
const RELAYER = "x207b-relayer.testnet";
const TARGET = "x207b-usdt.testnet";
const KEYS = process.env.X207_KEYS_DIR ?? "";
const RECORD = process.env.X207_DEMO_RECORD ?? "";

describe.skipIf(!ENABLED)("SD-031 gas key on testnet", () => {
  it("four parallel transactions on four nonce lanes of one gas key", async () => {
    expect(KEYS && RECORD, "set X207_KEYS_DIR and X207_DEMO_RECORD").toBeTruthy();
    const saved = JSON.parse(readFileSync(join(KEYS, "testnet", `${RELAYER}.gaskey.json`), "utf8")) as { secret_key: string; lanes: number };
    const privateKey = saved.secret_key;
    const publicKey = KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
    const rpc = new NearRpc({ urls: RPCS, timeoutMs: 20_000, rateLimit: { attempts: 5, baseMs: 2_000 } });
    const nonces = async () =>
      (await rpc.call<{ nonces: Array<number | string> }>("query", { request_type: "view_gas_key_nonces", finality: "optimistic", account_id: RELAYER, public_key: publicKey })).nonces.map(BigInt);
    const before = await nonces();
    expect(before.length).toBe(saved.lanes);

    const lanes = new GasKeyLanes(saved.lanes);
    const hashes: string[] = [];
    const used: number[] = [];
    await Promise.all(
      Array.from({ length: saved.lanes }, () =>
        lanes.run(
          async (lane) => before[lane]!,
          async (lane, nonce) => {
            used.push(lane);
            const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
            const signed = signGasKeyTransaction(
              { signerId: RELAYER, receiverId: TARGET, nonce, nonceIndex: lane, blockHash: base58Decode(block.header.hash), methodName: "ft_total_supply", args: {}, gas: 30_000_000_000_000n, deposit: 0n },
              privateKey,
            );
            const result = await rpc.call<{ status: unknown; transaction: { hash: string } }>("send_tx", { signed_tx_base64: signed.bytes.toString("base64"), wait_until: "FINAL" });
            expect(result.status, `lane ${lane}`).toHaveProperty("SuccessValue");
            hashes.push(result.transaction.hash);
            recordStep(RECORD, { section: "sd-031-gaskey", step: `parallel call on gas key lane ${lane}`, account: RELAYER, method: "ft_total_supply (Transaction::V1, NEP-611)", hash: result.transaction.hash });
          },
        ),
      ),
    );
    expect(new Set(used).size, "each parallel transaction took its own lane").toBe(saved.lanes);
    const after = await nonces();
    for (let lane = 0; lane < saved.lanes; lane += 1) expect(after[lane]! > before[lane]!, `lane ${lane} nonce advanced`).toBe(true);
    recordStep(RECORD, { section: "sd-031-gaskey", step: "lane nonces", note: `before ${before.join(",")} after ${after.join(",")}; ${hashes.length} transactions in parallel` });
  }, 300_000);
});
