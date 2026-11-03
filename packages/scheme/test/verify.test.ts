import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signVoucher, type ContractAbi, type UnsignedVoucher } from "@x207/core";
import { X207SchemeFacilitator, type PendingVoucherRef, type VerifyChain } from "@x207/scheme";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys as Record<string, { seed: string; publicKey: string }>;
const seed = (name: string) => Buffer.from(keys[name]!.seed, "hex");
const pub = (name: string) => keys[name]!.publicKey;

const CIRCLE = "x207-circle.near";
const A = "a.x207-circle.near"; // active, kA, limit besar
const B = "b.x207-circle.near"; // active, kB
const C = "c.x207-circle.near"; // active, kOther
const D = "d.x207-circle.near"; // active, kD, headroom 30000
const N = "n.x207-circle.near"; // tidak terdaftar
const S = "s.x207-circle.near"; // suspended
const P = "p.x207-circle.near"; // pending
const X = "x.x207-circle.near"; // exited
const L = "l.x207-circle.near"; // active, exiting
const NETWORK = "x207:agents-main";
const NOW = 1_793_836_800_000;
const CUTOFF_MS = NOW + 3_600_000;

const member = (
  account: string,
  key: string,
  status: ContractAbi.MemberStatus = "active",
  exit: number | null = null,
): ContractAbi.MemberView => ({
  account_id: account, admitted: false, exit_requested_epoch: exit, joined_at: "1", last_active_epoch: 42,
  limit: "100000", pubkey_voucher: pub(key), settled_history: "0", stake: "100000", status, terms_hash: "0".repeat(64),
});

type World = {
  members: Record<string, ContractAbi.MemberView>;
  headroom: Record<string, string>;
  obligations: Record<string, { cumulative: string; last_seq: number }>;
  pending: (PendingVoucherRef & { payer: string; epoch: number; attempts?: number })[];
  epoch: ContractAbi.EpochView;
  now: number;
  fail?: boolean;
  /** Accounts that `is_frozen` answers true for (SD-074); `undefined` = a chain of the older contract that has no such view. */
  frozen?: string[];
};

const world = (): World => ({
  members: {
    [A]: member(A, "kA"), [B]: member(B, "kB"), [C]: member(C, "kOther"), [D]: member(D, "kD"),
    [S]: member(S, "kOther", "suspended"), [P]: member(P, "kOther", "pending"),
    [X]: member(X, "kOther", "exited"), [L]: member(L, "kOther", "active", 42),
  },
  headroom: { [A]: "1000000", [B]: "1000000", [D]: "30000", [S]: "0", [P]: "0", [L]: "1000000", [C]: "1000000" },
  obligations: {},
  pending: [],
  epoch: {
    epoch: 42, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n), opened_at: "0", phase: "open",
    edge_count: 0, participant_count: 0, pool: "0", params: {} as ContractAbi.Params,
  } as unknown as ContractAbi.EpochView,
  now: NOW,
});

function chainOf(w: World): VerifyChain {
  const guard = () => { if (w.fail) throw new Error("chain unavailable"); };
  return {
    member: async (account) => { guard(); return w.members[account] ?? null; },
    getEpoch: async () => { guard(); return w.epoch; },
    headroom: async (account) => { guard(); return w.headroom[account] ?? "0"; },
    obligation: async (epoch, debtor, creditor) => { guard(); return w.obligations[`${epoch}:${debtor}:${creditor}`] ?? null; },
    pendingByPayer: async (payer, epoch) => { guard(); return w.pending.filter((r) => r.payer === payer && r.epoch === epoch); },
    ...(w.frozen === undefined ? {} : { isFrozen: async (account: string) => { guard(); return w.frozen!.includes(account); } }),
  };
}

const facilitatorOf = (w: World) =>
  new X207SchemeFacilitator({
    network: NETWORK, circleContract: CIRCLE,
    verify: { chain: chainOf(w), now: () => w.now },
  });

const requirements = (payTo = B, epoch = 42, circleContract = CIRCLE, amount = "20000") => ({
  scheme: "batch-settlement", network: NETWORK, amount, asset: "USD", payTo, maxTimeoutSeconds: 60,
  extra: { circleContract, unit: "credit", decimals: 6, epoch },
});

function payloadOf(
  voucher: Partial<UnsignedVoucher>, signer = "kA", accepted: Record<string, any> = requirements(voucher.payee ?? B),
) {
  const unsigned: UnsignedVoucher = {
    circle: CIRCLE, payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: "20000", unit: "credit",
    resource: "https://summarizer.example/api", ...voucher,
  };
  const { signature, ...rest } = signVoucher(unsigned, seed(signer));
  return {
    x402Version: 2, resource: { url: unsigned.resource }, accepted,
    payload: { voucher: rest, signature },
  } as any;
}

const verify = (w: World, payload: any, reqs: any = requirements()) => facilitatorOf(w).verify(payload, reqs);

describe("SD-024 facilitator verify", () => {
  it("TC-SD-024-01 success path", async () => {
    expect(await verify(world(), payloadOf({}))).toEqual({ isValid: true, payer: A });
  });

  it("TC-SD-024-02 versi x402", async () => {
    const p = payloadOf({}); p.x402Version = 1;
    expect(await verify(world(), p)).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
  });

  it("TC-SD-024-03 scheme", async () => {
    const reqs = { ...requirements(), scheme: "exact" };
    const p = payloadOf({}, "kA", reqs);
    expect(await verify(world(), p, reqs)).toMatchObject({ invalidReason: "unsupported_scheme" });
  });

  it("TC-SD-024-04 network not configured", async () => {
    const reqs = { ...requirements(), network: "x207:other-circle" };
    const p = payloadOf({}, "kA", reqs);
    expect(await verify(world(), p, reqs)).toMatchObject({ invalidReason: "invalid_network" });
  });

  it("TC-SD-024-05 accepted differs from requirements", async () => {
    const p = payloadOf({}, "kA", requirements(B, 42, CIRCLE, "10000"));
    expect(await verify(world(), p, requirements())).toMatchObject({ invalidReason: "invalid_payment_requirements" });
    const zero = requirements(B, 42, CIRCLE, "0");
    expect(await verify(world(), payloadOf({}, "kA", zero), zero)).toMatchObject({
      invalidReason: "invalid_payment_requirements",
    });
  });

  it("TC-SD-024-06 skema payload", async () => {
    const noSignature = payloadOf({}); delete noSignature.payload.signature;
    expect(await verify(world(), noSignature)).toMatchObject({ invalidReason: "invalid_payload" });
    const stringSeq = payloadOf({}); stringSeq.payload.voucher.seq = "1";
    expect(await verify(world(), stringSeq)).toMatchObject({ invalidReason: "invalid_payload" });
  });

  it("TC-SD-024-07 circle voucher", async () => {
    const p = payloadOf({ circle: "evil-circle.near" });
    expect(await verify(world(), p)).toMatchObject({ invalidReason: "circle_mismatch", payer: A });
  });

  it("TC-SD-024-08 circle requirements", async () => {
    const reqs = requirements(B, 42, "evil-circle.near");
    const p = payloadOf({ circle: "evil-circle.near" }, "kA", reqs);
    expect(await verify(world(), p, reqs)).toMatchObject({ invalidReason: "circle_mismatch" });
  });

  it("TC-SD-024-09 payee", async () => {
    const p = payloadOf({ payee: C }, "kA", requirements(B));
    expect(await verify(world(), p)).toMatchObject({ invalidReason: "payee_mismatch" });
  });

  it("TC-SD-024-10 unit and resource", async () => {
    const unit = payloadOf({}); unit.payload.voucher.unit = "usd";
    expect(await verify(world(), unit)).toMatchObject({ invalidReason: "invalid_payload" });
    const resource = payloadOf({}); resource.payload.voucher.resource = "https://x.example/ü";
    expect(await verify(world(), resource)).toMatchObject({ invalidReason: "invalid_payload" });
  });

  it("TC-SD-024-11 paying yourself", async () => {
    const p = payloadOf({ payee: A }, "kA", requirements(A));
    expect(await verify(world(), p, requirements(A))).toMatchObject({ invalidReason: "self_payment" });
  });

  it("TC-SD-024-12 epoch voucher", async () => {
    const p = payloadOf({ epoch: 41 }, "kA", requirements(B, 42));
    expect(await verify(world(), p)).toMatchObject({ invalidReason: "epoch_mismatch" });
  });

  it("TC-SD-024-13 contract epoch", async () => {
    const reqs = requirements(B, 41);
    expect(await verify(world(), payloadOf({ epoch: 41 }, "kA", reqs), reqs)).toMatchObject({
      invalidReason: "epoch_mismatch",
    });
  });

  it("TC-SD-024-14 flushLead limit", async () => {
    const w = world();
    w.now = CUTOFF_MS - 120_000;
    expect(await verify(w, payloadOf({}))).toMatchObject({ invalidReason: "epoch_closing" });
    w.now = CUTOFF_MS - 121_000;
    expect(await verify(w, payloadOf({}))).toMatchObject({ isValid: true });
  });

  it("a phase that is not open counts as epoch_closing", async () => {
    const w = world();
    (w.epoch as { phase: string }).phase = "cutoff";
    expect(await verify(w, payloadOf({}))).toMatchObject({ invalidReason: "epoch_closing" });
  });

  it("TC-SD-024-15 not a member", async () => {
    const p = payloadOf({ payer: N }, "kZ");
    expect(await verify(world(), p)).toMatchObject({ invalidReason: "member_not_found", payer: N });
  });

  it("TC-SD-024-16 payer not active", async () => {
    for (const payer of [S, P, X]) {
      expect(await verify(world(), payloadOf({ payer }, "kOther")), payer).toMatchObject({
        invalidReason: "member_not_active",
      });
    }
  });

  it("TC-SD-024-17 payee not active", async () => {
    for (const payee of [N, S]) {
      const reqs = requirements(payee);
      expect(await verify(world(), payloadOf({ payee }, "kA", reqs), reqs), payee).toMatchObject({
        invalidReason: "payee_not_active",
      });
    }
  });

  it("TC-SD-074-01 a voucher from or to a frozen account is refused account_frozen, also a first voucher of the epoch of the freeze; others pass; no is_frozen view means no check", async () => {
    const w = { ...world(), frozen: [A] };
    expect(await verify(w, payloadOf({}, "kA"))).toMatchObject({ isValid: false, invalidReason: "account_frozen", payer: A });
    const toFrozen = requirements(D);
    expect(await verify({ ...world(), frozen: [D] }, payloadOf({ payee: D }, "kA", toFrozen), toFrozen)).toMatchObject({ invalidReason: "account_frozen" });
    // another pair is not touched
    const other = requirements(B);
    expect(await verify({ ...world(), frozen: [D] }, payloadOf({ payer: C }, "kOther", other), other)).toMatchObject({ isValid: true });
    expect(await verify({ ...world(), frozen: [] }, payloadOf({}, "kA"))).toMatchObject({ isValid: true });
    expect(await verify(world(), payloadOf({}, "kA"))).toMatchObject({ isValid: true }); // a chain of contract 0.0.11 has no is_frozen
    // a failing view is an error of the facilitator, not an accepted voucher
    await expect(verify({ ...world(), frozen: [], fail: true }, payloadOf({}, "kA"))).rejects.toThrow();
  });

  it("TC-SD-024-18 and 19 exiting", async () => {
    expect(await verify(world(), payloadOf({ payer: L }, "kOther"))).toMatchObject({ invalidReason: "member_exiting" });
    const reqs = requirements(L);
    expect(await verify(world(), payloadOf({ payee: L }, "kA", reqs), reqs)).toMatchObject({
      invalidReason: "member_exiting",
    });
  });

  it("TC-SD-024-20 tanda tangan", async () => {
    expect(await verify(world(), payloadOf({}, "kZ"))).toMatchObject({ invalidReason: "invalid_signature" });
  });

  it("TC-SD-024-21 and 22 ADR-23", async () => {
    const w = world();
    w.pending.push({ payer: A, payee: C, epoch: 42, seq: 1, cumulativeAmount: "1000", attempts: 2 });
    expect(await verify(w, payloadOf({}))).toMatchObject({ invalidReason: "registration_retry_pending" });
    w.pending[0]!.attempts = 1;
    expect(await verify(w, payloadOf({}))).toMatchObject({ isValid: true });
  });

  it("TC-SD-024-23 replay on-chain", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "100000", last_seq: 5 };
    expect(await verify(w, payloadOf({ seq: 5, cumulativeAmount: "120000" }))).toMatchObject({
      invalidReason: "seq_not_increasing",
    });
  });

  it("TC-SD-024-24 replay pending, basis pending", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "100000", last_seq: 5 };
    w.pending.push({ payer: A, payee: B, epoch: 42, seq: 7, cumulativeAmount: "140000" });
    expect(await verify(w, payloadOf({ seq: 6, cumulativeAmount: "160000" }))).toMatchObject({
      invalidReason: "seq_not_increasing",
    });
  });

  it("TC-SD-024-25 kumulatif turun", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "100000", last_seq: 5 };
    expect(await verify(w, payloadOf({ seq: 6, cumulativeAmount: "80000" }))).toMatchObject({
      invalidReason: "cumulative_decreased",
    });
  });

  it("TC-SD-024-26 and 27 an increase is not a price", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "20000", last_seq: 1 };
    expect(await verify(w, payloadOf({ seq: 2, cumulativeAmount: "60000" }))).toMatchObject({
      invalidReason: "amount_mismatch",
    });
    expect(await verify(w, payloadOf({ seq: 2, cumulativeAmount: "20000" }))).toMatchObject({
      invalidReason: "amount_mismatch",
    });
  });

  it("TC-SD-024-28 credit (and TC-SD-023-06 two pending vouchers)", async () => {
    const w = world();
    w.pending.push({ payer: D, payee: C, epoch: 42, seq: 1, cumulativeAmount: "20000" });
    const p = payloadOf({ payer: D }, "kD");
    expect(await verify(w, p)).toMatchObject({ isValid: false, invalidReason: "insufficient_credit", payer: D });

    const fresh = world();
    expect(await verify(fresh, payloadOf({ payer: D, payee: B }, "kD"))).toMatchObject({ isValid: true });
    fresh.pending.push({ payer: D, payee: B, epoch: 42, seq: 1, cumulativeAmount: "20000" });
    const second = payloadOf({ payer: D, payee: C }, "kD", requirements(C));
    expect(await verify(fresh, second, requirements(C))).toMatchObject({ invalidReason: "insufficient_credit" });
  });

  it("TC-SD-023-05 passes on-chain, fails after pending", async () => {
    const w = world();
    w.headroom[A] = "100000";
    w.pending.push({ payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: "90000" });
    const reqs = requirements(C, 42, CIRCLE, "20000");
    expect(await verify(w, payloadOf({ payee: C }, "kA", reqs), reqs)).toMatchObject({
      invalidReason: "insufficient_credit",
    });
  });

  it("TC-SD-024-29 base from obligation", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "60000", last_seq: 3 };
    expect(await verify(w, payloadOf({ seq: 4, cumulativeAmount: "80000" }))).toMatchObject({ isValid: true });
  });

  it("TC-SD-024-30 stops at the first rejection", async () => {
    const w = world();
    w.obligations[`42:${A}:${B}`] = { cumulative: "100000", last_seq: 5 };
    expect(await verify(w, payloadOf({ seq: 3, cumulativeAmount: "120000" }, "kZ"))).toMatchObject({
      invalidReason: "invalid_signature",
    });
    const wrongVersion = payloadOf({}, "kZ"); wrongVersion.x402Version = 1;
    expect(await verify(world(), wrongVersion)).toMatchObject({ invalidReason: "invalid_x402_version" });
  });

  it("TC-SD-024-31 no state change", async () => {
    const w = world();
    const before = JSON.stringify(w);
    for (let i = 0; i < 3; i++) expect(await verify(w, payloadOf({}))).toMatchObject({ isValid: true });
    expect(await verify(w, payloadOf({}, "kZ"))).toMatchObject({ isValid: false });
    expect(JSON.stringify(w)).toBe(before);
  });

  it("TC-SD-024-32 RPC failure throws, not isValid false", async () => {
    const w = world();
    w.fail = true;
    await expect(verify(w, payloadOf({}))).rejects.toThrow("chain unavailable");
  });

  it("without configuration verify throws NotImplementedError", async () => {
    const f = new X207SchemeFacilitator({ network: NETWORK, circleContract: CIRCLE });
    await expect(f.verify(payloadOf({}), requirements() as any)).rejects.toThrow(/SD-024/);
  });
});

describe("SD-024 kasus negatif tambahan", () => {
  it("forgery by the seller", async () => {
    expect(await verify(world(), payloadOf({}, "kB"))).toMatchObject({ invalidReason: "invalid_signature" });
  });

  it("field changed after signing", async () => {
    const p = payloadOf({ cumulativeAmount: "20000" });
    p.payload.voucher.cumulativeAmount = "10000";
    expect(await verify(world(), p)).toMatchObject({ invalidReason: "invalid_signature" });
  });

  it("payer suspended with headroom 0", async () => {
    expect(await verify(world(), payloadOf({ payer: S }, "kOther"))).toMatchObject({
      invalidReason: "member_not_active",
    });
  });

  it("payer pending", async () => {
    expect(await verify(world(), payloadOf({ payer: P }, "kOther"))).toMatchObject({
      invalidReason: "member_not_active",
    });
  });

  it("replay of an already settled payload", async () => {
    const w = world();
    const p = payloadOf({});
    expect(await verify(w, p)).toMatchObject({ isValid: true });
    w.pending.push({ payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: "20000" });
    expect(await verify(w, p)).toMatchObject({ invalidReason: "seq_not_increasing" });
  });
});
