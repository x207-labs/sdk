// One helper for the public NEAR RPC endpoints (UM-191). They answer 429 or 5xx under load, and `rpc.testnet.near.org` is deprecated
// (it answers 429 to every transaction). A caller lists its endpoints, the helper asks them in order, asks the same endpoint
// again after a pause when it answered 429, and hands over to the next endpoint when it is down.

/** Testnet endpoints in the order they are asked: FastNEAR, then dRPC. `rpc.testnet.near.org` is not on the list (deprecated). */
export const TESTNET_RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"] as const;

/** An endpoint that answered with an HTTP error status. */
export class RpcHttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`${url}: HTTP ${status}`);
    this.name = "RpcHttpError";
  }
}

/** The endpoint refused because of its rate limit (HTTP 429, JSON-RPC code -429, or the words "rate limit" / "HTTP 429" in a transport message, never in a contract panic or action error). Nothing was executed. */
export function isRateLimited(error: unknown): boolean {
  if (error instanceof RpcHttpError) return error.status === 429;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -429 || code === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  // A-SD-07: a contract panic or a failed action means the transaction may have run, and its text can hold the digits 429 ("ERR_EVM_NONCE: nonce 429 expected 430"). Never a rate limit.
  if (/\bERR_[A-Z0-9_]+|smart contract panicked|Action #\d+|ExecutionError/i.test(message)) return false;
  // "429" counts only as a status ("HTTP 429", "status 429", "code -429"), never as a bare number
  return /\b(?:HTTP|status|code)[\s:=]*-?429\b|rate.?limit/i.test(message);
}

/** The endpoint may work for another one to ask: rate limited, HTTP 5xx, timeout, or no connection. A contract panic is not. */
export function isEndpointDown(error: unknown): boolean {
  if (isRateLimited(error)) return true;
  if (error instanceof RpcHttpError) return error.status >= 500;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|aborted|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket|Internal server error/i.test(message);
}

export type FailoverOptions = {
  /** Which errors move on to the next endpoint. Default `isEndpointDown`. Use `isRateLimited` for a transaction: after any other error it may have been executed. */
  failoverOn?: (error: unknown) => boolean;
  /** Extra asks of the same endpoint after a rate limit answer (default 2), after `baseMs`, `2 * baseMs`, ... */
  rateLimitRetries?: number;
  /** First pause in ms (default 500). */
  baseMs?: number;
  /** Pause function (tests). */
  sleep?: (ms: number) => Promise<void>;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run(url)` against the endpoints in order. A rate limit answer is asked again on the same endpoint after a growing pause;
 * when the error still qualifies (`failoverOn`) the next endpoint is asked; any other error is thrown at once.
 * When every endpoint failed the error says which endpoint answered what: `all RPC endpoints failed (url: reason; ...)`.
 */
export async function withRpcFailover<T>(urls: readonly string[], run: (url: string) => Promise<T>, options: FailoverOptions = {}): Promise<T> {
  if (urls.length === 0) throw new Error("all RPC endpoints failed (no endpoint given)");
  const failoverOn = options.failoverOn ?? isEndpointDown;
  const retries = options.rateLimitRetries ?? 2;
  const baseMs = options.baseMs ?? 500;
  const sleep = options.sleep ?? pause;
  const failures: string[] = [];
  for (const url of urls) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run(url);
      } catch (error) {
        if (!failoverOn(error)) throw error;
        if (isRateLimited(error) && attempt < retries) {
          await sleep(baseMs * 2 ** attempt);
          continue;
        }
        failures.push(error instanceof RpcHttpError ? error.message : `${url}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }
  throw new Error(`all RPC endpoints failed (${failures.join("; ")})`);
}
