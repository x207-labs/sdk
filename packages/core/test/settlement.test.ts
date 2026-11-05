import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIM_MIN_GAS, buildClaimArgs, buildClaimCall, buildSettleMsg, buildSettleTransferCall, buildSetAutoSettleCall, getAutoSettle } from "@x207/core";

const vector = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/test-vectors/${path}`, import.meta.url)), "utf8")) as any;
const C = "scraper.x207-circle.near";

describe("SD-014 settle residual and claim helpers", () => {
  it("TC-SD-014-01 settle msg without and with member_id", () => {
    expect(buildSettleMsg({ epoch: 42 })).toBe('{"action":"settle","epoch":42}');
    expect(buildSettleMsg({ epoch: 42, memberId: C })).toBe(
      '{"action":"settle","epoch":42,"member_id":"scraper.x207-circle.near"}',
    );
  });

  it("TC-SD-014-02 claim arguments for near and intents, deposit 1 yocto, gas 100 TGas", () => {
    expect(JSON.stringify(buildClaimArgs(42, "near"))).toBe('{"epoch":42,"destination":"near"}');
    expect(JSON.stringify(buildClaimArgs(42, "intents"))).toBe('{"epoch":42,"destination":"intents"}');
    const call = buildClaimCall({ circleContract: "x207-circle.near", epoch: 42, destination: "intents" });
    expect(call).toEqual({
      receiverId: "x207-circle.near",
      methodName: "claim",
      args: { epoch: 42, destination: "intents" },
      deposit: 1n,
      gas: 100_000_000_000_000n,
    });
    expect(CLAIM_MIN_GAS).toBe(100_000_000_000_000n);
  });

  it("TC-SD-014-03 an invalid destination throws before the transaction is built", () => {
    expect(() => buildClaimArgs(42, "base" as never)).toThrow(/destination/);
    expect(() => buildClaimCall({ circleContract: "x207-circle.near", epoch: 42, destination: "base" as never })).toThrow();
  });

  it("TC-SD-014-04 covered by the vectors the contract reads", () => {
    const settle = vector("msg/settle.json");
    const msgs = settle.input.cases.map((c: { epoch: number; memberId?: string }) => buildSettleMsg(c));
    expect(msgs).toEqual(settle.expected.msgs);
    for (const name of ["near", "intents"] as const) {
      const v = vector(`args/claim_${name}.json`);
      const call = buildClaimCall({ circleContract: "x207-circle.near", epoch: v.input.epoch, destination: v.input.destination });
      expect(JSON.stringify(call.args)).toBe(v.expected.args);
      expect(call.deposit.toString()).toBe(v.expected.deposit_yocto);
      expect(call.gas! >= BigInt(v.expected.min_gas_tgas) * 10n ** 12n).toBe(true);
    }
  });

  it("settle transfer: ft_transfer_call USDT to the contract with msg, deposit 1 yocto", () => {
    const call = buildSettleTransferCall({ circleContract: "x207-circle.near", amount: "35000000", epoch: 42, memberId: C });
    expect(call).toEqual({
      receiverId: "usdt.tether-token.near",
      methodName: "ft_transfer_call",
      args: {
        receiver_id: "x207-circle.near",
        amount: "35000000",
        msg: '{"action":"settle","epoch":42,"member_id":"scraper.x207-circle.near"}',
      },
      deposit: 1n,
    });
    expect(() => buildSettleTransferCall({ circleContract: "x207-circle.near", amount: "0", epoch: 42 })).toThrow();
    expect(() => buildSettleMsg({ epoch: 0 })).toThrow();
    expect(() => buildSettleMsg({ epoch: 42, memberId: "Bad Id" })).toThrow();
  });
});

describe("SD-094 auto settle helpers (CT-108)", () => {
  it("TC-SD-094-02 buildSetAutoSettleCall names the method and the argument of the contract", () => {
    expect(buildSetAutoSettleCall({ circleContract: "x207-v015.testnet", enabled: true })).toEqual({
      receiverId: "x207-v015.testnet", methodName: "set_auto_settle", args: { enabled: true }, deposit: 0n, gas: 30_000_000_000_000n,
    });
  });

  it("TC-SD-094-03 getAutoSettle reads the view is_auto_settle and is false for anything but true", async () => {
    const calls: unknown[] = [];
    const view = (answer: unknown) => async (method: string, args: object) => { calls.push([method, args]); return answer; };
    expect(await getAutoSettle(view(true), "a.testnet")).toBe(true);
    expect(await getAutoSettle(view(false), "a.testnet")).toBe(false);
    expect(await getAutoSettle(view(null), "a.testnet")).toBe(false);
    expect(calls[0]).toEqual(["is_auto_settle", { account_id: "a.testnet" }]);
  });
});

