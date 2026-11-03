import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContractAbi, UnsignedVoucher } from "@x207/core";
import { loadConfig } from "../src/config.js";
import { PendingStore } from "../src/pending-store.js";
import {
  BACKOFF_MAX_SECONDS,
  RegistrationScheduler,
  backoffSeconds,
  type RegistrationChain,
  type SchedulerLogEntry,
} from "../src/scheduler.js";

const CIRCLE = "x207-circle.near";
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";
const SIG = "ed25519:3sX9" as const;
const EPOCH = 42;
const CUTOFF_MS = 1_000_000_000;
const KEY = { circleContract: CIRCLE, payer: A, payee: B, epoch: EPOCH };

const voucher = (payee: string, seq: number, cumulativeAmount: string): UnsignedVoucher => ({
  circle: CIRCLE, payer: A, payee, epoch: EPOCH, seq, cumulativeAmount, unit: "credit", resource: "https://x.example/api",
});

class FakeChain implements RegistrationChain {
  calls: Array<{ payee: string; seq: number; mode: string }> = [];
  failWith: Error | null = null;
  last = 0;
  epochViews = new Map<number, ContractAbi.EpochView | null>();
  constructor() {
    this.epochViews.set(EPOCH, { epoch: EPOCH, cutoff_at: String(BigInt(CUTOFF_MS) * 1_000_000n) } as ContractAbi.EpochView);
  }
  registerArgs: Array<{ payee: string; bundleId: number | undefined }> = [];
  async register(v: UnsignedVoucher, _sig: string, mode: string, bundleId?: number) {
    this.calls.push({ payee: v.payee, seq: v.seq, mode });
    this.registerArgs.push({ payee: v.payee, bundleId });
    if (this.failWith) throw this.failWith;
  }
  async lastSeq() {
    return this.last;
  }
  async getEpoch(epoch: number) {
    return this.epochViews.get(epoch) ?? null;
  }
}

const stores: PendingStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => { try { s.close(); } catch { /* sudah ditutup */ } });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function setup(options: { path?: string } = {}) {
  const clock = { now: CUTOFF_MS - 3_600_000 };
  const store = new PendingStore(options.path ?? ":memory:", () => clock.now);
  stores.push(store);
  const chain = new FakeChain();
  const logs: SchedulerLogEntry[] = [];
  const make = (s: PendingStore = store) =>
    new RegistrationScheduler({ circleContract: CIRCLE, store: s, chain, now: () => clock.now, log: (e) => logs.push(e) });
  return { clock, store, chain, logs, scheduler: make(), make };
}

const fail = (code: string) => new Error(`Smart contract panicked: ${code}: detail`);

describe("SD-028 RegistrationScheduler", () => {
  it("TC-SD-028-30 onRegistered is called once per registered row with its payer, and not for a failed one", async () => {
    const { store, chain, clock } = setup();
    const seen: Array<{ payer: string; payee: string; epoch: number }> = [];
    const scheduler = new RegistrationScheduler({ circleContract: CIRCLE, store, chain, now: () => clock.now, log: () => {}, onRegistered: (row) => seen.push(row) });
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail("ERR_INSUFFICIENT_CREDIT");
    await scheduler.tick();
    expect(seen).toEqual([]);
    chain.failWith = null;
    clock.now += 10 * 60_000;
    await scheduler.tick();
    expect(seen).toEqual([{ payer: A, payee: B, epoch: EPOCH }]);
  });

  it("TC-SD-028-01 threshold reached: one register_cumulative with the highest seq", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 10, "400000"), SIG);
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    const result = await scheduler.tick();
    expect(chain.calls).toEqual([{ payee: B, seq: 50, mode: "cumulative" }]);
    expect(result.registered).toBe(1);
    expect(store.get(KEY)).toMatchObject({ state: "registered", registeredSeq: 50, registeredCumulative: "1000000" });
  });

  it("TC-SD-028-02 below the threshold: no transaction", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 49, "999999"), SIG);
    await scheduler.tick();
    expect(chain.calls).toHaveLength(0);
    expect(store.get(KEY)?.state).toBe("pending");
  });

  it("TC-SD-028-03 flush near cutoff: 120 seconds yes, 121 seconds not yet", async () => {
    const { store, chain, clock, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 3, "60000"), SIG);
    store.upsert(CIRCLE, voucher(C, 2, "40000"), SIG);
    clock.now = CUTOFF_MS - 121_000;
    await scheduler.tick();
    expect(chain.calls).toHaveLength(0);
    clock.now = CUTOFF_MS - 120_000;
    await scheduler.tick();
    expect(chain.calls.map((c) => c.payee).sort()).toEqual([C, B]);
  });

  it("TC-SD-028-04 failure recorded: attempts, last_error, next_attempt_at, log", async () => {
    const { store, chain, clock, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = new Error("RPC timeout");
    const at = clock.now;
    await scheduler.tick();
    expect(store.get(KEY)).toMatchObject({ attempts: 1, lastError: "RPC timeout", nextAttemptAt: at + 5000, state: "retrying" });
    expect(logs[0]).toMatchObject({ event: "registration_retry", payer: A, payee: B, error: "RPC timeout", attempts: 1 });
  });

  it("TC-SD-028-05 backoff 5, 10, 20, 40, 60, 60 seconds", async () => {
    const { store, chain, clock, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = new Error("RPC down");
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      const next = store.get(KEY)!.nextAttemptAt!;
      gaps.push((next - clock.now) / 1000);
      clock.now = next;
    }
    expect(gaps).toEqual([5, 10, 20, 40, 60, 60]);
    expect(backoffSeconds(30)).toBe(BACKOFF_MAX_SECONDS);
  });

  it("does not try before next_attempt_at", async () => {
    const { store, chain, clock, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = new Error("RPC down");
    await scheduler.tick();
    clock.now += 4_999;
    await scheduler.tick();
    expect(chain.calls).toHaveLength(1);
    clock.now += 1;
    await scheduler.tick();
    expect(chain.calls).toHaveLength(2);
  });

  it("TC-SD-028-06 stops at cutoff: state failed and the risk is logged", async () => {
    const { store, chain, clock, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = new Error("RPC down");
    await scheduler.tick();
    clock.now = CUTOFF_MS;
    const result = await scheduler.tick();
    expect(chain.calls).toHaveLength(1);
    expect(result.failedAtCutoff).toBe(1);
    expect(store.get(KEY)).toMatchObject({ state: "failed", registeredCumulative: "0" });
    expect(logs.at(-1)).toMatchObject({ event: "registration_failed_until_cutoff", risk: "1000000" });
    clock.now += 60_000;
    await scheduler.tick();
    expect(chain.calls).toHaveLength(1);
  });

  it("TC-SD-028-09 a rejection stops: a successful retry resets attempts to 0", async () => {
    const { store, chain, clock, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 7, "1000000"), SIG);
    chain.failWith = new Error("RPC down");
    await scheduler.tick();
    clock.now += 5_000;
    await scheduler.tick();
    expect(store.get(KEY)?.attempts).toBe(2);
    chain.failWith = null;
    clock.now += 10_000;
    await scheduler.tick();
    expect(store.get(KEY)).toMatchObject({ registeredSeq: 7, attempts: 0, state: "registered" });
  });

  it("TC-SD-028-10 ERR_SEQ_NOT_INCREASING with last_seq >= seq counts as success without raising attempts", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail("ERR_SEQ_NOT_INCREASING");
    chain.last = 50;
    await scheduler.tick();
    expect(store.get(KEY)).toMatchObject({ registeredSeq: 50, attempts: 0, state: "registered" });
  });

  it("TC-SD-028-11 ERR_SEQ_NOT_INCREASING with last_seq < seq is retried", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail("ERR_SEQ_NOT_INCREASING");
    chain.last = 49;
    await scheduler.tick();
    expect(store.get(KEY)).toMatchObject({ registeredSeq: 0, attempts: 1, state: "retrying" });
  });

  it.each([
    ["ERR_BAD_SIGNATURE", "invalid_signature"],
    ["ERR_CUMULATIVE_DECREASED", "cumulative_decreased"],
    ["ERR_WRONG_CIRCLE", "circle_mismatch"],
    ["ERR_SELF_PAYMENT", "self_payment"],
    ["ERR_BAD_UNIT", "invalid_payload"],
  ])("TC-SD-028-12 %s is dropped with code %s", async (contractCode, specCode) => {
    const { store, chain, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail(contractCode);
    const result = await scheduler.tick();
    expect(result.dropped).toBe(1);
    expect(store.get(KEY)?.state).toBe("failed");
    expect(logs[0]).toMatchObject({ event: "registration_dropped", code: specCode });
    await scheduler.tick();
    expect(chain.calls).toHaveLength(1);
  });

  it("TC-SD-028-13 ERR_INSUFFICIENT_CREDIT is retried with the insufficient_credit log", async () => {
    const { store, chain, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail("ERR_INSUFFICIENT_CREDIT");
    await scheduler.tick();
    expect(store.get(KEY)).toMatchObject({ state: "retrying", attempts: 1 });
    expect(logs[0]).toMatchObject({ event: "registration_retry", code: "insufficient_credit" });
  });

  it.each([
    ["ERR_PAYER_NOT_ACTIVE", "member_not_active"],
    ["ERR_PAYEE_NOT_ACTIVE", "payee_not_active"],
    ["ERR_PAST_CUTOFF", "epoch_closing"],
    ["ERR_EPOCH_MISMATCH", "epoch_mismatch"],
  ])("TC-SD-028-14/15 %s is marked failed with code %s", async (contractCode, specCode) => {
    const { store, chain, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail(contractCode);
    await scheduler.tick();
    expect(store.get(KEY)?.state).toBe("failed");
    expect(logs[0]).toMatchObject({ code: specCode });
  });

  it("TC-SD-028-16 a new voucher during retry: the next attempt sends the latest seq", async () => {
    const { store, chain, clock, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 10, "1000000"), SIG);
    chain.failWith = new Error("RPC down");
    await scheduler.tick();
    store.upsert(CIRCLE, voucher(B, 11, "1020000"), SIG);
    chain.failWith = null;
    clock.now += 5_000;
    await scheduler.tick();
    expect(chain.calls.map((c) => c.seq)).toEqual([10, 11]);
    expect(store.get(KEY)).toMatchObject({ registeredSeq: 11, state: "registered" });
  });

  it("an old registration finishes when a newer seq arrives: the row stays pending for the new seq", () => {
    const { store } = setup();
    store.upsert(CIRCLE, voucher(B, 10, "1000000"), SIG);
    store.upsert(CIRCLE, voucher(B, 11, "1020000"), SIG);
    store.recordRegistered(KEY, 10, "1000000");
    expect(store.get(KEY)).toMatchObject({ registeredSeq: 10, state: "pending", seq: 11 });
  });

  it("TC-SD-028-17 restart during retry: continues at next_attempt_at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x207-sched-"));
    dirs.push(dir);
    const path = join(dir, "pending.sqlite");
    const first = setup({ path });
    first.store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    first.chain.failWith = new Error("RPC down");
    await first.scheduler.tick();
    const next = first.store.get(KEY)!.nextAttemptAt!;
    first.store.close();

    const reopened = new PendingStore(path, () => first.clock.now);
    stores.push(reopened);
    const again = first.make(reopened);
    first.chain.failWith = null;
    await again.tick();
    expect(first.chain.calls).toHaveLength(1);
    first.clock.now = next;
    await again.tick();
    expect(first.chain.calls).toHaveLength(2);
    expect(reopened.get(KEY)?.state).toBe("registered");
  });

  it("TC-SD-028-18 the default mode uses register_cumulative", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    await scheduler.tick();
    expect(chain.calls[0]?.mode).toBe("cumulative");
    const config = loadConfig({ X207_CIRCLES: `agents-main=${CIRCLE}` });
    expect(config.registerMode).toBe("cumulative");
    expect(() => loadConfig({ X207_CIRCLES: `agents-main=${CIRCLE}`, X207_REGISTER_MODE: "per_request" })).toThrow(/needs X207_RELAYER_ACCOUNT_ID/);
    expect(() => loadConfig({ X207_CIRCLES: `agents-main=${CIRCLE}`, X207_REGISTER_MODE: "nope" })).toThrow(/X207_REGISTER_MODE/);
  });

  it("an overlapping round is skipped", async () => {
    const { store, chain, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    let release!: () => void;
    chain.register = (v) => new Promise<void>((resolve) => { chain.calls.push({ payee: v.payee, seq: v.seq, mode: "cumulative" }); release = resolve; });
    const first = scheduler.tick();
    await Promise.resolve();
    const second = await scheduler.tick();
    expect(second).toEqual({ registered: 0, retrying: 0, dropped: 0, failedAtCutoff: 0 });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
    expect(chain.calls).toHaveLength(1);
  });
});

describe("SD-054 pemetaan ERR_EXITING", () => {
  it("TC-SD-054-11 registration rejected with ERR_EXITING: logged as member_exiting and the row state is failed", async () => {
    const { store, chain, logs, scheduler } = setup();
    store.upsert(CIRCLE, voucher(B, 50, "1000000"), SIG);
    chain.failWith = fail("ERR_EXITING");
    await scheduler.tick();
    expect(store.get(KEY)?.state).toBe("failed");
    expect(logs[0]).toMatchObject({ event: "registration_dropped", code: "member_exiting" });
  });
});

describe("SD-048 registrasi voucher leg bundle", () => {
  it("TC-SD-048-09 a row with bundle_id is registered through bundleId; ERR_BUNDLE_LEG_EXCEEDED drops the row", async () => {
    const { store, chain, scheduler } = setup();
    chain.registerArgs = [];
    store.upsert(CIRCLE, voucher(B, 1, "20000000"), SIG, 7);
    store.upsert(CIRCLE, voucher(C, 1, "20000000"), SIG);
    const first = await scheduler.tick();
    expect(first).toMatchObject({ registered: 2, dropped: 0 });
    expect(chain.registerArgs.sort((a, b) => a.payee.localeCompare(b.payee))).toEqual([
      { payee: C, bundleId: undefined },
      { payee: B, bundleId: 7 },
    ]);

    chain.failWith = new Error("Smart contract panicked: ERR_BUNDLE_LEG_EXCEEDED: leg 100 registered 90 delta 20");
    store.upsert(CIRCLE, voucher(B, 2, "40000000"), SIG, 7);
    const second = await scheduler.tick();
    expect(second).toMatchObject({ dropped: 1 });
    expect(store.get({ ...KEY, payee: B })?.state).toBe("failed");
  });
});
