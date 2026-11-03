import { describe, expect, it } from "vitest";
import {
  ASSET_CONTRACT_ERROR_CODES, ContractAbi, DEAL_ERROR_CODES, FREEZE_ERROR_CODES, buildApplyFreezeCall, buildCancelFreezeCall, buildConfirmDealCall, buildDisputeDealCall, buildProposeFreezeCall,
  buildRuleDealCall, buildSetAssetContractsCall, buildSettleDealCall, buildUnfreezeMemberCall, contractErrorCode, getAssetContracts, getBondLocked, getDeal, getFreeze, isFrozen,
  type CircleViewFn,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const A = "translator.x207-circle.near";

describe("SD-073 client of the deal, the freeze and the official contracts (interface 0.0.12)", () => {
  it("TC-SD-073-01 every call builder names a method that is in the pinned ABI, with the argument names of the ABI and no deposit; every view helper names a view of the ABI", () => {
    const calls = [
      buildConfirmDealCall(CIRCLE, 1), buildDisputeDealCall(CIRCLE, 1, "ab".repeat(32)), buildRuleDealCall(CIRCLE, 1, "no_fault"), buildSettleDealCall(CIRCLE, 1),
      buildProposeFreezeCall(CIRCLE, A, "cd".repeat(32)), buildApplyFreezeCall(CIRCLE, A), buildCancelFreezeCall(CIRCLE, A), buildUnfreezeMemberCall(CIRCLE, A),
      buildSetAssetContractsCall(CIRCLE, "token:nep141", ["usdt.near"]),
    ];
    for (const c of calls) {
      expect(ContractAbi.CIRCLE_CALL_METHODS as readonly string[], c.methodName).toContain(c.methodName);
      expect(c.receiverId).toBe(CIRCLE);
      expect(c.deposit).toBe(0n);
    }
    expect(calls.map((c) => [c.methodName, Object.keys(c.args)])).toEqual([
      ["confirm_deal", ["bundle_id"]], ["dispute_deal", ["bundle_id", "evidence_hash"]], ["rule_deal", ["bundle_id", "verdict"]], ["settle_deal", ["bundle_id"]],
      ["propose_freeze", ["account_id", "reason_hash"]], ["apply_freeze", ["account_id"]], ["cancel_freeze", ["account_id"]], ["unfreeze_member", ["account_id"]],
      ["set_asset_contracts", ["asset_type", "contracts"]],
    ]);
    for (const view of ["get_deal", "bond_locked", "is_frozen", "get_freeze", "get_asset_contracts"]) expect(ContractAbi.CIRCLE_VIEW_METHODS as readonly string[]).toContain(view);
    expect(buildProposeFreezeCall(CIRCLE, A).args).toEqual({ account_id: A }); // reason_hash is optional
  });

  it("TC-SD-073-02 bad arguments are refused before a transaction is built: a bundle id, an evidence hash, a verdict, a reason hash, an empty asset type", () => {
    expect(() => buildConfirmDealCall(CIRCLE, -1)).toThrow(/bundle_id/);
    expect(() => buildSettleDealCall(CIRCLE, 1.5)).toThrow(/bundle_id/);
    expect(() => buildDisputeDealCall(CIRCLE, 1, "AB".repeat(32))).toThrow(/evidence_hash/);
    expect(() => buildRuleDealCall(CIRCLE, 1, "guilty" as never)).toThrow(/verdict/);
    expect(() => buildProposeFreezeCall(CIRCLE, A, "short")).toThrow(/reason_hash/);
    expect(() => buildSetAssetContractsCall(CIRCLE, "", [])).toThrow(/asset_type/);
  });

  it("TC-SD-073-03 the views are read through the injected function and typed; null and empty answers are not errors", async () => {
    const asked: Array<[string, object]> = [];
    const answers: Record<string, unknown> = {
      get_deal: { arbiter: "arb.near", bundle_id: 3, bond_each: "20000000", state: "open" },
      bond_locked: "20000000", is_frozen: true, get_freeze: { state: "pending", eta: "1", from_epoch: 0 }, get_asset_contracts: ["usdt.near"],
    };
    const view: CircleViewFn = async (method, args) => {
      asked.push([method, args]);
      return answers[method] ?? null;
    };
    expect((await getDeal(view, 3))?.arbiter).toBe("arb.near");
    expect(await getBondLocked(view, A)).toBe("20000000");
    expect(await isFrozen(view, A)).toBe(true);
    expect((await getFreeze(view, A))?.state).toBe("pending");
    expect(await getAssetContracts(view, "token:nep141")).toEqual(["usdt.near"]);
    expect(asked).toEqual([["get_deal", { bundle_id: 3 }], ["bond_locked", { account_id: A }], ["is_frozen", { account_id: A }], ["get_freeze", { account_id: A }], ["get_asset_contracts", { asset_type: "token:nep141" }]]);
    expect(await getDeal(async () => null, 9)).toBeNull();
    expect(await isFrozen(async () => null, A)).toBe(false);
    expect(await getAssetContracts(async () => null, "x")).toEqual([]);
  });

  it("TC-SD-073-04 the error codes of the deal, the freeze and the official contracts are read from a panic message", () => {
    for (const code of [...DEAL_ERROR_CODES, ...FREEZE_ERROR_CODES, ...ASSET_CONTRACT_ERROR_CODES]) {
      expect(contractErrorCode(new Error(`Smart contract panicked: ${code}: detail`))).toBe(code);
      expect(code).toMatch(/^ERR_[A-Z_]+$/);
    }
    expect(DEAL_ERROR_CODES).toContain("ERR_DEAL_NO_STAKE_AT_RISK"); // added by the review fix of rule_deal
    expect(new Set([...DEAL_ERROR_CODES, ...FREEZE_ERROR_CODES, ...ASSET_CONTRACT_ERROR_CODES]).size).toBe(DEAL_ERROR_CODES.length + FREEZE_ERROR_CODES.length + ASSET_CONTRACT_ERROR_CODES.length);
  });
});
