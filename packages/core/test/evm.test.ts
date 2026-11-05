// SD-088: EIP-712 signatures of EVM agents. The vectors are the fixture of the contract (CT-104, `contracts/tests/fixtures/evm-eip712.json`),
// so the digests that viem computes here are the ones the Rust code must produce.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signVoucher, validateX207Payload, verifyVoucher, voucherPublicKey, type UnsignedVoucher, type Voucher } from "../src/index.js";
import { ed25519Signer } from "../src/voucher-signer.js";
import {
  EVM_ACTIONS, actionTypedData, evmActionDigest, evmBundleDigest, evmDomain, evmDomainSalt, evmSigner, evmVoucherDigest, isEvmMemberId, voucherTypedData,
  verifyEvmAction, verifyEvmBundle, verifyEvmVoucher, type EvmActionMessage,
} from "../src/evm.js";

const fixturePath = fileURLToPath(new URL("./fixtures/evm-eip712.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const contractFixture = fileURLToPath(new URL("../../../../contracts/tests/fixtures/evm-eip712.json", import.meta.url));
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat test key, the one of the fixture
const account = privateKeyToAccount(KEY);
const sig = (hex: string) => `eip712:${hex}`;

const v = fixture.vectors;
const unsignedVoucher: UnsignedVoucher = {
  circle: v.voucher.message.circle, payer: v.voucher.message.payer, payee: v.voucher.message.payee, epoch: Number(v.voucher.message.epoch),
  seq: Number(v.voucher.message.seq), cumulativeAmount: v.voucher.message.cumulativeAmount, unit: "credit", resource: v.voucher.message.resource,
};
const action = (name: string): EvmActionMessage => {
  const m = v[name].message;
  return { ...m, epoch: BigInt(m.epoch), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) };
};

describe("SD-088 EVM EIP-712", () => {
  it("TC-SD-088-01 the copy of the fixture equals the one of the contract repository", () => {
    if (!existsSync(contractFixture)) return; // sdk checked out alone
    expect(JSON.parse(readFileSync(contractFixture, "utf8"))).toEqual(fixture);
  });

  it("TC-SD-088-02 digests match the contract vectors", () => {
    expect(evmVoucherDigest(unsignedVoucher)).toBe(v.voucher.digest);
    expect(evmBundleDigest({ circle: fixture.circle, message: v.bundle.message.message, termsHash: v.bundle.termsHash })).toBe(v.bundle.digest);
    for (const name of EVM_ACTIONS) expect(evmActionDigest(action(name))).toBe(v[name].digest);
  });

  it("TC-SD-088-03 the signer reproduces the vector signatures byte for byte", async () => {
    const signer = evmSigner(account);
    expect(signer.id).toBe(fixture.address);
    expect(signer.scheme).toBe("eip712");
    const signed = await signer.signVoucher(unsignedVoucher);
    expect(signed.signature).toBe(sig(v.voucher.signature));
    expect(await signer.signBundle({ circle: fixture.circle, message: v.bundle.message.message, termsHash: v.bundle.termsHash })).toBe(sig(v.bundle.signature));
    for (const name of EVM_ACTIONS) expect(await signer.signAction(action(name))).toBe(sig(v[name].signature));
  });

  it("TC-SD-088-04 verification accepts the vectors and names the signer", async () => {
    expect(await verifyEvmVoucher({ ...unsignedVoucher, signature: sig(v.voucher.signature) } as Voucher)).toBe(true);
    expect(await verifyEvmBundle({ circle: fixture.circle, message: v.bundle.message.message, termsHash: v.bundle.termsHash }, sig(v.bundle.signature), fixture.address)).toBe(true);
    for (const name of EVM_ACTIONS) expect(await verifyEvmAction(action(name), sig(v[name].signature))).toBe(true);
  });

  it("TC-SD-088-05 a changed field, another payer or a broken signature is refused", async () => {
    const good = { ...unsignedVoucher, signature: sig(v.voucher.signature) } as Voucher;
    expect(await verifyEvmVoucher({ ...good, seq: good.seq + 1 })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, cumulativeAmount: "1" })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, circle: "x207-v013.testnet" })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, payer: "0x0000000000000000000000000000000000000001" })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, payer: fixture.address.toUpperCase().replace("0X", "0x") })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, signature: "eip712:0x1234" as never })).toBe(false);
    expect(await verifyEvmVoucher({ ...good, signature: "ed25519:abc" as never })).toBe(false);
    expect(await verifyEvmAction({ ...action("claim"), receiver: "evil.testnet" }, sig(v.claim.signature))).toBe(false);
    expect(await verifyEvmAction({ ...action("claim"), nonce: 1n }, sig(v.claim.signature))).toBe(false);
  });

  it("TC-SD-088-06 signer refuses a voucher of another payer", async () => {
    await expect(evmSigner(account).signVoucher({ ...unsignedVoucher, payer: "a.testnet" })).rejects.toThrow(/payer must be/);
  });

  it("TC-SD-088-07 validateX207Payload accepts eip712 signatures and still refuses other strings", () => {
    const base = { voucher: unsignedVoucher };
    expect(validateX207Payload({ ...base, signature: sig(v.voucher.signature) }).ok).toBe(true);
    expect(validateX207Payload({ ...base, signature: "eip712:0x12" }).ok).toBe(false);
    expect(validateX207Payload({ ...base, signature: "secp256k1:abc" }).ok).toBe(false);
  });

  it("TC-SD-088-08 member id rule", () => {
    expect(isEvmMemberId(fixture.address)).toBe(true);
    expect(isEvmMemberId(account.address)).toBe(false); // checksum case is not a member id
    expect(isEvmMemberId("a.testnet")).toBe(false);
  });

  it("TC-SD-088-09 ed25519Signer gives the same voucher as signVoucher and the old verify still works", async () => {
    const seed = new Uint8Array(32).fill(7);
    const unsigned: UnsignedVoucher = { ...unsignedVoucher, payer: "a.testnet" };
    const viaSigner = await ed25519Signer(seed).signVoucher(unsigned);
    expect(viaSigner).toEqual(signVoucher(unsigned, seed));
    expect(ed25519Signer(seed).id).toBe(voucherPublicKey(seed));
    expect(verifyVoucher(viaSigner, voucherPublicKey(seed))).toBe(true);
    expect(verifyVoucher({ ...unsignedVoucher, signature: sig(v.voucher.signature) } as Voucher, voucherPublicKey(seed))).toBe(false);
  });

  it("TC-SD-088-10 typed data of an action carries bigints for the uint64 fields", () => {
    const data = actionTypedData(action("join"));
    expect(data.message.deadline).toBe(1_900_000_000_000n);
    expect(data.domain).toEqual({ name: "x207", version: "1", salt: fixture.salt });
  });

  it("TC-SD-088-11 domain salt: the salt and the domain separator of the fixture, and other contracts or networks give other salts (audit C55)", async () => {
    expect(evmDomainSalt(fixture.circle)).toBe(fixture.salt);
    expect(evmDomain(fixture.circle)).toEqual({ name: "x207", version: "1", salt: fixture.salt });
    for (const [contract, cross] of Object.entries(fixture.crossContract as Record<string, { salt: string; digest: string; signature: string }>)) {
      expect(evmDomainSalt(contract)).toBe(cross.salt);
      // same message, the domain of another contract: the digest differs and its signature does not verify for the circle of the fixture
      expect(hashTypedData({ ...voucherTypedData(unsignedVoucher), domain: evmDomain(contract) })).toBe(cross.digest);
      expect(await verifyEvmVoucher({ ...unsignedVoucher, signature: sig(cross.signature) } as unknown as Voucher)).toBe(false);
    }
  });
});
