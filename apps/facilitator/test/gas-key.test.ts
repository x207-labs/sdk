// SD-031: gas key (NEP-611) for the facilitator relayer. The `Transaction::V1` bytes are matched with the near-api-js 7.4.0 reference (a one-time test key,
// 32-byte seed 0x07, not used outside tests), and the nonce lane divider never uses one lane for two simultaneous transactions.
import { describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { base58Decode } from "@x207/core";
import { GasKeyLanes, encodeGasKeyTransaction, signGasKeyTransaction } from "../src/gas-key.js";
import { loadConfig } from "../src/config.js";
import { RegistrationScheduler, type RegistrationChain } from "../src/scheduler.js";
import { PendingStore } from "../src/pending-store.js";

const SECRET = "ed25519:99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3StnzFNUx8FKCPPPPpR479qsw5zv2WNBKmgiz7WqgAJfM";
const REFERENCE = {
  txHex: "0110000000736f6c7665722e746573742e6e65617200ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c010500000000000000070010000000636972636c652e746573742e6e656172090909090909090909090909090909090909090909090909090909090909090901000000020f0000007375626d69745f636c656172696e675c0000007b2265706f6368223a34322c226564676573223a5b7b22646562746f72223a22612e746573742e6e656172222c226372656469746f72223a22622e746573742e6e656172222c22636c6561726564223a2231303030303030227d5d7d00c06e31d91001000000000000000000000000000000000000",
  signatureHex: "8279a28a8801ef80290ee5d81db7ae1d31f3d3670b9400f6c43825703bc1c1b66ec9f1cb5874e28bbe41909e5116a3a6d4a034d1e13e99062133f30f9c314605",
};
const tx = {
  signerId: "solver.test.near", receiverId: "circle.test.near", nonce: 5n, nonceIndex: 7, blockHash: Buffer.alloc(32, 9), methodName: "submit_clearing",
  args: { epoch: 42, edges: [{ debtor: "a.test.near", creditor: "b.test.near", cleared: "1000000" }] }, gas: 300_000_000_000_000n, deposit: 0n,
};

describe("SD-031 gas key Transaction::V1", () => {
  it("TC-SD-031-01 bytes and signature equal the near-api-js 7.4.0 reference", () => {
    const publicKey = base58Decode(KeyPair.fromString(SECRET as never).getPublicKey().toString().replace(/^ed25519:/, ""));
    const body = encodeGasKeyTransaction(tx, publicKey).toString("hex");
    expect(body.startsWith(REFERENCE.txHex)).toBe(true);
    const signed = signGasKeyTransaction(tx, SECRET);
    expect(signed.bytes.toString("hex")).toBe(REFERENCE.txHex + "00" + REFERENCE.signatureHex);
  });

  it("TC-SD-031-02 a lane outside 0..1023 is rejected", () => {
    expect(() => signGasKeyTransaction({ ...tx, nonceIndex: 1024 }, SECRET)).toThrow(/0..1023/);
    expect(() => signGasKeyTransaction({ ...tx, nonceIndex: -1 }, SECRET)).toThrow(/0..1023/);
  });
});

describe("SD-031 GasKeyLanes", () => {
  it("TC-SD-031-03 parallel transactions use different lanes and each lane's nonce rises by one per transaction", async () => {
    const lanes = new GasKeyLanes(3);
    const chainNonce = [10n, 20n, 30n];
    const used: Array<[number, bigint]> = [];
    const concurrent = { now: 0, max: 0 };
    const work = async (lane: number, nonce: bigint) => {
      concurrent.now += 1;
      concurrent.max = Math.max(concurrent.max, concurrent.now);
      used.push([lane, nonce]);
      await new Promise((r) => setTimeout(r, 20));
      concurrent.now -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => lanes.run(async (lane) => chainNonce[lane]!, work)));
    expect(concurrent.max).toBe(3);
    // six transactions on three lanes: two per lane, nonce 11 then 12 and so on
    for (const lane of [0, 1, 2]) {
      const nonces = used.filter(([l]) => l === lane).map(([, n]) => n).sort();
      expect(nonces).toEqual([chainNonce[lane]! + 1n, chainNonce[lane]! + 2n]);
    }
    // parallel transactions never use the same (lane, nonce) pair
    expect(new Set(used.map(([l, n]) => `${l}:${n}`)).size).toBe(used.length);
  });

  it("TC-SD-031-04 a failure makes that lane re-read the nonce from the chain; other lanes are not disturbed", async () => {
    const lanes = new GasKeyLanes(1);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return 100n;
    };
    await lanes.run(read, async () => undefined);
    await lanes.run(read, async () => undefined);
    expect(reads).toBe(1);
    await expect(lanes.run(read, async () => { throw new Error("network down"); })).rejects.toThrow("network down");
    await lanes.run(read, async () => undefined);
    expect(reads).toBe(2);
  });

  it("TC-SD-031-05 lane count must be 1..1024", () => {
    expect(() => new GasKeyLanes(0)).toThrow();
    expect(() => new GasKeyLanes(1025)).toThrow();
    expect(new GasKeyLanes(1024).count).toBe(1024);
  });
});

describe("SD-031 configuration and scheduler", () => {
  const base = { X207_CIRCLES: "agents-main=x207-circle.near", X207_RELAYER_ACCOUNT_ID: "r.near", X207_RELAYER_PRIVATE_KEY: "ed25519:x" };
  it("TC-SD-031-06 gas key and lane count are set together, need a relayer account, 1..1024", () => {
    expect(loadConfig(base).gasKey).toBeUndefined();
    expect(loadConfig({ ...base, X207_GAS_KEY_PRIVATE_KEY: "ed25519:g", X207_GAS_KEY_LANES: "4" }).gasKey).toEqual({ privateKey: "ed25519:g", lanes: 4 });
    expect(() => loadConfig({ ...base, X207_GAS_KEY_PRIVATE_KEY: "ed25519:g" })).toThrow(/set together/);
    expect(() => loadConfig({ ...base, X207_GAS_KEY_LANES: "4" })).toThrow(/set together/);
    expect(() => loadConfig({ ...base, X207_GAS_KEY_PRIVATE_KEY: "ed25519:g", X207_GAS_KEY_LANES: "2000" })).toThrow(/1..1024/);
    expect(() => loadConfig({ X207_CIRCLES: base.X207_CIRCLES, X207_GAS_KEY_PRIVATE_KEY: "ed25519:g", X207_GAS_KEY_LANES: "4" })).toThrow(/X207_RELAYER_ACCOUNT_ID/);
  });

  it("TC-SD-031-07 a scheduler with concurrency N registers several pairs at once, never more than N", async () => {
    const store = new PendingStore(":memory:");
    const circle = "x207-circle.near";
    const now = Date.now();
    const cutoff = String(BigInt(now + 3_600_000) * 1_000_000n);
    const payer = (n: number) => `p${n}.x207-circle.near`;
    for (let i = 0; i < 6; i += 1) {
      store.upsert(circle, { circle, payer: payer(i), payee: "q.x207-circle.near", epoch: 1, seq: 1, cumulativeAmount: "2000000", unit: "credit", resource: "https://x.example" }, "ed25519:3sX9");
    }
    const gauge = { now: 0, max: 0 };
    const chain: RegistrationChain = {
      async register() {
        gauge.now += 1;
        gauge.max = Math.max(gauge.max, gauge.now);
        await new Promise((r) => setTimeout(r, 20));
        gauge.now -= 1;
      },
      lastSeq: async () => 0,
      getEpoch: async () => ({ epoch: 1, cutoff_at: cutoff }) as never,
    };
    const scheduler = new RegistrationScheduler({ circleContract: circle, store, chain, concurrency: 3, log: () => {}, now: () => now });
    expect(await scheduler.tick()).toMatchObject({ registered: 6, retrying: 0, dropped: 0 });
    expect(gauge.max).toBe(3);
    expect(store.listOpen(circle)).toEqual([]);
    store.close();
  });
});
