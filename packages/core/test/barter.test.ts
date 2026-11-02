import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BarterFormatError, base58Encode, bundleInput, contractErrorCode, bundleFullySigned, bundleParticipants, intentHash, intentHashBase58, serializeBundleTerms, serializeIntent,
  signBundle, signIntent, termsHash, verifyBundleSignature, verifyIntentSignature, voucherPublicKey,
  type BarterIntent, type BundleTerms,
} from "@x207/core";

const vector = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/test-vectors/barter/${name}.json`, import.meta.url)), "utf8"));
const keys = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/test-vectors/keys.json", import.meta.url)), "utf8")).keys;
const seed = (k: string) => Buffer.from(keys[k].seed, "hex");
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest();
const A = "translator.x207-circle.near";
const B = "summarizer.x207-circle.near";
const C = "scraper.x207-circle.near";

/** NEP-413 dibangun tangan, terpisah dari kode produk. */
function nep413(message: string, nonce: Buffer, recipient: string): Buffer {
  const str = (s: string) => Buffer.concat([Buffer.from(new Uint32Array([Buffer.byteLength(s)]).buffer), Buffer.from(s)]);
  return sha256(Buffer.concat([Buffer.from([0x9d, 0x01, 0x00, 0x80]), str(message), nonce, str(recipient), Buffer.from([0])]));
}

describe("SD-047 intent barter dan bundle", () => {
  const intentVector = vector("intent");
  const bundleVector = vector("bundle_abca");

  it("intent: JSON kanonik, hash heks dan base58, tanda tangan cocok dengan vector", () => {
    const intent = intentVector.intent as BarterIntent;
    expect(serializeIntent(intent)).toBe(intentVector.message);
    expect(intentVector.message).toBe(
      '{"circle":"x207-circle.near","account":"translator.x207-circle.near","offer":{"service":"translate","calls":50,"value":"1000000"},"need":{"service":"summarize","calls":50,"value":"1000000"},"expiresAt":1793600000,"nonce":"n1"}',
    );
    expect(intentHash(intent)).toBe(intentVector.intentHash);
    expect(intentHash(intent)).toBe(sha256(intentVector.message).toString("hex"));
    expect(intentHashBase58(intent)).toBe(base58Encode(sha256(intentVector.message)));
    expect(signIntent(intent, seed("kA"))).toBe(intentVector.signature);
    expect(verifyIntentSignature(intent, intentVector.signature, intentVector.pubkey)).toBe(true);
    expect(verifyIntentSignature({ ...intent, nonce: "n2" }, intentVector.signature, intentVector.pubkey)).toBe(false);
  });

  it("bundle A->B->C->A: terms_hash deterministik dan tidak bergantung urutan leg", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(serializeBundleTerms(terms)).toBe(bundleVector.message);
    expect(termsHash(terms)).toBe(bundleVector.termsHash);
    expect(termsHash(terms)).toBe(sha256(bundleVector.message).toString("hex"));
    expect(termsHash({ ...terms, legs: [...terms.legs].reverse() })).toBe(bundleVector.termsHash);
    const legs = JSON.parse(bundleVector.message).legs as Array<{ payer: string }>;
    expect(legs.map((l) => l.payer)).toEqual([C, A, B].sort());
  });

  it("tanda tangan ketiga peserta cocok dengan vector dan hash penandatanganan NEP-413 independen", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(bundleVector.signingHash).toBe(nep413(bundleVector.message, sha256(bundleVector.message), terms.circle).toString("hex"));
    for (const [account, k] of [[A, "kA"], [B, "kB"], [C, "kC"]] as const) {
      const signature = signBundle(terms, account, seed(k));
      expect(signature).toEqual(bundleVector.signatures.find((s: { account: string }) => s.account === account));
      expect(verifyBundleSignature(terms, signature.signature, voucherPublicKey(seed(k)))).toBe(true);
      expect(verifyBundleSignature(terms, signature.signature, voucherPublicKey(seed("kZ")))).toBe(false);
    }
  });

  it("bundle sah hanya bila semua peserta menandatangani; ubah satu leg membatalkan tanda tangan", () => {
    const terms = bundleVector.terms as BundleTerms;
    const pubkeys = bundleVector.participants as Record<string, string>;
    expect(bundleParticipants(terms)).toEqual([C, B, A].sort());
    expect(bundleFullySigned(terms, bundleVector.signatures, pubkeys)).toBe(true);
    expect(bundleFullySigned(terms, bundleVector.signatures.slice(0, 2), pubkeys)).toBe(false);
    const changed: BundleTerms = { ...terms, legs: terms.legs.map((l, i) => (i === 0 ? { ...l, max_amount: "6000001" } : l)) };
    expect(termsHash(changed)).not.toBe(bundleVector.termsHash);
    expect(bundleFullySigned(changed, bundleVector.signatures, pubkeys)).toBe(false);
  });

  it("search_leg (interface 0.0.5): kunci terakhir di JSON kanonik, hash cocok dengan vector, bundle tanpa search_leg tidak berubah", () => {
    const searchVector = vector("bundle_search");
    const terms = searchVector.terms as BundleTerms;
    expect(serializeBundleTerms(terms)).toBe(searchVector.message);
    expect(Object.keys(JSON.parse(searchVector.message))).toEqual(["circle", "epoch", "legs", "search_leg"]);
    expect(Object.keys(JSON.parse(searchVector.message).search_leg)).toEqual(["payer", "payee"]);
    expect(termsHash(terms)).toBe(searchVector.termsHash);
    expect(termsHash(terms)).toBe(sha256(searchVector.message).toString("hex"));
    expect(termsHash(terms)).not.toBe(termsHash({ ...terms, search_leg: undefined }));
    expect(searchVector.signingHash).toBe(nep413(searchVector.message, sha256(searchVector.message), terms.circle).toString("hex"));
    for (const [account, k] of [[A, "kA"], [B, "kB"], [C, "kC"]] as const) {
      expect(signBundle(terms, account, seed(k))).toEqual(searchVector.signatures.find((s: { account: string }) => s.account === account));
    }
    const pubkeys = searchVector.participants as Record<string, string>;
    expect(bundleFullySigned(terms, searchVector.signatures, pubkeys)).toBe(true);
    // search_leg diubah atau dibuang: tanda tangan lama tidak berlaku
    expect(bundleFullySigned({ ...terms, search_leg: { payer: A, payee: B } }, searchVector.signatures, pubkeys)).toBe(false);
    expect(bundleFullySigned({ ...terms, search_leg: undefined }, searchVector.signatures, pubkeys)).toBe(false);
    // tanpa search_leg (kosong, undefined atau null) bytes sama dengan vector lama
    const old = bundleVector.terms as BundleTerms;
    expect(serializeBundleTerms({ ...old, search_leg: undefined })).toBe(bundleVector.message);
    expect(serializeBundleTerms({ ...old, search_leg: null })).toBe(bundleVector.message);
    expect(termsHash({ ...old, search_leg: null })).toBe(bundleVector.termsHash);
  });

  it("bundleInput: argumen commit_bundle memuat search_leg hanya bila ada", () => {
    const searched = vector("bundle_search").terms as BundleTerms;
    expect(bundleInput(searched)).toEqual({ epoch: 42, legs: searched.legs, search_leg: searched.search_leg });
    const old = bundleVector.terms as BundleTerms;
    expect(Object.keys(bundleInput({ ...old, search_leg: null }))).toEqual(["epoch", "legs"]);
  });

  it("search_leg harus salah satu leg dan berisi akun sah", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: A, payee: C } })).toThrow(BarterFormatError); // A -> C bukan leg
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: "BUKAN AKUN", payee: A } })).toThrow(/search_leg/);
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: C } as never })).toThrow(/search_leg/);
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: C, payee: A } })).not.toThrow();
  });

  it("menolak bentuk tidak sah", () => {
    const terms = bundleVector.terms as BundleTerms;
    const intent = intentVector.intent as BarterIntent;
    expect(() => serializeBundleTerms({ ...terms, legs: [terms.legs[0]!] })).toThrow(BarterFormatError);
    expect(() => serializeBundleTerms({ ...terms, legs: [terms.legs[0]!, { ...terms.legs[0]! }] })).toThrow(/dua kali/);
    expect(() => serializeBundleTerms({ ...terms, legs: [{ payer: A, payee: A, max_amount: "1" }, terms.legs[1]!] })).toThrow(/diri sendiri/);
    expect(() => serializeBundleTerms({ ...terms, legs: terms.legs.map((l) => ({ ...l, max_amount: "007" })) })).toThrow(/max_amount/);
    expect(() => serializeBundleTerms({ ...terms, epoch: 0 })).toThrow(/epoch/);
    expect(() => serializeIntent({ ...intent, offer: { ...intent.offer, calls: 0 } })).toThrow(/calls/);
    expect(() => serializeIntent({ ...intent, need: { ...intent.need, service: "Translate!" } })).toThrow(/service/);
    expect(() => serializeIntent({ ...intent, offer: { ...intent.offer, value: "340282366920938463463374607431768211456" } })).toThrow(/value/);
    expect(() => serializeIntent({ ...intent, nonce: "bad nonce" })).toThrow(/nonce/);
  });

  it("kode error bundle dari kontrak sampai apa adanya ke pemanggil", () => {
    for (const code of ["ERR_BUNDLE_EXISTS", "ERR_BUNDLE_SIGNATURES", "ERR_BUNDLE_HEADROOM"]) {
      const error = new Error(`Smart contract panicked: ${code}: terms_hash ${bundleVector.termsHash}`);
      expect(contractErrorCode(error)).toBe(code);
      expect(error.message).toContain(bundleVector.termsHash);
    }
  });

  it("syarat identik menghasilkan terms_hash sama (kontrak menolak yang kedua dengan ERR_BUNDLE_EXISTS); ganti epoch mengubah hash", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(termsHash({ ...terms })).toBe(termsHash(terms));
    expect(termsHash({ ...terms, epoch: terms.epoch + 1 })).not.toBe(termsHash(terms));
  });
});
