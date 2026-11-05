// EVM agents (SD-088): EIP-712 signatures for the x207 circle contract v0.0.15, separate entry `@x207/core/evm` so the main entry does not pull in viem.
// Types and domain are fixed by the design note "x207 - Desain Agent EVM" and by `contracts/tests/fixtures/evm-eip712.json` (CT-104); the Rust code must match byte for byte.
import { hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Eip712Signature, UnsignedVoucher, Voucher } from "./types.js";
import { EIP712_SIGNATURE_PATTERN } from "./types.js";
import type { VoucherSigner } from "./voucher-signer.js";

/** `salt = keccak256("near:" + network + ":" + contract account id)` (audit C55); the network is `testnet` for an account that ends in `.testnet`, else `mainnet`. Binds a signature to one contract on one network. */
export const evmDomainSalt = (contract: string): Hex => keccak256(toHex(`near:${contract.endsWith(".testnet") ? "testnet" : "mainnet"}:${contract}`));

/** Domain `EIP712Domain(string name,string version,bytes32 salt)`: no `chainId` and no `verifyingContract`, because the contract is not an EVM contract. `contract` is the `circle` field of the message (the circle contract account). */
export const evmDomain = (contract: string) => ({ name: "x207", version: "1", salt: evmDomainSalt(contract) }) as const;

export const EVM_TYPES = {
  Voucher: [
    { name: "circle", type: "string" },
    { name: "payer", type: "string" },
    { name: "payee", type: "string" },
    { name: "epoch", type: "uint64" },
    { name: "seq", type: "uint64" },
    { name: "cumulativeAmount", type: "uint256" },
    { name: "unit", type: "string" },
    { name: "resource", type: "string" },
  ],
  Bundle: [
    { name: "circle", type: "string" },
    { name: "message", type: "string" },
    { name: "termsHash", type: "string" },
  ],
  Action: [
    { name: "circle", type: "string" },
    { name: "member", type: "string" },
    { name: "action", type: "string" },
    { name: "epoch", type: "uint64" },
    { name: "receiver", type: "string" },
    { name: "termsHash", type: "string" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

/** `auto_settle` turns settlement from the stake on, `auto_settle_off` turns it off (contract 0.0.15, CT-108): the signature fixes the choice, so a signed "on" cannot be replayed as "off". */
export const EVM_ACTIONS = ["join", "claim", "request_exit", "withdraw_stake", "auto_settle", "auto_settle_off"] as const;
export type EvmAction = (typeof EVM_ACTIONS)[number];

/** Member action message (`join_evm`, `claim_evm`, `request_exit_evm`, `withdraw_stake_evm`). `deadline` is in ms of block time; `nonce` equals `EvmSigner.nonce` of the contract. */
export type EvmActionMessage = {
  circle: string;
  member: string;
  action: EvmAction;
  epoch: number | bigint;
  receiver: string;
  termsHash: string;
  nonce: number | bigint;
  deadline: number | bigint;
};

const EVM_MEMBER_ID = /^0x[0-9a-f]{40}$/;

/** Member id of an EVM agent: the lower-case `0x` address (42 characters). */
export const isEvmMemberId = (value: unknown): value is `0x${string}` => typeof value === "string" && EVM_MEMBER_ID.test(value);

export const isEip712Signature = (value: unknown): value is Eip712Signature => typeof value === "string" && EIP712_SIGNATURE_PATTERN.test(value);

/** Typed data of a voucher. `payer` is the lower-case `0x` address. */
export function voucherTypedData(voucher: UnsignedVoucher) {
  return {
    domain: evmDomain(voucher.circle),
    types: EVM_TYPES,
    primaryType: "Voucher" as const,
    message: {
      circle: voucher.circle,
      payer: voucher.payer,
      payee: voucher.payee,
      epoch: BigInt(voucher.epoch),
      seq: BigInt(voucher.seq),
      cumulativeAmount: BigInt(voucher.cumulativeAmount),
      unit: voucher.unit,
      resource: voucher.resource,
    },
  };
}

/** Typed data of a bundle: `message` is the canonical terms JSON, `termsHash` its sha256 hex. */
export function bundleTypedData(input: { circle: string; message: string; termsHash: string }) {
  return { domain: evmDomain(input.circle), types: EVM_TYPES, primaryType: "Bundle" as const, message: { ...input } };
}

export function actionTypedData(input: EvmActionMessage) {
  return {
    domain: evmDomain(input.circle),
    types: EVM_TYPES,
    primaryType: "Action" as const,
    message: { ...input, epoch: BigInt(input.epoch), nonce: BigInt(input.nonce), deadline: BigInt(input.deadline) },
  };
}

/** The 32-byte digest that is signed (what the contract computes with `keccak256`). */
export const evmVoucherDigest = (voucher: UnsignedVoucher): Hex => hashTypedData(voucherTypedData(voucher));
export const evmActionDigest = (input: EvmActionMessage): Hex => hashTypedData(actionTypedData(input));
export const evmBundleDigest = (input: { circle: string; message: string; termsHash: string }): Hex => hashTypedData(bundleTypedData(input));

/** Address that signed `typed`, lower-case, or `null` when the signature is malformed. */
async function recover(typed: ReturnType<typeof voucherTypedData> | ReturnType<typeof actionTypedData> | ReturnType<typeof bundleTypedData>, signature: string): Promise<string | null> {
  if (!isEip712Signature(signature)) return null;
  try {
    const address = await recoverTypedDataAddress({ ...typed, signature: `0x${signature.slice("eip712:0x".length)}` } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    return address.toLowerCase();
  } catch {
    return null;
  }
}

/** `true` only if `voucher.signature` is an `eip712:` signature made by the address in `voucher.payer`. Malformed input yields `false`, does not throw. */
export async function verifyEvmVoucher(voucher: Voucher): Promise<boolean> {
  if (!isEvmMemberId(voucher.payer)) return false;
  const { signature, ...unsigned } = voucher;
  return (await recover(voucherTypedData(unsigned), signature)) === voucher.payer;
}

export async function verifyEvmAction(input: EvmActionMessage, signature: string): Promise<boolean> {
  return isEvmMemberId(input.member) && (await recover(actionTypedData(input), signature)) === input.member;
}

export async function verifyEvmBundle(input: { circle: string; message: string; termsHash: string }, signature: string, address: string): Promise<boolean> {
  return isEvmMemberId(address) && (await recover(bundleTypedData(input), signature)) === address;
}

/** What `evmSigner` needs from a viem account (`privateKeyToAccount(key)`), or any wallet with the same two members. */
export type EvmAccountLike = {
  address: string;
  signTypedData(parameters: any): Promise<string>;
};

export interface EvmVoucherSigner extends VoucherSigner {
  readonly scheme: "eip712";
  /** Lower-case `0x` address = member id in the circle. */
  readonly id: `0x${string}`;
  signAction(input: Omit<EvmActionMessage, "member"> & { member?: string }): Promise<Eip712Signature>;
  signBundle(input: { circle: string; message: string; termsHash: string }): Promise<Eip712Signature>;
}

const asEip712 = (hex: string): Eip712Signature => {
  if (!/^0x[0-9a-fA-F]{130}$/.test(hex)) throw new Error("wallet returned a signature that is not 65 bytes (r, s, v)");
  return `eip712:${hex.toLowerCase()}` as Eip712Signature;
};

/** Signer for an EVM agent: `evmSigner(privateKeyToAccount("0x…"))`. The agent needs no NEAR key. */
export function evmSigner(account: EvmAccountLike): EvmVoucherSigner {
  const id = account.address.toLowerCase() as `0x${string}`;
  if (!isEvmMemberId(id)) throw new Error("EVM address must be 0x followed by 40 hex characters");
  return {
    scheme: "eip712",
    id,
    async signVoucher(voucher) {
      if (voucher.payer !== id) throw new Error(`voucher.payer must be the signer address ${id}`);
      const signature = asEip712(await account.signTypedData(voucherTypedData(voucher)));
      return { ...voucher, signature };
    },
    async signAction(input) {
      return asEip712(await account.signTypedData(actionTypedData({ ...input, member: input.member ?? id })));
    },
    async signBundle(input) {
      return asEip712(await account.signTypedData(bundleTypedData(input)));
    },
  };
}

const EVM_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** `true` for `0x` + 64 hex characters. */
export const isEvmPrivateKey = (value: unknown): value is `0x${string}` => typeof value === "string" && EVM_PRIVATE_KEY.test(value);

/** Signer from a plain EVM private key (`X207_EVM_PRIVATE_KEY`). The error never contains the key. */
export function evmSignerFromPrivateKey(privateKey: string): EvmVoucherSigner {
  if (!isEvmPrivateKey(privateKey)) throw new Error("EVM private key must be 0x followed by 64 hex characters");
  return evmSigner(privateKeyToAccount(privateKey));
}
