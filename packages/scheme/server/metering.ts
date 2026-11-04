// Metered price per request (SD-062, pipeline P5, class D): a route's `price` may be a function `(request) => { unit, quantity, unitPrice, maxQuantity? }`, so the price per GB,
// per second, or per job is computed from the request. Units (`GB`, `job`, `second`, ...) live in the SDK, listing, and voucher; the contract does not change. The amount paid is
// `unitPrice × quantity`, rounded up to the smallest credit unit, and the per-request upper bound is announced BEFORE the work: a request above the bound is rejected 413 before
// any 402, so nobody pays for work that will not run.
import { CREDIT_DECIMALS } from "@x207/core";
import { priceToAmount } from "./price.js";

export type MeterQuote = {
  /** Usage unit, e.g. `GB`, `job`, `second`, `call`. ASCII text 1 to 24 characters, `[A-Za-z0-9._/-]`. */
  unit: string;
  /** Number of units this request will work on; a decimal number > 0 with at most 6 decimals. */
  quantity: number | string;
  /** Price of one unit in credit (usual `price` format: `"$0.02"` or `0.02`). */
  unitPrice: string | number;
  /** Upper bound of units for one request; the smaller of the route bound and this bound applies. */
  maxQuantity?: number | string;
};
export type PriceFn = (request: Request) => MeterQuote | Promise<MeterQuote>;

/** Throw from the price function to reject a request before the 402: `status` 400 (default) for invalid input, 413 for above the bound. */
export class MeterRejection extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400, readonly detail: Record<string, string> = {}) {
    super(message);
    this.name = "MeterRejection";
  }
}

/** What is announced in `accepts[x207].extra.meter` (all text): unit, quantity, unit price in the smallest credit unit, and the upper bound if any. */
export type MeterAnnouncement = { unit: string; quantity: string; unit_price: string; max_quantity?: string };

const UNIT = /^[A-Za-z0-9._/-]{1,24}$/;
const QUANTITY = /^(\d+)(?:\.(\d{1,6}))?$/;
const SCALE = 10n ** BigInt(CREDIT_DECIMALS);
const U128_MAX = 340282366920938463463374607431768211455n;

const micro = (value: number | string, name: string): bigint => {
  const text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : "") : value.trim();
  const match = QUANTITY.exec(text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  if (!match) throw new MeterRejection(`${name} must be a decimal number > 0 with at most 6 decimals, got ${JSON.stringify(value)}`);
  const result = BigInt(match[1]!) * SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (result <= 0n) throw new MeterRejection(`${name} must be > 0`);
  return result;
};
const plain = (microValue: bigint): string => {
  const whole = microValue / SCALE;
  const fraction = (microValue % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};

/** `unitPrice × quantity` in the smallest credit unit, rounded up (the seller does not receive less than the price; the difference is at most one smallest unit). */
export function meterAmount(unitPriceAtomic: string, quantityMicro: bigint): string {
  // F8 (review BE-062): BigInt() takes hex, spaces and an empty text; the price is a decimal whole number above 0
  if (!/^[1-9]\d*$/.test(unitPriceAtomic)) throw new MeterRejection(`unit price must be a decimal integer > 0, got ${JSON.stringify(unitPriceAtomic)}`);
  const amount = (BigInt(unitPriceAtomic) * quantityMicro + SCALE - 1n) / SCALE;
  if (amount === 0n) throw new MeterRejection("the amount to pay is 0 after rounding");
  if (amount > U128_MAX) throw new MeterRejection("amount exceeds U128");
  return amount.toString();
}

/**
 * From the route price and request to the amount to pay and its announcement. A static price (text or number) has no announcement: old behavior is unchanged.
 * Throws `MeterRejection` for an invalid unit, an invalid quantity, and a quantity above the bound (413).
 */
export async function resolvePrice(
  price: string | number | PriceFn,
  request: Request,
  routeMaxQuantity?: number | string,
): Promise<{ amount: string; meter?: MeterAnnouncement }> {
  if (typeof price !== "function") return { amount: priceToAmount(price) };
  const quote = await price(request);
  if (!UNIT.test(quote.unit)) throw new MeterRejection(`unit must be 1 to 24 characters [A-Za-z0-9._/-], got ${JSON.stringify(quote.unit)}`);
  const quantity = micro(quote.quantity, "quantity");
  const ceilings = [routeMaxQuantity, quote.maxQuantity].filter((c): c is number | string => c !== undefined).map((c) => micro(c, "maxQuantity"));
  const ceiling = ceilings.length > 0 ? ceilings.reduce((a, b) => (a < b ? a : b)) : undefined;
  if (ceiling !== undefined && quantity > ceiling) {
    throw new MeterRejection(`quantity ${plain(quantity)} ${quote.unit} exceeds the limit ${plain(ceiling)} ${quote.unit} per request`, 413, {
      unit: quote.unit, quantity: plain(quantity), max_quantity: plain(ceiling),
    });
  }
  const unitPrice = priceToAmount(quote.unitPrice);
  return {
    amount: meterAmount(unitPrice, quantity),
    meter: { unit: quote.unit, quantity: plain(quantity), unit_price: unitPrice, ...(ceiling !== undefined ? { max_quantity: plain(ceiling) } : {}) },
  };
}
