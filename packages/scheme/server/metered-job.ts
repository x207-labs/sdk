// Voucher bertahap untuk job panjang (SD-063, pipeline P5, kelas D). Kerja dipecah menjadi potongan berukuran sama; klien membayar dengan voucher kumulatif (ADR-17), satu
// kenaikan per potongan, dan server berhenti bila voucher berikutnya tidak datang. Kelas ini hanya mesin status (tanpa jaringan, tanpa waktu): ia menjawab kapan potongan berikut
// boleh dimulai, berapa yang sudah dibayar, dan berapa yang masih terutang, sedangkan memverifikasi dan menyelesaikan voucher tetap dikerjakan `/verify` dan `/settle`
// seperti biasa untuk tiap voucher.
//
// Aturan risiko: potongan k+1 dimulai hanya bila potongan yang belum dibayar tidak lebih dari `maxUnpaidChunks` (bawaan 1). Jadi penjual yang bekerja paling banyak satu
// potongan tanpa dibayar, dan pembeli yang berhenti membayar kehilangan paling banyak satu potongan bagi penjual; pembeli tidak pernah membayar potongan yang belum selesai
// kecuali ia memilih membayar di muka (voucher yang lebih besar dari yang terutang diterima sampai jumlah total).
import { CREDIT_DECIMALS } from "@x207/core";
import { MeterRejection, meterAmount } from "./metering.js";
import { priceToAmount } from "./price.js";

export type MeteredJobOptions = {
  jobId: string;
  /** Satuan seperti pada harga terukur (`job`, `GB`, `second`, ...); hanya untuk laporan. */
  unit: string;
  /** Satuan per potongan; angka desimal > 0 dengan paling banyak 6 desimal. */
  chunkQuantity: number | string;
  /** Harga satu satuan dalam credit (format `price`). */
  unitPrice: string | number;
  /** Jumlah potongan job. */
  chunks: number;
  /** Paling banyak berapa potongan yang boleh sedang atau sudah dikerjakan tanpa dibayar (bawaan 1). */
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
  /** Voucher kumulatif tertinggi yang diterima, satuan credit terkecil. */
  cumulativePaid: string;
  /** Harga satu potongan, satuan credit terkecil. */
  chunkAmount: string;
  /** Yang masih terutang untuk potongan yang selesai: `max(0, selesai × harga - dibayar)`. */
  amountDue: string;
  /** Yang dibayar di muka untuk potongan yang belum selesai: `max(0, dibayar - selesai × harga)`. */
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
    // harga satu potongan dibulatkan ke atas satu kali; total job = potongan × harga potongan (bisa sedikit di atas harga satuan × jumlah total, paling banyak satu satuan kecil per potongan)
    this.chunkAmount = BigInt(meterAmount(priceToAmount(options.unitPrice), quantityMicro));
  }

  get paidChunks(): number {
    return Number(this.#cumulative / this.chunkAmount > BigInt(this.totalChunks) ? BigInt(this.totalChunks) : this.#cumulative / this.chunkAmount);
  }

  /** Jumlah kumulatif voucher yang melunasi potongan ke-`k` (1 sampai total): bahan voucher berikutnya di sisi klien. */
  cumulativeFor(chunk: number): string {
    if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > this.totalChunks) throw new MeterRejection(`chunk must be 1 to ${this.totalChunks}, got ${chunk}`);
    return (this.chunkAmount * BigInt(chunk)).toString();
  }

  /**
   * Terima voucher kumulatif (hasil `/verify` yang sah). Jumlah tidak boleh turun (`cumulative_decreased`); jumlah yang sama diterima tanpa efek (ulang). Jumlah
   * di atas harga seluruh job ditolak (`overpayment`).
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

  /** Nomor potongan berikut yang boleh dikerjakan sekarang, atau `null` bila job selesai, dihentikan, atau menunggu voucher (macet). */
  next(): number | null {
    if (this.#aborted || this.#started >= this.totalChunks) return null;
    if (this.#started > this.#completed) return null; // satu potongan dikerjakan pada satu waktu
    const unpaid = this.#started + 1 - this.paidChunks;
    return unpaid <= this.maxUnpaidChunks ? this.#started + 1 : null;
  }

  /** Mulai potongan `next()`; melempar bila tidak boleh dimulai. */
  start(): number {
    const chunk = this.next();
    if (chunk === null) throw new MeterRejection(`the next chunk must not start (status ${this.status()})`);
    this.#started = chunk;
    return chunk;
  }

  /** Potongan yang sedang dikerjakan selesai. */
  complete(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("the job has already been stopped");
    if (chunk !== this.#started || this.#completed >= this.#started) throw new MeterRejection(`chunk ${chunk} is not being worked on`);
    this.#completed = chunk;
  }

  /** Hentikan job (klien menutup, voucher tidak datang sampai batas waktu). Potongan yang sedang dikerjakan tidak dihitung selesai. */
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
