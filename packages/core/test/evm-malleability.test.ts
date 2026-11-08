// A-SD-02: the contract refuses a high-s signature (`env::ecrecover(.., true)`) and a v other than 0, 1, 27, 28; the verifier must say the same, or a seller serves and is never paid.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { bundleTypedData, isCanonicalEvmSignature, verifyEvmAction, verifyEvmBundle } from "../src/evm.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat test key
const account = privateKeyToAccount(KEY);
const address = account.address.toLowerCase();
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const bundle = { circle: "x207-v017.testnet", message: "A-SD-02", termsHash: "ab".repeat(32) };

async function signed() {
  const typed = bundleTypedData(bundle);
  const hex = await account.signTypedData(typed as never);
  return { typed, hex };
}

/** The twin of a signature: s' = n - s and the other parity of v. It recovers the same address in viem and is rejected by the contract. */
function highS(hex: string): string {
  const r = hex.slice(2, 66);
  const s = BigInt(`0x${hex.slice(66, 130)}`);
  const v = Number.parseInt(hex.slice(130, 132), 16);
  const flipped = v === 27 ? 28 : v === 28 ? 27 : v === 0 ? 1 : 0;
  return `0x${r}${(N - s).toString(16).padStart(64, "0")}${flipped.toString(16).padStart(2, "0")}`;
}

describe("A-SD-02 EVM signature malleability", () => {
  it("TC-SD-105-01 the high-s twin recovers the same address in viem (the gap) but the verifier rejects it", async () => {
    const { typed, hex } = await signed();
    const twin = highS(hex);
    expect(await recoverTypedDataAddress({ ...typed, signature: hex } as never)).toBe(account.address);
    expect(await recoverTypedDataAddress({ ...typed, signature: twin } as never)).toBe(account.address); // viem alone would accept it
    expect(await verifyEvmBundle(bundle, `eip712:${hex}`, address)).toBe(true);
    expect(await verifyEvmBundle(bundle, `eip712:${twin}`, address)).toBe(false);
    expect(isCanonicalEvmSignature(`eip712:${hex}`)).toBe(true);
    expect(isCanonicalEvmSignature(`eip712:${twin}`)).toBe(false);
  });

  it("TC-SD-105-02 v 0, 1, 27 and 28 are accepted, any other v and s = 0 are refused (same set as the contract)", async () => {
    const { hex } = await signed();
    const body = hex.slice(2, 130);
    const v = Number.parseInt(hex.slice(130, 132), 16);
    const zeroBased = (v - 27).toString(16).padStart(2, "0");
    expect(isCanonicalEvmSignature(`eip712:0x${body}${v.toString(16)}`)).toBe(true);
    expect(isCanonicalEvmSignature(`eip712:0x${body}${zeroBased}`)).toBe(true);
    for (const bad of ["02", "1d", "1f", "ff"]) expect(isCanonicalEvmSignature(`eip712:0x${body}${bad}`)).toBe(false);
    expect(isCanonicalEvmSignature(`eip712:0x${hex.slice(2, 66)}${"00".repeat(32)}1b`)).toBe(false);
  });

  it("TC-SD-105-03 an action signed with the high-s twin is refused by verifyEvmAction", async () => {
    const message = { circle: bundle.circle, member: address, action: "claim" as const, epoch: 5, receiver: "agent.testnet", termsHash: "", nonce: 0, deadline: 1_900_000_000_000, maxFee: "0" };
    const { actionTypedData } = await import("../src/evm.js");
    const hex = await account.signTypedData(actionTypedData(message as never) as never);
    expect(await verifyEvmAction(message as never, `eip712:${hex}`)).toBe(true);
    expect(await verifyEvmAction(message as never, `eip712:${highS(hex)}`)).toBe(false);
  });
});
