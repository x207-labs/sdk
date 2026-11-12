// x207 server middleware (SD-017, SD-027, Spec Binding x402 sections 2, 4, 5.3): 402 with `accepts`,
// `/verify` then the handler then `/settle`, and `PAYMENT-RESPONSE`. Based on standard web Request/Response,
// so it can be mounted in Hono (`c.req.raw`), Express (adapter), or any fetch handler.
import type { PaymentRequirements } from "@x402/core/types";
import type { AccountId, PairState } from "@x207/core";
import { X207_SCHEME } from "../shared/circle.js";
import { X207ExtraSource } from "./extra.js";
import { buildPaymentRequirements } from "./index.js";
import { MeterRejection, resolvePrice, type PriceFn } from "./metering.js";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Facilitator call timeout (ADR-25). */
export const FACILITATOR_TIMEOUT_MS = 10_000;
/** Longest time one voucher is held while its request runs (security review 3, G2). */
export const IN_FLIGHT_MAX_HOLD_MS = 120_000;
export const RETRY_AFTER_SECONDS = 5;

const RESYNC_REASONS = new Set(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"]);

/** A grant paid for by a request (SD-053): `payTo` = the grantor (not the broker account), `grantId` goes into `extra` and the voucher `resource`. */
export type X207GrantContext = { grantId: number; payTo: AccountId };

export type X207RouteConfig = {
  /**
   * Fixed price (`"$0.02"` or `0.02`), or a function `(request) => { unit, quantity, unitPrice, maxQuantity? }` for metered pricing (SD-062): the amount paid is
   * `unitPrice × quantity`, and `accepts[x207].extra.meter` announces the unit, quantity, unit price, and upper bound.
   */
  price: string | number | PriceFn;
  /** Upper bound of units per request for metered pricing; a request above the bound is rejected 413 before the 402 and before the handler. */
  maxQuantity?: number | string;
  description?: string;
  mimeType?: string;
  /**
   * F8 grant endpoint: determines the grant from the request. `undefined` means the grant does not exist (404 `grant_not_found`). Without this, `payTo` from the
   * middleware options is used and there is no `grantId`.
   */
  grant?: (request: Request) => X207GrantContext | undefined | Promise<X207GrantContext | undefined>;
  /**
   * Top-level `extensions` of the 402 answer, e.g. the `bazaar` discovery extension from `declareDiscoveryExtension` of `@x402/extensions` (UM-187).
   * A facilitator that indexes the Bazaar reads it when it settles a payment that echoes the extension; the x207 facilitator does not index anything.
   */
  extensions?: Record<string, unknown>;
};

/**
 * One voucher pays one request at a time (security review 2, finding R1). `/verify` reserves nothing and `/settle` answers success again to a
 * payload it already holds, so n parallel requests with one voucher would all pass `/verify`, run the handler n times and settle. The middleware
 * therefore takes the commitment id (`payer:payee:epoch:seq`) after `/verify` answered valid and gives it back after `/settle`; a second request
 * with the same id gets 409 `voucher_in_flight` and the handler does not run. After `/settle` the facilitator refuses the voucher itself
 * (`seq_not_increasing`).
 *
 * The id is taken only after `/verify` (security review 3, G1): the four parts of the id are public, so a request with a forged signature must not
 * be able to hold the id of a real voucher. Valid replays stay serialised, because the handler runs only after the id is taken.
 *
 * The id is given back when the request ends, when the client aborts (`request.signal`), and after `maxHoldMs` (security review 3, G2). The last
 * two can free the id while a handler still runs, so a replay of the same voucher may then run the handler a second time; the facilitator still
 * settles one voucher once, so the seller is paid once for it.
 *
 * The default guard lives in the memory of one process. With several seller processes the guard must be shared (a store with an atomic
 * set-if-absent), or requests with one payer must go to one process; otherwise a replay across processes is still possible inside the time
 * between `/verify` and `/settle`.
 */
export interface InFlightGuard {
  /** `false` when the id is already held. */
  acquire(id: string): boolean | Promise<boolean>;
  release(id: string): void | Promise<void>;
}

export function memoryInFlightGuard(): InFlightGuard {
  const held = new Set<string>();
  return {
    acquire: (id) => (held.has(id) ? false : (held.add(id), true)),
    release: (id) => void held.delete(id),
  };
}

/**
 * An extra `accepts` entry that another facilitator settles (SD-093), e.g. `exact` on Base Sepolia (`eip155:84532`) for buyers outside the circle.
 * The entry is added after the x207 and near `exact` entries. A payment that picks it is verified and settled at its own `facilitatorUrl`
 * (the x402 `/verify` and `/settle`), never at the x207 facilitator. `amount` defaults to the price of the route, so it is right only for an
 * asset with the same decimals as the credit unit (6, as USDC); give `amount` for other assets.
 */
export type X207AlsoAccept = {
  network: string;
  asset: string;
  /** The seller's address on that network (for `eip155:*`, the `0x` address). */
  payTo: string;
  facilitatorUrl: string;
  scheme?: string;
  amount?: string;
  maxTimeoutSeconds?: number;
  /** For `exact` on EVM: the EIP-3009 domain of the token, e.g. `{ name: "USDC", version: "2" }`. */
  extra?: Record<string, unknown>;
};

export type X207MiddlewareOptions = {
  /** Key `"/path"` or `"METHOD /path"`. Routes outside the list are passed to the handler without a 402. */
  routes: Record<string, X207RouteConfig>;
  facilitatorUrl: string;
  circleId: string;
  payTo: AccountId;
  /** Extra entries of `accepts` settled by other facilitators (SD-093). */
  alsoAccept?: X207AlsoAccept[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Replaces the default `extra` source (`/supported` cache, 60 seconds). */
  extra?: X207ExtraSource;
  /** Guard of vouchers in flight; default: in memory, one process (see `InFlightGuard`). */
  inFlight?: InFlightGuard;
  /** Longest time a voucher stays held by one request (default `IN_FLIGHT_MAX_HOLD_MS`). */
  maxHoldMs?: number;
  /**
   * SD-121. `"verify-first"` (default, unchanged): serve after the facilitator's `/verify`, then `/settle`. The facilitator's answer is its own view: a buyer can sign
   * vouchers to several sellers through different facilitators until the sum is above the limit, and the contract (first come, first served) then refuses the late
   * ones with `ERR_INSUFFICIENT_CREDIT` after the seller has already served. `"register-first"`: after `/verify` the middleware calls `registerVoucher` and serves only
   * if the voucher is registered on-chain; a refused voucher gets 402 and the handler does not run. Costs one on-chain call (about 2 seconds on NEAR) before the
   * response, and needs `registerVoucher`. Applies to the x207 entry only (not `alsoAccept` entries) and to vouchers without `bundleId`. Registration replaces `/settle`:
   * the facilitator is not asked to settle, because the voucher is already on-chain.
   */
  settleMode?: "verify-first" | "register-first";
  /** Registers the voucher on-chain (`register_voucher`, permissionless: any account can send it). Required for `settleMode: "register-first"`. */
  registerVoucher?: RegisterVoucherFn;
};

/** Result of `registerVoucher`: `reason` is the contract code of the refusal (`ERR_INSUFFICIENT_CREDIT`, `ERR_SEQ_NOT_NEXT`, ...). A thrown error means the call could not be made (503). */
export type RegisterVoucherResult = { ok: true } | { ok: false; reason: string };
export type RegisterVoucherFn = (input: { voucher: Record<string, unknown>; signature: string }) => Promise<RegisterVoucherResult>;

export type NextHandler = (request: Request) => Response | Promise<Response>;
export type X207Middleware = (request: Request, next: NextHandler) => Promise<Response>;

class FacilitatorUnavailable extends Error {}

const toBase64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function fromBase64(header: string): any {
  const text = Buffer.from(header, "base64").toString("utf8");
  if (!text || Buffer.from(text, "utf8").toString("base64").replace(/=+$/, "") !== header.replace(/=+$/, "")) {
    throw new Error("not base64");
  }
  return JSON.parse(text);
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function paymentRequiredResponse(
  resource: { url: string; description?: string; mimeType?: string },
  accepts: PaymentRequirements[],
  error: string,
  settleResponse?: unknown,
  extensions?: Record<string, unknown>,
): Response {
  const body = { x402Version: 2, error, resource, accepts, ...(extensions ? { extensions } : {}) };
  const headers = new Headers({ "content-type": "application/json", [HEADER_PAYMENT_REQUIRED]: toBase64(body) });
  if (settleResponse !== undefined) headers.set(HEADER_PAYMENT_RESPONSE, toBase64(settleResponse));
  return new Response(JSON.stringify(body), { status: 402, headers });
}

const unavailable = (message: string): Response =>
  new Response(JSON.stringify({ error: "facilitator_unavailable", message }), {
    status: 503,
    headers: { "content-type": "application/json", "Retry-After": String(RETRY_AFTER_SECONDS) },
  });

export function x207Middleware(options: X207MiddlewareOptions): X207Middleware {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? FACILITATOR_TIMEOUT_MS;
  const base = options.facilitatorUrl.replace(/\/+$/, "");
  const extra = options.extra ?? new X207ExtraSource({ facilitatorUrl: base, fetch: fetchFn });
  const inFlight = options.inFlight ?? memoryInFlightGuard();
  const maxHoldMs = options.maxHoldMs ?? IN_FLIGHT_MAX_HOLD_MS;
  if (options.settleMode === "register-first" && options.registerVoucher === undefined) {
    throw new Error("settleMode 'register-first' needs the option registerVoucher");
  }

  async function call(path: string, init?: RequestInit, root: string = base): Promise<any> {
    let response: Response;
    try {
      response = await fetchFn(`${root}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new FacilitatorUnavailable(`${path}: ${(error as Error).message}`);
    }
    if (response.status >= 500) throw new FacilitatorUnavailable(`${path}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new FacilitatorUnavailable(`${path}: response is not JSON`);
    }
  }
  const post = (path: string, body: unknown, root?: string) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, root);

  async function resyncResponse(
    reason: string,
    payload: any,
    network: string,
  ): Promise<Record<string, unknown> | undefined> {
    const voucher = payload?.payload?.voucher;
    if (!isRecord(voucher)) return undefined;
    const query = new URLSearchParams({
      network, payer: String(voucher.payer), payee: String(voucher.payee), epoch: String(voucher.epoch),
    });
    try {
      const state = (await call(`/x207/pair-state?${query}`)) as PairState;
      if (typeof state?.lastSeq !== "number") return undefined;
      return {
        success: false, errorReason: reason, transaction: "", network, payer: voucher.payer,
        extensions: { x207: { epoch: voucher.epoch, lastSeq: state.lastSeq, lastCumulativeAmount: state.lastCumulativeAmount } },
      };
    } catch {
      return undefined;
    }
  }

  return async (request, next) => {
    const url = new URL(request.url);
    const route = options.routes[`${request.method} ${url.pathname}`] ?? options.routes[url.pathname];
    if (!route) return next(request);

    const resource = {
      url: request.url,
      ...(route.description ? { description: route.description } : {}),
      ...(route.mimeType ? { mimeType: route.mimeType } : {}),
    };

    let grant: X207GrantContext | undefined;
    if (route.grant) {
      grant = await route.grant(request);
      if (grant === undefined) {
        return new Response(JSON.stringify({ error: "grant_not_found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
    }

    // metered pricing (SD-062): computed from the request BEFORE the 402 and before the handler; above the bound it is rejected here, so nobody pays for work that does not run
    let priced: Awaited<ReturnType<typeof resolvePrice>>;
    try {
      priced = await resolvePrice(route.price, request, route.maxQuantity);
    } catch (error) {
      if (error instanceof MeterRejection) {
        const code = error.status === 413 ? "quantity_over_limit" : "invalid_quantity";
        return new Response(JSON.stringify({ error: code, message: error.message, ...error.detail }), { status: error.status, headers: { "content-type": "application/json" } });
      }
      if (typeof route.price !== "function") return unavailable((error as Error).message);
      throw error;
    }

    let accepts: PaymentRequirements[];
    try {
      accepts = await buildPaymentRequirements({
        circleId: options.circleId, payTo: grant?.payTo ?? options.payTo, price: typeof route.price === "function" ? "0.000001" : route.price, amount: priced.amount, resource: request.url, extra,
        ...(priced.meter ? { meter: priced.meter } : {}),
        ...(grant ? { grantId: grant.grantId } : {}),
      });
    } catch (error) {
      return unavailable((error as Error).message);
    }

    // SD-093: entries settled by another facilitator; remember which facilitator belongs to which entry
    const roots = new Map<PaymentRequirements, string>();
    for (const also of options.alsoAccept ?? []) {
      const entry: PaymentRequirements = {
        scheme: also.scheme ?? "exact", network: also.network, amount: also.amount ?? priced.amount, asset: also.asset, payTo: also.payTo,
        maxTimeoutSeconds: also.maxTimeoutSeconds ?? 60, extra: also.extra ?? {},
      } as PaymentRequirements;
      accepts.push(entry);
      roots.set(entry, also.facilitatorUrl.replace(/\/+$/, ""));
    }

    const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);
    if (header === null) return paymentRequiredResponse(resource, accepts, "PAYMENT-SIGNATURE header is required", undefined, route.extensions);

    let payload: any;
    try {
      payload = fromBase64(header);
    } catch {
      return paymentRequiredResponse(resource, accepts, "invalid_payload", undefined, route.extensions);
    }
    const accepted = isRecord(payload) ? payload.accepted : undefined;
    const requirements = accepts.find((r) => r.scheme === accepted?.scheme && r.network === accepted?.network);
    if (!requirements) return paymentRequiredResponse(resource, accepts, "invalid_payload", undefined, route.extensions);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };
    const root = roots.get(requirements);

    const voucher = isRecord(payload.payload) && isRecord(payload.payload.voucher) ? payload.payload.voucher : undefined;
    const commitment =
      voucher !== undefined && ["payer", "payee"].every((k) => typeof voucher[k] === "string") && ["epoch", "seq"].every((k) => Number.isSafeInteger(voucher[k]))
        ? `${voucher.payer}:${voucher.payee}:${voucher.epoch}:${voucher.seq}`
        : undefined;
    let giveBack: (() => Promise<void>) | undefined;
    try {
      const verdict = await post("/verify", body, root);
      if (!verdict?.isValid) {
        const reason = String(verdict?.invalidReason ?? "invalid_payload");
        const resync = RESYNC_REASONS.has(reason) ? await resyncResponse(reason, payload, requirements.network) : undefined;
        return paymentRequiredResponse(resource, accepts, reason, resync, route.extensions);
      }

      if (commitment !== undefined) {
        if (!(await inFlight.acquire(commitment))) {
          return new Response(JSON.stringify({ error: "voucher_in_flight", message: `voucher ${commitment} is already paying a request` }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        // one give-back per acquisition: the timer, the abort and the end of the request may all call it, only the first one counts
        let given = false;
        const timer = setTimeout(() => void giveBack?.(), maxHoldMs);
        timer.unref?.();
        const onAbort = () => void giveBack?.();
        request.signal?.addEventListener("abort", onAbort, { once: true });
        giveBack = async () => {
          if (given) return;
          given = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          await inFlight.release(commitment);
        };
      }

      // SD-121 register-first: the voucher must be on-chain before the handler runs; the contract's answer, not the facilitator's, decides.
      const signature = isRecord(payload.payload) ? payload.payload.signature : undefined;
      const registerFirst =
        options.settleMode === "register-first" && requirements.scheme === X207_SCHEME && voucher !== undefined && typeof signature === "string" &&
        payload.payload.bundleId === undefined;
      if (registerFirst) {
        let outcome: RegisterVoucherResult;
        try {
          outcome = await options.registerVoucher!({ voucher: voucher!, signature });
        } catch (error) {
          return unavailable(`registerVoucher: ${(error as Error).message}`);
        }
        if (!outcome.ok) {
          const reason = outcome.reason.replace(/^ERR_/, "").toLowerCase();
          const refused = { success: false, errorReason: reason, transaction: "", network: requirements.network, payer: voucher!.payer, extensions: { x207: { contractCode: outcome.reason } } };
          return paymentRequiredResponse(resource, accepts, reason, refused, route.extensions);
        }
      }

      const response = await next(request);
      // The handler failed or refused: there is no obligation (`authorization` flow), the response is passed through as-is.
      // With register-first the voucher is already on-chain, so the buyer owes it even when the handler failed (see `settleMode`).
      if (response.status >= 400) return response;

      if (registerFirst) {
        const registered = {
          success: true, transaction: commitment, network: requirements.network, payer: voucher!.payer,
          extensions: { x207: { epoch: voucher!.epoch, seq: voucher!.seq, cumulativeAmount: voucher!.cumulativeAmount, registration: "registered" } },
        };
        const headers = new Headers(response.headers);
        headers.set(HEADER_PAYMENT_RESPONSE, toBase64(registered));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }

      const settled = await post("/settle", body, root);
      if (settled?.success === true || settled?.errorReason === "settlement_pending") {
        const headers = new Headers(response.headers);
        headers.set(HEADER_PAYMENT_RESPONSE, toBase64(settled));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return paymentRequiredResponse(resource, accepts, String(settled?.errorReason ?? "settle_failed"), settled, route.extensions);
    } catch (error) {
      if (error instanceof FacilitatorUnavailable) return unavailable(error.message);
      throw error;
    } finally {
      await giveBack?.();
    }
  };
}
