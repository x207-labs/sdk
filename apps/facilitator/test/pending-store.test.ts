import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UnsignedVoucher } from "@x207/core";
import { PendingStore } from "../src/pending-store.js";

const CIRCLE = "x207-circle.near";
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";
const SIG = "ed25519:3sX9" as const;

const v = (payer: string, payee: string, epoch: number, seq: number, cum = String(seq * 20000)): UnsignedVoucher => ({
  circle: CIRCLE, payer, payee, epoch, seq, cumulativeAmount: cum, unit: "credit",
  resource: "https://summarizer.example/api/summarize",
});
const key = (payer: string, payee: string, epoch: number) => ({ circleContract: CIRCLE, payer, payee, epoch });

const stores: PendingStore[] = [];
const dirs: string[] = [];
const memory = (now = () => 1000) => {
  const store = new PendingStore(":memory:", now);
  stores.push(store);
  return store;
};
afterEach(() => {
  stores.splice(0).forEach((s) => { try { s.close(); } catch { /* sudah ditutup */ } });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("SD-022 PendingStore", () => {
  it("TC-SD-022-01 hanya seq tertinggi", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 5), SIG);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    const rows = store.listByPayer(CIRCLE, A, 42);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 7, cumulativeAmount: "140000" });
  });

  it("TC-SD-022-02 seq lebih rendah diabaikan, updated_at tetap", () => {
    let t = 1000;
    const store = memory(() => t);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    t = 2000;
    expect(store.upsert(CIRCLE, v(A, B, 42, 6), SIG)).toBe(false);
    expect(store.get(key(A, B, 42))).toMatchObject({ seq: 7, updatedAt: 1000 });
  });

  it("TC-SD-022-03 seq sama tidak mengubah apa pun", () => {
    let t = 1000;
    const store = memory(() => t);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    t = 2000;
    expect(store.upsert(CIRCLE, v(A, B, 42, 7, "999"), "ed25519:other"), "tidak berubah").toBe(false);
    expect(store.get(key(A, B, 42))).toMatchObject({ cumulativeAmount: "140000", signature: SIG, updatedAt: 1000 });
  });

  it("TC-SD-022-04 persisten antar restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "x207-pending-"));
    dirs.push(dir);
    const file = join(dir, "pending.sqlite");
    const first = new PendingStore(file, () => 1234);
    first.upsert(CIRCLE, v(A, B, 42, 9), SIG);
    first.recordFailure(key(A, B, 42), "rpc timeout", 9999);
    const before = first.get(key(A, B, 42));
    first.close();

    const second = new PendingStore(file);
    stores.push(second);
    const after = second.get(key(A, B, 42));
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      voucher: v(A, B, 42, 9), signature: SIG, registeredSeq: 0, attempts: 1,
      nextAttemptAt: 9999, lastError: "rpc timeout",
    });
  });

  it("TC-SD-022-05 kunci utama (payer, payee, epoch)", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, C, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, B, 43, 1), SIG);
    expect(store.listByPayer(CIRCLE, A, 42)).toHaveLength(2);
    expect(store.listByPayer(CIRCLE, A, 43)).toHaveLength(1);
  });

  it("TC-SD-022-06 catatan percobaan lalu sukses", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 3), SIG);
    store.recordFailure(key(A, B, 42), "ERR_X");
    expect(store.get(key(A, B, 42))).toMatchObject({ attempts: 1, state: "retrying", lastError: "ERR_X" });
    store.recordFailure(key(A, B, 42), "ERR_Y");
    expect(store.get(key(A, B, 42))).toMatchObject({ attempts: 2, lastError: "ERR_Y" });
    store.recordRegistered(key(A, B, 42), 3, "60000");
    const row = store.get(key(A, B, 42))!;
    expect(row).toMatchObject({ registeredSeq: 3, registeredCumulative: "60000", state: "registered", attempts: 0 });
    expect(row.registeredSeq).toBe(row.seq);
  });

  it("TC-SD-022-07 query per payer dan epoch", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, C, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, B, 41, 1), SIG);
    const rows = store.listByPayer(CIRCLE, A, 42);
    expect(rows.map((r) => [r.payee, r.epoch])).toEqual([[C, 42], [B, 42]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
  });

  it("TC-SD-022-08 tulis berurutan seq 8 lalu 9 (atau terbalik) berakhir seq 9", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 9), SIG);
    store.upsert(CIRCLE, v(A, B, 42, 8), SIG);
    expect(store.get(key(A, B, 42))?.seq).toBe(9);
    const other = memory();
    other.upsert(CIRCLE, v(A, B, 42, 8), SIG);
    other.upsert(CIRCLE, v(A, B, 42, 9), SIG);
    expect(other.get(key(A, B, 42))?.seq).toBe(9);
  });

  it("TC-SD-022-10 jumlah U128 di atas 2^64 tersimpan tepat", () => {
    const store = memory();
    const big = "18446744073709551617";
    store.upsert(CIRCLE, v(A, B, 42, 1, big), SIG);
    const row = store.get(key(A, B, 42))!;
    expect(row.cumulativeAmount).toBe(big);
    expect(BigInt(row.cumulativeAmount) > 2n ** 64n).toBe(true);
    store.upsert(CIRCLE, v(A, B, 42, 2, "340282366920938463463374607431768211455"), SIG);
    expect(store.get(key(A, B, 42))?.cumulativeAmount).toBe("340282366920938463463374607431768211455");
  });

  it("baris baru setelah gagal tetap retrying dan menyimpan registered_*", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.recordRegistered(key(A, B, 42), 1, "20000");
    store.upsert(CIRCLE, v(A, B, 42, 2), SIG);
    expect(store.get(key(A, B, 42))).toMatchObject({ seq: 2, registeredSeq: 1, registeredCumulative: "20000", state: "pending" });
    store.recordFailure(key(A, B, 42), "e");
    store.upsert(CIRCLE, v(A, B, 42, 3), SIG);
    expect(store.get(key(A, B, 42))?.state).toBe("retrying");
    store.markFailed(key(A, B, 42), "sampai cutoff");
    expect(store.get(key(A, B, 42))).toMatchObject({ state: "failed", lastError: "sampai cutoff" });
  });
});
