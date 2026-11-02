import { describe, expect, it } from "vitest";
import {
  buildRequestExitCall,
  buildWithdrawStakeCall,
  contractErrorCode,
  getOutstandingDebt,
  parseEventLog,
  type ContractAbi,
} from "@x207/core";

const A = "translator.x207-circle.near";
const log = (event: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({ standard: "x207", version: "0.0.1", event, data: [data] })}`;
const one = (line: string) => parseEventLog(line)![0]!;

describe("SD-054 exit dan outstanding_debt", () => {
  it("TC-SD-054-01 exit_requested", () => {
    expect(one(log("exit_requested", { account_id: A, epoch: 42 }))).toEqual({ event: "exit_requested", account_id: A, epoch: 42 });
  });

  it("TC-SD-054-02 stake_withdrawn dan stake_withdraw_failed", () => {
    expect(one(log("stake_withdrawn", { account_id: A, amount: "50000000" }))).toEqual({ event: "stake_withdrawn", account_id: A, amount: "50000000" });
    expect(one(log("stake_withdraw_failed", { account_id: A, amount: "50000000" }))).toMatchObject({ event: "stake_withdraw_failed", amount: "50000000" });
  });

  it("TC-SD-054-03 member_reactivated", () => {
    expect(one(log("member_reactivated", { account_id: A, stake: "50000000", limit: "40000000", effective_epoch: 44 }))).toEqual({
      event: "member_reactivated", account_id: A, stake: "50000000", limit: "40000000", effective_epoch: 44,
    });
  });

  it("TC-SD-054-04 outstanding_debt di voucher_registered, member_defaulted, dan posisi epoch_committed (role none, status null)", () => {
    const defaulted = one(log("member_defaulted", {
      epoch: 42, account_id: A, due: "35000000", from_stake: "35000000", from_reserve: "0", shortfall: "0", stake: "15000000",
      status: "suspended", position_status: "defaulted", outstanding_debt: "2740000",
    }));
    expect(defaulted).toMatchObject({ event: "member_defaulted", outstanding_debt: "2740000" });
    const committed = one(log("epoch_committed", {
      epoch: 42, committed_at: "1", payment_deadline: "2", total_due: "0", total_claimable: "0", chunk: 1, chunks: 1,
      positions: [{ account_id: A, role: "none", amount: "0", net: "0", status: null, outstanding_debt: "1000" }],
    }));
    expect((committed as { positions: Array<{ role: string; status: null; outstanding_debt: string }> }).positions[0]).toMatchObject({
      role: "none", status: null, outstanding_debt: "1000",
    });
  });

  it("TC-SD-054-05 field D1 exit_requested_epoch bertipe number atau null", () => {
    const base = { account_id: A, admitted: false, joined_at: "1", last_active_epoch: 1, limit: "0", pubkey_voucher: "k", settled_history: "0", stake: "0", status: "active", terms_hash: "a" } as const;
    const exiting: ContractAbi.MemberView = { ...base, exit_requested_epoch: 42 };
    const staying: ContractAbi.MemberView = { ...base, exit_requested_epoch: null };
    expect(exiting.exit_requested_epoch).toBe(42);
    expect(staying.exit_requested_epoch).toBeNull();
  });

  it("TC-SD-054-06 view outstanding_debt mengembalikan string U128", async () => {
    expect(await getOutstandingDebt(async () => "2740000", A)).toBe("2740000");
  });

  it("TC-SD-054-07 requestExit: request_exit() tanpa argumen dengan 1 yoctoNEAR", () => {
    expect(buildRequestExitCall("x207-circle.near")).toEqual({ receiverId: "x207-circle.near", methodName: "request_exit", args: {}, deposit: 1n });
  });

  it("TC-SD-054-08 withdrawStake: 1 yoctoNEAR, error kontrak bertipe", () => {
    const call = buildWithdrawStakeCall("x207-circle.near");
    expect(call).toMatchObject({ methodName: "withdraw_stake", args: {}, deposit: 1n });
    expect(contractErrorCode(new Error("Smart contract panicked: ERR_EXIT_NOT_READY: epoch 44"))).toBe("ERR_EXIT_NOT_READY");
    expect(contractErrorCode(new Error("Smart contract panicked: ERR_HAS_DUE: 5"))).toBe("ERR_HAS_DUE");
  });
});

describe("SD-011 event solver fee dan versi 0.0.2", () => {
  const log2 = (event: string, data: unknown, version = "0.0.2") =>
    `EVENT_JSON:${JSON.stringify({ standard: "x207", version, event, data: [data] })}`;

  it("solver_fee_claimed dan solver_fee_claim_failed ter-parse bertipe", () => {
    expect(parseEventLog(log2("solver_fee_claimed", { account_id: A, amount: "150000" }))![0]).toEqual({ event: "solver_fee_claimed", account_id: A, amount: "150000" });
    expect(parseEventLog(log2("solver_fee_claim_failed", { account_id: A, amount: "150000" }))![0]).toEqual({ event: "solver_fee_claim_failed", account_id: A, amount: "150000" });
  });

  it("member_admitted dan member_reactivated dari versi 0.0.2", () => {
    expect(parseEventLog(log2("member_admitted", { account_id: A, status: "active" }))![0]).toMatchObject({ event: "member_admitted", status: "active" });
    expect(parseEventLog(log2("member_reactivated", { account_id: A, stake: "1", limit: "1", effective_epoch: 3 }))![0]).toMatchObject({ event: "member_reactivated", effective_epoch: 3 });
  });

  it("log versi 0.0.1 lama tetap diterima, versi minor 0.1.0 ditolak", () => {
    expect(parseEventLog(log2("exit_requested", { account_id: A, epoch: 1 }, "0.0.1"))).not.toBeNull();
    expect(() => parseEventLog(log2("exit_requested", { account_id: A, epoch: 1 }, "0.1.0"))).toThrow();
  });
});
