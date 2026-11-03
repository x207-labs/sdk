import { describe, expect, it } from "vitest";
import { MeterRejection, MeteredJob, resolvePrice } from "@x207/scheme";

const job = (over: Partial<ConstructorParameters<typeof MeteredJob>[0]> = {}) =>
  new MeteredJob({ jobId: "job-1", unit: "job", chunkQuantity: 1, unitPrice: "$0.05", chunks: 4, ...over });

/** Works the job to the end the honest way: start, finish, then the buyer pays for the chunk. */
function runAll(j: MeteredJob, payUntil = Infinity): number[] {
  const done: number[] = [];
  for (;;) {
    const chunk = j.next();
    if (chunk === null) return done;
    j.start();
    j.complete(chunk);
    done.push(chunk);
    if (chunk <= payUntil) j.pay(j.cumulativeFor(chunk));
  }
}

describe("SD-063 staged vouchers for a long job", () => {
  it("TC-SD-063-01 a job whose vouchers keep coming runs to the end and is paid in full, one increment per chunk", () => {
    const j = job();
    expect(j.chunkAmount).toBe(50_000n);
    expect(runAll(j)).toEqual([1, 2, 3, 4]);
    expect(j.summary()).toMatchObject({ status: "complete", completedChunks: 4, paidChunks: 4, cumulativePaid: "200000", amountDue: "0", prepaid: "0", chunkAmount: "50000" });
    expect([1, 2, 3, 4].map((k) => j.cumulativeFor(k))).toEqual(["50000", "100000", "150000", "200000"]);
  });

  it("TC-SD-063-02 a job cut in the middle: the server stops when the next voucher does not come, the buyer paid only for finished chunks and the seller lost at most one chunk", () => {
    const j = job({ chunks: 6 });
    const done = runAll(j, 2); // vouchers 1 and 2 arrive, then silence
    expect(done).toEqual([1, 2, 3]); // chunk 3 is worked on credit, chunk 4 is never started
    expect(j.next()).toBeNull();
    expect(j.status()).toBe("stalled");
    expect(() => j.start()).toThrow(MeterRejection);
    const summary = j.abort();
    expect(summary).toMatchObject({ status: "aborted", startedChunks: 3, completedChunks: 3, paidChunks: 2, cumulativePaid: "100000", amountDue: "50000", prepaid: "0" });
    expect(BigInt(summary.amountDue)).toBeLessThanOrEqual(j.chunkAmount); // the seller's risk: one chunk at most
    expect(() => j.pay("150000")).toThrow(/already been stopped/);
  });

  it("TC-SD-063-03 a chunk that is not finished is not paid for and not counted: the buyer cuts during a chunk", () => {
    const j = job();
    j.start();
    j.complete(1);
    j.pay(j.cumulativeFor(1));
    j.start(); // chunk 2 in progress
    const summary = j.abort();
    expect(summary).toMatchObject({ startedChunks: 2, completedChunks: 1, paidChunks: 1, amountDue: "0", status: "aborted" });
  });

  it("TC-SD-063-04 vouchers are cumulative: a smaller one is refused, the same one is accepted again without effect, more than the whole job is refused", () => {
    const j = job();
    j.start();
    j.complete(1);
    j.pay("50000");
    expect(() => j.pay("49999")).toThrow(/cumulative_decreased/);
    expect(j.pay("50000").cumulativePaid).toBe("50000");
    expect(() => j.pay("200001")).toThrow(/overpayment/);
    expect(() => j.pay("1.5")).toThrow(MeterRejection);
    expect(() => j.pay("-1")).toThrow(MeterRejection);
    expect(j.pay("200000").paidChunks).toBe(4);
  });

  it("TC-SD-063-05 prepaying is allowed: with three chunks paid the next three start without a new voucher, and an unfinished chunk shows as prepaid", () => {
    const j = job({ chunks: 5 });
    j.pay(j.cumulativeFor(3));
    expect(runAll(j, 0)).toEqual([1, 2, 3, 4]); // chunk 4 needs unpaid <= 1: it is the first unpaid chunk, chunk 5 would be the second
    expect(j.summary()).toMatchObject({ completedChunks: 4, paidChunks: 3, amountDue: "50000", prepaid: "0" });
    const k = job({ chunks: 5 });
    k.pay(k.cumulativeFor(3));
    k.start();
    k.complete(1);
    expect(k.summary()).toMatchObject({ prepaid: "100000", amountDue: "0" });
  });

  it("TC-SD-063-06 maxUnpaidChunks widens the seller's risk on purpose: two unpaid chunks, then it stops", () => {
    const j = job({ chunks: 6, maxUnpaidChunks: 2 });
    expect(runAll(j, 0)).toEqual([1, 2]);
    expect(j.abort().amountDue).toBe("100000");
    expect(() => job({ maxUnpaidChunks: 0 })).toThrow(MeterRejection);
  });

  it("TC-SD-063-07 one chunk at a time, in order: no second start, no completion of a chunk that did not start", () => {
    const j = job();
    expect(j.start()).toBe(1);
    expect(j.next()).toBeNull(); // chunk 1 is in progress
    expect(() => j.start()).toThrow(MeterRejection);
    expect(() => j.complete(2)).toThrow(MeterRejection);
    j.complete(1);
    expect(() => j.complete(1)).toThrow(MeterRejection);
    expect(j.status()).toBe("stalled");
  });

  it("TC-SD-063-08 the price of a chunk is the metered price of SD-062 (rounded up once per chunk), and bad arguments are refused", async () => {
    const quote = { unit: "GB", quantity: "0.5", unitPrice: "$0.000003" } as const;
    const j = job({ unit: "GB", chunkQuantity: "0.5", unitPrice: "$0.000003", chunks: 10 });
    expect((await resolvePrice(() => quote, new Request("https://x.example/"))).amount).toBe(j.chunkAmount.toString());
    expect(j.chunkAmount).toBe(2n); // 1.5 rounded up to 2: ten chunks cost 20, not 15 (at most one smallest unit more per chunk)
    for (const bad of [{ chunks: 0 }, { chunks: 1.5 }, { chunkQuantity: 0 }, { chunkQuantity: "0.1234567" }, { chunkQuantity: "x" }, { unitPrice: "$0" }]) {
      expect(() => job(bad as never), JSON.stringify(bad)).toThrow();
    }
    expect(() => j.cumulativeFor(0)).toThrow(MeterRejection);
    expect(() => j.cumulativeFor(11)).toThrow(MeterRejection);
  });
});
