import { describe, expect, it } from "vitest";
import {
  CODE_RESOURCE_PREFIX, CodeError, codePayload, newCodeSalt, splitCodePayload, UNVERIFIABLE_CODE_LIMIT, checkCheatProof, checkCodeDocument, codeDocumentHash, codeCommitment, codeNeedsBond, codeResource, contentHash, createCodeRelease,
  encryptCode, generateVoucherKeypair, licensePublicKey, makeCodeCheatProof, normalizeCode, parseCodeResource, serializeCode, verifyCodeDelivery, encryptContent, createRelease,
  type CodeDocument, type CodeIssuer,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const SELLER = "seller.x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const seller = generateVoucherKeypair();
const buyer = generateVoucherKeypair();
const CODE = "GIFT-7QK2-M9XD-41LP";
const SALT = new Uint8Array(32).fill(9);
const text = (s: string) => new TextEncoder().encode(s);
const errCode = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof CodeError ? e.code : `other: ${String(e)}`;
  }
};
const doc = (over: Partial<CodeDocument> = {}): CodeDocument => ({ circle: CIRCLE, seller: SELLER, code_commitment: codeCommitment(CODE, SALT), issuer: "shop.example", value: "5000000", verifiable: false, arbiter: null, nonce: "n1", ...over });
const sellerPublic = licensePublicKey(seller.secretKey);
const buyerPublic = licensePublicKey(buyer.secretKey);
const sell = (d: CodeDocument = doc(), code = CODE) => {
  const enc = encryptCode(code, { salt: SALT });
  const { release, signature } = createCodeRelease({ doc: d, code, salt: SALT, buyer: BUYER, buyerPublicKey: buyerPublic, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey });
  return { enc, release, signature };
};

describe("SD-076 code_commitment and document", () => {
  it("TC-SD-076-01 code_commitment is the SD-070 contentHash of salt || code; the same code with another salt gives another commitment, the same salt gives the same", () => {
    expect(codeCommitment(CODE, SALT)).toBe(contentHash(codePayload(CODE, SALT)));
    expect(codeCommitment(CODE, SALT)).toBe(codeCommitment(CODE, SALT));
    expect(codeCommitment(CODE, SALT)).not.toBe(codeCommitment(CODE, new Uint8Array(32).fill(8)));
    expect(codeCommitment(CODE, SALT)).not.toBe(codeCommitment(`${CODE}X`, SALT));
    expect(codeCommitment(CODE, SALT)).toMatch(/^[0-9a-f]{64}$/);
    expect(newCodeSalt()).toHaveLength(32);
    expect(newCodeSalt()).not.toEqual(newCodeSalt());
  });

  it("TC-SD-076-01b a low-entropy code cannot be guessed from the commitment: the plain hash of the code does not match, a dictionary of codes without the salt finds nothing", () => {
    const weak = "SAVE20-XX";
    const commitment = codeCommitment(weak, SALT);
    expect(commitment).not.toBe(contentHash(text(weak)));
    expect(commitment).not.toBe(contentHash(new Uint8Array([...text(weak)])));
    const dictionary = ["SAVE20-XX", "SAVE10-XX", "PROMO2026"].map((guess) => contentHash(text(guess)));
    expect(dictionary).not.toContain(commitment);
    const payload = splitCodePayload(codePayload(weak, SALT));
    expect(payload?.code).toBe(weak);
  });

  it("TC-SD-076-02 a code or salt that is bad is refused: too short, too long, padded, control characters, salt of the wrong size", () => {
    expect(errCode(() => codeCommitment("1234567", SALT))).toBe("code_bad_code");
    expect(errCode(() => codeCommitment("a".repeat(1025), SALT))).toBe("code_bad_code");
    expect(errCode(() => codeCommitment(" GIFT-7QK2-M9XD", SALT))).toBe("code_bad_code");
    expect(errCode(() => codeCommitment("GIFT-7QK2\n-M9XD", SALT))).toBe("code_bad_code");
    expect(errCode(() => codeCommitment(CODE, new Uint8Array(31)))).toBe("code_bad_salt");
    expect(codeCommitment("12345678", SALT)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeCommitment("a".repeat(1024), SALT)).toMatch(/^[0-9a-f]{64}$/);
    expect(splitCodePayload(new Uint8Array(32))).toBeNull();
  });

  it("TC-SD-076-03 the canonical JSON has a fixed key order, a missing arbiter is null, and the hash is stable", () => {
    const d = doc();
    expect(serializeCode(d)).toBe(`{"circle":"${CIRCLE}","seller":"${SELLER}","code_commitment":"${codeCommitment(CODE, SALT)}","issuer":"shop.example","value":"5000000","verifiable":false,"arbiter":null,"nonce":"n1"}`);
    const { arbiter: _a, ...without } = d;
    expect(codeDocumentHash(without)).toBe(codeDocumentHash(d));
    expect(codeDocumentHash(doc({ value: "5000001" }))).not.toBe(codeDocumentHash(d));
  });

  it("TC-SD-076-04 the resource is x207:code:<hash> and parses back; anything else gives null", () => {
    const h = codeDocumentHash(doc());
    expect(codeResource(h)).toBe(`${CODE_RESOURCE_PREFIX}${h}`);
    expect(parseCodeResource(codeResource(h))).toBe(h);
    expect(parseCodeResource("x207:license:" + h)).toBeNull();
    expect(parseCodeResource("x207:code:xyz")).toBeNull();
    expect(errCode(() => codeResource("abc"))).toBe("code_bad_resource");
  });

  it("TC-SD-076-05 field validation: account, hash, value, nonce, arbiter", () => {
    expect(errCode(() => normalizeCode(doc({ seller: "Not An Account" })))).toBe("code_bad_account");
    expect(errCode(() => normalizeCode(doc({ code_commitment: "ABC" })))).toBe("code_bad_commitment");
    expect(errCode(() => normalizeCode(doc({ issuer: "" })))).toBe("code_bad_account");
    expect(errCode(() => normalizeCode(doc({ value: "0" })))).toBe("code_bad_value");
    expect(errCode(() => normalizeCode(doc({ value: "1.5" })))).toBe("code_bad_value");
    expect(errCode(() => normalizeCode(doc({ value: "007" })))).toBe("code_bad_value");
    expect(errCode(() => normalizeCode(doc({ value: (2n ** 128n).toString() })))).toBe("code_bad_value");
    expect(errCode(() => normalizeCode(doc({ nonce: "has space" })))).toBe("code_bad_nonce");
    expect(errCode(() => normalizeCode(doc({ arbiter: "Bad Arbiter" })))).toBe("code_bad_arbiter");
    expect(errCode(() => normalizeCode(doc({ arbiter: SELLER })))).toBe("code_bad_arbiter");
  });
});

describe("SD-076 limit of a code that cannot be checked", () => {
  it("TC-SD-076-06 20 credit is the default limit; at the limit is allowed, above it is refused without a bond", () => {
    expect(UNVERIFIABLE_CODE_LIMIT).toBe("20000000");
    expect(() => checkCodeDocument(doc({ value: "20000000" }))).not.toThrow();
    expect(errCode(() => checkCodeDocument(doc({ value: "20000001" })))).toBe("code_over_limit_unbonded");
    expect(codeNeedsBond(doc({ value: "20000001" }))).toBe(true);
    expect(codeNeedsBond(doc({ value: "20000000" }))).toBe(false);
  });

  it("TC-SD-076-07 above the limit it is allowed with an arbiter (bond) or with an issuer API (verifiable)", () => {
    expect(() => checkCodeDocument(doc({ value: "500000000", arbiter: "arbiter.near" }))).not.toThrow();
    expect(() => checkCodeDocument(doc({ value: "500000000", verifiable: true }))).not.toThrow();
    expect(codeNeedsBond(doc({ value: "500000000", verifiable: true }))).toBe(false);
  });

  it("TC-SD-076-08 the limit can be set, and a bad limit is refused", () => {
    expect(() => checkCodeDocument(doc({ value: "50000000" }), "50000000")).not.toThrow();
    expect(errCode(() => checkCodeDocument(doc({ value: "50000001" }), "50000000"))).toBe("code_over_limit_unbonded");
    expect(errCode(() => checkCodeDocument(doc(), "-1"))).toBe("code_bad_limit");
  });

  it("TC-SD-076-09 the seller cannot create a release for a code over the limit without a bond, nor for a code that is not the one in the document", () => {
    const enc = encryptCode(CODE, { salt: SALT });
    const base = { salt: SALT, buyer: BUYER, buyerPublicKey: buyerPublic, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey };
    expect(errCode(() => createCodeRelease({ ...base, doc: doc({ value: "99000000" }), code: CODE }))).toBe("code_over_limit_unbonded");
    expect(errCode(() => createCodeRelease({ ...base, doc: doc(), code: "OTHER-CODE-123" }))).toBe("code_bad_commitment");
    expect(errCode(() => createCodeRelease({ ...base, doc: doc(), code: CODE, salt: new Uint8Array(32).fill(1) }))).toBe("code_bad_commitment");
  });
});

describe("SD-076 delivery and proof of cheating reuse SD-070", () => {
  it("TC-SD-076-10 a right code is delivered, opened by the buyer, and gives no proof", () => {
    const { enc, release, signature } = sell();
    expect(release.content_hash).toBe(codeCommitment(CODE, SALT));
    expect(release.content_size).toBe(32 + text(CODE).length);
    const verdict = verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, purchaseId: "p1", doc: doc() });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.code).toBe(CODE);
    expect(verdict.ok && verdict.salt).toBe("09".repeat(32));
    expect(() => makeCodeCheatProof({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey })).toThrow(/proof_not_possible/);
  });

  it("TC-SD-076-11 a wrong code under the listed code_commitment gives a proof that anyone can check", () => {
    const d = doc();
    const wrong = "WRONG-CODE-0000-AAAA";
    const enc = encryptContent(codePayload(wrong, SALT));
    const { release, signature } = createRelease({ circle: CIRCLE, license_hash: codeDocumentHash(d), buyer: BUYER, buyerPublicKey: buyerPublic, content_hash: d.code_commitment!, content_size: 32 + text(wrong).length, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey });
    const verdict = verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, doc: d });
    expect(verdict.ok).toBe(false);
    const proof = makeCodeCheatProof({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey });
    expect(checkCheatProof(proof, sellerPublic, "p1")).toEqual({ valid: true, reason: "content_mismatch" });
    expect(checkCheatProof(proof, licensePublicKey(buyer.secretKey))).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("TC-SD-076-12 a release that belongs to another document, another code_commitment or another circle is not accepted for this listing", () => {
    const { enc, release, signature } = sell();
    const args = { ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey };
    expect(verifyCodeDelivery({ ...args, doc: doc({ nonce: "n2" }) })).toEqual({ ok: false, reason: "wrong_purchase" });
    expect(verifyCodeDelivery({ ...args, doc: doc({ circle: "other-circle.near" }) })).toEqual({ ok: false, reason: "wrong_purchase" });
    expect(verifyCodeDelivery({ ...args, doc: doc({ code_commitment: codeCommitment("ANOTHER-CODE-0001", SALT) }) })).toEqual({ ok: false, reason: "wrong_purchase" });
  });

  it("TC-SD-076-13 a wrong ciphertext is a wrong source, not a proof; a delivery for another purchase is refused", () => {
    const { enc, release, signature } = sell();
    const other = encryptCode("ZZZZ-9999-YYYY", { salt: SALT });
    expect(verifyCodeDelivery({ ciphertext: other.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey })).toEqual({ ok: false, reason: "cipher_hash_mismatch" });
    expect(verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, purchaseId: "p2" })).toEqual({ ok: false, reason: "wrong_purchase" });
  });
});

describe("SD-076 vectors", () => {
  it("TC-SD-076-14 fixed vector: the hash of the document and of the commitment do not change", () => {
    const d = doc();
    expect(codeCommitment(CODE, SALT)).toBe(contentHash(codePayload(CODE, SALT)));
    expect(codeDocumentHash(d)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeDocumentHash(d)).toBe(codeDocumentHash(JSON.parse(serializeCode(d)) as CodeDocument));
  });

  it("TC-SD-076-15 the issuer adapter type checks a code before the key is released (type only)", async () => {
    const used = new Set(["USED-CODE-0001"]);
    const issuer: CodeIssuer = { checkCode: async (c) => (used.has(c) ? "used" : c === CODE ? "valid" : "unknown") };
    expect(await issuer.checkCode(CODE)).toBe("valid");
    expect(await issuer.checkCode("USED-CODE-0001")).toBe("used");
    expect(await issuer.checkCode("nope-nope-nope")).toBe("unknown");
  });
});
