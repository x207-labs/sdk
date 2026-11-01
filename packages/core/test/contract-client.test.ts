import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  JOIN_STORAGE_DEPOSIT,
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

describe("SD-012 client kontrak", () => {
  it("TC-SD-012-01 argumen join dan deposit, sama dengan vector", () => {
    const call = buildJoinCall({ circleContract: "x207-circle.near", circleId: "agents-main", pubkeyVoucher: KA, termsHash: HASH });
    expect(call.methodName).toBe("join");
    expect(call.receiverId).toBe("x207-circle.near");
    expect(JSON.stringify(call.args)).toBe(
      `{"circle_id":"agents-main","pubkey_voucher":"${KA}","terms_hash":"${HASH}"}`,
    );
    expect(call.deposit).toBe(10n ** 22n);
    expect(JOIN_STORAGE_DEPOSIT).toBe(10n ** 22n);

    const v = vector("args/join.json");
    const fromVector = buildJoinCall({ circleContract: "x207-circle.near", circleId: v.input.circleId, pubkeyVoucher: v.input.pubkeyVoucher, termsHash: v.input.termsHash });
    expect(JSON.stringify(fromVector.args)).toBe(v.expected.args);
    expect(fromVector.deposit >= BigInt(v.expected.min_deposit_yocto)).toBe(true);
    expect(v.input.pubkeyVoucher).toBe(KA);
  });

  it("TC-SD-012-02 terms_hash salah format melempar sebelum transaksi", () => {
    const base = { circleContract: "x207-circle.near", circleId: "agents-main", pubkeyVoucher: KA };
    expect(() => buildJoinCall({ ...base, termsHash: "a".repeat(63) })).toThrow(/terms_hash/);
    expect(() => buildJoinCall({ ...base, termsHash: "A".repeat(64) })).toThrow(/terms_hash/);
    expect(() => buildJoinCall({ ...base, termsHash: HASH, pubkeyVoucher: "secp256k1:abc" })).toThrow(/pubkey_voucher/);
    expect(() => buildJoinCall({ ...base, termsHash: HASH, deposit: 1n })).toThrow(/deposit/);
    expect(buildJoinCall({ ...base, termsHash: HASH, deposit: 2n * 10n ** 22n }).deposit).toBe(2n * 10n ** 22n);
  });

  it("TC-SD-012-03 builder msg stake dan ft_transfer_call", () => {
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

  it("TC-SD-012-06 view member null bukan error", async () => {
    expect(await getMember(async () => null, "stranger.near")).toBeNull();
    expect(await getMember(async () => undefined, "stranger.near")).toBeNull();
  });

  it("TC-SD-012-07 (unit) kode error diambil dari pesan panic", () => {
    expect(contractErrorCode(new Error("Smart contract panicked: ERR_ALREADY_MEMBER: a.near"))).toBe("ERR_ALREADY_MEMBER");
    expect(contractErrorCode("ERR_BAD_MSG: expected value")).toBe("ERR_BAD_MSG");
    expect(contractErrorCode(new Error("network down"))).toBeNull();
  });
});
