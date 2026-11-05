// Reference facilitator routes (Spec Binding x402 section 8): /verify, /settle, /supported.
import { Hono } from "hono";
import type {
  SettleRequest,
  SettleResponse,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
} from "@x402/core/types";
import type { AccountId } from "@x207/core";
import { assertCircleId } from "@x207/scheme";
import { EvmRelayError, type EvmRelay } from "./evm-relay.js";
import { RateLimiter, type RateLimitOptions } from "./exact-guard.js";
import { ChainUnavailableError } from "./rpc.js";

export type PairStateQuery = { network: string; payer: string; payee: string; epoch: number };

/** Response of `GET /x207/pair-state` (Spec Binding x402 8.5, K-29). */
export type PairStateResponse = PairStateQuery & {
  lastSeq: number;
  lastCumulativeAmount: string;
  source: "pending" | "onchain" | "none";
};

/** Business logic behind the routes; filled by SD-024 (`verify`), SD-026 (`settle`), SD-032 (`supported`, `pairState`). */
export type FacilitatorService = {
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  settle(request: SettleRequest): Promise<SettleResponse>;
  supported(): Promise<SupportedResponse>;
  pairState?(query: PairStateQuery): Promise<PairStateResponse>;
  /** Forget the cached debt reads of `payer` after a registration (only when `chainCache` is on). */
  invalidatePayer?(circleContract: AccountId, payer: AccountId): void;
};

export const RETRY_AFTER_SECONDS = 5;

export class InvalidRequestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Body of `/verify` and `/settle`; the x207 network must pass the CAIP-2 regex. */
function parsePaymentRequest(body: unknown): VerifyRequest {
  if (!isRecord(body)) throw new InvalidRequestError("body must be a JSON object");
  if (typeof body.x402Version !== "number") throw new InvalidRequestError("x402Version is required");
  if (!isRecord(body.paymentPayload)) throw new InvalidRequestError("paymentPayload is required");
  const requirements = body.paymentRequirements;
  if (!isRecord(requirements)) throw new InvalidRequestError("paymentRequirements is required");
  const { network } = requirements;
  if (typeof network !== "string") throw new InvalidRequestError("paymentRequirements.network is required");
  if (network.startsWith("x207:")) {
    try {
      assertCircleId(network);
    } catch (error) {
      throw new InvalidRequestError((error as Error).message);
    }
  }
  return body as unknown as VerifyRequest;
}

/** Query of `GET /x207/pair-state`; all parameters are required and the network must pass the CAIP-2 regex. */
function parsePairStateQuery(query: Record<string, string | undefined>): PairStateQuery {
  const { network, payer, payee, epoch } = query;
  if (!network || !payer || !payee || !epoch) throw new InvalidRequestError("network, payer, payee and epoch are required");
  try {
    assertCircleId(network);
  } catch (error) {
    throw new InvalidRequestError((error as Error).message);
  }
  if (!/^[1-9]\d*$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw new InvalidRequestError(`epoch must be an integer >= 1, got "${epoch}"`);
  }
  return { network, payer, payee, epoch: Number(epoch) };
}

export type AppOptions = {
  /** Per client on `/verify` and `/settle` (default `RATE_LIMIT_DEFAULTS`); `false` turns it off. The client is the address of the socket, or the first `x-forwarded-for` when `trustProxy`. */
  rateLimit?: RateLimitOptions | false;
  trustProxy?: boolean;
  /** SD-089: relayer for EVM agents; with it the routes `POST /evm/join`, `/evm/claim`, `/evm/exit`, `/evm/withdraw` and `/evm/auto-settle` exist. */
  evm?: EvmRelay;
};

export function createApp(service: FacilitatorService, options: AppOptions = {}): Hono {
  const app = new Hono();
  const limiter = options.rateLimit === false ? undefined : new RateLimiter(options.rateLimit);
  if (limiter) {
    const limited = async (c: import("hono").Context, next: () => Promise<void>) => {
      const forwarded = options.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
      const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
      const wait = limiter.hit(forwarded || socket || "unknown");
      if (wait > 0) {
        c.header("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
        return c.json({ error: "rate_limited", message: "too many requests" }, 429);
      }
      await next();
    };
    app.use("/verify", limited);
    app.use("/settle", limited);
    if (options.evm) app.use("/evm/*", limited);
  }

  const handlePayment = (run: (request: VerifyRequest) => Promise<unknown>) => async (c: import("hono").Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new InvalidRequestError("body is not JSON");
    }
    return c.json(await run(parsePaymentRequest(body)) as object, 200);
  };

  app.post("/verify", handlePayment((request) => service.verify(request)));
  app.post("/settle", handlePayment((request) => service.settle(request)));
  if (options.evm) {
    const evm = options.evm;
    const route = (run: (body: unknown) => Promise<unknown>) => async (c: import("hono").Context) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new EvmRelayError(400, "invalid_request", "body is not JSON");
      }
      return c.json(await run(body) as object, 200);
    };
    app.post("/evm/join", route((body) => evm.join(body)));
    app.post("/evm/claim", route((body) => evm.claim(body)));
    app.post("/evm/exit", route((body) => evm.exit(body)));
    app.post("/evm/withdraw", route((body) => evm.withdraw(body)));
    app.post("/evm/auto-settle", route((body) => evm.autoSettle(body)));
  }
  app.get("/supported", async (c) => c.json(await service.supported(), 200));
  app.get("/x207/pair-state", async (c) => {
    if (!service.pairState) return c.json({ error: "not_found" }, 404);
    return c.json(await service.pairState(parsePairStateQuery(c.req.query())), 200);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((error, c) => {
    if (error instanceof EvmRelayError) {
      if (error.retryAfterSeconds !== undefined) c.header("Retry-After", String(error.retryAfterSeconds));
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof InvalidRequestError) {
      return c.json({ error: "invalid_request", message: error.message }, 400);
    }
    if (error instanceof ChainUnavailableError) {
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return c.json({ error: "chain_unavailable", message: error.message }, 503);
    }
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
