// Marketplace helpers for agent developers (SD-056, F9): `postListing`, `counterOffer`, `acceptOffer`.
// They only build and sign payloads; sending to the listing book (backend) is done by the caller with its own transport.
import { BarterFormatError, bundleParticipants, signBundle, termsHash, type BundleSignature, type BundleTerms, type SearchLeg } from "./barter.js";
import type { BundleLeg } from "./events.js";
import {
  listingHash, offerHash, quickBarter, quickPay, serializeListing, signListing, signOffer, verifyListingSignature, verifyOfferSignature,
  type Listing, type Offer, type OfferMode,
} from "./marketplace.js";
import { type VoucherSecretKey } from "./voucher.js";
import type { AccountId, Ed25519Signature, U128String } from "./types.js";

export type SignedListing = { listing: Listing; listing_hash: string; signature: Ed25519Signature };
export type SignedOffer = { offer: Offer; offer_hash: string; signature: Ed25519Signature };

/** Sign a listing with the poster's voucher key. `listing.account` must own that key. */
export function postListing(listing: Listing, secretKey: VoucherSecretKey): SignedListing {
  serializeListing(listing);
  return { listing, listing_hash: listingHash(listing), signature: signListing(listing, secretKey) };
}

export type CounterOfferInput = {
  listing: Listing;
  /** Bidder account. */
  proposer: AccountId;
  mode: OfferMode;
  value: U128String;
  quantity: number;
  deliver_by: number;
  /** The counterparty offer being answered; the new round = that round + 1. Empty for the first offer. */
  previous?: Offer;
  /** Current time (unix seconds), used to reject listings that have already expired. */
  now: number;
};

/** A signed offer or counter-offer on a listing. */
export function counterOffer(input: CounterOfferInput, secretKey: VoucherSecretKey): SignedOffer {
  const { listing, previous } = input;
  const hash = listingHash(listing);
  if (listing.expires_at <= input.now) throw new BarterFormatError("listing is expired");
  if (input.mode === "pay" && !listing.accept_payment) throw new BarterFormatError("listing does not accept payment (accept_payment false)");
  if (input.proposer === listing.account && previous === undefined) throw new BarterFormatError("the listing poster must not bid on its own listing");
  if (previous !== undefined) {
    if (previous.listing_hash !== hash) throw new BarterFormatError("the previous offer is for another listing");
    if (previous.proposer === input.proposer) throw new BarterFormatError("the next round must come from the opposing party");
  }
  const offer: Offer = {
    circle: listing.circle, listing_hash: hash, proposer: input.proposer, round: (previous?.round ?? 0) + 1, mode: input.mode,
    value: input.value, quantity: input.quantity, deliver_by: input.deliver_by,
  };
  return { offer, offer_hash: offerHash(offer), signature: signOffer(offer, secretKey) };
}

export type PlanInput = {
  listing: Listing;
  offer: Offer;
  /** The epoch in which the bundle runs. */
  epoch: number;
  /** The autonomous searcher who brought this offer, if any; their share is `searcherShareBps` of the listing's `offer` value. */
  searcher?: AccountId;
  searcherShareBps?: number;
  /**
   * The counterparty of the listing poster in this thread. Defaults to `offer.proposer`, correct when the accepted offer is a counterparty offer; set it when the accepted
   * offer is the poster's counter-offer (proposer = poster) so the leg stays between the poster and the counterparty.
   */
  counterparty?: AccountId;
};

export type AcceptInput = PlanInput & {
  /** The receiving account and the voucher key that signs. */
  account: AccountId;
};

/** Acceptance result without a signature: `discount` and `searcher` in credit (smallest unit) are used for marketplace statistics. */
export type OfferPlan =
  | { kind: "payment"; payer: AccountId; payee: AccountId; amount: U128String; discount: U128String; searcher: U128String }
  | { kind: "bundle"; terms: BundleTerms; terms_hash: string; discount: U128String; searcher: U128String };

export type AcceptResult =
  | { kind: "payment"; payer: AccountId; payee: AccountId; amount: U128String }
  | { kind: "bundle"; terms: BundleTerms; terms_hash: string; signature: BundleSignature };

function leg(payer: AccountId, payee: AccountId, amount: bigint): BundleLeg[] {
  return amount > 0n ? [{ payer, payee, max_amount: String(amount) }] : [];
}

/**
 * Compute the result of accepting an offer without keys: the bundle legs per the F9 note, or a single payment when no bundle is needed.
 * Pay path: the counterparty pays the seller `value − discount` and the searcher their share (without a searcher a single voucher payment is enough).
 * The `value` computed is the `Offer.value` of the accepted offer, i.e. the agreed value for the listing's `offer` side (not the initial
 * value in the listing), so the price from bargaining sets the leg amounts. The discount and searcher share are computed from that value.
 * Barter path: the seller pays `want.value + cashback` to the counterparty, the counterparty pays `Offer.value` to the seller, the seller pays
 * the searcher their share; after clearing the seller bears cashback + searcher share. When there is a leg for the searcher, the terms include `search_leg` (interface 0.0.5), so agent, backend and solver compute the same `terms_hash`.
 * The backend uses this function to recompute the `terms_hash` submitted by the client.
 */
export function planOffer(input: PlanInput): OfferPlan {
  const { listing, offer } = input;
  if (offer.listing_hash !== listingHash(listing)) throw new BarterFormatError("offer is for another listing");
  if (offer.circle !== listing.circle) throw new BarterFormatError("offer circle differs");
  const seller = listing.account;
  const counterparty = input.counterparty ?? offer.proposer;
  if (counterparty === seller) throw new BarterFormatError("the counterparty must not be the same as the listing poster");
  const searcherShareBps = input.searcher ? (input.searcherShareBps ?? 0) : 0;
  const params = { value: offer.value, discountBps: listing.discount_bps, searcherShareBps };
  let legs: BundleLeg[];
  let discount: U128String;
  let searcher: U128String;
  /** The leg that pays the searcher; exists only when their share is > 0 so that a leg exists. */
  let searchLeg: SearchLeg | undefined;
  if (offer.mode === "pay") {
    if (!listing.accept_payment) throw new BarterFormatError("listing does not accept payment");
    const pay = quickPay(params);
    discount = pay.discount;
    searcher = input.searcher ? pay.searcher : "0";
    const searchLegs = input.searcher ? leg(counterparty, input.searcher, BigInt(pay.searcher)) : [];
    if (searchLegs.length > 0) searchLeg = { payer: counterparty, payee: input.searcher! };
    legs = [...leg(counterparty, seller, BigInt(pay.sellerReceives)), ...searchLegs];
    if (legs.length === 1) return { kind: "payment", payer: counterparty, payee: seller, amount: legs[0]!.max_amount, discount, searcher };
  } else {
    const barter = quickBarter(params);
    discount = barter.sellerBears;
    searcher = input.searcher ? barter.searcher : "0";
    const searchLegs = input.searcher ? leg(seller, input.searcher, BigInt(barter.searcher)) : [];
    if (searchLegs.length > 0) searchLeg = { payer: seller, payee: input.searcher! };
    legs = [
      ...leg(seller, counterparty, BigInt(listing.want.value) + BigInt(barter.cashback)),
      ...leg(counterparty, seller, BigInt(offer.value)),
      ...searchLegs,
    ];
  }
  // Interface 0.0.5: the searcher leg is named in the signed terms (`search_leg`) so the contract limits it with `max_search_share_bps`.
  // Without a searcher the bytes and `terms_hash` equal the old format.
  const terms: BundleTerms = { circle: listing.circle, epoch: input.epoch, legs, ...(searchLeg ? { search_leg: searchLeg } : {}) };
  return { kind: "bundle", terms, terms_hash: termsHash(terms), discount, searcher };
}

/** Accept an offer: compute the plan with `planOffer` and sign the `terms_hash` for `account`. */
export function acceptOffer(input: AcceptInput, secretKey: VoucherSecretKey): AcceptResult {
  const { listing, offer } = input;
  if (offer.listing_hash !== listingHash(listing)) throw new BarterFormatError("offer is for another listing");
  if (offer.circle !== listing.circle) throw new BarterFormatError("offer circle differs");
  if (input.account !== listing.account && input.account !== offer.proposer && input.account !== input.counterparty) throw new BarterFormatError("only a party of the listing may accept");
  const plan = planOffer(input);
  if (plan.kind === "payment") return { kind: "payment", payer: plan.payer, payee: plan.payee, amount: plan.amount };
  if (!bundleParticipants(plan.terms).includes(input.account)) throw new BarterFormatError("the receiving account is not a bundle participant");
  return { kind: "bundle", terms: plan.terms, terms_hash: plan.terms_hash, signature: signBundle(plan.terms, input.account, secretKey) };
}

/** Check the signature of a listing and of an offer received from another account; `false` for anything not valid. */
export const verifySignedListing = (signed: SignedListing, publicKey: string): boolean =>
  signed.listing_hash === listingHash(signed.listing) && verifyListingSignature(signed.listing, signed.signature, publicKey);
export const verifySignedOffer = (signed: SignedOffer, publicKey: string): boolean =>
  signed.offer_hash === offerHash(signed.offer) && verifyOfferSignature(signed.offer, signed.signature, publicKey);
