// Klien JSON-RPC NEAR dengan failover antar endpoint dan timeout per panggilan (ADR-25).
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnavailableError";
  }
}

/** Jawaban RPC yang sah tetapi berisi error (mis. kontrak panic); tidak memicu failover. */
export class RpcError extends Error {
  constructor(readonly method: string, readonly detail: unknown) {
    super(`RPC ${method} error: ${JSON.stringify(detail)}`);
    this.name = "RpcError";
  }
}

export type NearRpcOptions = {
  urls: readonly string[];
  /** Timeout tiap percobaan ke satu endpoint. */
  timeoutMs: number;
  fetch?: typeof fetch;
  /**
   * Public RPC endpoints answer HTTP 429 when asked too often. With this option an endpoint that answers 429 is asked again up to
   * `attempts` more times, after `baseMs`, `2 * baseMs`, ... (or the `Retry-After` seconds, whichever is longer) before failover.
   * Off by default.
   */
  rateLimit?: { attempts: number; baseMs: number };
};

const FAILOVER_CAUSES = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR"]);

export class NearRpc {
  readonly #urls: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #rateLimit: { attempts: number; baseMs: number };

  constructor(options: NearRpcOptions) {
    if (options.urls.length === 0) throw new Error("NearRpc needs at least one URL");
    this.#urls = options.urls;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#rateLimit = options.rateLimit ?? { attempts: 0, baseMs: 0 };
  }

  #post(url: string, method: string, params: unknown): Promise<Response> {
    return this.#fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method, params }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  /** Coba endpoint berurutan; `ChainUnavailableError` bila semuanya gagal. */
  async call<T>(method: string, params: unknown): Promise<T> {
    const failures: string[] = [];
    for (const url of this.#urls) {
      try {
        let response = await this.#post(url, method, params);
        for (let retry = 1; response.status === 429 && retry <= this.#rateLimit.attempts; retry += 1) {
          const advised = Number(response.headers.get("retry-after")) * 1000;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.max(this.#rateLimit.baseMs * 2 ** (retry - 1), Number.isFinite(advised) ? advised : 0)));
          response = await this.#post(url, method, params);
        }
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        const body = (await response.json()) as { result?: T; error?: { cause?: { name?: string } } };
        if (body.error) {
          if (FAILOVER_CAUSES.has(body.error.cause?.name ?? "")) {
            failures.push(`${url}: ${body.error.cause?.name}`);
            continue;
          }
          throw new RpcError(method, body.error);
        }
        return body.result as T;
      } catch (error) {
        if (error instanceof RpcError) throw error;
        failures.push(`${url}: ${(error as Error).name === "TimeoutError" ? `timeout ${this.#timeoutMs} ms` : (error as Error).message}`);
      }
    }
    throw new ChainUnavailableError(`all RPC endpoints failed (${failures.join("; ")})`);
  }

  /** Panggil view method kontrak; hasil di-parse sebagai JSON. */
  async view<T>(contractId: string, methodName: string, args: unknown = {}): Promise<T> {
    const result = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }
}
