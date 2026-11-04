// Canonical voucher serialization (NEP-413 style, ADR-06) and ed25519 signature.
// Byte format: spec/voucher-format.md. The Rust contract builds the same bytes (Contract Interface Spec 3.3).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { base58Decode, base58Encode } from "./base58.js";
import {
  UNSIGNED_VOUCHER_KEYS,
  type Ed25519Signature,
  type UnsignedVoucher,
  type Voucher,
} from "./types.js";
import { validateUnsignedVoucher } from "./validate.js";

/** Tag NEP-413: 2^31 + 413. */
export const NEP413_TAG = 2147484061;

/** ed25519 voucher key: a 32-byte seed, or the string `ed25519:<base58 64 bytes>` (seed + pubkey, NEAR style). */
export type VoucherSecretKey = Uint8Array | `ed25519:${string}`;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PREFIX = "ed25519:";

const sha256 = (data: Uint8Array): Uint8Array => createHash("sha256").update(data).digest();
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

const borshString = (text: string): Uint8Array => {
  const bytes = utf8(text);
  return Buffer.concat([u32le(bytes.length), bytes]);
};

function assertSerializable(voucher: UnsignedVoucher): void {
  const result = validateUnsignedVoucher(voucher);
  if (!result.ok) throw new Error(`voucher cannot be serialized: ${result.field} ${result.message}`);
}

/** Canonical JSON without `signature`: fixed key order, no whitespace, `cumulativeAmount` a string, `epoch` and `seq` numbers. */
export function serializeVoucherMessage(voucher: UnsignedVoucher): string {
  assertSerializable(voucher);
  const ordered = Object.fromEntries(UNSIGNED_VOUCHER_KEYS.map((key) => [key, voucher[key]]));
  return JSON.stringify(ordered);
}

/** `sha256("x207:" + payer + ":" + payee + ":" + epoch + ":" + seq)`, 32 bytes. */
export function voucherNonce(voucher: UnsignedVoucher): Uint8Array {
  assertSerializable(voucher);
  const { payer, payee, epoch, seq } = voucher;
  return sha256(utf8(`x207:${payer}:${payee}:${epoch}:${seq}`));
}

/** `borsh(u32 NEP413_TAG)` + `borsh({ message, nonce, recipient, callback_url: None })`. */
export function voucherPayload(voucher: UnsignedVoucher): Uint8Array {
  return Buffer.concat([
    u32le(NEP413_TAG),
    borshString(serializeVoucherMessage(voucher)),
    voucherNonce(voucher),
    borshString(voucher.circle),
    Uint8Array.of(0),
  ]);
}

/** What is signed: `sha256(payload)`. */
export const voucherSigningHash = (voucher: UnsignedVoucher): Uint8Array =>
  sha256(voucherPayload(voucher));

function seedOf(secretKey: VoucherSecretKey): Uint8Array {
  if (typeof secretKey !== "string") {
    if (secretKey.length !== 32) throw new Error("voucher key seed must be 32 bytes");
    return secretKey;
  }
  if (!secretKey.startsWith(ED25519_PREFIX)) throw new Error("voucher key must be ed25519:<base58>");
  const bytes = base58Decode(secretKey.slice(ED25519_PREFIX.length));
  if (bytes.length !== 64) throw new Error("voucher key ed25519:<base58> must be 64 bytes");
  return bytes.slice(0, 32);
}

const privateKeyOf = (seed: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });

/** Voucher pubkey `ed25519:<base58>` (the `pubkey_voucher` value in D1). */
export function voucherPublicKey(secretKey: VoucherSecretKey): `ed25519:${string}` {
  const spki = createPublicKey(privateKeyOf(seedOf(secretKey))).export({ format: "der", type: "spki" });
  return `${ED25519_PREFIX}${base58Encode(spki.subarray(SPKI_PREFIX.length))}`;
}

/** New voucher keypair. This key is not a NEAR access key (ADR-06). */
export function generateVoucherKeypair(): { secretKey: `ed25519:${string}`; publicKey: `ed25519:${string}` } {
  const seed = randomBytes(32);
  const publicKey = voucherPublicKey(seed);
  const pub = base58Decode(publicKey.slice(ED25519_PREFIX.length));
  return { secretKey: `${ED25519_PREFIX}${base58Encode(Buffer.concat([seed, pub]))}`, publicKey };
}

/** `sha256` of the NEP-413 payload for any message: `u32 tag` + borsh `{ message, nonce[32], recipient, callback_url: None }`. */
export function nep413SigningHash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  return sha256(
    Buffer.concat([u32le(NEP413_TAG), borshString(message), nonce, borshString(recipient), Uint8Array.of(0)]),
  );
}

/** ed25519 signature over a 32-byte hash, written `ed25519:<base58 64 bytes>`. */
export function signHash(hash: Uint8Array, secretKey: VoucherSecretKey): Ed25519Signature {
  return `${ED25519_PREFIX}${base58Encode(nodeSign(null, hash, privateKeyOf(seedOf(secretKey))))}` as Ed25519Signature;
}

/** `true` only if `signature` is valid over `hash` for `publicKey`; malformed input yields `false`. */
export function verifyHash(hash: Uint8Array, signature: string, publicKey: string): boolean {
  try {
    if (!publicKey.startsWith(ED25519_PREFIX) || !signature.startsWith(ED25519_PREFIX)) return false;
    const pub = base58Decode(publicKey.slice(ED25519_PREFIX.length));
    const sig = base58Decode(signature.slice(ED25519_PREFIX.length));
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return nodeVerify(null, hash, key, sig);
  } catch {
    return false;
  }
}

export function signVoucher(voucher: UnsignedVoucher, secretKey: VoucherSecretKey): Voucher {
  const hash = voucherSigningHash(voucher);
  const signature = nodeSign(null, hash, privateKeyOf(seedOf(secretKey)));
  const { circle, payer, payee, epoch, seq, cumulativeAmount, unit, resource } = voucher;
  return {
    circle, payer, payee, epoch, seq, cumulativeAmount, unit, resource,
    signature: `${ED25519_PREFIX}${base58Encode(signature)}` as Ed25519Signature,
  };
}

/** `true` only if the signature is valid over the canonical bytes. Malformed input yields `false`, does not throw. */
export function verifyVoucher(voucher: Voucher, publicKey: string): boolean {
  try {
    if (!publicKey.startsWith(ED25519_PREFIX) || !voucher.signature.startsWith(ED25519_PREFIX)) return false;
    const pub = base58Decode(publicKey.slice(ED25519_PREFIX.length));
    const signature = base58Decode(voucher.signature.slice(ED25519_PREFIX.length));
    if (pub.length !== 32 || signature.length !== 64) return false;
    const { signature: _signature, ...unsigned } = voucher;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return nodeVerify(null, voucherSigningHash(unsigned), key, signature);
  } catch {
    return false;
  }
}
