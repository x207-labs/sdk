// Escrow kredit untuk job P5 tanpa ubah kontrak (SD-067, ADR-43). Anggaran job (harga semua potongan) dikunci sebagai leg bundle F5: pembeli ke penjual dengan `max_amount` =
// anggaran. `commit_bundle` mencadangkan headroom pembeli untuk anggaran itu di epoch yang berjalan, jadi tiap voucher potongan bisa didaftarkan lewat `register_in_bundle`
// (facilitator, SD-048) walau headroom bebas pembeli habis oleh bundle atau voucher lain. Voucher itu kumulatif (ADR-17): potongan k dilunasi voucher `k × harga potongan`.
//
// Kontrak mewajibkan bundle punya paling sedikit DUA leg (`ERR_BAD_BUNDLE`), jadi syaratnya membawa leg pendamping penjual ke pembeli sebesar satu satuan terkecil
// (`JOB_ESCROW_COUNTER_LEG`): tidak pernah didaftarkan, hanya memenuhi bentuk bundle, dan penjual yang menandatangani bundle sudah ikut sebagai peserta.
//
// Aturan risiko (bayar di depan satu potongan):
//   - penjual mengerjakan potongan k hanya setelah voucher potongan k tiba (`SellerJob.next()`), jadi penjual tidak pernah bekerja tanpa dibayar: pembeli yang berhenti tidak
//     merugikan penjual sama sekali;
//   - pembeli menandatangani voucher potongan k+1 hanya setelah potongan k diterima (`BuyerJob.nextVoucherAmount()`), jadi pembeli yang ditinggal penjual rugi paling banyak
//     satu potongan (yang sudah dibayar dan tidak dikerjakan);
//   - total yang bisa dibayar tidak pernah melebihi anggaran (cadangan bundle).
// Voucher kumulatif itu milik pasangan (pembeli, penjual) di epoch, bukan job: `baseCumulative` dan `baseSeq` adalah keadaan pasangan saat job mulai, dan selama job berjalan
// pembayaran lain pasangan itu menunggu.
// Kelas ini hanya mesin status: tanpa jaringan dan tanpa waktu. Memverifikasi dan menyelesaikan voucher tetap tugas `/verify` dan `/settle`.
import { CREDIT_UNIT, bundleInput, signVoucher, termsHash, type AccountId, type BundleTerms, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";
import { MeteredJob, type MeteredJobOptions } from "./metered-job.js";
import { MeterRejection } from "./metering.js";

/** Leg pendamping penjual ke pembeli: satuan terkecil, karena kontrak menuntut bundle dengan dua leg dan `max_amount` > 0. */
export const JOB_ESCROW_COUNTER_LEG = "1";

export type JobEscrowOptions = Omit<MeteredJobOptions, "maxUnpaidChunks"> & {
  circle: AccountId;
  buyer: AccountId;
  seller: AccountId;
  /** Epoch yang berjalan saat bundle di-commit; anggaran terkunci untuk epoch ini saja, jadi job harus selesai di dalamnya. */
  epoch: number;
  /**
   * Keadaan pasangan (pembeli, penjual) di epoch ini saat job mulai: jumlah kumulatif dan `seq` terakhir yang sudah terdaftar (0 bila belum ada voucher). Voucher kumulatif
   * itu milik PASANGAN, bukan job, jadi voucher potongan harus melanjutkannya; selama job berjalan pembayaran lain pasangan itu menunggu.
   */
  baseCumulative?: U128String;
  baseSeq?: number;
};

/** Angka dan syarat bersama pembeli dan penjual. */
export class JobBudget {
  readonly jobId: string;
  readonly circle: AccountId;
  readonly buyer: AccountId;
  readonly seller: AccountId;
  readonly epoch: number;
  readonly unit: string;
  readonly chunks: number;
  readonly chunkAmount: bigint;
  /** Harga seluruh job = `max_amount` leg pembeli, satuan credit terkecil. */
  readonly budget: bigint;
  readonly baseCumulative: bigint;
  readonly baseSeq: number;
  #bundleId: number | null = null;

  constructor(options: JobEscrowOptions) {
    if (options.buyer === options.seller) throw new MeterRejection("pembeli dan penjual harus akun yang berbeda");
    if (!Number.isSafeInteger(options.epoch) || options.epoch < 1) throw new MeterRejection(`epoch harus bilangan bulat >= 1, dapat ${options.epoch}`);
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
    if (!/^(0|[1-9]\d*)$/.test(base)) throw new MeterRejection(`baseCumulative harus bilangan bulat desimal, dapat ${JSON.stringify(base)}`);
    this.baseCumulative = BigInt(base);
    this.baseSeq = options.baseSeq ?? 0;
    if (!Number.isSafeInteger(this.baseSeq) || this.baseSeq < 0) throw new MeterRejection(`baseSeq harus bilangan bulat >= 0, dapat ${this.baseSeq}`);
  }

  /** Syarat bundle yang ditandatangani pembeli dan penjual: leg pembeli ke penjual sebesar anggaran, ditambah leg pendamping. */
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

  /** Argumen `bundle` untuk `commit_bundle`. */
  commitArgs(): ReturnType<typeof bundleInput> {
    return bundleInput(this.terms());
  }

  termsHash(): string {
    return termsHash(this.terms());
  }

  /** Dipanggil setelah `commit_bundle` mengembalikan `bundle_id`; voucher potongan lalu membawa `bundleId` ini. */
  attach(bundleId: number): void {
    if (!Number.isSafeInteger(bundleId) || bundleId < 1) throw new MeterRejection(`bundleId harus bilangan bulat >= 1, dapat ${bundleId}`);
    this.#bundleId = bundleId;
  }

  get bundleId(): number | null {
    return this.#bundleId;
  }

  /** Jumlah kumulatif voucher pasangan yang melunasi potongan ke-`chunk` (1 sampai total): keadaan awal pasangan + `chunk × harga potongan`. */
  cumulativeFor(chunk: number): bigint {
    if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > this.chunks) throw new MeterRejection(`potongan harus 1 sampai ${this.chunks}, dapat ${chunk}`);
    return this.baseCumulative + this.chunkAmount * BigInt(chunk);
  }

  /** Voucher belum bertanda tangan untuk potongan `chunk`; `seq` naik satu per potongan. */
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
  /** Yang sudah dibayar untuk job ini (kumulatif pasangan dikurangi keadaan awalnya). */
  cumulativePaid: string;
  /** Yang sudah dikerjakan penjual tanpa dibayar: selalu 0, karena potongan dimulai hanya setelah dibayar. */
  unpaidWork: string;
};

/** Sisi penjual: potongan baru dimulai setelah voucher potongan itu tiba. */
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
   * Terima voucher (yang sudah lolos `/verify`): pasangan, epoch, dan unit harus sama dengan job, `seq` naik, jumlah kumulatif tidak turun (`cumulative_decreased`),
   * tidak melebihi anggaran (`over_budget`), dan tidak lebih dari satu potongan di depan potongan yang selesai (`prepaid_too_far`). Jumlah yang sama diterima tanpa efek.
   */
  accept(voucher: Pick<Voucher, "circle" | "payer" | "payee" | "epoch" | "seq" | "cumulativeAmount" | "unit">): SellerJobSummary {
    const b = this.budget;
    if (this.#aborted) throw new MeterRejection("job sudah dihentikan");
    if (voucher.circle !== b.circle || voucher.payer !== b.buyer || voucher.payee !== b.seller || voucher.epoch !== b.epoch || voucher.unit !== CREDIT_UNIT) {
      throw new MeterRejection("wrong_leg: voucher bukan untuk leg pembeli ke penjual di epoch job ini");
    }
    if (!/^(0|[1-9]\d*)$/.test(voucher.cumulativeAmount)) throw new MeterRejection(`cumulativeAmount harus bilangan bulat desimal, dapat ${JSON.stringify(voucher.cumulativeAmount)}`);
    const amount = BigInt(voucher.cumulativeAmount);
    if (amount < this.#cumulative) throw new MeterRejection("cumulative_decreased: voucher lebih kecil dari yang sudah diterima");
    if (amount > b.baseCumulative + b.budget) throw new MeterRejection("over_budget: voucher di atas anggaran yang dikunci");
    if (amount === this.#cumulative) return this.summary();
    if (voucher.seq <= this.#seq) throw new MeterRejection("seq_not_increasing: seq voucher harus naik");
    if (amount > b.baseCumulative + b.chunkAmount * BigInt(this.#completed + 1)) throw new MeterRejection("prepaid_too_far: voucher membayar lebih dari satu potongan di depan");
    this.#cumulative = amount;
    this.#seq = voucher.seq;
    return this.summary();
  }

  /** Nomor potongan yang boleh dikerjakan sekarang: hanya bila voucher potongan itu sudah tiba dan potongan sebelumnya selesai; selain itu `null`. */
  next(): number | null {
    if (this.#aborted || this.#started >= this.budget.chunks || this.#started > this.#completed) return null;
    return this.paidChunks >= this.#started + 1 ? this.#started + 1 : null;
  }

  start(): number {
    const chunk = this.next();
    if (chunk === null) throw new MeterRejection("potongan berikut belum dibayar atau job tidak berjalan");
    this.#started = chunk;
    return chunk;
  }

  complete(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("job sudah dihentikan");
    if (chunk !== this.#started || this.#completed >= this.#started) throw new MeterRejection(`potongan ${chunk} tidak sedang dikerjakan`);
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
  /** Yang sudah ditandatangani dan belum diterima: paling banyak satu potongan. */
  atRisk: string;
};

/** Sisi pembeli: voucher potongan k+1 ditandatangani hanya setelah potongan k diterima. */
export class BuyerJob {
  readonly budget: JobBudget;
  #confirmed = 0;
  #signed = 0;
  #aborted = false;

  constructor(budget: JobBudget) {
    this.budget = budget;
  }

  /** Potongan `chunk` diterima dan sah (hitungan pembeli sendiri; SD-068 menyediakan hitungannya). Harus berurutan dan sudah dibayar. */
  confirm(chunk: number): void {
    if (this.#aborted) throw new MeterRejection("job sudah dihentikan");
    if (chunk !== this.#confirmed + 1 || chunk > this.#signed) throw new MeterRejection(`potongan ${chunk} tidak sedang ditunggu`);
    this.#confirmed = chunk;
  }

  /** Potongan berikut yang boleh dibayar: yang pertama di awal, lalu hanya setelah potongan sebelumnya diterima; `null` bila menunggu pengiriman atau selesai. */
  nextChunk(): number | null {
    if (this.#aborted || this.#signed >= this.budget.chunks || this.#signed > this.#confirmed) return null;
    return this.#signed + 1;
  }

  nextVoucherAmount(): string | null {
    const chunk = this.nextChunk();
    return chunk === null ? null : this.budget.cumulativeFor(chunk).toString();
  }

  /** Tandatangani voucher potongan berikut, atau lempar bila potongan sebelumnya belum diterima (tidak membayar dua potongan di depan). */
  signNext(secretKey: VoucherSecretKey): { chunk: number; voucher: Voucher; bundleId: number | null } {
    const chunk = this.nextChunk();
    if (chunk === null) throw new MeterRejection("voucher berikut hanya ditandatangani setelah potongan sebelumnya diterima");
    const voucher = signVoucher(this.budget.voucherFor(chunk), secretKey);
    this.#signed = chunk;
    return { chunk, voucher, bundleId: this.budget.bundleId };
  }

  /** Penjual berhenti: pembeli tidak menandatangani apa pun lagi. */
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
