// NEAR transaction signer for the contract helpers (`onboardMember`, `requestExit`, ...), a separate entry
// `@x207/core/signer` so the main entry does not pull in near-api-js (TC-SD-021-08).
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { contractErrorCode } from "./contract/client.js";
import type { CircleViewFn } from "./contract/client.js";
import type { ContractCall } from "./contract/settlement.js";

export type NearSenderOptions = {
  rpcUrl: string;
  accountId: string;
  /** Account access key (`ed25519:...`), not the voucher key. */
  secretKey: `ed25519:${string}`;
  /** Called with the hash of each finished transaction (for demo logs). */
  onTx?: (info: { methodName: string; hash: string }) => void;
};

/** Transaction error with the contract `ERR_*` code when there is one. */
export class ContractCallError extends Error {
  readonly code: string | null;
  constructor(readonly call: Pick<ContractCall, "receiverId" | "methodName">, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${call.receiverId}.${call.methodName} failed: ${message}`);
    this.name = "ContractCallError";
    this.code = contractErrorCode(cause);
  }
}

const DEFAULT_GAS = 100_000_000_000_000n;

/**
 * `sendCall` for `onboardMember`: signs with the account key, waits for finality, and returns
 * the success value (JSON). Throws `ContractCallError` if the transaction fails.
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
      options.onTx?.({ methodName: call.methodName, hash: (result as unknown as { transaction: { hash: string } }).transaction.hash });
      const final = (result as unknown as { status?: { SuccessValue?: string } }).status;
      return final?.SuccessValue ? JSON.parse(Buffer.from(final.SuccessValue, "base64").toString("utf8")) : undefined;
    } catch (error) {
      throw new ContractCallError(call, error);
    }
  };
}

/** `CircleViewFn` through a single RPC (no failover); for scripts and tests. */
export function createNearView(rpcUrl: string, contractId: string): CircleViewFn {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return async (methodName, args) => {
    const result = await provider.callFunction({
      contractId, method: methodName, args: args as Record<string, unknown>, blockQuery: { finality: "final" },
    });
    return result ?? null;
  };
}
