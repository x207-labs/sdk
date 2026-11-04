// Content license format and fair exchange with encryption (SD-070, pipeline P7, ADR-46). What is sold is a license over a file; x207 does not store the file itself.
// Flow: the seller posts the ciphertext at any source and records `cipher_hash`; the buyer downloads and checks `cipher_hash`; the seller releases the file key sealed to the
// buyer's x25519 key and signs that release; the buyer decrypts and checks `content_hash`. Match: confirmation. Mismatch: a cheat proof anyone can verify.
//
// This module uses neither node:crypto nor Buffer, so it runs in the browser (FE-028) and in Node. Crypto is from @noble (XChaCha20-Poly1305, ed25519 and x25519, sha256, HMAC).
//
// Acknowledged limits: (1) a cheat proof is only possible if the released key can be opened by the buyer; a seller who releases a corrupted sealed key cannot be proven wrong, only
// goes unpaid (the buyer disputes `other`, the voucher is not registered). (2) Exclusive licenses are recorded per `content_hash`; a seller who changes one byte goes undetected.
// (3) Watermarks detect a redistributor who copies the whole file, not one who processes it.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58Decode, base58Encode } from "./base58.js";
import { publicHostProblem } from "./metered-presets.js";
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

/** Chunk size for Merkle and for encryption: 4 MiB. */
export const CONTENT_CHUNK = 4 * 1024 * 1024;
const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

/** RFC 6962-style Merkle root: leaf `sha256(0x00 ‖ chunk)`, node `sha256(0x01 ‖ left ‖ right)`, split at the largest power of two less than the leaf count. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return fail("cipher_bad_format", "Merkle needs at least one leaf");
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return sha256(concatBytes(NODE, merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k))));
}

/**
 * Staged content hash, one scheme for all sizes (fix for F1 and F2 from the BE-062 review): the file is cut per 4 MiB, each chunk becomes a leaf `sha256(0x00 ‖ chunk)`, and
 * leaves are combined with `merkleRoot` (node `sha256(0x01 ‖ left ‖ right)`). A single-chunk file, including an empty one, still goes through a leaf, so no content can be both
 * a leaf and a node: the 65-byte string `0x01 ‖ left ‖ right` does not have the same hash as a large file.
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

  /** Lowercase hex hash, 64 characters. May be called once. */
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
  /** License kind from the backend `license_id` list, e.g. `personal` or `commercial`; ASCII `[a-z0-9.-]` 1 to 32. */
  license_id: string;
  /** sha256 of the license text. */
  license_hash: string;
  /** sha256 of the preview (a small chunk that may be seen before buying); `null` if none. */
  preview_hash?: string | null;
  exclusive: boolean;
  nonce: string;
};

export function normalizeLicense(doc: LicenseDocument): Required<LicenseDocument> {
  for (const [name, value] of [["circle", doc.circle], ["seller", doc.seller]] as const) if (!isAccount(value)) fail("license_bad_account", `${name} is not a NEAR account: ${JSON.stringify(value)}`);
  for (const [name, value] of [["content_hash", doc.content_hash], ["license_hash", doc.license_hash]] as const) if (!HASH.test(value)) fail("license_bad_hash", `${name} must be 64 lowercase hex characters`);
  const preview = doc.preview_hash ?? null;
  if (preview !== null && !HASH.test(preview)) fail("license_bad_hash", "preview_hash must be 64 lowercase hex characters");
  if (!/^[a-z0-9.-]{1,32}$/.test(doc.license_id)) fail("license_bad_license_id", "license_id must be 1 to 32 characters [a-z0-9.-]");
  if (typeof doc.exclusive !== "boolean") fail("license_bad_hash", "exclusive must be a boolean");
  if (typeof doc.nonce !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(doc.nonce)) fail("license_bad_nonce", "nonce must be 1 to 32 characters [A-Za-z0-9._-]");
  return { circle: doc.circle, seller: doc.seller, content_hash: doc.content_hash, license_id: doc.license_id, license_hash: doc.license_hash, preview_hash: preview, exclusive: doc.exclusive, nonce: doc.nonce };
}
/** Canonical JSON: keys `circle, seller, content_hash, license_id, license_hash, preview_hash, exclusive, nonce`. */
export const serializeLicense = (doc: LicenseDocument): string => JSON.stringify(normalizeLicense(doc));
export const licenseDocumentHash = (doc: LicenseDocument): string => bytesToHex(sha256(utf8(serializeLicense(doc))));
export function licenseResource(hash: string): string {
  if (!HASH.test(hash)) return fail("license_bad_resource", "license hash must be 64 lowercase hex characters");
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
 * Encrypts `plain` with a 32-byte key (random if not given). Format: `"X207ENC1" ‖ 16-byte prefix ‖ chunks`; each 4 MiB chunk is encrypted with nonce `prefix ‖ index`
 * and AAD of one byte marking the last chunk, so truncation, insertion, and reordering are detected. An empty file is still one chunk.
 */
export function encryptContent(plain: Uint8Array, options: { key?: Uint8Array; prefix?: Uint8Array } = {}): { ciphertext: Uint8Array; key: Uint8Array } {
  const key = options.key ?? randomBytes(32);
  const prefix = options.prefix ?? randomBytes(PREFIX);
  if (key.length !== 32) fail("license_bad_key", "file key must be 32 bytes");
  if (prefix.length !== PREFIX) fail("cipher_bad_format", `nonce prefix must be ${PREFIX} bytes`);
  const count = Math.max(1, Math.ceil(plain.length / CONTENT_CHUNK));
  const parts: Uint8Array[] = [MAGIC, prefix];
  for (let i = 0; i < count; i++) {
    parts.push(xchacha20poly1305(key, chunkNonce(prefix, i), finalAad(i === count - 1)).encrypt(plain.subarray(i * CONTENT_CHUNK, (i + 1) * CONTENT_CHUNK)));
  }
  return { ciphertext: concatBytes(...parts), key };
}

/** Decrypts; throws `cipher_bad_format` if not this format, truncated, or any chunk fails authentication (wrong key or altered ciphertext). */
export function decryptContent(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) fail("license_bad_key", "file key must be 32 bytes");
  if (ciphertext.length < HEADER + TAG || !MAGIC.every((b, i) => ciphertext[i] === b)) fail("cipher_bad_format", "not an X207ENC1 ciphertext");
  const prefix = ciphertext.subarray(MAGIC.length, HEADER);
  const body = ciphertext.subarray(HEADER);
  const full = CONTENT_CHUNK + TAG;
  const count = Math.max(1, Math.ceil(body.length / full));
  const lastLength = body.length - (count - 1) * full;
  if (lastLength < TAG) fail("cipher_bad_format", "ciphertext truncated");
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const piece = body.subarray(i * full, i === count - 1 ? body.length : (i + 1) * full);
    try {
      out.push(xchacha20poly1305(key, chunkNonce(prefix, i), finalAad(i === count - 1)).decrypt(piece));
    } catch {
      return fail("cipher_bad_format", `chunk ${i + 1} failed authentication: wrong key or the ciphertext changed`);
    }
  }
  return concatBytes(...out);
}

// ---- key sealed to the buyer (x25519 derived from the voucher key, ed25519) -------------------------------------------------------------------------------------------

const ED = "ed25519:";
function edSeed(secretKey: string): Uint8Array {
  if (!secretKey.startsWith(ED)) return fail("license_bad_key", "voucher key must be ed25519:<base58>");
  const bytes = base58Decode(secretKey.slice(ED.length));
  if (bytes.length !== 32 && bytes.length !== 64) return fail("license_bad_key", "voucher key must be 32 or 64 bytes");
  return bytes.slice(0, 32);
}
function edPublic(publicKey: string): Uint8Array {
  if (!publicKey.startsWith(ED)) return fail("license_bad_key", "public key must be ed25519:<base58>");
  const bytes = base58Decode(publicKey.slice(ED.length));
  if (bytes.length !== 32) return fail("license_bad_key", "public key must be 32 bytes");
  return bytes;
}
/** Public key `ed25519:<base58>` from the secret voucher key. */
export const licensePublicKey = (secretKey: string): string => `${ED}${base58Encode(ed25519.getPublicKey(edSeed(secretKey)))}`;

const BOX_DOMAIN = utf8("x207:license:box:v1");
const boxKeyOf = (shared: Uint8Array, ephemeralPub: Uint8Array, recipientPub: Uint8Array): Uint8Array => sha256(concatBytes(BOX_DOMAIN, shared, ephemeralPub, recipientPub));
const BOX_NONCE = new Uint8Array(24); // the box key is unique per ephemeral key, so a fixed nonce is safe

/** Seals the file key to the buyer's ed25519 public key: `ephemeral x25519 pub (32) ‖ key ciphertext (32 + 16)`; the box key comes from X25519 with the buyer. */
export function sealKey(contentKey: Uint8Array, buyerPublicKey: string, ephemeralSecret?: Uint8Array): Uint8Array {
  if (contentKey.length !== 32) fail("license_bad_key", "file key must be 32 bytes");
  const recipient = ed25519.utils.toMontgomery(edPublic(buyerPublicKey));
  const secret = ephemeralSecret ?? x25519.utils.randomSecretKey();
  const ephemeralPub = x25519.getPublicKey(secret);
  const box = boxKeyOf(x25519.getSharedSecret(secret, recipient), ephemeralPub, recipient);
  return concatBytes(ephemeralPub, xchacha20poly1305(box, BOX_NONCE).encrypt(contentKey));
}

/** Box (symmetric) key for `sealed`, from the buyer's voucher key: used to open the key and, if needed, handed over as part of the cheat proof. */
export function deriveBoxKey(sealed: Uint8Array, buyerSecretKey: string): Uint8Array {
  if (sealed.length !== 32 + 32 + TAG) fail("release_bad_key", "sealed key must be 80 bytes");
  const seed = edSeed(buyerSecretKey);
  const mine = ed25519.utils.toMontgomerySecret(seed);
  const ephemeralPub = sealed.subarray(0, 32);
  return boxKeyOf(x25519.getSharedSecret(mine, ephemeralPub), ephemeralPub, x25519.getPublicKey(mine));
}
/** Opens the sealed key with the box key; throws `release_bad_key` if authentication fails. */
export function openSealedWithBoxKey(sealed: Uint8Array, boxKey: Uint8Array): Uint8Array {
  if (sealed.length !== 32 + 32 + TAG || boxKey.length !== 32) fail("release_bad_key", "invalid sealed key or box key");
  try {
    return xchacha20poly1305(boxKey, BOX_NONCE).decrypt(sealed.subarray(32));
  } catch {
    return fail("release_bad_key", "the sealed key cannot be opened with this box key");
  }
}
export const openSealedKey = (sealed: Uint8Array, buyerSecretKey: string): Uint8Array => openSealedWithBoxKey(sealed, deriveBoxKey(sealed, buyerSecretKey));

// ---- the release signed by the seller ---------------------------------------------------------------------------------------------------------------------------------

/** Key release signed by the seller: binds the license document, content, ciphertext, buyer, and sealed key. */
export type LicenseRelease = {
  circle: AccountId; license_hash: string; buyer: AccountId; content_hash: string; cipher_hash: string; sealed_key: string; at: number
  /** Size of the original file and the ciphertext in bytes, signed as well: the checker rejects content of a different size (BE-062 review, F1 and F2). */
  content_size: number; cipher_size: number
  /** `sha256` of the file key (F11): the key opened from the box must match, so the key cannot be swapped later. */
  key_commitment: string
  /** The purchase this release serves (F12): a release for one purchase cannot be reused for another purchase by the same buyer. */
  purchase_id: string
};
const serializeRelease = (r: LicenseRelease): string =>
  JSON.stringify({
    circle: r.circle, license_hash: r.license_hash, buyer: r.buyer, content_hash: r.content_hash, cipher_hash: r.cipher_hash, sealed_key: r.sealed_key, at: r.at, content_size: r.content_size, cipher_size: r.cipher_size, key_commitment: r.key_commitment, purchase_id: r.purchase_id,
  });

function checkRelease(r: LicenseRelease): void {
  if (!isAccount(r.circle) || !isAccount(r.buyer)) fail("license_bad_account", "circle and buyer must be NEAR accounts");
  for (const h of [r.license_hash, r.content_hash, r.cipher_hash]) if (!HASH.test(h)) fail("license_bad_hash", "release hash must be 64 lowercase hex characters");
  if (!/^(?:[0-9a-f]{2}){80}$/.test(r.sealed_key)) fail("release_bad_key", "sealed_key must be 80 bytes in hex");
  if (!Number.isSafeInteger(r.at) || r.at <= 0) fail("license_bad_nonce", "at must be unix seconds");
  if (!HASH.test(r.key_commitment)) fail("license_bad_hash", "key_commitment must be 64 lowercase hex characters");
  if (typeof r.purchase_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.purchase_id)) fail("license_bad_nonce", "purchase_id must be 1 to 64 characters [A-Za-z0-9_-]");
  for (const n of [r.content_size, r.cipher_size]) if (!Number.isSafeInteger(n) || n < 0) fail("license_bad_hash", "content_size and cipher_size must be integers >= 0");
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
/** The same NEP-413 hash as `nep413SigningHash` in voucher.ts, computed without node:crypto: nonce = sha256(message), recipient = circle contract account. */
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

/** Seller side: builds the release (seals the key to the buyer) and signs it. */
export function createRelease(args: {
  circle: AccountId; license_hash: string; buyer: AccountId; buyerPublicKey: string; content_hash: string; content_size: number; purchase_id: string; ciphertext: Uint8Array; contentKey: Uint8Array; at: number; sellerSecretKey: string; ephemeralSecret?: Uint8Array
}): { release: LicenseRelease; signature: string } {
  const release: LicenseRelease = {
    circle: args.circle, license_hash: args.license_hash, buyer: args.buyer, content_hash: args.content_hash, cipher_hash: contentHash(args.ciphertext),
    sealed_key: bytesToHex(sealKey(args.contentKey, args.buyerPublicKey, args.ephemeralSecret)), at: args.at, content_size: args.content_size, cipher_size: args.ciphertext.length,
    key_commitment: bytesToHex(sha256(args.contentKey)), purchase_id: args.purchase_id,
  };
  return { release, signature: signRelease(release, args.sellerSecretKey) };
}

// ---- the buyer: check the delivery, or make the proof of cheating ------------------------------------------------------------------------------------------------------

export type CheatReason = "content_mismatch" | "decrypt_failed" | "key_mismatch";
/** Cheat proof: the ciphertext, the seller-signed release (containing `cipher_hash` and the sealed key), and the box key that opens that sealed key. */
export type CheatProof = { ciphertext: Uint8Array; release: LicenseRelease; signature: string; box_key: string };
export type DeliveryVerdict =
  | { ok: true; content: Uint8Array }
  | { ok: false; reason: "cipher_hash_mismatch" | "bad_signature" | "sealed_key_unopenable" | "wrong_purchase" }
  | { ok: false; reason: CheatReason; proof: CheatProof };

/**
 * Buyer side: checks the delivery. Order: `cipher_hash` (wrong = wrong source, not seller cheating), release signature, opening the sealed key, decryption, `content_hash`.
 * If decryption fails or the content differs from `content_hash`, the result carries a cheat proof that passes `checkCheatProof`. A correct file never produces a proof.
 */
export function verifyDelivery(args: { ciphertext: Uint8Array; release: LicenseRelease; signature: string; sellerPublicKey: string; buyerSecretKey: string; purchaseId?: string }): DeliveryVerdict {
  const { ciphertext, release, signature } = args;
  if (args.purchaseId !== undefined && release.purchase_id !== args.purchaseId) return { ok: false, reason: "wrong_purchase" };
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
  if (bytesToHex(sha256(key)) !== release.key_commitment) return proof("key_mismatch");
  let content: Uint8Array;
  try {
    content = decryptContent(ciphertext, key);
  } catch {
    return proof("decrypt_failed");
  }
  return content.length === release.content_size && contentHash(content) === release.content_hash ? { ok: true, content } : proof("content_mismatch");
}

/** Builds a cheat proof from a delivery; throws `proof_not_possible` if the delivery is correct or the fault cannot be proven. */
export function makeCheatProof(args: Parameters<typeof verifyDelivery>[0]): CheatProof {
  const verdict = verifyDelivery(args);
  if (verdict.ok) return fail("proof_not_possible", "the file is correct: nothing to prove");
  if (!("proof" in verdict)) return fail("proof_not_possible", `this error cannot be proven as seller cheating (${verdict.reason})`);
  return verdict.proof;
}

export type ProofVerdict = { valid: true; reason: CheatReason } | { valid: false; reason: "bad_signature" | "cipher_hash_mismatch" | "box_key_invalid" | "file_is_correct" | "wrong_purchase" };
/** Cheat proof checker, runnable by anyone with the seller's public key: a proof for a correct file is rejected (`file_is_correct`). */
export function checkCheatProof(proof: CheatProof, sellerPublicKey: string, purchaseId?: string): ProofVerdict {
  const { ciphertext, release, signature } = proof;
  if (purchaseId !== undefined && release.purchase_id !== purchaseId) return { valid: false, reason: "wrong_purchase" };
  if (!verifyRelease(release, signature, sellerPublicKey)) return { valid: false, reason: "bad_signature" };
  if (ciphertext.length !== release.cipher_size || contentHash(ciphertext) !== release.cipher_hash) return { valid: false, reason: "cipher_hash_mismatch" };
  let key: Uint8Array;
  try {
    key = openSealedWithBoxKey(hexToBytes(release.sealed_key), hexToBytes(proof.box_key));
  } catch {
    return { valid: false, reason: "box_key_invalid" };
  }
  if (bytesToHex(sha256(key)) !== release.key_commitment) return { valid: true, reason: "key_mismatch" };
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
type FetchLike = (input: string, init?: { signal?: AbortSignal; redirect?: "follow" | "error" | "manual" }) => Promise<Response>;

async function readBody(res: Response, options: FetchOptions): Promise<Uint8Array> {
  const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) fail("source_too_large", `source declares ${declared} bytes, limit ${max}`);
  const parts: Uint8Array[] = [];
  let received = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) fail("source_too_large", `source sent more than ${max} bytes`);
    options.onProgress?.(all.length);
    return all;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > max) {
      void reader.cancel();
      fail("source_too_large", `source sent more than ${max} bytes`);
    }
    parts.push(value);
    options.onProgress?.(received);
  }
  return concatBytes(...parts);
}

/** https address without username, password, or fragment. The SSRF check (private IP addresses) is in the backend; on the buyer side the address is opened by the buyer's own browser or Node. */
export function httpsRefProblem(ref: string): string | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return "ref is not a URL";
  }
  if (url.protocol !== "https:") return "ref must be https";
  if (url.username !== "" || url.password !== "" || url.hash !== "") return "ref must not contain credentials or a fragment";
  // F10 (review BE-062): a name of the own network (localhost, .internal, an IP, a name that carries an IP) is not a place to fetch a ciphertext from
  const host = publicHostProblem(url.hostname);
  return host === null ? null : host.replace("endpoint", "ref");
}

export const MAX_REDIRECTS = 3;
export function httpsSource(options: { fetch?: FetchLike; maxRedirects?: number } = {}): ContentSource {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  return {
    kind: "https",
    async fetch(ref, opts = {}) {
      let current = ref;
      for (let hop = 0; ; hop++) {
        // every address, the first and each redirect, goes through the same check; redirects are followed by hand (F10, review BE-062)
        const problem = httpsRefProblem(current);
        if (problem !== null) fail("source_forbidden", hop === 0 ? problem : `redirect to a rejected address: ${problem}`);
        let res: Response;
        try {
          res = await doFetch(current, { ...(opts.signal ? { signal: opts.signal } : {}), redirect: "manual" });
        } catch (e) {
          return fail("source_failed", `download failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (res.type === "opaqueredirect") fail("source_forbidden", "the browser hides the redirect target: a source with a redirect cannot be checked, use a direct address");
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (hop >= maxRedirects) return fail("source_forbidden", `more than ${maxRedirects} redirects`);
          if (location === null) return fail("source_forbidden", "redirect without Location");
          try {
            current = new URL(location, current).href;
          } catch {
            return fail("source_forbidden", "redirect Location is not a URL");
          }
          continue;
        }
        if (!res.ok) fail("source_failed", `source answered HTTP ${res.status}`);
        return readBody(res, opts);
      }
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
    if (idx < 0) return fail("source_bad_ref", "CID is not lowercase base32");
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
  return fail("source_bad_ref", "malformed CID (varint)");
}

/** A verifiable CID: CIDv1 (base32), raw codec (0x55), multihash sha2-256. Anything else is `source_cid_unsupported` (CIDv0 and dag-pb need DAG traversal). */
export function parseRawCid(cid: string): { digest: Uint8Array } {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return fail("source_cid_unsupported", "CIDv0 (dag-pb) cannot be verified without walking the DAG; use a CIDv1 raw or an https source");
  if (!cid.startsWith("b")) return fail("source_bad_ref", "CID must be CIDv1 base32 (starting with b)");
  const bytes = base32Decode(cid.slice(1));
  if (bytes[0] !== 1) return fail("source_bad_ref", "CID is not version 1");
  const [codec, at] = varint(bytes, 1);
  const [hashCode, at2] = varint(bytes, at);
  const [length, at3] = varint(bytes, at2);
  if (codec !== 0x55) return fail("source_cid_unsupported", `CID codec 0x${codec.toString(16)} is not supported; only raw (0x55)`);
  if (hashCode !== 0x12 || length !== 32 || bytes.length - at3 !== 32) return fail("source_cid_unsupported", "only sha2-256 multihash is supported");
  return { digest: bytes.slice(at3) };
}

/** CIDv1 raw sha2-256 of `data`, for tests and for sellers who record `ref`. */
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

/** ipfs source through an https gateway. The gateway is not trusted: the bytes received must match the CID, otherwise the next gateway is tried. */
export function ipfsSource(options: { gateways: readonly string[]; fetch?: FetchLike }): ContentSource {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    kind: "ipfs",
    async fetch(ref, opts = {}) {
      const { digest } = parseRawCid(ref);
      let last = "no gateway";
      for (const gateway of options.gateways) {
        const problem = httpsRefProblem(gateway);
        if (problem !== null) fail("source_forbidden", `gateway: ${problem}`);
        try {
          const bytes = await httpsSource({ fetch: doFetch }).fetch(`${gateway.replace(/\/+$/, "")}/ipfs/${ref}`, opts);
          if (bytesToHex(sha256(bytes)) === bytesToHex(digest)) return bytes;
          last = "gateway sent bytes that do not match the CID";
        } catch (e) {
          if (e instanceof LicenseError && (e.code === "source_too_large" || e.code === "source_forbidden")) throw e;
          last = e instanceof Error ? e.message : String(e);
        }
      }
      return fail("source_cid_mismatch", `no gateway sent bytes that match the CID: ${last}`);
    },
  };
}

/** Downloads from the source matching `ref.kind` then checks `cipher_hash`. A mismatching delivery is rejected `cipher_hash_mismatch` (wrong source, not a cheat proof). */
export async function fetchCiphertext(ref: ContentRef, cipherHash: string, sources: Partial<Record<ContentRef["kind"], ContentSource>>, options: FetchOptions = {}): Promise<Uint8Array> {
  const source = sources[ref.kind];
  if (!source) return fail("source_bad_ref", `no source for kind ${JSON.stringify(ref.kind)}`);
  const bytes = await source.fetch(ref.ref, options);
  if (contentHash(bytes) !== cipherHash) fail("cipher_hash_mismatch", "bytes from the source do not match cipher_hash");
  return bytes;
}

// ---- optional canary watermark for a dataset of lines --------------------------------------------------------------------------------------------------------------------

export const CANARY_PREFIX = "x207-canary:";
export type CanaryOptions = { secret: string | Uint8Array; buyer: AccountId; baseContentHash: string; count: number };
const canaryBytes = (o: CanaryOptions, i: number): Uint8Array => hmac(sha256, typeof o.secret === "string" ? utf8(o.secret) : o.secret, utf8(`x207:canary:${o.buyer}:${o.baseContentHash}:${i}`));
export const canaryLine = (o: CanaryOptions, i: number): string => `${CANARY_PREFIX}${bytesToHex(canaryBytes(o, i)).slice(0, 24)}`;

/** Inserts `count` buyer-specific canary lines at positions derived from HMAC. The original dataset must not already contain lines starting with the canary. */
export function addCanaries(lines: readonly string[], o: CanaryOptions): string[] {
  if (!HASH.test(o.baseContentHash) || !Number.isSafeInteger(o.count) || o.count < 1 || o.count > 64) fail("canary_bad_input", "baseContentHash must be a hex hash and count 1 to 64");
  if (lines.some((l) => l.startsWith(CANARY_PREFIX))) fail("canary_bad_input", "dataset already contains a canary line");
  const out = [...lines];
  for (let i = 0; i < o.count; i++) {
    const position = new DataView(canaryBytes(o, i).buffer).getUint32(24) % (out.length + 1);
    out.splice(position, 0, canaryLine(o, i));
  }
  return out;
}
/** Dataset without canary lines: to match against the base `content_hash`. */
export const stripCanaries = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith(CANARY_PREFIX));
/** How many of this buyer's canaries are found in `lines` (proof that this copy came from the delivery to that buyer). */
export function findCanaries(lines: readonly string[], o: CanaryOptions): { found: number; expected: number } {
  const present = new Set(lines.filter((l) => l.startsWith(CANARY_PREFIX)));
  let found = 0;
  for (let i = 0; i < o.count; i++) if (present.has(canaryLine(o, i))) found += 1;
  return { found, expected: o.count };
}
