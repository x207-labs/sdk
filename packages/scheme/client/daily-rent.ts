// Sewa akses harian, sisi penyewa (SD-071, pipeline P2, ADR-47). Akses disewa per hari: penyewa membayar satu hari di depan dan hanya menandatangani voucher hari berikutnya bila akses
// MASIH BERJALAN, jadi kerugian tiap pihak paling banyak satu hari: penyewa yang ditinggal pemberi (akses dicabut lebih awal) tidak membayar hari berikutnya, dan pemberi yang tidak dibayar
// mencabut aksesnya sendiri (broker). Polanya sama dengan `BuyerMeter` (SD-068): hitungan dan pemeriksaan ada di sisi penyewa, dan tanpa lolos pemeriksaan tidak ada voucher yang ditandatangani.
// Untuk akses berbiaya (role cloud, org dengan batas belanja) penyedia menagih biaya nyata per hari, dibatasi `daily_cap` dari scope grant; tagihan di atas batas tidak ditandatangani.
//
// Kelas ini tanpa jaringan dan tanpa waktu: pemanggil memberi `view` (jawaban `GET /grants/{id}/access` broker) dan, bila ada, hasil pemeriksaan langsung ke penyedia.
import { CREDIT_UNIT, RentError, checkAccessBeforeNextDay, signVoucher, type AccessView, type AccountId, type RentErrorCode, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";

const fail = (code: RentErrorCode, message: string): never => {
  throw new RentError(code, message);
};
export type { AccessView };

export type DailyRentOptions = {
  circle: AccountId;
  payer: AccountId;
  payee: AccountId;
  grantId: number;
  /** Harga satu hari sewa dalam satuan credit terkecil. */
  dailyPrice: U128String;
  /** Batas biaya nyata per hari dari scope grant (`daily_cap`), satuan credit terkecil; kosong untuk akses tanpa biaya. */
  dailyCap?: U128String | undefined;
  secretKey: VoucherSecretKey;
  /** Jam penyewa, unix ms. */
  now: () => number;
};

const isAmount = (v: string): boolean => /^(0|[1-9]\d*)$/.test(v);

export class DailyRent {
  readonly #o: DailyRentOptions;
  #days = 0;
  #stopped = false;

  constructor(options: DailyRentOptions) {
    if (!isAmount(options.dailyPrice) || BigInt(options.dailyPrice) === 0n) fail("rent_bad_cap", "dailyPrice must be a decimal integer > 0");
    if (options.dailyCap !== undefined && !isAmount(options.dailyCap)) fail("rent_bad_cap", "dailyCap must be a decimal integer");
    this.#o = options;
  }

  /** Hari yang sudah dibayar (voucher ditandatangani). */
  get daysPaid(): number {
    return this.#days;
  }
  get stopped(): boolean {
    return this.#stopped;
  }
  /** Penyewa berhenti sewa: tidak ada voucher lagi. */
  stop(): void {
    this.#stopped = true;
  }

  /**
   * Pemeriksaan sebelum menandatangani voucher hari BERIKUTNYA. Lolos hanya bila broker mengatakan akses `active` dan masih terbayar sampai sekarang, dan, bila diberikan, pemeriksaan
   * langsung ke penyedia (`directCheck`, mis. mencoba masuk) berhasil: akses yang dicabut lebih awal tidak dibayar lagi.
   */
  async checkBeforeNextDay(view: AccessView, directCheck?: () => Promise<boolean>): Promise<void> {
    if (this.#stopped) fail("rent_stopped", "the rent has already been stopped");
    await checkAccessBeforeNextDay({ grantId: this.#o.grantId, view, nowMs: this.#o.now(), ...(directCheck ? { directCheck } : {}) });
  }

  /** Voucher untuk satu hari sewa di atas keadaan pasangan di `epoch`; `day` (mis. `2026-11-04`) mencegah membayar hari yang sama dua kali. */
  signDay(args: { day: string; epoch: number; state: { seq: number; cumulativeAmount: U128String } }): Voucher {
    if (this.#stopped) fail("rent_stopped", "the rent has already been stopped");
    if (this.#lastDay === args.day) fail("rent_day_already_paid", `day ${args.day} is already paid`);
    const voucher: UnsignedVoucher = {
      circle: this.#o.circle, payer: this.#o.payer, payee: this.#o.payee, epoch: args.epoch, seq: args.state.seq + 1,
      cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(this.#o.dailyPrice)).toString(), unit: CREDIT_UNIT, resource: `x207:grant:${this.#o.grantId}`,
    };
    const signed = signVoucher(voucher, this.#o.secretKey);
    this.#lastDay = args.day;
    this.#days += 1;
    return signed;
  }
  #lastDay: string | null = null;

  /**
   * Tagihan biaya nyata sehari: `billed` dari penyedia (lewat broker). Di atas `daily_cap` ditolak dan sewa dihentikan; tanpa batas, akses berbiaya tidak boleh ditagih sama sekali.
   * Mengembalikan jumlah yang boleh ditandatangani.
   */
  checkBill(billed: U128String): U128String {
    if (!isAmount(billed)) fail("rent_bad_state", `bill must be a decimal integer, got ${JSON.stringify(billed)}`);
    const cap = this.#o.dailyCap;
    if (BigInt(billed) === 0n) return billed;
    if (cap === undefined) return fail("rent_bill_over_cap", "this access has no daily limit, so a real charge must not be billed");
    if (BigInt(billed) > BigInt(cap)) {
      this.#stopped = true;
      return fail("rent_bill_over_cap", `bill ${billed} is above the daily limit ${cap}: not signed, rent stopped`);
    }
    return billed;
  }

  signBill(args: { billed: U128String; epoch: number; state: { seq: number; cumulativeAmount: U128String } }): Voucher {
    const amount = this.checkBill(args.billed);
    const voucher: UnsignedVoucher = {
      circle: this.#o.circle, payer: this.#o.payer, payee: this.#o.payee, epoch: args.epoch, seq: args.state.seq + 1,
      cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(amount)).toString(), unit: CREDIT_UNIT, resource: `x207:grant:${this.#o.grantId}:cost`,
    };
    return signVoucher(voucher, this.#o.secretKey);
  }
}
