import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, verifyVoucher } from "@x207/core";
import { BuyerJob, JOB_ESCROW_COUNTER_LEG, JobBudget, MeterRejection, SellerJob } from "@x207/scheme";

const CIRCLE = "x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const SELLER = "seller.x207-circle.near";
const keys = generateVoucherKeypair();
// 6 chunks of 10 minutes at 0.01 credit per minute: 100000 per chunk, 600000 for the job
const budget = (over: Record<string, unknown> = {}) =>
  new JobBudget({ jobId: "j1", unit: "minute", chunkQuantity: 10, unitPrice: "$0.01", chunks: 6, circle: CIRCLE, buyer: BUYER, seller: SELLER, epoch: 42, ...over });
const fails = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof MeterRejection ? e.message : `other: ${String(e)}`;
  }
};

/** Runs the job: the buyer signs, the seller accepts and works. `buyerStopsAfter` / `sellerStopsAfter` count chunks. */
function run(b: JobBudget, stop: { buyerStopsAfter?: number; sellerStopsAfter?: number } = {}) {
  const buyer = new BuyerJob(b);
  const seller = new SellerJob(b);
  const sellerWork: number[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const payChunk = buyer.nextChunk();
    if (payChunk !== null && payChunk <= (stop.buyerStopsAfter ?? Infinity)) {
      const { voucher } = buyer.signNext(keys.secretKey);
      seller.accept(voucher);
    }
    const chunk = seller.next();
    if (chunk === null) break;
    seller.start();
    if (chunk > (stop.sellerStopsAfter ?? Infinity)) break; // the seller disappears with the chunk unfinished: nothing is delivered
    seller.complete(chunk);
    sellerWork.push(chunk);
    buyer.confirm(chunk);
  }
  return { buyer, seller, sellerWork };
}

describe("SD-067 escrow of job credit with a bundle", () => {
  it("TC-SD-067-01 the budget is the price of all chunks; the terms have two legs: buyer to seller for the budget, and the counter leg of one smallest unit", () => {
    const b = budget();
    expect(b.chunkAmount).toBe(100000n);
    expect(b.budget).toBe(600000n);
    expect(b.terms()).toEqual({
      circle: CIRCLE, epoch: 42,
      legs: [{ payer: BUYER, payee: SELLER, max_amount: "600000" }, { payer: SELLER, payee: BUYER, max_amount: JOB_ESCROW_COUNTER_LEG }],
    });
    expect(b.commitArgs()).toEqual({ epoch: 42, legs: b.terms().legs });
    expect(b.termsHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(budget({ jobId: "other" }).termsHash()).toBe(b.termsHash()); // the terms do not depend on the job id: same parties, epoch and amount
    expect(budget({ chunks: 7 }).termsHash()).not.toBe(b.termsHash());
    expect(b.bundleId).toBeNull();
    b.attach(9);
    expect(b.bundleId).toBe(9);
    expect(fails(() => b.attach(0))).toMatch(/bundleId/);
  });

  it("TC-SD-067-02 invalid parties, epoch and chunks are refused", () => {
    expect(fails(() => budget({ buyer: SELLER }))).toMatch(/berbeda/);
    expect(fails(() => budget({ epoch: 0 }))).toMatch(/epoch/);
    expect(fails(() => budget({ chunks: 0 }))).toMatch(/chunks/);
    expect(fails(() => budget({ unitPrice: "abc" }))).toMatch(/harga|price|tidak sah/);
  });

  it("TC-SD-067-03 a job that runs to the end pays the whole budget in six steps, and the seller never works a chunk that is not paid", () => {
    const { buyer, seller, sellerWork } = run(budget());
    expect(sellerWork).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seller.summary()).toMatchObject({ status: "complete", paidChunks: 6, cumulativePaid: "600000", unpaidWork: "0" });
    expect(buyer.summary()).toMatchObject({ status: "complete", confirmedChunks: 6, cumulativeSigned: "600000", atRisk: "0" });
  });

  it("TC-SD-067-04 the buyer stops paying after chunk 3: the seller worked three chunks, was paid three, and cannot start the fourth", () => {
    const { seller, sellerWork } = run(budget(), { buyerStopsAfter: 3 });
    expect(sellerWork).toEqual([1, 2, 3]);
    expect(seller.summary()).toMatchObject({ status: "waiting", completedChunks: 3, paidChunks: 3, cumulativePaid: "300000", unpaidWork: "0" });
    expect(seller.next()).toBeNull();
    expect(fails(() => seller.start())).toMatch(/belum dibayar/);
  });

  it("TC-SD-067-05 the seller stops in the middle of chunk 4: the buyer paid for four chunks, got three, and loses one chunk at most; it signs nothing more", () => {
    const { buyer, seller, sellerWork } = run(budget(), { sellerStopsAfter: 3 });
    expect(sellerWork).toEqual([1, 2, 3]);
    const s = buyer.summary();
    expect(s).toMatchObject({ status: "waiting_delivery", confirmedChunks: 3, signedChunks: 4, cumulativeSigned: "400000", atRisk: "100000" });
    expect(buyer.nextVoucherAmount()).toBeNull();
    expect(fails(() => buyer.signNext(keys.secretKey))).toMatch(/setelah potongan sebelumnya diterima/);
    expect(seller.summary()).toMatchObject({ status: "running", completedChunks: 3 });
    expect(buyer.abort().status).toBe("aborted");
  });

  it("TC-SD-067-06 the buyer cannot be made to pay two chunks ahead, and the seller refuses a voucher more than one chunk ahead", () => {
    const b = budget();
    const buyer = new BuyerJob(b);
    const first = buyer.signNext(keys.secretKey);
    expect(first.voucher.cumulativeAmount).toBe("100000");
    expect(buyer.nextVoucherAmount()).toBeNull(); // waiting for chunk 1
    expect(fails(() => buyer.confirm(2))).toMatch(/tidak sedang ditunggu/);
    const seller = new SellerJob(b);
    seller.accept(first.voucher);
    const ahead = { ...first.voucher, seq: 2, cumulativeAmount: "200000" };
    expect(fails(() => seller.accept(ahead))).toMatch(/prepaid_too_far/);
    seller.start();
    seller.complete(1);
    expect(seller.accept(ahead).paidChunks).toBe(2);
  });

  it("TC-SD-067-07 the seller refuses a voucher for another pair, another epoch, a lower amount, a repeated seq or an amount above the budget; the same amount again is a no-op", () => {
    const b = budget();
    const seller = new SellerJob(b);
    const v = new BuyerJob(b).signNext(keys.secretKey).voucher;
    expect(fails(() => seller.accept({ ...v, payer: "x.x207-circle.near" }))).toMatch(/wrong_leg/);
    expect(fails(() => seller.accept({ ...v, payee: "y.x207-circle.near" }))).toMatch(/wrong_leg/);
    expect(fails(() => seller.accept({ ...v, epoch: 43 }))).toMatch(/wrong_leg/);
    expect(fails(() => seller.accept({ ...v, circle: "other.near" }))).toMatch(/wrong_leg/);
    expect(fails(() => seller.accept({ ...v, cumulativeAmount: "01" }))).toMatch(/bilangan bulat desimal/);
    expect(fails(() => seller.accept({ ...v, cumulativeAmount: "700000" }))).toMatch(/over_budget/);
    seller.accept(v);
    expect(seller.accept(v).cumulativePaid).toBe("100000"); // repeated: no effect
    expect(fails(() => seller.accept({ ...v, seq: 1, cumulativeAmount: "100001" }))).toMatch(/seq_not_increasing/);
    seller.start();
    seller.complete(1);
    seller.accept({ ...v, seq: 2, cumulativeAmount: "200000" });
    expect(fails(() => seller.accept({ ...v, seq: 3, cumulativeAmount: "100000" }))).toMatch(/cumulative_decreased/);
    expect(seller.abort().status).toBe("aborted");
    expect(fails(() => seller.accept({ ...v, seq: 4, cumulativeAmount: "300000" }))).toMatch(/dihentikan/);
  });

  it("TC-SD-067-08 the voucher of a chunk is a normal voucher: signed by the buyer key, cumulative, seq per chunk, unit credit, resource names the job; bundleId travels with it", () => {
    const b = budget();
    b.attach(5);
    const buyer = new BuyerJob(b);
    const signed = buyer.signNext(keys.secretKey);
    expect(signed.bundleId).toBe(5);
    expect(signed.voucher).toMatchObject({ circle: CIRCLE, payer: BUYER, payee: SELLER, epoch: 42, seq: 1, cumulativeAmount: "100000", unit: "credit", resource: "job:j1" });
    expect(verifyVoucher(signed.voucher, keys.publicKey)).toBe(true);
    expect(b.voucherFor(3)).toMatchObject({ seq: 3, cumulativeAmount: "300000" });
    expect(fails(() => b.voucherFor(7))).toMatch(/potongan harus 1 sampai 6/);
  });

  it("TC-SD-067-09 the voucher of a pair is cumulative for the pair: a job that starts after other payments continues from the state of the pair, and a voucher that restarts at zero is refused", () => {
    const b = budget({ baseCumulative: "250000", baseSeq: 7 });
    expect(b.voucherFor(1)).toMatchObject({ seq: 8, cumulativeAmount: "350000" });
    expect(b.voucherFor(6)).toMatchObject({ seq: 13, cumulativeAmount: "850000" });
    const { buyer, seller, sellerWork } = run(b);
    expect(sellerWork).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seller.summary()).toMatchObject({ status: "complete", paidChunks: 6, cumulativePaid: "600000", unpaidWork: "0" });
    expect(buyer.summary()).toMatchObject({ cumulativeSigned: "600000", atRisk: "0" });
    // the budget of the leg is the job, not the pair: above base + budget is refused
    const s2 = new SellerJob(b);
    const v = new BuyerJob(b).signNext(keys.secretKey).voucher;
    expect(fails(() => s2.accept({ ...v, cumulativeAmount: "850001" }))).toMatch(/over_budget/);
    expect(fails(() => s2.accept({ ...v, seq: 8, cumulativeAmount: "100000" }))).toMatch(/cumulative_decreased/);
    expect(fails(() => budget({ baseCumulative: "-1" }))).toMatch(/baseCumulative/);
    expect(fails(() => budget({ baseSeq: -1 }))).toMatch(/baseSeq/);
  });

  it("TC-SD-067-10 [F7] a voucher of the same pair for another resource is not the payment of a chunk of this job", () => {
    const b = budget();
    const seller = new SellerJob(b);
    const v = new BuyerJob(b).signNext(keys.secretKey).voucher;
    expect(fails(() => seller.accept({ ...v, resource: "x207:grant:7" }))).toMatch(/wrong_resource/);
    expect(fails(() => seller.accept({ ...v, resource: "job:other" }))).toMatch(/wrong_resource/);
    expect(seller.accept(v).paidChunks).toBe(1);
  });
});
