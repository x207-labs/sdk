import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANARY_PREFIX, CONTENT_CHUNK, ContentHasher, LicenseError, addCanaries, checkCheatProof, contentHash, createRelease, decryptContent, deriveBoxKey, encryptContent, fetchCiphertext,
  findCanaries, generateVoucherKeypair, httpsSource, ipfsSource, licenseDocumentHash, licensePublicKey, licenseResource, makeCheatProof, nep413SigningHash, openSealedKey, parseLicenseResource,
  parseRawCid, rawCidOf, releaseSigningHash, sealKey, serializeLicense, signRelease, stripCanaries, verifyDelivery, verifyRelease, type LicenseDocument, type LicenseRelease,
} from "../src/index.js";

const CIRCLE = "x207-circle.near";
const SELLER = "seller.x207-circle.near";
const BUYER = "buyer.x207-circle.near";
const seller = generateVoucherKeypair();
const buyer = generateVoucherKeypair();
const stranger = generateVoucherKeypair();
const sha = (data: Uint8Array | Buffer) => createHash("sha256").update(data).digest();
const hex = (b: Uint8Array | Buffer) => Buffer.from(b).toString("hex");
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e instanceof LicenseError ? e.code : `other: ${String(e)}`;
  }
};
const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);
const text = (s: string) => new TextEncoder().encode(s);

describe("SD-070 content_hash: one scheme for every size, leaves of 4 MiB", () => {
  const leaf = (chunk: Buffer) => sha(Buffer.concat([Buffer.from([0]), chunk]));
  const node = (l: Buffer, r: Buffer) => sha(Buffer.concat([Buffer.from([1]), l, r]));
  const c = (n: number, f: number) => Buffer.alloc(n, f);

  it("TC-SD-070-01 a short file is one leaf, sha256(0x00 || data), also the empty file and exactly 4 MiB; it is no longer the plain sha256", () => {
    expect(contentHash(text("abc"))).toBe(hex(leaf(Buffer.from("abc"))));
    expect(contentHash(text("abc"))).not.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // the plain sha256 of abc
    expect(contentHash(new Uint8Array())).toBe(hex(leaf(Buffer.alloc(0))));
    expect(contentHash(bytes(CONTENT_CHUNK))).toBe(hex(leaf(c(CONTENT_CHUNK, 7))));
  });

  it("TC-SD-070-02 above 4 MiB it is the Merkle root of the leaves, nodes sha256(0x01 || left || right), split at the largest power of two below", () => {
    const two = Buffer.concat([c(CONTENT_CHUNK, 1), c(1, 2)]);
    expect(contentHash(two)).toBe(hex(node(leaf(c(CONTENT_CHUNK, 1)), leaf(c(1, 2)))));
    const eight = Buffer.concat([c(CONTENT_CHUNK, 1), c(CONTENT_CHUNK, 3)]);
    expect(contentHash(eight)).toBe(hex(node(leaf(c(CONTENT_CHUNK, 1)), leaf(c(CONTENT_CHUNK, 3)))));
    const three = Buffer.concat([c(CONTENT_CHUNK, 1), c(CONTENT_CHUNK, 2), c(5, 3)]);
    expect(contentHash(three)).toBe(hex(node(node(leaf(c(CONTENT_CHUNK, 1)), leaf(c(CONTENT_CHUNK, 2))), leaf(c(5, 3)))));
  });

  it("TC-SD-070-02b [F2] the 65-byte string 0x01 || left || right does not have the hash of the large file it was made from, and a ciphertext of 65 bytes is not a ciphertext of 8 MiB", () => {
    const big = Buffer.concat([c(CONTENT_CHUNK, 1), c(1, 2)]);
    const forged = Buffer.concat([Buffer.from([1]), leaf(c(CONTENT_CHUNK, 1)), leaf(c(1, 2))]);
    expect(forged.length).toBe(65);
    expect(contentHash(forged)).not.toBe(contentHash(big));
  });

  it("TC-SD-070-03 the incremental hasher gives the same hash for any way of cutting the input", () => {
    const data = new Uint8Array(CONTENT_CHUNK * 2 + 123).map((_, i) => (i * 31) % 251);
    const whole = contentHash(data);
    const h = new ContentHasher();
    for (let at = 0; at < data.length; ) {
      const step = Math.min(1_000_003 + (at % 7), data.length - at);
      h.update(data.subarray(at, at + step));
      at += step;
    }
    expect(h.size).toBe(data.length);
    expect(h.digest()).toBe(whole);
    expect(new ContentHasher().update(data.subarray(0, 10)).update(data.subarray(10, 20)).digest()).toBe(contentHash(data.subarray(0, 20)));
  });
});

describe("SD-070 license document and resource", () => {
  const doc: LicenseDocument = { circle: CIRCLE, seller: SELLER, content_hash: "a".repeat(64), license_id: "commercial", license_hash: "b".repeat(64), preview_hash: null, exclusive: false, nonce: "n1" };
  it("TC-SD-070-04 canonical JSON, sha256 of it, resource x207:license:<hash>, and the checks of every field", () => {
    const expected = `{"circle":"x207-circle.near","seller":"seller.x207-circle.near","content_hash":"${"a".repeat(64)}","license_id":"commercial","license_hash":"${"b".repeat(64)}","preview_hash":null,"exclusive":false,"nonce":"n1"}`;
    expect(serializeLicense(doc)).toBe(expected);
    expect(licenseDocumentHash(doc)).toBe(hex(sha(Buffer.from(expected))));
    expect(licenseDocumentHash({ ...doc, exclusive: true })).not.toBe(licenseDocumentHash(doc));
    const h = licenseDocumentHash(doc);
    expect(licenseResource(h)).toBe(`x207:license:${h}`);
    expect(parseLicenseResource(`x207:license:${h}`)).toBe(h);
    expect(parseLicenseResource(`x207:order:${h}`)).toBeNull();
    expect(code(() => licenseResource("x"))).toBe("license_bad_resource");
    expect(code(() => licenseDocumentHash({ ...doc, seller: "Bad" }))).toBe("license_bad_account");
    expect(code(() => licenseDocumentHash({ ...doc, content_hash: "zz" }))).toBe("license_bad_hash");
    expect(code(() => licenseDocumentHash({ ...doc, preview_hash: "zz" }))).toBe("license_bad_hash");
    expect(code(() => licenseDocumentHash({ ...doc, license_id: "Commercial License" }))).toBe("license_bad_license_id");
    expect(code(() => licenseDocumentHash({ ...doc, nonce: "" }))).toBe("license_bad_nonce");
  });
});

describe("SD-070 XChaCha20-Poly1305 per chunk", () => {
  it("TC-SD-070-05 round trip for the empty file, a small file and a file of three chunks; the ciphertext is the header, the chunks and a tag each", () => {
    for (const size of [0, 1, 1000, CONTENT_CHUNK, CONTENT_CHUNK + 1, CONTENT_CHUNK * 2 + 17]) {
      const plain = new Uint8Array(size).map((_, i) => (i * 7) % 256);
      const { ciphertext, key } = encryptContent(plain);
      const chunks = Math.max(1, Math.ceil(size / CONTENT_CHUNK));
      expect(ciphertext.length, String(size)).toBe(24 + size + 16 * chunks);
      expect(Buffer.from(decryptContent(ciphertext, key)).equals(Buffer.from(plain)), String(size)).toBe(true);
    }
  });

  it("TC-SD-070-06 a wrong key, a changed byte, a cut end, an appended chunk, swapped chunks and another format are all refused", () => {
    const plain = bytes(CONTENT_CHUNK * 2 + 10);
    const { ciphertext, key } = encryptContent(plain);
    expect(code(() => decryptContent(ciphertext, bytes(32, 9)))).toBe("cipher_bad_format");
    const flipped = ciphertext.slice();
    flipped[100] = flipped[100]! ^ 1;
    expect(code(() => decryptContent(flipped, key))).toBe("cipher_bad_format");
    expect(code(() => decryptContent(ciphertext.subarray(0, ciphertext.length - 1), key))).toBe("cipher_bad_format");
    const full = CONTENT_CHUNK + 16;
    // cut after the second chunk: the end looks complete but the last chunk was not marked final
    expect(code(() => decryptContent(ciphertext.subarray(0, 24 + 2 * full), key))).toBe("cipher_bad_format");
    // swap the first two chunks
    const swapped = Buffer.concat([ciphertext.subarray(0, 24), ciphertext.subarray(24 + full, 24 + 2 * full), ciphertext.subarray(24, 24 + full), ciphertext.subarray(24 + 2 * full)]);
    expect(code(() => decryptContent(swapped, key))).toBe("cipher_bad_format");
    expect(code(() => decryptContent(text("not a ciphertext at all, really not"), key))).toBe("cipher_bad_format");
    expect(code(() => encryptContent(plain, { key: bytes(31) }))).toBe("license_bad_key");
  });

  it("TC-SD-070-07 with a given key and prefix the ciphertext is the same every time (the vector for other implementations)", () => {
    const a = encryptContent(text("hello license"), { key: bytes(32, 1), prefix: bytes(16, 2) });
    const b = encryptContent(text("hello license"), { key: bytes(32, 1), prefix: bytes(16, 2) });
    expect(hex(a.ciphertext)).toBe(hex(b.ciphertext));
    expect(hex(a.ciphertext.subarray(0, 24))).toBe(`${hex(text("X207ENC1"))}${"02".repeat(16)}`);
    expect(encryptContent(text("hello license"), { key: bytes(32, 1) }).ciphertext.length).toBe(a.ciphertext.length);
  });
});

describe("SD-070 key sealed to the buyer", () => {
  it("TC-SD-070-08 only the buyer opens the sealed key; the key of the voucher turns into an x25519 key; a fixed ephemeral key gives a fixed result", () => {
    const key = bytes(32, 5);
    const sealed = sealKey(key, buyer.publicKey);
    expect(sealed.length).toBe(80);
    expect(Buffer.from(openSealedKey(sealed, buyer.secretKey)).equals(Buffer.from(key))).toBe(true);
    expect(code(() => openSealedKey(sealed, stranger.secretKey))).toBe("release_bad_key");
    expect(licensePublicKey(buyer.secretKey)).toBe(buyer.publicKey);
    const fixed = bytes(32, 3);
    expect(hex(sealKey(key, buyer.publicKey, fixed))).toBe(hex(sealKey(key, buyer.publicKey, fixed)));
    expect(hex(sealKey(key, buyer.publicKey))).not.toBe(hex(sealKey(key, buyer.publicKey)));
    expect(code(() => sealKey(bytes(31), buyer.publicKey))).toBe("license_bad_key");
    expect(code(() => sealKey(key, "nope"))).toBe("license_bad_key");
    expect(hex(deriveBoxKey(sealed, buyer.secretKey))).toHaveLength(64);
  });
});

describe("SD-070 release signed by the seller", () => {
  const plain = text("name,email\nann,ann@example.com\n");
  const content_hash = contentHash(plain);
  const make = (overrides: Partial<Parameters<typeof createRelease>[0]> = {}, data = plain, claimed = content_hash, size = data.length) => {
    const { ciphertext, key } = encryptContent(data);
    const { release, signature } = createRelease({
      circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash: claimed, content_size: size, ciphertext, contentKey: key, at: 1_800_000_000, sellerSecretKey: seller.secretKey, ...overrides,
    });
    return { ciphertext, key, release, signature };
  };

  it("TC-SD-070-09 the signing hash equals the NEP-413 hash of core, a signature verifies for the seller only, and any changed field breaks it", () => {
    const { release, signature } = make();
    const message = JSON.stringify({ circle: release.circle, license_hash: release.license_hash, buyer: release.buyer, content_hash: release.content_hash, cipher_hash: release.cipher_hash, sealed_key: release.sealed_key, at: release.at, content_size: release.content_size, cipher_size: release.cipher_size });
    expect(hex(releaseSigningHash(release))).toBe(hex(nep413SigningHash(message, sha(Buffer.from(message)), CIRCLE)));
    expect(verifyRelease(release, signature, seller.publicKey)).toBe(true);
    expect(verifyRelease(release, signature, stranger.publicKey)).toBe(false);
    for (const change of [{ buyer: "other.x207-circle.near" }, { content_hash: "d".repeat(64) }, { cipher_hash: "d".repeat(64) }, { at: 1 }, { content_size: 1 }, { cipher_size: 1 }] as Array<Partial<LicenseRelease>>) {
      expect(verifyRelease({ ...release, ...change }, signature, seller.publicKey), JSON.stringify(change)).toBe(false);
    }
    expect(verifyRelease(release, "ed25519:xx", seller.publicKey)).toBe(false);
    expect(signRelease(release, seller.secretKey)).toBe(signature); // ed25519 is deterministic
  });

  it("TC-SD-070-10 a right delivery is confirmed with the plain file, and a wrong source (cipher_hash), a signature of another key or an unopenable key give no proof", () => {
    const { ciphertext, release, signature } = make();
    const ok = verifyDelivery({ ciphertext, release, signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(ok.ok).toBe(true);
    expect(ok.ok && Buffer.from(ok.content).equals(Buffer.from(plain))).toBe(true);
    const damaged = ciphertext.slice();
    damaged[40] = damaged[40]! ^ 1;
    expect(verifyDelivery({ ciphertext: damaged, release, signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey })).toEqual({ ok: false, reason: "cipher_hash_mismatch" });
    expect(verifyDelivery({ ciphertext, release, signature, sellerPublicKey: stranger.publicKey, buyerSecretKey: buyer.secretKey })).toEqual({ ok: false, reason: "bad_signature" });
    // the seller seals the key to somebody else: the buyer cannot open it, and that cannot be proven
    const wrong = make({ buyerPublicKey: stranger.publicKey });
    const v = verifyDelivery({ ciphertext: wrong.ciphertext, release: wrong.release, signature: wrong.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(v).toEqual({ ok: false, reason: "sealed_key_unopenable" });
    expect(code(() => makeCheatProof({ ciphertext: wrong.ciphertext, release: wrong.release, signature: wrong.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey }))).toBe("proof_not_possible");
  });

  it("TC-SD-070-11 a file that is not the one in the listing gives a proof that any checker accepts, with the public key of the seller only", () => {
    const other = make({}, text("a different file"), content_hash);
    const proof = makeCheatProof({ ciphertext: other.ciphertext, release: other.release, signature: other.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(checkCheatProof(proof, seller.publicKey)).toEqual({ valid: true, reason: "content_mismatch" });
    // the checker does not have the secret key of the buyer: the proof carries the box key, not the key of the buyer
    expect(JSON.stringify(proof)).not.toContain(buyer.secretKey);
    expect(checkCheatProof(proof, stranger.publicKey)).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("TC-SD-070-12 a key that does not decrypt what the seller posted is cheating too (decrypt_failed)", () => {
    const first = make();
    const second = make({}, plain);
    // release of the second ciphertext's hash with the key of the first: sign a release that mixes them
    const mixed = createRelease({ circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash, content_size: plain.length, ciphertext: second.ciphertext, contentKey: first.key, at: 1_800_000_000, sellerSecretKey: seller.secretKey });
    const proof = makeCheatProof({ ciphertext: second.ciphertext, release: mixed.release, signature: mixed.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(checkCheatProof(proof, seller.publicKey)).toEqual({ valid: true, reason: "decrypt_failed" });
  });

  it("TC-SD-070-13 a proof for the right file is refused: none can be made, and one made by hand (the buyer reveals its box key for a right file) is rejected as file_is_correct", () => {
    const { ciphertext, release, signature } = make();
    expect(code(() => makeCheatProof({ ciphertext, release, signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey }))).toBe("proof_not_possible");
    const boxKey = hex(deriveBoxKey(Buffer.from(release.sealed_key, "hex"), buyer.secretKey));
    expect(checkCheatProof({ ciphertext, release, signature, box_key: boxKey }, seller.publicKey)).toEqual({ valid: false, reason: "file_is_correct" });
  });

  it("TC-SD-070-14 forged proofs fail: a wrong box key, another ciphertext, and a release edited after the seller signed it", () => {
    const other = make({}, text("a different file"));
    const proof = makeCheatProof({ ciphertext: other.ciphertext, release: other.release, signature: other.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(checkCheatProof({ ...proof, box_key: "00".repeat(32) }, seller.publicKey)).toEqual({ valid: false, reason: "box_key_invalid" });
    expect(checkCheatProof({ ...proof, ciphertext: make().ciphertext }, seller.publicKey)).toEqual({ valid: false, reason: "cipher_hash_mismatch" });
    expect(checkCheatProof({ ...proof, release: { ...proof.release, content_hash: "e".repeat(64) } }, seller.publicKey)).toEqual({ valid: false, reason: "bad_signature" });
  });
});

describe("SD-070 review BE-062 F1 and F2: no forged proof, no substituted file", () => {
  const leaf = (b: Uint8Array) => sha(Buffer.concat([Buffer.from([0]), b]));
  const node = (l: Uint8Array, r: Uint8Array) => sha(Buffer.concat([Buffer.from([1]), l, r]));

  it("TC-SD-070-20 [F1] a 65-byte ciphertext built from the leaf hashes of an honest 8 MiB ciphertext is no proof of cheating against the honest seller", () => {
    const plain = new Uint8Array(CONTENT_CHUNK * 2).fill(7);
    const { ciphertext, key } = encryptContent(plain);
    const { release, signature } = createRelease({
      circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash: contentHash(plain), content_size: plain.length, ciphertext, contentKey: key,
      at: 1_800_000_000, sellerSecretKey: seller.secretKey,
    });
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < ciphertext.length; i += CONTENT_CHUNK) chunks.push(ciphertext.subarray(i, i + CONTENT_CHUNK));
    expect(chunks).toHaveLength(3);
    const forged = Buffer.concat([Buffer.from([1]), node(leaf(chunks[0]!), leaf(chunks[1]!)), leaf(chunks[2]!)]);
    expect(forged.length).toBe(65);
    const boxKey = hex(deriveBoxKey(Buffer.from(release.sealed_key, "hex"), buyer.secretKey));
    expect(checkCheatProof({ ciphertext: forged, release, signature, box_key: boxKey }, seller.publicKey)).toEqual({ valid: false, reason: "cipher_hash_mismatch" });
    // even if the hash were the same, the size of the signed release would refuse it
    expect(forged.length).not.toBe(release.cipher_size);
    expect(release.cipher_size).toBe(ciphertext.length);
  });

  it("TC-SD-070-21 [F2] a seller cannot deliver 65 bytes for the hash of a large file: verifyDelivery refuses the size and the hash", () => {
    const big = new Uint8Array(CONTENT_CHUNK + 1).fill(1);
    const forgedPlain = Buffer.concat([Buffer.from([1]), leaf(big.subarray(0, CONTENT_CHUNK)), leaf(big.subarray(CONTENT_CHUNK))]);
    const { ciphertext, key } = encryptContent(forgedPlain);
    const { release, signature } = createRelease({
      circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash: contentHash(big), content_size: big.length, ciphertext, contentKey: key,
      at: 1_800_000_000, sellerSecretKey: seller.secretKey,
    });
    const verdict = verifyDelivery({ ciphertext, release, signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && "proof" in verdict && verdict.reason).toBe("content_mismatch"); // the buyer gets a true proof against the seller
    // a size in the release that matches the 65 bytes does not help: the hash does not
    const lying = createRelease({
      circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash: contentHash(big), content_size: forgedPlain.length, ciphertext, contentKey: key,
      at: 1_800_000_000, sellerSecretKey: seller.secretKey,
    });
    expect(verifyDelivery({ ciphertext, release: lying.release, signature: lying.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey }).ok).toBe(false);
  });

  it("TC-SD-070-22 a ciphertext or a file of another size than the signed one is refused, whatever its hash", () => {
    const plain = text("rows,of,data\n1,2,3\n");
    const { ciphertext, key } = encryptContent(plain);
    const make = (content_size: number) => createRelease({
      circle: CIRCLE, license_hash: "c".repeat(64), buyer: BUYER, buyerPublicKey: buyer.publicKey, content_hash: contentHash(plain), content_size, ciphertext, contentKey: key,
      at: 1_800_000_000, sellerSecretKey: seller.secretKey,
    });
    const good = make(plain.length);
    expect(verifyDelivery({ ciphertext, release: good.release, signature: good.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey }).ok).toBe(true);
    const wrongSize = make(plain.length + 1); // the seller states another size for the right file: that is cheating, and provable
    const v = verifyDelivery({ ciphertext, release: wrongSize.release, signature: wrongSize.signature, sellerPublicKey: seller.publicKey, buyerSecretKey: buyer.secretKey });
    expect(v.ok).toBe(false);
    expect(checkCheatProof({ ciphertext, release: wrongSize.release, signature: wrongSize.signature, box_key: hex(deriveBoxKey(Buffer.from(wrongSize.release.sealed_key, "hex"), buyer.secretKey)) }, seller.publicKey)).toEqual({ valid: true, reason: "content_mismatch" });
    expect(code(() => make(-1))).toBe("license_bad_hash");
    expect(code(() => make(1.5))).toBe("license_bad_hash");
  });
});

describe("SD-070 ContentSource: https and ipfs", () => {
  const body = text("ciphertext bytes");
  const reply = (data: Uint8Array, init: ResponseInit & { url?: string } = {}) => {
    const res = new Response(Buffer.from(data), init);
    if (init.url) Object.defineProperty(res, "url", { value: init.url });
    return res;
  };

  it("TC-SD-070-15 https: only https without credentials, a size limit by header and by stream, progress, a redirect to http, and an error status", async () => {
    const ok = httpsSource({ fetch: async () => reply(body, { status: 200, url: "https://cdn.example.com/x" }) });
    const progress: number[] = [];
    expect(Buffer.from(await ok.fetch("https://cdn.example.com/x", { onProgress: (n) => progress.push(n) })).equals(Buffer.from(body))).toBe(true);
    expect(progress.at(-1)).toBe(body.length);
    for (const bad of ["http://cdn.example.com/x", "https://u:p@cdn.example.com/x", "https://cdn.example.com/x#f", "nope"]) {
      await expect(ok.fetch(bad), bad).rejects.toMatchObject({ code: "source_forbidden" });
    }
    await expect(ok.fetch("https://cdn.example.com/x", { maxBytes: 5 })).rejects.toMatchObject({ code: "source_too_large" });
    await expect(httpsSource({ fetch: async () => reply(body, { status: 200, headers: { "content-length": "999999" } }) }).fetch("https://cdn.example.com/x", { maxBytes: 100 })).rejects.toMatchObject({ code: "source_too_large" });
    await expect(httpsSource({ fetch: async () => reply(body, { status: 200, url: "http://evil.example.com/x" }) }).fetch("https://cdn.example.com/x")).rejects.toMatchObject({ code: "source_forbidden" });
    await expect(httpsSource({ fetch: async () => reply(body, { status: 404 }) }).fetch("https://cdn.example.com/x")).rejects.toMatchObject({ code: "source_failed" });
    await expect(httpsSource({ fetch: async () => { throw new Error("offline"); } }).fetch("https://cdn.example.com/x")).rejects.toMatchObject({ code: "source_failed" });
  });

  it("TC-SD-070-16 CIDv1 raw sha2-256 is parsed and made back; CIDv0, dag-pb and a bad CID are refused", () => {
    const cid = rawCidOf(body);
    expect(cid.startsWith("bafkrei")).toBe(true);
    expect(hex(parseRawCid(cid).digest)).toBe(hex(sha(Buffer.from(body))));
    expect(rawCidOf(text("abc"))).toBe("bafkreif2pall7dybz7vecqka3zo24irdwabwdi4wc55jznaq75q7eaavvu"); // the CID of the raw block "abc"
    expect(code(() => parseRawCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"))).toBe("source_cid_unsupported");
    expect(code(() => parseRawCid("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"))).toBe("source_cid_unsupported"); // dag-pb
    expect(code(() => parseRawCid("zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA"))).toBe("source_bad_ref");
    expect(code(() => parseRawCid("bNOT!VALID"))).toBe("source_bad_ref");
  });

  it("TC-SD-070-17 ipfs: a gateway that sends other bytes is not trusted, the next one is tried; all wrong gives source_cid_mismatch", async () => {
    const cid = rawCidOf(body);
    const calls: string[] = [];
    const fetcher = (answers: Record<string, Uint8Array>) => async (input: string) => {
      calls.push(input);
      const host = new URL(input).host;
      return reply(answers[host] ?? text("nothing"), { status: 200, url: input });
    };
    const ipfs = ipfsSource({ gateways: ["https://liar.example.com", "https://honest.example.com/"], fetch: fetcher({ "liar.example.com": text("tampered"), "honest.example.com": body }) });
    expect(Buffer.from(await ipfs.fetch(cid)).equals(Buffer.from(body))).toBe(true);
    expect(calls).toEqual([`https://liar.example.com/ipfs/${cid}`, `https://honest.example.com/ipfs/${cid}`]);
    await expect(ipfsSource({ gateways: ["https://liar.example.com"], fetch: fetcher({ "liar.example.com": text("tampered") }) }).fetch(cid)).rejects.toMatchObject({ code: "source_cid_mismatch" });
    await expect(ipfsSource({ gateways: ["http://plain.example.com"], fetch: fetcher({}) }).fetch(cid)).rejects.toMatchObject({ code: "source_forbidden" });
    await expect(ipfs.fetch("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).rejects.toMatchObject({ code: "source_cid_unsupported" });
  });

  it("TC-SD-070-18 fetchCiphertext checks cipher_hash whatever the source says, and needs a source for the kind", async () => {
    const source = httpsSource({ fetch: async () => reply(body, { status: 200, url: "https://cdn.example.com/x" }) });
    const ref = { kind: "https" as const, ref: "https://cdn.example.com/x" };
    expect(Buffer.from(await fetchCiphertext(ref, contentHash(body), { https: source })).equals(Buffer.from(body))).toBe(true);
    await expect(fetchCiphertext(ref, "f".repeat(64), { https: source })).rejects.toMatchObject({ code: "cipher_hash_mismatch" });
    await expect(fetchCiphertext({ kind: "ipfs", ref: rawCidOf(body) }, contentHash(body), { https: source })).rejects.toMatchObject({ code: "source_bad_ref" });
  });
});

describe("SD-070 canary watermark of a dataset", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `row-${i},value-${i}`);
  const base = contentHash(text(lines.join("\n")));
  const opts = { secret: "seller-canary-secret", buyer: BUYER, baseContentHash: base, count: 4 };

  it("TC-SD-070-19 canaries are added at places that depend on the buyer, stripped back to the same hash, and found in a leaked copy of that buyer only", () => {
    const marked = addCanaries(lines, opts);
    expect(marked).toHaveLength(54);
    expect(marked.filter((l) => l.startsWith(CANARY_PREFIX))).toHaveLength(4);
    expect(contentHash(text(stripCanaries(marked).join("\n")))).toBe(base);
    expect(findCanaries(marked, opts)).toEqual({ found: 4, expected: 4 });
    expect(findCanaries(marked, { ...opts, buyer: "other.x207-circle.near" })).toEqual({ found: 0, expected: 4 });
    expect(findCanaries(lines, opts)).toEqual({ found: 0, expected: 4 });
    // a copy with two rows removed still shows the other canaries
    expect(findCanaries(marked.filter((l) => !l.startsWith(CANARY_PREFIX) || l !== marked.find((x) => x.startsWith(CANARY_PREFIX))), opts).found).toBe(3);
    expect(addCanaries(lines, opts)).toEqual(marked); // deterministic
    expect(addCanaries(lines, { ...opts, buyer: "other.x207-circle.near" })).not.toEqual(marked);
    expect(code(() => addCanaries(marked, opts))).toBe("canary_bad_input");
    expect(code(() => addCanaries(lines, { ...opts, count: 0 }))).toBe("canary_bad_input");
    expect(code(() => addCanaries(lines, { ...opts, baseContentHash: "x" }))).toBe("canary_bad_input");
  });
});
