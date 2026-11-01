import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signVoucher, type ContractAbi, type Ed25519Signature, type UnsignedVoucher } from "@x207/core";
import { X207SchemeFacilitator, type PendingVoucherRecord, type PendingWriter, type VerifyChain } from "@x207/scheme";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys as Record<string, { seed: string; publicKey: string }>;
const seed = (name: string) => Buffer.from(keys[name]!.seed, "hex");

const CIRCLE = "x207-circle.near";
const NETWORK = "x207:agents-main";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const C = "c.x207-circle.near";
const S = "s.x207-circle.near";
const P = "p.x207-circle.near";
const NOW = 1_793_836_800_000;
const CUTOFF_MS = NOW + 3_600_000;

const member = (account: string, key: string, status: ContractAbi.MemberStatus = "active"): ContractAbi.MemberView => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: keys[key]!.publicKey, settled_history: "0", stake: "1000000", status, terms_hash: "0".repeat(64),
});

type Row = PendingVoucherRecord & { payer: string; payee: string; epoch: number };

function setup(options: { headroomA?: string; now?: number; contractEpoch?: number } = {}) {
  const rows = new Map<string, Row>();
  const members: Record<string, ContractAbi.MemberView> = {
    [A]: member(A, "kA"), [B]: member(B, "kB"), [C]: member(C, "kOther"),
    [S]: member(S, "kOther", "suspended"), [P]: member(P, "kOther", "pending"),
  };
  const headroom: Record<string, string> = { [A]: options.headroomA ?? "1000000", [B]: "1000000", [C]: "1000000", [S]: "0", [P]: "0" };
  const store: PendingWriter = {
    save(voucher: UnsignedVoucher, signature: Ed25519Signature) {
      rows.set(`${voucher.payer}|${voucher.payee}|${voucher.epoch}`, {
        payer: voucher.payer, payee: voucher.payee, epoch: voucher.epoch, seq: voucher.seq,
        cumulativeAmount: voucher.cumulativeAmount, signature, registeredSeq: 0, attempts: 0,
      });
      return true;
    },
    get: (payer, payee, epoch) => rows.get(`${payer}|${payee}|${epoch}`) ?? null,
  };
  const chain: VerifyChain = {
    member: async (account) => members[account] ?? null,
    getEpoch: async () =>
      ({ epoch: options.contractEpoch ?? 42, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n), opened_at: "0", phase: "open" }) as unknown as ContractAbi.EpochView,
    headroom: async (account) => headroom[account] ?? "0",
    obligation: async () => null,
    pendingByPayer: async (payer, epoch) => [...rows.values()].filter((r) => r.payer === payer && r.epoch === epoch),
  };
  const facilitator = new X207SchemeFacilitator({
    network: NETWORK, circleContract: CIRCLE, verify: { chain, now: () => options.now ?? NOW }, store,
  });
  return { facilitator, rows };
}

const requirements = (over: Record<string, unknown> = {}, extraEpoch = 42, payTo = B, amount = "20000") => ({
  scheme: "batch-settlement", network: NETWORK, amount, asset: "USD", payTo, maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: extraEpoch }, ...over,
});

function pay(
  over: Partial<UnsignedVoucher> = {},
  options: { signer?: string; accepted?: Record<string, unknown>; tamper?: Partial<UnsignedVoucher> } = {},
): any {
  const unsigned: UnsignedVoucher = {
    circle: CIRCLE, payer: A, payee: B, epoch: 42, seq: 1, cumulativeAmount: "20000", unit: "credit",
    resource: "https://s.example/api", ...over,
  };
  const { signature, ...voucher } = signVoucher(unsigned, seed(options.signer ?? "kA"));
  return {
    x402Version: 2, resource: { url: unsigned.resource }, accepted: options.accepted ?? requirements({}, unsigned.epoch, unsigned.payee),
    payload: { voucher: { ...voucher, ...options.tamper }, signature },
  };
}

// Fixture negatif bersama untuk TC-SD-025-15: [nama, payload, requirements, invalidReason, opsi setup]
const NEGATIVES: [string, any, any, string, Parameters<typeof setup>[0]?][] = [
  ["penjual memalsukan", pay({}, { signer: "kB" }), requirements(), "invalid_signature"],
  ["cumulative diubah server", pay({}, { tamper: { cumulativeAmount: "10000" } }), requirements(), "invalid_signature"],
  ["payer suspended", pay({ payer: S }), requirements(), "member_not_active"],
  ["payer pending", pay({ payer: P }), requirements(), "member_not_active"],
  ["amount dinaikkan di requirements saja", pay(), requirements({ amount: "2000000" }), "invalid_payment_requirements"],
  [
    "amount dinaikkan di kedua tempat",
    pay({}, { accepted: requirements({ amount: "2000000" }) }),
    requirements({ amount: "2000000" }),
    "amount_mismatch",
  ],
  [
    "amount diturunkan di kedua tempat",
    pay({}, { accepted: requirements({ amount: "10000" }) }),
    requirements({ amount: "10000" }),
    "amount_mismatch",
  ],
  ["payTo dialihkan server", pay(), requirements({}, 42, C), "invalid_payment_requirements"],
  ["epoch masa depan", pay({ epoch: 43 }), requirements({}, 43), "epoch_mismatch"],
  ["lewat cutoff", pay(), requirements(), "epoch_closing", { now: CUTOFF_MS + 1000 }],
];

describe("SD-025 suite test negatif verify", () => {
  it("TC-SD-025-01 pemalsuan oleh penjual", async () => {
    expect(await setup().facilitator.verify(pay({}, { signer: "kB" }), requirements() as any)).toMatchObject({
      isValid: false, invalidReason: "invalid_signature", payer: A,
    });
  });

  it("TC-SD-025-02 field diubah setelah ditandatangani", async () => {
    const result = await setup().facilitator.verify(pay({}, { tamper: { cumulativeAmount: "10000" } }), requirements() as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_signature" });
  });

  it("TC-SD-025-03 payer suspended dengan headroom 0: member_not_active, bukan insufficient_credit", async () => {
    const result = await setup().facilitator.verify(pay({ payer: S }), requirements() as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "member_not_active" });
  });

  it("TC-SD-025-04 payer pending", async () => {
    expect(await setup().facilitator.verify(pay({ payer: P }), requirements() as any)).toMatchObject({
      invalidReason: "member_not_active",
    });
  });

  it("TC-SD-025-05 replay payload yang sudah di-settle", async () => {
    const { facilitator } = setup();
    const payload = pay();
    expect((await facilitator.settle(payload, requirements() as any)).success).toBe(true);
    expect(await facilitator.verify(payload, requirements() as any)).toMatchObject({
      isValid: false, invalidReason: "seq_not_increasing",
    });
  });

  it("TC-SD-025-06 di atas headroom termasuk pending", async () => {
    const { facilitator } = setup({ headroomA: "100000" });
    expect((await facilitator.settle(pay({ payee: B, cumulativeAmount: "90000" }, { accepted: requirements({ amount: "90000" }, 42, B) }), requirements({ amount: "90000" }) as any)).success).toBe(true);
    const toC = pay({ payee: C }, { accepted: requirements({}, 42, C) });
    expect(await facilitator.verify(toC, requirements({}, 42, C) as any)).toMatchObject({
      isValid: false, invalidReason: "insufficient_credit",
    });
  });

  it("TC-SD-025-07 lewat cutoff sebelum close_epoch", async () => {
    const result = await setup({ now: CUTOFF_MS + 1000 }).facilitator.verify(pay(), requirements() as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "epoch_closing" });
  });

  it("TC-SD-025-08 server menaikkan amount di requirements", async () => {
    const result = await setup().facilitator.verify(pay(), requirements({ amount: "2000000" }) as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements" });
  });

  it("TC-SD-025-09 server menaikkan amount di kedua tempat: tidak ada kewajiban baru", async () => {
    const { facilitator, rows } = setup();
    const high = requirements({ amount: "2000000" });
    const result = await facilitator.verify(pay({}, { accepted: high }), high as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "amount_mismatch" });
    expect(rows.size).toBe(0);
  });

  it("TC-SD-025-10 server menurunkan amount", async () => {
    const low = requirements({ amount: "10000" });
    const result = await setup().facilitator.verify(pay({}, { accepted: low }), low as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "amount_mismatch" });
  });

  it("TC-SD-025-11 amount tidak sah", async () => {
    for (const amount of ["0", "-1", "0.5"]) {
      const bad = requirements({ amount });
      const result = await setup().facilitator.verify(pay({}, { accepted: bad }), bad as any);
      expect(result, amount).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements" });
    }
  });

  it("TC-SD-025-12 kewajiban = nilai bertanda tangan, bukan requirements.amount", async () => {
    const { facilitator, rows } = setup();
    await facilitator.settle(pay({ seq: 1, cumulativeAmount: "20000" }), requirements() as any);
    expect(rows.get(`${A}|${B}|42`)?.cumulativeAmount).toBe("20000");
  });

  it("TC-SD-025-13 payTo dialihkan server", async () => {
    const { facilitator } = setup();
    expect(await facilitator.verify(pay(), requirements({}, 42, C) as any)).toMatchObject({
      invalidReason: "invalid_payment_requirements",
    });
    const toC = requirements({}, 42, C);
    expect(await facilitator.verify(pay({}, { accepted: toC }), toC as any)).toMatchObject({ invalidReason: "payee_mismatch" });
  });

  it("TC-SD-025-14 epoch masa depan", async () => {
    const result = await setup().facilitator.verify(pay({ epoch: 43 }), requirements({}, 43) as any);
    expect(result).toMatchObject({ isValid: false, invalidReason: "epoch_mismatch" });
  });

  it("TC-SD-025-15 penolakan tidak menyimpan; /settle success false dengan alasan yang sama", async () => {
    for (const [name, payload, reqs, reason, options] of NEGATIVES) {
      const { facilitator, rows } = setup(options);
      expect(await facilitator.verify(payload, reqs), name).toMatchObject({ isValid: false, invalidReason: reason });
      const settled = await facilitator.settle(payload, reqs);
      expect(settled, name).toMatchObject({ success: false, errorReason: reason, transaction: "" });
      expect(rows.size, name).toBe(0);
    }
  });
});
