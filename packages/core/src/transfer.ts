// Listing of a transfer through the official feature of a platform (SD-077, pipeline P4, ADR-49). A domain, a game item or a ticket changes hands through the platform itself (a registrar
// transfer, a Steam trade offer, a ticket transfer); x207 holds the voucher of the buyer until the platform shows that it happened. The contract does not change: on the chain there is a
// voucher with `resource = "x207:transfer:<hash>"`. This module is the format: the document and its hash, the resource, the texts of the DNS proof, the voucher, and the bundle of two legs
// with an arbiter for a value at or above `bond_threshold` (SD-067 pattern, CT-094). The backend (BE-074, docs/transfers.md) checks the same rules with the same names.
//
// The module needs no node:crypto or Buffer, so it runs in the browser. Limits that stay: the proof says that the buyer controlled the domain, or that the trade was accepted, at the
// moment it was checked; a registrar can take a transfer back for about 60 days while the bond window is 14 days (ADR-49 point 2), and a ticket is the word of the buyer.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CREDIT_UNIT } from "./constants.js";
import type { BundleTerms } from "./barter.js";
import type { AccountId, U128String, UnsignedVoucher } from "./types.js";

export const TRANSFER_RESOURCE_PREFIX = "x207:transfer:";
export const TRANSFER_PLATFORMS = ["domain", "game_item", "ticket"] as const;
export type TransferPlatform = (typeof TRANSFER_PLATFORMS)[number];
export const TRANSFER_PROOF_METHODS = ["dns_txt", "trade_api", "buyer_confirm"] as const;
export type TransferProofMethod = (typeof TRANSFER_PROOF_METHODS)[number];
/** The mapping is fixed: a domain is proved by DNS, a game item by the trade API, a ticket by the buyer. */
export const TRANSFER_PLATFORM_METHOD: Readonly<Record<TransferPlatform, TransferProofMethod>> = { domain: "dns_txt", game_item: "trade_api", ticket: "buyer_confirm" };
/** How long the voucher is held while the transfer is made (ADR-49): a domain 7 days, a ticket 1 day, a game item 1 hour. The backend applies it; this is the reference. */
export const TRANSFER_WINDOW_SECONDS: Readonly<Record<TransferPlatform, number>> = { domain: 7 * 86_400, ticket: 86_400, game_item: 3_600 };
/** A ticket is limited to 100 credit (ADR-49 point 4), in the smallest unit (1 credit = 1_000_000). */
export const TRANSFER_TICKET_LIMIT: U128String = "100000000";
/** The default `bond_threshold` of the circle: at or above it a transfer is a bundle of two legs with an arbiter. */
export const TRANSFER_BOND_THRESHOLD: U128String = "100000000";
/** The window of the bond for a transfer (ADR-49 point 2): 14 days, shorter than the 60 days in which a registrar can take a transfer back. */
export const TRANSFER_BOND_WINDOW_SECONDS = 14 * 86_400;

export type TransferErrorCode =
  | "transfer_bad_account" | "transfer_bad_hash" | "transfer_bad_platform" | "transfer_bad_ref" | "transfer_bad_method" | "transfer_method_mismatch" | "transfer_bad_value"
  | "transfer_bad_estimate" | "transfer_bad_nonce" | "transfer_bad_resource" | "transfer_bad_txt" | "transfer_ticket_over_limit" | "transfer_bond_threshold_invalid"
  | "transfer_arbiter_required";

export class TransferError extends Error {
  constructor(readonly code: TransferErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TransferError";
  }
}
const fail = (code: TransferErrorCode, message: string): never => {
  throw new TransferError(code, message);
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const U128_MAX = (1n << 128n) - 1n;
const amount = (value: unknown, name: string, code: TransferErrorCode): bigint => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return fail(code, `${name} must be a decimal whole number above 0 with no leading zeros`);
  const n = BigInt(value);
  if (n > U128_MAX) return fail(code, `${name} is above u128`);
  return n;
};

export type TransferDocument = {
  circle: AccountId;
  /** The account that sells: the account of the listing. */
  seller: AccountId;
  platform: TransferPlatform;
  /** What is transferred: a domain name, `<appid>:<assetid>` of a game item, or a free text of 1 to 256 characters for a ticket. */
  transfer_ref: string;
  proof_method: TransferProofMethod;
  /** The seller's estimate of how long the transfer takes, in seconds: 1 up to the window of the platform. */
  estimate_seconds: number;
  /** The price in the smallest unit of credit: `offer.value` of the listing. */
  value: U128String;
  /** 1 to 64 characters `[A-Za-z0-9._-]`. */
  nonce: string;
};

const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A domain name in lowercase ASCII (a punycode name for an international one): 2 to 127 labels of 1 to 63 characters, the last one letters (a TLD), 253 characters at most. */
export function isDomainName(name: string): boolean {
  if (name.length < 3 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => DOMAIN_LABEL.test(l)) && /^[a-z]{2,63}$|^xn--[a-z0-9-]{1,59}$/.test(labels[labels.length - 1]!);
}

export function normalizeTransfer(doc: TransferDocument): TransferDocument {
  for (const [name, value] of [["circle", doc.circle], ["seller", doc.seller]] as const) if (!isAccount(value)) fail("transfer_bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
  if (!(TRANSFER_PLATFORMS as readonly string[]).includes(doc.platform)) fail("transfer_bad_platform", `platform must be one of ${TRANSFER_PLATFORMS.join(", ")}`);
  if (!(TRANSFER_PROOF_METHODS as readonly string[]).includes(doc.proof_method)) fail("transfer_bad_method", `proof_method must be one of ${TRANSFER_PROOF_METHODS.join(", ")}`);
  if (TRANSFER_PLATFORM_METHOD[doc.platform] !== doc.proof_method) fail("transfer_method_mismatch", `a ${doc.platform} is proved by ${TRANSFER_PLATFORM_METHOD[doc.platform]}, not by ${doc.proof_method}`);
  const ref = doc.transfer_ref;
  if (typeof ref !== "string") fail("transfer_bad_ref", "transfer_ref must be text");
  if (doc.platform === "domain" && !isDomainName(ref)) fail("transfer_bad_ref", "transfer_ref of a domain must be a domain name in lowercase ASCII (punycode for an international name)");
  if (doc.platform === "game_item" && !/^\d{1,20}:\d{1,20}$/.test(ref)) fail("transfer_bad_ref", "transfer_ref of a game item must be <appid>:<assetid>, digits only");
  if (doc.platform === "ticket" && (ref.length < 1 || ref.length > 256 || ref !== ref.trim() || /[\u0000-\u001f\u007f]/.test(ref))) {
    fail("transfer_bad_ref", "transfer_ref of a ticket must be 1 to 256 characters, with no control characters and no spaces at the ends");
  }
  if (!Number.isSafeInteger(doc.estimate_seconds) || doc.estimate_seconds < 1 || doc.estimate_seconds > TRANSFER_WINDOW_SECONDS[doc.platform]) {
    fail("transfer_bad_estimate", `estimate_seconds must be an integer from 1 to ${TRANSFER_WINDOW_SECONDS[doc.platform]} (the window of a ${doc.platform})`);
  }
  const value = amount(doc.value, "value", "transfer_bad_value");
  if (doc.platform === "ticket" && value > BigInt(TRANSFER_TICKET_LIMIT)) fail("transfer_ticket_over_limit", `a ticket is limited to ${TRANSFER_TICKET_LIMIT} units (100 credit)`);
  if (typeof doc.nonce !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(doc.nonce)) fail("transfer_bad_nonce", "nonce must be 1 to 64 characters [A-Za-z0-9._-]");
  return {
    circle: doc.circle, seller: doc.seller, platform: doc.platform, transfer_ref: doc.transfer_ref, proof_method: doc.proof_method, estimate_seconds: doc.estimate_seconds, value: doc.value,
    nonce: doc.nonce,
  };
}
/** The canonical JSON: the keys `circle, seller, platform, transfer_ref, proof_method, estimate_seconds, value, nonce`, in that order. */
export const serializeTransfer = (doc: TransferDocument): string => JSON.stringify(normalizeTransfer(doc));
/** `transfer_doc` of the listing detail: sha256 of the canonical JSON, hex of 64 characters. */
export const transferDocumentHash = (doc: TransferDocument): string => bytesToHex(sha256(utf8(serializeTransfer(doc))));
export function transferResource(hash: string): string {
  if (!HASH.test(hash)) return fail("transfer_bad_resource", "the hash of a transfer document must be 64 lowercase hex characters");
  return `${TRANSFER_RESOURCE_PREFIX}${hash}`;
}
export function parseTransferResource(resource: string): string | null {
  if (!resource.startsWith(TRANSFER_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(TRANSFER_RESOURCE_PREFIX.length);
  return HASH.test(hash) ? hash : null;
}

/** The text of the DNS TXT record that the seller of a domain sets before the listing: `x207-sell=<listing_hash>`. */
export function sellTxt(listingHash: string): string {
  if (!HASH.test(listingHash)) return fail("transfer_bad_hash", "the listing hash must be 64 lowercase hex characters");
  return `x207-sell=${listingHash}`;
}
/**
 * The text `x207-own=<id>`. Since UM-096 the backend binds the text of a domain transfer to the voucher of the buyer: it is `x207-own=<transfer id>-<token>` and the answer of the purchase
 * gives it whole (`instructions.setTxtAfterTransfer`), so the buyer sets that value; pass `<transfer id>-<token>` here to build the same text.
 */
export function ownTxt(purchaseId: number | string): string {
  const id = String(purchaseId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail("transfer_bad_txt", "the purchase id must be 1 to 64 characters [A-Za-z0-9_-]");
  return `x207-own=${id}`;
}
/** Reads a TXT value: `{kind: "sell", value: <listing hash>}`, `{kind: "own", value: <purchase id>}`, or `null` for a text that is neither (a TXT record of something else on the domain). */
export function parseTxt(text: string): { kind: "sell" | "own"; value: string } | null {
  const sell = /^x207-sell=([0-9a-f]{64})$/.exec(text);
  if (sell) return { kind: "sell", value: sell[1]! };
  const own = /^x207-own=([A-Za-z0-9_-]{1,64})$/.exec(text);
  return own ? { kind: "own", value: own[1]! } : null;
}

/**
 * The voucher of the buyer for a transfer: for the seller, `resource` `x207:transfer:<hash>`, continuing the state of the pair in `epoch`. `state` is what the pair holds: the registered
 * state or the highest held voucher of other purchases of the pair, whichever is higher (the backend counts the held ones), and the cumulative adds the price to it.
 */
export function transferVoucher(args: { doc: TransferDocument; buyer: AccountId; epoch: number; state: { seq: number; cumulativeAmount: U128String } }): UnsignedVoucher {
  const d = normalizeTransfer(args.doc);
  if (!isAccount(args.buyer)) fail("transfer_bad_account", `buyer is not a NEAR account: ${JSON.stringify(args.buyer)}`);
  if (args.buyer === d.seller) fail("transfer_bad_account", "buyer and seller must be two accounts");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("transfer_bad_value", `epoch must be an integer >= 1, got ${args.epoch}`);
  if (!Number.isSafeInteger(args.state.seq) || args.state.seq < 0 || !/^(0|[1-9]\d*)$/.test(args.state.cumulativeAmount)) fail("transfer_bad_value", `invalid pair state: ${JSON.stringify(args.state)}`);
  return {
    circle: d.circle, payer: args.buyer, payee: d.seller, epoch: args.epoch, seq: args.state.seq + 1,
    cumulativeAmount: (BigInt(args.state.cumulativeAmount) + BigInt(d.value)).toString(), unit: CREDIT_UNIT, resource: transferResource(transferDocumentHash(d)),
  };
}

/** Is the value at or above the threshold? Then the transfer is a bundle of two legs with an arbiter, not a plain voucher. */
export function transferNeedsBond(doc: Pick<TransferDocument, "value">, bondThreshold: U128String = TRANSFER_BOND_THRESHOLD): boolean {
  const threshold = bondThreshold;
  if (typeof threshold !== "string" || !/^(0|[1-9]\d*)$/.test(threshold) || BigInt(threshold) > U128_MAX) return fail("transfer_bond_threshold_invalid", `bond_threshold must be a decimal whole number, got ${JSON.stringify(threshold)}`);
  return amount(doc.value, "value", "transfer_bad_value") >= BigInt(threshold);
}

/**
 * The bundle that carries a transfer at or above `bond_threshold` (SD-067, CT-094): the leg of the buyer to the seller for the price, and the counter leg of the seller to the buyer of 1
 * smallest unit (the contract wants two legs), with the `arbiter` that both parties chose, `confirm_by` (nanoseconds, a decimal string) at most `TRANSFER_BOND_WINDOW_SECONDS` after
 * `now`, and optionally the `agreement_hash`. For a value at or above the threshold an arbiter is required (`transfer_arbiter_required`): the bond of CT-094 exists only for a bundle of
 * two parties with an arbiter. For a lower value an arbiter is allowed and not needed. The arbiter is neither the buyer nor the seller.
 */
export function transferBundleTerms(args: {
  doc: TransferDocument; buyer: AccountId; epoch: number; arbiter?: AccountId | null; confirmBy?: string | null; nowNs?: bigint; agreementHash?: string | null; bondThreshold?: U128String;
}): BundleTerms {
  const d = normalizeTransfer(args.doc);
  if (!isAccount(args.buyer)) fail("transfer_bad_account", `buyer is not a NEAR account: ${JSON.stringify(args.buyer)}`);
  if (args.buyer === d.seller) fail("transfer_bad_account", "buyer and seller must be two accounts");
  if (!Number.isSafeInteger(args.epoch) || args.epoch < 1) fail("transfer_bad_value", `epoch must be an integer >= 1, got ${args.epoch}`);
  const arbiter = args.arbiter ?? null;
  const needs = transferNeedsBond(d, args.bondThreshold);
  if (arbiter === null) {
    if (needs) fail("transfer_arbiter_required", "a transfer at or above bond_threshold needs an arbiter: the bond of CT-094 exists only for a bundle of two parties with an arbiter");
    return { circle: d.circle, epoch: args.epoch, legs: [{ payer: args.buyer, payee: d.seller, max_amount: d.value }, { payer: d.seller, payee: args.buyer, max_amount: "1" }] };
  }
  if (!isAccount(arbiter)) fail("transfer_bad_account", `arbiter is not a NEAR account: ${JSON.stringify(arbiter)}`);
  if (arbiter === d.seller || arbiter === args.buyer) fail("transfer_bad_account", "the arbiter must be neither the buyer nor the seller");
  if (args.agreementHash !== undefined && args.agreementHash !== null && !HASH.test(args.agreementHash)) fail("transfer_bad_hash", "agreement_hash must be 64 lowercase hex characters");
  const confirmBy = args.confirmBy ?? null;
  if (confirmBy === null) return fail("transfer_bad_estimate", "confirm_by is required with an arbiter: the end of the window of the bond, in nanoseconds");
  if (!/^[1-9]\d*$/.test(confirmBy)) fail("transfer_bad_estimate", "confirm_by must be a decimal string of nanoseconds");
  if (args.nowNs !== undefined && BigInt(confirmBy) > args.nowNs + BigInt(TRANSFER_BOND_WINDOW_SECONDS) * 1_000_000_000n) {
    fail("transfer_bad_estimate", `confirm_by is more than ${TRANSFER_BOND_WINDOW_SECONDS} seconds (14 days) after now: the bond window of a transfer is 14 days`);
  }
  return {
    circle: d.circle, epoch: args.epoch, legs: [{ payer: args.buyer, payee: d.seller, max_amount: d.value }, { payer: d.seller, payee: args.buyer, max_amount: "1" }],
    arbiter, ...(args.agreementHash ? { agreement_hash: args.agreementHash } : {}), confirm_by: confirmBy,
  };
}
