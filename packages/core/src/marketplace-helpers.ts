// Helper marketplace untuk developer agent (SD-056, F9): `postListing`, `counterOffer`, `acceptOffer`.
// Hanya membangun dan menandatangani payload; pengiriman ke buku listing (backend) dilakukan pemanggil dengan transportnya sendiri.
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

/** Tanda tangani listing dengan kunci voucher pemasang. `listing.account` harus pemilik kunci itu. */
export function postListing(listing: Listing, secretKey: VoucherSecretKey): SignedListing {
  serializeListing(listing);
  return { listing, listing_hash: listingHash(listing), signature: signListing(listing, secretKey) };
}

export type CounterOfferInput = {
  listing: Listing;
  /** Akun penawar. */
  proposer: AccountId;
  mode: OfferMode;
  value: U128String;
  quantity: number;
  deliver_by: number;
  /** Penawaran lawan yang dijawab; ronde baru = ronde itu + 1. Kosong untuk penawaran pertama. */
  previous?: Offer;
  /** Waktu sekarang (detik unix), untuk menolak listing yang sudah kedaluwarsa. */
  now: number;
};

/** Penawaran atau penawaran balik bertanda tangan atas listing. */
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
  /** Epoch tempat bundle berjalan. */
  epoch: number;
  /** Pencari otonom yang membawa tawaran ini, bila ada; jatahnya `searcherShareBps` dari nilai `offer` listing. */
  searcher?: AccountId;
  searcherShareBps?: number;
  /**
   * Lawan pemasang listing di utas ini. Default `offer.proposer`, benar bila yang diterima penawaran lawan; isi bila yang diterima
   * penawaran balik pemasang (proposer = pemasang) supaya leg tetap antara pemasang dan lawan.
   */
  counterparty?: AccountId;
};

export type AcceptInput = PlanInput & {
  /** Akun penerima dan kunci voucher yang menandatangani. */
  account: AccountId;
};

/** Hasil penerimaan tanpa tanda tangan: `discount` dan `searcher` dalam credit (satuan terkecil) dipakai statistik marketplace. */
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
 * Hitung hasil penerimaan penawaran tanpa kunci: leg bundle sesuai note F9, atau satu pembayaran bila tidak perlu bundle.
 * Jalur bayar: lawan membayar penjual `value − diskon` dan pencari jatahnya (tanpa pencari cukup satu pembayaran voucher).
 * `value` yang dihitung adalah `Offer.value` penawaran yang diterima, yaitu nilai kesepakatan untuk sisi `offer` listing (bukan nilai
 * awal di listing), jadi harga hasil tawar-menawar menentukan jumlah leg. Diskon dan jatah pencari dihitung dari nilai itu.
 * Jalur barter: penjual membayar `want.value + cashback` ke lawan, lawan membayar `Offer.value` ke penjual, penjual membayar
 * pencari jatahnya; setelah kliring penjual menanggung cashback + jatah pencari. Bila ada leg untuk pencari, syaratnya memuat `search_leg` (interface 0.0.5), jadi agent, backend dan solver menghitung `terms_hash` yang sama.
 * Backend memakai fungsi ini untuk menghitung ulang `terms_hash` yang diajukan klien.
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
  /** Leg yang membayar pencari; hanya ada bila jatahnya > 0 sehingga ada legnya. */
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
  // Interface 0.0.5: leg pencari disebut di syarat yang ditandatangani (`search_leg`) supaya kontrak membatasinya dengan `max_search_share_bps`.
  // Tanpa pencari bytes dan `terms_hash` sama dengan format lama.
  const terms: BundleTerms = { circle: listing.circle, epoch: input.epoch, legs, ...(searchLeg ? { search_leg: searchLeg } : {}) };
  return { kind: "bundle", terms, terms_hash: termsHash(terms), discount, searcher };
}

/** Terima penawaran: hitung rencana dengan `planOffer` dan tandatangani `terms_hash` untuk `account`. */
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

/** Periksa tanda tangan listing dan penawaran yang diterima dari akun lain; `false` untuk apa pun yang tidak sah. */
export const verifySignedListing = (signed: SignedListing, publicKey: string): boolean =>
  signed.listing_hash === listingHash(signed.listing) && verifyListingSignature(signed.listing, signed.signature, publicKey);
export const verifySignedOffer = (signed: SignedOffer, publicKey: string): boolean =>
  signed.offer_hash === offerHash(signed.offer) && verifyOfferSignature(signed.offer, signed.signature, publicKey);
