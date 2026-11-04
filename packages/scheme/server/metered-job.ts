// Staged vouchers for long jobs (SD-063, pipeline P5, class D). The work is split into equal-sized chunks; the client pays with cumulative vouchers (ADR-17), one
// increment per chunk, and the server stops if the next voucher does not arrive. This class is only a state machine (no network, no time): it answers when the next chunk
// may start, how much has been paid, and how much is still owed, while verifying and settling vouchers is still done by `/verify` and `/settle`
// as usual for each voucher.
//
// Risk rule: chunk k+1 starts only if the unpaid chunks are no more than `maxUnpaidChunks` (default 1). So the seller works on at most one
// chunk without being paid, and a buyer who stops paying costs the seller at most one chunk; the buyer never pays for a chunk that is not finished
// unless they choose to prepay (a voucher larger than what is owed is accepted up to the total amount).
import { CREDIT_DECIMALS } from "@x207/core";
import { MeterRejection, meterAmount } from "./metering.js";
import { priceToAmount } from "./price.js";

export type MeteredJobOptions = {
  jobId: string;
  /** Unit as in metered pricing (`job`, `GB`, `second`, ...); for reporting only. */
  unit: string;
  /** Units per chunk; a decimal number > 0 with at most 6 decimals. */
  chunkQuantity: number | string;
  /** Price of one unit in credit (`price` format). */
  unitPrice: string | number;
  /** Number of chunks in the job. */
  chunks: number;
  /** The most chunks that may be in progress or done without being paid (default 1). */
  maxUnpaidChunks?: number;
};

export type MeteredJobStatus = "running" | "stalled" | "complete" | "aborted";
export type MeteredJobSummary = {
  jobId: string;
  status: MeteredJobStatus;
  totalChunks: number;
  startedChunks: number;
  completedChunks: number;
  paidChunks: number;
  /** Highest cumulative voucher received, in smallest credit units. */
  cumulativePaid: string;
  /** Price of one chunk, in smallest credit units. */
  chunkAmount: string;
  /** What is still owed for finished chunks: `max(0, finished × price - paid)`. */
  amountDue: string;
  /** What is prepaid for unfinished chunks: `max(0, paid - finished × price)`. */
  prepaid: string;
};

export class MeteredJob {
  readonly jobId: string;
  readonly unit: string;
  readonly totalChunks: number;
  readonly chunkAmount: bigint;
  readonly maxUnpaidChunks: number;
  #started = 0;
  #completed = 0;
  #cumulative = 0n;
  #aborted = false;

  constructor(options: MeteredJobOptions) {
    if (!Number.isSafeInteger(options.chunks) || options.chunks < 1) throw new MeterRejection(`chunks must be an integer >= 1, got ${options.chunks}`);
    const maxUnpaid = options.maxUnpaidChunks ?? 1;
    if (!Number.isSafeInteger(maxUnpaid) || maxUnpaid < 1) throw new MeterRejection("maxUnpaidChunks must be an integer >= 1");
    const text = typeof options.chunkQuantity === "number" ? options.chunkQuantity.toFixed(6) : options.chunkQuantity.trim();
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
    if (!match) throw new MeterRejection(`chunkQuantity must be a decimal number > 0 with at most 6 decimals, got ${JSON.stringify(options.chunkQuantity)}`);
    const quantityMicro = BigInt(match[1]!) * 10n ** BigInt(CREDIT_DECIMALS) + BigInt((match[2] ?? "").padEnd(6, "0"));
    if (quantityMicro <= 0n) throw new MeterRejection("chunkQuantity must be > 0");
    this.jobId = options.jobId;
    this.unit = options.unit;
    this.totalChunks = options.chunks;
    this.maxUnpaidChunks = maxUnpaid;
    // the price of one chunk is rounded up once; total job = chunks × chunk price (can be slightly above unit price × total quantity, at most one small unit per chunk)
    this.chunkAmount = BigInt(meterAmount(priceToAmount(options.unitPrice), quantityMicro));
  }

  get paidChunks(): number {
    return Number(this.#cumulative / this.chunkAmount > BigInt(this.totalChunks) ? BigInt(this.totalChunks) : this.#cumulative / this.chunkAmount);
  }

  /** Cumulative voucher amount that pays off chunk `k` (1 to total): material for the next voucher on the client side. */
  cumulativeFor(chunk: number): string {
    if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > this.totalChunks) throw new MeterRejection(`chunk must be 1 to ${this.totalChunks}, got ${chunk}`);
    return (this.chunkAmount * BigInt(chunk)).toString();
  }

  /**
   * Accept a cumulative voucher (a valid `/verify` result). The amount must not decrease (`cumulative_decreased`); the same amount is accepted with no effect (repeat). An amount
   * above the price of the whole job is rejected (`overpayment`).
   */
  pay(cumulativeAmount: string): MeteredJobSummary {
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (!/^(0|[1-9]\d*)$/.test(cumulativeAmount)) throw new MeterRejection(`cumulativeAmount must be a decimal integer, got ${JSON.stringify(cumulativeAmount)}`);
    const amount = BigInt(cumulativeAmount);
    if (amount < this.#cumulative) throw new MeterRejection("cumulative_decreased: voucher is smaller than what was already received");
    if (amount > this.chunkAmount * BigInt(this.totalChunks)) throw new MeterRejection("overpayment: voucher is above the price of the whole job");
    this.#cumulative = amount;
    return this.summary();
  }

  /** Number of the next chunk that may be worked on now, or `null` if the job is finished, stopped, or waiting for a voucher (stalled). */
  next(): number | null {
    if (this.#aborted || this.#started >= this.totalChunks) return null;
    if (this.#started > this.#completed) return null; // one chunk is worked on at a time
    const unpaid = this.#started + 1 - this.paidChunks;
    return unpaid <= this.maxUnpaidChunks ? this.#started + 1 : null;
  }

  /** Start chunk `next()`; throws if it may not start. */
  start(): number {
    const chunk = this.next();
    if (chunk === null) throw new MeterRejection(`the next chunk must not start (status ${this.status()})`);
    this.#started = chunk;
    return chunk;
  }

  /** The chunk being worked on is finished. */
  complete(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (chunk !== this.#started || this.#completed >= this.#started) throw new MeterRejection(`chunk ${chunk} is not being worked on`);
    this.#completed = chunk;
  }

  /** Stop the job (client closes, voucher does not arrive by the deadline). The chunk being worked on is not counted as finished. */
  abort(): MeteredJobSummary {
    this.#aborted = true;
    return this.summary();
  }

  status(): MeteredJobStatus {
    if (this.#aborted) return "aborted";
    if (this.#completed >= this.totalChunks) return "complete";
    if (this.#started === this.#completed && this.next() === null) return "stalled";
    return "running";
  }

  summary(): MeteredJobSummary {
    const earned = this.chunkAmount * BigInt(this.#completed);
    return {
      jobId: this.jobId,
      status: this.status(),
      totalChunks: this.totalChunks,
      startedChunks: this.#started,
      completedChunks: this.#completed,
      paidChunks: this.paidChunks,
      cumulativePaid: this.#cumulative.toString(),
      chunkAmount: this.chunkAmount.toString(),
      amountDue: (earned > this.#cumulative ? earned - this.#cumulative : 0n).toString(),
      prepaid: (this.#cumulative > earned ? this.#cumulative - earned : 0n).toString(),
    };
  }
}
