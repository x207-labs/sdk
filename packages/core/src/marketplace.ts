// Marketplace listings, offers, and fast barter arithmetic (SD-055, F9). Field names follow the F9 note and the D12 listing book.
// Byte format and rationale: spec/marketplace.md. The arithmetic functions are pure, BigInt, with no float rounding.
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

/** Asset class A/B/C/D from Feature F8; class `X` is rejected. */
export const ASSET_CLASSES = ["A", "B", "C", "D"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
export const LISTING_STATUSES = ["open", "matched", "cancelled", "expired"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** One listing side: a free-form asset shape (`asset_type`), its handover class, quantity, and total value in credit. */
export type ListingSide = { asset_type: string; asset_class: AssetClass; quantity: number; value: U128String };

/** A listing "has `offer`, seeks `want`". `status` is managed by the listing book and is not signed. */
export type Listing = {
  circle: AccountId;
  account: AccountId;
  offer: ListingSide;
  want: ListingSide;
  terms: string;
  detail: string;
  /** Unix seconds. */
  expires_at: number;
  /** Discount in bps of the `offer` value for fast barter. */
  discount_bps: number;
  accept_payment: boolean;
  discoverable: boolean;
  nonce: string;
};

export type OfferMode = "pay" | "barter";

/** An offer or counter-offer on a listing, one per round. `status` is managed by the backend and is not signed. */
export type Offer = {
  circle: AccountId;
  listing_hash: string;
  proposer: AccountId;
  round: number;
  mode: OfferMode;
  value: U128String;
  quantity: number;
  /** Handover schedule, unix seconds. */
  deliver_by: number;
};

const isAccount = (v: unknown): v is AccountId => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const isInt = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const isAmount = (v: unknown): v is U128String => typeof v === "string" && AMOUNT.test(v) && BigInt(v) <= U128_MAX;
const asciiText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && /^[\x20-\x7e]*$/.test(v);

function checkSide(side: ListingSide, name: string): void {
  if (typeof side !== "object" || side === null) throw new BarterFormatError(`${name} must be an object`);
  if (typeof side.asset_type !== "string" || !ASSET_TYPE.test(side.asset_type)) throw new BarterFormatError(`${name}.asset_type must be ASCII lowercase letters, digits, dot, colon, hyphen or underscore (1-64)`);
  if (!(ASSET_CLASSES as readonly string[]).includes(side.asset_class)) {
    throw new BarterFormatError(`${name}.asset_class ${JSON.stringify(side.asset_class)} rejected: valid classes are A, B, C, or D`);
  }
  if (!isInt(side.quantity, 1)) throw new BarterFormatError(`${name}.quantity must be an integer >= 1`);
  if (!isAmount(side.value)) throw new BarterFormatError(`${name}.value must be a decimal string > 0 with no leading zeros and <= U128`);
}

export function validateListing(listing: Listing): void {
  if (!isAccount(listing.circle) || !isAccount(listing.account)) throw new BarterFormatError("circle and account must be NEAR accounts");
  checkSide(listing.offer, "offer");
  checkSide(listing.want, "want");
  if (!asciiText(listing.terms, 512)) throw new BarterFormatError("terms must be ASCII text of at most 512 characters");
  if (!asciiText(listing.detail, 2048)) throw new BarterFormatError("detail must be ASCII text of at most 2048 characters");
  if (!isInt(listing.expires_at, 1)) throw new BarterFormatError("expires_at must be an integer of unix seconds >= 1");
  if (!isInt(listing.discount_bps, 0) || listing.discount_bps > 10_000) throw new BarterFormatError("discount_bps must be an integer 0..10000");
  if (typeof listing.accept_payment !== "boolean" || typeof listing.discoverable !== "boolean") throw new BarterFormatError("accept_payment and discoverable must be booleans");
  if (typeof listing.nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(listing.nonce)) throw new BarterFormatError("nonce must be 1-64 characters [A-Za-z0-9_-]");
}

export function validateOffer(offer: Offer): void {
  if (!isAccount(offer.circle) || !isAccount(offer.proposer)) throw new BarterFormatError("circle and proposer must be NEAR accounts");
  if (typeof offer.listing_hash !== "string" || !HASH_HEX.test(offer.listing_hash)) throw new BarterFormatError("listing_hash must be 64 lowercase hex characters");
  if (!isInt(offer.round, 1)) throw new BarterFormatError("round must be an integer >= 1");
  if (offer.mode !== "pay" && offer.mode !== "barter") throw new BarterFormatError('mode must be "pay" or "barter"');
  if (!isAmount(offer.value)) throw new BarterFormatError("value must be a decimal string > 0 with no leading zeros and <= U128");
  if (!isInt(offer.quantity, 1)) throw new BarterFormatError("quantity must be an integer >= 1");
  if (!isInt(offer.deliver_by, 1)) throw new BarterFormatError("deliver_by must be an integer of unix seconds >= 1");
}

const side = (s: ListingSide) => ({ asset_type: s.asset_type, asset_class: s.asset_class, quantity: s.quantity, value: s.value });

/** Canonical listing JSON: keys `circle, account, offer, want, terms, detail, expires_at, discount_bps, accept_payment, discoverable, nonce`. */
export function serializeListing(listing: Listing): string {
  validateListing(listing);
  return JSON.stringify({
    circle: listing.circle, account: listing.account, offer: side(listing.offer), want: side(listing.want), terms: listing.terms,
    detail: listing.detail, expires_at: listing.expires_at, discount_bps: listing.discount_bps, accept_payment: listing.accept_payment,
    discoverable: listing.discoverable, nonce: listing.nonce,
  });
}

/** Canonical offer JSON: keys `circle, listing_hash, proposer, round, mode, value, quantity, deliver_by`. */
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

/** Discount split parameters. No fixed value in code: the caller sets them (F9 note example: 1000 bps and 300 bps of 100 credit). */
export type QuickBarterParams = {
  /** The listing's `offer` value (credit, smallest unit). */
  value: U128String;
  /** Discount from the listing, bps of `value`. */
  discountBps: number;
  /** Autonomous searcher share, bps of `value`; must not exceed the discount. */
  searcherShareBps: number;
};

function bpsOf(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new BarterFormatError("bps must be an integer 0..10000");
  return (value * BigInt(bps)) / BPS_DENOMINATOR;
}

function split({ value, discountBps, searcherShareBps }: QuickBarterParams) {
  if (!isAmount(value)) throw new BarterFormatError("value must be a decimal string > 0 with no leading zeros and <= U128");
  const v = BigInt(value);
  const discount = bpsOf(v, discountBps);
  const searcher = bpsOf(v, searcherShareBps);
  if (searcher > discount) throw new BarterFormatError("the seeker share must not exceed the discount");
  return { v, discount, searcher };
}

/** Pay path: the counterparty pays `value − discount + searcher share`; the seller receives `value − discount`; the searcher receives their share. */
export type QuickPay = { counterpartyPays: U128String; sellerReceives: U128String; searcher: U128String; discount: U128String };

export function quickPay(params: QuickBarterParams): QuickPay {
  const { v, discount, searcher } = split(params);
  return {
    counterpartyPays: String(v - discount + searcher), sellerReceives: String(v - discount), searcher: String(searcher), discount: String(discount),
  };
}

/**
 * Barter path: the counterparty hands over goods worth `value` and receives `offer` plus cashback `discount − searcher share`.
 * The seller bears the `discount` (cashback + searcher share). Cashback and searcher share are ordinary bundle legs.
 */
export type QuickBarter = { cashback: U128String; searcher: U128String; sellerBears: U128String; counterpartyGives: U128String };

export function quickBarter(params: QuickBarterParams): QuickBarter {
  const { v, discount, searcher } = split(params);
  return { cashback: String(discount - searcher), searcher: String(searcher), sellerBears: String(discount), counterpartyGives: String(v) };
}

/** Listing cancellation message signed by the poster: `x207:cancel_listing:<listing_hash>`. */
export const cancelListingMessage = (hash: string): string => `x207:cancel_listing:${hash}`;

function cancelSigningHash(listing: Listing): Uint8Array {
  const message = cancelListingMessage(listingHash(listing));
  return nep413SigningHash(message, sha256(message), listing.circle);
}

export const signCancelListing = (listing: Listing, secretKey: VoucherSecretKey): Ed25519Signature => signHash(cancelSigningHash(listing), secretKey);

/** Signing hash for cancellation from the listing hash and the circle contract account (used by a server that stores only the hash). */
export function cancelSigningHashFor(hash: string, circle: AccountId): Uint8Array {
  const message = cancelListingMessage(hash);
  return nep413SigningHash(message, sha256(message), circle);
}

export function verifyCancelSignature(hash: string, circle: AccountId, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(cancelSigningHashFor(hash, circle), signature, publicKey);
  } catch {
    return false;
  }
}

// --- Searcher invitation (SV-015, FIT-F9-08) ---

/**
 * Invitation from an autonomous searcher to agent `to` to bid on `listing_hash`: prepared offer fields (method, value, quantity, schedule) and the searcher
 * share in bps of the agreed value. Signed by the searcher with the voucher key; the actual offer must still be signed by agent `to`.
 */
export type Referral = {
  circle: AccountId;
  seeker: AccountId;
  to: AccountId;
  listing_hash: string;
  mode: OfferMode;
  value: U128String;
  quantity: number;
  deliver_by: number;
  searcher_share_bps: number;
  /** Unix seconds; an expired invitation does not appear in the inbox. */
  expires_at: number;
  nonce: string;
};

export function validateReferral(referral: Referral): void {
  if (!isAccount(referral.circle) || !isAccount(referral.seeker) || !isAccount(referral.to)) throw new BarterFormatError("circle, seeker, and to must be NEAR accounts");
  if (referral.seeker === referral.to) throw new BarterFormatError("the seeker must not refer themselves");
  if (typeof referral.listing_hash !== "string" || !HASH_HEX.test(referral.listing_hash)) throw new BarterFormatError("listing_hash must be 64 lowercase hex characters");
  if (referral.mode !== "pay" && referral.mode !== "barter") throw new BarterFormatError('mode must be "pay" or "barter"');
  if (!isAmount(referral.value)) throw new BarterFormatError("value must be a decimal string > 0 with no leading zeros and <= U128");
  if (!isInt(referral.quantity, 1)) throw new BarterFormatError("quantity must be an integer >= 1");
  if (!isInt(referral.deliver_by, 1)) throw new BarterFormatError("deliver_by must be an integer of unix seconds >= 1");
  if (!isInt(referral.searcher_share_bps, 0) || referral.searcher_share_bps > 10_000) throw new BarterFormatError("searcher_share_bps must be an integer 0..10000");
  if (!isInt(referral.expires_at, 1)) throw new BarterFormatError("expires_at must be an integer of unix seconds >= 1");
  if (typeof referral.nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(referral.nonce)) throw new BarterFormatError("nonce must be 1-64 characters [A-Za-z0-9_-]");
}

/** Canonical invitation JSON: keys `circle, seeker, to, listing_hash, mode, value, quantity, deliver_by, searcher_share_bps, expires_at, nonce`. */
export function serializeReferral(referral: Referral): string {
  validateReferral(referral);
  return JSON.stringify({
    circle: referral.circle, seeker: referral.seeker, to: referral.to, listing_hash: referral.listing_hash, mode: referral.mode, value: referral.value,
    quantity: referral.quantity, deliver_by: referral.deliver_by, searcher_share_bps: referral.searcher_share_bps, expires_at: referral.expires_at,
    nonce: referral.nonce,
  });
}

export const referralHash = (referral: Referral): string => hex(sha256(serializeReferral(referral)));
export const referralSigningHash = (referral: Referral): Uint8Array =>
  nep413SigningHash(serializeReferral(referral), sha256(serializeReferral(referral)), referral.circle);
export const signReferral = (referral: Referral, secretKey: VoucherSecretKey): Ed25519Signature => signHash(referralSigningHash(referral), secretKey);

export function verifyReferralSignature(referral: Referral, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(referralSigningHash(referral), signature, publicKey);
  } catch {
    return false;
  }
}

/** Referral refusal message signed by the target agent: `x207:refuse_referral:<referral_hash>`. */
export const refuseReferralMessage = (hash: string): string => `x207:refuse_referral:${hash}`;

export function refuseReferralSigningHash(hash: string, circle: AccountId): Uint8Array {
  const message = refuseReferralMessage(hash);
  return nep413SigningHash(message, sha256(message), circle);
}

export const signRefuseReferral = (hash: string, circle: AccountId, secretKey: VoucherSecretKey): Ed25519Signature =>
  signHash(refuseReferralSigningHash(hash, circle), secretKey);

export function verifyRefuseReferral(hash: string, circle: AccountId, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(refuseReferralSigningHash(hash, circle), signature, publicKey);
  } catch {
    return false;
  }
}
