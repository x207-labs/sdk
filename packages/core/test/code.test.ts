import { describe, expect, it } from "vitest";
import {
  CODE_RESOURCE_PREFIX, CodeError, UNVERIFIABLE_CODE_LIMIT, checkCheatProof, checkCodeDocument, codeDocumentHash, codeHash, codeNeedsBond, codeResource, contentHash, createCodeRelease,
  encryptCode, generateVoucherKeypair, licensePublicKey, makeCodeCheatProof, normalizeCode, parseCodeResource, serializeCode, verifyCodeDelivery, encryptContent, createRelease,
  type CodeDocument, type CodeIssuer,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const SELLER = "seller.x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const seller = generateVoucherKeypair();
const buyer = generateVoucherKeypair();
const CODE = "GIFT-7QK2-M9XD-41LP";
const text = (s: string) => new TextEncoder().encode(s);
const errCode = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof CodeError ? e.code : `other: ${String(e)}`;
  }
};
const doc = (over: Partial<CodeDocument> = {}): CodeDocument => ({ circle: CIRCLE, seller: SELLER, code_hash: codeHash(CODE), issuer: "shop.example", value: "5000000", verifiable: false, arbiter: null, nonce: "n1", ...over });
const sellerPublic = licensePublicKey(seller.secretKey);
const buyerPublic = licensePublicKey(buyer.secretKey);
const sell = (d: CodeDocument = doc(), code = CODE) => {
  const enc = encryptCode(code);
  const { release, signature } = createCodeRelease({ doc: d, code, buyer: BUYER, buyerPublicKey: buyerPublic, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey });
  return { enc, release, signature };
};

describe("SD-076 code_hash and document", () => {
  it("TC-SD-076-01 code_hash is the SD-070 contentHash of the UTF-8 bytes, and the same code gives the same hash", () => {
    expect(codeHash(CODE)).toBe(contentHash(text(CODE)));
    expect(codeHash(CODE)).toBe(codeHash(CODE));
    expect(codeHash(CODE)).not.toBe(codeHash(`${CODE}X`));
    expect(codeHash(CODE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TC-SD-076-02 a code that is too short, too long, padded or with control characters is refused", () => {
    expect(errCode(() => codeHash("1234567"))).toBe("code_bad_code");
    expect(errCode(() => codeHash("a".repeat(1025)))).toBe("code_bad_code");
    expect(errCode(() => codeHash(" GIFT-7QK2-M9XD"))).toBe("code_bad_code");
    expect(errCode(() => codeHash("GIFT-7QK2\n-M9XD"))).toBe("code_bad_code");
    expect(codeHash("12345678")).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash("a".repeat(1024))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TC-SD-076-03 the canonical JSON has a fixed key order, a missing arbiter is null, and the hash is stable", () => {
    const d = doc();
    expect(serializeCode(d)).toBe(`{"circle":"${CIRCLE}","seller":"${SELLER}","code_hash":"${codeHash(CODE)}","issuer":"shop.example","value":"5000000","verifiable":false,"arbiter":null,"nonce":"n1"}`);
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
    expect(errCode(() => normalizeCode(doc({ code_hash: "ABC" })))).toBe("code_bad_hash");
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
    const enc = encryptCode(CODE);
    const base = { buyer: BUYER, buyerPublicKey: buyerPublic, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey };
    expect(errCode(() => createCodeRelease({ ...base, doc: doc({ value: "99000000" }), code: CODE }))).toBe("code_over_limit_unbonded");
    expect(errCode(() => createCodeRelease({ ...base, doc: doc(), code: "OTHER-CODE-123" }))).toBe("code_bad_hash");
  });
});

describe("SD-076 delivery and proof of cheating reuse SD-070", () => {
  it("TC-SD-076-10 a right code is delivered, opened by the buyer, and gives no proof", () => {
    const { enc, release, signature } = sell();
    expect(release.content_hash).toBe(codeHash(CODE));
    expect(release.content_size).toBe(text(CODE).length);
    const verdict = verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, purchaseId: "p1", doc: doc() });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.code).toBe(CODE);
    expect(() => makeCodeCheatProof({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey })).toThrow(/proof_not_possible/);
  });

  it("TC-SD-076-11 a wrong code under the listed code_hash gives a proof that anyone can check", () => {
    const d = doc();
    const wrong = "WRONG-CODE-0000-AAAA";
    const enc = encryptContent(text(wrong));
    const { release, signature } = createRelease({ circle: CIRCLE, license_hash: codeDocumentHash(d), buyer: BUYER, buyerPublicKey: buyerPublic, content_hash: d.code_hash, content_size: text(wrong).length, purchase_id: "p1", ciphertext: enc.ciphertext, contentKey: enc.key, at: 1_700_000_000, sellerSecretKey: seller.secretKey });
    const verdict = verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, doc: d });
    expect(verdict.ok).toBe(false);
    const proof = makeCodeCheatProof({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey });
    expect(checkCheatProof(proof, sellerPublic, "p1")).toEqual({ valid: true, reason: "content_mismatch" });
    expect(checkCheatProof(proof, licensePublicKey(buyer.secretKey))).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("TC-SD-076-12 a release that belongs to another document, another code_hash or another circle is not accepted for this listing", () => {
    const { enc, release, signature } = sell();
    const args = { ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey };
    expect(verifyCodeDelivery({ ...args, doc: doc({ nonce: "n2" }) })).toEqual({ ok: false, reason: "wrong_purchase" });
    expect(verifyCodeDelivery({ ...args, doc: doc({ circle: "other-circle.near" }) })).toEqual({ ok: false, reason: "wrong_purchase" });
    expect(verifyCodeDelivery({ ...args, doc: doc({ code_hash: codeHash("ANOTHER-CODE-0001") }) })).toEqual({ ok: false, reason: "wrong_purchase" });
  });

  it("TC-SD-076-13 a wrong ciphertext is a wrong source, not a proof; a delivery for another purchase is refused", () => {
    const { enc, release, signature } = sell();
    const other = encryptCode("ZZZZ-9999-YYYY");
    expect(verifyCodeDelivery({ ciphertext: other.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey })).toEqual({ ok: false, reason: "cipher_hash_mismatch" });
    expect(verifyCodeDelivery({ ciphertext: enc.ciphertext, release, signature, sellerPublicKey: sellerPublic, buyerSecretKey: buyer.secretKey, purchaseId: "p2" })).toEqual({ ok: false, reason: "wrong_purchase" });
  });
});

describe("SD-076 vectors", () => {
  it("TC-SD-076-14 fixed vector: the hash of the document and of the code do not change", () => {
    const d = doc();
    expect(codeHash(CODE)).toBe(contentHash(text(CODE)));
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
