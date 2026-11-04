// Uses only the public exports of @x207/core, like an outside developer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BarterFormatError, acceptOffer, bundleFullySigned, counterOffer, listingHash, planOffer, postListing, serializeBundleTerms, signBundle, termsHash, verifySignedListing, verifySignedOffer,
  voucherPublicKey, type Listing,
} from "@x207/core";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/barter/listing.json", import.meta.url)), "utf8"));
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys;
const seed = (k: string) => Buffer.from(keys[k].seed, "hex");
const ANDI = "translator.x207-circle.near";
const COUNTERPARTY = "summarizer.x207-circle.near";
const SEEKER = "scraper.x207-circle.near";
const listing = vector.listing as Listing;
const NOW = 1793000000;

describe("SD-056 marketplace helpers", () => {
  it("postListing signs and verifySignedListing rejects a changed listing", () => {
    const signed = postListing(listing, seed("kA"));
    expect(signed.signature).toBe(vector.signature);
    expect(signed.listing_hash).toBe(vector.listingHash);
    expect(verifySignedListing(signed, voucherPublicKey(seed("kA")))).toBe(true);
    expect(verifySignedListing({ ...signed, listing: { ...listing, discount_bps: 5 } }, voucherPublicKey(seed("kA")))).toBe(false);
    expect(verifySignedListing(signed, voucherPublicKey(seed("kB")))).toBe(false);
  });

  it("counterOffer: the round increases, alternates, and rejects an expired listing or pay mode without accept_payment", () => {
    const first = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(first.offer.round).toBe(1);
    expect(first.offer.listing_hash).toBe(listingHash(listing));
    expect(verifySignedOffer(first, voucherPublicKey(seed("kB")))).toBe(true);
    const second = counterOffer({ listing, proposer: ANDI, mode: "barter", value: "100000000", quantity: 4000, deliver_by: 1793300000, previous: first.offer, now: NOW }, seed("kA"));
    expect(second.offer.round).toBe(2);
    expect(() => counterOffer({ listing, proposer: ANDI, mode: "barter", value: "1", quantity: 1, deliver_by: 1793300000, previous: second.offer, now: NOW }, seed("kA"))).toThrow(/opposing party/);
    expect(() => counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "1", quantity: 1, deliver_by: 1, now: listing.expires_at }, seed("kB"))).toThrow(/expired/);
    expect(() => counterOffer({ listing: { ...listing, accept_payment: false }, proposer: COUNTERPARTY, mode: "pay", value: "1", quantity: 1, deliver_by: 1, now: NOW }, seed("kB"))).toThrow(/accept_payment/);
    expect(() => counterOffer({ listing, proposer: ANDI, mode: "barter", value: "1", quantity: 1, deliver_by: 1, now: NOW }, seed("kA"))).toThrow(BarterFormatError);
  });

  it("acceptOffer pay path with a seeker: the counterparty pays 93 (90 to Andi, 3 to the seeker)", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "pay", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const result = acceptOffer({ listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300, account: ANDI }, seed("kA"));
    if (result.kind !== "bundle") throw new Error("seharusnya bundle");
    expect(result.terms.legs).toEqual([
      { payer: COUNTERPARTY, payee: ANDI, max_amount: "90000000" },
      { payer: COUNTERPARTY, payee: SEEKER, max_amount: "3000000" },
    ]);
    const total = result.terms.legs.reduce((s, l) => s + BigInt(l.max_amount), 0n);
    expect(total).toBe(93_000_000n);
  });

  it("acceptOffer pay path without a seeker: one plain voucher payment, not a bundle", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "pay", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(acceptOffer({ listing, offer, epoch: 42, account: ANDI }, seed("kA"))).toEqual({ kind: "payment", payer: COUNTERPARTY, payee: ANDI, amount: "90000000" });
  });

  it("acceptOffer barter path: Andi bears 10 after clearing, all three parties sign", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const input = { listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300 };
    const byAndi = acceptOffer({ ...input, account: ANDI }, seed("kA"));
    if (byAndi.kind !== "bundle") throw new Error("seharusnya bundle");
    const net = new Map<string, bigint>();
    for (const l of byAndi.terms.legs) {
      net.set(l.payer, (net.get(l.payer) ?? 0n) - BigInt(l.max_amount));
      net.set(l.payee, (net.get(l.payee) ?? 0n) + BigInt(l.max_amount));
    }
    expect(net.get(ANDI)).toBe(-10_000_000n);
    expect(net.get(COUNTERPARTY)).toBe(7_000_000n);
    expect(net.get(SEEKER)).toBe(3_000_000n);
    expect(byAndi.terms.legs).toContainEqual({ payer: ANDI, payee: COUNTERPARTY, max_amount: "107000000" });

    const sigs = [byAndi.signature, signBundle(byAndi.terms, COUNTERPARTY, seed("kB")), signBundle(byAndi.terms, SEEKER, seed("kC"))];
    const pubkeys = { [ANDI]: voucherPublicKey(seed("kA")), [COUNTERPARTY]: voucherPublicKey(seed("kB")), [SEEKER]: voucherPublicKey(seed("kC")) };
    expect(bundleFullySigned(byAndi.terms, sigs, pubkeys)).toBe(true);
    expect(bundleFullySigned(byAndi.terms, sigs.slice(0, 2), pubkeys)).toBe(false);
  });

  it("acceptOffer rejects an offer for another listing and a receiver outside the listing", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "1", quantity: 1, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(() => acceptOffer({ listing: { ...listing, nonce: "l2" }, offer, epoch: 1, account: ANDI }, seed("kA"))).toThrow(/another listing/);
    expect(() => acceptOffer({ listing, offer, epoch: 1, account: SEEKER }, seed("kC"))).toThrow(/party of the listing/);
  });

  it("planOffer computes the terms without a key and matches what acceptOffer signs", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const input = { listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300 };
    const plan = planOffer(input);
    expect(plan.kind).toBe("bundle");
    const signed = acceptOffer({ ...input, account: ANDI }, seed("kA"));
    expect(signed.kind === "bundle" && plan.kind === "bundle" && signed.terms_hash === plan.terms_hash).toBe(true);
    expect(plan.discount).toBe("10000000");
    expect(plan.searcher).toBe("3000000");
    const pay = planOffer({ listing, offer: { ...offer, mode: "pay" }, epoch: 42 });
    expect(pay).toMatchObject({ kind: "payment", payer: COUNTERPARTY, payee: ANDI, amount: "90000000", discount: "10000000", searcher: "0" });
  });

  it("planOffer on the poster's counter-offer uses the explicit counterparty, not the proposer", () => {
    const first = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const second = counterOffer({ listing, proposer: ANDI, mode: "barter", value: "95000000", quantity: 5000, deliver_by: 1793300000, previous: first.offer, now: NOW }, seed("kA"));
    expect(() => planOffer({ listing, offer: second.offer, epoch: 42 })).toThrow(/the counterparty must not be the same as the listing poster/);
    const viaSecond = planOffer({ listing, offer: second.offer, epoch: 42, counterparty: COUNTERPARTY });
    if (viaSecond.kind !== "bundle") throw new Error("must be a bundle");
    // the poster counter-offers 95: the counterparty pays 95 to Andi, Andi pays 100 + 9.5 cashback to the counterparty
    const byKey = <T extends { payer: string; payee: string }>(legs: T[]) => [...legs].sort((a, b) => (a.payer + a.payee < b.payer + b.payee ? -1 : 1));
    expect(byKey(viaSecond.terms.legs)).toEqual(byKey([
      { payer: ANDI, payee: COUNTERPARTY, max_amount: "109500000" },
      { payer: COUNTERPARTY, payee: ANDI, max_amount: "95000000" },
    ]));
  });

  it("planOffer uses the agreed value Offer.value, not the initial listing value", () => {
    const first = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "90000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const barter = planOffer({ listing, offer: first.offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300 });
    if (barter.kind !== "bundle") throw new Error("must be a bundle");
    const amount = (payer: string, payee: string) => barter.terms.legs.find((l) => l.payer === payer && l.payee === payee)?.max_amount;
    // 10% discount on 90 = 9, 3% share of 90 = 2.7, cashback 6.3; the counterparty pays 90 to Andi
    expect(amount(COUNTERPARTY, ANDI)).toBe("90000000");
    expect(amount(ANDI, COUNTERPARTY)).toBe("106300000");
    expect(amount(ANDI, SEEKER)).toBe("2700000");
    expect(barter.discount).toBe("9000000");
    const pay = planOffer({ listing, offer: { ...first.offer, mode: "pay" }, epoch: 42 });
    expect(pay).toMatchObject({ kind: "payment", amount: "81000000", discount: "9000000" });
  });

  it("a seeker with a share: the terms contain a search_leg to the seeker and terms_hash is computed with it; without a seeker the old hash (interface 0.0.5)", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const withSeeker = planOffer({ listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300 });
    if (withSeeker.kind !== "bundle") throw new Error("must be a bundle");
    expect(withSeeker.terms.search_leg).toEqual({ payer: ANDI, payee: SEEKER });
    expect(withSeeker.terms_hash).toBe(termsHash(withSeeker.terms));
    expect(Object.keys(JSON.parse(serializeBundleTerms(withSeeker.terms)))).toEqual(["circle", "epoch", "legs", "search_leg"]);
    // acceptOffer signs the same terms, with search_leg
    const accepted = acceptOffer({ listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300, account: ANDI }, seed("kA"));
    if (accepted.kind !== "bundle") throw new Error("must be a bundle");
    expect(accepted.terms_hash).toBe(withSeeker.terms_hash);
    expect(accepted.terms.search_leg).toEqual({ payer: ANDI, payee: SEEKER });

    // without a searcher, or a share of 0 (no leg): there is no search_leg and the hash equals the hash of legs alone
    const noSeeker = planOffer({ listing, offer, epoch: 42 });
    const zeroShare = planOffer({ listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 0 });
    for (const plan of [noSeeker, zeroShare]) {
      if (plan.kind !== "bundle") throw new Error("must be a bundle");
      expect("search_leg" in plan.terms).toBe(false);
      expect(plan.terms_hash).toBe(termsHash({ circle: plan.terms.circle, epoch: plan.terms.epoch, legs: plan.terms.legs }));
    }
  });

  it("pay path with a seeker: search_leg is the counterparty leg to the seeker", () => {
    const { offer } = counterOffer({ listing, proposer: COUNTERPARTY, mode: "pay", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const plan = planOffer({ listing, offer, epoch: 42, searcher: SEEKER, searcherShareBps: 300 });
    if (plan.kind !== "bundle") throw new Error("must be a bundle");
    expect(plan.terms.search_leg).toEqual({ payer: COUNTERPARTY, payee: SEEKER });
    expect(plan.terms.legs).toContainEqual({ payer: COUNTERPARTY, payee: SEEKER, max_amount: "3000000" });
  });
});
