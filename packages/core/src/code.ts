// One-time-exchange code listing format (SD-076, pipeline P3, ADR-48). What is sold is one code (voucher, license key, redeem code) that can be used only once. The exchange
// is the SD-070 fair exchange with `salt ‖ code` as the content: the payload (32 random salt bytes, then the UTF-8 bytes of the code) is encrypted, and `code_commitment` is the SD-070 `contentHash`
// of that payload (`sha256(0x00 ‖ salt ‖ code)`). The public listing carries only `code_commitment`; the random salt keeps a low-entropy code ("SAVE20", 6 to 8 characters) from being
// guessed from the hash. `createRelease`, `verifyDelivery`, `makeCheatProof`, and `checkCheatProof` are used as-is with `content_hash = code_commitment` and
// `license_hash = codeDocumentHash`: a buyer who receives a payload that does not match `code_commitment` gets a cheat proof that anyone can check.
//
// This module uses neither node:crypto nor Buffer. Acknowledged limits: (1) the same seller can register the same code with a different salt, so a duplicate code is not detected through
// the hash; what holds it back is the issuer check before the key is released, the value limit for codes without a check, the guarantee, and reputation. (2) A code that has already been used cannot be proven fraudulent:
// without an issuer API (`verifiable = false`) the buyer is protected only by the value limit and the seller's guarantee.
import { bytesToHex, concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { contentHash, createRelease, encryptContent, makeCheatProof, verifyDelivery, type CheatProof, type DeliveryVerdict, type LicenseRelease } from "./license.js";
import type { AccountId, U128String } from "./types.js";

export const CODE_RESOURCE_PREFIX = "x207:code:";
/** Value cap of a code that the issuer cannot check (ADR-48): 20 credit in the smallest unit (1 credit = 1_000_000). No bond lifts it (B6-F2): a sale paid by one voucher locks no bond. */
export const UNVERIFIABLE_CODE_LIMIT: U128String = "20000000";
/** Value cap of a code that the issuer can check: 100 credit. The check before the release lowers the risk but does not remove it, so a cap holds here too. */
export const VERIFIABLE_CODE_LIMIT: U128String = "100000000";
export const MIN_CODE_BYTES = 8;
export const MAX_CODE_BYTES = 1024;
/** Code dispute window, seconds (ADR-48): 1 hour. */
export const CODE_DISPUTE_WINDOW_SECONDS = 3600;

export type CodeErrorCode =
  | "code_bad_account" | "code_bad_commitment" | "code_bad_salt" | "code_bad_value" | "code_bad_code" | "code_bad_nonce" | "code_bad_resource" | "code_bad_arbiter" | "code_arbiter_not_supported" | "code_bad_limit" | "code_over_limit_unbonded";

export class CodeError extends Error {
  constructor(readonly code: CodeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CodeError";
  }
}
const fail = (code: CodeErrorCode, message: string): never => {
  throw new CodeError(code, message);
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const U128_MAX = (1n << 128n) - 1n;
const parseAmount = (value: unknown, name: string, code: CodeErrorCode): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return fail(code, `${name} must be an integer string with no leading zeros`);
  const n = BigInt(value);
  if (n > U128_MAX) return fail(code, `${name} exceeds u128`);
  return n;
};

/** Result of the issuer's check on one code. `unknown`: the issuer does not recognize the code or does not answer. */
export type CodeCheck = "valid" | "used" | "unknown";
/** Issuer adapter: called before the key is released if `verifiable`. The implementation belongs to the backend (BE-069) and a mock issuer in tests. */
export interface CodeIssuer {
  checkCode(code: string): Promise<CodeCheck>;
}

export type CodeDocument = {
  circle: AccountId;
  seller: AccountId;
  /** `codeCommitment(code, salt)`: 64 lowercase hex characters. Does not leak the code; salt and code exist only in the encrypted payload. */
  code_commitment: string;
  /** Code issuer (NEAR account or a service name known to the backend); only recorded, the issuer does not co-sign. */
  issuer: string;
  /** Code value in the smallest credit unit, a positive integer string. */
  value: U128String;
  /** The issuer has a check API (`CodeIssuer`), so the backend checks the code before the key is released. */
  verifiable: boolean;
  /** CT-094 guarantee arbiter; `null` if no guarantee. */
  arbiter?: AccountId | null;
  nonce: string;
};

export const CODE_SALT_BYTES = 32;
/** Random 32-byte salt for one code. */
export const newCodeSalt = (): Uint8Array => randomBytes(CODE_SALT_BYTES);

function checkCodeText(code: string): Uint8Array {
  const bytes = utf8(code);
  if (bytes.length < MIN_CODE_BYTES || bytes.length > MAX_CODE_BYTES) return fail("code_bad_code", `code must be ${MIN_CODE_BYTES} to ${MAX_CODE_BYTES} bytes`);
  if (code !== code.trim() || /[\u0000-\u001f]/.test(code)) return fail("code_bad_code", "code must not start or end with whitespace and must not contain control characters");
  return bytes;
}
/** The encrypted and hashed content: `salt (32) ‖ UTF-8 bytes of the code`. */
export function codePayload(code: string, salt: Uint8Array): Uint8Array {
  if (salt.length !== CODE_SALT_BYTES) return fail("code_bad_salt", `salt must be ${CODE_SALT_BYTES} bytes`);
  return concatBytes(salt, checkCodeText(code));
}
/** `code_commitment` = SD-070 `contentHash` of `salt ‖ code`. */
export const codeCommitment = (code: string, salt: Uint8Array): string => contentHash(codePayload(code, salt));

export function normalizeCode(doc: CodeDocument): Required<CodeDocument> {
  for (const [name, value] of [["circle", doc.circle], ["seller", doc.seller]] as const) if (!isAccount(value)) fail("code_bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
  if (!HASH.test(doc.code_commitment)) fail("code_bad_commitment", "code_commitment must be 64 lowercase hex characters");
  if (typeof doc.issuer !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(doc.issuer)) fail("code_bad_account", "issuer must be 1 to 64 characters [a-z0-9._-]");
  if (parseAmount(doc.value, "value", "code_bad_value") === 0n) fail("code_bad_value", "value must be greater than 0");
  if (typeof doc.verifiable !== "boolean") fail("code_bad_value", "verifiable must be a boolean");
  const arbiter = doc.arbiter ?? null;
  if (arbiter !== null) {
    if (!isAccount(arbiter)) fail("code_bad_arbiter", "arbiter is not a NEAR account");
    if (arbiter === doc.seller) fail("code_bad_arbiter", "arbiter must not be the seller");
  }
  if (typeof doc.nonce !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(doc.nonce)) fail("code_bad_nonce", "nonce must be 1 to 32 characters [A-Za-z0-9._-]");
  return { circle: doc.circle, seller: doc.seller, code_commitment: doc.code_commitment, issuer: doc.issuer, value: doc.value, verifiable: doc.verifiable, arbiter, nonce: doc.nonce };
}

/**
 * Is the value of the code above its cap? `limit` is the cap of a code that cannot be checked (default `UNVERIFIABLE_CODE_LIMIT`, 20 credit), `verifiableLimit` the cap of a code that
 * can be checked (default `VERIFIABLE_CODE_LIMIT`, 100 credit). The `arbiter` of the document changes nothing: no bond exists for a sale paid by one voucher (ADR-48 points 6 and 7).
 */
export function codeOverLimit(doc: Pick<CodeDocument, "value" | "verifiable">, limit: U128String = UNVERIFIABLE_CODE_LIMIT, verifiableLimit: U128String = VERIFIABLE_CODE_LIMIT): boolean {
  const cap = parseAmount(doc.verifiable ? verifiableLimit : limit, "limit", "code_bad_limit");
  return parseAmount(doc.value, "value", "code_bad_value") > cap;
}

/**
 * Checks the document and the value cap: `code_arbiter_not_supported` when the document names an arbiter (nothing is bonded, so the name would only look like a guarantee) and
 * `code_over_limit_unbonded` when the value is above the cap of its kind. Returns the normalised document.
 */
export function checkCodeDocument(doc: CodeDocument, limit: U128String = UNVERIFIABLE_CODE_LIMIT, verifiableLimit: U128String = VERIFIABLE_CODE_LIMIT): Required<CodeDocument> {
  const normal = normalizeCode(doc);
  if (normal.arbiter !== null) fail("code_arbiter_not_supported", "no bond is locked for a code sale: the value cap applies without exception and an arbiter is not accepted");
  if (codeOverLimit(normal, limit, verifiableLimit)) {
    fail("code_over_limit_unbonded", `a code that ${normal.verifiable ? "can" : "cannot"} be checked is capped at ${normal.verifiable ? verifiableLimit : limit} units; no bond raises it`);
  }
  return normal;
}

/** Canonical JSON: keys `circle, seller, code_commitment, issuer, value, verifiable, arbiter, nonce`. Does not check the value limit (see `checkCodeDocument`). */
export const serializeCode = (doc: CodeDocument): string => JSON.stringify(normalizeCode(doc));
export const codeDocumentHash = (doc: CodeDocument): string => bytesToHex(sha256(utf8(serializeCode(doc))));
export function codeResource(hash: string): string {
  if (!HASH.test(hash)) return fail("code_bad_resource", "code document hash must be 64 lowercase hex characters");
  return `${CODE_RESOURCE_PREFIX}${hash}`;
}
export function parseCodeResource(resource: string): string | null {
  if (!resource.startsWith(CODE_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(CODE_RESOURCE_PREFIX.length);
  return HASH.test(hash) ? hash : null;
}

/** Seller side: encrypts `salt ‖ code` (XChaCha20-Poly1305, SD-070). Put the `ciphertext` at any source; `code_commitment` goes into the listing document. Random salt if not given; keep the `salt`. */
export function encryptCode(code: string, options: Parameters<typeof encryptContent>[1] & { salt?: Uint8Array } = {}): { ciphertext: Uint8Array; key: Uint8Array; code_commitment: string; salt: Uint8Array } {
  const { salt = newCodeSalt(), ...rest } = options;
  const payload = codePayload(code, salt);
  return { ...encryptContent(payload, rest), code_commitment: contentHash(payload), salt };
}

/** Seller side: key release for one buyer. Checks the value limit and that `salt` and `code` match `doc.code_commitment` (`code_bad_commitment` if not). */
export function createCodeRelease(args: Omit<Parameters<typeof createRelease>[0], "license_hash" | "content_hash" | "content_size" | "circle"> & { doc: CodeDocument; code: string; salt: Uint8Array; limit?: U128String; verifiableLimit?: U128String }): ReturnType<typeof createRelease> {
  const { doc, code, salt, limit, verifiableLimit, ...rest } = args;
  const normal = checkCodeDocument(doc, limit, verifiableLimit);
  const payload = codePayload(code, salt);
  if (contentHash(payload) !== normal.code_commitment) fail("code_bad_commitment", "salt and code do not match the document code_commitment");
  return createRelease({ ...rest, circle: normal.circle, license_hash: codeDocumentHash(normal), content_hash: normal.code_commitment, content_size: payload.length });
}

/**
 * Splits the decrypted payload into the salt (hex) and the code. `null` when the payload is not a code of the format (B6-F5): over `32 + MAX_CODE_BYTES` bytes, a code under
 * `MIN_CODE_BYTES`, text that is not valid UTF-8, a code with control characters or padded with spaces. A seller who does not use the SDK can commit to any payload; the buyer
 * must not take it as a code.
 */
export function splitCodePayload(payload: Uint8Array): { salt: string; code: string } | null {
  if (payload.length < CODE_SALT_BYTES + MIN_CODE_BYTES || payload.length > CODE_SALT_BYTES + MAX_CODE_BYTES) return null;
  let code: string;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(CODE_SALT_BYTES));
  } catch {
    return null;
  }
  if (code !== code.trim() || /[\u0000-\u001f\u007f]/.test(code)) return null;
  return { salt: bytesToHex(payload.subarray(0, CODE_SALT_BYTES)), code };
}

export type CodeDeliveryVerdict = DeliveryVerdict | { ok: false; reason: "bad_payload" };

/**
 * Buyer side: checks the delivery of a code. `ok` carries `code` (text) and `salt` (hex) besides the bytes of the payload. Pass `doc`, the code document of the listing that the
 * buyer looked at (B6-F4): the release must be for that document, that commitment and that circle, otherwise `wrong_purchase`. A payload that matches the commitment but is not a
 * code of the format is `bad_payload` (no proof of cheating exists for it: the seller committed to it).
 */
export function verifyCodeDelivery(args: Parameters<typeof verifyDelivery>[0] & { doc?: CodeDocument }): CodeDeliveryVerdict & { code?: string; salt?: string } {
  if (args.doc !== undefined) {
    const normal = normalizeCode(args.doc);
    const r = args.release;
    if (r.license_hash !== codeDocumentHash(normal) || r.content_hash !== normal.code_commitment || r.circle !== normal.circle) return { ok: false, reason: "wrong_purchase" };
  }
  const verdict = verifyDelivery(args);
  if (!verdict.ok) return verdict;
  const parts = splitCodePayload(verdict.content);
  return parts === null ? { ok: false, reason: "bad_payload" } : { ...verdict, ...parts };
}
export const makeCodeCheatProof = (args: Parameters<typeof verifyDelivery>[0]): CheatProof => makeCheatProof(args);

export type { LicenseRelease as CodeRelease };
