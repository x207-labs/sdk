// Hitungan sendiri di sisi pembeli (SD-068, pipeline P5, ADR-43): pembeli mencatat apa yang benar-benar diterima (byte, durasi, jumlah panggilan) dan menolak menandatangani
// voucher di atas hitungan itu. Penjual yang menagih 10 GB untuk 2 GB tidak mendapat voucher di atas 2 GB. Dua pemeriksaan:
//   1. `authorize(meter, amount)`: pada 402 yang mengumumkan `extra.meter`, satuan, harga satuan, jumlah, dan total harus cocok dengan yang diminta pembeli;
//   2. `checkVoucher(cumulativeAmount)` / `sign(...)`: jumlah kumulatif tidak boleh melebihi harga (diterima + diharapkan) satuan, untuk tagihan sesudah pemakaian dan job bertahap.
// Kelas ini tanpa jaringan dan tanpa waktu. Satuan memakai enam desimal, sama dengan harga terukur penjual (SD-062).
import { CREDIT_DECIMALS, signVoucher, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";
import { meterAmount, type MeterAnnouncement } from "../server/metering.js";
import { priceToAmount } from "../server/price.js";

/** Kode galat yang stabil. */
export type MeterOverbilledCode =
  | "meter_missing" | "meter_unit_mismatch" | "meter_price_too_high" | "meter_quantity_over_expected" | "meter_amount_mismatch" | "meter_overbilled" | "meter_bad_count" | "meter_wrong_epoch";

export class MeterOverbilledError extends Error {
  constructor(readonly code: MeterOverbilledCode, message: string, readonly detail: Record<string, string> = {}) {
    super(`${code}: ${message}`);
    this.name = "MeterOverbilledError";
  }
}

export type BuyerMeterOptions = {
  /** Satuan yang dibeli, mis. `GB`, `minute`, `call`, `job`. */
  unit: string;
  /** Harga satuan tertinggi yang disetujui pembeli, dalam credit (format `price` biasa); biasanya harga di listing. */
  unitPrice: string | number;
  /** Batas jumlah per request bila pembeli tidak menyebut harapan per request. */
  maxQuantityPerRequest?: number | string;
  /**
   * Epoch yang berjalan dan keadaan pasangan (pembeli, penjual) di epoch itu: jumlah kumulatif voucher yang sudah terdaftar (`"0"` bila belum ada). Voucher kumulatif dimulai lagi
   * dari 0 di tiap epoch (ADR-17), jadi batasnya dihitung per epoch: `baseCumulative` ditambah harga yang diterima di epoch ini (tinjauan BE-062, F3).
   */
  epoch: number;
  baseCumulative?: U128String;
};

const SCALE = 10n ** BigInt(CREDIT_DECIMALS);
const QUANTITY = /^(\d+)(?:\.(\d{1,6}))?$/;
const GB_BYTES = 1_000_000_000n;

function micro(value: number | string, name: string): bigint {
  const text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : "") : value.trim();
  const match = QUANTITY.exec(text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  if (!match) throw new MeterOverbilledError("meter_bad_count", `${name} harus angka desimal >= 0 dengan paling banyak 6 desimal, dapat ${JSON.stringify(value)}`);
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}
const plain = (value: bigint): string => {
  const fraction = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / SCALE}.${fraction}` : `${value / SCALE}`;
};

export class BuyerMeter {
  readonly unit: string;
  /** Harga satuan tertinggi yang disetujui, satuan credit terkecil. */
  readonly unitPrice: bigint;
  #maxPerRequest: bigint | undefined;
  #received = 0n;
  #epoch: number;
  #base: bigint;
  #pending = 0n;

  constructor(options: BuyerMeterOptions) {
    this.unit = options.unit;
    this.unitPrice = BigInt(priceToAmount(options.unitPrice));
    this.#maxPerRequest = options.maxQuantityPerRequest === undefined ? undefined : micro(options.maxQuantityPerRequest, "maxQuantityPerRequest");
    this.#epoch = BuyerMeter.#checkEpoch(options.epoch);
    this.#base = BuyerMeter.#checkBase(options.baseCumulative ?? "0");
  }

  static #checkEpoch(epoch: number): number {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new MeterOverbilledError("meter_wrong_epoch", `epoch harus bilangan bulat >= 1, dapat ${epoch}`);
    return epoch;
  }
  static #checkBase(base: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(base)) throw new MeterOverbilledError("meter_bad_count", `baseCumulative harus bilangan bulat desimal, dapat ${JSON.stringify(base)}`);
    return BigInt(base);
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** Pindah ke epoch berikutnya dengan keadaan pasangan di sana; yang diterima dan yang diharapkan dihitung dari 0 lagi. */
  startEpoch(epoch: number, baseCumulative: U128String = "0"): void {
    if (epoch <= this.#epoch) throw new MeterOverbilledError("meter_wrong_epoch", `epoch ${epoch} bukan setelah epoch ${this.#epoch}`);
    this.#epoch = BuyerMeter.#checkEpoch(epoch);
    this.#base = BuyerMeter.#checkBase(baseCumulative);
    this.#received = 0n;
    this.#pending = 0n;
  }

  /** Yang benar-benar diterima di epoch ini, dalam satuan (teks). */
  get received(): string {
    return plain(this.#received);
  }

  /** Yang diminta pembeli dan belum diterima, dalam satuan (teks). */
  get pending(): string {
    return plain(this.#pending);
  }

  /** Pembeli akan meminta `quantity` satuan: voucher boleh membayarnya di muka, tidak lebih. */
  expect(quantity: number | string): void {
    this.#pending += micro(quantity, "quantity");
  }

  /** Mencatat `quantity` satuan yang diterima; mengurangi yang diharapkan. */
  record(quantity: number | string): void {
    const q = micro(quantity, "quantity");
    this.#received += q;
    this.#pending = q >= this.#pending ? 0n : this.#pending - q;
  }

  /** Mencatat byte yang diterima; hanya untuk satuan `GB` (1 GB = 10^9 byte). */
  recordBytes(bytes: number | bigint): void {
    if (this.unit !== "GB") throw new MeterOverbilledError("meter_unit_mismatch", `byte hanya untuk satuan GB, satuan meter ini ${this.unit}`);
    const b = BigInt(bytes);
    if (b < 0n) throw new MeterOverbilledError("meter_bad_count", "byte tidak boleh negatif");
    this.record(plain((b * SCALE) / GB_BYTES));
  }

  /** Mencatat durasi yang diterima dalam milidetik; hanya untuk satuan `minute` atau `day`. */
  recordMillis(ms: number): void {
    const unitMs = this.unit === "minute" ? 60_000 : this.unit === "day" ? 86_400_000 : 0;
    if (unitMs === 0) throw new MeterOverbilledError("meter_unit_mismatch", `durasi hanya untuk satuan minute atau day, satuan meter ini ${this.unit}`);
    if (!Number.isFinite(ms) || ms < 0) throw new MeterOverbilledError("meter_bad_count", "durasi tidak boleh negatif");
    this.record((ms / unitMs).toFixed(6));
  }

  /** Mencatat jumlah panggilan, request, atau job yang diterima (bilangan bulat). */
  recordCalls(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new MeterOverbilledError("meter_bad_count", `jumlah harus bilangan bulat >= 0, dapat ${count}`);
    this.record(count);
  }

  /** Harga (diterima + diharapkan) satuan pada harga yang disetujui: batas atas jumlah kumulatif yang boleh ditandatangani, satuan credit terkecil. */
  ceiling(): bigint {
    const total = this.#received + this.#pending;
    return this.#base + (total === 0n ? 0n : (this.unitPrice * total + SCALE - 1n) / SCALE);
  }

  /**
   * Periksa 402 yang mengumumkan `extra.meter` sebelum menandatangani: satuan sama, harga satuan tidak di atas yang disetujui, jumlah tidak di atas yang diminta (atau batas
   * per request), dan `amount` sama dengan harga satuan × jumlah.
   */
  authorize(announcement: MeterAnnouncement | undefined, amount: U128String): void {
    if (announcement === undefined) throw new MeterOverbilledError("meter_missing", "402 tidak mengumumkan extra.meter: satuan dan jumlah tagihan tidak diketahui");
    if (announcement.unit !== this.unit) throw new MeterOverbilledError("meter_unit_mismatch", `satuan ${announcement.unit}, diharapkan ${this.unit}`, { unit: announcement.unit });
    // F8 (review BE-062): BigInt() reads hex ("0x10"), spaces and an empty text; the price is a decimal whole number above 0 or the announcement is refused
    if (typeof announcement.unit_price !== "string" || !/^[1-9]\d*$/.test(announcement.unit_price)) {
      throw new MeterOverbilledError("meter_bad_count", `unit_price harus bilangan bulat desimal > 0, dapat ${JSON.stringify(announcement.unit_price)}`);
    }
    const announcedPrice = BigInt(announcement.unit_price);
    if (announcedPrice > this.unitPrice) {
      throw new MeterOverbilledError("meter_price_too_high", `harga satuan ${announcement.unit_price} di atas yang disetujui ${this.unitPrice}`, { unit_price: announcement.unit_price });
    }
    const quantity = micro(announcement.quantity, "quantity");
    const allowed = this.#pending > 0n ? this.#pending : this.#maxPerRequest;
    if (allowed !== undefined && quantity > allowed) {
      throw new MeterOverbilledError("meter_quantity_over_expected", `${announcement.quantity} ${this.unit} ditagih, diminta paling banyak ${plain(allowed)}`, {
        quantity: announcement.quantity, expected: plain(allowed),
      });
    }
    if (meterAmount(announcement.unit_price, quantity) !== amount) {
      throw new MeterOverbilledError("meter_amount_mismatch", `jumlah ${amount} bukan ${announcement.unit_price} × ${announcement.quantity}`, { amount });
    }
  }

  /** Voucher kumulatif di atas `ceiling()` ditolak. */
  checkVoucher(cumulativeAmount: U128String, epoch: number): void {
    if (epoch !== this.#epoch) throw new MeterOverbilledError("meter_wrong_epoch", `voucher untuk epoch ${epoch}, meter ini untuk epoch ${this.#epoch}: panggil startEpoch`, { epoch: String(epoch) });
    const cap = this.ceiling();
    if (BigInt(cumulativeAmount) > cap) {
      throw new MeterOverbilledError(
        "meter_overbilled",
        `voucher ${cumulativeAmount} di atas harga ${this.received} ${this.unit} diterima dan ${this.pending} diharapkan (${cap})`,
        { cumulative_amount: cumulativeAmount, ceiling: cap.toString(), received: this.received },
      );
    }
  }

  /** Tandatangani voucher hanya bila lolos `checkVoucher`. */
  sign(voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Voucher {
    this.checkVoucher(voucher.cumulativeAmount, voucher.epoch);
    return signVoucher(voucher, secretKey);
  }
}
