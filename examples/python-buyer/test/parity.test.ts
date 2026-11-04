// SD-086 parity: vouchers signed by `@x207/core` verify in Python, vouchers signed by the Python SDK verify in `@x207/core`, on random keys and amounts;
// a tampered voucher fails on both sides; a Python-made keypair signs for TypeScript. Needs python3 (standard library only); skipped without it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, signVoucher, verifyVoucher, voucherPublicKey, type UnsignedVoucher } from "@x207/core";

const python = process.env.X207_PYTHON ?? "python3";
const helper = new URL("./sign_batch.py", import.meta.url).pathname;
const hasPython = spawnSync(python, ["--version"]).status === 0;

const run = (input: unknown): { signed: Array<Record<string, unknown>>; publicKeys: string[]; verdicts: boolean[]; keypair: { secretKey: string; publicKey: string } } => {
  const result = spawnSync(python, [helper], { input: JSON.stringify(input), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
};

const voucherFor = (i: number): UnsignedVoucher => ({
  circle: "x207-circle.near", payer: `agent${i}.x207-circle.near`, payee: `seller${i % 3}.x207-circle.near`, epoch: 1 + (i % 50), seq: 1 + i,
  cumulativeAmount: (BigInt(20_000) * BigInt(i + 1) + BigInt(randomBytes(4).readUInt32LE())).toString(), unit: "credit",
  resource: i % 5 === 0 ? `x207:grant:${i}` : `https://seller${i}.example/api/summarize?q=${i}`,
});

describe.skipIf(!hasPython)("SD-086 the Python SDK and @x207/core sign and verify the same vouchers", () => {
  it("40 vouchers signed by TypeScript verify in Python, and the other way round", () => {
    const keys = Array.from({ length: 40 }, () => generateVoucherKeypair());
    const vouchers = keys.map((_, i) => voucherFor(i));
    const tsSigned = vouchers.map((v, i) => signVoucher(v, keys[i]!.secretKey));
    const answer = run({
      items: vouchers.map((voucher, i) => ({ voucher, secretKey: keys[i]!.secretKey })),
      verify: tsSigned.map((voucher, i) => ({ voucher, publicKey: keys[i]!.publicKey })),
    });
    expect(answer.verdicts.every(Boolean)).toBe(true);
    expect(answer.publicKeys).toEqual(keys.map((k) => k.publicKey));
    // Ed25519 is deterministic, so the same key and message give the same signature bytes
    expect(answer.signed).toEqual(tsSigned);
    answer.signed.forEach((voucher, i) => expect(verifyVoucher(voucher as never, keys[i]!.publicKey)).toBe(true));
  }, 120_000);

  it("a tampered voucher is refused on both sides, and a key made in Python signs for TypeScript", () => {
    const pair = generateVoucherKeypair();
    const voucher = voucherFor(7);
    const signed = signVoucher(voucher, pair.secretKey);
    const tampered = { ...signed, cumulativeAmount: (BigInt(signed.cumulativeAmount) + 1n).toString() };
    const answer = run({ verify: [{ voucher: signed, publicKey: pair.publicKey }, { voucher: tampered, publicKey: pair.publicKey }, { voucher: signed, publicKey: generateVoucherKeypair().publicKey }] });
    expect(answer.verdicts).toEqual([true, false, false]);
    expect(verifyVoucher(tampered, pair.publicKey)).toBe(false);
    const fromPython = answer.keypair;
    expect(voucherPublicKey(fromPython.secretKey as `ed25519:${string}`)).toBe(fromPython.publicKey);
    expect(verifyVoucher(signVoucher(voucher, fromPython.secretKey as `ed25519:${string}`), fromPython.publicKey)).toBe(true);
  }, 60_000);
});
