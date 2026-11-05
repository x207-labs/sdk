// EVM agents (SD-088): EIP-712 signatures for the x207 circle contract v0.0.15, separate entry `@x207/core/evm` so the main entry does not pull in viem.
// Types and domain are fixed by the design note "x207 - Desain Agent EVM" and by `contracts/tests/fixtures/evm-eip712.json` (CT-104); the Rust code must match byte for byte.
import {
  bytesToHex, decodeFunctionData, encodeFunctionData, hashTypedData, hexToBytes, hexToString, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, stringToBytes, toHex, type Hex,
} from "viem";
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

/**
 * SD-100 (contract 0.0.16, `x207-v016.testnet`): the `Action` type has a ninth field, `uint256 maxFee`, the most the relayer may take from a payout or a stake. The contracts 0.0.14 and
 * 0.0.15 sign the eight-field type above. `actionTypedData` uses this one only when the message has a `maxFee`; fixtures: `evm-eip712.json` (nine fields) and `evm-eip712-v1.json` (eight).
 */
export const EVM_TYPES_WITH_MAX_FEE = { ...EVM_TYPES, Action: [...EVM_TYPES.Action, { name: "maxFee", type: "uint256" }] } as const;

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
  /** SD-100: given (even `0`) only for contract 0.0.16, where it is the ninth signed field; absent for 0.0.14 and 0.0.15. In the credit unit of the circle (6 decimals), a non-negative integer. */
  maxFee?: number | bigint | string;
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
  const { maxFee, ...rest } = input;
  const base = { ...rest, epoch: BigInt(input.epoch), nonce: BigInt(input.nonce), deadline: BigInt(input.deadline) };
  if (maxFee === undefined) return { domain: evmDomain(input.circle), types: EVM_TYPES, primaryType: "Action" as const, message: base };
  if (typeof maxFee === "string" ? !/^\d+$/.test(maxFee) : typeof maxFee === "number" ? !Number.isSafeInteger(maxFee) || maxFee < 0 : maxFee < 0n) throw new Error("maxFee must be a non-negative integer");
  return { domain: evmDomain(input.circle), types: EVM_TYPES_WITH_MAX_FEE, primaryType: "Action" as const, message: { ...base, maxFee: BigInt(maxFee) } };
}

/** The 32-byte digest that is signed (what the contract computes with `keccak256`). */
export const evmVoucherDigest = (voucher: UnsignedVoucher): Hex => hashTypedData(voucherTypedData(voucher));
export const evmActionDigest = (input: EvmActionMessage): Hex => hashTypedData(actionTypedData(input) as unknown as Parameters<typeof hashTypedData>[0]);
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

/** CT-114: a signed Action is valid until its `deadline` and anybody may send it; the contract has no upper bound for the deadline (roadmap `ERR_EVM_DEADLINE_TOO_FAR`), so the signer keeps it short. */
export const EVM_DEFAULT_DEADLINE_TTL_MS = 10 * 60_000;

/** Options of `signAction` that are not part of the signed message. */
export type EvmSignActionOptions = {
  /** Unix ms used for the default deadline and the check of `maxTtlMs`. Default `Date.now()`. */
  now?: number;
  /** Refuse (throw) a `deadline` that is more than this many ms after `now`. Default: no limit. */
  maxTtlMs?: number;
  /** SD-100: sign the nine-field `Action` of contract 0.0.16 with this `maxFee` (when the input has none of its own). Without it the eight-field `Action` of 0.0.14 and 0.0.15 is signed. */
  maxFee?: number | bigint | string;
};

export interface EvmVoucherSigner extends VoucherSigner {
  readonly scheme: "eip712";
  /** Lower-case `0x` address = member id in the circle. */
  readonly id: `0x${string}`;
  /** `deadline` (ms of block time) defaults to `now + 10 minutes` (`EVM_DEFAULT_DEADLINE_TTL_MS`); a signature that is not sent in time must be signed again. */
  signAction(input: Omit<EvmActionMessage, "member" | "deadline"> & { member?: string; deadline?: number | bigint }, options?: EvmSignActionOptions): Promise<Eip712Signature>;
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
    async signAction(input, options = {}) {
      const now = options.now ?? Date.now();
      const deadline = input.deadline ?? now + EVM_DEFAULT_DEADLINE_TTL_MS;
      if (options.maxTtlMs !== undefined && BigInt(deadline) > BigInt(now) + BigInt(options.maxTtlMs)) {
        throw new Error(`deadline ${deadline} is more than ${options.maxTtlMs} ms after ${now}: sign a shorter one`);
      }
      const maxFee = input.maxFee ?? options.maxFee;
      return asEip712(await account.signTypedData(actionTypedData({ ...input, deadline, member: input.member ?? id, ...(maxFee !== undefined ? { maxFee } : {}) })));
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

// ---- NEP-518 `rlp_execute` (SD-097) -------------------------------------------------------------------------------------------------------------------------------------------------------
// A 0x key controls the eth-implicit NEAR account with the same address. A signed Ethereum transaction (EIP-1559, chain id 398 on testnet, 397 on mainnet) that is sent to `rlp_execute` on that account makes
// the account call any NEAR contract, and the contract sees the 0x account as `predecessor_account_id`. Recipe and on-chain proof: contracts/docs/spike-nep518.md and docs/testnet-epochs/sd094-auto-settle-run.json.

export const NEP518_CHAIN_ID = { testnet: 398, mainnet: 397 } as const;
/** Selector of `functionCall(string,string,bytes,uint64,uint32)` of the wallet contract. */
export const NEP518_FUNCTION_CALL_SELECTOR = "0x6179b707" as const;
const NEP518_FUNCTION_CALL_ABI = parseAbi(["function functionCall(string receiver_id, string method_name, bytes args, uint64 gas, uint32 yocto_near)"]);

/** A NEAR function call as the wallet contract takes it. `args` is the JSON object of the call; `yoctoNear` is the NEAR attached (1 for the methods that need exactly one yocto). */
export interface Nep518Call {
  receiverId: string;
  methodName: string;
  args: object;
  gas: bigint;
  yoctoNear: number;
}

/** The `to` address of the Ethereum transaction: the last 20 bytes of `keccak256(target account id)`. */
export const nep518ToAddress = (target: string): `0x${string}` => `0x${keccak256(stringToBytes(target)).slice(26)}`;

/** ABI data of `functionCall(receiver_id, method_name, args, gas, yocto_near)`. */
export function encodeNep518FunctionCall(call: Nep518Call): Hex {
  return encodeFunctionData({ abi: NEP518_FUNCTION_CALL_ABI, functionName: "functionCall", args: [call.receiverId, call.methodName, toHex(stringToBytes(JSON.stringify(call.args))), call.gas, call.yoctoNear] });
}

/** Inverse of `encodeNep518FunctionCall`; throws when the data is not a `functionCall`. */
export function decodeNep518FunctionCall(data: Hex): Nep518Call {
  const decoded = decodeFunctionData({ abi: NEP518_FUNCTION_CALL_ABI, data });
  const [receiverId, methodName, args, gas, yoctoNear] = decoded.args;
  return { receiverId, methodName, args: JSON.parse(hexToString(args)) as object, gas, yoctoNear };
}

/**
 * NEAR attached to a wallet call is `value` (wei, 1 wei = 1e6 yoctoNEAR) plus the `uint32` yocto remainder (SD-099). Splits any yoctoNEAR amount in the two:
 * 1 yocto stays `{ valueWei: 0n, yoctoNear: 1 }`, the 0.35 NEAR of `join` becomes `{ valueWei: 350000000000000000n, yoctoNear: 0 }`.
 */
export function nep518Attach(yocto: bigint): { valueWei: bigint; yoctoNear: number } {
  if (yocto < 0n) throw new Error("the attached NEAR cannot be negative");
  return { valueWei: yocto / 1_000_000n, yoctoNear: Number(yocto % 1_000_000n) };
}

/** What is needed to sign: `target` is the NEAR account the wallet transaction is aimed at (the contract that is called), `nonce` is `get_nonce` of the eth-implicit account. */
export interface Nep518SignInput {
  privateKey: string;
  target: string;
  nonce: number;
  call: Nep518Call;
  chainId?: number;
  /** Ethereum gas limit of the transaction (not NEAR gas); default 1,000,000 as in the testnet run. */
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  /** Wei sent with the call (1 wei = 1e6 yoctoNEAR; see `nep518Attach`), paid from the balance of the eth-implicit account. Default 0. */
  valueWei?: bigint;
}

/** Arguments of `rlp_execute` on the eth-implicit account: `{ target, tx_bytes_b64 }`. */
export interface Nep518RlpExecuteArgs {
  target: string;
  tx_bytes_b64: string;
}

/** Signs the EIP-1559 transaction for `rlp_execute`. The key never leaves this function; the error for a bad key does not contain it. */
export async function signNep518Transaction(input: Nep518SignInput): Promise<Nep518RlpExecuteArgs> {
  if (!isEvmPrivateKey(input.privateKey)) throw new Error("EVM private key must be 0x followed by 64 hex characters");
  const account = privateKeyToAccount(input.privateKey);
  const signed = await account.signTransaction({
    type: "eip1559",
    chainId: input.chainId ?? NEP518_CHAIN_ID.testnet,
    nonce: input.nonce,
    to: nep518ToAddress(input.target),
    value: input.valueWei ?? 0n,
    data: encodeNep518FunctionCall(input.call),
    gas: input.gasLimit ?? 1_000_000n,
    maxFeePerGas: input.maxFeePerGas ?? 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
  });
  return { target: input.target, tx_bytes_b64: btoa(String.fromCharCode(...hexToBytes(signed))) };
}

/** Reads a signed `rlp_execute` transaction back: the address that signed it, the fields, and the NEAR call inside. */
export async function decodeNep518Transaction(txBytesB64: string): Promise<{
  signer: `0x${string}`; chainId: number | undefined; type: string; nonce: number; to: `0x${string}` | null | undefined; value: bigint; gasLimit: bigint | undefined; maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined; call: Nep518Call;
}> {
  const serialized = bytesToHex(Uint8Array.from(atob(txBytesB64), (c) => c.charCodeAt(0)));
  const tx = parseTransaction(serialized);
  const signer = await recoverTransactionAddress({ serializedTransaction: serialized as never });
  return {
    signer: signer.toLowerCase() as `0x${string}`, chainId: tx.chainId, type: tx.type ?? "legacy", nonce: tx.nonce ?? 0, to: tx.to, value: tx.value ?? 0n, gasLimit: tx.gas,
    // RLP leaves a zero out, so a missing priority fee of an EIP-1559 transaction means 0
    maxFeePerGas: "maxFeePerGas" in tx ? tx.maxFeePerGas : undefined, maxPriorityFeePerGas: tx.type === "eip1559" ? (tx.maxPriorityFeePerGas ?? 0n) : undefined, call: decodeNep518FunctionCall(tx.data ?? "0x"),
  };
}
