// NEAR transaction signer for the contract helpers (`onboardMember`, `requestExit`, ...), a separate entry
// `@x207/core/signer` so the main entry does not pull in near-api-js (TC-SD-021-08).
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { contractErrorCode } from "./contract/client.js";
import { isRateLimited, withRpcFailover, type FailoverOptions } from "./rpc-failover.js";
import type { CircleViewFn } from "./contract/client.js";
import type { ContractCall } from "./contract/settlement.js";

export type NearSenderOptions = {
  rpcUrl: string;
  /** More endpoints, asked after `rpcUrl` when it answers a rate limit (UM-191). Only a rate limit moves on: after any other error the transaction may have been executed. */
  fallbackRpcUrls?: readonly string[];
  /** Pauses and retries after a rate limit answer (tests pass `sleep`). */
  failover?: Pick<FailoverOptions, "rateLimitRetries" | "baseMs" | "sleep">;
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
  const signer = KeyPairSigner.fromSecretKey(options.secretKey);
  const urls = [options.rpcUrl, ...(options.fallbackRpcUrls ?? [])];
  return async (call) => {
    try {
      const result = await withRpcFailover(
        urls,
        (url) =>
          new Account(options.accountId, new JsonRpcProvider({ url }), signer).callFunctionRaw({
            contractId: call.receiverId,
            methodName: call.methodName,
            args: call.args,
            deposit: call.deposit,
            gas: call.gas ?? DEFAULT_GAS,
            waitUntil: "FINAL",
          }),
        { failoverOn: isRateLimited, ...(options.failover ?? {}) },
      );
      options.onTx?.({ methodName: call.methodName, hash: (result as unknown as { transaction: { hash: string } }).transaction.hash });
      const final = (result as unknown as { status?: { SuccessValue?: string } }).status;
      return final?.SuccessValue ? JSON.parse(Buffer.from(final.SuccessValue, "base64").toString("utf8")) : undefined;
    } catch (error) {
      throw new ContractCallError(call, error);
    }
  };
}

/** `CircleViewFn` through one RPC or a list of them (UM-191: a rate limit or a dead endpoint moves on to the next); for scripts and tests. */
export function createNearView(rpcUrl: string | readonly string[], contractId: string, failover: FailoverOptions = {}): CircleViewFn {
  const urls = typeof rpcUrl === "string" ? [rpcUrl] : rpcUrl;
  return async (methodName, args) =>
    withRpcFailover(
      urls,
      async (url) => {
        const result = await new JsonRpcProvider({ url }).callFunction({
          contractId, method: methodName, args: args as Record<string, unknown>, blockQuery: { finality: "final" },
        });
        return result ?? null;
      },
      failover,
    );
}
