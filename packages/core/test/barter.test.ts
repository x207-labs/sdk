import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BarterFormatError, MAX_BUNDLE_LEGS, base58Encode, bundleInput, contractErrorCode, bundleFullySigned, bundleParticipants, intentHash, intentHashBase58, serializeBundleTerms, serializeIntent,
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

describe("SD-047 barter intent and bundle", () => {
  const intentVector = vector("intent");
  const bundleVector = vector("bundle_abca");

  it("intent: canonical JSON, hex and base58 hash, signature matches the vector", () => {
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

  it("bundle A->B->C->A: terms_hash is deterministic and does not depend on the leg order", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(serializeBundleTerms(terms)).toBe(bundleVector.message);
    expect(termsHash(terms)).toBe(bundleVector.termsHash);
    expect(termsHash(terms)).toBe(sha256(bundleVector.message).toString("hex"));
    expect(termsHash({ ...terms, legs: [...terms.legs].reverse() })).toBe(bundleVector.termsHash);
    const legs = JSON.parse(bundleVector.message).legs as Array<{ payer: string }>;
    expect(legs.map((l) => l.payer)).toEqual([C, A, B].sort());
  });

  it("the signatures of the three participants match the vector and the independent NEP-413 signing hash", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(bundleVector.signingHash).toBe(nep413(bundleVector.message, sha256(bundleVector.message), terms.circle).toString("hex"));
    for (const [account, k] of [[A, "kA"], [B, "kB"], [C, "kC"]] as const) {
      const signature = signBundle(terms, account, seed(k));
      expect(signature).toEqual(bundleVector.signatures.find((s: { account: string }) => s.account === account));
      expect(verifyBundleSignature(terms, signature.signature, voucherPublicKey(seed(k)))).toBe(true);
      expect(verifyBundleSignature(terms, signature.signature, voucherPublicKey(seed("kZ")))).toBe(false);
    }
  });

  it("a bundle is valid only when every participant signs; changing one leg voids the signature", () => {
    const terms = bundleVector.terms as BundleTerms;
    const pubkeys = bundleVector.participants as Record<string, string>;
    expect(bundleParticipants(terms)).toEqual([C, B, A].sort());
    expect(bundleFullySigned(terms, bundleVector.signatures, pubkeys)).toBe(true);
    expect(bundleFullySigned(terms, bundleVector.signatures.slice(0, 2), pubkeys)).toBe(false);
    const changed: BundleTerms = { ...terms, legs: terms.legs.map((l, i) => (i === 0 ? { ...l, max_amount: "6000001" } : l)) };
    expect(termsHash(changed)).not.toBe(bundleVector.termsHash);
    expect(bundleFullySigned(changed, bundleVector.signatures, pubkeys)).toBe(false);
  });

  it("search_leg (interface 0.0.5): last key in the canonical JSON, hash matches the vector, a bundle without search_leg is unchanged", () => {
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

  it("SD-073 bond terms (interface 0.0.12): arbiter, agreement_hash, confirm_by come after search_leg, confirm_by is a string, hash matches the vector, a bundle without arbiter is unchanged", () => {
    for (const name of ["bundle_deal", "bundle_deal_no_agreement"]) {
      const v = vector(name);
      const terms = v.terms as BundleTerms;
      expect(serializeBundleTerms(terms)).toBe(v.message);
      expect(termsHash(terms)).toBe(v.termsHash);
      expect(termsHash(terms)).toBe(sha256(v.message).toString("hex"));
      expect(v.signingHash).toBe(nep413(v.message, sha256(v.message), terms.circle).toString("hex"));
      for (const [account, k] of [[A, "kA"], [B, "kB"]] as const) expect(signBundle(terms, account, seed(k))).toEqual(v.signatures.find((s: { account: string }) => s.account === account));
      const pubkeys = v.participants as Record<string, string>;
      expect(bundleFullySigned(terms, v.signatures, pubkeys)).toBe(true);
      // any of the three keys changed or dropped: the old signatures are worth nothing
      expect(bundleFullySigned({ ...terms, confirm_by: "1793900000000000001" }, v.signatures, pubkeys)).toBe(false);
      expect(bundleFullySigned({ ...terms, arbiter: "other.x207-circle.near" }, v.signatures, pubkeys)).toBe(false);
      expect(bundleFullySigned({ ...terms, arbiter: undefined, agreement_hash: undefined, confirm_by: undefined }, v.signatures, pubkeys)).toBe(false);
    }
    const withAgreement = vector("bundle_deal");
    expect(Object.keys(JSON.parse(withAgreement.message))).toEqual(["circle", "epoch", "legs", "arbiter", "agreement_hash", "confirm_by"]);
    expect(typeof JSON.parse(withAgreement.message).confirm_by).toBe("string"); // nanoseconds do not fit a JavaScript number
    expect(Object.keys(JSON.parse(vector("bundle_deal_no_agreement").message))).toEqual(["circle", "epoch", "legs", "arbiter", "confirm_by"]);
    // with search_leg too: search_leg first, then the deal keys
    const both = { ...(withAgreement.terms as BundleTerms), search_leg: { payer: B, payee: A } };
    expect(Object.keys(JSON.parse(serializeBundleTerms(both)))).toEqual(["circle", "epoch", "legs", "search_leg", "arbiter", "agreement_hash", "confirm_by"]);
    // the argument of commit_bundle carries the three keys only when there is an arbiter
    expect(bundleInput(withAgreement.terms as BundleTerms)).toMatchObject({ arbiter: C, agreement_hash: "ab".repeat(32), confirm_by: "1793900000000000000" });
    expect(Object.keys(bundleInput(bundleVector.terms as BundleTerms))).toEqual(["epoch", "legs"]);
    expect(Object.keys(bundleInput(vector("bundle_deal_no_agreement").terms as BundleTerms))).toEqual(["epoch", "legs", "arbiter", "confirm_by"]);
    // null is the same as absent
    const old = bundleVector.terms as BundleTerms;
    expect(serializeBundleTerms({ ...old, arbiter: null, agreement_hash: null, confirm_by: null })).toBe(bundleVector.message);
  });

  it("SD-073 invalid bond terms are rejected like the contract: arbiter without confirm_by, agreement_hash without arbiter, bad hash, confirm_by not a decimal string, arbiter is a participant, more than two participants", () => {
    const deal = vector("bundle_deal").terms as BundleTerms;
    const bad = (over: Partial<BundleTerms>) => () => serializeBundleTerms({ ...deal, ...over });
    expect(bad({ confirm_by: undefined })).toThrow(/come together/);
    expect(bad({ arbiter: undefined })).toThrow(/come together/);
    expect(bad({ arbiter: undefined, confirm_by: undefined })).toThrow(/come together/); // agreement_hash alone
    expect(bad({ agreement_hash: "AB".repeat(32) })).toThrow(/agreement_hash/);
    expect(bad({ confirm_by: "0" })).toThrow(/confirm_by/);
    expect(bad({ confirm_by: "18446744073709551616" })).toThrow(/confirm_by/);
    expect(bad({ confirm_by: 1793900000 as unknown as string })).toThrow(/confirm_by/);
    expect(bad({ arbiter: "NOT AN ACCOUNT" })).toThrow(/arbiter is not a NEAR account/);
    expect(bad({ arbiter: A })).toThrow(/ERR_ARBITER_INVALID/);
    expect(() => serializeBundleTerms({ ...(vector("bundle_abca").terms as BundleTerms), arbiter: "arbiter.x207-circle.near", confirm_by: "1793900000000000000" })).toThrow(/two-participant/);
  });

  it("bundleInput: the commit_bundle argument contains search_leg only when present", () => {
    const searched = vector("bundle_search").terms as BundleTerms;
    expect(bundleInput(searched)).toEqual({ epoch: 42, legs: searched.legs, search_leg: searched.search_leg });
    const old = bundleVector.terms as BundleTerms;
    expect(Object.keys(bundleInput({ ...old, search_leg: null }))).toEqual(["epoch", "legs"]);
  });

  it("search_leg must be one of the legs and hold valid accounts", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: A, payee: C } })).toThrow(BarterFormatError); // A -> C bukan leg
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: "NOT AN ACCOUNT", payee: A } })).toThrow(/search_leg/);
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: C } as never })).toThrow(/search_leg/);
    expect(() => serializeBundleTerms({ ...terms, search_leg: { payer: C, payee: A } })).not.toThrow();
  });

  it("rejects an invalid shape", () => {
    const terms = bundleVector.terms as BundleTerms;
    const intent = intentVector.intent as BarterIntent;
    expect(() => serializeBundleTerms({ ...terms, legs: [terms.legs[0]!] })).toThrow(BarterFormatError);
    expect(() => serializeBundleTerms({ ...terms, legs: [terms.legs[0]!, { ...terms.legs[0]! }] })).toThrow(/appears twice/);
    expect(() => serializeBundleTerms({ ...terms, legs: [{ payer: A, payee: A, max_amount: "1" }, terms.legs[1]!] })).toThrow(/pay itself/);
    expect(() => serializeBundleTerms({ ...terms, legs: terms.legs.map((l) => ({ ...l, max_amount: "007" })) })).toThrow(/max_amount/);
    expect(() => serializeBundleTerms({ ...terms, epoch: 0 })).toThrow(/epoch/);
    expect(() => serializeIntent({ ...intent, offer: { ...intent.offer, calls: 0 } })).toThrow(/calls/);
    expect(() => serializeIntent({ ...intent, need: { ...intent.need, service: "Translate!" } })).toThrow(/service/);
    expect(() => serializeIntent({ ...intent, offer: { ...intent.offer, value: "340282366920938463463374607431768211456" } })).toThrow(/value/);
    expect(() => serializeIntent({ ...intent, nonce: "bad nonce" })).toThrow(/nonce/);
  });

  it("the bundle error code from the contract reaches the caller unchanged", () => {
    for (const code of ["ERR_BUNDLE_EXISTS", "ERR_BUNDLE_SIGNATURES", "ERR_BUNDLE_HEADROOM"]) {
      const error = new Error(`Smart contract panicked: ${code}: terms_hash ${bundleVector.termsHash}`);
      expect(contractErrorCode(error)).toBe(code);
      expect(error.message).toContain(bundleVector.termsHash);
    }
  });

  it("identical terms give the same terms_hash (the contract rejects the second with ERR_BUNDLE_EXISTS); changing the epoch changes the hash", () => {
    const terms = bundleVector.terms as BundleTerms;
    expect(termsHash({ ...terms })).toBe(termsHash(terms));
    expect(termsHash({ ...terms, epoch: terms.epoch + 1 })).not.toBe(termsHash(terms));
  });

  it("TC-SD-047-30 interface 0.0.8: a bundle of 64 legs is valid, 65 fails early with a clear message (ERR_BAD_BUNDLE on chain)", () => {
    const legs = (n: number) => Array.from({ length: n }, (_, i) => ({ payer: `p${i}.x207-circle.near`, payee: `p${(i + 1) % n}.x207-circle.near`, max_amount: "1000" }));
    const terms = (n: number): BundleTerms => ({ circle: "x207-circle.near", epoch: 1, legs: legs(n) });
    expect(MAX_BUNDLE_LEGS).toBe(64);
    expect(() => termsHash(terms(64))).not.toThrow();
    expect(() => termsHash(terms(65))).toThrow(/65 leg.*64.*ERR_BAD_BUNDLE/);
    expect(() => signBundle(terms(65), "p0.x207-circle.near", seed("kA"))).toThrow(/ERR_BAD_BUNDLE/);
  });
});
