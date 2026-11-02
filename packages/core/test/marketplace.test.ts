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

describe("SD-055 listing, penawaran, dan barter cepat", () => {
  const v = vector("listing");
  const listing = v.listing as Listing;
  const offer = v.offer as Offer;

  it("listing: JSON kanonik, hash, dan tanda tangan cocok dengan vector", () => {
    expect(serializeListing(listing)).toBe(v.message);
    expect(listingHash(listing)).toBe(v.listingHash);
    expect(v.listingHash).toBe(sha256(v.message));
    expect(signListing(listing, seed("kA"))).toBe(v.signature);
    expect(verifyListingSignature(listing, v.signature, v.pubkey)).toBe(true);
    expect(verifyListingSignature({ ...listing, discount_bps: 1001 }, v.signature, v.pubkey)).toBe(false);
  });

  it("penawaran balik mengikat hash listing dan menolak tanda tangan akun lain", () => {
    expect(offer.listing_hash).toBe(v.listingHash);
    expect(serializeOffer(offer)).toBe(v.offerMessage);
    expect(offerHash(offer)).toBe(v.offerHash);
    expect(signOffer(offer, seed("kB"))).toBe(v.offerSignature);
    expect(verifyOfferSignature(offer, v.offerSignature, v.offerPubkey)).toBe(true);
    expect(verifyOfferSignature(offer, v.offerSignature, v.pubkey)).toBe(false);
    expect(offerHash({ ...offer, round: 2 })).not.toBe(v.offerHash);
  });

  it("barter cepat contoh note F9: 100, diskon 10, jatah pencari 3", () => {
    const q = vector("quick_barter");
    expect(quickPay(q.params)).toMatchObject(q.expected.pay);
    expect(quickBarter(q.params)).toMatchObject(q.expected.barter);
    // Jalur bayar: lawan 93, Andi 90, pencari 3. Jalur barter: lawan serahkan 100, cashback 7, Andi tanggung 10.
    expect(q.expected).toEqual({
      pay: { counterpartyPays: "93000000", sellerReceives: "90000000", searcher: "3000000" },
      barter: { cashback: "7000000", searcher: "3000000", sellerBears: "10000000" },
    });
  });

  it("pembagian adalah parameter, bukan angka tetap", () => {
    const base = { value: "200000000", discountBps: 500, searcherShareBps: 100 };
    expect(quickPay(base)).toMatchObject({ counterpartyPays: "192000000", sellerReceives: "190000000", searcher: "2000000" });
    expect(quickBarter(base)).toMatchObject({ cashback: "8000000", sellerBears: "10000000" });
    expect(quickBarter({ ...base, searcherShareBps: 0 })).toMatchObject({ cashback: "10000000", searcher: "0" });
  });

  it("jumlah tetap utuh: pay.sellerBears = cashback + pencari, dan pembulatan ke bawah", () => {
    const p = { value: "333333", discountBps: 1000, searcherShareBps: 333 };
    const b = quickBarter(p);
    expect(BigInt(b.cashback) + BigInt(b.searcher)).toBe(BigInt(b.sellerBears));
    expect(quickPay(p).counterpartyPays).toBe(String(333333n - 33333n + 11099n));
  });

  it("menolak jatah pencari di atas diskon, bps di luar rentang, dan kelas aset X", () => {
    expect(() => quickPay({ value: "100", discountBps: 100, searcherShareBps: 200 })).toThrow(/melebihi diskon/);
    expect(() => quickBarter({ value: "100", discountBps: 10_001, searcherShareBps: 0 })).toThrow(BarterFormatError);
    expect(() => quickPay({ value: "0", discountBps: 0, searcherShareBps: 0 })).toThrow(/value/);
    expect(() => serializeListing({ ...listing, offer: { ...listing.offer, asset_class: "X" as never } })).toThrow(/kelas yang sah A, B, C, atau D/);
    expect(() => serializeListing({ ...listing, discount_bps: 10_001 })).toThrow(/discount_bps/);
    expect(() => serializeListing({ ...listing, detail: "tidak ascii é" })).toThrow(/detail/);
    expect(() => serializeOffer({ ...offer, mode: "swap" as never })).toThrow(/mode/);
  });

  it("asset_type bebas selama sah, semua kelas A-D diterima", () => {
    for (const asset_class of ["A", "B", "C", "D"] as const) {
      expect(() => serializeListing({ ...listing, want: { ...listing.want, asset_type: "gpu-hours.v2", asset_class } })).not.toThrow();
    }
  });
});

describe("pembatalan listing", () => {
  it("tanda tangan pembatalan hanya sah untuk listing dan pemasang itu", async () => {
    const { signCancelListing, verifyCancelSignature, listingHash: hashOf } = await import("@x207/core");
    const listing = vector("listing").listing as Listing;
    const signature = signCancelListing(listing, seed("kA"));
    expect(verifyCancelSignature(hashOf(listing), listing.circle, signature, vector("listing").pubkey)).toBe(true);
    expect(verifyCancelSignature(hashOf({ ...listing, nonce: "x" }), listing.circle, signature, vector("listing").pubkey)).toBe(false);
    expect(verifyCancelSignature(hashOf(listing), listing.circle, signature, vector("listing").offerPubkey)).toBe(false);
  });
});
