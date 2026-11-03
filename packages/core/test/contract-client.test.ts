import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  JOIN_STORAGE_DEPOSIT,
  formatNear,
  buildJoinCall,
  buildStakeMsg,
  buildStakeTransferCall,
  contractErrorCode,
  getMember,
  type ContractAbi,
} from "@x207/core";

const vector = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/test-vectors/${path}`, import.meta.url)), "utf8")) as any;
const KA = vector("keys.json").keys.kA.publicKey as string;
const HASH = "a".repeat(64);
const A = "translator.x207-circle.near";

describe("SD-012 contract client", () => {
  it("TC-SD-012-01 join arguments and deposit, equal to the vector", () => {
    const call = buildJoinCall({ circleContract: "x207-circle.near", circleId: "agents-main", pubkeyVoucher: KA, termsHash: HASH });
    expect(call.methodName).toBe("join");
    expect(call.receiverId).toBe("x207-circle.near");
    expect(JSON.stringify(call.args)).toBe(
      `{"circle_id":"agents-main","pubkey_voucher":"${KA}","terms_hash":"${HASH}"}`,
    );
    expect(call.deposit).toBe(JOIN_STORAGE_DEPOSIT);
    expect(JOIN_STORAGE_DEPOSIT).toBe(35n * 10n ** 22n); // ADR-41: 0.35 NEAR for 0.0.12; 0.0.11 (0.32) and the contract before 0.0.9 (0.01) return the excess

    const v = vector("args/join.json");
    const fromVector = buildJoinCall({ circleContract: "x207-circle.near", circleId: v.input.circleId, pubkeyVoucher: v.input.pubkeyVoucher, termsHash: v.input.termsHash });
    expect(JSON.stringify(fromVector.args)).toBe(v.expected.args);
    expect(fromVector.deposit >= BigInt(v.expected.min_deposit_yocto)).toBe(true);
    expect(v.input.pubkeyVoucher).toBe(KA);
  });

  it("TC-SD-012-02 a malformed terms_hash throws before the transaction", () => {
    const base = { circleContract: "x207-circle.near", circleId: "agents-main", pubkeyVoucher: KA };
    expect(() => buildJoinCall({ ...base, termsHash: "a".repeat(63) })).toThrow(/terms_hash/);
    expect(() => buildJoinCall({ ...base, termsHash: "A".repeat(64) })).toThrow(/terms_hash/);
    expect(() => buildJoinCall({ ...base, termsHash: HASH, pubkeyVoucher: "secp256k1:abc" })).toThrow(/pubkey_voucher/);
    expect(() => buildJoinCall({ ...base, termsHash: HASH, deposit: 1n })).toThrow(/deposit/);
    expect(() => buildJoinCall({ ...base, termsHash: HASH, deposit: JOIN_STORAGE_DEPOSIT - 1n })).toThrow(/JOIN_STORAGE_DEPOSIT \(\d/);
    expect(buildJoinCall({ ...base, termsHash: HASH, deposit: 2n * JOIN_STORAGE_DEPOSIT }).deposit).toBe(2n * JOIN_STORAGE_DEPOSIT);
  });

  it("TC-SD-012-02b formatNear writes yoctoNEAR as a short NEAR text", () => {
    expect(formatNear(10n ** 22n)).toBe("0.01");
    expect(formatNear(10n ** 23n)).toBe("0.1");
    expect(formatNear(3n * 10n ** 24n)).toBe("3");
    expect(formatNear(1n)).toBe("0.000000000000000000000001");
  });

  it("TC-SD-012-03 msg builders for stake and ft_transfer_call", () => {
    expect(buildStakeMsg()).toBe('{"action":"stake"}');
    expect(buildStakeMsg({ memberId: A })).toBe('{"action":"stake","member_id":"translator.x207-circle.near"}');
    const call = buildStakeTransferCall({ circleContract: "x207-circle.near", amount: "50000000", memberId: A });
    expect(call).toEqual({
      receiverId: "usdt.tether-token.near",
      methodName: "ft_transfer_call",
      args: { receiver_id: "x207-circle.near", amount: "50000000", msg: '{"action":"stake","member_id":"translator.x207-circle.near"}' },
      deposit: 1n,
    });
    expect(typeof call.args.amount).toBe("string");
    expect(() => buildStakeTransferCall({ circleContract: "x207-circle.near", amount: "0" })).toThrow();
    expect(() => buildStakeMsg({ memberId: "Bad Id" })).toThrow();
  });

  it("TC-SD-012-04 msg dicakup vector", () => {
    const plain = vector("msg/stake.json");
    expect(plain.input.cases.map((c: { memberId?: string }) => buildStakeMsg(c))).toEqual(plain.expected.msgs);
    const withMember = vector("msg/stake_member_id.json");
    expect(withMember.input.cases.map((c: { memberId?: string }) => buildStakeMsg(c))).toEqual(withMember.expected.msgs);
  });

  it("TC-SD-012-05 view member ada", async () => {
    const member = {
      account_id: A, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
      limit: "40000000", pubkey_voucher: KA, settled_history: "0", stake: "50000000", status: "active", terms_hash: HASH,
    } satisfies ContractAbi.MemberView;
    const view = vi.fn(async () => member);
    const result = await getMember(view, A);
    expect(view).toHaveBeenCalledWith("member", { account_id: A });
    expect(result).toMatchObject({ status: "active", limit: "40000000", exit_requested_epoch: null });
  });

  it("TC-SD-012-06 a null member view is not an error", async () => {
    expect(await getMember(async () => null, "stranger.near")).toBeNull();
    expect(await getMember(async () => undefined, "stranger.near")).toBeNull();
  });

  it("TC-SD-012-07 (unit) the error code is taken from the panic message", () => {
    expect(contractErrorCode(new Error("Smart contract panicked: ERR_ALREADY_MEMBER: a.near"))).toBe("ERR_ALREADY_MEMBER");
    expect(contractErrorCode("ERR_BAD_MSG: expected value")).toBe("ERR_BAD_MSG");
    expect(contractErrorCode(new Error("network down"))).toBeNull();
  });
});
