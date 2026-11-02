// Membangkitkan spec/test-vectors/barter/*.json (SD-047). Jalankan setelah `npm run build`: node spec/test-vectors/generate-barter.mjs
// Deterministik: kunci dari keys.json (kA translator, kB summarizer, kC scraper), tanpa waktu atau acak.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bundleSigningHash, listingHash, listingHashBase58, listingSigningHash, offerHash, offerSigningHash, quickBarter, quickPay, serializeListing,
  serializeOffer, signListing, signOffer, intentHash, intentHashBase58, intentSigningHash, serializeBundleTerms, serializeIntent, signBundle,
  signIntent, termsHash, voucherPublicKey, referralHash, referralSigningHash, serializeReferral, signReferral,
} from "../../packages/core/dist/index.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const keys = JSON.parse(readFileSync(here("keys.json"), "utf8")).keys;
const seed = (k) => Buffer.from(keys[k].seed, "hex");
const hex = (b) => Buffer.from(b).toString("hex");
const CIRCLE = "x207-circle.near";
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";
const out = here("barter/");
mkdirSync(out, { recursive: true });

const intent = {
  circle: CIRCLE, account: A,
  offer: { service: "translate", calls: 50, value: "1000000" },
  need: { service: "summarize", calls: 50, value: "1000000" },
  expiresAt: 1793600000, nonce: "n1",
};
writeFileSync(`${out}intent.json`, JSON.stringify({
  circle: CIRCLE, intent, message: serializeIntent(intent), intentHash: intentHash(intent), intentHashBase58: intentHashBase58(intent),
  signingHash: hex(intentSigningHash(intent)), pubkey: voucherPublicKey(seed("kA")), signature: signIntent(intent, seed("kA")),
}, null, 2) + "\n");

// A -> B -> C -> A: tiga leg melingkar (10, 8, 6 credit); legs sengaja tidak urut agar kanonikalisasi teruji.
const terms = {
  circle: CIRCLE, epoch: 42,
  legs: [
    { payer: C, payee: A, max_amount: "6000000" },
    { payer: A, payee: B, max_amount: "10000000" },
    { payer: B, payee: C, max_amount: "8000000" },
  ],
};
const participants = { [A]: "kA", [B]: "kB", [C]: "kC" };
writeFileSync(`${out}bundle_abca.json`, JSON.stringify({
  circle: CIRCLE, terms, message: serializeBundleTerms(terms), termsHash: termsHash(terms), signingHash: hex(bundleSigningHash(terms)),
  participants: Object.fromEntries(Object.entries(participants).map(([account, k]) => [account, voucherPublicKey(seed(k))])),
  signatures: Object.entries(participants).map(([account, k]) => signBundle(terms, account, seed(k))),
}, null, 2) + "\n");
// Listing dan penawaran (SD-055). Andi (translator) menawarkan jasa 100 credit, diskon 10%, mencari jasa 100 credit.
const listing = {
  circle: CIRCLE, account: A,
  offer: { asset_type: "translate-calls", asset_class: "D", quantity: 5000, value: "100000000" },
  want: { asset_type: "summarize-calls", asset_class: "D", quantity: 5000, value: "100000000" },
  terms: "delivery within 7 days", detail: "5000 translation calls, any language pair",
  expires_at: 1793600000, discount_bps: 1000, accept_payment: true, discoverable: true, nonce: "l1",
};
const offer = { circle: CIRCLE, listing_hash: listingHash(listing), proposer: B, round: 1, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793000000 };
writeFileSync(`${out}listing.json`, JSON.stringify({
  circle: CIRCLE, listing, message: serializeListing(listing), listingHash: listingHash(listing), listingHashBase58: listingHashBase58(listing),
  signingHash: hex(listingSigningHash(listing)), pubkey: voucherPublicKey(seed("kA")), signature: signListing(listing, seed("kA")),
  offer, offerMessage: serializeOffer(offer), offerHash: offerHash(offer), offerSigningHash: hex(offerSigningHash(offer)),
  offerPubkey: voucherPublicKey(seed("kB")), offerSignature: signOffer(offer, seed("kB")),
}, null, 2) + "\n");

// Barter cepat dari note F9: A bernilai 100, diskon 10, jatah pencari 3 (angka ilustrasi; semuanya parameter).
const params = { value: "100000000", discountBps: 1000, searcherShareBps: 300 };
writeFileSync(`${out}quick_barter.json`, JSON.stringify({
  params, pay: quickPay(params), barter: quickBarter(params),
  expected: { pay: { counterpartyPays: "93000000", sellerReceives: "90000000", searcher: "3000000" }, barter: { cashback: "7000000", searcher: "3000000", sellerBears: "10000000" } },
}, null, 2) + "\n");
console.log("barter vectors ditulis");

// Ajakan pencari (SV-015): scraper (kC) mengajak summarizer (kB) menawar listing Andi dengan jatah 3% (300 bps).
const referral = {
  circle: CIRCLE, seeker: C, to: B, listing_hash: listingHash(listing), mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793000000,
  searcher_share_bps: 300, expires_at: 1793300000, nonce: "r1",
};
writeFileSync(`${out}referral.json`, JSON.stringify({
  circle: CIRCLE, referral, message: serializeReferral(referral), referralHash: referralHash(referral), signingHash: hex(referralSigningHash(referral)),
  pubkey: voucherPublicKey(seed("kC")), signature: signReferral(referral, seed("kC")),
}, null, 2) + "\n");
