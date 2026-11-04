import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TRANSFER_BOND_THRESHOLD, TRANSFER_BOND_WINDOW_SECONDS, TRANSFER_PLATFORM_METHOD, TRANSFER_TICKET_LIMIT, TRANSFER_WINDOW_SECONDS, TransferError, isDomainName, termsHash, validateBundleTerms, normalizeTransfer,
  ownTxt, parseTransferResource, parseTxt, sellTxt, serializeTransfer, transferBundleTerms, transferDocumentHash, transferNeedsBond, transferResource, transferVoucher,
  type TransferDocument,
} from "../src/index.js";

// SD-077 (P4, ADR-49): the format of a transfer listing through the official feature of a platform.
const CIRCLE = "x207-circle.near";
const SELLER = "seller.x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const doc = (over: Partial<TransferDocument> = {}): TransferDocument => ({
  circle: CIRCLE, seller: SELLER, platform: "domain", transfer_ref: "example-shop.com", proof_method: "dns_txt", estimate_seconds: 86_400, value: "30000000", nonce: "n1", ...over,
});
const errCode = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof TransferError ? e.code : `other: ${String(e)}`;
  }
};

describe("SD-077 document, hash and resource", () => {
  it("TC-SD-077-01 the canonical JSON has the fixed key order and the hash is sha256 of it (checked with node crypto), whatever the order of the keys that the caller used", () => {
    const d = doc();
    expect(serializeTransfer(d)).toBe(`{"circle":"${CIRCLE}","seller":"${SELLER}","platform":"domain","transfer_ref":"example-shop.com","proof_method":"dns_txt","estimate_seconds":86400,"value":"30000000","nonce":"n1"}`);
    expect(transferDocumentHash(d)).toBe(createHash("sha256").update(serializeTransfer(d)).digest("hex"));
    const shuffled = { nonce: "n1", value: "30000000", estimate_seconds: 86_400, proof_method: "dns_txt", transfer_ref: "example-shop.com", platform: "domain", seller: SELLER, circle: CIRCLE } as TransferDocument;
    expect(transferDocumentHash(shuffled)).toBe(transferDocumentHash(d));
    expect(transferDocumentHash(doc({ value: "30000001" }))).not.toBe(transferDocumentHash(d));
    expect(transferDocumentHash(doc({ nonce: "n2" }))).not.toBe(transferDocumentHash(d));
  });

  it("TC-SD-077-02 the resource is x207:transfer:<hash> and parses back; anything else is null", () => {
    const h = transferDocumentHash(doc());
    expect(transferResource(h)).toBe(`x207:transfer:${h}`);
    expect(parseTransferResource(transferResource(h))).toBe(h);
    expect(parseTransferResource(`x207:code:${h}`)).toBeNull();
    expect(parseTransferResource("x207:transfer:xyz")).toBeNull();
    expect(errCode(() => transferResource("abc"))).toBe("transfer_bad_resource");
  });

  it("TC-SD-077-03 the platform fixes the proof method; a mismatch, an unknown platform or an unknown method is refused", () => {
    expect(TRANSFER_PLATFORM_METHOD).toEqual({ domain: "dns_txt", game_item: "trade_api", ticket: "buyer_confirm" });
    expect(errCode(() => normalizeTransfer(doc({ proof_method: "buyer_confirm" })))).toBe("transfer_method_mismatch");
    expect(errCode(() => normalizeTransfer(doc({ platform: "website" as never })))).toBe("transfer_bad_platform");
    expect(errCode(() => normalizeTransfer(doc({ proof_method: "email" as never })))).toBe("transfer_bad_method");
    expect(() => normalizeTransfer(doc({ platform: "game_item", transfer_ref: "730:1234567890", proof_method: "trade_api", estimate_seconds: 3600 }))).not.toThrow();
    expect(() => normalizeTransfer(doc({ platform: "ticket", transfer_ref: "Concert A, row 4 seat 12", proof_method: "buyer_confirm", value: "20000000" }))).not.toThrow();
  });

  it("TC-SD-077-04 transfer_ref per platform: a domain name in lowercase ASCII, <appid>:<assetid> digits, a ticket text of 1 to 256 characters", () => {
    for (const ok of ["example.com", "a-b.example.co.uk", "xn--bcher-kva.example", "shop.example.xn--p1ai"]) expect(isDomainName(ok), ok).toBe(true);
    for (const bad of ["example", "Example.com", "-a.com", "a-.com", "a..com", "exa mple.com", "example.c", "example.123", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`]) expect(isDomainName(bad), bad).toBe(false);
    expect(errCode(() => normalizeTransfer(doc({ transfer_ref: "not a domain" })))).toBe("transfer_bad_ref");
    const game = { platform: "game_item", proof_method: "trade_api", estimate_seconds: 3600 } as const;
    expect(errCode(() => normalizeTransfer(doc({ ...game, transfer_ref: "730" })))).toBe("transfer_bad_ref");
    expect(errCode(() => normalizeTransfer(doc({ ...game, transfer_ref: "730:abc" })))).toBe("transfer_bad_ref");
    const ticket = { platform: "ticket", proof_method: "buyer_confirm", estimate_seconds: 3600, value: "5000000" } as const;
    expect(errCode(() => normalizeTransfer(doc({ ...ticket, transfer_ref: "" })))).toBe("transfer_bad_ref");
    expect(errCode(() => normalizeTransfer(doc({ ...ticket, transfer_ref: "x".repeat(257) })))).toBe("transfer_bad_ref");
    expect(errCode(() => normalizeTransfer(doc({ ...ticket, transfer_ref: "line\nbreak" })))).toBe("transfer_bad_ref");
    expect(() => normalizeTransfer(doc({ ...ticket, transfer_ref: "x".repeat(256) }))).not.toThrow();
  });

  it("TC-SD-077-05 estimate_seconds is 1 up to the window of the platform; the value is a whole number above 0; the nonce is 1 to 64 characters; accounts are NEAR accounts", () => {
    expect(TRANSFER_WINDOW_SECONDS).toEqual({ domain: 604_800, ticket: 86_400, game_item: 3_600 });
    expect(() => normalizeTransfer(doc({ estimate_seconds: 604_800 }))).not.toThrow();
    for (const bad of [0, -1, 604_801, 1.5, Number.NaN]) expect(errCode(() => normalizeTransfer(doc({ estimate_seconds: bad }))), String(bad)).toBe("transfer_bad_estimate");
    for (const bad of ["0", "010", "1.5", "-5", "", (2n ** 128n).toString()]) expect(errCode(() => normalizeTransfer(doc({ value: bad }))), bad).toBe("transfer_bad_value");
    expect(errCode(() => normalizeTransfer(doc({ nonce: "" })))).toBe("transfer_bad_nonce");
    expect(errCode(() => normalizeTransfer(doc({ nonce: "a".repeat(65) })))).toBe("transfer_bad_nonce");
    expect(errCode(() => normalizeTransfer(doc({ nonce: "has space" })))).toBe("transfer_bad_nonce");
    expect(() => normalizeTransfer(doc({ nonce: "a".repeat(64) }))).not.toThrow();
    expect(errCode(() => normalizeTransfer(doc({ seller: "Bad Account" })))).toBe("transfer_bad_account");
    expect(errCode(() => normalizeTransfer(doc({ circle: "x" })))).toBe("transfer_bad_account");
  });

  it("TC-SD-077-06 a ticket above 100 credit is refused, at 100 credit it is allowed; the limit is only for tickets", () => {
    expect(TRANSFER_TICKET_LIMIT).toBe("100000000");
    const t = { platform: "ticket", proof_method: "buyer_confirm", transfer_ref: "Concert A", estimate_seconds: 3600 } as const;
    expect(() => normalizeTransfer(doc({ ...t, value: "100000000" }))).not.toThrow();
    expect(errCode(() => normalizeTransfer(doc({ ...t, value: "100000001" })))).toBe("transfer_ticket_over_limit");
    expect(() => normalizeTransfer(doc({ value: "900000000" }))).not.toThrow(); // a domain may cost more (it then needs a bond)
  });
});

describe("SD-077 the texts of the DNS proof and the voucher", () => {
  it("TC-SD-077-07 the TXT texts: x207-sell=<listing hash> and x207-own=<purchase id>, read back; another TXT record is null", () => {
    const h = "a".repeat(64);
    expect(sellTxt(h)).toBe(`x207-sell=${h}`);
    expect(ownTxt(17)).toBe("x207-own=17");
    expect(ownTxt("tr_9-x")).toBe("x207-own=tr_9-x");
    expect(parseTxt(sellTxt(h))).toEqual({ kind: "sell", value: h });
    expect(parseTxt(ownTxt(17))).toEqual({ kind: "own", value: "17" });
    for (const other of ["v=spf1 include:_spf.example.com ~all", "x207-sell=abc", `x207-sell=${"A".repeat(64)}`, "x207-own=", "x207-own=a b", " x207-own=1", "x207-own=1 "]) expect(parseTxt(other), other).toBeNull();
    expect(errCode(() => sellTxt("abc"))).toBe("transfer_bad_hash");
    expect(errCode(() => ownTxt(""))).toBe("transfer_bad_txt");
    expect(errCode(() => ownTxt("a b"))).toBe("transfer_bad_txt");
  });

  it("TC-SD-077-08 the voucher of the buyer continues the state of the pair, adds the price and carries the resource of the document; buyer and seller are two accounts", () => {
    const d = doc();
    const v = transferVoucher({ doc: d, buyer: BUYER, epoch: 42, state: { seq: 3, cumulativeAmount: "2000000" } });
    expect(v).toEqual({ circle: CIRCLE, payer: BUYER, payee: SELLER, epoch: 42, seq: 4, cumulativeAmount: "32000000", unit: "credit", resource: transferResource(transferDocumentHash(d)) });
    expect(errCode(() => transferVoucher({ doc: d, buyer: SELLER, epoch: 42, state: { seq: 0, cumulativeAmount: "0" } }))).toBe("transfer_bad_account");
    expect(errCode(() => transferVoucher({ doc: d, buyer: BUYER, epoch: 0, state: { seq: 0, cumulativeAmount: "0" } }))).toBe("transfer_bad_value");
    expect(errCode(() => transferVoucher({ doc: d, buyer: BUYER, epoch: 1, state: { seq: -1, cumulativeAmount: "0" } }))).toBe("transfer_bad_value");
    expect(errCode(() => transferVoucher({ doc: d, buyer: BUYER, epoch: 1, state: { seq: 0, cumulativeAmount: "01" } }))).toBe("transfer_bad_value");
  });
});

describe("SD-077 a transfer at or above bond_threshold is a bundle of two legs with an arbiter", () => {
  const big = () => doc({ value: "250000000" });
  const NOW = 1_800_000_000_000_000_000n;

  it("TC-SD-077-09 transferNeedsBond: at the threshold (100 credit) and above; below it not; a bad threshold is refused", () => {
    expect(TRANSFER_BOND_THRESHOLD).toBe("100000000");
    expect(transferNeedsBond({ value: "99999999" })).toBe(false);
    expect(transferNeedsBond({ value: "100000000" })).toBe(true);
    expect(transferNeedsBond({ value: "100000000" }, "200000000")).toBe(false);
    expect(errCode(() => transferNeedsBond({ value: "1" }, "-1"))).toBe("transfer_bond_threshold_invalid");
    expect(errCode(() => transferNeedsBond({ value: "1" }, "1.5"))).toBe("transfer_bond_threshold_invalid");
  });

  it("TC-SD-077-10 without an arbiter a value at or above the threshold is refused (transfer_arbiter_required); below it the bundle has no arbiter", () => {
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42 }))).toBe("transfer_arbiter_required");
    expect(errCode(() => transferBundleTerms({ doc: doc({ value: "100000000" }), buyer: BUYER, epoch: 42, arbiter: null }))).toBe("transfer_arbiter_required");
    const small = transferBundleTerms({ doc: doc(), buyer: BUYER, epoch: 42 });
    expect(small).toEqual({ circle: CIRCLE, epoch: 42, legs: [{ payer: BUYER, payee: SELLER, max_amount: "30000000" }, { payer: SELLER, payee: BUYER, max_amount: "1" }] });
    expect(small.arbiter).toBeUndefined();
  });

  it("TC-SD-077-11 with an arbiter the terms carry arbiter, confirm_by and an optional agreement_hash, as the contract wants them; the arbiter is not a party; confirm_by is within 14 days", () => {
    const confirmBy = (NOW + 7n * 86_400n * 1_000_000_000n).toString();
    const t = transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near", confirmBy, nowNs: NOW, agreementHash: "b".repeat(64) });
    expect(t).toEqual({
      circle: CIRCLE, epoch: 42, legs: [{ payer: BUYER, payee: SELLER, max_amount: "250000000" }, { payer: SELLER, payee: BUYER, max_amount: "1" }], arbiter: "arbiter.near", agreement_hash: "b".repeat(64), confirm_by: confirmBy,
    });
    expect(() => validateBundleTerms(t)).not.toThrow(); // the terms are valid for the bundle format of SD-073 (two participants, an arbiter that is not one of them)
    expect(termsHash(t)).toMatch(/^[0-9a-f]{64}$/);
    const noAgreement = transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near", confirmBy });
    expect("agreement_hash" in noAgreement).toBe(false);
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: SELLER, confirmBy }))).toBe("transfer_bad_account");
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: BUYER, confirmBy }))).toBe("transfer_bad_account");
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "Bad Arbiter", confirmBy }))).toBe("transfer_bad_account");
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near" }))).toBe("transfer_bad_estimate"); // confirm_by is needed with an arbiter
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near", confirmBy: "1.5" }))).toBe("transfer_bad_estimate");
    const late = (NOW + BigInt(TRANSFER_BOND_WINDOW_SECONDS + 1) * 1_000_000_000n).toString();
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near", confirmBy: late, nowNs: NOW }))).toBe("transfer_bad_estimate");
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: BUYER, epoch: 42, arbiter: "arbiter.near", confirmBy, agreementHash: "xyz" }))).toBe("transfer_bad_hash");
    expect(errCode(() => transferBundleTerms({ doc: big(), buyer: SELLER, epoch: 42, arbiter: "arbiter.near", confirmBy }))).toBe("transfer_bad_account");
  });
});
