// Harga terukur per request (SD-062, pipeline P5, kelas D): `price` sebuah route boleh berupa fungsi `(request) => { unit, quantity, unitPrice, maxQuantity? }`, jadi harga per GB,
// per detik, atau per job dihitung dari request. Satuan (`GB`, `job`, `second`, ...) hidup di SDK, listing, dan voucher; kontrak tidak berubah. Jumlah yang dibayar adalah
// `unitPrice × quantity`, dibulatkan ke atas ke satuan credit terkecil, dan batas atas per request diumumkan SEBELUM kerja: request di atas batas ditolak 413 sebelum
// ada 402, jadi tidak ada yang membayar untuk kerja yang tidak akan dijalankan.
import { CREDIT_DECIMALS } from "@x207/core";
import { priceToAmount } from "./price.js";

export type MeterQuote = {
  /** Satuan pemakaian, mis. `GB`, `job`, `second`, `call`. Teks ASCII 1 sampai 24 karakter, `[A-Za-z0-9._/-]`. */
  unit: string;
  /** Jumlah satuan yang akan dikerjakan request ini; angka desimal > 0 dengan paling banyak 6 desimal. */
  quantity: number | string;
  /** Harga satu satuan dalam credit (format `price` biasa: `"$0.02"` atau `0.02`). */
  unitPrice: string | number;
  /** Batas atas satuan untuk satu request; yang lebih kecil dari batas route dan batas ini yang berlaku. */
  maxQuantity?: number | string;
};
export type PriceFn = (request: Request) => MeterQuote | Promise<MeterQuote>;

/** Lemparkan dari fungsi harga untuk menolak request sebelum 402: `status` 400 (bawaan) untuk masukan yang tidak sah, 413 untuk di atas batas. */
export class MeterRejection extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400, readonly detail: Record<string, string> = {}) {
    super(message);
    this.name = "MeterRejection";
  }
}

/** Yang diumumkan di `accepts[x207].extra.meter` (semua teks): satuan, jumlah, harga satuan dalam satuan credit terkecil, dan batas atas bila ada. */
export type MeterAnnouncement = { unit: string; quantity: string; unit_price: string; max_quantity?: string };

const UNIT = /^[A-Za-z0-9._/-]{1,24}$/;
const QUANTITY = /^(\d+)(?:\.(\d{1,6}))?$/;
const SCALE = 10n ** BigInt(CREDIT_DECIMALS);
const U128_MAX = 340282366920938463463374607431768211455n;

const micro = (value: number | string, name: string): bigint => {
  const text = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : "") : value.trim();
  const match = QUANTITY.exec(text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  if (!match) throw new MeterRejection(`${name} harus angka desimal > 0 dengan paling banyak 6 desimal, dapat ${JSON.stringify(value)}`);
  const result = BigInt(match[1]!) * SCALE + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (result <= 0n) throw new MeterRejection(`${name} harus > 0`);
  return result;
};
const plain = (microValue: bigint): string => {
  const whole = microValue / SCALE;
  const fraction = (microValue % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
};

/** `unitPrice × quantity` dalam satuan credit terkecil, dibulatkan ke atas (penjual tidak menerima kurang dari harganya; selisih paling banyak satu satuan terkecil). */
export function meterAmount(unitPriceAtomic: string, quantityMicro: bigint): string {
  const amount = (BigInt(unitPriceAtomic) * quantityMicro + SCALE - 1n) / SCALE;
  if (amount === 0n) throw new MeterRejection("jumlah yang harus dibayar 0 setelah pembulatan");
  if (amount > U128_MAX) throw new MeterRejection("jumlah melebihi U128");
  return amount.toString();
}

/**
 * Dari harga route dan request ke jumlah yang harus dibayar dan pengumumannya. Harga statis (teks atau angka) tidak punya pengumuman: perilaku lama tidak berubah.
 * Melempar `MeterRejection` untuk satuan yang tidak sah, jumlah yang tidak sah, dan jumlah di atas batas (413).
 */
export async function resolvePrice(
  price: string | number | PriceFn,
  request: Request,
  routeMaxQuantity?: number | string,
): Promise<{ amount: string; meter?: MeterAnnouncement }> {
  if (typeof price !== "function") return { amount: priceToAmount(price) };
  const quote = await price(request);
  if (!UNIT.test(quote.unit)) throw new MeterRejection(`unit harus 1 sampai 24 karakter [A-Za-z0-9._/-], dapat ${JSON.stringify(quote.unit)}`);
  const quantity = micro(quote.quantity, "quantity");
  const ceilings = [routeMaxQuantity, quote.maxQuantity].filter((c): c is number | string => c !== undefined).map((c) => micro(c, "maxQuantity"));
  const ceiling = ceilings.length > 0 ? ceilings.reduce((a, b) => (a < b ? a : b)) : undefined;
  if (ceiling !== undefined && quantity > ceiling) {
    throw new MeterRejection(`jumlah ${plain(quantity)} ${quote.unit} melebihi batas ${plain(ceiling)} ${quote.unit} per request`, 413, {
      unit: quote.unit, quantity: plain(quantity), max_quantity: plain(ceiling),
    });
  }
  const unitPrice = priceToAmount(quote.unitPrice);
  return {
    amount: meterAmount(unitPrice, quantity),
    meter: { unit: quote.unit, quantity: plain(quantity), unit_price: unitPrice, ...(ceiling !== undefined ? { max_quantity: plain(ceiling) } : {}) },
  };
}
