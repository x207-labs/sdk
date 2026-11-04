// Credit escrow for P5 jobs without changing the contract (SD-067, ADR-43). The job budget (price of all chunks) is locked as an F5 bundle leg: buyer to seller with `max_amount` =
// the budget. `commit_bundle` reserves the buyer's headroom for that budget in the current epoch, so each chunk voucher can be registered through `register_in_bundle`
// (facilitator, SD-048) even when the buyer's free headroom is used up by bundles or other vouchers. The voucher is cumulative (ADR-17): chunk k is settled by a voucher of `k × chunk price`.
//
// The contract requires a bundle to have at least TWO legs (`ERR_BAD_BUNDLE`), so the terms carry a companion leg from seller to buyer of one smallest unit
// (`JOB_ESCROW_COUNTER_LEG`): it is never registered, it only satisfies the bundle shape, and the seller who signs the bundle already takes part as a member.
//
// Risk rules (pay one chunk ahead):
//   - the seller works on chunk k only after the voucher for chunk k arrives (`SellerJob.next()`), so the seller never works unpaid: a buyer who stops does not
//     hurt the seller at all;
//   - the buyer signs the voucher for chunk k+1 only after chunk k is received (`BuyerJob.nextVoucherAmount()`), so a buyer abandoned by the seller loses at most
//     one chunk (paid for and not delivered);
//   - the total that can be paid never exceeds the budget (the bundle reserve).
// The cumulative voucher belongs to the (buyer, seller) pair in the epoch, not to the job: `baseCumulative` and `baseSeq` are the pair's state when the job starts, and while the job runs
// other payments of that pair wait.
// This class is only a state machine: no network and no time. Verifying and settling vouchers remains the job of `/verify` and `/settle`.
import { CREDIT_UNIT, bundleInput, signVoucher, termsHash, type AccountId, type BundleTerms, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";
import { MeteredJob, type MeteredJobOptions } from "./metered-job.js";
import { MeterRejection } from "./metering.js";

/** Companion leg from seller to buyer: the smallest unit, because the contract demands a bundle with two legs and `max_amount` > 0. */
export const JOB_ESCROW_COUNTER_LEG = "1";

export type JobEscrowOptions = Omit<MeteredJobOptions, "maxUnpaidChunks"> & {
  circle: AccountId;
  buyer: AccountId;
  seller: AccountId;
  /** The epoch running when the bundle is committed; the budget is locked for this epoch only, so the job must finish within it. */
  epoch: number;
  /**
   * State of the (buyer, seller) pair in this epoch when the job starts: the cumulative amount and last `seq` already registered (0 if there is no voucher yet). The cumulative voucher
   * belongs to the PAIR, not the job, so chunk vouchers must continue it; while the job runs other payments of that pair wait.
   */
  baseCumulative?: U128String;
  baseSeq?: number;
};

/** Numbers and terms shared by buyer and seller. */
export class JobBudget {
  readonly jobId: string;
  readonly circle: AccountId;
  readonly buyer: AccountId;
  readonly seller: AccountId;
  readonly epoch: number;
  readonly unit: string;
  readonly chunks: number;
  readonly chunkAmount: bigint;
  /** Price of the whole job = the buyer leg's `max_amount`, in the smallest credit unit. */
  readonly budget: bigint;
  readonly baseCumulative: bigint;
  readonly baseSeq: number;
  #bundleId: number | null = null;

  constructor(options: JobEscrowOptions) {
    if (options.buyer === options.seller) throw new MeterRejection("buyer and seller must be different accounts");
    if (!Number.isSafeInteger(options.epoch) || options.epoch < 1) throw new MeterRejection(`epoch must be an integer >= 1, got ${options.epoch}`);
    const math = new MeteredJob(options); // validates chunks, quantity and price once, and gives the price of one chunk
    this.jobId = options.jobId;
    this.circle = options.circle;
    this.buyer = options.buyer;
    this.seller = options.seller;
    this.epoch = options.epoch;
    this.unit = options.unit;
    this.chunks = math.totalChunks;
    this.chunkAmount = math.chunkAmount;
    this.budget = math.chunkAmount * BigInt(math.totalChunks);
    const base = options.baseCumulative ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(base)) throw new MeterRejection(`baseCumulative must be a decimal integer, got ${JSON.stringify(base)}`);
    this.baseCumulative = BigInt(base);
    this.baseSeq = options.baseSeq ?? 0;
    if (!Number.isSafeInteger(this.baseSeq) || this.baseSeq < 0) throw new MeterRejection(`baseSeq must be an integer >= 0, got ${this.baseSeq}`);
  }

  /** Bundle terms signed by buyer and seller: buyer to seller leg for the budget, plus the companion leg. */
  terms(): BundleTerms {
    return {
      circle: this.circle,
      epoch: this.epoch,
      legs: [
        { payer: this.buyer, payee: this.seller, max_amount: this.budget.toString() },
        { payer: this.seller, payee: this.buyer, max_amount: JOB_ESCROW_COUNTER_LEG },
      ],
    };
  }

  /** Argument `bundle` for `commit_bundle`. */
  commitArgs(): ReturnType<typeof bundleInput> {
    return bundleInput(this.terms());
  }

  termsHash(): string {
    return termsHash(this.terms());
  }

  /** Called after `commit_bundle` returns `bundle_id`; chunk vouchers then carry this `bundleId`. */
  attach(bundleId: number): void {
    if (!Number.isSafeInteger(bundleId) || bundleId < 1) throw new MeterRejection(`bundleId must be an integer >= 1, got ${bundleId}`);
    this.#bundleId = bundleId;
  }

  get bundleId(): number | null {
    return this.#bundleId;
  }

  /** Cumulative voucher amount of the pair that settles chunk number `chunk` (1 to total): the pair's starting state + `chunk × chunk price`. */
  cumulativeFor(chunk: number): bigint {
    if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > this.chunks) throw new MeterRejection(`chunk must be 1 to ${this.chunks}, got ${chunk}`);
    return this.baseCumulative + this.chunkAmount * BigInt(chunk);
  }

  /** Unsigned voucher for chunk `chunk`; `seq` rises by one per chunk. */
  voucherFor(chunk: number): UnsignedVoucher {
    return {
      circle: this.circle, payer: this.buyer, payee: this.seller, epoch: this.epoch, seq: this.baseSeq + chunk,
      cumulativeAmount: this.cumulativeFor(chunk).toString(), unit: CREDIT_UNIT, resource: `job:${this.jobId}`,
    };
  }
}

export type SellerJobSummary = {
  jobId: string;
  status: "waiting" | "running" | "complete" | "aborted";
  startedChunks: number;
  completedChunks: number;
  paidChunks: number;
  /** What has been paid for this job (the pair's cumulative minus its starting state). */
  cumulativePaid: string;
  /** What the seller has worked on without being paid: always 0, because a chunk starts only after it is paid. */
  unpaidWork: string;
};

/** Seller side: a new chunk starts only after the voucher for that chunk arrives. */
export class SellerJob {
  readonly budget: JobBudget;
  #started = 0;
  #completed = 0;
  #cumulative: bigint;
  #seq: number;
  #aborted = false;

  constructor(budget: JobBudget) {
    this.budget = budget;
    this.#cumulative = budget.baseCumulative;
    this.#seq = budget.baseSeq;
  }

  get paidChunks(): number {
    const paid = (this.#cumulative - this.budget.baseCumulative) / this.budget.chunkAmount;
    return Number(paid > BigInt(this.budget.chunks) ? BigInt(this.budget.chunks) : paid);
  }

  /**
   * Accept a voucher (one that passed `/verify`): pair, epoch, and unit must equal the job's, `seq` rises, the cumulative amount does not fall (`cumulative_decreased`),
   * does not exceed the budget (`over_budget`), and is not more than one chunk ahead of the completed chunk (`prepaid_too_far`). The same amount is accepted with no effect.
   */
  accept(voucher: Pick<Voucher, "circle" | "payer" | "payee" | "epoch" | "seq" | "cumulativeAmount" | "unit" | "resource">): SellerJobSummary {
    const b = this.budget;
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (voucher.circle !== b.circle || voucher.payer !== b.buyer || voucher.payee !== b.seller || voucher.epoch !== b.epoch || voucher.unit !== CREDIT_UNIT) {
      throw new MeterRejection("wrong_leg: voucher is not for the buyer to seller leg in this job's epoch");
    }
    // F7 (review BE-062): a voucher of the same pair for another purpose is not the payment of a chunk of this job
    if (voucher.resource !== `job:${b.jobId}`) throw new MeterRejection(`wrong_resource: voucher resource must be job:${b.jobId}, got ${JSON.stringify(voucher.resource)}`);
    if (!/^(0|[1-9]\d*)$/.test(voucher.cumulativeAmount)) throw new MeterRejection(`cumulativeAmount must be a decimal integer, got ${JSON.stringify(voucher.cumulativeAmount)}`);
    const amount = BigInt(voucher.cumulativeAmount);
    if (amount < this.#cumulative) throw new MeterRejection("cumulative_decreased: voucher is smaller than what was already received");
    if (amount > b.baseCumulative + b.budget) throw new MeterRejection("over_budget: voucher is above the locked budget");
    if (amount === this.#cumulative) return this.summary();
    if (voucher.seq <= this.#seq) throw new MeterRejection("seq_not_increasing: voucher seq must increase");
    if (amount > b.baseCumulative + b.chunkAmount * BigInt(this.#completed + 1)) throw new MeterRejection("prepaid_too_far: voucher pays more than one chunk ahead");
    this.#cumulative = amount;
    this.#seq = voucher.seq;
    return this.summary();
  }

  /** Number of the chunk that may be worked on now: only if the voucher for that chunk has arrived and the previous chunk is finished; otherwise `null`. */
  next(): number | null {
    if (this.#aborted || this.#started >= this.budget.chunks || this.#started > this.#completed) return null;
    return this.paidChunks >= this.#started + 1 ? this.#started + 1 : null;
  }

  start(): number {
    const chunk = this.next();
    if (chunk === null) throw new MeterRejection("the next chunk is not paid yet or the job is not running");
    this.#started = chunk;
    return chunk;
  }

  complete(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (chunk !== this.#started || this.#completed >= this.#started) throw new MeterRejection(`chunk ${chunk} is not being worked on`);
    this.#completed = chunk;
  }

  abort(): SellerJobSummary {
    this.#aborted = true;
    return this.summary();
  }

  summary(): SellerJobSummary {
    const status = this.#aborted ? "aborted" : this.#completed >= this.budget.chunks ? "complete" : this.#started > this.#completed ? "running" : "waiting";
    return {
      jobId: this.budget.jobId, status, startedChunks: this.#started, completedChunks: this.#completed, paidChunks: this.paidChunks,
      cumulativePaid: (this.#cumulative - this.budget.baseCumulative).toString(), unpaidWork: "0",
    };
  }
}

export type BuyerJobSummary = {
  jobId: string;
  status: "paying" | "waiting_delivery" | "complete" | "aborted";
  confirmedChunks: number;
  signedChunks: number;
  cumulativeSigned: string;
  /** Signed and not yet received: at most one chunk. */
  atRisk: string;
};

/** Buyer side: the voucher for chunk k+1 is signed only after chunk k is received. */
export class BuyerJob {
  readonly budget: JobBudget;
  #confirmed = 0;
  #signed = 0;
  #aborted = false;

  constructor(budget: JobBudget) {
    this.budget = budget;
  }

  /** Chunk `chunk` received and valid (the buyer's own count; SD-068 provides the count). Must be in order and already paid. */
  confirm(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (chunk !== this.#confirmed + 1 || chunk > this.#signed) throw new MeterRejection(`chunk ${chunk} is not being awaited`);
    this.#confirmed = chunk;
  }

  /** Next chunk that may be paid: the first one at the start, then only after the previous chunk is received; `null` when waiting for delivery or finished. */
  nextChunk(): number | null {
    if (this.#aborted || this.#signed >= this.budget.chunks || this.#signed > this.#confirmed) return null;
    return this.#signed + 1;
  }

  nextVoucherAmount(): string | null {
    const chunk = this.nextChunk();
    return chunk === null ? null : this.budget.cumulativeFor(chunk).toString();
  }

  /** Sign the voucher for the next chunk, or throw if the previous chunk is not yet received (never pay two chunks ahead). */
  signNext(secretKey: VoucherSecretKey): { chunk: number; voucher: Voucher; bundleId: number | null } {
    const chunk = this.nextChunk();
    if (chunk === null) throw new MeterRejection("the next voucher is signed only after the previous chunk is received");
    const voucher = signVoucher(this.budget.voucherFor(chunk), secretKey);
    this.#signed = chunk;
    return { chunk, voucher, bundleId: this.budget.bundleId };
  }

  /** The seller stopped: the buyer signs nothing more. */
  abort(): BuyerJobSummary {
    this.#aborted = true;
    return this.summary();
  }

  summary(): BuyerJobSummary {
    const status = this.#aborted ? "aborted" : this.#confirmed >= this.budget.chunks ? "complete" : this.#signed > this.#confirmed ? "waiting_delivery" : "paying";
    return {
      jobId: this.budget.jobId, status, confirmedChunks: this.#confirmed, signedChunks: this.#signed,
      cumulativeSigned: (this.budget.chunkAmount * BigInt(this.#signed)).toString(),
      atRisk: (this.budget.chunkAmount * BigInt(this.#signed - this.#confirmed)).toString(),
    };
  }
}
