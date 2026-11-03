import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BarterFormatError, listingHash, offerHash, quickBarter, quickPay, serializeListing, serializeOffer, signListing, signOffer,
  verifyListingSignature, verifyOfferSignature, type Listing, type Offer,
} from "@x207/core";

const vector = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/test-vectors/barter/${name}.json`, import.meta.url)), "utf8"));
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys;
const seed = (k: string) => Buffer.from(keys[k].seed, "hex");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("SD-055 listing, offer, and quick barter", () => {
  const v = vector("listing");
  const listing = v.listing as Listing;
  const offer = v.offer as Offer;

  it("listing: canonical JSON, hash, and signature match the vector", () => {
    expect(serializeListing(listing)).toBe(v.message);
    expect(listingHash(listing)).toBe(v.listingHash);
    expect(v.listingHash).toBe(sha256(v.message));
    expect(signListing(listing, seed("kA"))).toBe(v.signature);
    expect(verifyListingSignature(listing, v.signature, v.pubkey)).toBe(true);
    expect(verifyListingSignature({ ...listing, discount_bps: 1001 }, v.signature, v.pubkey)).toBe(false);
  });

  it("a counter-offer binds the listing hash and rejects the signature of another account", () => {
    expect(offer.listing_hash).toBe(v.listingHash);
    expect(serializeOffer(offer)).toBe(v.offerMessage);
    expect(offerHash(offer)).toBe(v.offerHash);
    expect(signOffer(offer, seed("kB"))).toBe(v.offerSignature);
    expect(verifyOfferSignature(offer, v.offerSignature, v.offerPubkey)).toBe(true);
    expect(verifyOfferSignature(offer, v.offerSignature, v.pubkey)).toBe(false);
    expect(offerHash({ ...offer, round: 2 })).not.toBe(v.offerHash);
  });

  it("quick barter example of note F9: 100, discount 10, seeker share 3", () => {
    const q = vector("quick_barter");
    expect(quickPay(q.params)).toMatchObject(q.expected.pay);
    expect(quickBarter(q.params)).toMatchObject(q.expected.barter);
    // Jalur bayar: lawan 93, Andi 90, pencari 3. Jalur barter: lawan serahkan 100, cashback 7, Andi tanggung 10.
    expect(q.expected).toEqual({
      pay: { counterpartyPays: "93000000", sellerReceives: "90000000", searcher: "3000000" },
      barter: { cashback: "7000000", searcher: "3000000", sellerBears: "10000000" },
    });
  });

  it("the split is a parameter, not a fixed number", () => {
    const base = { value: "200000000", discountBps: 500, searcherShareBps: 100 };
    expect(quickPay(base)).toMatchObject({ counterpartyPays: "192000000", sellerReceives: "190000000", searcher: "2000000" });
    expect(quickBarter(base)).toMatchObject({ cashback: "8000000", sellerBears: "10000000" });
    expect(quickBarter({ ...base, searcherShareBps: 0 })).toMatchObject({ cashback: "10000000", searcher: "0" });
  });

  it("the total stays whole: pay.sellerBears = cashback + seeker, and rounding goes down", () => {
    const p = { value: "333333", discountBps: 1000, searcherShareBps: 333 };
    const b = quickBarter(p);
    expect(BigInt(b.cashback) + BigInt(b.searcher)).toBe(BigInt(b.sellerBears));
    expect(quickPay(p).counterpartyPays).toBe(String(333333n - 33333n + 11099n));
  });

  it("rejects a seeker share above the discount, bps out of range, and asset class X", () => {
    expect(() => quickPay({ value: "100", discountBps: 100, searcherShareBps: 200 })).toThrow(/exceed the discount/);
    expect(() => quickBarter({ value: "100", discountBps: 10_001, searcherShareBps: 0 })).toThrow(BarterFormatError);
    expect(() => quickPay({ value: "0", discountBps: 0, searcherShareBps: 0 })).toThrow(/value/);
    expect(() => serializeListing({ ...listing, offer: { ...listing.offer, asset_class: "X" as never } })).toThrow(/valid classes are A, B, C, or D/);
    expect(() => serializeListing({ ...listing, discount_bps: 10_001 })).toThrow(/discount_bps/);
    expect(() => serializeListing({ ...listing, detail: "not ascii é" })).toThrow(/detail/);
    expect(() => serializeOffer({ ...offer, mode: "swap" as never })).toThrow(/mode/);
  });

  it("asset_type is free as long as it is valid, all classes A-D are accepted", () => {
    for (const asset_class of ["A", "B", "C", "D"] as const) {
      expect(() => serializeListing({ ...listing, want: { ...listing.want, asset_type: "gpu-hours.v2", asset_class } })).not.toThrow();
    }
  });
});

describe("pembatalan listing", () => {
  it("a cancellation signature is valid only for that listing and poster", async () => {
    const { signCancelListing, verifyCancelSignature, listingHash: hashOf } = await import("@x207/core");
    const listing = vector("listing").listing as Listing;
    const signature = signCancelListing(listing, seed("kA"));
    expect(verifyCancelSignature(hashOf(listing), listing.circle, signature, vector("listing").pubkey)).toBe(true);
    expect(verifyCancelSignature(hashOf({ ...listing, nonce: "x" }), listing.circle, signature, vector("listing").pubkey)).toBe(false);
    expect(verifyCancelSignature(hashOf(listing), listing.circle, signature, vector("listing").offerPubkey)).toBe(false);
  });
});

describe("seeker referral (SV-015)", () => {
  it("referral vector: canonical JSON, hash, signing hash, and seeker signature", async () => {
    const { serializeReferral, referralHash, signReferral, verifyReferralSignature, referralSigningHash } = await import("@x207/core");
    const v = vector("referral");
    expect(serializeReferral(v.referral)).toBe(v.message);
    expect(referralHash(v.referral)).toBe(v.referralHash);
    expect(v.referralHash).toBe(sha256(v.message));
    expect(Buffer.from(referralSigningHash(v.referral)).toString("hex")).toBe(v.signingHash);
    expect(signReferral(v.referral, seed("kC"))).toBe(v.signature);
    expect(verifyReferralSignature(v.referral, v.signature, v.pubkey)).toBe(true);
    expect(verifyReferralSignature({ ...v.referral, searcher_share_bps: 301 }, v.signature, v.pubkey)).toBe(false);
    expect(verifyReferralSignature(v.referral, v.signature, vector("listing").pubkey)).toBe(false);
  });

  it("validation rejects a referral to oneself, a share outside 0..10000, a wrong mode", async () => {
    const { validateReferral, BarterFormatError: Err } = await import("@x207/core");
    const base = vector("referral").referral;
    expect(() => validateReferral(base)).not.toThrow();
    for (const bad of [{ to: base.seeker }, { searcher_share_bps: 10_001 }, { mode: "swap" }, { value: "0" }, { listing_hash: "x" }, { nonce: "a b" }]) {
      expect(() => validateReferral({ ...base, ...bad })).toThrow(Err);
    }
  });

  it("a referral rejection is signed by the target agent for that hash and circle only", async () => {
    const { signRefuseReferral, verifyRefuseReferral } = await import("@x207/core");
    const v = vector("referral");
    const sig = signRefuseReferral(v.referralHash, v.circle, seed("kB"));
    const pub = vector("listing").offerPubkey; // kB
    expect(verifyRefuseReferral(v.referralHash, v.circle, sig, pub)).toBe(true);
    expect(verifyRefuseReferral("0".repeat(64), v.circle, sig, pub)).toBe(false);
    expect(verifyRefuseReferral(v.referralHash, "other.near", sig, pub)).toBe(false);
    expect(verifyRefuseReferral(v.referralHash, v.circle, sig, v.pubkey)).toBe(false);
  });
});
