// Intent barter dan usulan bundle (SD-047, F5/F9): JSON kanonik, hash, dan tanda tangan ed25519 dengan kunci voucher.
// Format byte dan alasannya: spec/barter-format.md. Kontrak Rust (commit_bundle, post_intent) membangun byte yang sama.
import { createHash } from "node:crypto";
import { base58Encode } from "./base58.js";
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

/** Satu sisi intent: jasa, jumlah panggilan, dan nilai total dalam credit (satuan terkecil, 6 desimal). */
export type BarterSide = { service: string; calls: number; value: U128String };

/** Intent barter: akun menawarkan `offer` dan membutuhkan `need`, berlaku sampai `expiresAt` (detik unix). */
export type BarterIntent = {
  circle: AccountId;
  account: AccountId;
  offer: BarterSide;
  need: BarterSide;
  expiresAt: number;
  /** Pembeda antar intent dengan isi sama dari akun yang sama. */
  nonce: string;
};

/** Syarat bundle yang disetujui semua pihak: `terms_hash` dihitung dari bentuk kanoniknya. */
export type BundleTerms = { circle: AccountId; epoch: number; legs: BundleLeg[] };

function checkSide(side: BarterSide, name: string): void {
  if (typeof side !== "object" || side === null) throw new BarterFormatError(`${name} harus objek`);
  if (typeof side.service !== "string" || !SERVICE.test(side.service)) {
    throw new BarterFormatError(`${name}.service harus ASCII huruf kecil, angka, titik, titik dua, strip atau garis bawah (1-64)`);
  }
  if (!isPositiveInt(side.calls)) throw new BarterFormatError(`${name}.calls harus integer >= 1`);
  if (!isAmount(side.value)) throw new BarterFormatError(`${name}.value harus string desimal > 0 tanpa nol di depan dan <= U128`);
}

export function validateIntent(intent: BarterIntent): void {
  if (!isAccount(intent.circle)) throw new BarterFormatError("circle bukan akun NEAR");
  if (!isAccount(intent.account)) throw new BarterFormatError("account bukan akun NEAR");
  checkSide(intent.offer, "offer");
  checkSide(intent.need, "need");
  if (!isPositiveInt(intent.expiresAt)) throw new BarterFormatError("expiresAt harus integer detik unix >= 1");
  if (typeof intent.nonce !== "string" || !NONCE.test(intent.nonce)) throw new BarterFormatError("nonce harus 1-64 karakter [A-Za-z0-9_-]");
}

const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function validateBundleTerms(terms: BundleTerms): void {
  if (!isAccount(terms.circle)) throw new BarterFormatError("circle bukan akun NEAR");
  if (!isPositiveInt(terms.epoch)) throw new BarterFormatError("epoch harus integer >= 1");
  if (!Array.isArray(terms.legs) || terms.legs.length < 2) throw new BarterFormatError("bundle butuh minimal dua leg");
  const seen = new Set<string>();
  for (const leg of terms.legs) {
    if (!isAccount(leg.payer) || !isAccount(leg.payee)) throw new BarterFormatError("payer dan payee harus akun NEAR");
    if (leg.payer === leg.payee) throw new BarterFormatError("leg tidak boleh membayar diri sendiri");
    if (!isAmount(leg.max_amount)) throw new BarterFormatError("max_amount harus string desimal > 0 tanpa nol di depan dan <= U128");
    const key = `${leg.payer}>${leg.payee}`;
    if (seen.has(key)) throw new BarterFormatError(`pasangan ${key} muncul dua kali`);
    seen.add(key);
  }
}

/** JSON kanonik intent: key `circle, account, offer{service,calls,value}, need{...}, expiresAt, nonce`, tanpa spasi. */
export function serializeIntent(intent: BarterIntent): string {
  validateIntent(intent);
  const side = (s: BarterSide) => ({ service: s.service, calls: s.calls, value: s.value });
  return JSON.stringify({
    circle: intent.circle, account: intent.account, offer: side(intent.offer), need: side(intent.need),
    expiresAt: intent.expiresAt, nonce: intent.nonce,
  });
}

/** JSON kanonik syarat bundle: `circle, epoch, legs[{payer,payee,max_amount}]`; leg diurutkan menurut (payer, payee). */
export function serializeBundleTerms(terms: BundleTerms): string {
  validateBundleTerms(terms);
  const legs = [...terms.legs]
    .sort((a, b) => byBytes(a.payer, b.payer) || byBytes(a.payee, b.payee))
    .map((l) => ({ payer: l.payer, payee: l.payee, max_amount: l.max_amount }));
  return JSON.stringify({ circle: terms.circle, epoch: terms.epoch, legs });
}

const sha256 = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** `sha256(JSON kanonik intent)`: 32 byte. */
export const intentHashBytes = (intent: BarterIntent): Uint8Array => sha256(serializeIntent(intent));
/** Heks huruf kecil 64 karakter. */
export const intentHash = (intent: BarterIntent): string => hex(intentHashBytes(intent));
/** `Base58CryptoHash` untuk argumen `post_intent(intent_hash)`. */
export const intentHashBase58 = (intent: BarterIntent): string => base58Encode(intentHashBytes(intent));

/** `sha256(JSON kanonik syarat bundle)`: 32 byte. */
export const termsHashBytes = (terms: BundleTerms): Uint8Array => sha256(serializeBundleTerms(terms));
/** `terms_hash` heks huruf kecil 64 karakter, ditandatangani semua peserta. */
export const termsHash = (terms: BundleTerms): string => hex(termsHashBytes(terms));

/**
 * Yang ditandatangani: `sha256` payload NEP-413 dengan `message` = JSON kanonik, `nonce` = hash pesan itu, dan
 * `recipient` = akun kontrak lingkaran. Sama dengan voucher, jadi kontrak memakai pembangun byte yang sama.
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

/** Peserta bundle: semua akun yang muncul sebagai payer atau payee, urut. Semuanya wajib menandatangani. */
export function bundleParticipants(terms: BundleTerms): AccountId[] {
  validateBundleTerms(terms);
  return [...new Set(terms.legs.flatMap((l) => [l.payer, l.payee]))].sort(byBytes);
}

/** `true` bila semua peserta punya tanda tangan sah dari pubkey voucher masing-masing (`pubkeys`: akun -> pubkey). */
export function bundleFullySigned(terms: BundleTerms, signatures: readonly BundleSignature[], pubkeys: Readonly<Record<string, string>>): boolean {
  return bundleParticipants(terms).every((account) => {
    const pubkey = pubkeys[account];
    return pubkey !== undefined && signatures.some((s) => s.account === account && verifyBundleSignature(terms, s.signature, pubkey));
  });
}
