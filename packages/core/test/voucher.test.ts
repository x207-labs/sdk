import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base58Decode,
  base58Encode,
  generateVoucherKeypair,
  serializeVoucherMessage,
  signVoucher,
  verifyVoucher,
  voucherNonce,
  voucherPayload,
  voucherPublicKey,
  voucherSigningHash,
  type UnsignedVoucher,
} from "@x207/core";

const seed = (byte: number) => new Uint8Array(32).fill(byte);
const kA = seed(0x01);
const kZ = seed(0x0f);

const V: UnsignedVoucher = {
  circle: "x207-circle.near",
  payer: "translator.x207-circle.near",
  payee: "summarizer.x207-circle.near",
  epoch: 42,
  seq: 137,
  cumulativeAmount: "2740000",
  unit: "credit",
  resource: "https://summarizer.example/api/summarize",
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha = (text: string) => createHash("sha256").update(text).digest();

describe("SD-005 serialisasi kanonik dan tanda tangan", () => {
  it("TC-SD-005-01 JSON kanonik", () => {
    expect(serializeVoucherMessage(V)).toBe(
      '{"circle":"x207-circle.near","payer":"translator.x207-circle.near","payee":"summarizer.x207-circle.near","epoch":42,"seq":137,"cumulativeAmount":"2740000","unit":"credit","resource":"https://summarizer.example/api/summarize"}',
    );
  });

  it("TC-SD-005-02 urutan key input tidak berpengaruh", () => {
    const shuffled = Object.fromEntries(Object.entries(V).reverse()) as UnsignedVoucher;
    expect(serializeVoucherMessage(shuffled)).toBe(serializeVoucherMessage(V));
  });

  it("TC-SD-005-03 nonce", () => {
    const nonce = voucherNonce(V);
    expect(nonce).toHaveLength(32);
    expect(hex(nonce)).toBe(
      hex(sha("x207:translator.x207-circle.near:summarizer.x207-circle.near:42:137")),
    );
  });

  it("TC-SD-005-04 prefix NEP-413 9d 01 00 80", () => {
    expect(hex(voucherPayload(V).subarray(0, 4))).toBe("9d010080");
  });

  it("TC-SD-005-05 struct borsh", () => {
    const message = Buffer.from(serializeVoucherMessage(V));
    const recipient = Buffer.from("x207-circle.near");
    const u32 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, 0, 0]);
    const expected = Buffer.concat([
      Buffer.from("9d010080", "hex"),
      u32(message.length), message,
      voucherNonce(V),
      u32(recipient.length), recipient,
      Buffer.from([0]),
    ]);
    expect(hex(voucherPayload(V))).toBe(hex(expected));
    expect(hex(voucherSigningHash(V))).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });

  it("TC-SD-005-06 tanda tangan sah", () => {
    const signed = signVoucher(V, kA);
    expect(signed.signature).toMatch(/^ed25519:/);
    expect(base58Decode(signed.signature.slice(8))).toHaveLength(64);
    expect(verifyVoucher(signed, voucherPublicKey(kA))).toBe(true);
  });

  it("TC-SD-005-07 satu dari delapan field diubah", () => {
    const signed = signVoucher(V, kA);
    const pub = voucherPublicKey(kA);
    const changes: Record<string, unknown> = {
      circle: "evil-circle.near",
      payer: "scraper.x207-circle.near",
      payee: "scraper.x207-circle.near",
      epoch: 43,
      seq: 138,
      cumulativeAmount: "2740001",
      unit: "usd",
      resource: "https://summarizer.example/api/other",
    };
    for (const [field, value] of Object.entries(changes)) {
      expect(verifyVoucher({ ...signed, [field]: value }, pub), field).toBe(false);
    }
  });

  it("TC-SD-005-08 kunci lain", () => {
    expect(verifyVoucher(signVoucher(V, kZ), voucherPublicKey(kA))).toBe(false);
  });

  it("TC-SD-005-09 tanda tangan dirusak", () => {
    const signed = signVoucher(V, kA);
    const bytes = base58Decode(signed.signature.slice(8));
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    const broken = { ...signed, signature: `ed25519:${base58Encode(bytes)}` as const };
    expect(verifyVoucher(broken, voucherPublicKey(kA))).toBe(false);
    expect(verifyVoucher({ ...signed, signature: "ed25519:???" }, voucherPublicKey(kA))).toBe(false);
  });

  it("TC-SD-005-10 deterministik", () => {
    expect(signVoucher(V, kA).signature).toBe(signVoucher(V, kA).signature);
  });

  it("TC-SD-005-11 nol di depan melempar", () => {
    expect(() => serializeVoucherMessage({ ...V, cumulativeAmount: "02740000" })).toThrow();
    expect(() => signVoucher({ ...V, cumulativeAmount: "02740000" }, kA)).toThrow();
  });

  it("TC-SD-005-12 resource non-ASCII melempar", () => {
    expect(() => signVoucher({ ...V, resource: "https://é.example" }, kA)).toThrow();
  });

  it("TC-SD-005-13 U128 besar tetap utuh", () => {
    const big = "340282366920938463463374607431768211455";
    expect(serializeVoucherMessage({ ...V, cumulativeAmount: big })).toContain(`"cumulativeAmount":"${big}"`);
  });

  it("TC-SD-005-14 epoch dan seq number di message", () => {
    const parsed = JSON.parse(serializeVoucherMessage(V)) as Record<string, unknown>;
    expect(typeof parsed.epoch).toBe("number");
    expect(typeof parsed.seq).toBe("number");
  });

  it("kunci ed25519 cocok dengan vektor RFC 8032 (seed 9d61b19d…)", () => {
    const rfcSeed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    const pub = voucherPublicKey(rfcSeed);
    expect(hex(base58Decode(pub.slice(8)))).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
  });

  it("generateVoucherKeypair menghasilkan pasangan yang saling cocok", () => {
    const { secretKey, publicKey } = generateVoucherKeypair();
    expect(voucherPublicKey(secretKey)).toBe(publicKey);
    expect(verifyVoucher(signVoucher(V, secretKey), publicKey)).toBe(true);
  });

  it("base58 round-trip dengan nol di depan", () => {
    const bytes = Uint8Array.of(0, 0, 1, 2, 255);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(() => base58Decode("0OIl")).toThrow();
  });
});
