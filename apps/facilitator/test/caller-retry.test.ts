// A-SD-11: InvalidNonce after a timeout can mean the first send landed; the caller looks the transaction up by hash before it signs a second one.
import { KeyPair } from "@near-js/crypto";
import { describe, expect, it } from "vitest";
import { base58Encode } from "@x207/core";
import { NearContractCaller } from "../src/relay.js";
import type { NearRpc } from "../src/rpc.js";

const BLOCK = base58Encode(new Uint8Array(32).fill(7));
const ok = { status: { SuccessValue: "" }, transaction: { hash: "x" }, transaction_outcome: { outcome: { status: { SuccessValue: "" } } }, receipts_outcome: [] };

function fake(lookup: "landed" | "unknown" | "failed") {
  const calls: string[] = [];
  let sends = 0;
  const rpc = {
    async call(method: string) {
      calls.push(method);
      if (method === "query") return { nonce: 10 + sends };
      if (method === "block") return { header: { hash: BLOCK } };
      if (method === "send_tx") {
        sends += 1;
        if (sends === 1) throw new Error("rpc: InvalidNonce { tx_nonce: 11, ak_nonce: 11 }");
        return ok;
      }
      if (method === "tx") {
        if (lookup === "unknown") throw new Error("UNKNOWN_TRANSACTION");
        return lookup === "failed" ? { ...ok, status: { Failure: "ERR_X" }, transaction_outcome: { outcome: { status: { Failure: "ERR_X" } } } } : ok;
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as NearRpc;
  const caller = new NearContractCaller({ rpc, circleContract: "c.testnet", account: { accountId: "r.testnet", privateKey: KeyPair.fromRandom("ed25519").toString() } });
  return { caller, calls, sends: () => sends };
}

describe("SD-113 caller retry", () => {
  it("TC-SD-113-01 the first send landed: its hash is returned and nothing is signed twice", async () => {
    const f = fake("landed");
    const result = await f.caller.call("m", {}, 0n);
    expect(result.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,}$/);
    expect(f.sends()).toBe(1);
    expect(f.calls).toContain("tx");
  });

  it("TC-SD-113-02 the first send is unknown to the chain: a new transaction is sent once", async () => {
    const f = fake("unknown");
    await f.caller.call("m", {}, 0n);
    expect(f.sends()).toBe(2);
  });

  it("TC-SD-113-03 the first send landed but failed: the failure is reported, not retried", async () => {
    const f = fake("failed");
    await expect(f.caller.call("m", {}, 0n)).rejects.toThrow(/ERR_X/);
    expect(f.sends()).toBe(1);
  });
});
