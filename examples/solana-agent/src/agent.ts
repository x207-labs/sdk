// An agent whose identity is a Solana keypair (SD-098). A Solana key is an ed25519 key, and so is a NEAR access key and an x207 voucher key. The 32-byte public key is
// therefore three things at once: the Solana address (base58), the NEAR implicit account (64 lower-case hex characters, no account creation needed) and the x207
// `pubkey_voucher` (`ed25519:<base58>`). Nothing in the contract changes: the agent is a plain NEAR member whose account id is the hex of its public key.
// Nothing here prints or returns more than the caller asks for; the secret goes only to the key file the caller writes.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { base58Encode, nep413SigningHash, voucherPublicKey } from "@x207/core";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX_LENGTH = 12;

export type SolanaAgentKeys = {
  /** Solana address: base58 of the 32-byte public key. */
  solanaAddress: string;
  /** NEAR implicit account and x207 member id: 64 lower-case hex characters of the same public key. */
  accountId: string;
  /** `ed25519:<base58 of seed||public key>`: valid as a NEAR access key and as an x207 voucher key. */
  secretKey: `ed25519:${string}`;
  /** `ed25519:<base58 public key>`: the `pubkey_voucher` given to `join`. */
  voucherPublicKey: `ed25519:${string}`;
  /** The 64 bytes of a Solana `id.json` keypair file (seed then public key). */
  solanaKeypairBytes: Uint8Array;
};

/** Keys from a 64-byte Solana keypair (seed then public key, as in `solana-keygen` files). */
export function solanaAgentKeysFromKeypair(keypair: Uint8Array): SolanaAgentKeys {
  if (keypair.length !== 64) throw new Error("a Solana keypair is 64 bytes (32 seed then 32 public key)");
  const seed = keypair.slice(0, 32);
  const publicKey = keypair.slice(32);
  const derived = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX_LENGTH);
  if (Buffer.compare(Buffer.from(derived), Buffer.from(publicKey)) !== 0) throw new Error("the public key half of the keypair does not match its seed");
  const secretKey: `ed25519:${string}` = `ed25519:${base58Encode(keypair)}`;
  return { solanaAddress: base58Encode(publicKey), accountId: Buffer.from(publicKey).toString("hex"), secretKey, voucherPublicKey: voucherPublicKey(secretKey), solanaKeypairBytes: keypair };
}

/** A new random Solana keypair, as the 64-byte file format. */
export function generateSolanaKeypair(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX_LENGTH);
  return Uint8Array.from(Buffer.concat([seed, pub]));
}

/** A legacy Solana message that moves `lamports` from the agent to `to` (System Program transfer). Only used to show that such bytes are not a valid x207 message. */
export function solanaTransferMessage(from: Uint8Array, to: Uint8Array, lamports: bigint, recentBlockhash: Uint8Array): Uint8Array {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return Uint8Array.from(Buffer.concat([
    Uint8Array.of(1, 0, 1, 3), from, to, new Uint8Array(32), recentBlockhash, // header, three account keys (the third is the System Program, all zero), blockhash
    Uint8Array.of(1, 2, 2, 0, 1, 12), data, // one instruction: program index 2, accounts [0, 1], 12 bytes of data
  ]));
}

/** What the agent's key signs when it pays with Solana: the bytes of the message, not a hash. */
export function signSolanaMessage(keys: SolanaAgentKeys, message: Uint8Array): Uint8Array {
  return Uint8Array.from(nodeSign(null, message, createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, keys.solanaKeypairBytes.slice(0, 32)]), format: "der", type: "pkcs8" })));
}

/** The 32-byte hash a NEAR/x207 message signature covers (NEP-413): a different preimage from any Solana transaction message. */
export const nearMessageHash = nep413SigningHash;
