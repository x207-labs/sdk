// Penanda tangan transaksi NEAR untuk helper kontrak (`onboardMember`, `requestExit`, ...), entry terpisah
// `@x207/core/signer` supaya entry utama tidak menarik near-api-js (TC-SD-021-08).
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { contractErrorCode } from "./contract/client.js";
import type { CircleViewFn } from "./contract/client.js";
import type { ContractCall } from "./contract/settlement.js";

export type NearSenderOptions = {
  rpcUrl: string;
  accountId: string;
  /** Kunci akses akun (`ed25519:...`), bukan kunci voucher. */
  secretKey: `ed25519:${string}`;
};

/** Kesalahan transaksi dengan kode `ERR_*` kontrak bila ada. */
export class ContractCallError extends Error {
  readonly code: string | null;
  constructor(readonly call: Pick<ContractCall, "receiverId" | "methodName">, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${call.receiverId}.${call.methodName} gagal: ${message}`);
    this.name = "ContractCallError";
    this.code = contractErrorCode(cause);
  }
}

const DEFAULT_GAS = 100_000_000_000_000n;

/**
 * `sendCall` untuk `onboardMember`: menandatangani dengan kunci akun, menunggu final, dan mengembalikan
 * nilai sukses (JSON). Melempar `ContractCallError` bila transaksi gagal.
 */
export function createNearSender(options: NearSenderOptions): (call: ContractCall) => Promise<unknown> {
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const account = new Account(options.accountId, provider, KeyPairSigner.fromSecretKey(options.secretKey));
  return async (call) => {
    try {
      const result = await account.callFunctionRaw({
        contractId: call.receiverId,
        methodName: call.methodName,
        args: call.args,
        deposit: call.deposit,
        gas: call.gas ?? DEFAULT_GAS,
        waitUntil: "FINAL",
      });
      const final = (result as unknown as { status?: { SuccessValue?: string } }).status;
      return final?.SuccessValue ? JSON.parse(Buffer.from(final.SuccessValue, "base64").toString("utf8")) : undefined;
    } catch (error) {
      throw new ContractCallError(call, error);
    }
  };
}

/** `CircleViewFn` lewat satu RPC (tanpa failover); untuk skrip dan test. */
export function createNearView(rpcUrl: string, contractId: string): CircleViewFn {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return async (methodName, args) => {
    const result = await provider.callFunction({
      contractId, method: methodName, args: args as Record<string, unknown>, blockQuery: { finality: "final" },
    });
    return result ?? null;
  };
}
