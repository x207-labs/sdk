// Listing, penawaran, dan hitungan barter cepat marketplace (SD-055, F9). Nama field mengikuti note F9 dan buku listing D12.
// Format byte dan alasannya: spec/marketplace.md. Fungsi hitung murni, BigInt, tanpa pembulatan float.
import { createHash } from "node:crypto";
import { base58Encode } from "./base58.js";
import { nep413SigningHash, signHash, verifyHash, type VoucherSecretKey } from "./voucher.js";
import { BarterFormatError } from "./barter.js";
import type { AccountId, Ed25519Signature, U128String } from "./types.js";

const U128_MAX = 340282366920938463463374607431768211455n;
const AMOUNT = /^[1-9]\d*$/;
const ASSET_TYPE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const BPS_DENOMINATOR = 10_000n;

/** Kelas aset A/B/C/D dari Fitur F8; kelas `X` ditolak. */
export const ASSET_CLASSES = ["A", "B", "C", "D"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const LISTING_STATUSES = ["open", "matched", "cancelled", "expired"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Satu sisi listing: bentuk aset bebas (`asset_type`), kelas penyerahannya, jumlah, dan nilai total dalam credit. */
export type ListingSide = { asset_type: string; asset_class: AssetClass; quantity: number; value: U128String };

/** Listing "punya `offer`, cari `want`". `status` dikelola buku listing dan tidak ikut ditandatangani. */
export type Listing = {
  circle: AccountId;
  account: AccountId;
  offer: ListingSide;
  want: ListingSide;
  terms: string;
  detail: string;
  /** Detik unix. */
  expires_at: number;
  /** Diskon dalam bps dari nilai `offer` untuk barter cepat. */
  discount_bps: number;
  accept_payment: boolean;
  discoverable: boolean;
  nonce: string;
};

export type OfferMode = "pay" | "barter";

/** Penawaran atau penawaran balik atas listing, satu per ronde. `status` dikelola backend dan tidak ikut ditandatangani. */
export type Offer = {
  circle: AccountId;
  listing_hash: string;
  proposer: AccountId;
  round: number;
  mode: OfferMode;
  value: U128String;
  quantity: number;
  /** Jadwal penyerahan, detik unix. */
  deliver_by: number;
};

const isAccount = (v: unknown): v is AccountId => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const isInt = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const isAmount = (v: unknown): v is U128String => typeof v === "string" && AMOUNT.test(v) && BigInt(v) <= U128_MAX;
const asciiText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);

function checkSide(side: ListingSide, name: string): void {
  if (typeof side !== "object" || side === null) throw new BarterFormatError(`${name} harus objek`);
  if (typeof side.asset_type !== "string" || !ASSET_TYPE.test(side.asset_type)) throw new BarterFormatError(`${name}.asset_type harus ASCII huruf kecil, angka, titik, titik dua, strip atau garis bawah (1-64)`);
  if (!(ASSET_CLASSES as readonly string[]).includes(side.asset_class)) {
    throw new BarterFormatError(`${name}.asset_class ${JSON.stringify(side.asset_class)} ditolak: kelas yang sah A, B, C, atau D`);
  }
  if (!isInt(side.quantity, 1)) throw new BarterFormatError(`${name}.quantity harus integer >= 1`);
  if (!isAmount(side.value)) throw new BarterFormatError(`${name}.value harus string desimal > 0 tanpa nol di depan dan <= U128`);
}

export function validateListing(listing: Listing): void {
  if (!isAccount(listing.circle) || !isAccount(listing.account)) throw new BarterFormatError("circle dan account harus akun NEAR");
  checkSide(listing.offer, "offer");
  checkSide(listing.want, "want");
  if (!asciiText(listing.terms, 512)) throw new BarterFormatError("terms harus teks ASCII maksimal 512 karakter");
  if (!asciiText(listing.detail, 2048)) throw new BarterFormatError("detail harus teks ASCII maksimal 2048 karakter");
  if (!isInt(listing.expires_at, 1)) throw new BarterFormatError("expires_at harus integer detik unix >= 1");
  if (!isInt(listing.discount_bps, 0) || listing.discount_bps > 10_000) throw new BarterFormatError("discount_bps harus integer 0..10000");
  if (typeof listing.accept_payment !== "boolean" || typeof listing.discoverable !== "boolean") throw new BarterFormatError("accept_payment dan discoverable harus boolean");
  if (typeof listing.nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(listing.nonce)) throw new BarterFormatError("nonce harus 1-64 karakter [A-Za-z0-9_-]");
}

export function validateOffer(offer: Offer): void {
  if (!isAccount(offer.circle) || !isAccount(offer.proposer)) throw new BarterFormatError("circle dan proposer harus akun NEAR");
  if (typeof offer.listing_hash !== "string" || !HASH_HEX.test(offer.listing_hash)) throw new BarterFormatError("listing_hash harus heks huruf kecil 64 karakter");
  if (!isInt(offer.round, 1)) throw new BarterFormatError("round harus integer >= 1");
  if (offer.mode !== "pay" && offer.mode !== "barter") throw new BarterFormatError('mode harus "pay" atau "barter"');
  if (!isAmount(offer.value)) throw new BarterFormatError("value harus string desimal > 0 tanpa nol di depan dan <= U128");
  if (!isInt(offer.quantity, 1)) throw new BarterFormatError("quantity harus integer >= 1");
  if (!isInt(offer.deliver_by, 1)) throw new BarterFormatError("deliver_by harus integer detik unix >= 1");
}

const side = (s: ListingSide) => ({ asset_type: s.asset_type, asset_class: s.asset_class, quantity: s.quantity, value: s.value });

/** JSON kanonik listing: key `circle, account, offer, want, terms, detail, expires_at, discount_bps, accept_payment, discoverable, nonce`. */
export function serializeListing(listing: Listing): string {
  validateListing(listing);
  return JSON.stringify({
    circle: listing.circle, account: listing.account, offer: side(listing.offer), want: side(listing.want), terms: listing.terms,
    detail: listing.detail, expires_at: listing.expires_at, discount_bps: listing.discount_bps, accept_payment: listing.accept_payment,
    discoverable: listing.discoverable, nonce: listing.nonce,
  });
}

/** JSON kanonik penawaran: key `circle, listing_hash, proposer, round, mode, value, quantity, deliver_by`. */
export function serializeOffer(offer: Offer): string {
  validateOffer(offer);
  return JSON.stringify({
    circle: offer.circle, listing_hash: offer.listing_hash, proposer: offer.proposer, round: offer.round, mode: offer.mode,
    value: offer.value, quantity: offer.quantity, deliver_by: offer.deliver_by,
  });
}

const sha256 = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const listingHash = (listing: Listing): string => hex(sha256(serializeListing(listing)));
export const listingHashBase58 = (listing: Listing): string => base58Encode(sha256(serializeListing(listing)));
export const offerHash = (offer: Offer): string => hex(sha256(serializeOffer(offer)));

export const listingSigningHash = (listing: Listing): Uint8Array => nep413SigningHash(serializeListing(listing), sha256(serializeListing(listing)), listing.circle);
export const offerSigningHash = (offer: Offer): Uint8Array => nep413SigningHash(serializeOffer(offer), sha256(serializeOffer(offer)), offer.circle);

export const signListing = (listing: Listing, secretKey: VoucherSecretKey): Ed25519Signature => signHash(listingSigningHash(listing), secretKey);
export const signOffer = (offer: Offer, secretKey: VoucherSecretKey): Ed25519Signature => signHash(offerSigningHash(offer), secretKey);

export function verifyListingSignature(listing: Listing, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(listingSigningHash(listing), signature, publicKey);
  } catch {
    return false;
  }
}

export function verifyOfferSignature(offer: Offer, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(offerSigningHash(offer), signature, publicKey);
  } catch {
    return false;
  }
}

/** Parameter pembagian diskon. Tidak ada nilai tetap di kode: pemanggil menetapkannya (contoh note F9: 1000 bps dan 300 bps dari 100 credit). */
export type QuickBarterParams = {
  /** Nilai `offer` listing (credit satuan terkecil). */
  value: U128String;
  /** Diskon dari listing, bps dari `value`. */
  discountBps: number;
  /** Jatah pencari otonom, bps dari `value`; tidak boleh melebihi diskon. */
  searcherShareBps: number;
};

function bpsOf(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new BarterFormatError("bps harus integer 0..10000");
  return (value * BigInt(bps)) / BPS_DENOMINATOR;
}

function split({ value, discountBps, searcherShareBps }: QuickBarterParams) {
  if (!isAmount(value)) throw new BarterFormatError("value harus string desimal > 0 tanpa nol di depan dan <= U128");
  const v = BigInt(value);
  const discount = bpsOf(v, discountBps);
  const searcher = bpsOf(v, searcherShareBps);
  if (searcher > discount) throw new BarterFormatError("jatah pencari tidak boleh melebihi diskon");
  return { v, discount, searcher };
}

/** Jalur bayar: lawan membayar `value − diskon + jatah pencari`; penjual menerima `value − diskon`; pencari menerima jatahnya. */
export type QuickPay = { counterpartyPays: U128String; sellerReceives: U128String; searcher: U128String; discount: U128String };

export function quickPay(params: QuickBarterParams): QuickPay {
  const { v, discount, searcher } = split(params);
  return {
    counterpartyPays: String(v - discount + searcher), sellerReceives: String(v - discount), searcher: String(searcher), discount: String(discount),
  };
}

/**
 * Jalur barter: lawan menyerahkan barang senilai `value` dan menerima `offer` ditambah cashback `diskon − jatah pencari`.
 * Penjual menanggung `diskon` (cashback + jatah pencari). Cashback dan jatah pencari adalah leg bundle biasa.
 */
export type QuickBarter = { cashback: U128String; searcher: U128String; sellerBears: U128String; counterpartyGives: U128String };

export function quickBarter(params: QuickBarterParams): QuickBarter {
  const { v, discount, searcher } = split(params);
  return { cashback: String(discount - searcher), searcher: String(searcher), sellerBears: String(discount), counterpartyGives: String(v) };
}
