import { describe, expect, it, vi } from "vitest";
import {
  OnboardTimeoutError,
  StakeRejectedError,
  onboardMember,
  voucherPublicKey,
  type ContractAbi,
  type ContractCall,
} from "@x207/core";

const ACCOUNT = "translator.x207-circle.near";
const INPUT = {
  circleContract: "x207-circle.near", circleId: "agents-main", accountId: ACCOUNT, termsHash: "a".repeat(64), stakeAmount: "50000000",
};
const memberOf = (status: ContractAbi.MemberStatus, pubkey: string): ContractAbi.MemberView => ({
  account_id: ACCOUNT, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 1,
  limit: "40000000", pubkey_voucher: pubkey, settled_history: "0", stake: "50000000", status, terms_hash: "a".repeat(64),
});

function setup(options: { statuses: ContractAbi.MemberStatus[]; stakeResult?: unknown; failOn?: string; pubkeyOverride?: string }) {
  const calls: ContractCall[] = [];
  let pubkey = options.pubkeyOverride ?? "";
  let polls = 0;
  const sendCall = vi.fn(async (call: ContractCall) => {
    calls.push(call);
    if (options.failOn === call.methodName) throw new Error(`ERR_${call.methodName.toUpperCase()}: gagal`);
    if (call.methodName === "join" && !options.pubkeyOverride) pubkey = String(call.args.pubkey_voucher);
    if (call.methodName === "ft_transfer_call") return options.stakeResult ?? "50000000";
    return undefined;
  });
  const view = vi.fn(async () => {
    const status = options.statuses[Math.min(polls++, options.statuses.length - 1)]!;
    return memberOf(status, pubkey);
  });
  let t = 0;
  return {
    calls, sendCall, view,
    deps: { sendCall, view, pollIntervalMs: 10, timeoutMs: 100, sleep: async (ms: number) => { t += ms; }, now: () => t },
    polls: () => polls,
  };
}

describe("SD-013 onboardMember", () => {
  it("TC-SD-013-03 menunggu pending dua kali lalu active: tiga polling", async () => {
    const s = setup({ statuses: ["pending", "pending", "active"] });
    const result = await onboardMember(s.deps, INPUT);
    expect(s.polls()).toBe(3);
    expect(result.member.status).toBe("active");
  });

  it("TC-SD-013-01/02 (mock) mengembalikan keypair voucher yang pubkey-nya didaftarkan lewat join", async () => {
    const s = setup({ statuses: ["active"] });
    const result = await onboardMember(s.deps, INPUT);
    expect(s.calls.map((c) => c.methodName)).toEqual(["join", "ft_transfer_call"]);
    expect(s.calls[0]!.args.pubkey_voucher).toBe(result.publicKey);
    expect(voucherPublicKey(result.secretKey)).toBe(result.publicKey);
    expect(result.member.pubkey_voucher).toBe(result.publicKey);
    expect(s.calls[1]!.args.msg).toBe(`{"action":"stake","member_id":"${ACCOUNT}"}`);
  });

  it("memakai kunci yang diberikan", async () => {
    const first = await onboardMember(setup({ statuses: ["active"] }).deps, INPUT);
    const s = setup({ statuses: ["active"] });
    const again = await onboardMember(s.deps, { ...INPUT, secretKey: first.secretKey });
    expect(again.publicKey).toBe(first.publicKey);
  });

  it("TC-SD-013-04 tidak pernah active: error timeout bertipe", async () => {
    const s = setup({ statuses: ["pending"] });
    await expect(onboardMember(s.deps, INPUT)).rejects.toBeInstanceOf(OnboardTimeoutError);
    await expect(onboardMember(setup({ statuses: ["pending"] }).deps, INPUT)).rejects.toThrow(/pending/);
  });

  it("TC-SD-013-05 stake di-refund: error bertipe, tanpa menunggu active", async () => {
    const s = setup({ statuses: ["pending"], stakeResult: "0" });
    await expect(onboardMember(s.deps, INPUT)).rejects.toBeInstanceOf(StakeRejectedError);
    expect(s.polls()).toBe(0);
  });

  it("transaksi join atau stake yang gagal diteruskan", async () => {
    await expect(onboardMember(setup({ statuses: ["active"], failOn: "join" }).deps, INPUT)).rejects.toThrow(/ERR_JOIN/);
    const s = setup({ statuses: ["active"], failOn: "ft_transfer_call" });
    await expect(onboardMember(s.deps, INPUT)).rejects.toThrow(/ERR_FT_TRANSFER_CALL/);
  });

  it("pubkey di kontrak berbeda dari kunci yang dibuat ditolak", async () => {
    const s = setup({ statuses: ["active"], pubkeyOverride: "ed25519:other" });
    await expect(onboardMember(s.deps, INPUT)).rejects.toThrow(/pubkey_voucher/);
  });
});
