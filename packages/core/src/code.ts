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
/** Batas nilai kode yang tidak bisa dicek penerbit (ADR-48): 20 credit, dalam unit terkecil (1 credit = 1_000_000). Di atasnya wajib jaminan CT-094 (`arbiter`). */
export const UNVERIFIABLE_CODE_LIMIT: U128String = "20000000";
export const MIN_CODE_BYTES = 8;
export const MAX_CODE_BYTES = 1024;
/** Jendela sengketa kode, detik (ADR-48): 1 jam. */
export const CODE_DISPUTE_WINDOW_SECONDS = 3600;

export type CodeErrorCode =
  | "code_bad_account" | "code_bad_commitment" | "code_bad_salt" | "code_bad_value" | "code_bad_code" | "code_bad_nonce" | "code_bad_resource" | "code_bad_arbiter" | "code_bad_limit" | "code_over_limit_unbonded";

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
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return fail(code, `${name} harus string bilangan bulat tanpa nol di depan`);
  const n = BigInt(value);
  if (n > U128_MAX) return fail(code, `${name} melebihi u128`);
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
  if (bytes.length < MIN_CODE_BYTES || bytes.length > MAX_CODE_BYTES) return fail("code_bad_code", `kode harus ${MIN_CODE_BYTES} sampai ${MAX_CODE_BYTES} byte`);
  if (code !== code.trim() || /[\u0000-\u001f]/.test(code)) return fail("code_bad_code", "kode tidak boleh diawali atau diakhiri spasi dan tidak boleh memuat karakter kontrol");
  return bytes;
}
/** Isi yang dienkripsi dan dihash: `salt (32) ‖ byte UTF-8 kode`. */
export function codePayload(code: string, salt: Uint8Array): Uint8Array {
  if (salt.length !== CODE_SALT_BYTES) return fail("code_bad_salt", `salt harus ${CODE_SALT_BYTES} byte`);
  return concatBytes(salt, checkCodeText(code));
}
/** `code_commitment` = `contentHash` SD-070 atas `salt ‖ kode`. */
export const codeCommitment = (code: string, salt: Uint8Array): string => contentHash(codePayload(code, salt));

export function normalizeCode(doc: CodeDocument): Required<CodeDocument> {
  for (const [name, value] of [["circle", doc.circle], ["seller", doc.seller]] as const) if (!isAccount(value)) fail("code_bad_account", `${name} bukan akun NEAR: ${JSON.stringify(value)}`);
  if (!HASH.test(doc.code_commitment)) fail("code_bad_commitment", "code_commitment harus 64 heksadesimal huruf kecil");
  if (typeof doc.issuer !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(doc.issuer)) fail("code_bad_account", "issuer harus 1 sampai 64 karakter [a-z0-9._-]");
  if (parseAmount(doc.value, "value", "code_bad_value") === 0n) fail("code_bad_value", "value harus lebih dari 0");
  if (typeof doc.verifiable !== "boolean") fail("code_bad_value", "verifiable harus boolean");
  const arbiter = doc.arbiter ?? null;
  if (arbiter !== null) {
    if (!isAccount(arbiter)) fail("code_bad_arbiter", "arbiter bukan akun NEAR");
    if (arbiter === doc.seller) fail("code_bad_arbiter", "arbiter tidak boleh penjual");
  }
  if (typeof doc.nonce !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(doc.nonce)) fail("code_bad_nonce", "nonce harus 1 sampai 32 karakter [A-Za-z0-9._-]");
  return { circle: doc.circle, seller: doc.seller, code_commitment: doc.code_commitment, issuer: doc.issuer, value: doc.value, verifiable: doc.verifiable, arbiter, nonce: doc.nonce };
}

/** Kode tanpa cek penerbit dengan nilai di atas `limit` (bawaan `UNVERIFIABLE_CODE_LIMIT`) dan tanpa arbiter wajib ditolak. */
export function codeNeedsBond(doc: Pick<CodeDocument, "value" | "verifiable" | "arbiter">, limit: U128String = UNVERIFIABLE_CODE_LIMIT): boolean {
  const max = parseAmount(limit, "limit", "code_bad_limit");
  return !doc.verifiable && parseAmount(doc.value, "value", "code_bad_value") > max && (doc.arbiter ?? null) === null;
}

/** Memeriksa dokumen dan batas nilai; melempar `code_over_limit_unbonded` bila kode tak bisa dicek, nilainya di atas batas, dan tanpa arbiter. Mengembalikan dokumen ternormalisasi. */
export function checkCodeDocument(doc: CodeDocument, limit: U128String = UNVERIFIABLE_CODE_LIMIT): Required<CodeDocument> {
  const normal = normalizeCode(doc);
  if (codeNeedsBond(normal, limit)) fail("code_over_limit_unbonded", `kode yang tidak bisa dicek dibatasi ${limit} unit; di atasnya wajib jaminan (arbiter)`);
  return normal;
}

/** JSON kanonik: kunci `circle, seller, code_commitment, issuer, value, verifiable, arbiter, nonce`. Tidak memeriksa batas nilai (lihat `checkCodeDocument`). */
export const serializeCode = (doc: CodeDocument): string => JSON.stringify(normalizeCode(doc));
export const codeDocumentHash = (doc: CodeDocument): string => bytesToHex(sha256(utf8(serializeCode(doc))));
export function codeResource(hash: string): string {
  if (!HASH.test(hash)) return fail("code_bad_resource", "hash dokumen kode harus 64 heksadesimal huruf kecil");
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
export function createCodeRelease(args: Omit<Parameters<typeof createRelease>[0], "license_hash" | "content_hash" | "content_size" | "circle"> & { doc: CodeDocument; code: string; salt: Uint8Array; limit?: U128String }): ReturnType<typeof createRelease> {
  const { doc, code, salt, limit, ...rest } = args;
  const normal = checkCodeDocument(doc, limit);
  const payload = codePayload(code, salt);
  if (contentHash(payload) !== normal.code_commitment) fail("code_bad_commitment", "salt dan kode tidak cocok dengan code_commitment dokumen");
  return createRelease({ ...rest, circle: normal.circle, license_hash: codeDocumentHash(normal), content_hash: normal.code_commitment, content_size: payload.length });
}

/** Memecah payload hasil dekripsi menjadi salt (heks) dan kode; `null` bila bentuknya salah. */
export function splitCodePayload(payload: Uint8Array): { salt: string; code: string } | null {
  if (payload.length <= CODE_SALT_BYTES) return null;
  return { salt: bytesToHex(payload.subarray(0, CODE_SALT_BYTES)), code: new TextDecoder().decode(payload.subarray(CODE_SALT_BYTES)) };
}

/** Sisi pembeli: memeriksa kiriman kode. Hasil `ok` memuat `code` (teks) dan `salt` (heks) selain byte payload; `content_hash` rilis harus `code_commitment`. */
export function verifyCodeDelivery(args: Parameters<typeof verifyDelivery>[0] & { doc?: CodeDocument }): DeliveryVerdict & { code?: string; salt?: string } {
  if (args.doc !== undefined) {
    const normal = normalizeCode(args.doc);
    const r = args.release;
    if (r.license_hash !== codeDocumentHash(normal) || r.content_hash !== normal.code_commitment || r.circle !== normal.circle) return { ok: false, reason: "wrong_purchase" };
  }
  const verdict = verifyDelivery(args);
  if (!verdict.ok) return verdict;
  const parts = splitCodePayload(verdict.content);
  return parts === null ? { ok: false, reason: "wrong_purchase" } : { ...verdict, ...parts };
}
export const makeCodeCheatProof = (args: Parameters<typeof verifyDelivery>[0]): CheatProof => makeCheatProof(args);

export type { LicenseRelease as CodeRelease };
