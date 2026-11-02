// Kasus conformance x207 (SD-058): dibaca dari spec/test-vectors, satu-satunya sumber format. Tiap kasus: { id, op, input, expected }.
// Implementasi apa pun (bahasa apa pun) lulus bila menjawab semua kasus persis; protokolnya di conformance/README.md.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vectors = (path) => fileURLToPath(new URL(`../spec/test-vectors/${path}`, import.meta.url));
const json = (path) => JSON.parse(readFileSync(vectors(path), "utf8"));

export function loadCases() {
  const cases = [];
  const add = (id, op, input, expected) => cases.push({ id, op, input, expected });

  // Voucher F2: tanda tangan NEP-413 atas JSON kanonik; vector valid memuat pesan, nonce, payload, dan hash penandatanganan
  for (const file of readdirSync(vectors("voucher")).sort()) {
    const vector = json(`voucher/${file}`);
    const { signature, ...unsigned } = vector.input.voucher;
    add(`voucher/${vector.name}/verify`, "voucher.verify", { voucher: vector.input.voucher, publicKey: vector.input.publicKey }, { valid: vector.expected.valid });
    if (vector.name === "valid") {
      add("voucher/valid/message", "voucher.message", { voucher: unsigned }, vector.expected.message);
      add("voucher/valid/signingHash", "voucher.signingHash", { voucher: unsigned }, vector.expected.signingHash);
    }
  }

  // Intent F5
  const intent = json("barter/intent.json");
  add("intent/message", "intent.message", { intent: intent.intent }, intent.message);
  add("intent/hash", "intent.hash", { intent: intent.intent }, intent.intentHash);
  add("intent/hashBase58", "intent.hashBase58", { intent: intent.intent }, intent.intentHashBase58);
  add("intent/signingHash", "intent.signingHash", { intent: intent.intent }, intent.signingHash);
  add("intent/verify", "intent.verify", { intent: intent.intent, signature: intent.signature, publicKey: intent.pubkey }, { valid: true });
  add("intent/verify-tampered", "intent.verify", { intent: { ...intent.intent, nonce: "other" }, signature: intent.signature, publicKey: intent.pubkey }, { valid: false });

  // Bundle F5: pesan, terms_hash, hash penandatanganan, dan tanda tangan tiap peserta
  const bundle = json("barter/bundle_abca.json");
  add("bundle/message", "bundle.message", { terms: bundle.terms }, bundle.message);
  add("bundle/termsHash", "bundle.termsHash", { terms: bundle.terms }, bundle.termsHash);
  add("bundle/signingHash", "bundle.signingHash", { terms: bundle.terms }, bundle.signingHash);
  for (const s of bundle.signatures) {
    add(`bundle/verify/${s.account}`, "bundle.verify", { terms: bundle.terms, signature: s.signature, publicKey: bundle.participants[s.account] }, { valid: true });
  }
  const swapped = bundle.terms.legs.map((leg, i) => (i === 0 ? { ...leg, max_amount: String(BigInt(leg.max_amount) + 1n) } : leg));
  add("bundle/verify-tampered", "bundle.verify", { terms: { ...bundle.terms, legs: swapped }, signature: bundle.signatures[0].signature, publicKey: bundle.participants[bundle.signatures[0].account] }, { valid: false });

  // Listing dan penawaran F9
  const listing = json("barter/listing.json");
  add("listing/message", "listing.message", { listing: listing.listing }, listing.message);
  add("listing/hash", "listing.hash", { listing: listing.listing }, listing.listingHash);
  add("listing/hashBase58", "listing.hashBase58", { listing: listing.listing }, listing.listingHashBase58);
  add("listing/signingHash", "listing.signingHash", { listing: listing.listing }, listing.signingHash);
  add("listing/verify", "listing.verify", { listing: listing.listing, signature: listing.signature, publicKey: listing.pubkey }, { valid: true });
  add("listing/verify-tampered", "listing.verify", { listing: { ...listing.listing, discount_bps: 1001 }, signature: listing.signature, publicKey: listing.pubkey }, { valid: false });
  add("offer/message", "offer.message", { offer: listing.offer }, listing.offerMessage);
  add("offer/hash", "offer.hash", { offer: listing.offer }, listing.offerHash);
  add("offer/signingHash", "offer.signingHash", { offer: listing.offer }, listing.offerSigningHash);
  add("offer/verify", "offer.verify", { offer: listing.offer, signature: listing.offerSignature, publicKey: listing.offerPubkey }, { valid: true });
  add("offer/verify-wrong-key", "offer.verify", { offer: listing.offer, signature: listing.offerSignature, publicKey: listing.pubkey }, { valid: false });

  // Ajakan pencari F9 (SV-015)
  const referral = json("barter/referral.json");
  add("referral/message", "referral.message", { referral: referral.referral }, referral.message);
  add("referral/hash", "referral.hash", { referral: referral.referral }, referral.referralHash);
  add("referral/signingHash", "referral.signingHash", { referral: referral.referral }, referral.signingHash);
  add("referral/verify", "referral.verify", { referral: referral.referral, signature: referral.signature, publicKey: referral.pubkey }, { valid: true });
  add("referral/verify-tampered", "referral.verify", { referral: { ...referral.referral, searcher_share_bps: 301 }, signature: referral.signature, publicKey: referral.pubkey }, { valid: false });

  // Barter cepat F9: angka contoh note F9 sebagai parameter
  const quick = json("barter/quick_barter.json");
  add("quick/pay", "quick.pay", quick.params, quick.pay);
  add("quick/barter", "quick.barter", quick.params, quick.barter);
  add("quick/no-seeker", "quick.pay", { ...quick.params, searcherShareBps: 0 }, { counterpartyPays: "90000000", sellerReceives: "90000000", searcher: "0", discount: "10000000" });

  return cases;
}
