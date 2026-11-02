// Helper marketplace untuk developer agent (SD-056, F9): `postListing`, `counterOffer`, `acceptOffer`.
// Hanya membangun dan menandatangani payload; pengiriman ke buku listing (backend) dilakukan pemanggil dengan transportnya sendiri.
import { BarterFormatError, bundleParticipants, signBundle, termsHash, type BundleSignature, type BundleTerms } from "./barter.js";
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
  if (listing.expires_at <= input.now) throw new BarterFormatError("listing sudah kedaluwarsa");
  if (input.mode === "pay" && !listing.accept_payment) throw new BarterFormatError("listing tidak menerima pembayaran (accept_payment false)");
  if (input.proposer === listing.account && previous === undefined) throw new BarterFormatError("pemasang listing tidak menawar listingnya sendiri");
  if (previous !== undefined) {
    if (previous.listing_hash !== hash) throw new BarterFormatError("penawaran sebelumnya untuk listing lain");
    if (previous.proposer === input.proposer) throw new BarterFormatError("ronde berikutnya harus dari pihak lawan");
  }
  const offer: Offer = {
    circle: listing.circle, listing_hash: hash, proposer: input.proposer, round: (previous?.round ?? 0) + 1, mode: input.mode,
    value: input.value, quantity: input.quantity, deliver_by: input.deliver_by,
  };
  return { offer, offer_hash: offerHash(offer), signature: signOffer(offer, secretKey) };
}

export type AcceptInput = {
  listing: Listing;
  offer: Offer;
  /** Epoch tempat bundle berjalan. */
  epoch: number;
  /** Pencari otonom yang membawa tawaran ini, bila ada; jatahnya `searcherShareBps` dari nilai `offer` listing. */
  searcher?: AccountId;
  searcherShareBps?: number;
  /** Akun penerima dan kunci voucher yang menandatangani. */
  account: AccountId;
};

export type AcceptResult =
  | { kind: "payment"; payer: AccountId; payee: AccountId; amount: U128String }
  | { kind: "bundle"; terms: BundleTerms; terms_hash: string; signature: BundleSignature };

function leg(payer: AccountId, payee: AccountId, amount: bigint): BundleLeg[] {
  return amount > 0n ? [{ payer, payee, max_amount: String(amount) }] : [];
}

/**
 * Terima penawaran: bangun leg sesuai note F9 dan tandatangani `terms_hash` untuk `account`.
 * Jalur bayar: lawan membayar penjual `value − diskon` dan pencari jatahnya (tanpa pencari cukup satu pembayaran voucher).
 * Jalur barter: penjual membayar `want.value + cashback` ke lawan, lawan membayar `offer.value` ke penjual, penjual membayar
 * pencari jatahnya; setelah kliring penjual menanggung cashback + jatah pencari.
 */
export function acceptOffer(input: AcceptInput, secretKey: VoucherSecretKey): AcceptResult {
  const { listing, offer } = input;
  if (offer.listing_hash !== listingHash(listing)) throw new BarterFormatError("penawaran untuk listing lain");
  if (offer.circle !== listing.circle) throw new BarterFormatError("lingkaran penawaran berbeda");
  if (input.account !== listing.account && input.account !== offer.proposer) throw new BarterFormatError("hanya pihak listing yang boleh menerima");
  const seller = listing.account;
  const counterparty = offer.proposer;
  const searcherShareBps = input.searcher ? (input.searcherShareBps ?? 0) : 0;
  const params = { value: listing.offer.value, discountBps: listing.discount_bps, searcherShareBps };
  let legs: BundleLeg[];
  if (offer.mode === "pay") {
    if (!listing.accept_payment) throw new BarterFormatError("listing tidak menerima pembayaran");
    const pay = quickPay(params);
    legs = [...leg(counterparty, seller, BigInt(pay.sellerReceives)), ...(input.searcher ? leg(counterparty, input.searcher, BigInt(pay.searcher)) : [])];
    if (legs.length === 1) return { kind: "payment", payer: counterparty, payee: seller, amount: legs[0]!.max_amount };
  } else {
    const barter = quickBarter(params);
    legs = [
      ...leg(seller, counterparty, BigInt(listing.want.value) + BigInt(barter.cashback)),
      ...leg(counterparty, seller, BigInt(listing.offer.value)),
      ...(input.searcher ? leg(seller, input.searcher, BigInt(barter.searcher)) : []),
    ];
  }
  const terms: BundleTerms = { circle: listing.circle, epoch: input.epoch, legs };
  if (!bundleParticipants(terms).includes(input.account)) throw new BarterFormatError("akun penerima bukan peserta bundle");
  return { kind: "bundle", terms, terms_hash: termsHash(terms), signature: signBundle(terms, input.account, secretKey) };
}

/** Periksa tanda tangan listing dan penawaran yang diterima dari akun lain; `false` untuk apa pun yang tidak sah. */
export const verifySignedListing = (signed: SignedListing, publicKey: string): boolean =>
  signed.listing_hash === listingHash(signed.listing) && verifyListingSignature(signed.listing, signed.signature, publicKey);
export const verifySignedOffer = (signed: SignedOffer, publicKey: string): boolean =>
  signed.offer_hash === offerHash(signed.offer) && verifyOfferSignature(signed.offer, signed.signature, publicKey);
