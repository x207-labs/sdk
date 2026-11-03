// Middleware server x207 (SD-017, SD-027, Spec Binding x402 bagian 2, 4, 5.3): 402 dengan `accepts`,
// `/verify` lalu handler lalu `/settle`, dan `PAYMENT-RESPONSE`. Berbasis Request/Response web standar,
// jadi bisa dipasang di Hono (`c.req.raw`), Express (adapter), atau fetch handler apa pun.
import type { PaymentRequirements } from "@x402/core/types";
import type { AccountId, PairState } from "@x207/core";
import { X207ExtraSource } from "./extra.js";
import { buildPaymentRequirements } from "./index.js";
import { MeterRejection, resolvePrice, type PriceFn } from "./metering.js";

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
/** Timeout panggilan facilitator (ADR-25). */
export const FACILITATOR_TIMEOUT_MS = 10_000;
/** Longest time one voucher is held while its request runs (security review 3, G2). */
export const IN_FLIGHT_MAX_HOLD_MS = 120_000;
export const RETRY_AFTER_SECONDS = 5;

const RESYNC_REASONS = new Set(["seq_not_increasing", "cumulative_decreased", "amount_mismatch"]);

/** Grant yang dibayar sebuah request (SD-053): `payTo` = pemberi grant (bukan akun broker), `grantId` masuk `extra` dan `resource` voucher. */
export type X207GrantContext = { grantId: number; payTo: AccountId };

export type X207RouteConfig = {
  /**
   * Harga tetap (`"$0.02"` atau `0.02`), atau fungsi `(request) => { unit, quantity, unitPrice, maxQuantity? }` untuk harga terukur (SD-062): jumlah yang dibayar adalah
   * `unitPrice × quantity`, dan `accepts[x207].extra.meter` mengumumkan satuan, jumlah, harga satuan, dan batas atas.
   */
  price: string | number | PriceFn;
  /** Batas atas satuan per request untuk harga terukur; request di atas batas ditolak 413 sebelum 402 dan sebelum handler. */
  maxQuantity?: number | string;
  description?: string;
  mimeType?: string;
  /**
   * Endpoint grant F8: menentukan grant dari request. `undefined` berarti grant tidak ada (404 `grant_not_found`). Tanpa ini `payTo` dari
   * opsi middleware dipakai dan tidak ada `grantId`.
   */
  grant?: (request: Request) => X207GrantContext | undefined | Promise<X207GrantContext | undefined>;
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

export type X207MiddlewareOptions = {
  /** Kunci `"/path"` atau `"METHOD /path"`. Rute di luar daftar diteruskan ke handler tanpa 402. */
  routes: Record<string, X207RouteConfig>;
  facilitatorUrl: string;
  circleId: string;
  payTo: AccountId;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Menggantikan sumber `extra` bawaan (cache `/supported`, 60 detik). */
  extra?: X207ExtraSource;
  /** Guard of vouchers in flight; bawaan: in memory, one process (see `InFlightGuard`). */
  inFlight?: InFlightGuard;
  /** Longest time a voucher stays held by one request (default `IN_FLIGHT_MAX_HOLD_MS`). */
  maxHoldMs?: number;
};

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
): Response {
  const body = { x402Version: 2, error, resource, accepts };
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

  async function call(path: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

    // harga terukur (SD-062): dihitung dari request SEBELUM 402 dan sebelum handler; di atas batas ditolak di sini, jadi tidak ada yang membayar untuk kerja yang tidak berjalan
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

    const header = request.headers.get(HEADER_PAYMENT_SIGNATURE);
    if (header === null) return paymentRequiredResponse(resource, accepts, "PAYMENT-SIGNATURE header is required");

    let payload: any;
    try {
      payload = fromBase64(header);
    } catch {
      return paymentRequiredResponse(resource, accepts, "invalid_payload");
    }
    const accepted = isRecord(payload) ? payload.accepted : undefined;
    const requirements = accepts.find((r) => r.scheme === accepted?.scheme && r.network === accepted?.network);
    if (!requirements) return paymentRequiredResponse(resource, accepts, "invalid_payload");
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };

    const voucher = isRecord(payload.payload) && isRecord(payload.payload.voucher) ? payload.payload.voucher : undefined;
    const commitment =
      voucher !== undefined && ["payer", "payee"].every((k) => typeof voucher[k] === "string") && ["epoch", "seq"].every((k) => Number.isSafeInteger(voucher[k]))
        ? `${voucher.payer}:${voucher.payee}:${voucher.epoch}:${voucher.seq}`
        : undefined;
    let giveBack: (() => Promise<void>) | undefined;
    try {
      const verdict = await post("/verify", body);
      if (!verdict?.isValid) {
        const reason = String(verdict?.invalidReason ?? "invalid_payload");
        const resync = RESYNC_REASONS.has(reason) ? await resyncResponse(reason, payload, requirements.network) : undefined;
        return paymentRequiredResponse(resource, accepts, reason, resync);
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

      const response = await next(request);
      // Handler gagal atau menolak: tidak ada kewajiban (flow `authorization`), respons diteruskan apa adanya.
      if (response.status >= 400) return response;

      const settled = await post("/settle", body);
      if (settled?.success === true || settled?.errorReason === "settlement_pending") {
        const headers = new Headers(response.headers);
        headers.set(HEADER_PAYMENT_RESPONSE, toBase64(settled));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      return paymentRequiredResponse(resource, accepts, String(settled?.errorReason ?? "settle_failed"), settled);
    } catch (error) {
      if (error instanceof FacilitatorUnavailable) return unavailable(error.message);
      throw error;
    } finally {
      await giveBack?.();
    }
  };
}
