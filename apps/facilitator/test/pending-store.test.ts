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
  stores.splice(0).forEach((s) => { try { s.close(); } catch { /* already closed */ } });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe("SD-022 PendingStore", () => {
  it("TC-SD-022-01 only the highest seq", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 5), SIG);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    const rows = store.listByPayer(CIRCLE, A, 42);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 7, cumulativeAmount: "140000" });
  });

  it("TC-SD-022-02 a lower seq is ignored, updated_at stays", () => {
    let t = 1000;
    const store = memory(() => t);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    t = 2000;
    expect(store.upsert(CIRCLE, v(A, B, 42, 6), SIG)).toBe(false);
    expect(store.get(key(A, B, 42))).toMatchObject({ seq: 7, updatedAt: 1000 });
  });

  it("TC-SD-022-03 the same seq changes nothing", () => {
    let t = 1000;
    const store = memory(() => t);
    store.upsert(CIRCLE, v(A, B, 42, 7), SIG);
    t = 2000;
    expect(store.upsert(CIRCLE, v(A, B, 42, 7, "999"), "ed25519:other"), "unchanged").toBe(false);
    expect(store.get(key(A, B, 42))).toMatchObject({ cumulativeAmount: "140000", signature: SIG, updatedAt: 1000 });
  });

  it("TC-SD-022-04 persistent across restarts", () => {
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

  it("TC-SD-022-05 primary key (payer, payee, epoch)", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, C, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, B, 43, 1), SIG);
    expect(store.listByPayer(CIRCLE, A, 42)).toHaveLength(2);
    expect(store.listByPayer(CIRCLE, A, 43)).toHaveLength(1);
  });

  it("TC-SD-022-06 attempt record, then success", () => {
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

  it("TC-SD-022-07 query by payer and epoch", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, C, 42, 1), SIG);
    store.upsert(CIRCLE, v(A, B, 41, 1), SIG);
    const rows = store.listByPayer(CIRCLE, A, 42);
    expect(rows.map((r) => [r.payee, r.epoch])).toEqual([[C, 42], [B, 42]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
  });

  it("TC-SD-022-08 writing seq 8 then 9 (or reversed) ends at seq 9", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 9), SIG);
    store.upsert(CIRCLE, v(A, B, 42, 8), SIG);
    expect(store.get(key(A, B, 42))?.seq).toBe(9);
    const other = memory();
    other.upsert(CIRCLE, v(A, B, 42, 8), SIG);
    other.upsert(CIRCLE, v(A, B, 42, 9), SIG);
    expect(other.get(key(A, B, 42))?.seq).toBe(9);
  });

  it("TC-SD-022-10 a U128 amount above 2^64 is stored exactly", () => {
    const store = memory();
    const big = "18446744073709551617";
    store.upsert(CIRCLE, v(A, B, 42, 1, big), SIG);
    const row = store.get(key(A, B, 42))!;
    expect(row.cumulativeAmount).toBe(big);
    expect(BigInt(row.cumulativeAmount) > 2n ** 64n).toBe(true);
    store.upsert(CIRCLE, v(A, B, 42, 2, "340282366920938463463374607431768211455"), SIG);
    expect(store.get(key(A, B, 42))?.cumulativeAmount).toBe("340282366920938463463374607431768211455");
  });

  it("a new row after a failure stays retrying and keeps registered_*", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    store.recordRegistered(key(A, B, 42), 1, "20000");
    store.upsert(CIRCLE, v(A, B, 42, 2), SIG);
    expect(store.get(key(A, B, 42))).toMatchObject({ seq: 2, registeredSeq: 1, registeredCumulative: "20000", state: "pending" });
    store.recordFailure(key(A, B, 42), "e");
    store.upsert(CIRCLE, v(A, B, 42, 3), SIG);
    expect(store.get(key(A, B, 42))?.state).toBe("retrying");
    store.markFailed(key(A, B, 42), "until cutoff");
    expect(store.get(key(A, B, 42))).toMatchObject({ state: "failed", lastError: "until cutoff" });
  });
});

describe("SD-048 bundle_id column", () => {
  it("TC-SD-048-10 bundle_id is stored, rises with seq, and is null for a normal voucher", () => {
    const store = memory();
    store.upsert(CIRCLE, v(A, B, 42, 1), SIG, 7);
    store.upsert(CIRCLE, v(A, C, 42, 1), SIG);
    expect(store.get(key(A, B, 42))?.bundleId).toBe(7);
    expect(store.get(key(A, C, 42))?.bundleId).toBeNull();
    store.upsert(CIRCLE, v(A, B, 42, 2), SIG, 7);
    // ordered by payee: scraper (C) before summarizer (B)
    expect(store.listByPayer(CIRCLE, A, 42).map((r) => r.bundleId)).toEqual([null, 7]);
  });

  it("TC-SD-048-11 an old database without the bundle_id column is migrated when opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "x207-pending-"));
    dirs.push(dir);
    const path = join(dir, "pending.sqlite");
    const first = new PendingStore(path, () => 1000);
    first.upsert(CIRCLE, v(A, B, 42, 1), SIG);
    first.close();
    // simulate the old schema: drop the column then open again
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("ALTER TABLE pending_vouchers DROP COLUMN bundle_id");
    raw.close();
    const reopened = new PendingStore(path, () => 1000);
    stores.push(reopened);
    expect(reopened.get(key(A, B, 42))?.bundleId).toBeNull();
    reopened.upsert(CIRCLE, v(A, B, 42, 2), SIG, 9);
    expect(reopened.get(key(A, B, 42))?.bundleId).toBe(9);
  });
});
