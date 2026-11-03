// Harga ke satuan terkecil credit (SD-016): `amount = price × 10^6`, dibulatkan ke bawah, tanpa float.
import { CREDIT_DECIMALS } from "@x207/core";

const PRICE_STRING = /^\$?\s*(\d+)(?:\.(\d+))?$/;
const U128_MAX = 340282366920938463463374607431768211455n;

/** Melempar error untuk harga yang tidak sah, negatif, atau yang menghasilkan 0 setelah pembulatan. */
export function priceToAmount(price: string | number): string {
  let text: string;
  if (typeof price === "number") {
    if (!Number.isFinite(price) || price < 0) throw new Error(`price not valid: ${price}`);
    // toFixed menghindari notasi eksponen; 12 digit cukup untuk membuang derau float 0,29 -> 0.29000000000000004.
    text = price.toFixed(12);
  } else {
    text = price;
  }
  const match = PRICE_STRING.exec(text.trim());
  if (!match) throw new Error(`price not valid: ${JSON.stringify(price)}`);
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(CREDIT_DECIMALS, "0").slice(0, CREDIT_DECIMALS);
  const amount = BigInt(whole) * 10n ** BigInt(CREDIT_DECIMALS) + BigInt(fraction);
  if (amount === 0n) throw new Error(`harga ${JSON.stringify(price)} menghasilkan 0 unit; minimal 0.000001`);
  if (amount > U128_MAX) throw new Error(`harga ${JSON.stringify(price)} melebihi U128`);
  return amount.toString();
}
