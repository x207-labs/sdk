// Contract views through NEAR JSON-RPC with failover between endpoints (RPC_URLS: FastNEAR then rpc.mainnet.near.org).
import { RPC_URLS } from "../constants.js";
import type { AccountId } from "../types.js";
import type { CircleViewFn } from "./client.js";

export type CircleViewOptions = {
  circleContract: AccountId;
  rpcUrls?: readonly string[];
  fetch?: typeof fetch;
  /** Timeout per endpoint (default 10000 ms, ADR-25). */
  timeoutMs?: number;
};

/** `CircleViewFn` for one circle contract. Throws if all endpoints fail or the contract panics. */
export function createCircleViewFn(options: CircleViewOptions): CircleViewFn {
  const urls = options.rpcUrls ?? RPC_URLS;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (methodName, args) => {
    const failures: string[] = [];
    for (const url of urls) {
      try {
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
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: { result: number[]; error?: string }; error?: unknown };
        if (body.error) throw new Error(`RPC error in view ${methodName}: ${JSON.stringify(body.error)}`);
        if (body.result?.error) throw new Error(`view ${methodName} failed: ${body.result.error}`);
        const bytes = body.result?.result;
        if (!bytes) throw new Error(`view ${methodName}: RPC answer without result`);
        return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      } catch (error) {
        if ((error as Error).message.startsWith("RPC error") || (error as Error).message.startsWith("view ")) throw error;
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }
    throw new Error(`all RPC endpoints failed (${failures.join("; ")})`);
  };
}
