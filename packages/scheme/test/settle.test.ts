import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { signVoucher, type ContractAbi, type Ed25519Signature, type UnsignedVoucher } from "@x207/core";
import {
  X207SchemeFacilitator,
  X207SchemeServer,
  computeHeadroom,
  type PendingVoucherRecord,
  type PendingWriter,
  type VerifyChain,
} from "@x207/scheme";

const keys = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8"),
).keys as Record<string, { seed: string; publicKey: string }>;
const seed = (name: string) => Buffer.from(keys[name]!.seed, "hex");

const CIRCLE = "x207-circle.near";
const A = "a.x207-circle.near";
const B = "b.x207-circle.near";
const NETWORK = "x207:agents-main";
const NOW = 1_793_836_800_000;
const CUTOFF_MS = NOW + 3_600_000;

const member = (account: string, key: string): ContractAbi.MemberView => ({
  account_id: account, admitted: false, exit_requested_epoch: null, joined_at: "1", last_active_epoch: 42,
  limit: "1000000", pubkey_voucher: keys[key]!.publicKey, settled_history: "0", stake: "1000000", status: "active",
  terms_hash: "0".repeat(64),
});

type Row = PendingVoucherRecord & { payer: string; payee: string; epoch: number };

class MemoryStore implements PendingWriter {
  rows = new Map<string, Row>();
  saves = 0;
  private key = (payer: string, payee: string, epoch: number) => `${payer}|${payee}|${epoch}`;
  save(voucher: UnsignedVoucher, signature: Ed25519Signature): boolean {
    const key = this.key(voucher.payer, voucher.payee, voucher.epoch);
    const existing = this.rows.get(key);
    if (existing && existing.seq >= voucher.seq) return false;
    this.saves++;
    this.rows.set(key, {
      payer: voucher.payer, payee: voucher.payee, epoch: voucher.epoch, seq: voucher.seq,
      cumulativeAmount: voucher.cumulativeAmount, signature,
      registeredSeq: existing?.registeredSeq ?? 0, attempts: existing?.attempts ?? 0,
    });
    return true;
  }
  get(payer: string, payee: string, epoch: number) {
    return this.rows.get(this.key(payer, payee, epoch)) ?? null;
  }
  set(row: Row) {
    this.rows.set(this.key(row.payer, row.payee, row.epoch), row);
  }
  snapshot() {
    return JSON.stringify([...this.rows.entries()]);
  }
}

function setup() {
  const store = new MemoryStore();
  const chain: VerifyChain = {
    member: async (account) => (account === A ? member(A, "kA") : account === B ? member(B, "kB") : null),
    getEpoch: async () =>
      ({ epoch: 42, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n), opened_at: "0", phase: "open" }) as unknown as ContractAbi.EpochView,
    headroom: async () => "1000000",
    obligation: async () => null,
    pendingByPayer: async (payer, epoch) =>
      [...store.rows.values()].filter((r) => r.payer === payer && r.epoch === epoch),
  };
  const facilitator = new X207SchemeFacilitator({
    network: NETWORK, circleContract: CIRCLE, verify: { chain, now: () => NOW }, store,
  });
  return { store, chain, facilitator };
}

const REQ = {
  scheme: "batch-settlement", network: NETWORK, amount: "20000", asset: "USD", payTo: B, maxTimeoutSeconds: 60,
  extra: { circleContract: CIRCLE, unit: "credit", decimals: 6, epoch: 42 },
};
function payload(seq = 1, cumulative = String(seq * 20000), signer = "kA"): any {
  const { signature, ...voucher } = signVoucher(
    { circle: CIRCLE, payer: A, payee: B, epoch: 42, seq, cumulativeAmount: cumulative, unit: "credit", resource: "https://s.example/api" },
    seed(signer),
  );
  return { x402Version: 2, resource: { url: voucher.resource }, accepted: REQ, payload: { voucher, signature } };
}

describe("SD-026 facilitator settle", () => {
  it("TC-SD-026-01 jalur sukses", async () => {
    const { facilitator } = setup();
    expect(await facilitator.settle(payload(), REQ as any)).toEqual({
      success: true,
      transaction: `${A}:${B}:42:1`,
      network: NETWORK,
      payer: A,
      extensions: { x207: { epoch: 42, seq: 1, cumulativeAmount: "20000", registration: "pending" } },
    });
  });

  it("TC-SD-026-02 transaction adalah commitment id, bukan tx hash", async () => {
    const result = await setup().facilitator.settle(payload(), REQ as any);
    expect(result.transaction).toMatch(/^[^:]+:[^:]+:\d+:\d+$/);
    expect(result.transaction).not.toBe("");
    expect(JSON.stringify(result)).not.toContain("X-X207-Commitment");
  });

  it("TC-SD-026-03 lolos tipe SettleResponse @x402/core", async () => {
    const result: SettleResponse = await setup().facilitator.settle(payload(), REQ as any);
    expect(result.success).toBe(true);
  });

  it("TC-SD-026-04 voucher tersimpan", async () => {
    const { facilitator, store } = setup();
    await facilitator.settle(payload(), REQ as any);
    expect(store.get(A, B, 42)).toMatchObject({ seq: 1, cumulativeAmount: "20000", attempts: 0 });
  });

  it("TC-SD-026-05 pending dihitung di /verify berikutnya", async () => {
    const { facilitator, chain } = setup();
    expect(await computeHeadroom(A, 42, chain)).toBe("1000000");
    await facilitator.settle(payload(), REQ as any);
    expect(await facilitator.verify(payload(), REQ as any)).toMatchObject({ isValid: false, invalidReason: "seq_not_increasing" });
    expect(await facilitator.verify(payload(2), REQ as any)).toEqual({ isValid: true, payer: A });
    expect(await computeHeadroom(A, 42, chain)).toBe("980000");
  });

  it("TC-SD-026-06 /verify berulang tanpa efek", async () => {
    const { facilitator, store } = setup();
    for (let i = 0; i < 5; i++) await facilitator.verify(payload(), REQ as any);
    expect(store.rows.size).toBe(0);
    expect((await facilitator.settle(payload(), REQ as any)).success).toBe(true);
  });

  it("TC-SD-026-07 idempoten per commitment id", async () => {
    const { facilitator, store } = setup();
    const first = await facilitator.settle(payload(), REQ as any);
    const before = store.snapshot();
    const second = await facilitator.settle(payload(), REQ as any);
    expect(second).toEqual(first);
    expect(store.snapshot()).toBe(before);
    expect(store.saves).toBe(1);
  });

  it("TC-SD-026-08 seq lebih kecil dari yang tersimpan", async () => {
    const { facilitator, store } = setup();
    store.set({ payer: A, payee: B, epoch: 42, seq: 137, cumulativeAmount: "2740000", signature: "ed25519:x", registeredSeq: 0, attempts: 0 });
    expect(await facilitator.settle(payload(136, "2720000"), REQ as any)).toEqual({
      success: false,
      errorReason: "seq_not_increasing",
      transaction: "",
      network: NETWORK,
      payer: A,
      extensions: { x207: { epoch: 42, lastSeq: 137, lastCumulativeAmount: "2740000" } },
    });
    expect(store.get(A, B, 42)?.seq).toBe(137);
  });

  it("TC-SD-026-09 settle menjalankan ulang verify", async () => {
    const { facilitator, store } = setup();
    expect(await facilitator.settle(payload(1, "20000", "kZ"), REQ as any)).toMatchObject({
      success: false, errorReason: "invalid_signature", transaction: "",
    });
    expect(store.rows.size).toBe(0);
  });

  it("TC-SD-026-10 status registered", async () => {
    const { facilitator, store } = setup();
    await facilitator.settle(payload(), REQ as any);
    store.set({ ...store.get(A, B, 42)!, payer: A, payee: B, epoch: 42, registeredSeq: 1 });
    const again = await facilitator.settle(payload(), REQ as any);
    expect((again.extensions as any).x207.registration).toBe("registered");
  });

  it("TC-SD-026-11 status retrying bila percobaan gagal ≥ 1", async () => {
    const { facilitator, store } = setup();
    await facilitator.settle(payload(), REQ as any);
    store.set({ ...store.get(A, B, 42)!, payer: A, payee: B, epoch: 42, attempts: 1 });
    const next = await facilitator.settle(payload(2), REQ as any);
    expect(next.success).toBe(true);
    expect((next.extensions as any).x207).toMatchObject({ seq: 2, cumulativeAmount: "40000", registration: "retrying" });
  });

  it("TC-SD-026-12 hanya flow authorization", () => {
    const flows = new X207SchemeServer().paymentFlows;
    expect(Object.values(flows).flatMap((f) => f.supported)).toEqual(["authorization"]);
    expect(Object.values(flows).map((f) => f.default)).toEqual(["authorization"]);
  });

  it("settle paralel yang kalah balapan menjawab seq_not_increasing", async () => {
    const { facilitator, store } = setup();
    const original = store.save.bind(store);
    store.save = () => false; // pasangan sudah diisi settle lain di antara verify dan simpan
    const result = await facilitator.settle(payload(), REQ as any);
    store.save = original;
    expect(result).toMatchObject({ success: false, errorReason: "seq_not_increasing" });
  });
});
