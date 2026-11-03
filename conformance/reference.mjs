#!/usr/bin/env node
// Adapter referensi conformance (SD-058): menjawab protokol NDJSON dengan @x207/core. Implementasi lain menulis adapter yang sama
// dalam bahasanya. Baca satu JSON per baris `{id, op, input}`, tulis satu JSON per baris `{id, output}` atau `{id, error}`.
import { createInterface } from "node:readline";
import * as core from "@x207/core";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const verify = (fn) => ({ valid: fn() });

const ops = {
  "voucher.message": ({ voucher }) => core.serializeVoucherMessage(voucher),
  "voucher.signingHash": ({ voucher }) => hex(core.voucherSigningHash(voucher)),
  "voucher.verify": ({ voucher, publicKey }) => verify(() => core.verifyVoucher(voucher, publicKey)),
  "intent.message": ({ intent }) => core.serializeIntent(intent),
  "intent.hash": ({ intent }) => core.intentHash(intent),
  "intent.hashBase58": ({ intent }) => core.intentHashBase58(intent),
  "intent.signingHash": ({ intent }) => hex(core.intentSigningHash(intent)),
  "intent.verify": ({ intent, signature, publicKey }) => verify(() => core.verifyIntentSignature(intent, signature, publicKey)),
  "bundle.message": ({ terms }) => core.serializeBundleTerms(terms),
  "bundle.termsHash": ({ terms }) => core.termsHash(terms),
  "bundle.signingHash": ({ terms }) => hex(core.bundleSigningHash(terms)),
  "bundle.verify": ({ terms, signature, publicKey }) => verify(() => core.verifyBundleSignature(terms, signature, publicKey)),
  "listing.message": ({ listing }) => core.serializeListing(listing),
  "listing.hash": ({ listing }) => core.listingHash(listing),
  "listing.hashBase58": ({ listing }) => core.listingHashBase58(listing),
  "listing.signingHash": ({ listing }) => hex(core.listingSigningHash(listing)),
  "listing.verify": ({ listing, signature, publicKey }) => verify(() => core.verifyListingSignature(listing, signature, publicKey)),
  "offer.message": ({ offer }) => core.serializeOffer(offer),
  "offer.hash": ({ offer }) => core.offerHash(offer),
  "offer.signingHash": ({ offer }) => hex(core.offerSigningHash(offer)),
  "offer.verify": ({ offer, signature, publicKey }) => verify(() => core.verifyOfferSignature(offer, signature, publicKey)),
  "referral.message": ({ referral }) => core.serializeReferral(referral),
  "referral.hash": ({ referral }) => core.referralHash(referral),
  "referral.signingHash": ({ referral }) => hex(core.referralSigningHash(referral)),
  "referral.verify": ({ referral, signature, publicKey }) => verify(() => core.verifyReferralSignature(referral, signature, publicKey)),
  "quick.pay": (params) => core.quickPay(params),
  "quick.barter": (params) => core.quickBarter(params),
};

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const { id, op, input } = JSON.parse(line);
  try {
    const handler = ops[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    process.stdout.write(`${JSON.stringify({ id, output: handler(input) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
}
