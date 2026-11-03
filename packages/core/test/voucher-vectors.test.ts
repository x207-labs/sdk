import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  serializeVoucherMessage,
  signVoucher,
  validatePaymentPayload,
  verifyVoucher,
  voucherNonce,
  voucherPayload,
  voucherPublicKey,
  voucherSigningHash,
  type Voucher,
} from "@x207/core";

const root = fileURLToPath(new URL("../../../spec/test-vectors/", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(`${root}${path}`, "utf8")) as any;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const walk = (dir: string): string[] =>
  readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}${entry.name}/`) : [`${dir}${entry.name}`],
  );

const voucherFiles = walk("voucher/");
const allFiles = [...voucherFiles, ...walk("payload/"), "keys.json"];
const TAMPERED_FIELDS = ["circle", "payer", "payee", "epoch", "seq", "cumulativeAmount", "unit", "resource"];

describe("SD-006 test vector voucher", () => {
  it("TC-SD-006-01 all files pass schema.json", () => {
    const validate = new Ajv().compile(read("schema.json"));
    const vectors = [...voucherFiles, ...walk("payload/")];
    expect(vectors.length).toBeGreaterThanOrEqual(13);
    for (const file of vectors) {
      expect(validate(read(file)), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("TC-SD-006-02 a valid voucher: verification and canonical bytes", () => {
    const { input, expected } = read("voucher/valid.json");
    const { signature: _signature, ...unsigned } = input.voucher as Voucher;
    expect(verifyVoucher(input.voucher, input.publicKey)).toBe(expected.valid);
    expect(serializeVoucherMessage(unsigned)).toBe(expected.message);
    expect(hex(voucherNonce(unsigned))).toBe(expected.nonce);
    expect(hex(voucherPayload(unsigned))).toBe(expected.payload);
    expect(hex(voucherSigningHash(unsigned))).toBe(expected.signingHash);
    expect(createHash("sha256").update(Buffer.from(expected.payload, "hex")).digest("hex")).toBe(
      expected.signingHash,
    );
  });

  it("TC-SD-006-02 the vector pubkey and signature equal the seed in keys.json", () => {
    const keys = read("keys.json").keys;
    const { input } = read("voucher/valid.json");
    const seed = Buffer.from(keys.kA.seed, "hex");
    expect(voucherPublicKey(seed)).toBe(keys.kA.publicKey);
    expect(input.publicKey).toBe(keys.kA.publicKey);
    const { signature: _s, ...unsigned } = input.voucher as Voucher;
    expect(signVoucher(unsigned, seed).signature).toBe(input.voucher.signature);
  });

  it("TC-SD-006-03 eight field-changed files are rejected", () => {
    for (const field of TAMPERED_FIELDS) {
      const { input, expected } = read(`voucher/tampered_${field}.json`);
      expect(verifyVoucher(input.voucher, input.publicKey), field).toBe(false);
      expect(expected.valid).toBe(false);
    }
  });

  it("TC-SD-006-04 tanda tangan dirusak", () => {
    const { input, expected } = read("voucher/bad_signature.json");
    expect(verifyVoucher(input.voucher, input.publicKey)).toBe(false);
    expect(expected.contractError).toBe("ERR_BAD_SIGNATURE");
    expect(expected.facilitatorReason).toBe("invalid_signature");
  });

  it("TC-SD-006-05 old seq (context last_seq 137, seq 137)", () => {
    const { input, expected } = read("voucher/seq_stale.json");
    expect(verifyVoucher(input.voucher, input.publicKey)).toBe(true);
    expect(input.context.lastSeq).toBe(137);
    expect(input.voucher.seq).toBe(137);
    expect(input.voucher.seq <= input.context.lastSeq).toBe(true);
    expect(expected).toMatchObject({
      accepted: false,
      contractError: "ERR_SEQ_NOT_INCREASING",
      facilitatorReason: "seq_not_increasing",
    });
  });

  it("TC-SD-006-06 seq mundur (seq 136)", () => {
    const { input, expected } = read("voucher/seq_backwards.json");
    expect(verifyVoucher(input.voucher, input.publicKey)).toBe(true);
    expect(input.voucher.seq).toBe(136);
    expect(input.voucher.seq <= input.context.lastSeq).toBe(true);
    expect(expected.contractError).toBe("ERR_SEQ_NOT_INCREASING");
    expect(expected.facilitatorReason).toBe("seq_not_increasing");
  });

  it("TC-SD-006-07 after the cutoff: epoch_closing / ERR_PAST_CUTOFF", () => {
    const { input, expected } = read("voucher/past_cutoff.json");
    expect(verifyVoucher(input.voucher, input.publicKey)).toBe(true);
    expect(input.context.nowMs).toBe(input.context.cutoffAtMs + 1000);
    expect(input.context.epochClosed).toBe(false);
    expect(expected).toMatchObject({
      accepted: false,
      contractError: "ERR_PAST_CUTOFF",
      facilitatorReason: "epoch_closing",
    });
  });

  it("TC-SD-006-08 PaymentPayload and the PAYMENT-SIGNATURE header", () => {
    const { input, expected } = read("payload/payment_signature_agents_main.json");
    const payload = input.paymentPayload;
    expect(payload.accepted.network).toBe("x207:agents-main");
    expect(validatePaymentPayload(payload).ok).toBe(true);
    const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    expect(header).toBe(expected.header);
    expect(JSON.parse(Buffer.from(expected.header, "base64").toString("utf8"))).toEqual(payload);
    expect(verifyVoucher(
      { ...payload.payload.voucher, signature: payload.payload.signature },
      read("keys.json").keys.kA.publicKey,
    )).toBe(true);
  });

  it("TC-SD-006-09 only standard JSON can be read by Rust", () => {
    const check = (value: unknown, path: string) => {
      if (typeof value === "number") expect(Number.isSafeInteger(value), path).toBe(true);
      else if (typeof value === "string") {
        if (/(signature|publicKey)$/.test(path)) expect(value, path).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
        if (/\.(nonce|payload|signingHash|seed)$/.test(path)) expect(value, path).toMatch(/^[0-9a-f]+$/);
        if (/cumulativeAmount$/.test(path)) expect(value, path).toMatch(/^(0|[1-9]\d*)$/);
      } else if (Array.isArray(value)) value.forEach((v, i) => check(v, `${path}[${i}]`));
      else if (value && typeof value === "object") {
        for (const [key, v] of Object.entries(value)) check(v, `${path}.${key}`);
      } else expect(["boolean"].includes(typeof value) || value === null, path).toBe(true);
    };
    for (const file of allFiles) {
      const text = readFileSync(`${root}${file}`, "utf8");
      expect(() => JSON.parse(text)).not.toThrow();
      check(JSON.parse(text), file);
    }
  });
});
