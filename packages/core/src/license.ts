// Format lisensi konten dan pertukaran adil dengan enkripsi (SD-070, pipeline P7, ADR-46). Yang dijual adalah lisensi atas berkas; berkasnya sendiri tidak disimpan x207.
// Alur: penjual memasang ciphertext di sumber mana saja dan mencatat `cipher_hash`; pembeli mengunduh dan mengecek `cipher_hash`; penjual melepas kunci berkas yang disegel ke
// kunci x25519 pembeli dan menandatangani rilis itu; pembeli mendekripsi dan mengecek `content_hash`. Cocok: konfirmasi. Tidak cocok: bukti curang yang bisa diperiksa siapa saja.
//
// Modul ini tidak memakai node:crypto atau Buffer, jadi jalan di browser (FE-028) dan di Node. Kripto dari @noble (XChaCha20-Poly1305, ed25519 dan x25519, sha256, HMAC).
//
// Batas yang diakui: (1) bukti curang hanya mungkin bila kunci yang dilepas bisa dibuka pembeli; penjual yang melepas kunci tersegel yang rusak tidak bisa dibuktikan, hanya
// tidak dibayar (pembeli menyengketakan `other`, voucher tidak didaftarkan). (2) Lisensi eksklusif dicatat per `content_hash`; penjual yang mengubah satu byte tidak terdeteksi.
// (3) Watermark mendeteksi penyebar ulang yang menyalin berkas utuh, bukan yang mengolahnya.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58Decode, base58Encode } from "./base58.js";
import type { AccountId } from "./types.js";

export type LicenseErrorCode =
  | "license_bad_hash" | "license_bad_account" | "license_bad_license_id" | "license_bad_nonce" | "license_bad_resource" | "license_bad_key" | "cipher_bad_format"
  | "cipher_hash_mismatch" | "release_bad_signature" | "release_bad_key" | "proof_not_possible" | "source_bad_ref" | "source_forbidden" | "source_too_large" | "source_failed"
  | "source_cid_unsupported" | "source_cid_mismatch" | "canary_bad_input";

export class LicenseError extends Error {
  constructor(readonly code: LicenseErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LicenseError";
  }
}
const fail = (code: LicenseErrorCode, message: string): never => {
  throw new LicenseError(code, message);
};

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);

// ---- content_hash: the Merkle root of leaves per 4 MiB, one scheme for every size -------------------------------------------------------------------------

/** Ukuran potongan untuk Merkle dan untuk enkripsi: 4 MiB. */
export const CONTENT_CHUNK = 4 * 1024 * 1024;
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

/** Akar Merkle gaya RFC 6962: daun `sha256(0x00 ‖ potongan)`, simpul `sha256(0x01 ‖ kiri ‖ kanan)`, pecahan di pangkat dua terbesar yang kurang dari jumlah daun. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return fail("cipher_bad_format", "Merkle butuh paling sedikit satu daun");
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(concatBytes(NODE, merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k))));
}

/**
 * Hash isi bertahap, satu skema untuk semua ukuran (perbaikan F1 dan F2 dari tinjauan BE-062): berkas dipotong per 4 MiB, tiap potongan menjadi daun `sha256(0x00 ‖ potongan)`, dan
 * daun digabung dengan `merkleRoot` (simpul `sha256(0x01 ‖ kiri ‖ kanan)`). Berkas satu potongan, juga yang kosong, tetap melewati daun, jadi tidak ada isi yang bisa sekaligus
 * menjadi daun dan simpul: string 65 byte `0x01 ‖ kiri ‖ kanan` tidak punya hash yang sama dengan berkas besar.
 */
export class ContentHasher {
  #leaf = sha256.create().update(LEAF);
  #leaves: Uint8Array[] = [];
  #inLeaf = 0;
  #total = 0;

  update(data: Uint8Array): this {
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(CONTENT_CHUNK - this.#inLeaf, data.length - offset);
      this.#leaf.update(data.subarray(offset, offset + take));
      this.#inLeaf += take;
      offset += take;
      if (this.#inLeaf === CONTENT_CHUNK) {
        this.#leaves.push(this.#leaf.digest());
        this.#leaf = sha256.create().update(LEAF);
        this.#inLeaf = 0;
      }
    }
    this.#total += data.length;
    return this;
  }

  get size(): number {
    return this.#total;
  }

  /** Hash heks huruf kecil 64 karakter. Boleh dipanggil sekali. */
  digest(): string {
    const leaves = this.#inLeaf > 0 || this.#total === 0 ? [...this.#leaves, this.#leaf.digest()] : this.#leaves;
    return bytesToHex(merkleRoot(leaves));
  }
}
export const contentHash = (data: Uint8Array): string => new ContentHasher().update(data).digest();

// ---- the license document and its resource -------------------------------------------------------------------------------------------------------------------------------

export const LICENSE_RESOURCE_PREFIX = "x207:license:";
export type LicenseDocument = {
  circle: AccountId;
  seller: AccountId;
  content_hash: string;
  /** Jenis lisensi dari daftar `license_id` backend, mis. `personal` atau `commercial`; ASCII `[a-z0-9.-]` 1 sampai 32. */
  license_id: string;
  /** sha256 teks lisensi. */
  license_hash: string;
  /** sha256 preview (potongan kecil yang boleh dilihat sebelum beli); `null` bila tidak ada. */
  preview_hash?: string | null;
  exclusive: boolean;
  nonce: string;
};

export function normalizeLicense(doc: LicenseDocument): Required<LicenseDocument> {
  for (const [name, value] of [["circle", doc.circle], ["seller", doc.seller]] as const) if (!isAccount(value)) fail("license_bad_account", `${name} bukan akun NEAR: ${JSON.stringify(value)}`);
  for (const [name, value] of [["content_hash", doc.content_hash], ["license_hash", doc.license_hash]] as const) if (!HASH.test(value)) fail("license_bad_hash", `${name} harus 64 heksadesimal huruf kecil`);
  const preview = doc.preview_hash ?? null;
  if (preview !== null && !HASH.test(preview)) fail("license_bad_hash", "preview_hash harus 64 heksadesimal huruf kecil");
  if (!/^[a-z0-9.-]{1,32}$/.test(doc.license_id)) fail("license_bad_license_id", "license_id harus 1 sampai 32 karakter [a-z0-9.-]");
  if (typeof doc.exclusive !== "boolean") fail("license_bad_hash", "exclusive harus boolean");
  if (typeof doc.nonce !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(doc.nonce)) fail("license_bad_nonce", "nonce harus 1 sampai 32 karakter [A-Za-z0-9._-]");
  return { circle: doc.circle, seller: doc.seller, content_hash: doc.content_hash, license_id: doc.license_id, license_hash: doc.license_hash, preview_hash: preview, exclusive: doc.exclusive, nonce: doc.nonce };
}
/** JSON kanonik: kunci `circle, seller, content_hash, license_id, license_hash, preview_hash, exclusive, nonce`. */
export const serializeLicense = (doc: LicenseDocument): string => JSON.stringify(normalizeLicense(doc));
export const licenseDocumentHash = (doc: LicenseDocument): string => bytesToHex(sha256(utf8(serializeLicense(doc))));
export function licenseResource(hash: string): string {
  if (!HASH.test(hash)) return fail("license_bad_resource", "hash lisensi harus 64 heksadesimal huruf kecil");
  return `${LICENSE_RESOURCE_PREFIX}${hash}`;
}
export function parseLicenseResource(resource: string): string | null {
  if (!resource.startsWith(LICENSE_RESOURCE_PREFIX)) return null;
  const hash = resource.slice(LICENSE_RESOURCE_PREFIX.length);
  return HASH.test(hash) ? hash : null;
}

// ---- encryption of the file: XChaCha20-Poly1305 per 4 MiB chunk ----------------------------------------------------------------------------------------------------------

const MAGIC = utf8("X207ENC1");
const TAG = 16;
const PREFIX = 16;
const HEADER = MAGIC.length + PREFIX;
const u64be = (n: number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
};
const chunkNonce = (prefix: Uint8Array, index: number): Uint8Array => concatBytes(prefix, u64be(index));
const finalAad = (final: boolean): Uint8Array => Uint8Array.of(final ? 1 : 0);

/**
 * Mengenkripsi `plain` dengan kunci 32 byte (acak bila tidak diberikan). Format: `"X207ENC1" ‖ prefiks 16 byte ‖ potongan`; tiap potongan 4 MiB dienkripsi dengan nonce `prefiks ‖ indeks`
 * dan AAD satu byte penanda potongan terakhir, jadi pemotongan, penyisipan, dan penukaran urutan terdeteksi. Berkas kosong tetap satu potongan.
 */
export function encryptContent(plain: Uint8Array, options: { key?: Uint8Array; prefix?: Uint8Array } = {}): { ciphertext: Uint8Array; key: Uint8Array } {
  const key = options.key ?? randomBytes(32);
  const prefix = options.prefix ?? randomBytes(PREFIX);
  if (key.length !== 32) fail("license_bad_key", "kunci berkas harus 32 byte");
  if (prefix.length !== PREFIX) fail("cipher_bad_format", `prefiks nonce harus ${PREFIX} byte`);
  const count = Math.max(1, Math.ceil(plain.length / CONTENT_CHUNK));
  const parts: Uint8Array[] = [MAGIC, prefix];
  for (let i = 0; i < count; i++) {
    parts.push(xchacha20poly1305(key, chunkNonce(prefix, i), finalAad(i === count - 1)).encrypt(plain.subarray(i * CONTENT_CHUNK, (i + 1) * CONTENT_CHUNK)));
  }
  return { ciphertext: concatBytes(...parts), key };
}

/** Mendekripsi; melempar `cipher_bad_format` bila bukan format ini, terpotong, atau salah satu potongan gagal diautentikasi (kunci salah atau ciphertext diubah). */
export function decryptContent(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) fail("license_bad_key", "kunci berkas harus 32 byte");
  if (ciphertext.length < HEADER + TAG || !MAGIC.every((b, i) => ciphertext[i] === b)) fail("cipher_bad_format", "bukan ciphertext X207ENC1");
  const prefix = ciphertext.subarray(MAGIC.length, HEADER);
  const body = ciphertext.subarray(HEADER);
  const full = CONTENT_CHUNK + TAG;
  const count = Math.max(1, Math.ceil(body.length / full));
  const lastLength = body.length - (count - 1) * full;
  if (lastLength < TAG) fail("cipher_bad_format", "ciphertext terpotong");
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const piece = body.subarray(i * full, i === count - 1 ? body.length : (i + 1) * full);
    try {
      out.push(xchacha20poly1305(key, chunkNonce(prefix, i), finalAad(i === count - 1)).decrypt(piece));
    } catch {
      return fail("cipher_bad_format", `potongan ${i + 1} gagal diautentikasi: kunci salah atau ciphertext berubah`);
    }
  }
  return concatBytes(...out);
}

// ---- key sealed to the buyer (x25519 derived from the voucher key, ed25519) -------------------------------------------------------------------------------------------

const ED = "ed25519:";
function edSeed(secretKey: string): Uint8Array {
  if (!secretKey.startsWith(ED)) return fail("license_bad_key", "kunci voucher harus ed25519:<base58>");
  const bytes = base58Decode(secretKey.slice(ED.length));
  if (bytes.length !== 32 && bytes.length !== 64) return fail("license_bad_key", "kunci voucher harus 32 atau 64 byte");
  return bytes.slice(0, 32);
}
function edPublic(publicKey: string): Uint8Array {
  if (!publicKey.startsWith(ED)) return fail("license_bad_key", "kunci publik harus ed25519:<base58>");
  const bytes = base58Decode(publicKey.slice(ED.length));
  if (bytes.length !== 32) return fail("license_bad_key", "kunci publik harus 32 byte");
  return bytes;
}
/** Kunci publik `ed25519:<base58>` dari kunci voucher rahasia. */
export const licensePublicKey = (secretKey: string): string => `${ED}${base58Encode(ed25519.getPublicKey(edSeed(secretKey)))}`;

const BOX_DOMAIN = utf8("x207:license:box:v1");
const boxKeyOf = (shared: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array => sha256(concatBytes(BOX_DOMAIN, shared, ephemeralPub, recipientPub));
const BOX_NONCE = new Uint8Array(24); // the box key is unique per ephemeral key, so a fixed nonce is safe

/** Menyegel kunci berkas ke kunci publik ed25519 pembeli: `ephemeral x25519 pub (32) ‖ ciphertext kunci (32 + 16)`; kunci kotak berasal dari X25519 dengan pembeli. */
export function sealKey(contentKey: Uint8Array, buyerPublicKey: string, ephemeralSecret?: Uint8Array): Uint8Array {
  if (contentKey.length !== 32) fail("license_bad_key", "kunci berkas harus 32 byte");
  const recipient = ed25519.utils.toMontgomery(edPublic(buyerPublicKey));
  const secret = ephemeralSecret ?? x25519.utils.randomSecretKey();
  const ephemeralPub = x25519.getPublicKey(secret);
  const box = boxKeyOf(x25519.getSharedSecret(secret, recipient), ephemeralPub, recipient);
  return concatBytes(ephemeralPub, xchacha20poly1305(box, BOX_NONCE).encrypt(contentKey));
}

/** Kunci kotak (simetris) untuk `sealed`, dari kunci voucher pembeli: dipakai membuka kunci dan, bila perlu, diserahkan sebagai bagian bukti curang. */
export function deriveBoxKey(sealed: Uint8Array, buyerSecretKey: string): Uint8Array {
  if (sealed.length !== 32 + 32 + TAG) fail("release_bad_key", "kunci tersegel harus 80 byte");
  const seed = edSeed(buyerSecretKey);
  const mine = ed25519.utils.toMontgomerySecret(seed);
  const ephemeralPub = sealed.subarray(0, 32);
  return boxKeyOf(x25519.getSharedSecret(mine, ephemeralPub), ephemeralPub, x25519.getPublicKey(mine));
}
/** Membuka kunci tersegel dengan kunci kotak; melempar `release_bad_key` bila gagal diautentikasi. */
export function openSealedWithBoxKey(sealed: Uint8Array, boxKey: Uint8Array): Uint8Array {
  if (sealed.length !== 32 + 32 + TAG || boxKey.length !== 32) fail("release_bad_key", "kunci tersegel atau kunci kotak tidak sah");
  try {
    return xchacha20poly1305(boxKey, BOX_NONCE).decrypt(sealed.subarray(32));
  } catch {
    return fail("release_bad_key", "kunci tersegel tidak bisa dibuka dengan kunci kotak ini");
  }
}
export const openSealedKey = (sealed: Uint8Array, buyerSecretKey: string): Uint8Array => openSealedWithBoxKey(sealed, deriveBoxKey(sealed, buyerSecretKey));

// ---- the release signed by the seller ---------------------------------------------------------------------------------------------------------------------------------

/** Rilis kunci yang ditandatangani penjual: mengikat dokumen lisensi, isi, ciphertext, pembeli, dan kunci tersegel. */
export type LicenseRelease = {
  circle: AccountId; license_hash: string; buyer: AccountId; content_hash: string; cipher_hash: string; sealed_key: string; at: number
  /** Ukuran berkas asli dan ciphertext dalam byte, ikut ditandatangani: pemeriksa menolak isi yang ukurannya lain (tinjauan BE-062, F1 dan F2). */
  content_size: number; cipher_size: number
};
const serializeRelease = (r: LicenseRelease): string =>
  JSON.stringify({
    circle: r.circle, license_hash: r.license_hash, buyer: r.buyer, content_hash: r.content_hash, cipher_hash: r.cipher_hash, sealed_key: r.sealed_key, at: r.at, content_size: r.content_size, cipher_size: r.cipher_size,
  });

function checkRelease(r: LicenseRelease): void {
  if (!isAccount(r.circle) || !isAccount(r.buyer)) fail("license_bad_account", "circle dan buyer harus akun NEAR");
  for (const h of [r.license_hash, r.content_hash, r.cipher_hash]) if (!HASH.test(h)) fail("license_bad_hash", "hash rilis harus 64 heksadesimal huruf kecil");
  if (!/^(?:[0-9a-f]{2}){80}$/.test(r.sealed_key)) fail("release_bad_key", "sealed_key harus 80 byte heks");
  if (!Number.isSafeInteger(r.at) || r.at <= 0) fail("license_bad_nonce", "at harus detik unix");
  for (const n of [r.content_size, r.cipher_size]) if (!Number.isSafeInteger(n) || n < 0) fail("license_bad_hash", "content_size dan cipher_size harus bilangan bulat >= 0");
}
const NEP413_TAG = 2147484061;
const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
const borshString = (text: string): Uint8Array => {
  const bytes = utf8(text);
  return concatBytes(u32le(bytes.length), bytes);
};
/** Hash NEP-413 yang sama dengan `nep413SigningHash` di voucher.ts, dihitung tanpa node:crypto: nonce = sha256(pesan), penerima = akun kontrak lingkaran. */
export const releaseSigningHash = (r: LicenseRelease): Uint8Array => {
  checkRelease(r);
  const message = serializeRelease(r);
  return sha256(concatBytes(u32le(NEP413_TAG), borshString(message), sha256(utf8(message)), borshString(r.circle), Uint8Array.of(0)));
};

export function signRelease(release: LicenseRelease, sellerSecretKey: string): string {
  return `${ED}${base58Encode(ed25519.sign(releaseSigningHash(release), edSeed(sellerSecretKey)))}`;
}
export function verifyRelease(release: LicenseRelease, signature: string, sellerPublicKey: string): boolean {
  try {
    if (!signature.startsWith(ED)) return false;
    return ed25519.verify(base58Decode(signature.slice(ED.length)), releaseSigningHash(release), edPublic(sellerPublicKey));
  } catch {
    return false;
  }
}

/** Sisi penjual: membuat rilis (menyegel kunci ke pembeli) dan menandatanganinya. */
export function createRelease(args: {
  circle: AccountId; license_hash: string; buyer: AccountId; buyerPublicKey: string; content_hash: string; content_size: number; ciphertext: Uint8Array; contentKey: Uint8Array; at: number; sellerSecretKey: string; ephemeralSecret?: Uint8Array
}): { release: LicenseRelease; signature: string } {
  const release: LicenseRelease = {
    circle: args.circle, license_hash: args.license_hash, buyer: args.buyer, content_hash: args.content_hash, cipher_hash: contentHash(args.ciphertext),
    sealed_key: bytesToHex(sealKey(args.contentKey, args.buyerPublicKey, args.ephemeralSecret)), at: args.at, content_size: args.content_size, cipher_size: args.ciphertext.length,
  };
  return { release, signature: signRelease(release, args.sellerSecretKey) };
}

// ---- the buyer: check the delivery, or make the proof of cheating ------------------------------------------------------------------------------------------------------

export type CheatReason = "content_mismatch" | "decrypt_failed";
/** Bukti curang: ciphertext, rilis bertanda tangan penjual (memuat `cipher_hash` dan kunci tersegel), dan kunci kotak yang membuka kunci tersegel itu. */
export type CheatProof = { ciphertext: Uint8Array; release: LicenseRelease; signature: string; box_key: string };
export type DeliveryVerdict =
  | { ok: true; content: Uint8Array }
  | { ok: false; reason: "cipher_hash_mismatch" | "bad_signature" | "sealed_key_unopenable" }
  | { ok: false; reason: CheatReason; proof: CheatProof };

/**
 * Sisi pembeli: memeriksa kiriman. Urutan: `cipher_hash` (salah = salah sumber, bukan kecurangan penjual), tanda tangan rilis, pembukaan kunci tersegel, dekripsi, `content_hash`.
 * Bila dekripsi gagal atau isinya berbeda dari `content_hash`, hasilnya memuat bukti curang yang lolos `checkCheatProof`. Berkas yang benar tidak pernah menghasilkan bukti.
 */
export function verifyDelivery(args: { ciphertext: Uint8Array; release: LicenseRelease; signature: string; sellerPublicKey: string; buyerSecretKey: string }): DeliveryVerdict {
  const { ciphertext, release, signature } = args;
  if (ciphertext.length !== release.cipher_size || contentHash(ciphertext) !== release.cipher_hash) return { ok: false, reason: "cipher_hash_mismatch" };
  if (!verifyRelease(release, signature, args.sellerPublicKey)) return { ok: false, reason: "bad_signature" };
  const sealed = hexToBytes(release.sealed_key);
  let boxKey: Uint8Array;
  let key: Uint8Array;
  try {
    boxKey = deriveBoxKey(sealed, args.buyerSecretKey);
    key = openSealedWithBoxKey(sealed, boxKey);
  } catch {
    return { ok: false, reason: "sealed_key_unopenable" };
  }
  const proof = (reason: CheatReason): DeliveryVerdict => ({ ok: false, reason, proof: { ciphertext, release, signature, box_key: bytesToHex(boxKey) } });
  let content: Uint8Array;
  try {
    content = decryptContent(ciphertext, key);
  } catch {
    return proof("decrypt_failed");
  }
  return content.length === release.content_size && contentHash(content) === release.content_hash ? { ok: true, content } : proof("content_mismatch");
}

/** Membuat bukti curang dari kiriman; melempar `proof_not_possible` bila kirimannya benar atau kesalahannya tidak bisa dibuktikan. */
export function makeCheatProof(args: Parameters<typeof verifyDelivery>[0]): CheatProof {
  const verdict = verifyDelivery(args);
  if (verdict.ok) return fail("proof_not_possible", "berkas benar: tidak ada yang dibuktikan");
  if (!("proof" in verdict)) return fail("proof_not_possible", `kesalahan ini tidak bisa dibuktikan sebagai kecurangan penjual (${verdict.reason})`);
  return verdict.proof;
}

export type ProofVerdict = { valid: true; reason: CheatReason } | { valid: false; reason: "bad_signature" | "cipher_hash_mismatch" | "box_key_invalid" | "file_is_correct" };
/** Pemeriksa bukti curang, bisa dijalankan siapa saja dengan kunci publik penjual: bukti untuk berkas yang benar ditolak (`file_is_correct`). */
export function checkCheatProof(proof: CheatProof, sellerPublicKey: string): ProofVerdict {
  const { ciphertext, release, signature } = proof;
  if (!verifyRelease(release, signature, sellerPublicKey)) return { valid: false, reason: "bad_signature" };
  if (ciphertext.length !== release.cipher_size || contentHash(ciphertext) !== release.cipher_hash) return { valid: false, reason: "cipher_hash_mismatch" };
  let key: Uint8Array;
  try {
    key = openSealedWithBoxKey(hexToBytes(release.sealed_key), hexToBytes(proof.box_key));
  } catch {
    return { valid: false, reason: "box_key_invalid" };
  }
  let content: Uint8Array;
  try {
    content = decryptContent(ciphertext, key);
  } catch {
    return { valid: true, reason: "decrypt_failed" };
  }
  return content.length === release.content_size && contentHash(content) === release.content_hash ? { valid: false, reason: "file_is_correct" } : { valid: true, reason: "content_mismatch" };
}

// ---- where the ciphertext lives: ContentSource (https and ipfs) --------------------------------------------------------------------------------------------------------

export type ContentRef = { kind: "https" | "ipfs"; ref: string };
export type FetchOptions = { signal?: AbortSignal; maxBytes?: number; onProgress?: (received: number) => void };
export interface ContentSource {
  readonly kind: string;
  fetch(ref: string, options?: FetchOptions): Promise<Uint8Array>;
}
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
type FetchLike = (input: string, init?: { signal?: AbortSignal; redirect?: "follow" | "error" }) => Promise<Response>;

async function readBody(res: Response, options: FetchOptions): Promise<Uint8Array> {
  const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) fail("source_too_large", `sumber menyatakan ${declared} byte, batas ${max}`);
  const parts: Uint8Array[] = [];
  let received = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) fail("source_too_large", `sumber mengirim lebih dari ${max} byte`);
    options.onProgress?.(all.length);
    return all;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > max) {
      void reader.cancel();
      fail("source_too_large", `sumber mengirim lebih dari ${max} byte`);
    }
    parts.push(value);
    options.onProgress?.(received);
  }
  return concatBytes(...parts);
}

/** Alamat https tanpa nama pengguna, kata sandi, atau fragmen. Pemeriksaan SSRF (alamat IP privat) ada di backend; di sisi pembeli alamat dibuka oleh browser atau Node pembeli sendiri. */
export function httpsRefProblem(ref: string): string | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return "ref bukan URL";
  }
  if (url.protocol !== "https:") return "ref harus https";
  if (url.username !== "" || url.password !== "" || url.hash !== "") return "ref tidak boleh memuat kredensial atau fragmen";
  return null;
}

export function httpsSource(options: { fetch?: FetchLike } = {}): ContentSource {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    kind: "https",
    async fetch(ref, opts = {}) {
      const problem = httpsRefProblem(ref);
      if (problem !== null) fail("source_forbidden", problem);
      let res: Response;
      try {
        res = await doFetch(ref, { ...(opts.signal ? { signal: opts.signal } : {}), redirect: "follow" });
      } catch (e) {
        return fail("source_failed", `unduhan gagal: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.url !== "" && !res.url.startsWith("https://")) fail("source_forbidden", "pengalihan ke alamat yang bukan https ditolak");
      if (!res.ok) fail("source_failed", `sumber menjawab HTTP ${res.status}`);
      return readBody(res, opts);
    },
  };
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Decode(text: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return fail("source_bad_ref", "CID bukan base32 huruf kecil");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}
function varint(bytes: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && i < at + 5; i++) {
    result |= (bytes[i]! & 0x7f) << shift;
    if ((bytes[i]! & 0x80) === 0) return [result, i + 1];
    shift += 7;
  }
  return fail("source_bad_ref", "CID rusak (varint)");
}

/** CID yang bisa diverifikasi: CIDv1 (base32), kodek raw (0x55), multihash sha2-256. Selain itu `source_cid_unsupported` (CIDv0 dan dag-pb butuh penelusuran DAG). */
export function parseRawCid(cid: string): { digest: Uint8Array } {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return fail("source_cid_unsupported", "CIDv0 (dag-pb) tidak bisa diverifikasi tanpa penelusuran DAG; pakai CIDv1 raw atau sumber https");
  if (!cid.startsWith("b")) return fail("source_bad_ref", "CID harus CIDv1 base32 (diawali b)");
  const bytes = base32Decode(cid.slice(1));
  if (bytes[0] !== 1) return fail("source_bad_ref", "CID bukan versi 1");
  const [codec, at] = varint(bytes, 1);
  const [hashCode, at2] = varint(bytes, at);
  const [length, at3] = varint(bytes, at2);
  if (codec !== 0x55) return fail("source_cid_unsupported", `kodek CID 0x${codec.toString(16)} tidak didukung; hanya raw (0x55)`);
  if (hashCode !== 0x12 || length !== 32 || bytes.length - at3 !== 32) return fail("source_cid_unsupported", "hanya multihash sha2-256 yang didukung");
  return { digest: bytes.slice(at3) };
}

/** CIDv1 raw sha2-256 dari `data`, untuk pengujian dan untuk penjual yang mencatat `ref`. */
export function rawCidOf(data: Uint8Array): string {
  const bytes = concatBytes(Uint8Array.of(0x01, 0x55, 0x12, 0x20), sha256(data));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return `b${out}`;
}

/** Sumber ipfs lewat gateway https. Gateway tidak dipercaya: byte yang diterima harus cocok dengan CID, kalau tidak gateway berikutnya dicoba. */
export function ipfsSource(options: { gateways: readonly string[]; fetch?: FetchLike }): ContentSource {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    kind: "ipfs",
    async fetch(ref, opts = {}) {
      const { digest } = parseRawCid(ref);
      let last = "tidak ada gateway";
      for (const gateway of options.gateways) {
        const problem = httpsRefProblem(gateway);
        if (problem !== null) fail("source_forbidden", `gateway: ${problem}`);
        try {
          const bytes = await httpsSource({ fetch: doFetch }).fetch(`${gateway.replace(/\/+$/, "")}/ipfs/${ref}`, opts);
          if (bytesToHex(sha256(bytes)) === bytesToHex(digest)) return bytes;
          last = "gateway mengirim byte yang tidak cocok dengan CID";
        } catch (e) {
          if (e instanceof LicenseError && (e.code === "source_too_large" || e.code === "source_forbidden")) throw e;
          last = e instanceof Error ? e.message : String(e);
        }
      }
      return fail("source_cid_mismatch", `tidak ada gateway yang mengirim byte yang cocok dengan CID: ${last}`);
    },
  };
}

/** Mengunduh dari sumber yang sesuai dengan `ref.kind` lalu memeriksa `cipher_hash`. Kiriman yang tidak cocok ditolak `cipher_hash_mismatch` (salah sumber, bukan bukti curang). */
export async function fetchCiphertext(ref: ContentRef, cipherHash: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>, options: FetchOptions = {}): Promise<Uint8Array> {
  const source = sources[ref.kind];
  if (!source) return fail("source_bad_ref", `tidak ada sumber untuk jenis ${JSON.stringify(ref.kind)}`);
  const bytes = await source.fetch(ref.ref, options);
  if (contentHash(bytes) !== cipherHash) fail("cipher_hash_mismatch", "byte dari sumber tidak cocok dengan cipher_hash");
  return bytes;
}

// ---- optional canary watermark for a dataset of lines --------------------------------------------------------------------------------------------------------------------

export const CANARY_PREFIX = "x207-canary:";
export type CanaryOptions = { secret: string | Uint8Array; buyer: AccountId; baseContentHash: string; count: number };
const canaryBytes = (o: CanaryOptions, i: number): Uint8Array => hmac(sha256, typeof o.secret === "string" ? utf8(o.secret) : o.secret, utf8(`x207:canary:${o.buyer}:${o.baseContentHash}:${i}`));
export const canaryLine = (o: CanaryOptions, i: number): string => `${CANARY_PREFIX}${bytesToHex(canaryBytes(o, i)).slice(0, 24)}`;

/** Menyisipkan `count` baris canary khas pembeli di posisi yang diturunkan dari HMAC. Dataset asli tidak boleh sudah memuat baris berawalan canary. */
export function addCanaries(lines: readonly string[], o: CanaryOptions): string[] {
  if (!HASH.test(o.baseContentHash) || !Number.isSafeInteger(o.count) || o.count < 1 || o.count > 64) fail("canary_bad_input", "baseContentHash harus hash heks dan count 1 sampai 64");
  if (lines.some((l) => l.startsWith(CANARY_PREFIX))) fail("canary_bad_input", "dataset sudah memuat baris canary");
  const out = [...lines];
  for (let i = 0; i < o.count; i++) {
    const position = new DataView(canaryBytes(o, i).buffer).getUint32(24) % (out.length + 1);
    out.splice(position, 0, canaryLine(o, i));
  }
  return out;
}
/** Dataset tanpa baris canary: untuk mencocokkan dengan `content_hash` dasar. */
export const stripCanaries = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith(CANARY_PREFIX));
/** Berapa canary milik pembeli ini yang ditemukan di `lines` (bukti bahwa salinan ini bersumber dari kiriman ke pembeli itu). */
export function findCanaries(lines: readonly string[], o: CanaryOptions): { found: number; expected: number } {
  const present = new Set(lines.filter((l) => l.startsWith(CANARY_PREFIX)));
  let found = 0;
  for (let i = 0; i < o.count; i++) if (present.has(canaryLine(o, i))) found += 1;
  return { found, expected: o.count };
}
