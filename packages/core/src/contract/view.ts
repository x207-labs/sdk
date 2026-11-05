// Contract views through NEAR JSON-RPC with failover between endpoints (RPC_URLS: FastNEAR then rpc.mainnet.near.org).
import { RPC_URLS } from "../constants.js";
import { RpcHttpError, isEndpointDown, withRpcFailover, type FailoverOptions } from "../rpc-failover.js";
import type { AccountId } from "../types.js";
import type { CircleViewFn } from "./client.js";

export type CircleViewOptions = {
  circleContract: AccountId;
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** Timeout per endpoint (default 10000 ms, ADR-25). */
  timeoutMs?: number;
  /** Pauses and retries after a rate limit answer (UM-191); tests pass `sleep`. */
  failover?: Pick<FailoverOptions, "rateLimitRetries" | "baseMs" | "sleep">;
};

/** `CircleViewFn` for one circle contract. Throws if all endpoints fail or the contract panics. */
export function createCircleViewFn(options: CircleViewOptions): CircleViewFn {
  const urls = options.rpcUrls ?? RPC_URLS;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (methodName, args) =>
    withRpcFailover(urls, async (url) => {
      {
        // one ask of one endpoint
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: "x207", method: "query",
            params: {
              request_type: "call_function", finality: "final", account_id: options.circleContract,
              method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new RpcHttpError(response.status, url);
        const body = (await response.json()) as { result?: { result: number[]; error?: string }; error?: { code?: number } };
        // FastNEAR answers its rate limit as a JSON-RPC error with code -429: that is the endpoint, not the contract.
        if (body.error && body.error.code === -429) throw new RpcHttpError(429, url);
        if (body.error) throw new ViewFailure(`RPC error in view ${methodName}: ${JSON.stringify(body.error)}`);
        if (body.result?.error) throw new ViewFailure(`view ${methodName} failed: ${body.result.error}`);
        const bytes = body.result?.result;
        if (!bytes) throw new ViewFailure(`view ${methodName}: RPC answer without result`);
        return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      }
    }, { failoverOn: (error) => !(error instanceof ViewFailure) && isEndpointDown(error), ...(options.failover ?? {}) });
}

/** The contract or the RPC answered and said no: another endpoint would say the same, so no failover. */
class ViewFailure extends Error {}
