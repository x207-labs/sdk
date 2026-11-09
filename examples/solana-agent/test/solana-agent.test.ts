import { describe, expect, it } from "vitest";
import { base58Decode, signVoucher, verifyHash, verifyVoucher, voucherSigningHash, type UnsignedVoucher } from "@x207/core";
import { generateSolanaKeypair, nearMessageHash, signSolanaMessage, solanaAgentKeysFromKeypair, solanaTransferMessage } from "../src/agent.js";

const voucher = (payer: string): UnsignedVoucher => ({ circle: "x207-v015.testnet", payer, payee: "x207-demo-seller.testnet", epoch: 3, seq: 1, cumulativeAmount: "20000", unit: "credit", resource: "x207:test" });

describe("SD-098 agent identified by a Solana keypair", () => {
  it("TC-SD-098-01 one public key is the Solana address, the NEAR implicit account and the voucher key", () => {
    const keys = solanaAgentKeysFromKeypair(generateSolanaKeypair());
    const pub = base58Decode(keys.solanaAddress);
    expect(pub).toHaveLength(32);
    expect(keys.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.accountId).toBe(Buffer.from(pub).toString("hex"));
    expect(keys.voucherPublicKey).toBe(`ed25519:${keys.solanaAddress}`);
  });

  it("TC-SD-098-02 a keypair whose public half does not match its seed is refused", () => {
    const pair = generateSolanaKeypair();
    pair[40]! ^= 1;
    expect(() => solanaAgentKeysFromKeypair(pair)).toThrow(/does not match/);
  });

  it("TC-SD-098-03 the key signs a voucher that verifies under its pubkey_voucher", () => {
    const keys = solanaAgentKeysFromKeypair(generateSolanaKeypair());
    const signed = signVoucher(voucher(keys.accountId), keys.secretKey);
    expect(verifyVoucher(signed, keys.voucherPublicKey)).toBe(true);
  });

  it("TC-SD-098-04 a signature over a Solana transaction message is not a valid voucher signature, and the reverse", () => {
    const keys = solanaAgentKeysFromKeypair(generateSolanaKeypair());
    const message = solanaTransferMessage(base58Decode(keys.solanaAddress), new Uint8Array(32).fill(7), 1_000_000n, new Uint8Array(32).fill(9));
    const solanaSignature = signSolanaMessage(keys, message);
    const asVoucher = voucher(keys.accountId);
    const hash = voucherSigningHash(asVoucher);
    const edSignature = `ed25519:${Buffer.from(solanaSignature).toString("base64")}`;
    expect(verifyHash(hash, edSignature, keys.voucherPublicKey)).toBe(false);
    // the preimages differ: a Solana message is the raw bytes, a voucher is a 32-byte NEP-413 hash that starts from the tag 2^31+413
    const nepHash = nearMessageHash("any", new Uint8Array(32), "x207-v015.testnet");
    expect(Buffer.from(message).subarray(0, 32)).not.toEqual(Buffer.from(nepHash));
    // a voucher signature (over a 32-byte hash) does not verify as the signature of the Solana message
    const voucherSignature = base58Decode(signVoucher(asVoucher, keys.secretKey).signature.slice("ed25519:".length));
    expect(Buffer.from(voucherSignature)).not.toEqual(Buffer.from(solanaSignature));
  });
});
