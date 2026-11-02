// Relayer on-chain untuk `RegistrationScheduler` (SD-028): menandatangani dan mengirim
// `register_cumulative(voucher, signature)` dari akun relayer, serta membaca `last_seq` dan `get_epoch`.
import { KeyPair, PublicKey, type KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, createTransaction, encodeTransaction } from "@near-js/transactions";
import { base58Decode, type AccountId, type ContractAbi, type Ed25519Signature, type UnsignedVoucher } from "@x207/core";
import { GasKeyLanes, signGasKeyTransaction } from "./gas-key.js";
import type { NearRpc } from "./rpc.js";
import type { RegisterMode, RegistrationChain } from "./scheduler.js";

/** Gas `register_cumulative` (100 TGas, sama dengan test gas di contracts). */
export const REGISTER_GAS = 100_000_000_000_000n;

type Outcome = { status: unknown; logs?: string[] };
type TxResult = { status?: unknown; transaction_outcome?: { outcome: Outcome }; receipts_outcome?: Array<{ outcome: Outcome }> };

/** Pesan kegagalan transaksi (termasuk teks panic `ERR_*` kontrak), atau `null` bila sukses. */
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
  /** Dipanggil dengan log semua receipt tiap transaksi yang selesai (mis. untuk event `voucher_registered`). */
  onLogs?: (logs: string[]) => void;
  /** Dipanggil dengan hash tiap transaksi registrasi yang dikirim. */
  onHash?: (hash: string) => void;
  /**
   * Gas key (NEP-611, SD-031): `privateKey` adalah gas key yang terpasang di `relayer.accountId` dan `lanes` jumlah jalur nonce yang dipakai
   * (1..1024). Dengan ini `register` boleh dipanggil paralel, satu jalur per transaksi, tanpa bentrok nonce. Tanpa ini relayer memakai
   * kunci akses biasa dan transaksi harus berurutan.
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

  /** Jumlah registrasi yang boleh berjalan bersamaan (jalur gas key), 1 untuk kunci akses biasa. */
  get concurrency(): number {
    return this.#lanes?.count ?? 1;
  }

  /** Kirim satu transaksi dan tunggu final; melempar `Error` dengan pesan panic kontrak bila gagal. */
  async register(voucher: UnsignedVoucher, signature: Ed25519Signature, mode: RegisterMode, bundleId?: number): Promise<void> {
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
          if (value === undefined) throw new Error(`gas key ${this.#gasPublicKey} tidak punya jalur nonce ${lane}`);
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

  /** Kirim byte transaksi bertanda tangan, tunggu final; melempar `Error` dengan pesan panic kontrak bila gagal. */
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
