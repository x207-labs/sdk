// SD-097: the NEP-518 `rlp_execute` path of an EVM agent. The real vector is the transaction 6zkgYgxW… of the SD-094 run on x207-v015.testnet (set_auto_settle enabled true, signed by the 0x key of the demo
// agent, accepted by the wallet contract and by x207-v015): `fixtures/nep518-rlp-execute.json` holds its `rlp_execute` arguments, public chain data without any key. The tests decode it and then build the same
// transaction with a NEW key (derived here from a text, not the Hardhat key and not a demo key), so the encoding, the `to` address, the nonce, the fees and the function-call payload are compared field by field.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSetAutoSettleCall } from "../src/index.js";
import {
  NEP518_CHAIN_ID, NEP518_FUNCTION_CALL_SELECTOR, decodeNep518FunctionCall, decodeNep518Transaction, encodeNep518FunctionCall, nep518ToAddress, signNep518Transaction, type Nep518Call,
} from "../src/evm.js";

const real = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/nep518-rlp-execute.json", import.meta.url)), "utf8")) as { tx_hash: string; relayer: string; receiver_id: string; method_name: string; target: string; tx_bytes_b64: string };
const AGENT = "0xcdaba48462aea97aff54fd15421a5dc8a589b845"; // the demo agent of SD-094 (its key is not in the repository)
const CIRCLE = "x207-v015.testnet";
// a key made for this test only: keccak256 of a text, so no private key is written in the repository
const NEW_KEY = keccak256(stringToBytes("x207 SD-097 test key: not a hardhat key, not a demo key")) as `0x${string}`;
const setAutoSettle = (enabled: boolean): Nep518Call => {
  const c = buildSetAutoSettleCall({ circleContract: CIRCLE, enabled });
  return { receiverId: c.receiverId, methodName: c.methodName, args: c.args, gas: c.gas!, yoctoNear: Number(c.deposit) };
};

describe("SD-097 NEP-518 rlp_execute", () => {
  it("TC-SD-097-01 the real testnet transaction decodes: EIP-1559, chain 398, signed by the demo agent, to = keccak256(target)[12..], set_auto_settle {enabled:true}, 30 Tgas, 1 yocto", async () => {
    expect(real.receiver_id).toBe(AGENT);
    expect(real.method_name).toBe("rlp_execute");
    expect(real.target).toBe(CIRCLE);
    const tx = await decodeNep518Transaction(real.tx_bytes_b64);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(NEP518_CHAIN_ID.testnet);
    expect(tx.signer).toBe(AGENT);
    expect(tx.nonce).toBe(1);
    expect(tx.to).toBe("0x5172490af44aadada41facdb6e7f0886641114c1");
    expect(tx.to).toBe(nep518ToAddress(CIRCLE));
    expect(tx.value).toBe(0n);
    expect(tx.gasLimit).toBe(1_000_000n);
    expect(tx.maxFeePerGas).toBe(1_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(0n);
    expect(tx.call).toEqual({ receiverId: CIRCLE, methodName: "set_auto_settle", args: { enabled: true }, gas: 30_000_000_000_000n, yoctoNear: 1 });
  });

  it("TC-SD-097-02 the call payload equals buildSetAutoSettleCall, and the data starts with the functionCall selector", () => {
    const data = encodeNep518FunctionCall(setAutoSettle(true));
    expect(data.startsWith(NEP518_FUNCTION_CALL_SELECTOR)).toBe(true);
    expect(decodeNep518FunctionCall(data)).toEqual(setAutoSettle(true));
    expect(JSON.stringify(setAutoSettle(true).args)).toBe('{"enabled":true}');
    expect(setAutoSettle(true).yoctoNear).toBe(1); // set_auto_settle needs exactly 1 yocto
  });

  it("TC-SD-097-03 a transaction built with a new key has every field of the real one (target, chain, nonce, fees, data); only the signer and the signature differ", async () => {
    const built = await signNep518Transaction({ privateKey: NEW_KEY, target: CIRCLE, nonce: 1, call: setAutoSettle(true) });
    expect(built.target).toBe(CIRCLE);
    const mine = await decodeNep518Transaction(built.tx_bytes_b64);
    const theirs = await decodeNep518Transaction(real.tx_bytes_b64);
    expect(mine.signer).toBe(privateKeyToAccount(NEW_KEY).address.toLowerCase());
    expect(mine.signer).not.toBe(theirs.signer);
    const { signer: _a, ...mineRest } = mine;
    const { signer: _b, ...theirsRest } = theirs;
    expect(mineRest).toEqual(theirsRest);
    // the unsigned part of the bytes is identical: the real transaction minus its signature is what the new key signed (same type byte, same payload prefix)
    expect(Buffer.from(built.tx_bytes_b64, "base64")[0]).toBe(Buffer.from(real.tx_bytes_b64, "base64")[0]);
    expect(Buffer.from(built.tx_bytes_b64, "base64")[0]).toBe(0x02);
  });

  it("TC-SD-097-04 the nonce, the enabled flag and the chain id change exactly the fields they should", async () => {
    const a = await decodeNep518Transaction((await signNep518Transaction({ privateKey: NEW_KEY, target: CIRCLE, nonce: 7, call: setAutoSettle(false) })).tx_bytes_b64);
    expect(a.nonce).toBe(7);
    expect(a.call.args).toEqual({ enabled: false });
    expect(a.chainId).toBe(398);
    const main = await decodeNep518Transaction((await signNep518Transaction({ privateKey: NEW_KEY, target: CIRCLE, nonce: 0, call: setAutoSettle(true), chainId: NEP518_CHAIN_ID.mainnet })).tx_bytes_b64);
    expect(main.chainId).toBe(397);
    // another target changes `to`
    expect(nep518ToAddress("usdt.x207-deployer.testnet")).not.toBe(nep518ToAddress(CIRCLE));
    expect(nep518ToAddress(CIRCLE)).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("TC-SD-097-05 signing is deterministic (RFC 6979): the same input gives the same bytes; a bad key is refused without printing it", async () => {
    const input = { privateKey: NEW_KEY, target: CIRCLE, nonce: 3, call: setAutoSettle(true) };
    expect((await signNep518Transaction(input)).tx_bytes_b64).toBe((await signNep518Transaction(input)).tx_bytes_b64);
    await expect(signNep518Transaction({ ...input, privateKey: "0x1234" })).rejects.toThrow(/64 hex/);
    await expect(signNep518Transaction({ ...input, privateKey: "0x1234" })).rejects.not.toThrow(/1234/);
  });

  it("TC-SD-097-06 bytes that are not a functionCall are refused", () => {
    expect(() => decodeNep518FunctionCall("0x12345678")).toThrow();
  });
});
