// Format listing kode sekali tukar (SD-076, pipeline P3, ADR-48). Yang dijual adalah satu kode (voucher, kunci lisensi, kode redeem) yang hanya bisa dipakai sekali. Pertukarannya
// adalah pertukaran adil SD-070 dengan `salt ‖ kode` sebagai isi: payload (salt 32 byte acak, lalu byte UTF-8 kode) dienkripsi, dan `code_commitment` adalah `contentHash` SD-070
// atas payload itu (`sha256(0x00 ‖ salt ‖ kode)`). Listing publik hanya memuat `code_commitment`; salt acak membuat kode berentropi rendah ("SAVE20", 6 sampai 8 karakter) tidak bisa
// ditebak dari hash. `createRelease`, `verifyDelivery`, `makeCheatProof`, dan `checkCheatProof` dipakai apa adanya dengan `content_hash = code_commitment` dan
// `license_hash = codeDocumentHash`: pembeli yang menerima payload yang tidak cocok dengan `code_commitment` mendapat bukti curang yang diperiksa siapa saja.
//
// Modul ini tidak memakai node:crypto atau Buffer. Batas yang diakui: (1) penjual yang sama bisa mendaftarkan kode yang sama dengan salt lain, jadi kode ganda tidak terdeteksi lewat
// hash; yang menahannya adalah cek penerbit sebelum kunci dilepas, batas nilai kode tanpa cek, jaminan, dan reputasi. (2) Kode yang sudah terpakai tidak bisa dibuktikan curang:
// tanpa API penerbit (`verifiable = false`) pembeli hanya terlindungi oleh batas nilai dan oleh jaminan penjual.
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
/** Jendela sengketa kode, detik (ADR-48): 1 jam. */
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

/** Hasil cek penerbit atas satu kode. `unknown`: penerbit tidak mengenal kode itu atau tidak menjawab. */
export type CodeCheck = "valid" | "used" | "unknown";
/** Adapter penerbit: dipanggil sebelum kunci dilepas bila `verifiable`. Implementasinya milik backend (BE-069) dan penerbit tiruan di tes. */
export interface CodeIssuer {
  checkCode(code: string): Promise<CodeCheck>;
}

export type CodeDocument = {
  circle: AccountId;
  seller: AccountId;
  /** `codeCommitment(kode, salt)`: 64 heksadesimal huruf kecil. Tidak membocorkan kode; salt dan kode hanya ada di payload terenkripsi. */
  code_commitment: string;
  /** Penerbit kode (akun NEAR atau nama layanan yang dikenal backend); hanya dicatat, penerbit tidak ikut menandatangani. */
  issuer: string;
  /** Nilai kode dalam unit terkecil credit, string bilangan bulat > 0. */
  value: U128String;
  /** Penerbit punya API cek (`CodeIssuer`), jadi backend mengecek kode sebelum kunci dilepas. */
  verifiable: boolean;
  /** Arbiter jaminan CT-094; `null` bila tanpa jaminan. */
  arbiter?: AccountId | null;
  nonce: string;
};

export const CODE_SALT_BYTES = 32;
/** Salt acak 32 byte untuk satu kode. */
export const newCodeSalt = (): Uint8Array => randomBytes(CODE_SALT_BYTES);

function checkCodeText(code: string): Uint8Array {
  const bytes = utf8(code);
  if (bytes.length < MIN_CODE_BYTES || bytes.length > MAX_CODE_BYTES) return fail("code_bad_code", `code must be ${MIN_CODE_BYTES} to ${MAX_CODE_BYTES} bytes`);
  if (code !== code.trim() || /[\u0000-\u001f]/.test(code)) return fail("code_bad_code", "code must not start or end with whitespace and must not contain control characters");
  return bytes;
}
/** Isi yang dienkripsi dan dihash: `salt (32) ‖ byte UTF-8 kode`. */
export function codePayload(code: string, salt: Uint8Array): Uint8Array {
  if (salt.length !== CODE_SALT_BYTES) return fail("code_bad_salt", `salt must be ${CODE_SALT_BYTES} bytes`);
  return concatBytes(salt, checkCodeText(code));
}
/** `code_commitment` = `contentHash` SD-070 atas `salt ‖ kode`. */
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

/** JSON kanonik: kunci `circle, seller, code_commitment, issuer, value, verifiable, arbiter, nonce`. Tidak memeriksa batas nilai (lihat `checkCodeDocument`). */
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

/** Sisi penjual: mengenkripsi `salt ‖ kode` (XChaCha20-Poly1305, SD-070). Pasang `ciphertext` di sumber mana saja; `code_commitment` masuk ke dokumen listing. Salt acak bila tidak diberikan; simpan `salt`. */
export function encryptCode(code: string, options: Parameters<typeof encryptContent>[1] & { salt?: Uint8Array } = {}): { ciphertext: Uint8Array; key: Uint8Array; code_commitment: string; salt: Uint8Array } {
  const { salt = newCodeSalt(), ...rest } = options;
  const payload = codePayload(code, salt);
  return { ...encryptContent(payload, rest), code_commitment: contentHash(payload), salt };
}

/** Sisi penjual: rilis kunci untuk satu pembeli. Memeriksa batas nilai dan bahwa `salt` dan `code` cocok dengan `doc.code_commitment` (`code_bad_commitment` bila tidak). */
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
