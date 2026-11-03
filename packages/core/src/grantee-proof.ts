// Bukti `grantee_ref` untuk sewa akses (SD-071, pipeline P2, ADR-47): penyewa membuktikan bahwa ia mengendalikan akun yang namanya dipakai sebagai `grantee_ref`, supaya grant
// tidak bisa diarahkan ke akun yang hanya diketahui namanya dan tidak bisa dijual lagi ke orang lain. Tiga bentuk:
//   - `near-gist`: penyewa menaruh tantangan yang ditandatangani kunci voucher-nya di sebuah gist publik; pemilik gist harus akun yang disebut `grantee_ref` (login GitHub);
//   - `ssh-signature`: `grantee_ref` adalah kunci publik OpenSSH `ssh-ed25519 …`; penyewa menandatangani tantangan dengan kunci privat SSH-nya;
//   - `oauth`: penyedia sendiri yang membuktikan lewat OAuth; SDK hanya membawa bentuknya dan memeriksa subjek yang dikembalikan penyedia terhadap `grantee_ref`.
// Tantangan mengikat `circle`, `grant_id`, `grantee_ref`, dan nonce dari broker, jadi bukti satu grant tidak berlaku untuk grant lain. Modul ini tanpa node:crypto, jadi jalan di browser.
//
// Batas yang diakui: `ssh-signature` adalah tanda tangan ed25519 mentah atas teks tantangan, bukan format SSHSIG dari `ssh-keygen -Y sign`; kunci selain ed25519 belum didukung.
// Bukti `near-gist` butuh jaringan (mengambil gist) dan dipercaya sejauh GitHub; pemeriksaannya disuntik lewat `GistFetcher`.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { base58Decode, base58Encode } from "./base58.js";
import type { AccountId } from "./types.js";

export type GranteeProofErrorCode = "grantee_proof_bad_format" | "grantee_proof_wrong_challenge" | "grantee_proof_bad_signature" | "grantee_proof_owner_mismatch" | "grantee_proof_unverifiable";

export class GranteeProofError extends Error {
  constructor(readonly code: GranteeProofErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GranteeProofError";
  }
}
const fail = (code: GranteeProofErrorCode, message: string): never => {
  throw new GranteeProofError(code, message);
};
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export type GranteeProof =
  | { kind: "near-gist"; gist: string }
  | { kind: "ssh-signature"; signature: string }
  | { kind: "oauth"; provider: string; token: string };

export const MAX_PROOF_BYTES = 2048;

/** Teks bukti yang dikirim ke broker (`proof` di `POST /grants/{id}/access`). */
export function encodeGranteeProof(proof: GranteeProof): string {
  const text = JSON.stringify(proof);
  if (utf8(text).length > MAX_PROOF_BYTES) fail("grantee_proof_bad_format", `proof is larger than ${MAX_PROOF_BYTES} bytes`);
  return text;
}
export function parseGranteeProof(text: string): GranteeProof {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("grantee_proof_bad_format", "proof is not JSON");
  }
  const p = value as Record<string, unknown> | null;
  if (utf8(text).length > MAX_PROOF_BYTES || p === null || typeof p !== "object") return fail("grantee_proof_bad_format", "proof is too large or not an object");
  if (p.kind === "near-gist" && typeof p.gist === "string" && /^[A-Za-z0-9/_.:-]{1,200}$/.test(p.gist)) return { kind: "near-gist", gist: p.gist };
  if (p.kind === "ssh-signature" && typeof p.signature === "string" && /^[A-Za-z0-9+/=]{80,100}$/.test(p.signature)) return { kind: "ssh-signature", signature: p.signature };
  if (p.kind === "oauth" && typeof p.provider === "string" && /^[a-z0-9-]{1,32}$/.test(p.provider) && typeof p.token === "string" && p.token.length >= 1 && p.token.length <= 1024) {
    return { kind: "oauth", provider: p.provider, token: p.token };
  }
  return fail("grantee_proof_bad_format", "unknown kind or invalid field");
}

export type ChallengeInput = { circle: AccountId; grantId: number; granteeRef: string; nonce: string };
/** Tantangan: teks tetap yang mengikat grant, referensi, dan nonce broker. */
export function granteeChallenge(i: ChallengeInput): string {
  if (!Number.isSafeInteger(i.grantId) || i.grantId < 1 || !/^[A-Za-z0-9._-]{8,64}$/.test(i.nonce) || i.granteeRef.length < 1 || i.granteeRef.length > 600 || /[\n\r]/.test(i.granteeRef)) {
    fail("grantee_proof_wrong_challenge", "invalid grantId, nonce, or granteeRef");
  }
  return `x207-grantee-proof v1\ncircle=${i.circle}\ngrant=${i.grantId}\nref=${i.granteeRef}\nnonce=${i.nonce}`;
}

// ---- near-gist: the challenge signed with the voucher key, put in a public gist ----------------------------------------------------------------------------------------

const NEP413_TAG = 2147484061;
const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
const borsh = (text: string): Uint8Array => concatBytes(u32le(utf8(text).length), utf8(text));
const signingHash = (challenge: string, circle: string): Uint8Array => sha256(concatBytes(u32le(NEP413_TAG), borsh(challenge), sha256(utf8(challenge)), borsh(circle), Uint8Array.of(0)));
const ED = "ed25519:";
function seedOf(secretKey: string): Uint8Array {
  const bytes = secretKey.startsWith(ED) ? base58Decode(secretKey.slice(ED.length)) : new Uint8Array();
  if (bytes.length !== 32 && bytes.length !== 64) return fail("grantee_proof_bad_format", "voucher key must be ed25519:<base58> of 32 or 64 bytes");
  return bytes.slice(0, 32);
}

/** Isi gist: JSON `{challenge, account, signature}`; `account` akun NEAR penyewa, tanda tangan dengan kunci voucher-nya (skema NEP-413 yang sama dengan notice). */
export function buildGistContent(challenge: ChallengeInput, account: AccountId, voucherSecretKey: string): string {
  const text = granteeChallenge(challenge);
  return JSON.stringify({ challenge: text, account, signature: `${ED}${base58Encode(ed25519.sign(signingHash(text, challenge.circle), seedOf(voucherSecretKey)))}` });
}

export type GistFetcher = (gist: string) => Promise<{ owner: string; files: readonly string[] }>;
/**
 * Memeriksa bukti `near-gist`: pemilik gist adalah `granteeRef`, salah satu berkas memuat tantangan grant ini, dan tanda tangannya sah untuk `voucherPublicKey` penyewa
 * (kunci voucher yang terdaftar di kontrak). Mengembalikan `true` atau melempar `GranteeProofError`.
 */
export async function verifyNearGistProof(args: { proof: GranteeProof; challenge: ChallengeInput; voucherPublicKey: string; fetchGist: GistFetcher }): Promise<true> {
  const { proof, challenge } = args;
  if (proof.kind !== "near-gist") return fail("grantee_proof_bad_format", "not a near-gist proof");
  const expected = granteeChallenge(challenge);
  let gist: { owner: string; files: readonly string[] };
  try {
    gist = await args.fetchGist(proof.gist);
  } catch (e) {
    return fail("grantee_proof_unverifiable", `gist cannot be fetched: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (gist.owner.toLowerCase() !== challenge.granteeRef.toLowerCase()) return fail("grantee_proof_owner_mismatch", `gist belongs to ${gist.owner}, not ${challenge.granteeRef}`);
  for (const file of gist.files) {
    let data: { challenge?: unknown; signature?: unknown };
    try {
      data = JSON.parse(file) as typeof data;
    } catch {
      continue;
    }
    if (data.challenge !== expected || typeof data.signature !== "string" || !data.signature.startsWith(ED)) continue;
    try {
      const ok = ed25519.verify(base58Decode(data.signature.slice(ED.length)), signingHash(expected, challenge.circle), base58Decode(args.voucherPublicKey.slice(ED.length)));
      if (ok) return true;
    } catch {
      // a malformed signature is just not a proof
    }
    return fail("grantee_proof_bad_signature", "signature in the gist is not valid for the renter voucher key");
  }
  return fail("grantee_proof_wrong_challenge", "no gist file contains this grant challenge");
}

// ---- ssh-signature: the challenge signed with the SSH key that is the grantee_ref ---------------------------------------------------------------------------------------------

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Kunci publik ed25519 dari baris OpenSSH `ssh-ed25519 <base64> [komentar]`. */
export function parseSshEd25519(line: string): Uint8Array {
  const [type, blob] = line.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !blob || !/^[A-Za-z0-9+/=]+$/.test(blob)) return fail("grantee_proof_bad_format", "grantee_ref is not an OpenSSH ssh-ed25519 key");
  const bytes = unb64(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = bytes.length >= 4 ? view.getUint32(0) : 0;
  if (nameLen !== 11 || new TextDecoder().decode(bytes.subarray(4, 15)) !== "ssh-ed25519" || bytes.length !== 4 + 11 + 4 + 32 || view.getUint32(15) !== 32) {
    return fail("grantee_proof_bad_format", "invalid OpenSSH key blob");
  }
  return bytes.slice(19);
}
/** Baris OpenSSH untuk kunci publik 32 byte (untuk pengujian dan untuk penyewa yang membangun `grantee_ref`). */
export function sshEd25519Line(publicKey: Uint8Array, comment = ""): string {
  const blob = concatBytes(Uint8Array.of(0, 0, 0, 11), utf8("ssh-ed25519"), Uint8Array.of(0, 0, 0, 32), publicKey);
  return `ssh-ed25519 ${b64(blob)}${comment ? ` ${comment}` : ""}`;
}
/** Tanda tangan tantangan dengan seed ed25519 kunci SSH (32 byte); hasilnya base64 dari 64 byte. */
export function signSshChallenge(challenge: ChallengeInput, seed: Uint8Array): GranteeProof {
  if (seed.length !== 32) fail("grantee_proof_bad_format", "SSH key seed must be 32 bytes");
  return { kind: "ssh-signature", signature: b64(ed25519.sign(utf8(granteeChallenge(challenge)), seed)) };
}
/** Memeriksa bukti `ssh-signature` terhadap `granteeRef` (baris OpenSSH): benar atau melempar `GranteeProofError`. */
export function verifySshProof(proof: GranteeProof, challenge: ChallengeInput): true {
  if (proof.kind !== "ssh-signature") return fail("grantee_proof_bad_format", "not an ssh-signature proof");
  const key = parseSshEd25519(challenge.granteeRef);
  let ok = false;
  try {
    ok = ed25519.verify(unb64(proof.signature), utf8(granteeChallenge(challenge)), key);
  } catch {
    ok = false;
  }
  return ok ? true : fail("grantee_proof_bad_signature", "signature is not valid for this SSH key");
}

// ---- oauth: the provider says who the token belongs to --------------------------------------------------------------------------------------------------------------------

export type OAuthVerifier = (provider: string, token: string) => Promise<{ subject: string }>;
/** Memeriksa bukti `oauth`: subjek yang dikembalikan penyedia harus `granteeRef`. Tokennya tidak disimpan di sini. */
export async function verifyOAuthProof(proof: GranteeProof, granteeRef: string, verify: OAuthVerifier): Promise<true> {
  if (proof.kind !== "oauth") return fail("grantee_proof_bad_format", "not an oauth proof");
  let subject: string;
  try {
    subject = (await verify(proof.provider, proof.token)).subject;
  } catch (e) {
    return fail("grantee_proof_unverifiable", `provider cannot check the token: ${e instanceof Error ? e.message : String(e)}`);
  }
  return subject === granteeRef ? true : fail("grantee_proof_owner_mismatch", `token belongs to ${subject}, not ${granteeRef}`);
}
