// Memakai hanya ekspor publik @x207/core, seperti developer luar.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BarterFormatError, acceptOffer, bundleFullySigned, counterOffer, listingHash, planOffer, postListing, signBundle, verifySignedListing, verifySignedOffer,
  voucherPublicKey, type Listing,
} from "@x207/core";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/barter/listing.json", import.meta.url)), "utf8"));
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys;
const seed = (k: string) => Buffer.from(keys[k].seed, "hex");
const ANDI = "translator.x207-circle.near";
const LAWAN = "summarizer.x207-circle.near";
const PENCARI = "scraper.x207-circle.near";
const listing = vector.listing as Listing;
const NOW = 1793000000;

describe("SD-056 helper marketplace", () => {
  it("postListing menandatangani dan verifySignedListing menolak listing yang diubah", () => {
    const signed = postListing(listing, seed("kA"));
    expect(signed.signature).toBe(vector.signature);
    expect(signed.listing_hash).toBe(vector.listingHash);
    expect(verifySignedListing(signed, voucherPublicKey(seed("kA")))).toBe(true);
    expect(verifySignedListing({ ...signed, listing: { ...listing, discount_bps: 5 } }, voucherPublicKey(seed("kA")))).toBe(false);
    expect(verifySignedListing(signed, voucherPublicKey(seed("kB")))).toBe(false);
  });

  it("counterOffer: ronde naik, bergantian, dan menolak listing kedaluwarsa atau mode bayar tanpa accept_payment", () => {
    const first = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(first.offer.round).toBe(1);
    expect(first.offer.listing_hash).toBe(listingHash(listing));
    expect(verifySignedOffer(first, voucherPublicKey(seed("kB")))).toBe(true);
    const second = counterOffer({ listing, proposer: ANDI, mode: "barter", value: "100000000", quantity: 4000, deliver_by: 1793300000, previous: first.offer, now: NOW }, seed("kA"));
    expect(second.offer.round).toBe(2);
    expect(() => counterOffer({ listing, proposer: ANDI, mode: "barter", value: "1", quantity: 1, deliver_by: 1793300000, previous: second.offer, now: NOW }, seed("kA"))).toThrow(/pihak lawan/);
    expect(() => counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "1", quantity: 1, deliver_by: 1, now: listing.expires_at }, seed("kB"))).toThrow(/kedaluwarsa/);
    expect(() => counterOffer({ listing: { ...listing, accept_payment: false }, proposer: LAWAN, mode: "pay", value: "1", quantity: 1, deliver_by: 1, now: NOW }, seed("kB"))).toThrow(/accept_payment/);
    expect(() => counterOffer({ listing, proposer: ANDI, mode: "barter", value: "1", quantity: 1, deliver_by: 1, now: NOW }, seed("kA"))).toThrow(BarterFormatError);
  });

  it("acceptOffer jalur bayar dengan pencari: lawan bayar 93 (90 ke Andi, 3 ke pencari)", () => {
    const { offer } = counterOffer({ listing, proposer: LAWAN, mode: "pay", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const result = acceptOffer({ listing, offer, epoch: 42, searcher: PENCARI, searcherShareBps: 300, account: ANDI }, seed("kA"));
    if (result.kind !== "bundle") throw new Error("seharusnya bundle");
    expect(result.terms.legs).toEqual([
      { payer: LAWAN, payee: ANDI, max_amount: "90000000" },
      { payer: LAWAN, payee: PENCARI, max_amount: "3000000" },
    ]);
    const total = result.terms.legs.reduce((s, l) => s + BigInt(l.max_amount), 0n);
    expect(total).toBe(93_000_000n);
  });

  it("acceptOffer jalur bayar tanpa pencari: satu pembayaran voucher biasa, bukan bundle", () => {
    const { offer } = counterOffer({ listing, proposer: LAWAN, mode: "pay", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(acceptOffer({ listing, offer, epoch: 42, account: ANDI }, seed("kA"))).toEqual({ kind: "payment", payer: LAWAN, payee: ANDI, amount: "90000000" });
  });

  it("acceptOffer jalur barter: Andi menanggung 10 setelah kliring, ketiga pihak menandatangani", () => {
    const { offer } = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const input = { listing, offer, epoch: 42, searcher: PENCARI, searcherShareBps: 300 };
    const byAndi = acceptOffer({ ...input, account: ANDI }, seed("kA"));
    if (byAndi.kind !== "bundle") throw new Error("seharusnya bundle");
    const net = new Map<string, bigint>();
    for (const l of byAndi.terms.legs) {
      net.set(l.payer, (net.get(l.payer) ?? 0n) - BigInt(l.max_amount));
      net.set(l.payee, (net.get(l.payee) ?? 0n) + BigInt(l.max_amount));
    }
    expect(net.get(ANDI)).toBe(-10_000_000n);
    expect(net.get(LAWAN)).toBe(7_000_000n);
    expect(net.get(PENCARI)).toBe(3_000_000n);
    expect(byAndi.terms.legs).toContainEqual({ payer: ANDI, payee: LAWAN, max_amount: "107000000" });

    const sigs = [byAndi.signature, signBundle(byAndi.terms, LAWAN, seed("kB")), signBundle(byAndi.terms, PENCARI, seed("kC"))];
    const pubkeys = { [ANDI]: voucherPublicKey(seed("kA")), [LAWAN]: voucherPublicKey(seed("kB")), [PENCARI]: voucherPublicKey(seed("kC")) };
    expect(bundleFullySigned(byAndi.terms, sigs, pubkeys)).toBe(true);
    expect(bundleFullySigned(byAndi.terms, sigs.slice(0, 2), pubkeys)).toBe(false);
  });

  it("acceptOffer menolak penawaran listing lain dan penerima di luar listing", () => {
    const { offer } = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "1", quantity: 1, deliver_by: 1793300000, now: NOW }, seed("kB"));
    expect(() => acceptOffer({ listing: { ...listing, nonce: "l2" }, offer, epoch: 1, account: ANDI }, seed("kA"))).toThrow(/listing lain/);
    expect(() => acceptOffer({ listing, offer, epoch: 1, account: PENCARI }, seed("kC"))).toThrow(/pihak listing/);
  });

  it("planOffer menghitung syarat tanpa kunci dan cocok dengan yang ditandatangani acceptOffer", () => {
    const { offer } = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const input = { listing, offer, epoch: 42, searcher: PENCARI, searcherShareBps: 300 };
    const plan = planOffer(input);
    expect(plan.kind).toBe("bundle");
    const signed = acceptOffer({ ...input, account: ANDI }, seed("kA"));
    expect(signed.kind === "bundle" && plan.kind === "bundle" && signed.terms_hash === plan.terms_hash).toBe(true);
    expect(plan.discount).toBe("10000000");
    expect(plan.searcher).toBe("3000000");
    const pay = planOffer({ listing, offer: { ...offer, mode: "pay" }, epoch: 42 });
    expect(pay).toMatchObject({ kind: "payment", payer: LAWAN, payee: ANDI, amount: "90000000", discount: "10000000", searcher: "0" });
  });

  it("planOffer atas penawaran balik pemasang memakai counterparty eksplisit, bukan proposer", () => {
    const first = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "100000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const second = counterOffer({ listing, proposer: ANDI, mode: "barter", value: "95000000", quantity: 5000, deliver_by: 1793300000, previous: first.offer, now: NOW }, seed("kA"));
    expect(() => planOffer({ listing, offer: second.offer, epoch: 42 })).toThrow(/lawan tidak boleh sama dengan pemasang/);
    const viaSecond = planOffer({ listing, offer: second.offer, epoch: 42, counterparty: LAWAN });
    if (viaSecond.kind !== "bundle") throw new Error("harus bundle");
    // pemasang menawar balik 95: lawan membayar 95 ke Andi, Andi membayar 100 + cashback 9,5 ke lawan
    const byKey = <T extends { payer: string; payee: string }>(legs: T[]) => [...legs].sort((a, b) => (a.payer + a.payee < b.payer + b.payee ? -1 : 1));
    expect(byKey(viaSecond.terms.legs)).toEqual(byKey([
      { payer: ANDI, payee: LAWAN, max_amount: "109500000" },
      { payer: LAWAN, payee: ANDI, max_amount: "95000000" },
    ]));
  });

  it("planOffer memakai nilai kesepakatan Offer.value, bukan nilai awal listing", () => {
    const first = counterOffer({ listing, proposer: LAWAN, mode: "barter", value: "90000000", quantity: 5000, deliver_by: 1793300000, now: NOW }, seed("kB"));
    const barter = planOffer({ listing, offer: first.offer, epoch: 42, searcher: PENCARI, searcherShareBps: 300 });
    if (barter.kind !== "bundle") throw new Error("harus bundle");
    const amount = (payer: string, payee: string) => barter.terms.legs.find((l) => l.payer === payer && l.payee === payee)?.max_amount;
    // diskon 10% dari 90 = 9, jatah 3% dari 90 = 2,7, cashback 6,3; lawan membayar 90 ke Andi
    expect(amount(LAWAN, ANDI)).toBe("90000000");
    expect(amount(ANDI, LAWAN)).toBe("106300000");
    expect(amount(ANDI, PENCARI)).toBe("2700000");
    expect(barter.discount).toBe("9000000");
    const pay = planOffer({ listing, offer: { ...first.offer, mode: "pay" }, epoch: 42 });
    expect(pay).toMatchObject({ kind: "payment", amount: "81000000", discount: "9000000" });
  });
});
