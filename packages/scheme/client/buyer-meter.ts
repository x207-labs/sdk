// Buyer-side own count (SD-068, pipeline P5, ADR-43): the buyer records what was actually received (bytes, duration, number of calls) and refuses to sign
// a voucher above that count. A seller who bills 10 GB for 2 GB gets no voucher above 2 GB. Two checks:
//   1. `authorize(meter, amount)`: on a 402 that announces `extra.meter`, the unit, unit price, quantity, and total must match what the buyer asked for;
//   2. `checkVoucher(cumulativeAmount)` / `sign(...)`: the cumulative amount must not exceed the price of (received + expected) units, for post-usage bills and staged jobs.
// This class has no network and no time. Units use six decimals, the same as the seller's metered price (SD-062).
import { CREDIT_DECIMALS, signVoucher, type U128String, type UnsignedVoucher, type Voucher, type VoucherSecretKey } from "@x207/core";
import { meterAmount, type MeterAnnouncement } from "../server/metering.js";
import { priceToAmount } from "../server/price.js";

/** Stable error code. */
export type MeterOverbilledCode =
  | "meter_missing" | "meter_unit_mismatch" | "meter_price_too_high" | "meter_quantity_over_expected" | "meter_amount_mismatch" | "meter_overbilled" | "meter_bad_count" | "meter_wrong_epoch";

export class MeterOverbilledError extends Error {
  constructor(readonly code: MeterOverbilledCode, message: string, readonly detail: Record<string, string> = {}) {
    super(`${code}: ${message}`);
    this.name = "MeterOverbilledError";
  }
}

export type BuyerMeterOptions = {
  /** The unit bought, e.g. `GB`, `minute`, `call`, `job`. */
  unit: string;
  /** The highest unit price the buyer approves, in credit (the usual `price` format); normally the listing price. */
  unitPrice: string | number;
  /** Cap on quantity per request when the buyer does not state an expectation per request. */
  maxQuantityPerRequest?: number | string;
  /**
   * The running epoch and the state of the (buyer, seller) pair in that epoch: the cumulative amount of vouchers already registered (`"0"` if none). The cumulative voucher starts again
   * from 0 in each epoch (ADR-17), so the limit is computed per epoch: `baseCumulative` plus the price received in this epoch (review BE-062, F3).
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
  if (!match) throw new MeterOverbilledError("meter_bad_count", `${name} must be a decimal number >= 0 with at most 6 decimals, got ${JSON.stringify(value)}`);
  return BigInt(match[1]!) * SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
}
const plain = (value: bigint): string => {
  const fraction = (value % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / SCALE}.${fraction}` : `${value / SCALE}`;
};

export class BuyerMeter {
  readonly unit: string;
  /** The highest approved unit price, in the smallest credit unit. */
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
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new MeterOverbilledError("meter_wrong_epoch", `epoch must be an integer >= 1, got ${epoch}`);
    return epoch;
  }
  static #checkBase(base: string): bigint {
    if (!/^(0|[1-9]\d*)$/.test(base)) throw new MeterOverbilledError("meter_bad_count", `baseCumulative must be a decimal integer, got ${JSON.stringify(base)}`);
    return BigInt(base);
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** Move to the next epoch with the pair's state there; received and expected are counted from 0 again. */
  startEpoch(epoch: number, baseCumulative: U128String = "0"): void {
    if (epoch <= this.#epoch) throw new MeterOverbilledError("meter_wrong_epoch", `epoch ${epoch} is not after epoch ${this.#epoch}`);
    this.#epoch = BuyerMeter.#checkEpoch(epoch);
    this.#base = BuyerMeter.#checkBase(baseCumulative);
    this.#received = 0n;
    this.#pending = 0n;
  }

  /** What was actually received in this epoch, in units (text). */
  get received(): string {
    return plain(this.#received);
  }

  /** What the buyer requested and has not yet received, in units (text). */
  get pending(): string {
    return plain(this.#pending);
  }

  /** The buyer will request `quantity` units: a voucher may pay for it in advance, no more. */
  expect(quantity: number | string): void {
    this.#pending += micro(quantity, "quantity");
  }

  /** Records `quantity` units received; reduces what is expected. */
  record(quantity: number | string): void {
    const q = micro(quantity, "quantity");
    this.#received += q;
    this.#pending = q >= this.#pending ? 0n : this.#pending - q;
  }

  /** Records bytes received; only for unit `GB` (1 GB = 10^9 bytes). */
  recordBytes(bytes: number | bigint): void {
    if (this.unit !== "GB") throw new MeterOverbilledError("meter_unit_mismatch", `bytes only apply to unit GB, this meter's unit is ${this.unit}`);
    const b = BigInt(bytes);
    if (b < 0n) throw new MeterOverbilledError("meter_bad_count", "bytes must not be negative");
    this.record(plain((b * SCALE) / GB_BYTES));
  }

  /** Records duration received in milliseconds; only for unit `minute` or `day`. */
  recordMillis(ms: number): void {
    const unitMs = this.unit === "minute" ? 60_000 : this.unit === "day" ? 86_400_000 : 0;
    if (unitMs === 0) throw new MeterOverbilledError("meter_unit_mismatch", `duration only applies to unit minute or day, this meter's unit is ${this.unit}`);
    if (!Number.isFinite(ms) || ms < 0) throw new MeterOverbilledError("meter_bad_count", "duration must not be negative");
    this.record((ms / unitMs).toFixed(6));
  }

  /** Records the number of calls, requests, or jobs received (integer). */
  recordCalls(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new MeterOverbilledError("meter_bad_count", `count must be an integer >= 0, got ${count}`);
    this.record(count);
  }

  /** Price of (received + expected) units at the approved price: the upper bound of the cumulative amount that may be signed, in the smallest credit unit. */
  ceiling(): bigint {
    const total = this.#received + this.#pending;
    return this.#base + (total === 0n ? 0n : (this.unitPrice * total + SCALE - 1n) / SCALE);
  }

  /**
   * Check a 402 that announces `extra.meter` before signing: same unit, unit price not above the approved one, quantity not above what was requested (or the per-request
   * limit), and `amount` equal to unit price × quantity.
   */
  authorize(announcement: MeterAnnouncement | undefined, amount: U128String): void {
    if (announcement === undefined) throw new MeterOverbilledError("meter_missing", "402 does not announce extra.meter: the unit and the billed quantity are unknown");
    if (announcement.unit !== this.unit) throw new MeterOverbilledError("meter_unit_mismatch", `unit ${announcement.unit}, expected ${this.unit}`, { unit: announcement.unit });
    // F8 (review BE-062): BigInt() reads hex ("0x10"), spaces and an empty text; the price is a decimal whole number above 0 or the announcement is refused
    if (typeof announcement.unit_price !== "string" || !/^[1-9]\d*$/.test(announcement.unit_price)) {
      throw new MeterOverbilledError("meter_bad_count", `unit_price must be a decimal integer > 0, got ${JSON.stringify(announcement.unit_price)}`);
    }
    const announcedPrice = BigInt(announcement.unit_price);
    if (announcedPrice > this.unitPrice) {
      throw new MeterOverbilledError("meter_price_too_high", `unit price ${announcement.unit_price} is above the approved ${this.unitPrice}`, { unit_price: announcement.unit_price });
    }
    const quantity = micro(announcement.quantity, "quantity");
    const allowed = this.#pending > 0n ? this.#pending : this.#maxPerRequest;
    if (allowed !== undefined && quantity > allowed) {
      throw new MeterOverbilledError("meter_quantity_over_expected", `${announcement.quantity} ${this.unit} billed, at most ${plain(allowed)} was requested`, {
        quantity: announcement.quantity, expected: plain(allowed),
      });
    }
    if (meterAmount(announcement.unit_price, quantity) !== amount) {
      throw new MeterOverbilledError("meter_amount_mismatch", `amount ${amount} is not ${announcement.unit_price} × ${announcement.quantity}`, { amount });
    }
  }

  /** Cumulative vouchers above `ceiling()` are rejected. */
  checkVoucher(cumulativeAmount: U128String, epoch: number): void {
    if (epoch !== this.#epoch) throw new MeterOverbilledError("meter_wrong_epoch", `voucher is for epoch ${epoch}, this meter is for epoch ${this.#epoch}: call startEpoch`, { epoch: String(epoch) });
    const cap = this.ceiling();
    if (BigInt(cumulativeAmount) > cap) {
      throw new MeterOverbilledError(
        "meter_overbilled",
        `voucher ${cumulativeAmount} is above the price of ${this.received} ${this.unit} received and ${this.pending} expected (${cap})`,
        { cumulative_amount: cumulativeAmount, ceiling: cap.toString(), received: this.received },
      );
    }
  }

  /** Sign the voucher only if it passes `checkVoucher`. */
  sign(voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Voucher {
    this.checkVoucher(voucher.cumulativeAmount, voucher.epoch);
    return signVoucher(voucher, secretKey);
  }
}
