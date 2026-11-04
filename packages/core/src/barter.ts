// Barter intents and bundle proposals (SD-047, F5/F9): canonical JSON, hash, and ed25519 signature with the voucher key.
// Byte format and rationale: spec/barter-format.md. The Rust contract (commit_bundle, post_intent) builds the same bytes.
import { createHash } from "node:crypto";
import { base58Encode } from "./base58.js";
import { MAX_BUNDLE_LEGS } from "./constants.js";
import type { BundleLeg } from "./events.js";
import { nep413SigningHash, signHash, verifyHash, type VoucherSecretKey } from "./voucher.js";
import type { AccountId, Ed25519Signature, U128String } from "./types.js";

const U128_MAX = 340282366920938463463374607431768211455n;
const AMOUNT = /^[1-9]\d*$/;
const SERVICE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const NONCE = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

export class BarterFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarterFormatError";
  }
}

const isAccount = (value: unknown): value is AccountId =>
  typeof value === "string" && value.length >= 2 && value.length <= 64 && ACCOUNT.test(value);
const isPositiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const isAmount = (value: unknown): value is U128String =>
  typeof value === "string" && AMOUNT.test(value) && BigInt(value) <= U128_MAX;

/** One side of an intent: the service, number of calls, and total value in credit (smallest unit, 6 decimals). */
export type BarterSide = { service: string; calls: number; value: U128String };

/** Barter intent: the account offers `offer` and needs `need`, valid until `expiresAt` (unix seconds). */
export type BarterIntent = {
  circle: AccountId;
  account: AccountId;
  offer: BarterSide;
  need: BarterSide;
  expiresAt: number;
  /** Distinguishes intents with identical content from the same account. */
  nonce: string;
};

/** F9 searcher leg (interface 0.0.5): a (payer, payee) pair that is one of the bundle legs; the contract limits it with `max_search_share_bps`. */
export type SearchLeg = { payer: AccountId; payee: AccountId };

/**
 * Bundle terms approved by all parties: `terms_hash` is computed from its canonical form. `search_leg` is optional (SD-047, interface 0.0.5):
 * if present, its key comes last in the canonical JSON; if absent (or `null`), the bytes and `terms_hash` equal the format before 0.0.5.
 */
export type BundleTerms = {
  circle: AccountId; epoch: number; legs: BundleLeg[]; search_leg?: SearchLeg | null;
  /**
   * CT-094 (interface 0.0.12, SD-073): the arbiter that both parties of a swap of two chose. It is part of the signed terms and the sign that the swap carries a bond. `arbiter` and
   * `confirm_by` come together; `agreement_hash` needs them. The three keys come after `search_leg` in the canonical JSON, so a bundle without them keeps its `terms_hash`.
   */
  arbiter?: AccountId | null;
  /** sha256 (64 lowercase hex) of the document of the agreement, kept off-chain. */
  agreement_hash?: string | null;
  /** The end of the window in which a party can confirm or dispute, in nanoseconds, as a decimal string (it does not fit a JavaScript number). */
  confirm_by?: string | null;
};

function checkSide(side: BarterSide, name: string): void {
  if (typeof side !== "object" || side === null) throw new BarterFormatError(`${name} must be an object`);
  if (typeof side.service !== "string" || !SERVICE.test(side.service)) {
    throw new BarterFormatError(`${name}.service must be ASCII lowercase letters, digits, dot, colon, hyphen or underscore (1-64)`);
  }
  if (!isPositiveInt(side.calls)) throw new BarterFormatError(`${name}.calls must be an integer >= 1`);
  if (!isAmount(side.value)) throw new BarterFormatError(`${name}.value must be a decimal string > 0 with no leading zeros and <= U128`);
}

export function validateIntent(intent: BarterIntent): void {
  if (!isAccount(intent.circle)) throw new BarterFormatError("circle is not a NEAR account");
  if (!isAccount(intent.account)) throw new BarterFormatError("account is not a NEAR account");
  checkSide(intent.offer, "offer");
  checkSide(intent.need, "need");
  if (!isPositiveInt(intent.expiresAt)) throw new BarterFormatError("expiresAt must be an integer of unix seconds >= 1");
  if (typeof intent.nonce !== "string" || !NONCE.test(intent.nonce)) throw new BarterFormatError("nonce must be 1-64 characters [A-Za-z0-9_-]");
}

const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function validateBundleTerms(terms: BundleTerms): void {
  if (!isAccount(terms.circle)) throw new BarterFormatError("circle is not a NEAR account");
  if (!isPositiveInt(terms.epoch)) throw new BarterFormatError("epoch must be an integer >= 1");
  if (!Array.isArray(terms.legs) || terms.legs.length < 2) throw new BarterFormatError("a bundle needs at least two legs");
  if (terms.legs.length > MAX_BUNDLE_LEGS) throw new BarterFormatError(`bundle has ${terms.legs.length} legs, contract limit ${MAX_BUNDLE_LEGS} (ERR_BAD_BUNDLE); split into several bundles`);
  const seen = new Set<string>();
  for (const leg of terms.legs) {
    if (!isAccount(leg.payer) || !isAccount(leg.payee)) throw new BarterFormatError("payer and payee must be NEAR accounts");
    if (leg.payer === leg.payee) throw new BarterFormatError("a leg must not pay itself");
    if (!isAmount(leg.max_amount)) throw new BarterFormatError("max_amount must be a decimal string > 0 with no leading zeros and <= U128");
    const key = `${leg.payer}>${leg.payee}`;
    if (seen.has(key)) throw new BarterFormatError(`pair ${key} appears twice`);
    seen.add(key);
  }
  const search = terms.search_leg;
  if (search !== undefined && search !== null) {
    if (typeof search !== "object" || !isAccount(search.payer) || !isAccount(search.payee)) throw new BarterFormatError("search_leg must be {payer, payee} NEAR accounts");
    if (!seen.has(`${search.payer}>${search.payee}`)) throw new BarterFormatError("search_leg is not one of the bundle legs");
  }
  validateDealTerms(terms);
}

const HASH64 = /^[0-9a-f]{64}$/;
const U64_MAX = 18446744073709551615n;
/** CT-094 guarantee terms: `arbiter` and `confirm_by` come together, `agreement_hash` needs both, only for two participants, and the arbiter is not a participant. */
function validateDealTerms(terms: BundleTerms): void {
  const arbiter = terms.arbiter ?? null;
  const agreement = terms.agreement_hash ?? null;
  const confirmBy = terms.confirm_by ?? null;
  if (arbiter === null && agreement === null && confirmBy === null) return;
  if (arbiter === null || confirmBy === null) throw new BarterFormatError("arbiter and confirm_by come together; agreement_hash needs both (ERR_BAD_BUNDLE)");
  if (!isAccount(arbiter)) throw new BarterFormatError("arbiter is not a NEAR account");
  if (agreement !== null && !HASH64.test(agreement)) throw new BarterFormatError("agreement_hash must be 64 lowercase hex characters");
  if (typeof confirmBy !== "string" || !/^[1-9]\d*$/.test(confirmBy) || BigInt(confirmBy) > U64_MAX) throw new BarterFormatError("confirm_by must be a decimal string of nanoseconds > 0 and <= U64");
  const participants = new Set(terms.legs.flatMap((l) => [l.payer, l.payee]));
  if (participants.size !== 2) throw new BarterFormatError("arbiter is only for a two-participant swap (ERR_BAD_BUNDLE)");
  if (participants.has(arbiter)) throw new BarterFormatError("arbiter must not be a swap participant (ERR_ARBITER_INVALID)");
}

/** Canonical intent JSON: keys `circle, account, offer{service,calls,value}, need{...}, expiresAt, nonce`, no whitespace. */
export function serializeIntent(intent: BarterIntent): string {
  validateIntent(intent);
  const side = (s: BarterSide) => ({ service: s.service, calls: s.calls, value: s.value });
  return JSON.stringify({
    circle: intent.circle, account: intent.account, offer: side(intent.offer), need: side(intent.need),
    expiresAt: intent.expiresAt, nonce: intent.nonce,
  });
}

/** Canonical bundle terms JSON: `circle, epoch, legs[{payer,payee,max_amount}]` then `search_leg{payer,payee}` if set, then `arbiter`, `agreement_hash` (if present), `confirm_by` if there is an arbiter; legs sorted by (payer, payee). */
export function serializeBundleTerms(terms: BundleTerms): string {
  validateBundleTerms(terms);
  const legs = [...terms.legs]
    .sort((a, b) => byBytes(a.payer, b.payer) || byBytes(a.payee, b.payee))
    .map((l) => ({ payer: l.payer, payee: l.payee, max_amount: l.max_amount }));
  const search = terms.search_leg;
  return JSON.stringify({
    circle: terms.circle, epoch: terms.epoch, legs,
    ...(search !== undefined && search !== null ? { search_leg: { payer: search.payer, payee: search.payee } } : {}),
    ...(terms.arbiter ? { arbiter: terms.arbiter, ...(terms.agreement_hash ? { agreement_hash: terms.agreement_hash } : {}), confirm_by: terms.confirm_by } : {}),
  });
}

const sha256 = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** `sha256(canonical intent JSON)`: 32 bytes. */
export const intentHashBytes = (intent: BarterIntent): Uint8Array => sha256(serializeIntent(intent));
/** 64-character lowercase hex. */
export const intentHash = (intent: BarterIntent): string => hex(intentHashBytes(intent));
/** `Base58CryptoHash` for the `post_intent(intent_hash)` argument. */
export const intentHashBase58 = (intent: BarterIntent): string => base58Encode(intentHashBytes(intent));

/**
 * `bundle` argument for `commit_bundle` from the signed terms: `{epoch, legs}` and `search_leg` if present. The contract computes
 * `terms_hash` from this argument, so a signed `search_leg` must be sent too (interface 0.0.5).
 */
export const bundleInput = (terms: BundleTerms): { epoch: number; legs: BundleLeg[]; search_leg?: SearchLeg; arbiter?: AccountId; agreement_hash?: string; confirm_by?: string } => ({
  epoch: terms.epoch,
  legs: terms.legs,
  ...(terms.search_leg ? { search_leg: terms.search_leg } : {}),
  ...(terms.arbiter ? { arbiter: terms.arbiter, ...(terms.agreement_hash ? { agreement_hash: terms.agreement_hash } : {}), confirm_by: terms.confirm_by! } : {}),
});

/** `sha256(canonical bundle terms JSON)`: 32 bytes. */
export const termsHashBytes = (terms: BundleTerms): Uint8Array => sha256(serializeBundleTerms(terms));
/** `terms_hash` as 64 lowercase hex characters, signed by all participants. */
export const termsHash = (terms: BundleTerms): string => hex(termsHashBytes(terms));

/**
 * What is signed: the `sha256` of the NEP-413 payload with `message` = the canonical JSON, `nonce` = the hash of that message, and
 * `recipient` = the circle contract account. Same as the voucher, so the contract uses the same byte builder.
 */
export const bundleSigningHash = (terms: BundleTerms): Uint8Array =>
  nep413SigningHash(serializeBundleTerms(terms), termsHashBytes(terms), terms.circle);
export const intentSigningHash = (intent: BarterIntent): Uint8Array =>
  nep413SigningHash(serializeIntent(intent), intentHashBytes(intent), intent.circle);

export type BundleSignature = { account: AccountId; signature: Ed25519Signature };

export function signBundle(terms: BundleTerms, account: AccountId, secretKey: VoucherSecretKey): BundleSignature {
  return { account, signature: signHash(bundleSigningHash(terms), secretKey) };
}

export function verifyBundleSignature(terms: BundleTerms, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(bundleSigningHash(terms), signature, publicKey);
  } catch {
    return false;
  }
}

export const signIntent = (intent: BarterIntent, secretKey: VoucherSecretKey): Ed25519Signature =>
  signHash(intentSigningHash(intent), secretKey);

export function verifyIntentSignature(intent: BarterIntent, signature: string, publicKey: string): boolean {
  try {
    return verifyHash(intentSigningHash(intent), signature, publicKey);
  } catch {
    return false;
  }
}

/** Bundle participants: all accounts that appear as payer or payee, sorted. All of them must sign. */
export function bundleParticipants(terms: BundleTerms): AccountId[] {
  validateBundleTerms(terms);
  return [...new Set(terms.legs.flatMap((l) => [l.payer, l.payee]))].sort(byBytes);
}

/** `true` if all participants have a valid signature from their voucher pubkey (`pubkeys`: account -> pubkey). */
export function bundleFullySigned(terms: BundleTerms, signatures: readonly BundleSignature[], pubkeys: Readonly<Record<string, string>>): boolean {
  return bundleParticipants(terms).every((account) => {
    const pubkey = pubkeys[account];
    return pubkey !== undefined && signatures.some((s) => s.account === account && verifyBundleSignature(terms, s.signature, pubkey));
  });
}
