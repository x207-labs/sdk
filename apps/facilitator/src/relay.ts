// On-chain relayer for `RegistrationScheduler` (SD-028): signs and sends
// `register_cumulative(voucher, signature)` from the relayer account, and reads `last_seq` and `get_epoch`.
import { KeyPair, PublicKey, type KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, createTransaction, encodeTransaction } from "@near-js/transactions";
import { base58Decode, type AccountId, type ContractAbi, type Signature, type UnsignedVoucher } from "@x207/core";
import { GasKeyLanes, signGasKeyTransaction } from "./gas-key.js";
import type { NearRpc } from "./rpc.js";
import type { RegisterMode, RegistrationChain } from "./scheduler.js";

/** Gas for `register_cumulative` (100 TGas, same as the gas test in contracts). */
export const REGISTER_GAS = 100_000_000_000_000n;

type Outcome = { status: unknown; logs?: string[] };
type TxResult = { status?: unknown; transaction_outcome?: { outcome: Outcome }; receipts_outcome?: Array<{ outcome: Outcome }> };

/** Transaction failure message (including the contract's `ERR_*` panic text), or `null` on success. */
export function transactionFailure(result: TxResult): string | null {
  const outcomes = [result.transaction_outcome?.outcome, ...(result.receipts_outcome ?? []).map((r) => r.outcome)];
  for (const outcome of outcomes) {
    const status = outcome?.status as { Failure?: unknown } | undefined;
    if (status && typeof status === "object" && "Failure" in status) return JSON.stringify(status.Failure);
  }
  const final = result.status as { Failure?: unknown } | undefined;
  if (final && typeof final === "object" && "Failure" in final) return JSON.stringify(final.Failure);
  return null;
}

export type NearRelayOptions = {
  rpc: NearRpc;
  circleContract: AccountId;
  relayer: { accountId: AccountId; privateKey: string };
  /** Called with the logs of all receipts of each finished transaction (e.g. for the `voucher_registered` event). */
  onLogs?: (logs: string[]) => void;
  /** Called with the hash of each registration transaction sent. */
  onHash?: (hash: string) => void;
  /**
   * Gas key (NEP-611, SD-031): `privateKey` is the gas key installed on `relayer.accountId` and `lanes` the number of nonce lanes used
   * (1..1024). With this `register` may be called in parallel, one lane per transaction, with no nonce clash. Without it the relayer uses
   * an ordinary access key and transactions must be sequential.
   */
  gasKey?: { privateKey: string; lanes: number };
};

export class NearRegistrationChain implements RegistrationChain {
  readonly #signer: KeyPairSigner;
  readonly #publicKey: PublicKey;
  readonly #lanes: GasKeyLanes | undefined;
  readonly #gasPublicKey: string | undefined;

  constructor(private readonly options: NearRelayOptions) {
    const key = KeyPair.fromString(options.relayer.privateKey as KeyPairString);
    this.#signer = new KeyPairSigner(key);
    this.#publicKey = key.getPublicKey();
    if (options.gasKey) {
      this.#lanes = new GasKeyLanes(options.gasKey.lanes);
      this.#gasPublicKey = KeyPair.fromString(options.gasKey.privateKey as KeyPairString).getPublicKey().toString();
    }
  }

  /** Number of registrations that may run at the same time (gas key lanes), 1 for an ordinary access key. */
  get concurrency(): number {
    return this.#lanes?.count ?? 1;
  }

  /** Send one transaction and wait for final; throws an `Error` with the contract's panic message on failure. */
  async register(voucher: UnsignedVoucher, signature: Signature, mode: RegisterMode, bundleId?: number): Promise<void> {
    const { rpc, circleContract, relayer } = this.options;
    const method = bundleId !== undefined ? "register_in_bundle" : mode === "cumulative" ? "register_cumulative" : "register_voucher";
    const args = bundleId !== undefined ? { bundle_id: bundleId, voucher, signature } : { voucher, signature };
    if (this.#lanes) {
      await this.#lanes.run(
        async (lane) => {
          const nonces = await rpc.call<{ nonces: Array<number | string> }>("query", {
            request_type: "view_gas_key_nonces", finality: "optimistic", account_id: relayer.accountId, public_key: this.#gasPublicKey,
          });
          const value = nonces.nonces[lane];
          if (value === undefined) throw new Error(`gas key ${this.#gasPublicKey} has no nonce lane ${lane}`);
          return BigInt(value);
        },
        async (lane, nonce) => {
          const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
          const signed = signGasKeyTransaction(
            { signerId: relayer.accountId, receiverId: circleContract, nonce, nonceIndex: lane, blockHash: base58Decode(block.header.hash), methodName: method, args, gas: REGISTER_GAS, deposit: 0n },
            this.options.gasKey!.privateKey,
          );
          await this.#send(signed.bytes);
        },
      );
      return;
    }
    const key = await rpc.call<{ nonce: number }>("query", {
      request_type: "view_access_key", finality: "optimistic", account_id: relayer.accountId,
      public_key: this.#publicKey.toString(),
    });
    const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
    const transaction = createTransaction(
      relayer.accountId, this.#publicKey, circleContract, BigInt(key.nonce) + 1n,
      [actionCreators.functionCall(method, args, REGISTER_GAS, 0n)],
      base58Decode(block.header.hash),
    );
    const [, signed] = await this.#signer.signTransaction(transaction);
    await this.#send(Buffer.from(encodeTransaction(signed)));
  }

  /** Send the signed transaction bytes and wait for final; throws an `Error` with the contract's panic message on failure. */
  async #send(bytes: Uint8Array): Promise<void> {
    const result = await this.options.rpc.call<TxResult>("send_tx", { signed_tx_base64: Buffer.from(bytes).toString("base64"), wait_until: "FINAL" });
    this.options.onHash?.(String((result as { transaction?: { hash?: string } }).transaction?.hash ?? ""));
    this.options.onLogs?.([result.transaction_outcome?.outcome, ...(result.receipts_outcome ?? []).map((r) => r.outcome)].flatMap((o) => o?.logs ?? []));
    const failure = transactionFailure(result);
    if (failure) throw new Error(failure);
  }

  lastSeq(payer: AccountId, payee: AccountId, epoch: number): Promise<number> {
    return this.options.rpc.view<number>(this.options.circleContract, "last_seq", { payer, payee, epoch });
  }

  getEpoch(epoch: number): Promise<ContractAbi.EpochView | null> {
    return this.options.rpc.view<ContractAbi.EpochView | null>(this.options.circleContract, "get_epoch", { epoch });
  }
}

/**
 * Sends one transaction at a time from `account` with an ordinary access key (SD-089: the EVM relayer). It uses its own key, so it does not share the nonce of the registration relayer;
 * a nonce error is tried again once with a new nonce.
 */
export class NearContractCaller {
  readonly #signer: KeyPairSigner;
  readonly #publicKey: PublicKey;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { rpc: NearRpc; circleContract: AccountId; account: { accountId: AccountId; privateKey: string }; onHash?: (hash: string) => void }) {
    const key = KeyPair.fromString(options.account.privateKey as KeyPairString);
    this.#signer = new KeyPairSigner(key);
    this.#publicKey = key.getPublicKey();
  }

  call(method: string, args: Record<string, unknown>, deposit: bigint, receiverId?: string, gas = 100_000_000_000_000n): Promise<{ hash: string }> {
    const run = this.#tail.then(() => this.#once(method, args, deposit, gas, receiverId).catch((error) => {
      if (/InvalidNonce/.test(String(error instanceof Error ? error.message : error))) return this.#once(method, args, deposit, gas, receiverId);
      throw error;
    }));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #once(method: string, args: Record<string, unknown>, deposit: bigint, gas: bigint, receiverId?: string): Promise<{ hash: string }> {
    const { rpc, circleContract, account } = this.options;
    const key = await rpc.call<{ nonce: number }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: account.accountId, public_key: this.#publicKey.toString() });
    const block = await rpc.call<{ header: { hash: string } }>("block", { finality: "final" });
    const transaction = createTransaction(
      account.accountId, this.#publicKey, receiverId ?? circleContract, BigInt(key.nonce) + 1n,
      [actionCreators.functionCall(method, args, gas, deposit)], base58Decode(block.header.hash),
    );
    const [, signed] = await this.#signer.signTransaction(transaction);
    const result = await rpc.call<TxResult>("send_tx", { signed_tx_base64: Buffer.from(encodeTransaction(signed)).toString("base64"), wait_until: "FINAL" });
    const hash = String((result as { transaction?: { hash?: string } }).transaction?.hash ?? "");
    this.options.onHash?.(hash);
    const failed = transactionFailure(result);
    if (failed) throw new Error(failed);
    return { hash };
  }
}
